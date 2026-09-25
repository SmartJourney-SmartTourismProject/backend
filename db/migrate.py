#!/usr/bin/env python3
"""
Idempotent SQL migration runner for the shared PostGIS database.

Canonical schema lives here as plain SQL (decision D13,
ai-backend/docs/master_plan/PROJECT_MASTER_PLAN.md) rather than being owned
by Prisma migrations - NestJS later runs `prisma db pull` to introspect this
schema as a client, it does not define it. This unblocks the AI backend,
which needs real tables now and cannot wait for nest new + prisma init + auth.

Usage:
    python db/migrate.py              # apply every pending migration
    python db/migrate.py --status     # show what's applied vs pending
    python db/migrate.py --dry-run    # print what WOULD run, apply nothing

Reads DATABASE_URL from backend/.env (falls back to the DATABASE_URL env var
if already set). Applied migrations are tracked in schema_migration by
filename + sha256 checksum - if a previously-applied file's content changes,
this aborts loudly rather than silently reapplying or ignoring the edit.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

try:
    import psycopg2
except ImportError:
    sys.exit("psycopg2 not installed. pip install psycopg2-binary")

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def _strip_query(url: str) -> str:
    """backend/.env's DATABASE_URL carries Prisma's "?schema=public" query
    param, which psycopg2 rejects outright ("invalid dsn: invalid URI query
    parameter"). Same incompatibility documented for asyncpg in
    ai-backend/docs/master_plan/API_SETUP.md §2.2 - handled here so this
    script works against the file as committed, not just a hand-edited copy."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def _load_database_url() -> str:
    if os.environ.get("DATABASE_URL"):
        return _strip_query(os.environ["DATABASE_URL"])
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("DATABASE_URL="):
                return _strip_query(line.split("=", 1)[1].strip())
    sys.exit(f"DATABASE_URL not set and not found in {env_file}")


def _checksum(path: Path) -> str:
    """Hash the migration's *content*, with line endings normalised.

    Git's core.autocrlf (on by default on Windows) rewrites LF to CRLF on
    checkout, which changes the raw bytes of an already-applied migration and
    made this script abort with a spurious "applied with a different checksum"
    - the file was never edited, only checked out on a different machine.
    """
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _legacy_checksum(path: Path) -> str:
    """Pre-normalisation checksum, for rows written by an older copy of this
    script. Matching one of these is accepted, and the stored value is then
    upgraded in place so the comparison is stable from then on."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _migration_files() -> list[Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"), key=lambda p: p.name)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--status", action="store_true", help="show applied/pending, apply nothing")
    ap.add_argument("--dry-run", action="store_true", help="print what would run, apply nothing")
    args = ap.parse_args()

    database_url = _load_database_url()
    files = _migration_files()
    if not files:
        print(f"No .sql files found in {MIGRATIONS_DIR}")
        return 0

    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS schema_migration ("
                "  filename text PRIMARY KEY,"
                "  applied_at timestamptz NOT NULL DEFAULT now(),"
                "  checksum text NOT NULL)"
            )
            cur.execute("SELECT filename, checksum FROM schema_migration")
            applied = dict(cur.fetchall())

        pending = []
        for f in files:
            checksum = _checksum(f)
            if f.name in applied:
                if applied[f.name] == checksum:
                    continue
                if applied[f.name] == _legacy_checksum(f):
                    with conn, conn.cursor() as cur:
                        cur.execute(
                            "UPDATE schema_migration SET checksum = %s WHERE filename = %s",
                            (checksum, f.name),
                        )
                    print(f"Note: re-hashed '{f.name}' (line endings only, content unchanged).")
                    continue
                sys.exit(
                    f"ABORT: '{f.name}' was already applied with a different "
                    f"checksum. A shipped migration must never be edited - add "
                    f"a new migration file instead. "
                    f"(applied={applied[f.name][:12]}… now={checksum[:12]}…)"
                )
            pending.append((f, checksum))

        if args.status:
            print(f"{'APPLIED':10} filename")
            for f in files:
                mark = "yes" if f.name in applied else "PENDING"
                print(f"{mark:10} {f.name}")
            return 0

        if not pending:
            print("Nothing to apply - schema is up to date.")
            return 0

        print(f"{'DRY RUN: ' if args.dry_run else ''}{len(pending)} migration(s) pending:")
        for f, _ in pending:
            print(f"  - {f.name}")

        if args.dry_run:
            return 0

        for f, checksum in pending:
            print(f"Applying {f.name} ...", end=" ", flush=True)
            with conn, conn.cursor() as cur:
                cur.execute(f.read_text(encoding="utf-8"))
                cur.execute(
                    "INSERT INTO schema_migration (filename, checksum) VALUES (%s, %s)",
                    (f.name, checksum),
                )
            print("done")

        print(f"Applied {len(pending)} migration(s) successfully.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
