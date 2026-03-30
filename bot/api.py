"""
api.py — Async helpers for calling the Flask API
"""
import aiohttp
from bot.config import API_BASE, BOT_SECRET


def _bot_headers() -> dict:
    h = {'Content-Type': 'application/json'}
    if BOT_SECRET:
        h['X-Bot-Secret'] = BOT_SECRET
    return h


async def api_get(path: str, token: str = '') -> tuple[int, dict | list]:
    headers = _bot_headers()
    if token:
        headers['Authorization'] = f'Bearer {token}'
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{API_BASE}{path}", headers=headers) as r:
            try:
                data = await r.json(content_type=None)
            except Exception:
                data = {}
            return r.status, data


async def api_post(path: str, data: dict, bot_auth: bool = True) -> tuple[int, dict]:
    headers = _bot_headers() if bot_auth else {'Content-Type': 'application/json'}
    async with aiohttp.ClientSession() as session:
        async with session.post(f"{API_BASE}{path}", json=data, headers=headers) as r:
            try:
                body = await r.json(content_type=None)
            except Exception:
                body = {}
            return r.status, body


async def api_patch(path: str, data: dict, token: str = '') -> tuple[int, dict]:
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    async with aiohttp.ClientSession() as session:
        async with session.patch(f"{API_BASE}{path}", json=data, headers=headers) as r:
            try:
                body = await r.json(content_type=None)
            except Exception:
                body = {}
            return r.status, body


def _normalize_ids(state: dict) -> dict:
    """Coerce all game/player/team IDs to strings so comparisons never fail
    due to int vs str mismatches (JSON can return either)."""
    for g in state.get('games', []):
        if 'id' in g:
            g['id'] = str(g['id'])
    for p in state.get('players', []):
        if 'id' in p:
            p['id'] = str(p['id'])
    for t in state.get('teams', []):
        if 'id' in t:
            t['id'] = str(t['id'])
    return state


async def get_state() -> dict:
    status, data = await api_get('/api/state')
    if status == 200 and isinstance(data, dict):
        return _normalize_ids(data)
    return {}


async def get_teams() -> list[dict]:
    status, data = await api_get('/api/teams')
    if status == 200 and isinstance(data, list):
        return data
    return []


async def get_discord_config() -> dict:
    """Return discordConfig from league state, or empty dict if not set."""
    state = await get_state()
    return state.get('discordConfig') or {}
