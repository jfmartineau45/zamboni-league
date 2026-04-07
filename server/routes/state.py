"""
routes/state.py — GET /api/state, POST /api/state
Bulk read/write of the full league state JSON.
"""
from flask import Blueprint, request, jsonify, Response
import json
from server.db import get_conn
state_bp = Blueprint('state', __name__)


@state_bp.route('/api/state', methods=['GET'])
def get_state():
    conn = get_conn()
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    conn.close()
    if not row:
        return Response('{}', mimetype='application/json')
    return Response(row['data'], mimetype='application/json')


@state_bp.route('/api/state', methods=['POST'])
def set_state():
    # First POST seeds the DB (bootstrap migration) — no auth required.
    # All subsequent POSTs require a valid admin JWT.
    conn = get_conn()
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    has_state = bool(row)
    existing_state = None
    if row:
        try:
            existing_state = json.loads(row['data'])
        except Exception:
            existing_state = None
    conn.close()
    if has_state:
        from server.routes.auth import check_auth
        ok, err = check_auth()
        if not ok:
            return err
    data = request.get_json(force=True)
    if data is None:
        return jsonify({'error': 'Invalid JSON'}), 400

    existing_admin_hash = ((existing_state or {}).get('league') or {}).get('adminHash')
    if existing_admin_hash:
        data.setdefault('league', {})['adminHash'] = existing_admin_hash

    blob = json.dumps(data)
    conn = get_conn()
    conn.execute("""
        INSERT INTO league_state (id, data, updated)
        VALUES (1, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET data=excluded.data, updated=excluded.updated
    """, (blob,))
    conn.commit()
    conn.close()

    # Keep players_ovr_plt_all.txt in sync — trace of every rating edit
    _sync_ratings_file(data)

    return jsonify({'ok': True})


def _sync_ratings_file(state: dict):
    """
    Regenerate players_ovr_plt_all.txt (skaters) and players_ovr_plt_goalies.txt
    from current player ratings. Called after every state save.
    """
    import os
    base = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))  # roster-app/

    players = state.get('players', [])
    if not any(p.get('ovr') and p.get('plt') for p in players):
        return

    # Split by position field (G = goalie), falling back to PLT-based check
    goalie_plts = {'GKP', 'HYB', 'BUT'}
    def _is_goalie(p):
        return p.get('position', '') == 'G' or p.get('plt', '').upper() in goalie_plts

    skaters = [(p['name'], int(p['ovr']), p.get('plt','').upper())
               for p in players if p.get('name') and p.get('ovr') and p.get('plt') and not _is_goalie(p)]
    goalies  = [(p['name'], int(p['ovr']), p.get('plt','').upper())
               for p in players if p.get('name') and p.get('ovr') and p.get('plt') and _is_goalie(p)]

    skaters.sort(key=lambda x: (-x[1], x[0]))
    goalies.sort(key=lambda x: (-x[1], x[0]))

    def _write(path, rows):
        try:
            with open(path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(f"{n}  {o}  {pl}" for n, o, pl in rows) + '\n')
        except Exception as e:
            print(f"[state] ratings file sync failed ({path}): {e}")

    _write(os.path.join(base, 'players_ovr_plt_all.txt'), skaters)
    if goalies:
        _write(os.path.join(base, 'players_ovr_plt_goalies.txt'), goalies)
