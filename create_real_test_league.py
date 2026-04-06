"""
create_real_test_league.py
Builds a full test league using REAL Zamboni player data.

Steps:
  1. Fetch all Zamboni player gamertags
  2. Fetch game histories for each to find active players
  3. Pick the 16 most active players
  4. Generate a 5-week schedule (8 games/week = all 16 play each week)
  5. For each matchup, pull real Zamboni game history between the two players
  6. Mark games played with real scores + zamboniStats where available
  7. Write to server/league_realtest.db

Run from roster-app/ with the server running on port 5000:
    py -3 create_real_test_league.py
or point to a different server:
    py -3 create_real_test_league.py --base http://localhost:3001
"""
import argparse
import json
import os
import random
import sqlite3
import sys
import time
import uuid
from urllib.request import urlopen, Request
from urllib.error import URLError

# ── Config ────────────────────────────────────────────────────────────────────

DB_PATH  = 'server/league_realtest.db'
TEAMS    = [
    'ANA','WPG','BOS','BUF','CGY','CAR','CHI','COL',
    'CBJ','DAL','DET','EDM','FLA','LAK','MIN','MTL',
    'NSH','NJD','NYI','NYR','OTT','PHI','PIT','STL',
    'SJS','TBL','TOR','VAN','VGK','WSH','WPG','ARI',
][:16]   # 16 teams for 8-game weeks

WEEKS          = 5
GAMES_PER_WEEK = 8   # = 16 teams / 2
MIN_GAMES      = 5   # player must have ≥5 history entries to qualify

# ── CLI args ──────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser()
parser.add_argument('--base', default='http://localhost:5000', help='API base URL')
args = parser.parse_args()
BASE = args.base.rstrip('/')

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _get(url: str, timeout: int = 10):
    try:
        req = Request(url, headers={'Accept': 'application/json', 'User-Agent': 'RealTestSetup/1.0'})
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        print(f'  [WARN] GET {url}: {e}')
        return None


def fetch(path: str):
    return _get(f'{BASE}{path}')

# ── Step 1: Get player list ───────────────────────────────────────────────────

print('Fetching Zamboni player list…')
raw_players = fetch('/api/zamboni/players')
if not raw_players or not isinstance(raw_players, list):
    print('ERROR: Could not fetch /api/zamboni/players — is the server running?')
    print(f'  Base URL: {BASE}')
    sys.exit(1)

# Normalise: list may contain strings or objects with a gamertag field
all_tags = []
for p in raw_players:
    if isinstance(p, str):
        all_tags.append(p)
    elif isinstance(p, dict):
        t = p.get('gamertag') or p.get('name') or ''
        if t:
            all_tags.append(t)

print(f'  Found {len(all_tags)} players.')

# ── Step 2: Fetch histories — sample up to 80 to find 16 active ones ─────────

random.shuffle(all_tags)
candidates: list[dict] = []   # {tag, history_vs, game_count}

print(f'Probing player histories (need 16 with >={MIN_GAMES} games)...')
probe_count = 0
for tag in all_tags:
    if len(candidates) >= 32:
        break
    probe_count += 1
    if probe_count % 20 == 0:
        print(f'  ... probed {probe_count}, found {len(candidates)} qualifying players so far')

    data = fetch(f'/api/zamboni/player/{tag}')
    if not data or not isinstance(data, dict):
        continue

    history = data.get('history') or {}
    if isinstance(history, list):
        # Some versions return a flat list
        vs = history
    else:
        vs = history.get('vs') or []

    if len(vs) >= MIN_GAMES:
        candidates.append({'tag': tag, 'history_vs': vs, 'game_count': len(vs)})
    time.sleep(0.05)   # small delay to avoid hammering the API

if len(candidates) < 16:
    print(f'WARNING: Only found {len(candidates)} qualifying players (need 16). Using all of them.')
    if len(candidates) < 2:
        print('ERROR: Not enough active players. Try increasing MIN_GAMES or check the API.')
        sys.exit(1)

# Sort by most active, take top 16
candidates.sort(key=lambda c: c['game_count'], reverse=True)
selected = candidates[:16]

print(f'\nSelected {len(selected)} active players:')
for i, c in enumerate(selected):
    print(f'  {i+1:2}. {c["tag"]:20s}  ({c["game_count"]} games in history)')

# ── Step 3: Build tag → manager map ──────────────────────────────────────────

random.shuffle(TEAMS)
managers = []
team_owners = {}
tag_to_mgr = {}

for i, cand in enumerate(selected):
    mgr_id = str(uuid.uuid4())[:8]
    team   = TEAMS[i % len(TEAMS)]
    mgr = {
        'id':         mgr_id,
        'name':       cand['tag'],
        'color':      f'#{random.randint(0x111111, 0xeeeeee):06x}',
        'zamboniTag': cand['tag'],
        # discordId intentionally left blank — /signup flow will fill these in
    }
    managers.append(mgr)
    team_owners[team] = mgr_id
    tag_to_mgr[cand['tag']] = {'mgr': mgr, 'team': team, 'history': cand['history_vs']}

# ── Step 4: Build schedule ────────────────────────────────────────────────────

def _uid(): return str(uuid.uuid4())[:8]

team_list = [tag_to_mgr[c['tag']]['team'] for c in selected]
games = []

for week in range(1, WEEKS + 1):
    shuffled = team_list[:]
    random.shuffle(shuffled)
    for i in range(0, len(shuffled) - 1, 2):
        games.append({
            'id':        _uid(),
            'week':      week,
            'game':      i // 2 + 1,
            'homeTeam':  shuffled[i],
            'awayTeam':  shuffled[i + 1],
            'homeScore': 0,
            'awayScore': 0,
            'played':    False,
            'ot':        False,
            'playoff':   False,
            'notes':     '',
        })

