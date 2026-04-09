"""
routes/user_portal_v2.py — Robust multi-user portal routes
Uses dedicated tables for user links and score submissions
Replaces user_portal.py with atomic writes and conflict protection
"""
from __future__ import annotations

import hashlib
import hmac
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
from server.routes.bot_events import queue_score_event

user_portal_v2_bp = Blueprint('user_portal_v2', __name__)

_DISCORD_API = 'https://discord.com/api'


def _hash_discord_id(discord_id: str) -> str:
    """One-way HMAC of the raw Discord snowflake using FLASK_SECRET_KEY.
    Stored in user_links instead of the plaintext ID.
    Login lookups hash the incoming ID and match on the hash."""
    key = (os.environ.get('FLASK_SECRET_KEY') or 'dev-insecure-key').encode()
    return hmac.new(key, discord_id.encode(), hashlib.sha256).hexdigest()


_PO_ROUND_LABELS = {
    100: 'First Round',
    101: 'Second Round',
    102: 'Conference Finals',
    103: 'Championship',
}


# ── OAuth helpers (unchanged) ────────────────────────────────────────────────

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
        return json.loads(resp.read().decode())


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


# ── Database helpers ──────────────────────────────────────────────────────────

def _load_state():
    conn = get_conn()
    row = conn.execute('SELECT data FROM league_state WHERE id=1').fetchone()
    conn.close()
    if not row:
        return {}
    try:
        return json.loads(row['data'])
    except (json.JSONDecodeError, TypeError):
        return {}


def _save_state(state: dict):
    conn = get_conn()
    conn.execute(
        "UPDATE league_state SET data=?, updated=datetime('now') WHERE id=1",
        (json.dumps(state),)
    )
    conn.commit()
    conn.close()


def _get_user_link(discord_id: str) -> dict | None:
    """Get user link from dedicated table"""
    conn = get_conn()
    row = conn.execute('''
        SELECT id, discord_id, manager_id, discord_username, discord_avatar,
               discord_global_name, zamboni_tag, linked_at, updated_at, last_active_at, source
        FROM user_links
        WHERE discord_id = ?
    ''', (_hash_discord_id(discord_id),)).fetchone()
    conn.close()
    if not row:
        return None
    return dict(row)


def _create_or_update_user_link(discord_id: str, manager_id: str, discord_user: dict, zamboni_tag: str):
    """Atomically create or update a user link"""
    conn = get_conn()
    now = datetime.now(timezone.utc).isoformat()
    
    hashed_id = _hash_discord_id(discord_id)
    existing = conn.execute('SELECT id FROM user_links WHERE discord_id = ?', (hashed_id,)).fetchone()
    
    if existing:
        conn.execute('''
            UPDATE user_links
            SET manager_id = ?, discord_username = ?, discord_avatar = ?,
                discord_global_name = ?, zamboni_tag = ?, updated_at = ?, last_active_at = ?
            WHERE discord_id = ?
        ''', (
            manager_id,
            discord_user.get('username', ''),
            _avatar_url(discord_user),
            discord_user.get('global_name', ''),
            zamboni_tag,
            now,
            now,
            hashed_id,
        ))
    else:
        conn.execute('''
            INSERT INTO user_links (
                discord_id, manager_id, discord_username, discord_avatar,
                discord_global_name, zamboni_tag, linked_at, updated_at, last_active_at, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            hashed_id,
            manager_id,
            discord_user.get('username', ''),
            _avatar_url(discord_user),
            discord_user.get('global_name', ''),
            zamboni_tag,
            now,
            now,
            now,
            'website',
        ))
    
    conn.commit()
    conn.close()


def _update_last_active(discord_id: str):
    """Update last_active_at timestamp"""
    conn = get_conn()
    conn.execute('''
        UPDATE user_links
        SET last_active_at = ?
        WHERE discord_id = ?
    ''', (datetime.now(timezone.utc).isoformat(), _hash_discord_id(discord_id)))
    conn.commit()
    conn.close()


def _create_score_submission(
    game_id: str,
    discord_id: str,
    manager_id: str,
    home_score: int,
    away_score: int,
    ot: bool,
    zamboni_game_id: str | None = None,
    zamboni_stats: dict | None = None,
    source: str = 'website',
) -> int:
    """Atomically create a score submission and return its ID"""
    conn = get_conn()
    now = datetime.now(timezone.utc).isoformat()
    
    cursor = conn.execute('''
        INSERT INTO score_submissions (
            game_id, submitted_by_discord_id, submitted_by_manager_id,
            home_score, away_score, ot, zamboni_game_id, zamboni_stats,
            source, submitted_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        game_id,
        discord_id,
        manager_id,
        home_score,
        away_score,
        ot,
        zamboni_game_id,
        json.dumps(zamboni_stats) if zamboni_stats else None,
        source,
        now,
        'pending',
    ))
    
    submission_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return submission_id


