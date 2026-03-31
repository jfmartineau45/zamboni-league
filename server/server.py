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

# Allow imports like "from server.db import ..."
# when running from the roster-app/ directory
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from flask import Flask, send_from_directory

from server.db import init_db
from server.routes.auth import auth_bp
from server.routes.state import state_bp
from server.routes.sysdata import sysdata_bp
from server.routes.pending import pending_bp
from server.routes.games import games_bp
from server import botmanager

# ── App setup ────────────────────────────────────────────────────────────────
STATIC_DIR = os.path.dirname(os.path.dirname(__file__))   # roster-app/

app = Flask(__name__, static_folder=None)

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
    response.headers['Access-Control-Allow-Origin'] = '*'
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



# ── Static file serving ───────────────────────────────────────────────────────
@app.route('/', defaults={'path': ''})
@app.route('/<path:path>')
def serve_static(path):
    if path and os.path.exists(os.path.join(STATIC_DIR, path)):
        return send_from_directory(STATIC_DIR, path)
    return send_from_directory(STATIC_DIR, 'index.html')


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 3001))
    print(f"[server] NHL Legacy League API running on http://localhost:{port}")
    print(f"[server] Static files from: {STATIC_DIR}")
    app.run(host='0.0.0.0', port=port, debug=False)
