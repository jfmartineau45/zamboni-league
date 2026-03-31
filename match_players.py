#!/usr/bin/env python3
"""
Match imported player names to real NHL API data.
Updates every player in state with: id (NHL), position, headshot, number, full name.
"""

import io, sys, re, json, sqlite3, time, unicodedata
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from pathlib import Path
import requests

BASE    = Path(__file__).parent
DB_PATH = BASE / 'server' / 'league.db'
API     = 'http://localhost:3001'

NHL_SEARCH = 'https://search.d3.nhle.com/api/v1/search/player'
NHL_ROSTER = 'https://api-web.nhle.com/v1/roster/{team}/current'

SESSION = requests.Session()
SESSION.headers['User-Agent'] = 'NHLLegacyLeague/1.0'

# Known name corrections (roster CSV spelling → correct NHL search term)
NAME_ALIASES = {
    'Kaprisov':       'Kaprizov',       # Kirill Kaprizov
    'Vasilevsky':     'Vasilevskiy',    # Andrei Vasilevskiy
    'Foegle':         'Foegele',        # Warren Foegele
    'feheravry':      'Fehervary',      # Martin Fehervary
    'Dadanov':        'Dadonov',        # Evgenii Dadonov
    'torophchenko':   'Toropchenko',    # Alexei Toropchenko
    'merzlinkin':     'Merzlikins',     # Elvis Merzlikins
    'merzlinkins':    'Merzlikins',     # Elvis Merzlikins
    'Nichuskin':      'Nichushkin',     # Valeri Nichushkin
    'Lizzotte':       'Lizotte',        # Samuel Lizotte
    'Khusnudinov':    'Khusnutdinov',   # Nikita Khusnutdinov
    'E.Kane':         'Evander Kane',   # Evander Kane (no space)
    'L.karlsson':     'Lucas Karlsson', # Lucas Karlsson
    'D Petey':        'Denis Petrov',   # best guess; will fallback gracefully
    'Phoeling':       'Pohling',        # Florian Pohling (SEA prospect)
    'Corczak':        'Korczak',        # Jakub Korczak
}

def clean_name(raw):
    """Strip trailing position hints like '(f)', '(d)', '(g)', '(lw)', etc."""
    s = re.sub(r'\s*\([a-z]+\)\s*$', '', raw.strip(), flags=re.I).strip()
    # Apply known aliases
    return NAME_ALIASES.get(s, s)


def norm(s):
    """Lowercase + strip accents."""
    return unicodedata.normalize('NFKD', s.lower()).encode('ascii', 'ignore').decode()


def search_nhl(query, active=True):
    """Search NHL API for a player by name. Returns list of hits."""
    try:
        r = SESSION.get(NHL_SEARCH, params={
            'culture': 'en-us', 'limit': 10, 'q': query,
            'active': 'true' if active else 'false',
        }, timeout=8)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f'    NHL search error for "{query}": {e}')
        return []


def parse_name(raw):
    """
    Parse a player name string into (first_initial, last_name, full_hint).
    Handles: 'McDavid', 'Q. Hughes', 'B. Tkachuk', 'E.Kane', 'Ukka-Pekka Luukkonen'
    """
    raw = raw.strip()

    # Handle "E.Kane" format (initial+dot+lastname, no space)
    m = re.match(r'^([A-Za-z])\.([A-Za-z].+)$', raw)
    if m:
        initial = norm(m.group(1))
        last    = norm(m.group(2))
        return initial, last, raw

    parts = raw.split()
    if not parts:
        return None, norm(raw), raw

    first = parts[0]
    # "X." pattern → initial + separate last name word
    if re.match(r'^[A-Za-z]\.$', first):
        initial = norm(first[0])
        last    = norm(parts[-1]) if len(parts) > 1 else norm(first[0])
        return initial, last, raw

    # Single word → just last name
    if len(parts) == 1:
        return None, norm(parts[0]), raw

    # Multiple words → first=initial, last=last word
    initial = norm(parts[0][0])
    last    = norm(parts[-1])
    return initial, last, raw


