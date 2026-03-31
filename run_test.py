"""
run_test.py — Test server on port 3001 with an isolated test database.
Run: python run_test.py
Data stored in server/league_test.db (never touches league.db)
"""
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)
os.chdir(BASE_DIR)

# Point db module at the test database before importing anything else
os.environ['NHL_DB_PATH'] = os.path.join(BASE_DIR, 'server', 'league_test.db')
os.environ['PORT'] = '3001'

from server.db import init_db
from server.server import app

if __name__ == '__main__':
    init_db()
    print('[TEST] NHL Test Server on http://localhost:3001')
    print('[TEST] Database: server/league_test.db  (isolated from production)')
    app.run(host='0.0.0.0', port=3001, debug=False)
