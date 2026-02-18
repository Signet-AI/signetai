#!/usr/bin/env python3
"""
Signet Database Migration Tool

Applies pending migrations to memories.db.
Migrations are in migrations/ directory, named NNN_name.sql
"""

import sqlite3
import hashlib
import os
import sys
from pathlib import Path
from datetime import datetime

DB_PATH = Path.home() / ".agents/memory/memories.db"
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def get_checksum(sql: str) -> str:
    """SHA-256 checksum of migration SQL."""
    return hashlib.sha256(sql.encode()).hexdigest()[:16]


def ensure_migrations_table(conn: sqlite3.Connection):
    """Create schema_migrations table if it doesn't exist."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version     INTEGER PRIMARY KEY,
            applied_at  TEXT NOT NULL,
            checksum    TEXT NOT NULL
        )
    """)
    conn.commit()


def get_current_version(conn: sqlite3.Connection) -> int:
    """Get current schema version, 0 if no migrations table."""
    ensure_migrations_table(conn)
    cursor = conn.execute(
        "SELECT MAX(version) FROM schema_migrations"
    )
    result = cursor.fetchone()[0]
    return result if result else 0


def get_pending_migrations(current_version: int) -> list[tuple[int, Path]]:
    """Get list of migrations to apply."""
    if not MIGRATIONS_DIR.exists():
        return []
    
    migrations = []
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        # Extract version from filename (e.g., 001_name.sql -> 1)
        try:
            version = int(f.name.split("_")[0])
            if version > current_version:
                migrations.append((version, f))
        except ValueError:
            continue
    
    return migrations


def apply_migration(conn: sqlite3.Connection, version: int, path: Path) -> bool:
    """Apply a single migration."""
    sql = path.read_text()
    checksum = get_checksum(sql)
    
    print(f"  Applying migration {version}: {path.name}")
    
    try:
        # Split by semicolon and execute each statement
        # (executescript doesn't work well with ALTER TABLE)
        statements = [s.strip() for s in sql.split(";") if s.strip()]
        
        for stmt in statements:
            if stmt and not stmt.startswith("--"):
                try:
                    conn.execute(stmt)
                except sqlite3.OperationalError as e:
                    # Ignore "duplicate column" errors for idempotency
                    if "duplicate column" in str(e).lower():
                        print(f"    (skipping: {e})")
                        continue
                    # Ignore "table already exists" errors
                    if "already exists" in str(e).lower():
                        print(f"    (skipping: {e})")
                        continue
                    raise
        
        # Record migration
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)",
            (version, datetime.utcnow().isoformat() + "Z", checksum)
        )
        
        conn.commit()
        print(f"  ✓ Migration {version} applied")
        return True
        
    except Exception as e:
        conn.rollback()
        print(f"  ✗ Migration {version} failed: {e}")
        return False


def migrate():
    """Run all pending migrations."""
    if not DB_PATH.exists():
        print(f"Database not found: {DB_PATH}")
        sys.exit(1)
    
    conn = sqlite3.connect(DB_PATH)
    
    try:
        current = get_current_version(conn)
        print(f"Current schema version: {current}")
        
        pending = get_pending_migrations(current)
        
        if not pending:
            print("No pending migrations.")
            return
        
        print(f"Found {len(pending)} pending migration(s)")
        
        for version, path in pending:
            if not apply_migration(conn, version, path):
                print("Migration failed, stopping.")
                sys.exit(1)
        
        new_version = get_current_version(conn)
        print(f"\nSchema upgraded to version {new_version}")
        
    finally:
        conn.close()


def status():
    """Show migration status."""
    if not DB_PATH.exists():
        print(f"Database not found: {DB_PATH}")
        return
    
    conn = sqlite3.connect(DB_PATH)
    
    try:
        current = get_current_version(conn)
        print(f"Current schema version: {current}")
        
        # Show applied migrations
        try:
            cursor = conn.execute(
                "SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version"
            )
            applied = cursor.fetchall()
            if applied:
                print("\nApplied migrations:")
                for v, at, cs in applied:
                    print(f"  {v}: {at} ({cs})")
        except sqlite3.OperationalError:
            print("No migrations table yet.")
        
        # Show pending
        pending = get_pending_migrations(current)
        if pending:
            print(f"\nPending migrations: {len(pending)}")
            for v, p in pending:
                print(f"  {v}: {p.name}")
        else:
            print("\nNo pending migrations.")
            
    finally:
        conn.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "status":
        status()
    else:
        migrate()