def _approve_score_submission(submission_id: int, approved_by: str = 'auto'):
    """Mark a submission as approved and apply it to the game"""
    conn = get_conn()
    
    # Get submission
    row = conn.execute('''
        SELECT
            game_id,
            home_score,
            away_score,
            ot,
            zamboni_game_id,
            zamboni_stats,
            submitted_by_discord_id,
            submitted_by_manager_id,
            source,
            submitted_at
        FROM score_submissions
        WHERE id = ? AND status = 'pending'
    ''', (submission_id,)).fetchone()
    
    if not row:
        conn.close()
        return False
    
    submission = dict(row)
    now = datetime.now(timezone.utc).isoformat()
    
    # Mark as approved
    conn.execute('''
        UPDATE score_submissions
        SET status = 'approved', approved_by = ?, approved_at = ?
        WHERE id = ?
    ''', (approved_by, now, submission_id))
    
    conn.commit()
    conn.close()
    
    # Apply to league state
    state = _load_state()
    game = next((g for g in state.get('games', []) if g.get('id') == submission['game_id']), None)
    
    if game and not game.get('played'):
        game['played'] = True
        game['homeScore'] = submission['home_score']
        game['awayScore'] = submission['away_score']
        game['ot'] = bool(submission['ot'])
        game['postedAt'] = now
        if submission['zamboni_game_id']:
            game['zamboniGameId'] = submission['zamboni_game_id']
        if submission['zamboni_stats']:
            game['zamboniStats'] = json.loads(submission['zamboni_stats']) if isinstance(submission['zamboni_stats'], str) else submission['zamboni_stats']
        game['winner'] = game['homeTeam'] if submission['home_score'] > submission['away_score'] else game['awayTeam']
        _save_state(state)
        queue_score_event(game, {
            'source': submission.get('source') or 'website',
            'submissionId': submission_id,
            'submittedByDiscordId': submission.get('submitted_by_discord_id'),
            'submittedByManagerId': submission.get('submitted_by_manager_id'),
            'submittedAt': submission.get('submitted_at'),
            'approvedBy': approved_by,
        })
        return True
    
    return False


# ── Session helpers ───────────────────────────────────────────────────────────

def _current_user() -> dict | None:
    user = session.get('discord_user')
    return user if isinstance(user, dict) and user.get('id') else None


def _require_user():
    user = _current_user()
    if not user:
        return None, (jsonify({'error': 'Unauthorized'}), 401)
    return user, None


# ── State helpers (reused from v1) ───────────────────────────────────────────

def _find_manager_by_id(state: dict, manager_id: str) -> dict | None:
    return next((m for m in state.get('managers', []) if m.get('id') == manager_id), None)


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
    managers_by_id = {m['id']: m for m in state.get('managers', [])}
    
    games = []
    for g in state.get('games', []):
        if g.get('played'):
            continue
        week = g.get('week', 0)
        if week > cur_week:
            continue
        if g.get('homeTeam') != team_code and g.get('awayTeam') != team_code:
            continue
        
        home_mgr_id = owners.get(g.get('homeTeam'))
        away_mgr_id = owners.get(g.get('awayTeam'))
        home_mgr = managers_by_id.get(home_mgr_id)
        away_mgr = managers_by_id.get(away_mgr_id)
        
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


