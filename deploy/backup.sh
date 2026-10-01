#!/usr/bin/env bash
# Nightly backup of both databases (cron, see MANUAL_SETUP.md section 8.5).
# Custom-format dumps, restorable with pg_restore. Keeps the last 7 of each.
set -euo pipefail
cd "$(dirname "$0")"

# Read only the few values needed, not `source .env`: a value with spaces
# (a Gmail app password copied as "abcd efgh ...") would break sourcing.
env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
POSTGRES_USER="$(env_value POSTGRES_USER)"; POSTGRES_DB="$(env_value POSTGRES_DB)"
KEYCLOAK_DB_USER="$(env_value KEYCLOAK_DB_USER)"; KEYCLOAK_DB_NAME="$(env_value KEYCLOAK_DB_NAME)"
COMPOSE=(./compose.sh)
STAMP="$(date -u +%Y%m%d-%H%M%S)"
DIR=./backups
mkdir -p "$DIR"

"${COMPOSE[@]}" exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$DIR/app-$STAMP.dump"
"${COMPOSE[@]}" exec -T keycloak_db pg_dump -U "$KEYCLOAK_DB_USER" -d "$KEYCLOAK_DB_NAME" -Fc > "$DIR/keycloak-$STAMP.dump"

for prefix in app keycloak; do
  ls -1t "$DIR/$prefix"-*.dump 2>/dev/null | tail -n +8 | xargs -r rm --
done
echo "backup $STAMP ok: $(du -h "$DIR/app-$STAMP.dump" | cut -f1) app, $(du -h "$DIR/keycloak-$STAMP.dump" | cut -f1) keycloak"
