from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from flask import Blueprint, jsonify, redirect, request, session

from server.db import get_conn
from server.routes.auth import require_admin
from server.routes.pending import _apply_score

user_portal_bp = Blueprint('user_portal', __name__)

_DISCORD_API = 'https://discord.com/api'
_PO_ROUND_LABELS = {
    100: 'First Round',
    101: 'Second Round',
    102: 'Conference Finals',
    103: 'Championship',
}


def _app_base_path() -> str:
    raw = (os.environ.get('APP_BASE_PATH', '/') or '/').strip()
    if not raw.startswith('/'):
        raw = '/' + raw
    raw = raw.rstrip('/')
    return raw or '/'


def _app_redirect_path(suffix: str = '') -> str:
    base = _app_base_path()
    suffix = suffix or ''
    if suffix and not suffix.startswith('?') and not suffix.startswith('#') and not suffix.startswith('/'):
        suffix = '/' + suffix
    if base == '/':
        return suffix or '/'
    return f'{base}{suffix}'


def _oauth_config() -> dict:
    return {
        'client_id': os.environ.get('DISCORD_CLIENT_ID', '').strip(),
        'client_secret': os.environ.get('DISCORD_CLIENT_SECRET', '').strip(),
        'redirect_uri': os.environ.get('DISCORD_REDIRECT_URI', '').strip(),
    }


def _oauth_ready() -> bool:
    cfg = _oauth_config()
    return bool(cfg['client_id'] and cfg['client_secret'] and cfg['redirect_uri'])


def _json_request(url: str, *, method: str = 'GET', data: dict | None = None, headers: dict | None = None):
    payload = None
    req_headers = {'Accept': 'application/json', 'User-Agent': 'ZamboniLeague/1.0'}
    if headers:
        req_headers.update(headers)
    if data is not None:
        payload = urlencode(data).encode('utf-8')
        req_headers.setdefault('Content-Type', 'application/x-www-form-urlencoded')
    req = Request(url, data=payload, headers=req_headers, method=method)
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _exchange_code(code: str) -> dict:
    cfg = _oauth_config()
    return _json_request(
        f'{_DISCORD_API}/oauth2/token',
        method='POST',
        data={
            'client_id': cfg['client_id'],
            'client_secret': cfg['client_secret'],
            'grant_type': 'authorization_code',
            'code': code,
            'redirect_uri': cfg['redirect_uri'],
        },
    )


def _fetch_discord_user(access_token: str) -> dict:
    return _json_request(
        f'{_DISCORD_API}/users/@me',
        headers={'Authorization': f'Bearer {access_token}'},
    )


def _avatar_url(user: dict) -> str:
    avatar = user.get('avatar')
    user_id = user.get('id')
    if not avatar or not user_id:
        return ''
    return f'https://cdn.discordapp.com/avatars/{user_id}/{avatar}.png?size=128'


def _load_state() -> dict:
    conn = get_conn()
    row = conn.execute('SELECT data FROM league_state WHERE id=1').fetchone()
    conn.close()
    if not row:
        return {}
    try:
        return json.loads(row['data'])
    except Exception:
        return {}