# Import Zamboni helpers from v1
from server.routes.user_portal import (
    _fmt_zamboni_date,
    _side_stats,
    _build_zamboni_options,
    _zamboni_player,
    _validate_zamboni_tag,
)


# ── Routes ────────────────────────────────────────────────────────────────────

@user_portal_v2_bp.route('/api/v2/oauth/discord/start', methods=['GET'])
def discord_oauth_start():
    if not _oauth_ready():
        return jsonify({'error': 'Discord OAuth is not configured'}), 503
    state_token = secrets.token_urlsafe(24)
    next_path = request.args.get('next', '/league')
    session['discord_oauth_state'] = state_token
    session['discord_oauth_next'] = next_path
    cfg = _oauth_config()
    params = urlencode({
        'client_id': cfg['client_id'],
        'response_type': 'code',
        'redirect_uri': cfg['redirect_uri'],
        'scope': 'identify',
        'state': state_token,
        'prompt': 'consent',
    })
    return redirect(f'https://discord.com/oauth2/authorize?{params}')


@user_portal_v2_bp.route('/api/v2/oauth/discord/callback', methods=['GET'])
def discord_oauth_callback():
    expected_state = session.get('discord_oauth_state')
    state_token = request.args.get('state', '')
    code = request.args.get('code', '')
    if not expected_state or state_token != expected_state or not code:
        return redirect('/league?portalError=oauth')
    try:
        token_data = _exchange_code(code)
        access_token = token_data.get('access_token', '')
        if not access_token:
            return redirect('/league?portalError=token')
        discord_user = _fetch_discord_user(access_token)
        session['discord_user'] = discord_user
        session.pop('discord_oauth_state', None)
        next_path = session.pop('discord_oauth_next', '/league')
    except (URLError, HTTPError, Exception):
        return redirect('/league?portalError=fetch')
    return redirect(next_path or '/league')


@user_portal_v2_bp.route('/api/v2/user/session', methods=['GET'])
def user_session():
    user = _current_user()
    if not user:
        return jsonify({'user': None, 'linked': False, 'manager': None, 'teamCode': None})
    
    _update_last_active(user['id'])
    link = _get_user_link(user['id'])
    
    # Add full avatar URL to user object
    user_with_avatar = {**user, 'avatar': _avatar_url(user)}
    
    if not link:
        return jsonify({'user': user_with_avatar, 'linked': False, 'manager': None, 'teamCode': None})
    
    state = _load_state()
    manager = _find_manager_by_id(state, link['manager_id'])
    team_code = _get_team_for_manager(state, link['manager_id']) if manager else None
    
    return jsonify({
        'user': user_with_avatar,
        'linked': True,
        'manager': manager,
        'teamCode': team_code,
        'currentWeek': _current_week(state),
    })


@user_portal_v2_bp.route('/api/v2/user/logout', methods=['POST'])
def user_logout():
    session.pop('discord_user', None)
    session.pop('discord_oauth_state', None)
    session.pop('discord_oauth_next', None)
    return jsonify({'ok': True})


@user_portal_v2_bp.route('/api/v2/me/link-options', methods=['GET'])
def my_link_options():
    user, err = _require_user()
    if err:
        return err
    
    state = _load_state()
    conn = get_conn()
    linked_manager_ids = {row['manager_id'] for row in conn.execute('SELECT manager_id FROM user_links').fetchall()}
    conn.close()
    
    managers = [
        {
            'id': m['id'],
            'name': m.get('name', ''),
            'teamCode': _get_team_for_manager(state, m['id']),
        }
        for m in state.get('managers', [])
        if m['id'] not in linked_manager_ids
    ]
    
    return jsonify({'managers': managers})


