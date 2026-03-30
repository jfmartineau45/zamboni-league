#!/usr/bin/env python3
"""
Zamboni.gg Season 1 import — clean rebuild.
1. Fetch all 32 NHL team rosters from NHL API (real player data)
2. Replay the draft from rosters.csv, matching each pick to a real NHL player
3. Apply trades from trades.csv
4. Load schedule from schedule.csv
5. Apply results from results.csv
6. POST complete state to http://localhost:3000

Fantasy team code notes:
  Seattle  → WES  (Western All-Star slot in game)
  Vegas    → EAS  (Eastern All-Star slot in game)
  Utah     → PHX
"""

import csv, io, json, re, sqlite3, time, unicodedata, uuid
import sys
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from collections import defaultdict
from pathlib import Path
import requests

BASE      = Path(__file__).parent
DB_PATH   = BASE / 'server' / 'league.db'
API       = 'http://localhost:3000'
DL        = Path.home() / 'Downloads'

SESSION   = requests.Session()
SESSION.headers['User-Agent'] = 'NHLLegacyLeague/1.0'

# ── Fantasy team codes (app-internal) ─────────────────────────────────
# Column order matches rosters.csv header
FANTASY_COLS = [
    'TBL','CAR','DET','MTL','STL','EDM','PIT','CHI','NYR','FLA',
    'NSH','DAL','VAN','MIN','WES','OTT','WSH','PHX','LAK','NYI',
    'BOS','NJD','PHI','BUF','EAS','CGY','TOR','WPG','CBJ','SJS',
    'ANA','COL',
]

# NHL API team code → fantasy team code
NHL_TO_FANTASY = {
    'SEA': 'WES',   # Seattle Kraken  → WES slot
    'VGK': 'EAS',   # Vegas           → EAS slot
    'UTA': 'PHX',   # Utah            → PHX
}
# All others map 1-to-1

# Fantasy code → NHL API code (for roster fetching)
FANTASY_TO_NHL = {
    'WES': 'SEA',
    'EAS': 'VGK',
    'PHX': 'UTA',
}
def nhl_code(fc): return FANTASY_TO_NHL.get(fc, fc)

# Manager display names (schedule.csv = source of truth)
TEAM_MANAGER = {
    'TBL':'Girgs',      'CAR':'Zach',       'DET':'gilleh',   'MTL':'Nordet',
    'STL':'Justo',      'EDM':'hamlyn',     'PIT':'Zam',      'CHI':'Dambo',
    'NYR':'RobotSp',    'FLA':'Jerdubzz',   'NSH':'Fagelbob', 'DAL':'Jes',
    'VAN':'Raymond',    'MIN':'Dats',       'WES':'Tino45',   'OTT':'Dmitry',
    'WSH':'Thor',       'PHX':'dannypet',   'LAK':'Jasper',   'NYI':'Sebbest',
    'BOS':'Cdnbud',     'NJD':'Elessar',    'PHI':'Jawntuff', 'BUF':'Steeliest',
    'EAS':'Jefrsonsteel','CGY':'Beniers',   'TOR':'Moodo',    'WPG':'Eggbert',
    'CBJ':'blake1288',  'SJS':'RWB',        'ANA':'DDP',      'COL':'Bacon',
}
DAL_COMANAGER = 'Jiggle'

TEAM_COLORS = {
    'TBL':'#002868','CAR':'#CC0000','DET':'#CE1126','MTL':'#AF1E2D',
    'STL':'#002F87','EDM':'#FF4C00','PIT':'#FCB514','CHI':'#CF0A2C',
    'NYR':'#0038A8','FLA':'#C8102E','NSH':'#FFB81C','DAL':'#006847',
    'VAN':'#00205B','MIN':'#154734','WES':'#001628','OTT':'#C52032',
    'WSH':'#C8102E','PHX':'#6CACE4','LAK':'#333333','NYI':'#00539B',
    'BOS':'#FFB81C','NJD':'#CE1126','PHI':'#F74902','BUF':'#003087',
    'EAS':'#B4975A','CGY':'#C8102E','TOR':'#003E7E','WPG':'#041E42',
    'CBJ':'#002654','SJS':'#006D75','ANA':'#B09055','COL':'#6F263D',
}

