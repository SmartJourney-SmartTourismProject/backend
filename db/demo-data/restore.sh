#!/usr/bin/env bash
# Load the SmartJourney reference data into a LOCAL database.
#
# Needs: the local docker stack running (`docker compose up -d` in backend/),
# and sj.dump, fees.csv, fees.cols in the folder given as the first argument
# (default: db/demo-data/out). Run from backend/ in Git Bash or any bash:
#   bash db/demo-data/restore.sh /path/to/demo-data
#
# DESTRUCTIVE for the local app database: it is dropped and recreated.
# Keycloak's own database (accounts) is not touched.
set -euo pipefail
# Git Bash on Windows would rewrite /tmp/... arguments into Windows paths.
export MSYS_NO_PATHCONV=1

SRC="${1:-$(dirname "$0")/out}"
C=smartjourney_postgres
U="${POSTGRES_USER:-smartjourney}"
D="${POSTGRES_DB:-smartjourney}"

for f in sj.dump fees.csv fees.cols; do
  [ -s "$SRC/$f" ] || { echo "missing or empty: $SRC/$f" >&2; exit 1; }
done

echo ">> recreating database $D"
docker exec "$C" dropdb -U "$U" --force --if-exists "$D"
docker exec "$C" createdb -U "$U" "$D"

echo ">> restoring the dump"
docker cp "$SRC/sj.dump" "$C:/tmp/sj.dump"
docker exec "$C" pg_restore -U "$U" -d "$D" --no-owner --no-privileges /tmp/sj.dump
docker exec "$C" rm -f /tmp/sj.dump

echo ">> loading entry fees"
docker exec -i "$C" psql -U "$U" -d "$D" -v ON_ERROR_STOP=1 \
  -c "\\copy listing_entry_fee ($(cat "$SRC/fees.cols")) from stdin csv" < "$SRC/fees.csv"

echo ">> row counts:"
docker exec "$C" psql -U "$U" -d "$D" -tA -c \
  "select 'districts', count(*) from district union all select 'listings', count(*) from travel_listing union all select 'events', count(*) from local_event union all select 'entry fees', count(*) from listing_entry_fee"
echo ">> done. Restart the NestJS backend and the AI backend if they were running."
