"""
config.py — Load environment variables from .env (or system env)

To run the dev bot against the test server, set BOT_ENV=dev before launching:
    BOT_ENV=dev python -m bot.bot          (Mac/Linux)
    set BOT_ENV=dev && python -m bot.bot   (Windows cmd)
    $env:BOT_ENV="dev"; python -m bot.bot  (Windows PowerShell)

This loads bot/.env.dev instead of bot/.env, keeping dev and prod completely
separate (different tokens, different guild, points to localhost:3001).
"""
import os
import sys
from pathlib import Path

# BOT_ENV=dev → loads .env.dev; anything else → loads .env
_bot_env   = os.environ.get('BOT_ENV', '').strip()
_env_file  = f'.env.{_bot_env}' if _bot_env else '.env'
_env_path  = Path(__file__).parent / _env_file
if _env_path.exists():
    from dotenv import load_dotenv
    load_dotenv(_env_path)
elif _bot_env:
    print(f'[config] WARNING: BOT_ENV={_bot_env!r} but {_env_path} not found — falling back to .env', file=sys.stderr)
    _fallback = Path(__file__).parent / '.env'
    if _fallback.exists():
        from dotenv import load_dotenv
        load_dotenv(_fallback)

BOT_ENV = _bot_env or 'prod'


def _int(key: str, default: int = 0) -> int:
    v = os.environ.get(key, '')
    try:
        return int(v) if v.strip() else default
    except ValueError:
        return default


def _normalized_url(key: str, default: str = '') -> str:
    raw = os.environ.get(key, '').strip() or default
    return raw.rstrip('/') if raw else ''


DISCORD_TOKEN   = os.environ.get('DISCORD_TOKEN', '')
BOT_SECRET      = os.environ.get('NHL_BOT_SECRET', '')
ADMIN_PASSWORD  = os.environ.get('ADMIN_PASSWORD', '')
API_BASE        = _normalized_url('API_BASE', 'http://localhost:3001')
# Public-facing URL shown in Discord links (same as API_BASE if not set)
APP_URL         = _normalized_url('APP_URL') or API_BASE
GUILD_ID        = _int('GUILD_ID')
SCORES_CHANNEL  = _int('SCORES_CHANNEL')
TRADES_CHANNEL  = _int('TRADES_CHANNEL')
PENDING_CHANNEL = _int('PENDING_CHANNEL')
ADMIN_ROLE_ID   = _int('ADMIN_ROLE_ID')

# Power rankings
GROQ_API_KEY           = os.environ.get('GROQ_API_KEY', '')
POWER_RANKINGS_CHANNEL = _int('POWER_RANKINGS_CHANNEL')
POWER_RANKINGS_DAY     = _int('POWER_RANKINGS_DAY', 0)   # 0=Mon … 6=Sun
POWER_RANKINGS_HOUR    = _int('POWER_RANKINGS_HOUR', 13)  # UTC hour (default 13 = 9am Eastern)


def startup_warnings() -> list[str]:
    warnings = []
    if not DISCORD_TOKEN:
        warnings.append('DISCORD_TOKEN is not set; the bot cannot connect to Discord.')
    if not BOT_SECRET:
        warnings.append('NHL_BOT_SECRET is not set; bot-authenticated API calls may fail.')
    if not API_BASE:
        warnings.append('API_BASE is empty; bot API calls cannot be constructed.')
    if API_BASE and 'localhost' in API_BASE and BOT_ENV != 'dev':
        warnings.append('API_BASE points at localhost outside BOT_ENV=dev; verify this is intentional.')
    if APP_URL and 'localhost' in APP_URL and BOT_ENV != 'dev':
        warnings.append('APP_URL points at localhost outside BOT_ENV=dev; Discord links may be wrong for shared environments.')
    if not GUILD_ID:
        warnings.append('GUILD_ID is not set; guild-scoped sync and channel access may fail.')
    if not any([SCORES_CHANNEL, TRADES_CHANNEL, PENDING_CHANNEL, POWER_RANKINGS_CHANNEL]):
        warnings.append('No bot output channels are configured yet.')
    if POWER_RANKINGS_CHANNEL and not GROQ_API_KEY:
        warnings.append('POWER_RANKINGS_CHANNEL is set but GROQ_API_KEY is missing.')
    return warnings


def log_startup_config() -> None:
    print(f'[config] BOT_ENV={BOT_ENV}')
    print(f'[config] API_BASE={API_BASE or "(unset)"}')
    print(f'[config] APP_URL={APP_URL or "(unset)"}')
    for warning in startup_warnings():
        print(f'[config][warning] {warning}', file=sys.stderr)


log_startup_config()