# Known name fixes (rosters.csv spelling → canonical search term)
NAME_FIXES = {
    'UPL':   'Ukka-Pekka Luukkonen',
    'TVR':   'Travis van Riemsdyk',
    'ASP':   'Axel Sandin Pellikka',
    'ROR':   "Ryan O'Reilly",
    'EK65':  'Erik Karlsson',
    'OEL':   'Oliver Ekman-Larsson',
    'RNH':   'Ryan Nugent-Hopkins',
    'JVR':   'James van Riemsdyk',
    'Joel EE': 'Joel Eriksson Ek',
    "L O'connor": "Logan O'Connor",
    # Spelling corrections
    'Coranato':     'Jonathan Coronato',
    'Kaprisov':     'Kirill Kaprizov',
    'Vasilevsky':   'Andrei Vasilevskiy',
    'Foegle':       'Warren Foegele',
    'feheravry':    'Martin Fehervary',
    'Dadanov':      'Evgenii Dadonov',
    'torophchenko': 'Alexei Toropchenko',
    'merzlinkin':   'Elvis Merzlikins',
    'merzlinkins':  'Elvis Merzlikins',
    'Nichuskin':    'Valeri Nichushkin',
    'Lizzotte':     'Samuel Lizotte',
    'Khusnudinov':  'Nikita Khusnutdinov',
    'E.Kane':       'Evander Kane',
    'L.karlsson':   'Lucas Karlsson',
}

# Roster CSV → schedule CSV team code normalizer
SCHED_TC = {
    'TBL':'TBL','CAR':'CAR','DET':'DET','MTL':'MTL','STL':'STL',
    'EDM':'EDM','PIT':'PIT','CHI':'CHI','NYR':'NYR','FLA':'FLA',
    'NSH':'NSH','DAL':'DAL','VAN':'VAN','MIN':'MIN',
    'SEA':'WES','UTA':'PHX','VGK':'EAS',          # ← remap here
    'OTT':'OTT','WSH':'WSH','LAK':'LAK','NYI':'NYI',
    'BOS':'BOS','NJD':'NJD','PHI':'PHI','BUF':'BUF',
    'CAL':'CGY','TOR':'TOR','WPG':'WPG','CBJ':'CBJ',
    'SJS':'SJS','ANA':'ANA','COL':'COL',
    'WES':'WES','EAS':'EAS','PHX':'PHX',
}

