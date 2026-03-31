"""
create_test_league.py
Creates a clean test league in a separate DB file for testing without touching Season 1 data.
Run from roster-app/:  py -3 create_test_league.py
"""
import sqlite3, json, uuid, os
from datetime import datetime, timedelta

DB_PATH = 'server/league_testenv.db'

# Wipe and recreate
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)

conn = sqlite3.connect(DB_PATH)
conn.execute("""CREATE TABLE league_state (
    id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL,
    updated TEXT NOT NULL DEFAULT (datetime('now')))""")
conn.execute("""CREATE TABLE sysdata_file (
    id INTEGER PRIMARY KEY CHECK (id=1), filename TEXT, size INTEGER,
    uploaded_at TEXT, data BLOB)""")
conn.execute("""CREATE TABLE pending_requests (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
    submitted_by TEXT NOT NULL, submitted_name TEXT,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT, reviewed_at TEXT, notes TEXT)""")
conn.commit()

# ── Test managers & teams ──────────────────────────────────────────────────────
managers = [
    {"id": "mgr1", "name": "TestAdmin",  "color": "#CE1126"},
    {"id": "mgr2", "name": "TestUser1",  "color": "#1f6feb"},
    {"id": "mgr3", "name": "TestUser2",  "color": "#3fb950"},
    {"id": "mgr4", "name": "TestUser3",  "color": "#d29922"},
    {"id": "mgr5", "name": "TestUser4",  "color": "#a371f7"},
    {"id": "mgr6", "name": "TestUser5",  "color": "#39d353"},
]

teamOwners = {
    "BOS": "mgr1",
    "TOR": "mgr2",
    "MTL": "mgr3",
    "NYR": "mgr4",
    "PIT": "mgr5",
    "CHI": "mgr6",
}

# ── Players (real names for each team) ────────────────────────────────────────
players = [
    # BOS
    {"id": 1001, "name": "David Pastrnak",  "teamCode": "BOS", "position": "RW", "ovr": 92, "plt": "SNP", "number": 88},
    {"id": 1002, "name": "Brad Marchand",   "teamCode": "BOS", "position": "LW", "ovr": 88, "plt": "TWF", "number": 63},
    {"id": 1003, "name": "Charlie McAvoy",  "teamCode": "BOS", "position": "D",  "ovr": 87, "plt": "TWD", "number": 73},
    {"id": 1004, "name": "Jeremy Swayman",  "teamCode": "BOS", "position": "G",  "ovr": 85, "plt": "GKP", "number": 1},
    # TOR
    {"id": 1011, "name": "Auston Matthews", "teamCode": "TOR", "position": "C",  "ovr": 95, "plt": "SNP", "number": 34},
    {"id": 1012, "name": "Mitch Marner",    "teamCode": "TOR", "position": "RW", "ovr": 92, "plt": "PLY", "number": 16},
    {"id": 1013, "name": "William Nylander","teamCode": "TOR", "position": "RW", "ovr": 88, "plt": "TWF", "number": 88},
    {"id": 1014, "name": "Joseph Woll",     "teamCode": "TOR", "position": "G",  "ovr": 82, "plt": "GKP", "number": 60},
    # MTL
    {"id": 1021, "name": "Cole Caufield",   "teamCode": "MTL", "position": "RW", "ovr": 87, "plt": "SNP", "number": 22},
    {"id": 1022, "name": "Nick Suzuki",     "teamCode": "MTL", "position": "C",  "ovr": 85, "plt": "TWF", "number": 14},
    {"id": 1023, "name": "Lane Hutson",     "teamCode": "MTL", "position": "D",  "ovr": 80, "plt": "OFD", "number": 48},
    {"id": 1024, "name": "Sam Montembeault","teamCode": "MTL", "position": "G",  "ovr": 80, "plt": "GKP", "number": 35},
    # NYR
    {"id": 1031, "name": "Artemi Panarin",  "teamCode": "NYR", "position": "LW", "ovr": 91, "plt": "TWF", "number": 10},
    {"id": 1032, "name": "Chris Kreider",   "teamCode": "NYR", "position": "LW", "ovr": 84, "plt": "PWF", "number": 20},
    {"id": 1033, "name": "Adam Fox",        "teamCode": "NYR", "position": "D",  "ovr": 90, "plt": "OFD", "number": 23},
    {"id": 1034, "name": "Igor Shesterkin", "teamCode": "NYR", "position": "G",  "ovr": 94, "plt": "GKP", "number": 31},
    # PIT
    {"id": 1041, "name": "Evgeni Malkin",   "teamCode": "PIT", "position": "C",  "ovr": 86, "plt": "TWF", "number": 71},
    {"id": 1042, "name": "Sidney Crosby",   "teamCode": "PIT", "position": "C",  "ovr": 90, "plt": "TWF", "number": 87},
    {"id": 1043, "name": "Kris Letang",     "teamCode": "PIT", "position": "D",  "ovr": 83, "plt": "OFD", "number": 58},
    {"id": 1044, "name": "Tristan Jarry",   "teamCode": "PIT", "position": "G",  "ovr": 80, "plt": "GKP", "number": 35},
    # CHI
    {"id": 1051, "name": "Connor Bedard",   "teamCode": "CHI", "position": "C",  "ovr": 88, "plt": "SNP", "number": 98},
    {"id": 1052, "name": "Taylor Hall",     "teamCode": "CHI", "position": "LW", "ovr": 80, "plt": "TWF", "number": 71},
    {"id": 1053, "name": "Seth Jones",      "teamCode": "CHI", "position": "D",  "ovr": 82, "plt": "TWD", "number": 4},
    {"id": 1054, "name": "Arvid Soderblom", "teamCode": "CHI", "position": "G",  "ovr": 76, "plt": "GKP", "number": 40},
]