def score_hit(hit, initial, last, raw):
    """
    Score how well an NHL API hit matches our parsed name.
    Higher = better match.
    """
    hit_name  = hit.get('name', '')
    hit_parts = hit_name.strip().split()
    if not hit_parts:
        return 0

    hit_last    = norm(hit_parts[-1])
    hit_initial = norm(hit_parts[0][0]) if hit_parts else ''

    score = 0
    # Last name match is required
    if hit_last == last:
        score += 10
    elif last in hit_last or hit_last in last:
        score += 5
    else:
        return 0   # last name mismatch → reject

    # First initial bonus
    if initial and hit_initial == initial:
        score += 5
    elif initial and hit_initial != initial:
        score -= 3

    # Exact full name bonus
    if norm(hit_name) == norm(raw):
        score += 3

    return score


def find_best(hits, initial, last, raw):
    """Pick best matching hit from search results."""
    scored = [(score_hit(h, initial, last, raw), h) for h in hits]
    scored = [(s, h) for s, h in scored if s > 0]
    if not scored:
        return None
    scored.sort(key=lambda x: -x[0])
    return scored[0][1]


def nhl_hit_to_player(hit, existing):
    """Merge NHL API hit data into existing player dict."""
    updated = dict(existing)
    updated['id']       = str(hit.get('playerId', existing.get('id', '')))
    updated['name']     = hit.get('name', existing['name'])
    updated['position'] = hit.get('positionCode', '')
    updated['headshot'] = hit.get('headshot', '')
    # sweaterNumber not always in search; leave number as-is
    return updated


def match_player(player):
    """
    Try to resolve a player to real NHL API data.
    Returns (updated_player, matched: bool).
    """
    raw   = player['name']
    clean = clean_name(raw)           # apply aliases + strip (f)/(d) hints
    initial, last, _ = parse_name(clean)

    # Search by last name (most reliable)
    hits = search_nhl(last)

    # If last name alone gives nothing, try full cleaned name
    if not hits:
        hits = search_nhl(clean)

    # Still nothing — try original raw name
    if not hits and clean != raw:
        hits = search_nhl(raw)

    best = find_best(hits, initial, last, raw)

    if best:
        return nhl_hit_to_player(best, player), True

    # Try searching inactive players as fallback (retired/bought-out)
    hits_inactive = search_nhl(last, active=False)
    best_inactive = find_best(hits_inactive, initial, last, raw)
    if best_inactive:
        return nhl_hit_to_player(best_inactive, player), True

    return player, False


def main():
    print('Fetching current state...')
    r = SESSION.get(f'{API}/api/state', timeout=10)
    r.raise_for_status()
    state = r.json()

    players = state.get('players', [])
    print(f'  {len(players)} players to match\n')

    matched   = 0
    unmatched = []

    for i, p in enumerate(players):
        name = p['name']
        updated, ok = match_player(p)
        players[i] = updated

        if ok:
            matched += 1
            if (i + 1) % 50 == 0:
                print(f'  [{i+1}/{len(players)}] matched {matched} so far...')
        else:
            unmatched.append(name)

        # Be polite to NHL API — small delay every 10 requests
        if (i + 1) % 10 == 0:
            time.sleep(0.3)

    print(f'\nMatched {matched}/{len(players)} players.')

    if unmatched:
        print(f'\nUnmatched ({len(unmatched)}):')
        for n in unmatched:
            print(f'  - {n}')

    state['players'] = players

    # Wipe state row so POST uses bootstrap path (no auth needed)
    print('\nWiping DB state row for bootstrap POST...')
    conn = sqlite3.connect(DB_PATH)
    conn.execute('DELETE FROM league_state WHERE id=1')
    conn.commit()
    conn.close()

    print('POSTing updated state...')
    r = SESSION.post(f'{API}/api/state', json=state,
                     headers={'Content-Type': 'application/json'}, timeout=30)
    print(f'  HTTP {r.status_code}')
    if r.status_code == 200:
        print('\n✅  Player matching complete!')
    else:
        print(f'\n❌  Error: {r.text[:300]}')


if __name__ == '__main__':
    main()
