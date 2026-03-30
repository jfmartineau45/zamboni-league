"""
routes/games.py — bot-facing score submission endpoint
POST /api/bot/score  — trusted endpoint, requires X-Bot-Secret header
GET  /api/teams      — public team list
"""
import json
import os
from flask import Blueprint, request, jsonify
from server.db import get_conn

games_bp = Blueprint('games', __name__)

# Full NHL team name lookup (matches app.js NHL_TEAMS)
_TEAM_NAMES = {
    "ANA":"Anaheim Ducks","WPG":"Winnipeg Jets","BOS":"Boston Bruins","BUF":"Buffalo Sabres",
    "CGY":"Calgary Flames","CAR":"Carolina Hurricanes","CHI":"Chicago Blackhawks",
    "COL":"Colorado Avalanche","CBJ":"Columbus Blue Jackets","DAL":"Dallas Stars",
    "DET":"Detroit Red Wings","EDM":"Edmonton Oilers","FLA":"Florida Panthers",
    "LA":"Los Angeles Kings","MIN":"Minnesota Wild","MTL":"Montreal Canadiens",
    "NSH":"Nashville Predators","NJ":"New Jersey Devils","NYI":"New York Islanders",
    "NYR":"New York Rangers","OTT":"Ottawa Senators","PHI":"Philadelphia Flyers",
    "PIT":"Pittsburgh Penguins","SJ":"San Jose Sharks","SEA":"Seattle Kraken",
    "STL":"St. Louis Blues","TB":"Tampa Bay Lightning","TOR":"Toronto Maple Leafs",
    "VAN":"Vancouver Canucks","VGK":"Vegas Golden Knights","WSH":"Washington Capitals",
    "UTI":"Utah Hockey Club",
}


def _check_bot_secret():
    secret = os.environ.get('NHL_BOT_SECRET', '')
    if secret and request.headers.get('X-Bot-Secret', '') != secret:
        return False
    return True


@games_bp.route('/api/teams', methods=['GET'])
def list_teams():
    """Public endpoint — returns managed team list derived from games + teamOwners."""
    conn = get_conn()
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    conn.close()
    if not row:
        return jsonify([])
    try:
        state = json.loads(row['data'])

        # Collect all team codes that appear in games (these are the active managed teams)
        codes: set[str] = set()
        for g in state.get('games', []):
            ht = g.get('homeTeam') or g.get('home', '')
            at = g.get('awayTeam') or g.get('away', '')
            if ht: codes.add(ht.upper())
            if at: codes.add(at.upper())

        # Also include any team that has an owner assigned
        for code in state.get('teamOwners', {}).keys():
            codes.add(code.upper())

        # Build manager name lookup: manager id → name
        mgr_names = {m['id']: m.get('name', '') for m in state.get('managers', [])}
        team_owners = state.get('teamOwners', {})

        result = []
        for code in sorted(codes):
            mgr_id   = team_owners.get(code, '')
            mgr_name = mgr_names.get(mgr_id, '')
            result.append({
                'code':    code,
                'name':    _TEAM_NAMES.get(code, code),
                'manager': mgr_name,
            })

        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@games_bp.route('/api/bot/score', methods=['POST'])
def bot_score():
    """
    Directly apply a game result. Requires X-Bot-Secret header.
    Body: { gameId, homeScore, awayScore, ot }
    OR:   { homeTeam, awayTeam, homeScore, awayScore, ot } — finds game by teams
    """
    if not _check_bot_secret():
        return jsonify({'error': 'Forbidden'}), 403

    body = request.get_json(force=True) or {}

    home_score = body.get('homeScore')
    away_score = body.get('awayScore')
    ot         = bool(body.get('ot', False))

    if home_score is None or away_score is None:
        return jsonify({'error': 'homeScore and awayScore required'}), 400

    home_score = int(home_score)
    away_score = int(away_score)

    conn = get_conn()
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'No state in database'}), 404

    state = json.loads(row['data'])
    games = state.get('games', [])

    game = None
    game_id = body.get('gameId')

    if game_id:
        game = next((g for g in games if g.get('id') == game_id), None)
    else:
        home_team = (body.get('homeTeam') or '').upper()
        away_team = (body.get('awayTeam') or '').upper()
        if not home_team or not away_team:
            conn.close()
            return jsonify({'error': 'gameId or homeTeam+awayTeam required'}), 400
        # Find the earliest unplayed game matching these teams
        for g in games:
            ht = (g.get('homeTeam') or g.get('home') or '').upper()
            at = (g.get('awayTeam') or g.get('away') or '').upper()
            if ht == home_team and at == away_team and not g.get('played'):
                game = g
                break

    if not game:
        conn.close()
        return jsonify({'error': 'Game not found or already played'}), 404

    # Apply result
    game['played']    = True
    game['homeScore'] = home_score
    game['awayScore'] = away_score
    game['ot']        = ot
    if home_score > away_score:
        game['winner'] = game.get('homeTeam') or game.get('home')
    else:
        game['winner'] = game.get('awayTeam') or game.get('away')

    conn.execute(
        "UPDATE league_state SET data=?, updated=datetime('now') WHERE id=1",
        (json.dumps(state),)
    )
    conn.commit()
    conn.close()

    return jsonify({'ok': True, 'game': game})