# ── Schedule (6 teams = 3 games/week) ─────────────────────────────────────────
def gid(): return str(uuid.uuid4())[:8]

games = [
    # Week 1 — all played
    {"id": gid(), "week": 1, "game": 1, "homeTeam": "BOS", "awayTeam": "TOR", "homeScore": 4, "awayScore": 2, "played": True,  "ot": False, "playoff": False, "notes": ""},
    {"id": gid(), "week": 1, "game": 2, "homeTeam": "MTL", "awayTeam": "NYR", "homeScore": 1, "awayScore": 3, "played": True,  "ot": False, "playoff": False, "notes": ""},
    {"id": gid(), "week": 1, "game": 3, "homeTeam": "PIT", "awayTeam": "CHI", "homeScore": 5, "awayScore": 4, "played": True,  "ot": True,  "playoff": False, "notes": ""},
    # Week 2 — partially played
    {"id": gid(), "week": 2, "game": 1, "homeTeam": "TOR", "awayTeam": "MTL", "homeScore": 2, "awayScore": 0, "played": True,  "ot": False, "playoff": False, "notes": ""},
    {"id": gid(), "week": 2, "game": 2, "homeTeam": "NYR", "awayTeam": "PIT", "homeScore": 0, "awayScore": 0, "played": False, "ot": False, "playoff": False, "notes": ""},
    {"id": gid(), "week": 2, "game": 3, "homeTeam": "CHI", "awayTeam": "BOS", "homeScore": 0, "awayScore": 0, "played": False, "ot": False, "playoff": False, "notes": ""},
    # Week 3 — all upcoming
    {"id": gid(), "week": 3, "game": 1, "homeTeam": "BOS", "awayTeam": "MTL", "homeScore": 0, "awayScore": 0, "played": False, "ot": False, "playoff": False, "notes": ""},
    {"id": gid(), "week": 3, "game": 2, "homeTeam": "TOR", "awayTeam": "PIT", "homeScore": 0, "awayScore": 0, "played": False, "ot": False, "playoff": False, "notes": ""},
    {"id": gid(), "week": 3, "game": 3, "homeTeam": "CHI", "awayTeam": "NYR", "homeScore": 0, "awayScore": 0, "played": False, "ot": False, "playoff": False, "notes": ""},
]

# ── Trades ─────────────────────────────────────────────────────────────────────
trades = [
    {
        "id": str(uuid.uuid4())[:8],
        "date": "2026-03-25",
        "fromTeam": "BOS",
        "toTeam": "PIT",
        "playersSent": ["Brad Marchand"],
        "playersReceived": ["Evgeni Malkin"],
        "notes": "Test trade — can reverse this",
    },
]

# Apply trade to rosters
for p in players:
    if p["name"] == "Brad Marchand":  p["teamCode"] = "PIT"
    if p["name"] == "Evgeni Malkin":  p["teamCode"] = "BOS"

# ── Build full state ──────────────────────────────────────────────────────────
state = {
    "league":           {"name": "TEST LEAGUE — DO NOT USE", "season": "Test", "adminHash": ""},
    "managers":         managers,
    "teamOwners":       teamOwners,
    "teamCoOwners":     {},
    "players":          players,
    "games":            games,
    "trades":           trades,
    "draft":            {"active": False, "rounds": 1, "order": [], "picks": []},
    "liveDraft":        {"active": False, "rounds": 1, "order": [], "picks": [], "autoManagers": []},
    "playerDraft":      [],
    "draftTab":         "live",
    "playoffs":         None,
    "lines":            {},
    "currentSeason":    1,
    "currentWeek":      None,
    "seasons":          [],
    "sysDataFile":      None,
    "scheduleStartDate": "2026-03-15",
    "rules":            None,
    "playoffFormat": [
        {"name": "First Round",       "winTo": 2},
        {"name": "Second Round",      "winTo": 3},
        {"name": "Conference Finals", "winTo": 3},
        {"name": "Championship",      "winTo": 4},
    ],
}

blob = json.dumps(state)
conn.execute("INSERT INTO league_state (id, data, updated) VALUES (1, ?, datetime('now'))", (blob,))
conn.commit()
conn.close()

print("Test league created:", DB_PATH)
print(f"  Managers : {len(managers)}")
print(f"  Teams    : {len(teamOwners)}")
print(f"  Players  : {len(players)}")
print(f"  Games    : {len(games)} ({sum(1 for g in games if g['played'])} played)")
print(f"  Trades   : {len(trades)}")
print()
print("To use: set NHL_DB_PATH=server/league_TEST.db in your .env then restart the server")
print("To restore Season 1: remove NHL_DB_PATH from .env (or set it back to server/league.db)")
