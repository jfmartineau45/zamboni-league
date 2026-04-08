#!/usr/bin/env python3
"""
Database migration script for NHL Legacy League
Applies schema changes and seeds data from existing league_state
"""
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / 'league.db'
SCHEMA_PATH = Path(__file__).parent / 'schema_migrations.sql'


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def load_state(conn):
    row = conn.execute('SELECT data FROM league_state WHERE id=1').fetchone()
    if not row:
        return {}
    return json.loads(row['data'])


def apply_schema(conn):
    """Apply all schema migrations"""
    print('[migrate] Applying schema migrations...')
    with open(SCHEMA_PATH) as f:
        schema_sql = f.read()
    conn.executescript(schema_sql)
    conn.commit()
    print('[migrate] Schema migrations applied')


def seed_user_links(conn):
    """Seed user_links table from existing manager records"""
    print('[migrate] Seeding user_links from existing manager data...')
    state = load_state(conn)
    managers = state.get('managers', [])
    
    seeded = 0
    skipped = 0
    
    for mgr in managers:
        discord_id = str(mgr.get('discordId', '')).strip()
        if not discord_id:
            continue
        
        # Check if already exists
        existing = conn.execute(
            'SELECT id FROM user_links WHERE discord_id = ?',
            (discord_id,)
        ).fetchone()
        
        if existing:
            skipped += 1
            continue
        
        # Insert new link
        conn.execute('''
            INSERT INTO user_links (
                discord_id, manager_id, discord_username, discord_avatar,
                zamboni_tag, linked_at, updated_at, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            discord_id,
            mgr['id'],
            mgr.get('discordUsername', ''),
            mgr.get('discordAvatar', ''),
            mgr.get('zamboniTag', ''),
            mgr.get('lastLinkedAt') or datetime.now(timezone.utc).isoformat(),
            datetime.now(timezone.utc).isoformat(),
            'migration'
        ))
        seeded += 1
    
    conn.commit()
    print(f'[migrate] Seeded {seeded} user links, skipped {skipped} existing')


def verify_tables(conn):
    """Verify all expected tables exist"""
    print('[migrate] Verifying tables...')
    expected = ['user_links', 'score_submissions', 'trade_offers', 'bot_events']
    cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    existing = {row['name'] for row in cursor.fetchall()}
    
    for table in expected:
        if table in existing:
            count = conn.execute(f'SELECT COUNT(*) as cnt FROM {table}').fetchone()['cnt']
            print(f'[migrate]   ✓ {table} ({count} rows)')
        else:
            print(f'[migrate]   ✗ {table} MISSING')
            return False
    
    return True


def main():
    print('[migrate] Starting database migration...')
    print(f'[migrate] Database: {DB_PATH}')
    
    if not DB_PATH.exists():
        print('[migrate] ERROR: Database file not found')
        sys.exit(1)
    
    if not SCHEMA_PATH.exists():
        print('[migrate] ERROR: Schema file not found')
        sys.exit(1)
    
    conn = get_conn()
    
    try:
        # Apply schema
        apply_schema(conn)
        
        # Seed data
        seed_user_links(conn)
        
        # Verify
        if verify_tables(conn):
            print('[migrate] ✓ Migration completed successfully')
        else:
            print('[migrate] ✗ Migration verification failed')
            sys.exit(1)
    
    except Exception as e:
        print(f'[migrate] ERROR: {e}')
        conn.rollback()
        sys.exit(1)
    
    finally:
        conn.close()


if __name__ == '__main__':
    main()
