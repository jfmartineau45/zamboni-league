"""
routes/auth.py — POST /api/auth  (verify admin password → JWT)
Exports @require_admin decorator used by all protected routes.
"""
from flask import Blueprint, request, jsonify, g
from functools import wraps
from collections import deque
import jwt
import json
import os
import ctypes
from datetime import datetime, timedelta, timezone
import bcrypt
from server.db import get_conn


def _to_i32(n):
    return ctypes.c_int32(n & 0xFFFFFFFF).value


def _simple_hash(s):
    """Replicates app.js simpleHash() — polynomial rolling hash → base-36."""
    h = 0
    for c in s:
        h = _to_i32(_to_i32(31 * h) + ord(c))
    n = abs(h)
    if n == 0:
        return '0'
    digits, result = '0123456789abcdefghijklmnopqrstuvwxyz', ''
    while n:
        result = digits[n % 36] + result
        n //= 36
    return result

auth_bp = Blueprint('auth', __name__)

JWT_SECRET = os.environ.get('NHL_JWT_SECRET', 'nhl-legacy-league-secret-change-me')
JWT_ALGO   = 'HS256'
JWT_TTL_H  = 12
AUTH_RATE_LIMIT_WINDOW_S = 300
AUTH_RATE_LIMIT_ATTEMPTS = 5
AUTH_RATE_LIMIT_LOCKOUT_S = 900
_AUTH_ATTEMPTS = {}


def _get_admin_hash():
    """Read adminHash from stored state blob."""
    conn = get_conn()
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    conn.close()
    if not row:
        return None
    try:
        state = json.loads(row['data'])
        return state.get('league', {}).get('adminHash')
    except Exception:
        return None


def _load_state_blob():
    conn = get_conn()
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    conn.close()
    if not row:
        return None
    try:
        return json.loads(row['data'])
    except Exception:
        return None


def _save_admin_hash(admin_hash: str):
    conn = get_conn()
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    if not row:
        state = {'league': {}}
    else:
        state = json.loads(row['data'])
    state.setdefault('league', {})['adminHash'] = admin_hash
    conn.execute(
        """
        INSERT INTO league_state (id, data, updated)
        VALUES (1, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated
        """,
        (json.dumps(state),)
    )
    conn.commit()
    conn.close()


def _password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def _is_bcrypt_hash(value: str | None) -> bool:
    return bool(value and value.startswith('$2'))


def _record_failed_attempt(client_id: str):
    now = datetime.now(timezone.utc).timestamp()
    entry = _AUTH_ATTEMPTS.setdefault(client_id, {'attempts': deque(), 'locked_until': 0})
    attempts = entry['attempts']
    while attempts and now - attempts[0] > AUTH_RATE_LIMIT_WINDOW_S:
        attempts.popleft()
    attempts.append(now)
    if len(attempts) >= AUTH_RATE_LIMIT_ATTEMPTS:
        entry['locked_until'] = now + AUTH_RATE_LIMIT_LOCKOUT_S


def _clear_failed_attempts(client_id: str):
    _AUTH_ATTEMPTS.pop(client_id, None)


def _rate_limit_error(client_id: str):
    now = datetime.now(timezone.utc).timestamp()
    entry = _AUTH_ATTEMPTS.setdefault(client_id, {'attempts': deque(), 'locked_until': 0})
    attempts = entry['attempts']
    while attempts and now - attempts[0] > AUTH_RATE_LIMIT_WINDOW_S:
        attempts.popleft()
    if entry['locked_until'] > now:
        retry_after = max(1, int(entry['locked_until'] - now))
        resp = jsonify({'error': 'Too many login attempts. Try again later.'})
        resp.status_code = 429
        resp.headers['Retry-After'] = str(retry_after)
        return resp
    if entry['locked_until'] and entry['locked_until'] <= now:
        entry['locked_until'] = 0
        entry['attempts'].clear()
    return None


def _client_id():
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',', 1)[0].strip()
    return request.remote_addr or 'unknown'


def _issue_token():
    return jwt.encode(
        {'role': 'admin', 'exp': datetime.now(timezone.utc) + timedelta(hours=JWT_TTL_H)},
        JWT_SECRET, algorithm=JWT_ALGO
    )


@auth_bp.route('/api/auth', methods=['POST'])
def login():
    client_id = _client_id()
    limited = _rate_limit_error(client_id)
    if limited is not None:
        return limited

    body = request.get_json(force=True) or {}
    password = body.get('password', '')
    if not password:
        return jsonify({'error': 'password required'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400

    admin_hash = _get_admin_hash()
    pw_hash = _simple_hash(password)

    if not admin_hash:
        try:
            _save_admin_hash(_password_hash(password))
        except Exception as exc:
            return jsonify({'error': f'Setup failed: {exc}'}), 500
    elif _is_bcrypt_hash(admin_hash):
        if not bcrypt.checkpw(password.encode('utf-8'), admin_hash.encode('utf-8')):
            _record_failed_attempt(client_id)
            return jsonify({'error': 'Wrong password'}), 401
    elif pw_hash == admin_hash:
        try:
            _save_admin_hash(_password_hash(password))
        except Exception as exc:
            return jsonify({'error': f'Password migration failed: {exc}'}), 500
    else:
        _record_failed_attempt(client_id)
        return jsonify({'error': 'Wrong password'}), 401

    _clear_failed_attempts(client_id)
    token = _issue_token()
    return jsonify({'token': token})


@auth_bp.route('/api/auth/session', methods=['GET'])
def auth_session():
    ok, err = check_auth()
    if not ok:
        return err
    return jsonify({'ok': True, 'role': getattr(g, 'admin_role', None)})


@auth_bp.route('/api/auth/password', methods=['POST'])
def update_password():
    ok, err = check_auth()
    if not ok:
        return err
    body = request.get_json(force=True) or {}
    password = body.get('password', '')
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400
    try:
        _save_admin_hash(_password_hash(password))
    except Exception as exc:
        return jsonify({'error': f'Password update failed: {exc}'}), 500
    return jsonify({'ok': True})


def _extract_token():
    auth_header = request.headers.get('Authorization', '')
    if auth_header.startswith('Bearer '):
        return auth_header[7:]
    return request.headers.get('X-Admin-Token', '')


def check_auth():
    """Returns (True, None) if valid token, else (False, error_response_tuple)."""
    token = _extract_token()
    if not token:
        return False, (jsonify({'error': 'Unauthorized'}), 401)
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        g.admin_role = payload.get('role')
        return True, None
    except jwt.ExpiredSignatureError:
        return False, (jsonify({'error': 'Token expired'}), 401)
    except jwt.InvalidTokenError:
        return False, (jsonify({'error': 'Invalid token'}), 401)


def require_admin(f):
    """Requires valid admin JWT in Authorization: Bearer <token> or X-Admin-Token header."""
    @wraps(f)
    def decorated(*args, **kwargs):
        ok, err = check_auth()
        if not ok:
            return err
        return f(*args, **kwargs)
    return decorated
