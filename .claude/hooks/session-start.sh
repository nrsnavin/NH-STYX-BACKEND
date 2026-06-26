#!/bin/bash
# Ensures the backend's database is ready before the session/app runs:
# starts PostgreSQL, installs deps (regenerating the Prisma client), applies
# pending migrations, and seeds an empty database. This prevents "Database
# request error" caused by a fresh or drifted (un-migrated) database.
set -euo pipefail

# Only needed in the remote (Claude Code on the web) environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# 1. Make sure PostgreSQL is accepting connections.
if ! pg_isready -q 2>/dev/null; then
  echo "Starting PostgreSQL..."
  pg_ctlcluster 16 main start 2>/dev/null || sudo pg_ctlcluster 16 main start 2>/dev/null || true
fi

# 2. Install dependencies (postinstall runs `prisma generate`, syncing the client).
npm install

# 3. Apply any pending migrations so the DB schema matches the Prisma schema.
npx prisma migrate deploy

# 4. Seed only when the database is empty.
node prisma/seed-if-empty.cjs

echo "Backend environment ready."