# General name/code → fantasy team code (for results + trades)
_TC_MAP = {**{fc: fc for fc in FANTASY_COLS}}
_TC_MAP.update({
    'SEA':'WES','VGK':'EAS','UTA':'PHX','TB':'TBL','NJ':'NJD',
    'SJ':'SJS','LA':'LAK','CAL':'CGY',
    'TAMPA':'TBL','CAROLINA':'CAR','DETROIT':'DET','MONTREAL':'MTL',
    'ST LOUIS':'STL','ST. LOUIS':'STL','EDMONTON':'EDM',
    'PITTSBURGH':'PIT','CHICAGO':'CHI','NY RANGERS':'NYR',
    'FLORIDA':'FLA','FLORIDA PANTHERS':'FLA','PANTHERS':'FLA',
    'NASHVILLE':'NSH','DALLAS':'DAL','VANCOUVER':'VAN','MINNESOTA':'MIN',
    'SEATTLE':'WES','KRAKEN':'WES',
    'OTTAWA':'OTT','OTTAWA SENATORS':'OTT',
    'WASHINGTON':'WSH','WASHINGTON CAPITALS':'WSH',
    'UTAH':'PHX',
    'LA KINGS':'LAK','LOS ANGELES':'LAK','LA KINGS / MAMMOTH':'PHX',
    'NY ISLANDERS':'NYI','NEW YORK ISLANDERS':'NYI',
    'BOSTON':'BOS','NEW JERSEY':'NJD','PHILADELPHIA':'PHI','PHILLY':'PHI',
    'FLYERS':'PHI','BUFFALO':'BUF',
    'VEGAS':'EAS','LAS VEGAS':'EAS','GOLDEN KNIGHTS':'EAS',
    'CALGARY':'CGY','TORONTO':'TOR','WINNIPEG':'WPG','COLUMBUS':'CBJ',
    'SAN JOSE':'SJS','ANAHEIM':'ANA','DUCKS':'ANA','COLORADO':'COL',
    # Manager names → team
    'GIRGS':'TBL','ZACH':'CAR','BUCKWEAT':'CAR','MEMESREST':'CAR',
    'GILLEH':'DET','NORDET':'MTL','NORDET2':'MTL','JUSTO':'STL',
    'HAMLYN':'EDM','ZAM':'PIT','DAMBO':'CHI',
    'ROBOTSP':'NYR','ROBOTSPIDER':'NYR','ROBOTSPIDER25':'NYR',
    'JERDUBZZ':'FLA','FAGELBOB':'NSH','JES':'DAL','JIGGLE':'DAL',
    'RAYMOND':'VAN','DATS':'MIN','TINO45':'WES','TINO':'WES',
    'DMITRY':'OTT','DIMITRY':'OTT','THOR':'WSH','DANNYPET':'PHX',
    'JASPER':'LAK','SEBBEST':'NYI','SEBBESTKILLER97':'NYI',
    'SEBTHEBEST':'NYI','SEBBESTKILLER':'NYI','CDNBUD':'BOS',
    'ELESSAR':'NJD','JAWNTUFF':'PHI','STEELIEST':'BUF',
    'JEFRSONSTEEL':'EAS','JEFRONSTEEL':'EAS',
    'BENIERS':'CGY','MOODO':'TOR','EGGBERT':'WPG','BLAKE1288':'CBJ',
    'PXLDO':'SJS','RWB':'SJS','DDP':'ANA','BACON':'COL',
})

def resolve_tc(raw):
    if not raw: return None
    up = raw.strip().upper()
    if up in _TC_MAP: return _TC_MAP[up]
    return _TC_MAP.get(up.split()[0])

def uid(): return str(uuid.uuid4())[:8]

def norm(s):
    return unicodedata.normalize('NFKD', s.strip().lower()).encode('ascii','ignore').decode()

def clean_csv_name(raw):
    """Strip position/type hints like '(f)', '(d)', '(g)' and apply name fixes."""
    s = re.sub(r'\s*\([a-z]+\)\s*$', '', raw.strip(), flags=re.I).strip()
    return NAME_FIXES.get(s, s)


# ════════════════════════════════════════════════════════════════════════
# 1.  Fetch real NHL rosters from API
# ════════════════════════════════════════════════════════════════════════

def fetch_nhl_rosters():
    """
    Returns dict: {last_norm: [player_dict, ...]}
    Each player_dict has: id, name, firstName, lastName, position, headshot, number
    """
    NHL_TEAMS = [
        'ANA','BOS','BUF','CAR','CBJ','CGY','CHI','COL','DAL','DET',
        'EDM','FLA','LAK','MIN','MTL','NJD','NSH','NYI','NYR','OTT',
        'PHI','PIT','SEA','SJS','STL','TBL','TOR','UTA','VAN','VGK',
        'WPG','WSH',
    ]
    lookup = defaultdict(list)   # last_norm → [player, ...]

    print(f'  Fetching {len(NHL_TEAMS)} team rosters from NHL API...')
    for tc in NHL_TEAMS:
        try:
            r = SESSION.get(
                f'https://api-web.nhle.com/v1/roster/{tc}/current',
                timeout=10
            )
            r.raise_for_status()
            data = r.json()
        except Exception as e:
            print(f'    {tc}: ERROR {e}')
            time.sleep(1)
            continue

        for group in ('forwards', 'defensemen', 'goalies'):
            for p in data.get(group, []):
                first = p['firstName']['default']
                last  = p['lastName']['default']
                pos   = p.get('positionCode', '')
                if group == 'goalies' and not pos:
                    pos = 'G'
                player = {
                    'id':       str(p['id']),
                    'name':     f'{first} {last}',
                    'firstName': first,
                    'lastName':  last,
                    'position': pos,
                    'headshot': p.get('headshot', ''),
                    'number':   str(p.get('sweaterNumber', '')),
                    'nhlTeam':  NHL_TO_FANTASY.get(tc, tc),  # not used for assignment
                }
                lookup[norm(last)].append(player)

        time.sleep(0.05)   # be polite

    total = sum(len(v) for v in lookup.values())
    print(f'  Loaded {total} players from NHL API.')
    return lookup


