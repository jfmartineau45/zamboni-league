"""
migrate_hash_discord_ids.py — One-time migration to hash plaintext Discord IDs in user_links.

Usage:
    python3 server/migrate_hash_discord_ids.py --key YOUR_FLASK_SECRET_KEY [--db path/to/league.db] [--dry-run]

Run BEFORE deploying the hashing code change to production.
Safe to re-run: already-hashed rows (64-char hex) are skipped automatically.
"""
import argparse
import hashlib
import hmac
import sqlite3
import sys


def is_already_hashed(value: str) -> bool:
    return len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def hash_discord_id(discord_id: str, key: str) -> str:
    return hmac.new(key.encode(), discord_id.encode(), hashlib.sha256).hexdigest()


def run(db_path: str, secret_key: str, dry_run: bool):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute('SELECT id, discord_id, manager_id, discord_username FROM user_links').fetchall()

    print(f"Found {len(rows)} user_links rows in {db_path}")
    to_update = [(r['id'], r['discord_id'], r['manager_id'], r['discord_username'])
                 for r in rows if r['discord_id'] and not is_already_hashed(r['discord_id'])]
    already_hashed = len(rows) - len(to_update)

    print(f"  Already hashed: {already_hashed}")
    print(f"  Need hashing:   {len(to_update)}")

    if not to_update:
        print("Nothing to do.")
        conn.close()
        return

    for row_id, discord_id, manager_id, username in to_update:
        hashed = hash_discord_id(discord_id, secret_key)
        print(f"  {'[DRY RUN] ' if dry_run else ''}Hashing manager={manager_id} username={username} {discord_id[:6]}... → {hashed[:12]}...")
        if not dry_run:
            conn.execute('UPDATE user_links SET discord_id = ? WHERE id = ?', (hashed, row_id))

    if not dry_run:
        conn.commit()
        print(f"\nDone. {len(to_update)} rows updated.")
    else:
        print(f"\nDry run complete. Re-run without --dry-run to apply.")

    conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Hash plaintext Discord IDs in user_links table.')
    parser.add_argument('--key', required=True, help='FLASK_SECRET_KEY value from prod .env')
    parser.add_argument('--db', default='server/league.db', help='Path to league.db (default: server/league.db)')
    parser.add_argument('--dry-run', action='store_true', help='Preview changes without writing')
    args = parser.parse_args()

    if not args.key.strip():
        print("ERROR: --key cannot be empty")
        sys.exit(1)

    run(args.db, args.key.strip(), args.dry_run)