print(f'\nGenerated {len(games)} games across {WEEKS} weeks.')

# ── Step 5: Fill in real scores where Zamboni history exists ──────────────────

def _find_real_matchup(h_tag: str, a_tag: str, h_history: list) -> dict | None:
    """Find a real played game between h_tag and a_tag from home player's history."""
    for entry in h_history:
        opp = (entry.get('opponent') or '').lower()
        if opp == a_tag.lower():
            return entry
    return None


def _stats_from_side(side: dict) -> dict:
    return {
        'shots': side.get('shts', 0),
        'hits':  side.get('hits',  0),
        'ppg':   side.get('ppg',   0),
        'ppo':   side.get('ppo',   0),
        'shg':   side.get('shg',   0),
        'fo':    side.get('fo',    0),
        'fol':   side.get('fol',   0),
        'toa':   side.get('toa',   0),
        'pims':  side.get('pims',  0),
    }


real_game_count  = 0
sim_game_count   = 0
SIM_SCORES = [1,1,2,2,2,3,3,3,3,4,4,4,5,5,6]

# Build reverse lookup: team → tag
team_to_tag = {info['team']: tag for tag, info in tag_to_mgr.items()}

for g in games:
    h_tag = team_to_tag.get(g['homeTeam'])
    a_tag = team_to_tag.get(g['awayTeam'])

    real = None
    if h_tag and a_tag and h_tag in tag_to_mgr:
        h_history = tag_to_mgr[h_tag]['history']
        real = _find_real_matchup(h_tag, a_tag, h_history)

    if real:
        # Use real Zamboni result
        hs = int(real.get('scor', 0))

        # Find matching entry in away player's history for their score
        a_history = tag_to_mgr.get(a_tag, {}).get('history', []) if a_tag else []
        a_real = _find_real_matchup(a_tag, h_tag, a_history) if a_tag else None
        as_ = int(a_real.get('scor', 0)) if a_real else max(0, hs - random.randint(0, 3))

        # Ensure no ties
        if hs == as_:
            if random.random() < 0.5:
                hs += 1
            else:
                as_ += 1

        is_ot = bool(real.get('otg', 0)) or (a_real and bool(a_real.get('otg', 0)))

        g['homeScore'] = hs
        g['awayScore'] = as_
        g['ot']        = is_ot
        g['played']    = True
        g['zamboniGameId'] = real.get('game_id')
        g['zamboniStats']  = {
            'home': _stats_from_side(real),
            'away': _stats_from_side(a_real) if a_real else {},
        }
        real_game_count += 1
    else:
        # Simulated score
        hs = random.choice(SIM_SCORES)
        as_ = random.choice(SIM_SCORES)
        while hs == as_:
            as_ = random.choice(SIM_SCORES)
        is_ot = random.random() < 0.15
        g['homeScore'] = hs
        g['awayScore'] = as_
        g['ot']        = is_ot
        g['played']    = True
        sim_game_count += 1

print(f'Scores: {real_game_count} real Zamboni games, {sim_game_count} simulated.')

# ── Step 6: Build state ───────────────────────────────────────────────────────

state = {
    'league':            {'name': 'REAL TEST LEAGUE', 'season': 'Test', 'adminHash': ''},
    'managers':          managers,
    'teamOwners':        team_owners,
    'teamCoOwners':      {},
    'players':           [],
    'games':             games,
    'trades':            [],
    'draft':             {'active': False, 'rounds': 1, 'order': [], 'picks': []},
    'liveDraft':         {'active': False, 'rounds': 1, 'order': [], 'picks': [], 'autoManagers': []},
    'playerDraft':       [],
    'draftTab':          'live',
    'playoffs':          None,
    'lines':             {},
    'currentSeason':     1,
    'currentWeek':       None,
    'seasons':           [],
    'sysDataFile':       None,
    'scheduleStartDate': '2026-03-15',
    'rules':             None,
    'discordConfig':     {},
    'playoffFormat': [
        {'name': 'First Round',       'winTo': 2},
        {'name': 'Second Round',      'winTo': 3},
        {'name': 'Conference Finals', 'winTo': 3},
        {'name': 'Championship',      'winTo': 4},
    ],
}

# ── Step 7: Write DB ──────────────────────────────────────────────────────────

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

conn.execute(
    "INSERT INTO league_state (id, data, updated) VALUES (1, ?, datetime('now'))",
    (json.dumps(state),)
)
conn.commit()
conn.close()

# ── Summary ───────────────────────────────────────────────────────────────────

print(f'\nOK Real test league created: {DB_PATH}')
print(f'  Managers : {len(managers)} (all with zamboniTag set)')
print(f'  Teams    : {len(team_owners)}')
print(f'  Games    : {len(games)} total ({real_game_count} real, {sim_game_count} simulated)')
print(f'  Weeks    : {WEEKS} regular season')
print()
print('To use:')
print('  set NHL_DB_PATH=server/league_realtest.db  (Windows)')
print('  export NHL_DB_PATH=server/league_realtest.db  (Mac/Linux)')
print('  then restart the server')
print()
print('What to verify:')
print('  1. Navigate to Standings - standings calculated correctly')
print('  2. Playoffs - Generate Bracket - 8 series seeded 1v16..8v9')
print('  3. Schedule - playoff stubs visible in First Round section')
print('  4. Scores section - Zamboni box score icon on games with zamboniStats')
print('  5. Settings - Managers - all 16 show green Z pip (zamboniTag set)')
print('  6. /signup - pick a manager - enter any tag - admin approves - re-check Settings')
print('  7. Settings - Data - Export - Import - verify state round-trips cleanly')
