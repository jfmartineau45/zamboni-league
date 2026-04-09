"""
botmanager.py — Manages the Discord bot as a child process.
The Flask server uses this to start/stop/restart the bot and tail its logs.
"""
import subprocess
import threading
import sys
import os
from collections import deque
from datetime import datetime, timezone

# Max log lines kept in memory
MAX_LOG_LINES = 100

_proc: subprocess.Popen | None = None
_log_lines: deque = deque(maxlen=MAX_LOG_LINES)
_lock = threading.Lock()


def _stream_output(proc: subprocess.Popen):
    """Read stdout+stderr from the bot process and buffer lines."""
    try:
        for raw in proc.stdout:
            line = raw.rstrip('\n')
            ts   = datetime.now(timezone.utc).strftime('%H:%M:%S')
            with _lock:
                _log_lines.append(f'[{ts}] {line}')
    except Exception:
        pass
    with _lock:
        _log_lines.append(f'[{datetime.now(timezone.utc).strftime("%H:%M:%S")}] — Bot process ended —')


def start() -> dict:
    global _proc
    with _lock:
        if _proc and _proc.poll() is None:
            return {'ok': False, 'error': 'Bot is already running'}

        # Bot lives in roster-app/bot/; run from roster-app/
        cwd = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env = os.environ.copy()
        # BOT_ENV not set = production (loads .env), BOT_ENV=dev = dev (loads .env.dev)
        # Pass bot secret through so it's available to the subprocess
        _log_lines.clear()
        _log_lines.append(f'[{datetime.now(timezone.utc).strftime("%H:%M:%S")}] Starting bot…')

        _proc = subprocess.Popen(
            [sys.executable, '-m', 'bot.bot'],
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

    t = threading.Thread(target=_stream_output, args=(_proc,), daemon=True)
    t.start()
    return {'ok': True, 'pid': _proc.pid}


def stop() -> dict:
    global _proc
    with _lock:
        if not _proc or _proc.poll() is not None:
            return {'ok': False, 'error': 'Bot is not running'}
        _proc.terminate()
    try:
        _proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _proc.kill()
    with _lock:
        _log_lines.append(f'[{datetime.now(timezone.utc).strftime("%H:%M:%S")}] Bot stopped by admin.')
    return {'ok': True}


def status() -> dict:
    with _lock:
        running = _proc is not None and _proc.poll() is None
        pid     = _proc.pid if running else None
        logs    = list(_log_lines)
    return {'running': running, 'pid': pid, 'logs': logs}
