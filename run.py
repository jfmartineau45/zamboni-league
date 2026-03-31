"""
run.py — launcher for the NHL Legacy League Flask server.
Run from any directory: python C:/path/to/roster-app/run.py
"""
import os
import sys

# Ensure imports work regardless of working directory
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)
os.chdir(BASE_DIR)

from server.db import init_db
from server.server import app

if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 3001))
    print(f"[NHL] Server running on http://localhost:{port}")
    app.run(host='0.0.0.0', port=port, debug=False)
