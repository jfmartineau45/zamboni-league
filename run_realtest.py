"""
run_realtest.py — Test server on port 3002 with the real Zamboni test database.
Run: python run_realtest.py
"""
import os, sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)
os.chdir(BASE_DIR)

os.environ['NHL_DB_PATH'] = os.path.join(BASE_DIR, 'server', 'league_realtest.db')
os.environ['PORT'] = '3002'

from server.db import init_db
from server.server import app

if __name__ == '__main__':
    init_db()
    print('[REALTEST] NHL Real-Data Test Server on http://localhost:3002')
    print('[REALTEST] Database: server/league_realtest.db')
    app.run(host='0.0.0.0', port=3002, debug=False)
