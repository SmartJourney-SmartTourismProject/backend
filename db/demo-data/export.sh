#!/usr/bin/env bash
# Export the reference data (districts, listings, images, events, entry fees,
# knowledge base, ...) from the local database WITHOUT any user data, so a
# fresh local setup can be populated with restore.sh.
#
# Run from backend/ with the local docker stack up:
#   bash db/demo-data/export.sh            -> db/demo-data/out/{sj.dump,fees.csv,fees.cols}
#
# Excluded (schema kept, rows dropped): accounts, profiles, chats, saved
# trips, expenses, OAuth tokens, activity log, and the Admin > AI models
# settings/API keys. listing_entry_fee is exported separately as CSV with
# reviewed_by cleared, because it points at app_user rows that won't exist.
set -euo pipefail
# Git Bash on Windows would rewrite /tmp/... arguments into Windows paths.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"

C=smartjourney_postgres
U="${POSTGRES_USER:-smartjourney}"
D="${POSTGRES_DB:-smartjourney}"
OUT=./out
mkdir -p "$OUT"

USER_TABLES="app_user traveler_profile admin_profile refresh_token google_oauth_tokens ai_session
chat_session chat_message itinerary itinerary_day itinerary_item expense activity_log
app_setting llm_provider_key listing_entry_fee"

EXCLUDES=()
for t in $USER_TABLES; do EXCLUDES+=("--exclude-table-data=$t"); done

echo ">> pg_dump (reference data only)"
docker exec "$C" pg_dump -U "$U" -d "$D" -Fc "${EXCLUDES[@]}" -f /tmp/sj.dump
docker cp "$C:/tmp/sj.dump" "$OUT/sj.dump"
docker exec "$C" rm -f /tmp/sj.dump

echo ">> entry fees (reviewer cleared)"
COLS=$(docker exec "$C" psql -U "$U" -d "$D" -tA -c \
  "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='listing_entry_fee'")
SELECT=$(echo "$COLS" | sed 's/\breviewed_by\b/NULL::uuid AS reviewed_by/')
echo "$COLS" > "$OUT/fees.cols"
docker exec "$C" psql -U "$U" -d "$D" -v ON_ERROR_STOP=1 \
  -c "\\copy (select $SELECT from listing_entry_fee) to stdout csv" > "$OUT/fees.csv"

ls -la "$OUT"
echo ">> done. Copy db/demo-data/out/ into the submission (it is gitignored)."
