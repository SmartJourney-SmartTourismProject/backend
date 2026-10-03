#!/usr/bin/env bash
# Replace the production app database with a data export made on a dev machine.
# Used ONCE for the first deploy (deploy/MANUAL_SETUP.md section 8.2).
#
# Expects, in /opt/smartjourney/backups/:
#   sj.dump     pg_dump -Fc of the dev database, WITHOUT any user data
#   fees.csv    listing_entry_fee rows (reviewer cleared), CSV
#   fees.cols   comma-separated column list for fees.csv
#
#   ./restore-data.sh
#
# DESTRUCTIVE: drops and recreates the application database.
set -euo pipefail
cd "$(dirname "$0")"

B=./backups
for f in sj.dump fees.csv fees.cols; do
  [ -s "$B/$f" ] || { echo "missing or empty: $B/$f" >&2; exit 1; }
done

env_value() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2-; }
PGU="$(env_value POSTGRES_USER)"
PGD="$(env_value POSTGRES_DB)"

echo ">> stopping the services that use the database"
./compose.sh stop backend ai-backend </dev/null

echo ">> recreating database $PGD"
./compose.sh exec -T db dropdb -U "$PGU" --force --if-exists "$PGD" </dev/null
./compose.sh exec -T db createdb -U "$PGU" "$PGD" </dev/null

echo ">> restoring the dump (extensions come from the dump itself)"
./compose.sh exec -T db pg_restore -U "$PGU" -d "$PGD" --no-owner --no-privileges < "$B/sj.dump"

echo ">> loading entry fees"
./compose.sh exec -T db psql -U "$PGU" -d "$PGD" -v ON_ERROR_STOP=1 \
  -c "\\copy listing_entry_fee ($(cat "$B/fees.cols")) from stdin csv" < "$B/fees.csv"

echo ">> restarting the services"
./compose.sh start backend ai-backend </dev/null

echo ">> row counts:"
./compose.sh exec -T db psql -U "$PGU" -d "$PGD" -tA </dev/null -c \
  "select 'listings', count(*) from travel_listing union all select 'images', count(*) from listing_image union all select 'events', count(*) from local_event union all select 'districts', count(*) from district"
echo ">> done"
