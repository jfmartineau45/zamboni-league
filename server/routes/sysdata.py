"""
routes/sysdata.py — GET /api/sysdata, POST /api/sysdata, DELETE /api/sysdata
Binary SYS-DATA file upload and download.
"""
from flask import Blueprint, request, jsonify, send_file
import io
import json
from datetime import datetime, timezone
from server.db import get_conn
from server.routes.auth import require_admin

sysdata_bp = Blueprint('sysdata', __name__)


@sysdata_bp.route('/api/sysdata', methods=['GET'])
def download_sysdata():
    conn = get_conn()
    row = conn.execute("SELECT filename, data FROM sysdata_file WHERE id=1").fetchone()
    conn.close()
    if not row or not row['data']:
        return jsonify({'error': 'No SYS-DATA file uploaded'}), 404
    return send_file(
        io.BytesIO(bytes(row['data'])),
        download_name=row['filename'] or 'SYS-DATA',
        as_attachment=True,
        mimetype='application/octet-stream'
    )


@sysdata_bp.route('/api/sysdata/meta', methods=['GET'])
def sysdata_meta():
    conn = get_conn()
    row = conn.execute(
        "SELECT filename, size, uploaded_at FROM sysdata_file WHERE id=1"
    ).fetchone()
    conn.close()
    if not row:
        return jsonify(None)
    meta = dict(row)
    meta['name'] = meta.get('filename') or 'SYS-DATA'
    return jsonify(meta)


@sysdata_bp.route('/api/sysdata', methods=['POST'])
@require_admin
def upload_sysdata():
    if request.files:
        f = next(iter(request.files.values()))
        data = f.read()
        filename = f.filename or 'SYS-DATA'
    else:
        data = request.get_data()
        filename = request.headers.get('X-Filename', 'SYS-DATA')

    if not data:
        return jsonify({'error': 'No data received'}), 400

    uploaded_at = datetime.now(timezone.utc).isoformat()
    conn = get_conn()
    conn.execute("""
        INSERT INTO sysdata_file (id, filename, size, uploaded_at, data)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            filename=excluded.filename, size=excluded.size,
            uploaded_at=excluded.uploaded_at, data=excluded.data
    """, (filename, len(data), uploaded_at, data))

    # Update sysDataFile metadata in league_state (no blob)
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    if row:
        try:
            state = json.loads(row['data'])
            state['sysDataFile'] = {
                'name': filename,
                'filename': filename,
                'size': len(data),
                'uploadedAt': uploaded_at,
                'week': state.get('sysDataFile', {}).get('week'),
            }
            conn.execute("UPDATE league_state SET data=?, updated=datetime('now') WHERE id=1",
                         (json.dumps(state),))
        except Exception:
            pass

    conn.commit()
    conn.close()
    return jsonify({
        'ok': True,
        'name': filename,
        'filename': filename,
        'size': len(data),
        'uploadedAt': uploaded_at,
    })


@sysdata_bp.route('/api/sysdata', methods=['DELETE'])
@require_admin
def delete_sysdata():
    conn = get_conn()
    conn.execute("DELETE FROM sysdata_file WHERE id=1")
    row = conn.execute("SELECT data FROM league_state WHERE id=1").fetchone()
    if row:
        try:
            state = json.loads(row['data'])
            state['sysDataFile'] = None
            conn.execute("UPDATE league_state SET data=?, updated=datetime('now') WHERE id=1",
                         (json.dumps(state),))
        except Exception:
            pass
    conn.commit()
    conn.close()
    return jsonify({'ok': True})