def find_nhl_player(name, lookup):
    """
    Find best matching NHL API player for a draft pick name.
    Returns player dict or None.
    """
    parts = name.strip().split()
    if not parts:
        return None

    # Figure out last name and optional first initial
    # Handles: "McDavid", "Q. Hughes", "B. Tkachuk", "Ukka-Pekka Luukkonen"
    if len(parts) == 1:
        # Single token = last name only
        last_key = norm(parts[0])
        initial  = None
    else:
        first_tok = parts[0]
        # "X." → initial
        if re.match(r'^[A-Za-z]\.$', first_tok):
            initial  = norm(first_tok[0])
            last_key = norm(parts[-1])
        else:
            initial  = norm(first_tok[0])
            last_key = norm(parts[-1])

    candidates = lookup.get(last_key, [])
    if not candidates:
        return None

    # Single candidate → done
    if len(candidates) == 1:
        return candidates[0]

    # Multiple → filter by first initial
    if initial:
        filtered = [p for p in candidates
                    if norm(p['firstName'][0]) == initial]
        if len(filtered) == 1:
            return filtered[0]
        if filtered:
            candidates = filtered

    # Exact full name
    for p in candidates:
        if norm(p['name']) == norm(name):
            return p

    # Still ambiguous → return first (best effort)
    return candidates[0]


# ════════════════════════════════════════════════════════════════════════
# 2.  Parse rosters.csv and build draft picks
# ════════════════════════════════════════════════════════════════════════

def parse_rosters(path, lookup):
    """
    Returns:
      roster      {fantasy_code: [player_dict, ...]}
      draft_picks [{round, teamCode, player_name, player_dict}]
    """
    roster      = {fc: [] for fc in FANTASY_COLS}
    draft_picks = []
    unmatched   = []

    with open(path, newline='', encoding='utf-8') as f:
        rows = list(csv.reader(f))

    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        label = row[0].strip()
        m = re.match(r'Round\s+(\d+)', label, re.I)
        rnd = int(m.group(1)) if m else 20   # Backup G = round 20

        for ci, fc in enumerate(FANTASY_COLS, start=1):
            if ci >= len(row):
                break
            raw = row[ci].strip()
            if not raw or raw.lower() in ('replace', 'n/a', '-', ''):
                continue

            name = clean_csv_name(raw)
            hit  = find_nhl_player(name, lookup)

            if hit:
                p = dict(hit)
                p['teamCode'] = fc
                p['ovr']      = 0
                p['plt']      = ''
            else:
                unmatched.append((fc, rnd, name))
                p = {
                    'id': uid(), 'name': name, 'teamCode': fc,
                    'position': '', 'headshot': '', 'number': '',
                    'ovr': 0, 'plt': '',
                }

            roster[fc].append(p)
            draft_picks.append({'round': rnd, 'teamCode': fc, 'player': name})

    return roster, draft_picks, unmatched


# ════════════════════════════════════════════════════════════════════════
# 3.  Trades
# ════════════════════════════════════════════════════════════════════════

TRADE_TC = {
    'TORONTO':'TOR','NEW JERSEY':'NJD','LA KINGS / MAMMOTH':'PHX',
    'WINNIPEG':'WPG','BUFFALO':'BUF','DETROIT':'DET','UTAH':'PHX',
    'VANCOUVER':'VAN','MINNESOTA':'MIN','NY RANGERS':'NYR',
    'SEATTLE':'WES','VEGAS':'EAS',
}

