"""
routes/zamboni.py — Proxy for the Zamboni NHL14Legacy API
Avoids CORS issues by fetching server-side. 5-minute in-memory cache.

Endpoints (all public, no auth):
  GET /api/zamboni/players        → all Zamboni gamertags (363 players)
  GET /api/zamboni/games          → all games with scores, shots, hits
  GET /api/zamboni/game/<id>      → per-game detailed report (66 fields/player)
"""
import time
import json
from urllib.request import urlopen, Request
from urllib.error import URLError
from flask import Blueprint, jsonify

zamboni_bp = Blueprint('zamboni', __name__)

ZAMBONI_ROOT = 'https://zamboni.gg'
ZAMBONI_BASE = f'{ZAMBONI_ROOT}/nhllegacy/api'   # primary — this league is NHL Legacy
ZAMBONI_VERSIONS = ['nhllegacy', 'nhl14']         # fallback order for player lookup
CACHE_TTL    = 300   # 5 minutes

_cache: dict = {}   # {key: (fetched_at, data)}


def _cached_get(key: str, url: str):
    """Fetch URL with simple in-memory cache. Returns parsed JSON or None on error."""
    now = time.time()
    if key in _cache and now - _cache[key][0] < CACHE_TTL:
        return _cache[key][1]

    try:
        req = Request(url, headers={'Accept': 'application/json', 'User-Agent': 'NHLLegacyLeague/1.0'})
        with urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode())
        _cache[key] = (now, data)
        return data
    except (URLError, Exception):
        # Return stale cache if available, else None
        if key in _cache:
            return _cache[key][1]
        return None


# ── Routes ────────────────────────────────────────────────────────────────────

@zamboni_bp.route('/api/zamboni/players', methods=['GET'])
def zamboni_players():
    """All Zamboni gamertags — used for manager settings autocomplete."""
    data = _cached_get('players', f'{ZAMBONI_BASE}/players')
    if data is None:
        return jsonify({'error': 'Zamboni API unavailable'}), 503
    return jsonify(data)


@zamboni_bp.route('/api/zamboni/games', methods=['GET'])
def zamboni_games():
    """All games with scores, shots, hits, gamertags, team names, status."""
    data = _cached_get('games', f'{ZAMBONI_BASE}/games')
    if data is None:
        return jsonify({'error': 'Zamboni API unavailable'}), 503
    return jsonify(data)


@zamboni_bp.route('/api/zamboni/game/<int:game_id>', methods=['GET'])
def zamboni_game(game_id: int):
    """Detailed per-game report — shots, hits, PP, faceoffs, TOA, pims per player."""
    data = _cached_get(f'game_{game_id}', f'{ZAMBONI_BASE}/game/{game_id}/reports')
    if data is None:
        return jsonify({'error': 'Zamboni API unavailable'}), 503
    return jsonify(data)


@zamboni_bp.route('/api/zamboni/player/<gamertag>', methods=['GET'])
def zamboni_player(gamertag: str):
    """Player summary + full game history.
    Tries nhllegacy first, falls back to nhl14 — players may be on either
    depending on platform (PS3 vs Xbox 360).
    Returns { profile, history, version }.
    """
    profile = None
    version_used = None

    for ver in ZAMBONI_VERSIONS:
        url = f'{ZAMBONI_ROOT}/{ver}/api/player/{gamertag}'
        data = _cached_get(f'profile_{ver}_{gamertag}', url)
        if data and data.get('userId'):
            profile = data
            version_used = ver
            break

    if profile is None:
        return jsonify({'error': 'Player not found on any Zamboni server'}), 404

    user_id = profile['userId']
    hist_url = f'{ZAMBONI_ROOT}/{version_used}/api/user/{user_id}/history'
    history  = _cached_get(f'history_{version_used}_{user_id}', hist_url)
    if history is None:
        history = []

    return jsonify({'profile': profile, 'history': history, 'version': version_used})
