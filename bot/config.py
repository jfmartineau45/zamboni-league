"""
config.py — Load environment variables from .env (or system env)
"""
import os
from pathlib import Path

# Load .env from bot/ directory if present
_env_path = Path(__file__).parent / '.env'
if _env_path.exists():
    from dotenv import load_dotenv
    load_dotenv(_env_path)


def _int(key: str, default: int = 0) -> int:
    v = os.environ.get(key, '')
    try:
        return int(v) if v.strip() else default
    except ValueError:
        return default


DISCORD_TOKEN   = os.environ.get('DISCORD_TOKEN', '')
BOT_SECRET      = os.environ.get('NHL_BOT_SECRET', '')
ADMIN_PASSWORD  = os.environ.get('ADMIN_PASSWORD', '')
API_BASE        = os.environ.get('API_BASE', 'http://localhost:3000').rstrip('/')
# Public-facing URL shown in Discord links (same as API_BASE if not set)
APP_URL         = os.environ.get('APP_URL', '').rstrip('/') or API_BASE
GUILD_ID        = _int('GUILD_ID')
SCORES_CHANNEL  = _int('SCORES_CHANNEL')
TRADES_CHANNEL  = _int('TRADES_CHANNEL')
PENDING_CHANNEL = _int('PENDING_CHANNEL')
ADMIN_ROLE_ID   = _int('ADMIN_ROLE_ID')
