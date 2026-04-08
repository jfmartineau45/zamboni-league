"""
routes/pending.py — Discord pending requests queue
POST  /api/pending        — bot submits a score/trade for approval
GET   /api/pending        — admin views the queue
PATCH /api/pending/<id>   — admin approves or rejects
"""
from flask import Blueprint, request, jsonify
import json
import uuid
from datetime import datetime, timezone
from server.db import get_conn
from server.routes.auth import require_admin
from server.routes.bot_events import queue_score_event, queue_trade_event

pending_bp = Blueprint('pending', __name__)


@pending_bp.route('/api/pending', methods=['POST'])
def submit_pending():
    """Used by the Discord bot — no admin token required (bot has its own secret check)."""
    # Validate bot shared secret
    import os
    bot_secret = os.environ.get('NHL_BOT_SECRET', '')
    if bot_secret and request.headers.get('X-Bot-Secret', '') != bot_secret:
        return jsonify({'error': 'Forbidden'}), 403

    body = request.get_json(force=True) or {}
    req_type      = body.get('type')          # 'score' | 'trade' | 'roster_edit'
    payload       = body.get('payload')       # dict with the actual data
    submitted_by  = body.get('submittedBy')   # Discord user ID string
    submitted_name = body.get('submittedName', '')

    if not req_type or payload is None or not submitted_by:
        return jsonify({'error': 'type, payload, submittedBy required'}), 400

    req_id = str(uuid.uuid4())
    submitted_at = datetime.now(timezone.utc).isoformat()

    conn = get_conn()
    conn.execute("""
        INSERT INTO pending_requests (id, type, payload, submitted_by, submitted_name, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (req_id, req_type, json.dumps(payload), submitted_by, submitted_name, submitted_at))
    conn.commit()
    conn.close()

    return jsonify({'ok': True, 'id': req_id})


@pending_bp.route('/api/pending', methods=['GET'])
@require_admin
def list_pending():
    status = request.args.get('status', 'pending')
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM pending_requests WHERE status=? ORDER BY submitted_at DESC",
        (status,)
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d['payload'] = json.loads(d['payload'])
        result.append(d)
    return jsonify(result)


@pending_bp.route('/api/pending/<req_id>', methods=['PATCH'])
def review_pending(req_id):
    # Accept either bot shared secret OR admin JWT
    import os
    bot_secret = os.environ.get('NHL_BOT_SECRET', '')
    has_bot_secret = bot_secret and request.headers.get('X-Bot-Secret', '') == bot_secret
    if not has_bot_secret:
        from server.routes.auth import check_auth
        ok, err = check_auth()
        if not ok:
            return err

    body = request.get_json(force=True) or {}
    action = body.get('action')   # 'approve' | 'reject'
    notes  = body.get('notes', '')

    if action not in ('approve', 'reject'):
        return jsonify({'error': 'action must be approve or reject'}), 400

    conn = get_conn()
    row = conn.execute("SELECT * FROM pending_requests WHERE id=?", (req_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    if row['status'] != 'pending':
        conn.close()
        return jsonify({'error': 'Already reviewed'}), 409

    reviewed_at = datetime.now(timezone.utc).isoformat()
    status = 'approved' if action == 'approve' else 'rejected'

    conn.execute("""
        UPDATE pending_requests
        SET status=?, reviewed_at=?, notes=?
        WHERE id=?
    """, (status, reviewed_at, notes, req_id))
    conn.commit()
    conn.close()

    result = {'ok': True, 'status': status}

    # If approved, apply the change to league state (fresh connection — avoids lock contention)
    if action == 'approve':
        payload = json.loads(row['payload'])
        req_type = row['type']
        try:
            conn2 = get_conn()
            state_row = conn2.execute("SELECT data FROM league_state WHERE id=1").fetchone()
            if state_row:
                state = json.loads(state_row['data'])
                updated_game = None
                applied_trade = None
                if req_type == 'score':
                    updated_game = _apply_score(state, payload)
                elif req_type == 'trade':
                    applied_trade = _apply_trade(state, payload)
                elif req_type == 'linkAccount':
                    _apply_link_account(state, payload)
                conn2.execute(
                    "UPDATE league_state SET data=?, updated=datetime('now') WHERE id=1",
                    (json.dumps(state),)
                )
                conn2.commit()
                conn2.close()
                if req_type == 'score' and updated_game:
                    queue_score_event(updated_game, {
                        'source': 'pending_request',
                        'pendingRequestId': req_id,
                        'submittedBy': row['submitted_by'],
                        'submittedName': row['submitted_name'],
                    })
                if req_type == 'trade' and applied_trade:
                    queue_trade_event(applied_trade, {
                        'source': 'pending_request',
                        'pendingRequestId': req_id,
                        'approvedBy': row['reviewed_by'] or 'admin',
                    })
                result['applied'] = True
            else:
                conn2.close()
        except Exception as e:
            result['applied'] = False
            result['error'] = str(e)

    return jsonify(result)


# ── State mutation helpers ────────────────────────────────────────────────────

def _apply_score(state, payload):
    """Mark a game as played and record the score.
    Also stores zamboniGameId + zamboniStats when submitted via the Zamboni picker."""
    game_id    = payload.get('gameId')
    home_score = int(payload.get('homeScore', 0))
    away_score = int(payload.get('awayScore', 0))
    ot         = bool(payload.get('ot', False))

    for g in state.get('games', []):
        if g['id'] == game_id:
            g['played']    = True
            g['homeScore'] = home_score
            g['awayScore'] = away_score
            g['ot']        = ot
            g['postedAt']  = datetime.now(timezone.utc).isoformat()
            if payload.get('zamboniGameId'):
                g['zamboniGameId'] = payload['zamboniGameId']
            if payload.get('zamboniStats'):
                g['zamboniStats'] = payload['zamboniStats']
            g['winner'] = g['homeTeam'] if home_score > away_score else g['awayTeam']
            # If it's a playoff game, recalculate the bracket
            if g.get('playoff'):
                _recalc_playoff_bracket(state)
            return g
    raise ValueError(f"Game {game_id} not found")


def _recalc_playoff_bracket(state):
    """Recalculate playoff bracket wins from real game scores, generate next game stubs."""
    import uuid as _uuid

    po = state.get('playoffs')
    if not po or not po.get('rounds'):
        return

    rounds = po['rounds']

    for ri, round_ in enumerate(rounds):
        win_to = round_.get('winTo', 2)
        po_week = 100 + ri

        for s in round_.get('series', []):
            t1, t2 = s.get('team1'), s.get('team2')
            if not t1 or not t2:
                continue

            # Count wins from played playoff games between these two teams
            series_games = [
                g for g in state.get('games', [])
                if g.get('playoff') and g.get('played') and
                ((g['homeTeam'] == t1 and g['awayTeam'] == t2) or
                 (g['homeTeam'] == t2 and g['awayTeam'] == t1))
            ]

            w1 = w2 = 0
            for g in series_games:
                if g['homeScore'] > g['awayScore']:
                    if g['homeTeam'] == t1: w1 += 1
                    else:                   w2 += 1
                else:
                    if g['awayTeam'] == t1: w1 += 1
                    else:                   w2 += 1

            s['wins1'] = w1
            s['wins2'] = w2

            if w1 >= win_to:
                s['winner'] = t1
            elif w2 >= win_to:
                s['winner'] = t2
            else:
                s['winner'] = None
                # Ensure an unplayed game stub exists for the next game
                game_num = w1 + w2 + 1
                has_pending = any(
                    g for g in state.get('games', [])
                    if g.get('playoff') and not g.get('played') and
                    ((g['homeTeam'] == t1 and g['awayTeam'] == t2) or
                     (g['homeTeam'] == t2 and g['awayTeam'] == t1))
                )
                if not has_pending:
                    round_name = round_.get('name', f'Round {ri + 1}')
                    state.setdefault('games', []).append({
                        'id':        str(_uuid.uuid4()),
                        'week':      po_week,
                        'game':      game_num,
                        'homeTeam':  t1,
                        'awayTeam':  t2,
                        'played':    False,
                        'homeScore': 0,
                        'awayScore': 0,
                        'ot':        False,
                        'playoff':   True,
                        'notes':     f'{round_name} – Game {game_num}',
                    })

        # If round is complete, populate & generate stubs for next round
        series_list = round_.get('series', [])
        all_done = bool(series_list) and all(s.get('winner') for s in series_list)
        if all_done and ri + 1 < len(rounds):
            next_round = rounds[ri + 1]
            if not next_round.get('series'):
                # Re-seed: sort winners by advancing seed (best remaining vs worst remaining)
                advancers = []
                for s in series_list:
                    advancing_seed = s.get('seed1', 99) if s['winner'] == s['team1'] else s.get('seed2', 99)
                    advancers.append({'team': s['winner'], 'seed': advancing_seed})
                advancers.sort(key=lambda a: a['seed'])
                n = len(advancers)
                next_series = []
                for i in range(n // 2):
                    t1 = advancers[i]['team']
                    t2 = advancers[n - 1 - i]['team']
                    if t1 and t2:
                        next_series.append({
                            'team1': t1, 'team2': t2,
                            'wins1': 0, 'wins2': 0, 'winner': None,
                            'winTo': next_round.get('winTo', 2),
                            'seed1': advancers[i]['seed'],
                            'seed2': advancers[n - 1 - i]['seed'],
                        })
                next_round['series'] = next_series

                next_week    = 100 + ri + 1
                round_name   = next_round.get('name', f'Round {ri + 2}')
                for s in next_series:
                    state.setdefault('games', []).append({
                        'id':        str(_uuid.uuid4()),
                        'week':      next_week,
                        'game':      1,
                        'homeTeam':  s['team1'],
                        'awayTeam':  s['team2'],
                        'played':    False,
                        'homeScore': 0,
                        'awayScore': 0,
                        'ot':        False,
                        'playoff':   True,
                        'notes':     f'{round_name} – Game 1',
                    })


def _apply_trade_history(state):
    """Python equivalent of JS applyTradeHistory() — replays all trades chronologically to set teamCode."""
    def to_list(v):
        if isinstance(v, list):
            return v
        return [v] if v else []

    trades = sorted(state.get('trades', []), key=lambda t: t.get('date', ''))
    player_map = {p['name']: p for p in state.get('players', [])}
    for t in trades:
        for name in to_list(t.get('playersSent', [])):
            p = player_map.get(name)
            if p:
                p['teamCode'] = t['toTeam']
        for name in to_list(t.get('playersReceived', [])):
            p = player_map.get(name)
            if p:
                p['teamCode'] = t['fromTeam']


def _apply_link_account(state, payload):
    """Write discordId, discordUsername, and zamboniTag onto a manager record."""
    mgr_id = payload.get('managerId')
    for mgr in state.get('managers', []):
        if mgr['id'] == mgr_id:
            if payload.get('discordId'):
                mgr['discordId'] = str(payload['discordId'])
            if payload.get('discordUsername'):
                mgr['discordUsername'] = payload['discordUsername']
            if payload.get('zamboniTag'):
                mgr['zamboniTag'] = payload['zamboniTag']
            return
    raise ValueError(f"Manager {mgr_id} not found")


def _apply_trade(state, payload):
    """Append a trade record to the state and update player teamCode values."""
    trade = {
        'id':              payload.get('id', str(uuid.uuid4())),
        'date':            payload.get('date', datetime.now(timezone.utc).date().isoformat()),
        'fromTeam':        payload['fromTeam'],
        'toTeam':          payload['toTeam'],
        'playersSent':     payload.get('playersSent', []),
        'playersReceived': payload.get('playersReceived', []),
        'notes':           payload.get('notes', ''),
    }
    state.setdefault('trades', []).insert(0, trade)
    _apply_trade_history(state)
    return trade
