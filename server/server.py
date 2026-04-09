"""
server.py — Flask app entry point
Serves roster-app/ as static files AND exposes /api/* endpoints.

Run:
    python -m server.server
  or
    python roster-app/server/server.py   (from nhlviewng/)
"""
import os
import sys
import secrets

# Allow imports like "from server.db import ..."
# when running from the roster-app/ directory
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from flask import Flask, jsonify, request, send_from_directory

from server.db import init_db
from server.routes.auth import auth_bp
from server.routes.state import state_bp
from server.routes.sysdata import sysdata_bp
from server.routes.pending import pending_bp
from server.routes.games import games_bp
from server.routes.zamboni import zamboni_bp
from server.routes.bot_events import bot_events_bp
from server.routes.user_portal_v2 import user_portal_v2_bp
from server import botmanager

# Kill any orphaned bot processes left over from a previous server instance
import subprocess as _sp
_sp.run(['pkill', '-f', 'python -m bot.bot'], capture_output=True)

# ── App setup ────────────────────────────────────────────────────────────────
STATIC_DIR = os.path.dirname(os.path.dirname(__file__))   # roster-app/
ALLOWED_CORS_ORIGINS = {
    origin.strip() for origin in os.environ.get('NHL_CORS_ORIGINS', '').split(',') if origin.strip()
}


def _app_base_path() -> str:
    raw = (os.environ.get('APP_BASE_PATH', '/') or '/').strip()
    if not raw.startswith('/'):
        raw = '/' + raw
    raw = raw.rstrip('/')
    return raw or '/'


def _startup_warnings() -> list[str]:
    warnings = []
    flask_secret = os.environ.get('FLASK_SECRET_KEY', '').strip()
    jwt_secret = os.environ.get('NHL_JWT_SECRET', '').strip()
    redirect_uri = os.environ.get('DISCORD_REDIRECT_URI', '').strip()
    client_id = os.environ.get('DISCORD_CLIENT_ID', '').strip()
    client_secret = os.environ.get('DISCORD_CLIENT_SECRET', '').strip()
    app_url = os.environ.get('APP_URL', '').strip()
    app_base_path = _app_base_path()

    if not flask_secret:
        warnings.append('FLASK_SECRET_KEY is not set; sessions will not remain stable across restarts.')
    if jwt_secret and jwt_secret == 'nhl-legacy-league-secret-change-me':
        warnings.append('NHL_JWT_SECRET is still using the default value.')
    if any([client_id, client_secret, redirect_uri]) and not all([client_id, client_secret, redirect_uri]):
        warnings.append('Discord OAuth config is partially set; DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI should be provided together.')
    if redirect_uri and '/api/v2/oauth/discord/callback' not in redirect_uri:
        warnings.append('DISCORD_REDIRECT_URI does not point at the v2 portal callback path.')
    if app_url and 'localhost' in app_url and os.environ.get('BOT_ENV', '').strip() != 'dev':
        warnings.append('APP_URL points at localhost; verify this is intentional for the current environment.')
    if app_base_path != '/' and not redirect_uri:
        warnings.append('APP_BASE_PATH is set but DISCORD_REDIRECT_URI is missing; verify OAuth redirects before deployment.')

    return warnings


def log_startup_config(port: int):
    host = os.environ.get('APP_URL', '').strip() or f'http://localhost:{port}'
    print(f"[server] NHL Legacy League API running on http://localhost:{port}")
    print(f"[server] Public app URL: {host}")
    print(f"[server] App base path: {_app_base_path()}")
    print(f"[server] Static files from: {STATIC_DIR}")
    for warning in _startup_warnings():
        print(f"[server][warning] {warning}", file=sys.stderr)

app = Flask(__name__, static_folder=None)
app.secret_key = os.environ.get('FLASK_SECRET_KEY', '') or os.environ.get('NHL_JWT_SECRET', '') or secrets.token_hex(32)

@app.route('/api/ping', methods=['GET', 'POST'])
def ping():
    from flask import request, jsonify
    return jsonify({'method': request.method, 'ok': True})


# ── Bot control endpoints (admin only) ───────────────────────────────────────
@app.route('/api/admin/bot/status', methods=['GET'])
def bot_status():
    from flask import jsonify
    from server.routes.auth import check_auth
    ok, err = check_auth()
    if not ok:
        return err
    return jsonify(botmanager.status())

@app.route('/api/admin/bot/start', methods=['POST'])
def bot_start():
    from flask import jsonify
    from server.routes.auth import check_auth
    ok, err = check_auth()
    if not ok:
        return err
    return jsonify(botmanager.start())

@app.route('/api/admin/bot/stop', methods=['POST'])
def bot_stop():
    from flask import jsonify
    from server.routes.auth import check_auth
    ok, err = check_auth()
    if not ok:
        return err
    return jsonify(botmanager.stop())

@app.after_request
def add_cors(response):
    origin = request.headers.get('Origin')
    if not origin:
        return response
    if origin in ALLOWED_CORS_ORIGINS:
        response.headers['Access-Control-Allow-Origin'] = origin
        response.headers['Vary'] = 'Origin'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Admin-Token, X-Bot-Secret'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    return response

@app.route('/api/<path:path>', methods=['OPTIONS'])
def options_handler(path):
    from flask import Response
    return Response('', 204)

# ── Register API blueprints ───────────────────────────────────────────────────
app.register_blueprint(auth_bp)
app.register_blueprint(state_bp)
app.register_blueprint(sysdata_bp)
app.register_blueprint(pending_bp)
app.register_blueprint(games_bp)
app.register_blueprint(zamboni_bp)
app.register_blueprint(bot_events_bp)
app.register_blueprint(user_portal_v2_bp)



# ── Static file serving ───────────────────────────────────────────────────────
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_static(path):
    if path.startswith('api/'):
        return jsonify({'error': 'API route not found', 'path': f'/{path}'}), 404
    if path and os.path.exists(os.path.join(STATIC_DIR, path)):
        return send_from_directory(STATIC_DIR, path)
    return send_from_directory(STATIC_DIR, 'index.html')


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 3001))
    log_startup_config(port)
    app.run(host='0.0.0.0', port=port, debug=False)