@user_portal_v2_bp.route('/api/v2/me/link-manager', methods=['POST'])
def my_link_manager():
    user, err = _require_user()
    if err:
        return err
    
    body = request.get_json(force=True) or {}
    manager_id = body.get('managerId', '').strip()
    zamboni_tag = body.get('zamboniTag', '').strip()
    
    if not manager_id or not zamboni_tag:
        return jsonify({'error': 'Manager ID and RPCN account are required'}), 400
    
    state = _load_state()
    target = _find_manager_by_id(state, manager_id)
    if not target:
        return jsonify({'error': 'Manager not found'}), 404
    
    # Check if manager is already linked
    conn = get_conn()
    existing = conn.execute('SELECT discord_id FROM user_links WHERE manager_id = ?', (manager_id,)).fetchone()
    conn.close()
    
    if existing and existing['discord_id'] != user['id']:
        return jsonify({'error': 'Manager is already linked to another Discord account'}), 409
    
    # Validate Zamboni tag
    valid, err_msg = _validate_zamboni_tag(zamboni_tag)
    if valid is False:
        return jsonify({'error': err_msg or 'Invalid RPCN account'}), 400
    
    # Create or update link
    _create_or_update_user_link(user['id'], manager_id, user, zamboni_tag)
    
    # Also update manager record for backward compat
    target['discordId'] = user['id']
    target['discordUsername'] = user.get('username', '')
    target['discordAvatar'] = _avatar_url(user)
    target['zamboniTag'] = zamboni_tag
    target['lastLinkedAt'] = datetime.now(timezone.utc).isoformat()
    _save_state(state)
    
    return jsonify({
        'ok': True,
        'validated': valid is True,
        'manager': target,
        'teamCode': _get_team_for_manager(state, target['id']),
    })


@user_portal_v2_bp.route('/api/v2/me/score/games', methods=['GET'])
def my_score_games():
    user, err = _require_user()
    if err:
        return err
    
    link = _get_user_link(user['id'])
    if not link:
        return jsonify({'error': 'Account is not linked to a manager'}), 409
    
    state = _load_state()
    manager = _find_manager_by_id(state, link['manager_id'])
    if not manager:
        return jsonify({'error': 'Linked manager not found'}), 404
    
    team_code = _get_team_for_manager(state, manager['id'])
    if not team_code:
        return jsonify({'error': 'Linked manager has no team assigned'}), 409
    
    games = _eligible_games_for_manager(state, manager)
    return jsonify({
        'games': games,
        'teamCode': team_code,
        'currentWeek': _current_week(state),
        'manager': manager,
    })


@user_portal_v2_bp.route('/api/v2/me/score/matches/<game_id>', methods=['GET'])
def my_score_matches(game_id: str):
    user, err = _require_user()
    if err:
        return err
    
    link = _get_user_link(user['id'])
    if not link:
        return jsonify({'error': 'Account is not linked to a manager'}), 409
    
    state = _load_state()
    manager = _find_manager_by_id(state, link['manager_id'])
    if not manager:
        return jsonify({'error': 'Linked manager not found'}), 404
    
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


@user_portal_v2_bp.route('/api/v2/me/score', methods=['POST'])
def my_score_submit():
    user, err = _require_user()
    if err:
        return err
    
    link = _get_user_link(user['id'])
    if not link:
        return jsonify({'error': 'Account is not linked to a manager'}), 409
    
    body = request.get_json(force=True) or {}
    game_id = body.get('gameId', '').strip()
    home_score = int(body.get('homeScore', 0))
    away_score = int(body.get('awayScore', 0))
    ot = bool(body.get('ot', False))
    zamboni_game_id = body.get('zamboniGameId')
    zamboni_stats = body.get('zamboniStats')
    
    if not game_id:
        return jsonify({'error': 'Game ID is required'}), 400
    if home_score == away_score:
        return jsonify({'error': 'Scores cannot be tied'}), 400
    
    state = _load_state()
    manager = _find_manager_by_id(state, link['manager_id'])
    if not manager:
        return jsonify({'error': 'Linked manager not found'}), 404
    
    # Verify game exists and is eligible
    eligible_games = _eligible_games_for_manager(state, manager)
    game = next((g for g in eligible_games if str(g.get('id', '')) == str(game_id)), None)
    if not game:
        return jsonify({'error': 'Game is not eligible for score submission'}), 404
    
    # CRITICAL: Check if game is still unplayed
    fresh_state = _load_state()
    fresh_game = next((g for g in fresh_state.get('games', []) if g.get('id') == game_id), None)
    if not fresh_game:
        return jsonify({'error': 'Game not found'}), 404
    if fresh_game.get('played'):
        return jsonify({'error': 'Game has already been scored'}), 409
    
    # Create submission
    submission_id = _create_score_submission(
        game_id,
        user['id'],
        link['manager_id'],
        home_score,
        away_score,
        ot,
        zamboni_game_id,
        zamboni_stats,
        'website',
    )
    
    # Auto-approve for linked users
    success = _approve_score_submission(submission_id, approved_by='auto_website')
    
    if not success:
        return jsonify({'error': 'Score submission failed - game may have been scored by someone else'}), 409
    
    return jsonify({'ok': True, 'submissionId': submission_id})