def resolve_trade_tc(raw):
    up = raw.strip().upper()
    return TRADE_TC.get(up) or resolve_tc(raw)

def parse_assets(cell):
    names = []
    for line in cell.splitlines():
        line = line.strip()
        if not line: continue
        line = re.sub(r'\s*\([^)]*\)', '', line).strip()
        line = re.sub(r'^[CLRDGW]{1,2}\s+', '', line).strip()
        if ' / ' in line:
            names.extend(p.strip() for p in line.split(' / ') if p.strip())
        elif line:
            names.append(line)
    return names

def _last(n):
    parts = n.split()
    last = parts[-1].rstrip('.')
    if '.' in last: last = last.split('.')[-1]
    return last

def _find_in_roster(roster_list, name):
    nl = norm(name)
    for i, p in enumerate(roster_list):
        if norm(p['name']) == nl: return i
    last = norm(_last(name))
    for i, p in enumerate(roster_list):
        if norm(_last(p['name'])) == last: return i
    first = norm(name.split()[0].rstrip('.'))
    for i, p in enumerate(roster_list):
        if norm(p['name'].split()[0].rstrip('.')) == first: return i
    return -1

def apply_trades(roster, path):
    state_trades = []
    with open(path, newline='', encoding='utf-8') as f:
        rows = list(csv.reader(f))
    for row in rows[2:]:
        if len(row) < 6 or not row[0].strip().isdigit(): continue
        num   = int(row[0])
        ft    = resolve_trade_tc(row[1].strip())
        sent  = parse_assets(row[2].strip())
        tt    = resolve_trade_tc(row[4].strip() if len(row) > 4 else '')
        recv  = parse_assets(row[5].strip() if len(row) > 5 else '')
        if not ft or not tt:
            print(f'  WARNING Trade {num}: unresolved team')
            continue

        sent_names, recv_names = [], []
        for name in sent:
            i = _find_in_roster(roster[ft], name)
            if i >= 0:
                p = roster[ft].pop(i)
                p['teamCode'] = tt
                roster[tt].append(p)
                sent_names.append(p['name'])
            else:
                print(f'  WARNING Trade {num}: "{name}" not found on {ft}')
                sent_names.append(name)
        for name in recv:
            i = _find_in_roster(roster[tt], name)
            if i >= 0:
                p = roster[tt].pop(i)
                p['teamCode'] = ft
                roster[ft].append(p)
                recv_names.append(p['name'])
            else:
                print(f'  WARNING Trade {num}: "{name}" not found on {tt}')
                recv_names.append(name)

        state_trades.append({
            'id': uid(), 'date': '', 'fromTeam': ft, 'toTeam': tt,
            'playersSent':     ', '.join(sent_names),
            'playersReceived': ', '.join(recv_names),
            'notes': f'Trade #{num}',
        })
    return state_trades


# ════════════════════════════════════════════════════════════════════════
# 4.  Schedule
# ════════════════════════════════════════════════════════════════════════

def _tc_from_cell(cell):
    m = re.search(r'\(([A-Z]{2,4})\)', cell)
    if m: return SCHED_TC.get(m.group(1).upper())
    return None

def parse_schedule(path):
    games = []
    week = round_in_week = game_in_round = 0
    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.rstrip('\r\n')
            if not line.strip():
                if game_in_round > 0:
                    round_in_week += 1
                    game_in_round  = 0
                continue
            m = re.match(r'WEEK\s+(\d+)', line.strip(), re.I)
            if m:
                week = int(m.group(1)); round_in_week = 1; game_in_round = 0
                continue
            parts = line.split(',')
            if len(parts) < 2 or not week: continue
            ht = _tc_from_cell(parts[0])
            at = _tc_from_cell(parts[1])
            if ht and at:
                game_in_round += 1
                games.append({
                    'id': uid(), 'week': week,
                    'game': (round_in_week - 1) * 16 + game_in_round,
                    'homeTeam': ht, 'awayTeam': at,
                    'homeScore': 0, 'awayScore': 0,
                    'played': False, 'ot': False, 'notes': '',
                })
    return games


