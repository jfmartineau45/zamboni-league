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

    result = {'ok': True, 'status': status}

    # If approved, apply the change to league state
    if action == 'approve':
        payload = json.loads(row['payload'])
        req_type = row['type']
        state_row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
        if state_row:
            try:
                state = json.loads(state_row['data'])
                if req_type == 'score':
                    _apply_score(state, payload)
                elif req_type == 'trade':
                    _apply_trade(state, payload)
                conn.execute(
                    "UPDATE league_state SET data=?, updated=datetime('now') WHERE id=1",
                    (json.dumps(state),)
                )
                result['applied'] = True
            except Exception as e:
                result['applied'] = False
                result['error'] = str(e)

    conn.commit()
    conn.close()
    return jsonify(result)


# ── State mutation helpers ────────────────────────────────────────────────────

def _apply_score(state, payload):
    """Mark a game as played and record the score."""
    game_id = payload.get('gameId')
    home_score = int(payload.get('homeScore', 0))
    away_score = int(payload.get('awayScore', 0))
    ot = bool(payload.get('ot', False))

    for g in state.get('games', []):
        if g['id'] == game_id:
            g['played']    = True
            g['homeScore'] = home_score
            g['awayScore'] = away_score
            g['ot']        = ot
            # Determine winner
            if home_score > away_score:
                g['winner'] = g['homeTeam']
            else:
                g['winner'] = g['awayTeam']
            return
    raise ValueError(f"Game {game_id} not found")


def _apply_trade(state, payload):
    """Append a trade record to the state."""
    import time
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