@user_portal_v2_bp.route('/api/v2/admin/submissions', methods=['GET'])
@require_admin
def admin_list_submissions():
    """Admin endpoint to view all score submissions"""
    conn = get_conn()
    rows = conn.execute('''
        SELECT id, game_id, submitted_by_discord_id, submitted_by_manager_id,
               home_score, away_score, ot, source, submitted_at, status,
               approved_by, approved_at
        FROM score_submissions
        ORDER BY submitted_at DESC
        LIMIT 100
    ''').fetchall()
    conn.close()
    
    submissions = [dict(row) for row in rows]
    return jsonify({'submissions': submissions})


@user_portal_v2_bp.route('/api/v2/admin/links/sync', methods=['POST'])
@require_admin
def admin_sync_link():
    """Upsert a user_links row from the admin manager panel. Called on every Save."""
    data = request.get_json(silent=True) or {}
    manager_id = (data.get('manager_id') or '').strip()
    discord_id = (data.get('discord_id') or '').strip()
    zamboni_tag = (data.get('zamboni_tag') or '').strip()
    if not manager_id:
        return jsonify({'error': 'manager_id required'}), 400
    conn = get_conn()
    now = datetime.now(timezone.utc).isoformat()
    if not discord_id:
        conn.execute('DELETE FROM user_links WHERE manager_id = ?', (manager_id,))
    else:
        hashed = _hash_discord_id(discord_id)
        existing = conn.execute('SELECT id FROM user_links WHERE manager_id = ?', (manager_id,)).fetchone()
        if existing:
            conn.execute(
                'UPDATE user_links SET discord_id = ?, zamboni_tag = ?, updated_at = ? WHERE manager_id = ?',
                (hashed, zamboni_tag, now, manager_id),
            )
        else:
            conn.execute(
                '''INSERT INTO user_links (discord_id, manager_id, zamboni_tag, linked_at, updated_at, last_active_at, source)
                   VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (hashed, manager_id, zamboni_tag, now, now, now, 'admin'),
            )
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@user_portal_v2_bp.route('/api/v2/admin/links/unlink', methods=['POST'])
@require_admin
def admin_unlink_manager():
    """Remove the user_links row for a given manager_id."""
    data = request.get_json(silent=True) or {}
    manager_id = (data.get('manager_id') or '').strip()
    if not manager_id:
        return jsonify({'error': 'manager_id required'}), 400
    conn = get_conn()
    result = conn.execute('DELETE FROM user_links WHERE manager_id = ?', (manager_id,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True, 'deleted': result.rowcount})


@user_portal_v2_bp.route('/api/v2/admin/links', methods=['GET'])
@require_admin
def admin_list_links():
    """Admin endpoint to view all user links"""
    conn = get_conn()
    rows = conn.execute('''
        SELECT id, discord_id, manager_id, discord_username, zamboni_tag,
               linked_at, updated_at, last_active_at, source
        FROM user_links
        ORDER BY last_active_at DESC
    ''').fetchall()
    conn.close()
    
    links = [dict(row) for row in rows]
    return jsonify({'links': links})
