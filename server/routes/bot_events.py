"""
bot_events.py — Queue of events the Discord bot should post (scores, trades, etc.)
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

from flask import Blueprint, jsonify, request

from server.db import get_conn

bot_events_bp = Blueprint('bot_events', __name__)


# ── helpers ────────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _check_bot_secret() -> bool:
    secret = os.environ.get('NHL_BOT_SECRET', '')
    if secret and request.headers.get('X-Bot-Secret', '') != secret:
        return False
    return True


def enqueue_bot_event(event_type: str, payload: dict[str, Any]):
    """Insert a new event for the Discord bot to handle."""
    conn = get_conn()
    conn.execute(
        """
        INSERT INTO bot_events (event_type, payload, created_at)
        VALUES (?, ?, ?)
        """,
        (event_type, json.dumps(payload), _now_iso()),
    )
    conn.commit()
    conn.close()


def queue_score_event(game: dict[str, Any], extra: dict[str, Any] | None = None):
    """Convenience wrapper to enqueue a score-final event."""
    payload = {
        'gameId':      game.get('id'),
        'week':        game.get('week'),
        'homeTeam':    game.get('homeTeam') or game.get('home'),
        'awayTeam':    game.get('awayTeam') or game.get('away'),
        'homeScore':   int(game.get('homeScore', 0) or 0),
        'awayScore':   int(game.get('awayScore', 0) or 0),
        'ot':          bool(game.get('ot', False)),
        'postedAt':    game.get('postedAt') or _now_iso(),
        'zamboniGameId': game.get('zamboniGameId'),
        'zamboniStats': game.get('zamboniStats'),
    }
    if extra:
        payload.update(extra)
    enqueue_bot_event('score_final', payload)


def queue_trade_event(trade: dict[str, Any], extra: dict[str, Any] | None = None):
    """Convenience wrapper to enqueue a trade-final event."""
    payload = {
        'tradeId':          trade.get('id'),
        'fromTeam':         trade.get('fromTeam'),
        'toTeam':           trade.get('toTeam'),
        'playersSent':      trade.get('playersSent', []),
        'playersReceived':  trade.get('playersReceived', []),
        'notes':            trade.get('notes', ''),
        'date':             trade.get('date') or _now_iso(),
    }
    if extra:
        payload.update(extra)
    enqueue_bot_event('trade_final', payload)


# ── routes ─────────────────────────────────────────────────────────────────────

@bot_events_bp.route('/api/bot/events', methods=['GET'])
def list_bot_events():
    if not _check_bot_secret():
        return jsonify({'error': 'Forbidden'}), 403

    try:
        limit = int(request.args.get('limit', 20))
    except ValueError:
        limit = 20
    limit = max(1, min(limit, 100))

    conn = get_conn()
    rows = conn.execute(
        """
        SELECT id, event_type, payload, created_at
        FROM bot_events
        WHERE handled_at IS NULL
        ORDER BY id ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    conn.close()

    events = []
    for row in rows:
        try:
            payload = json.loads(row['payload'])
        except Exception:
            payload = {}
        events.append({
            'id': row['id'],
            'eventType': row['event_type'],
            'payload': payload,
            'createdAt': row['created_at'],
        })

    return jsonify({'events': events})


@bot_events_bp.route('/api/bot/events/ack', methods=['POST'])
def ack_bot_events():
    if not _check_bot_secret():
        return jsonify({'error': 'Forbidden'}), 403

    body = request.get_json(force=True) or {}
    ids = body.get('ids') or []
    handled_by = (body.get('handledBy') or '').strip() or 'discord-bot'

    try:
        id_list = [int(i) for i in ids if int(i) > 0]
    except (ValueError, TypeError):
        return jsonify({'error': 'ids must be integers'}), 400

    if not id_list:
        return jsonify({'error': 'ids array required'}), 400

    placeholders = ','.join('?' for _ in id_list)
    params = [_now_iso(), handled_by, *id_list]

    conn = get_conn()
    cur = conn.execute(
        f"""
        UPDATE bot_events
        SET handled_at = ?, handled_by = ?
        WHERE handled_at IS NULL AND id IN ({placeholders})
        """,
        params,
    )
    conn.commit()
    conn.close()

    return jsonify({'ok': True, 'updated': cur.rowcount})


@bot_events_bp.route('/api/bot/score', methods=['POST'])
def enqueue_score():
    """Admin site calls this after entering a score via the schedule to notify the bot."""
    from server.routes.auth import check_auth
    ok, err = check_auth()
    if not ok:
        return err
    game = request.get_json(force=True) or {}
    if not game.get('homeTeam') or not game.get('awayTeam'):
        return jsonify({'error': 'homeTeam and awayTeam required'}), 400
    queue_score_event(game, {'source': 'admin_site', 'approvedBy': 'admin'})
    return jsonify({'ok': True})


@bot_events_bp.route('/api/admin/bot/score-event', methods=['POST'])
def enqueue_score_event_admin():
    """Admin site calls this after entering a score via the schedule to notify the bot."""
    from server.routes.auth import check_auth
    ok, err = check_auth()
    if not ok:
        return err
    game = request.get_json(force=True) or {}
    if not game.get('homeTeam') or not game.get('awayTeam'):
        return jsonify({'error': 'homeTeam and awayTeam required'}), 400
    queue_score_event(game, {'source': 'admin_site', 'approvedBy': 'admin'})
    return jsonify({'ok': True})


@bot_events_bp.route('/api/bot/trade', methods=['POST'])
def enqueue_trade():
    """Admin site calls this after recording a trade to notify the bot."""
    from server.routes.auth import check_auth
    ok, err = check_auth()
    if not ok:
        return err
    trade = request.get_json(force=True) or {}
    if not trade.get('fromTeam') or not trade.get('toTeam'):
        return jsonify({'error': 'fromTeam and toTeam required'}), 400
    queue_trade_event(trade, {'source': 'admin_site', 'approvedBy': 'admin'})
    return jsonify({'ok': True})
