#!/usr/bin/env python3
"""
Apply OVR/PLT ratings from players_ovr_plt_all.txt and players_ovr_plt_goalies.txt
back onto the current state players.
"""
import io, sys, re, sqlite3, unicodedata
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from pathlib import Path
import requests

BASE    = Path(__file__).parent
DB_PATH = BASE / 'server' / 'league.db'
API     = 'http://localhost:3001'

SESSION = requests.Session()


def norm(s):
    return unicodedata.normalize('NFKD', s.strip().lower()).encode('ascii', 'ignore').decode()


def load_ratings(path):
    """Read 'Name  OVR  PLT' lines → {norm_last: [(name, ovr, plt), ...]}"""
    ratings = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                parts = line.rsplit(None, 2)   # split from right: name | ovr | plt
                if len(parts) < 3:
                    continue
                name, ovr_s, plt = parts
                try:
                    ovr = int(ovr_s)
                except ValueError:
                    continue
                key = norm(name.split()[-1])   # index by last name
                ratings.setdefault(key, []).append((name.strip(), ovr, plt.strip()))
    except FileNotFoundError:
        print(f'  File not found: {path}')
    return ratings


def best_match(player_name, ratings):
    """Find best OVR/PLT entry for a player by name."""
    pn = norm(player_name)
    parts = player_name.strip().split()
    last  = norm(parts[-1]) if parts else pn

    candidates = ratings.get(last, [])
    if not candidates:
        return None

    # Exact full name
    for name, ovr, plt in candidates:
        if norm(name) == pn:
            return ovr, plt

    # Single candidate → use it
    if len(candidates) == 1:
        return candidates[0][1], candidates[0][2]

    # Multiple → try first-initial match
    if len(parts) >= 2:
        initial = norm(parts[0][0])
        for name, ovr, plt in candidates:
            n_parts = name.strip().split()
            if n_parts and norm(n_parts[0][0]) == initial:
                return ovr, plt

    # Fallback: first candidate
    return candidates[0][1], candidates[0][2]


def main():
    print('Loading ratings files...')
    skater_ratings = load_ratings(BASE / 'players_ovr_plt_all.txt')
    goalie_ratings = load_ratings(BASE / 'players_ovr_plt_goalies.txt')
    print(f'  {sum(len(v) for v in skater_ratings.values())} skaters, '
          f'{sum(len(v) for v in goalie_ratings.values())} goalies')

    print('\nFetching current state...')
    r = SESSION.get(f'{API}/api/state', timeout=10)
    r.raise_for_status()
    state = r.json()
    players = state.get('players', [])
    print(f'  {len(players)} players')

    goalie_plts = {'GKP', 'HYB', 'BUT'}

    applied = skipped = 0
    for p in players:
        name = p.get('name', '')
        pos  = p.get('position', '')

        # Try goalie ratings first if position is G
        result = None
        if pos == 'G':
            result = best_match(name, goalie_ratings)
        if result is None:
            result = best_match(name, skater_ratings)
        if result is None and pos != 'G':
            result = best_match(name, goalie_ratings)  # backup goalies

        if result:
            p['ovr'], p['plt'] = result
            applied += 1
        else:
            skipped += 1

    print(f'  Applied: {applied}  |  No rating found: {skipped}')
    if skipped:
        no_rating = [p['name'] for p in players if not p.get('ovr')]
        print(f'  Missing ratings: {no_rating[:20]}{"..." if len(no_rating) > 20 else ""}')

    # Bootstrap POST (wipe state row first)
    print('\nWiping DB row and POSTing...')
    conn = sqlite3.connect(DB_PATH)
    conn.execute('DELETE FROM league_state WHERE id=1')
    conn.commit()
    conn.close()

    r = SESSION.post(f'{API}/api/state', json=state,
                     headers={'Content-Type': 'application/json'}, timeout=30)
    print(f'  HTTP {r.status_code}')
    if r.status_code == 200:
        print('\n✅  Ratings applied!')
    else:
        print(f'\n❌  {r.text[:200]}')


if __name__ == '__main__':
    main()
