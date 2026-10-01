#!/usr/bin/env bash
# One release of the backend side of the stack. Run on the server by the CD
# pipeline (backend/.github/workflows/ci.yml), copied there with the other
# deploy files:
#
#   ./release.sh <git-sha> [db_changed] [keycloak_changed]
#
# It is a script FILE (not commands piped in over ssh stdin) on purpose: a
# command like `docker compose run` reads stdin and swallows whatever script
# text follows it, silently skipping the rest of the release.
set -euo pipefail
cd "$(dirname "$0")"

SHA="${1:?usage: release.sh <git-sha> [db_changed] [keycloak_changed]}"
DB_CHANGED="${2:-false}"
KEYCLOAK_CHANGED="${3:-false}"

# Infrastructure (no-ops when already running).
./compose.sh up -d db keycloak_db redis

# New SQL migrations first: they are additive, so the old backend keeps
# working until the new one replaces it. -T = no TTY, never touch stdin.
BACKEND_TAG="$SHA" ./compose.sh run --rm -T migrate </dev/null

if [ "$DB_CHANGED" = true ]; then ./deploy.sh db "$SHA" </dev/null; fi
if [ "$KEYCLOAK_CHANGED" = true ]; then ./deploy.sh keycloak "$SHA" </dev/null; fi
./deploy.sh backend "$SHA" </dev/null

# First deploy only: bring up whatever is not running yet.
./compose.sh up -d keycloak caddy </dev/null
./compose.sh ps