# ════════════════════════════════════════════════════════════════════════
# 5.  Results
# ════════════════════════════════════════════════════════════════════════

def parse_results(path):
    results = []
    with open(path, newline='', encoding='utf-8') as f:
        reader = csv.reader(f); next(reader)
        for row in reader:
            if len(row) < 7 or not row[0].strip().isdigit(): continue
            def si(s):
                try: return int(s.strip())
                except: return 0
            wt = resolve_tc(row[2].strip()) or resolve_tc(row[1].strip())
            lt = resolve_tc(row[4].strip()) or resolve_tc(row[3].strip())
            notes = row[7].strip() if len(row) > 7 else ''
            results.append({
                'wt': wt, 'lt': lt, 'ws': si(row[5]), 'ls': si(row[6]),
                'ot': bool(re.search(r'\b(OT|SO)\b', notes, re.I)),
                'notes': notes,
            })
    return results

def apply_results(games, results):
    pair = defaultdict(list)
    for i, g in enumerate(games):
        pair[tuple(sorted([g['homeTeam'], g['awayTeam']]))].append(i)
    for k in pair: pair[k].sort(key=lambda i:(games[i]['week'],games[i]['game']))
    ptr = defaultdict(int); unmatched = 0
    for r in results:
        if not r['wt'] or not r['lt']:
            print(f'  WARNING: unresolved teams in result {r}')
            unmatched += 1; continue
        key = tuple(sorted([r['wt'], r['lt']]))
        idxs = pair.get(key, [])
        if ptr[key] >= len(idxs):
            print(f'  WARNING: no game slot for {r["wt"]} vs {r["lt"]}')
            unmatched += 1; continue
        g = games[idxs[ptr[key]]]; ptr[key] += 1
        if g['homeTeam'] == r['wt']:
            g['homeScore'], g['awayScore'] = r['ws'], r['ls']
        else:
            g['homeScore'], g['awayScore'] = r['ls'], r['ws']
        g['played'] = True; g['ot'] = r['ot']; g['notes'] = r['notes']
    if unmatched: print(f'  {unmatched} result(s) unmatched')
    return games


# ════════════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════════════

