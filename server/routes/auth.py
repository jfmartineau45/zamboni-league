"""
routes/auth.py — POST /api/auth  (verify admin password → JWT)
Exports @require_admin decorator used by all protected routes.
"""
from flask import Blueprint, request, jsonify, g
from functools import wraps
import jwt
import json
import os
import ctypes
from datetime import datetime, timedelta, timezone
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


@auth_bp.route('/api/auth', methods=['POST'])
def login():
    body = request.get_json(force=True) or {}
    password = body.get('password', '')
    if not password:
        return jsonify({'error': 'password required'}), 400

    admin_hash = _get_admin_hash()
    # App uses simpleHash: polynomial rolling hash, 32-bit signed int, base-36
    pw_hash = _simple_hash(password)

    if not admin_hash:
        # First-time setup: set the password directly in the stored state blob
        try:
            conn = get_conn()
            row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
            if row:
                state = json.loads(row['data'])
                state.setdefault('league', {})['adminHash'] = pw_hash
                conn.execute(
                    "UPDATE league_state SET data=?, updated=datetime('now') WHERE id=1",
                    (json.dumps(state),)
                )
                conn.commit()
            conn.close()
        except Exception as exc:
            return jsonify({'error': f'Setup failed: {exc}'}), 500
    elif pw_hash != admin_hash:
        return jsonify({'error': 'Wrong password'}), 401

    token = jwt.encode(
        {'role': 'admin', 'exp': datetime.now(timezone.utc) + timedelta(hours=JWT_TTL_H)},
        JWT_SECRET, algorithm=JWT_ALGO
    )
    return jsonify({'token': token})


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
