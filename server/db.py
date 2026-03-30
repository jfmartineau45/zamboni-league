"""
db.py — SQLite init and connection helper
Database lives at roster-app/server/league.db
"""
import sqlite3
import os

DB_PATH = os.environ.get('NHL_DB_PATH') or os.path.join(os.path.dirname(__file__), 'league.db')


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_conn()
    c = conn.cursor()

    # Full league state blob (single row, id=1)
    c.execute("""
        CREATE TABLE IF NOT EXISTS league_state (
            id      INTEGER PRIMARY KEY CHECK (id = 1),
            data    TEXT NOT NULL,
            updated TEXT NOT NULL DEFAULT (datetime('now'))
        )
    """)

    # SYS-DATA binary file (single row, id=1) — stored separately to keep state blob small
    c.execute("""
        CREATE TABLE IF NOT EXISTS sysdata_file (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            filename    TEXT,
            size        INTEGER,
            uploaded_at TEXT,
            data        BLOB
        )
    """)

    # Pending requests from Discord (scores, trades, roster edits awaiting admin approval)
    c.execute("""
        CREATE TABLE IF NOT EXISTS pending_requests (
            id              TEXT PRIMARY KEY,
            type            TEXT NOT NULL,
            payload         TEXT NOT NULL,
            submitted_by    TEXT NOT NULL,
            submitted_name  TEXT,
            submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
            status          TEXT NOT NULL DEFAULT 'pending',
            reviewed_by     TEXT,
            reviewed_at     TEXT,
            notes           TEXT
        )
    """)

    conn.commit()
    conn.close()
    print(f"[db] Initialised at {DB_PATH}")