def _save_state(state: dict):
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO league_state (id, data, updated)
        VALUES (1, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated
        """,
        (json.dumps(state),),
    )
    conn.commit()
    conn.close()


def _current_user() -> dict | None:
    user = session.get('discord_user')
    return user if isinstance(user, dict) and user.get('id') else None


def _require_user():
    user = _current_user()
    if not user:
        return None, (jsonify({'error': 'Unauthorized'}), 401)
    return user, None


def _find_manager_by_discord(state: dict, discord_id: str) -> dict | None:
    return next(
        (m for m in state.get('managers', []) if str(m.get('discordId', '')) == str(discord_id)),
        None,
    )


def _get_team_for_manager(state: dict, mgr_id: str) -> str | None:
    return next(
        (code for code, mid in state.get('teamOwners', {}).items() if mid == mgr_id),
        None,
    )


def _auto_week(state: dict) -> int:
    unplayed = [g for g in state.get('games', []) if not g.get('played')]
    reg_weeks = [g.get('week', 0) for g in unplayed if (g.get('week') or 0) < 100]
    po_weeks = [g.get('week', 0) for g in unplayed if (g.get('week') or 0) >= 100]
    return min(reg_weeks) if reg_weeks else (min(po_weeks) if po_weeks else 1)


def _current_week(state: dict) -> int:
    raw = state.get('currentWeek')
    try:
        return int(raw) if raw is not None else _auto_week(state)
    except (TypeError, ValueError):
        return _auto_week(state)


def _eligible_games_for_manager(state: dict, manager: dict) -> list[dict]:
    team_code = _get_team_for_manager(state, manager['id'])
    if not team_code:
        return []
    cur_week = _current_week(state)
    owners = state.get('teamOwners', {})
    mgr_map = {m['id']: m for m in state.get('managers', [])}
    games = []
    for g in state.get('games', []):
        week = g.get('week') or 0
        if g.get('played'):
            continue
        if g.get('homeTeam') != team_code and g.get('awayTeam') != team_code:
            continue
        if week < 100 and week > cur_week:
            continue
        home_mgr = mgr_map.get(owners.get(g.get('homeTeam', '')))
        away_mgr = mgr_map.get(owners.get(g.get('awayTeam', '')))
        games.append({
            **g,
            'homeManagerName': home_mgr.get('name', '') if home_mgr else '',
            'awayManagerName': away_mgr.get('name', '') if away_mgr else '',
            'homeZamboniTag': home_mgr.get('zamboniTag', '') if home_mgr else '',
            'awayZamboniTag': away_mgr.get('zamboniTag', '') if away_mgr else '',
            'roundLabel': _PO_ROUND_LABELS.get(week, f'Playoffs Rd {week - 99}') if week >= 100 else '',
        })
    games.sort(key=lambda g: (g.get('week', 999), g.get('id', '')))
    return games


def _fmt_zamboni_date(created_at: str) -> str:
    if not created_at:
        return ''
    try:
        dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
        return dt.strftime('%b %-d · %-I:%M%p').lower()
    except Exception:
        return created_at[:10]


def _side_stats(hist: dict) -> dict:
    return {
        'scor': hist.get('scor', 0),
        'shots': hist.get('shts', 0),
        'hits': hist.get('hits', 0),
        'ppg': hist.get('ppg', 0),
        'ppo': hist.get('ppo', 0),
        'shg': hist.get('shg', 0),
        'fo': hist.get('fo', 0),
        'fol': hist.get('fol', 0),
        'toa': hist.get('toa', 0),
        'pims': hist.get('pims', 0),
        'otg': hist.get('otg', 0),
        'created_at': hist.get('created_at', ''),
    }


def _build_zamboni_options(home_tag: str, away_tag: str, home_history: list, away_history: list) -> list[dict]:
    home_by_id = {
        h['game_id']: h for h in home_history
        if str(h.get('opponent', '')).lower() == away_tag.lower()
    }
    away_by_id = {
        h['game_id']: h for h in away_history
        if str(h.get('opponent', '')).lower() == home_tag.lower()
    }
    results = []
    for gid in set(home_by_id) & set(away_by_id):
        hs = home_by_id[gid]
        a_s = away_by_id[gid]
        home_score = int(hs.get('scor', 0) or 0)
        away_score = int(a_s.get('scor', 0) or 0)
        is_ot = bool((hs.get('otg') or 0) > 0 and (a_s.get('otg') or 0) > 0)
        date_str = _fmt_zamboni_date(hs.get('created_at', ''))
        label = f'{home_tag} {home_score} - {away_score} {away_tag}'
        if date_str:
            label += f' · {date_str}'
        results.append({
            'gameId': gid,
            'label': label,
            'createdAt': hs.get('created_at', ''),
            'ot': is_ot,
            'homeScore': home_score,
            'awayScore': away_score,
            'zamboniStats': {
                'home': _side_stats(hs),
                'away': _side_stats(a_s),
            },
        })
    results.sort(key=lambda item: item.get('createdAt', ''), reverse=True)
    return results[:20]


def _zamboni_player(gamertag: str) -> dict | None:
    if not gamertag:
        return None
    from server.routes.zamboni import ZAMBONI_ROOT, ZAMBONI_VERSIONS, _cached_get
    candidates = []
    raw = str(gamertag).strip()
    for candidate in (raw, raw.lower()):
        if candidate and candidate not in candidates:
            candidates.append(candidate)
    for candidate in candidates:
        profile = None
        version_used = None
        for ver in ZAMBONI_VERSIONS:
            url = f'{ZAMBONI_ROOT}/{ver}/api/player/{candidate}'
            data = _cached_get(f'profile_{ver}_{candidate}', url)
            if data and data.get('userId'):
                profile = data
                version_used = ver
                break
        if profile is None:
            continue
        user_id = profile['userId']
        hist_url = f'{ZAMBONI_ROOT}/{version_used}/api/user/{user_id}/history'
        history = _cached_get(f'history_{version_used}_{user_id}', hist_url) or []
        return {'profile': profile, 'history': history, 'version': version_used}
    return None


def _validate_zamboni_tag(tag: str) -> tuple[bool | None, str | None]:
    clean = (tag or '').strip()
    if not clean:
        return False, 'RPCN account is required'
    try:
        data = _json_request('https://zamboni.gg/nhllegacy/api/players')
    except (URLError, HTTPError, Exception):
        return None, None
    known = set()
    if isinstance(data, list):
        for item in data:
            if isinstance(item, str):
                known.add(item.lower())
            elif isinstance(item, dict):
                val = item.get('gamertag') or item.get('name') or ''
                if val:
                    known.add(val.lower())
    return clean.lower() in known, None


def _portal_payload(state: dict, user: dict | None) -> dict:
    if not user:
        return {'user': None, 'linked': False, 'manager': None, 'teamCode': None}
    manager = _find_manager_by_discord(state, user['id'])
    team_code = _get_team_for_manager(state, manager['id']) if manager else None
    return {
        'user': user,
        'linked': bool(manager),
        'manager': manager,
        'teamCode': team_code,
        'currentWeek': _current_week(state),
    }


@user_portal_bp.route('/api/oauth/discord/start', methods=['GET'])
def discord_oauth_start():
    if not _oauth_ready():
        return jsonify({'error': 'Discord OAuth is not configured'}), 503
    state_token = secrets.token_urlsafe(24)
    next_path = request.args.get('next', _app_base_path())
    session['discord_oauth_state'] = state_token
    session['discord_oauth_next'] = next_path
    cfg = _oauth_config()
    params = urlencode({
        'client_id': cfg['client_id'],
        'redirect_uri': cfg['redirect_uri'],
        'response_type': 'code',
        'scope': 'identify',
        'state': state_token,
        'prompt': 'consent',
    })
    return redirect(f'https://discord.com/oauth2/authorize?{params}')


@user_portal_bp.route('/api/oauth/discord/callback', methods=['GET'])
def discord_oauth_callback():
    expected_state = session.get('discord_oauth_state')
    state_token = request.args.get('state', '')
    code = request.args.get('code', '')
    if not expected_state or state_token != expected_state or not code:
        return redirect(_app_redirect_path('?portalError=oauth'))
    try:
        token_data = _exchange_code(code)
        access_token = token_data.get('access_token', '')
        if not access_token:
            raise ValueError('missing access token')
        user = _fetch_discord_user(access_token)
    except Exception:
        session.pop('discord_oauth_state', None)
        return redirect(_app_redirect_path('?portalError=oauth'))
    session.pop('discord_oauth_state', None)
    next_path = session.pop('discord_oauth_next', _app_base_path())
    session['discord_user'] = {
        'id': str(user.get('id', '')),
        'username': user.get('username', ''),
        'globalName': user.get('global_name', ''),
        'avatar': _avatar_url(user),
    }
    return redirect(next_path or _app_base_path())


@user_portal_bp.route('/api/user/session', methods=['GET'])
def user_session():
    state = _load_state()
    return jsonify(_portal_payload(state, _current_user()))


@user_portal_bp.route('/api/user/logout', methods=['POST'])
def user_logout():
    session.pop('discord_user', None)
    session.pop('discord_oauth_state', None)
    session.pop('discord_oauth_next', None)
    return jsonify({'ok': True})


@user_portal_bp.route('/api/me/link-options', methods=['GET'])
def my_link_options():
    user, err = _require_user()
    if err:
        return err
    state = _load_state()
    managers = [
        {
            'id': m.get('id'),
            'name': m.get('name'),
            'color': m.get('color', ''),
            'teamCode': _get_team_for_manager(state, m.get('id', '')),
            'linkedToMe': str(m.get('discordId', '')) == str(user['id']),
        }
        for m in state.get('managers', [])
        if not m.get('discordId') or str(m.get('discordId', '')) == str(user['id'])
    ]
    managers.sort(key=lambda m: (m['teamCode'] or 'ZZZ', m['name'] or ''))
    return jsonify({'managers': managers})


@user_portal_bp.route('/api/me/link-manager', methods=['POST'])
def my_link_manager():
    user, err = _require_user()
    if err:
        return err
    body = request.get_json(force=True) or {}
    manager_id = str(body.get('managerId', '')).strip()
    zamboni_tag = str(body.get('zamboniTag', '')).strip()
    if not manager_id or not zamboni_tag:
        return jsonify({'error': 'managerId and zamboniTag are required'}), 400
    valid, validation_error = _validate_zamboni_tag(zamboni_tag)
    if valid is False:
        return jsonify({'error': validation_error or 'RPCN account was not found in Zamboni'}), 400
    state = _load_state()
    managers = state.get('managers', [])
    target = next((m for m in managers if str(m.get('id', '')) == manager_id), None)
    if not target:
        return jsonify({'error': 'Manager not found'}), 404
    existing_id = str(target.get('discordId', '')).strip()
    if existing_id and existing_id != str(user['id']):
        return jsonify({'error': 'Manager is already linked to another Discord account'}), 409
    target['discordId'] = str(user['id'])
    target['discordUsername'] = user.get('globalName') or user.get('username', '')
    if user.get('avatar'):
        target['discordAvatar'] = user['avatar']
    target['zamboniTag'] = zamboni_tag
    target['lastLinkedAt'] = datetime.now(timezone.utc).isoformat()
    _save_state(state)
    return jsonify({'ok': True, 'validated': valid is True, 'manager': target, 'teamCode': _get_team_for_manager(state, target['id'])})


@user_portal_bp.route('/api/managers/<manager_id>/link', methods=['PATCH'])
@require_admin
def admin_patch_manager_link(manager_id: str):
    state = _load_state()
    body = request.get_json(force=True) or {}
    target = next((m for m in state.get('managers', []) if str(m.get('id', '')) == str(manager_id)), None)
    if not target:
        return jsonify({'error': 'Manager not found'}), 404
    for field in ('discordId', 'discordUsername', 'discordAvatar', 'zamboniTag'):
        if field in body:
            value = body.get(field)
            if value in (None, ''):
                target.pop(field, None)
            else:
                target[field] = str(value)
    target['lastLinkedAt'] = datetime.now(timezone.utc).isoformat()
    _save_state(state)
    return jsonify({'ok': True, 'manager': target, 'teamCode': _get_team_for_manager(state, target['id'])})


@user_portal_bp.route('/api/me/score/games', methods=['GET'])
def my_score_games():
    user, err = _require_user()
    if err:
        return err
    state = _load_state()
    manager = _find_manager_by_discord(state, user['id'])
    if not manager:
        return jsonify({'error': 'Account is not linked to a manager'}), 409
    team_code = _get_team_for_manager(state, manager['id'])
    if not team_code:
        return jsonify({'error': 'Linked manager has no team assigned'}), 409
    games = _eligible_games_for_manager(state, manager)
    return jsonify({'games': games, 'teamCode': team_code, 'currentWeek': _current_week(state), 'manager': manager})


@user_portal_bp.route('/api/me/score/matches/<game_id>', methods=['GET'])
def my_score_matches(game_id: str):
    user, err = _require_user()
    if err:
        return err
    state = _load_state()
    manager = _find_manager_by_discord(state, user['id'])
    if not manager:
        return jsonify({'error': 'Account is not linked to a manager'}), 409
    eligible_games = _eligible_games_for_manager(state, manager)
    game = next((g for g in eligible_games if str(g.get('id', '')) == str(game_id)), None)
    if not game:
        return jsonify({'error': 'Game is not eligible for score submission'}), 404
    home_tag = str(game.get('homeZamboniTag', '')).strip()
    away_tag = str(game.get('awayZamboniTag', '')).strip()
    if not home_tag or not away_tag:
        missing = [team for team, tag in ((game.get('homeTeam'), home_tag), (game.get('awayTeam'), away_tag)) if not tag]
        return jsonify({'error': f"Missing RPCN tag for {' / '.join(missing)}"}), 409
    home_data = _zamboni_player(home_tag)
    away_data = _zamboni_player(away_tag)
    if not home_data or not away_data:
        return jsonify({'error': 'Zamboni API unavailable'}), 503
    home_hist = [*(home_data.get('history', {}) or {}).get('vs', []), *((home_data.get('history', {}) or {}).get('so', []))]
    away_hist = [*(away_data.get('history', {}) or {}).get('vs', []), *((away_data.get('history', {}) or {}).get('so', []))]
    options = _build_zamboni_options(home_tag, away_tag, home_hist, away_hist)
    return jsonify({
        'game': game,
        'homeTag': home_tag,
        'awayTag': away_tag,
        'matches': options,
    })


@user_portal_bp.route('/api/me/score', methods=['POST'])
def my_score_submit():
    user, err = _require_user()
    if err:
        return err
    body = request.get_json(force=True) or {}
    state = _load_state()
    manager = _find_manager_by_discord(state, user['id'])
    if not manager:
        return jsonify({'error': 'Account is not linked to a manager'}), 409
    team_code = _get_team_for_manager(state, manager['id'])
    if not team_code:
        return jsonify({'error': 'Linked manager has no team assigned'}), 409
    game_id = str(body.get('gameId', '')).strip()
    if not game_id:
        return jsonify({'error': 'gameId is required'}), 400
    game = next((g for g in state.get('games', []) if str(g.get('id', '')) == game_id), None)
    if not game or game.get('played'):
        return jsonify({'error': 'Game not found or already played'}), 404
    if game.get('homeTeam') != team_code and game.get('awayTeam') != team_code:
        return jsonify({'error': 'You can only submit scores for your own team'}), 403
    eligible_ids = {str(g.get('id', '')) for g in _eligible_games_for_manager(state, manager)}
    if game_id not in eligible_ids:
        return jsonify({'error': 'Game is not eligible for score submission right now'}), 409
    try:
        home_score = int(body.get('homeScore'))
        away_score = int(body.get('awayScore'))
    except (TypeError, ValueError):
        return jsonify({'error': 'homeScore and awayScore must be numbers'}), 400
    if home_score == away_score:
        return jsonify({'error': 'Scores cannot be tied'}), 400
    payload = {
        'gameId': game_id,
        'homeTeam': game.get('homeTeam'),
        'awayTeam': game.get('awayTeam'),
        'homeScore': home_score,
        'awayScore': away_score,
        'ot': bool(body.get('ot', False)),
    }
    if body.get('zamboniGameId') is not None:
        payload['zamboniGameId'] = body.get('zamboniGameId')
    if isinstance(body.get('zamboniStats'), dict):
        payload['zamboniStats'] = body.get('zamboniStats')
    _apply_score(state, payload)
    _save_state(state)
    updated_game = next((g for g in state.get('games', []) if str(g.get('id', '')) == game_id), None)
    return jsonify({'ok': True, 'game': updated_game, 'submittedBy': user.get('globalName') or user.get('username', '')})