def main():
    # ── 0. Fetch NHL rosters ───────────────────────────────────────────
    print('Step 1: Fetching NHL rosters from API...')
    lookup = fetch_nhl_rosters()

    # ── 1. Parse draft ─────────────────────────────────────────────────
    print('\nStep 2: Replaying draft from rosters.csv...')
    roster, draft_picks, unmatched = parse_rosters(DL / 'rosters.csv', lookup)
    total = sum(len(v) for v in roster.values())
    matched = total - len(unmatched)
    print(f'  {matched}/{total} players matched to NHL API data.')
    if unmatched:
        print(f'  Unmatched ({len(unmatched)}):')
        for fc, rnd, name in unmatched:
            print(f'    {fc} R{rnd}: {name}')

    # ── 2. Trades ──────────────────────────────────────────────────────
    print('\nStep 3: Applying trades...')
    state_trades = apply_trades(roster, DL / 'trades.csv')
    print(f'  {len(state_trades)} trades applied.')

    # ── 3. Schedule ────────────────────────────────────────────────────
    print('\nStep 4: Parsing schedule...')
    games = parse_schedule(DL / 'schedule.csv')
    print(f'  {len(games)} games across {len({g["week"] for g in games})} weeks.')

    # ── 4. Results ─────────────────────────────────────────────────────
    print('\nStep 5: Applying results...')
    results = parse_results(DL / 'results.csv')
    games   = apply_results(games, results)
    played  = sum(1 for g in games if g['played'])
    print(f'  {played}/{len(games)} games played.')

    # ── 5. Build state ─────────────────────────────────────────────────
    print('\nStep 6: Building state...')
    managers    = []
    team_owners = {}
    team_co     = {}

    for fc in FANTASY_COLS:
        mid = uid()
        managers.append({'id': mid, 'name': TEAM_MANAGER[fc], 'color': TEAM_COLORS[fc]})
        team_owners[fc] = mid

    jiggle_id = uid()
    managers.append({'id': jiggle_id, 'name': DAL_COMANAGER, 'color': TEAM_COLORS['DAL']})
    team_co['DAL'] = jiggle_id

    players = []
    for fc in FANTASY_COLS:
        for p in roster[fc]:
            players.append({
                'id':       p.get('id', uid()),
                'name':     p['name'],
                'teamCode': fc,
                'position': p.get('position', ''),
                'headshot': p.get('headshot', ''),
                'number':   p.get('number', ''),
                'ovr':      0,
                'plt':      '',
            })

    state = {
        'league':     {'name': 'Zamboni.gg Season 1', 'season': '1', 'adminHash': ''},
        'managers':   managers,
        'teamOwners': team_owners,
        'teamCoOwners': team_co,
        'players':    players,
        'games':      games,
        'trades':     state_trades,
        'playerDraft': draft_picks,
        'draftTab':   'imported',
        'liveDraft':  {'active': False, 'rounds': 20, 'order': [], 'picks': [], 'autoManagers': []},
        'draft':      {'active': False, 'rounds': 1, 'order': [], 'picks': []},
        'playoffs':   None,
        'lines':      {},
        'currentSeason': 1,
        'seasons':    [],
        'sysDataFile': None,
        'scheduleStartDate': '2026-03-22',
        'rules':      None,
        'playoffFormat': [
            {'name': 'First Round',       'winTo': 2},
            {'name': 'Second Round',      'winTo': 3},
            {'name': 'Conference Finals', 'winTo': 3},
            {'name': 'Championship',      'winTo': 4},
        ],
    }

    print(f'  {len(managers)} managers | {len(players)} players | '
          f'{len(games)} games | {len(state_trades)} trades')

    # ── 6. Apply OVR/PLT from txt files ───────────────────────────────
    print('\nStep 7: Applying OVR/PLT from ratings files...')
    def _load_ratings(path):
        r = defaultdict(list)
        try:
            with open(path, encoding='utf-8') as f:
                for line in f:
                    parts = line.strip().rsplit(None, 2)
                    if len(parts) < 3: continue
                    try: ovr = int(parts[1])
                    except: continue
                    r[norm(parts[0].split()[-1])].append((parts[0].strip(), ovr, parts[2].strip()))
        except FileNotFoundError:
            print(f'  Not found: {path}')
        return r

    sk_r = _load_ratings(BASE / 'players_ovr_plt_all.txt')
    gk_r = _load_ratings(BASE / 'players_ovr_plt_goalies.txt')
    print(f'  {sum(len(v) for v in sk_r.values())} skaters, {sum(len(v) for v in gk_r.values())} goalies in txt files')

    rated = 0
    for p in players:
        pn = p['name']; last = norm(_last(pn)); pool = None
        pool = gk_r.get(last) if p.get('position') == 'G' else None
        if not pool: pool = sk_r.get(last) or gk_r.get(last)
        if not pool: continue
        match = next((x for x in pool if norm(x[0]) == norm(pn)), None)
        if not match and len(pool) == 1: match = pool[0]
        if not match:
            ini = norm(pn.split()[0][0])
            match = next((x for x in pool if norm(x[0].split()[0][0]) == ini), None)
        if not match: match = pool[0]
        p['ovr'], p['plt'] = match[1], match[2]
        rated += 1
    print(f'  {rated}/{len(players)} players rated.')

    # ── 7. Wipe DB + POST ──────────────────────────────────────────────
    print('\nStep 7: Posting to server...')
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute('DELETE FROM league_state WHERE id=1')
        conn.commit()
        conn.close()
    except Exception as e:
        print(f'  DB wipe warning: {e}')

    r = SESSION.post(f'{API}/api/state', json=state,
                     headers={'Content-Type': 'application/json'}, timeout=30)
    print(f'  HTTP {r.status_code}')
    if r.status_code == 200:
        print('\n✅  Import complete! Set your admin password at http://localhost:3000')
    else:
        print(f'\n❌  {r.text[:300]}')


if __name__ == '__main__':
    main()
