#!/usr/bin/env sh
# Pushes the KC_SMTP_* settings from backend/.env into the running realm, so
# "forgot password" and "verify email" go to a real inbox instead of Mailpit.
#
# Why this exists: the KC_SMTP_* variables in docker-compose.yml are only read
# when Keycloak *imports* a realm. Once the realm exists in keycloak_db the
# import is skipped, so editing .env alone changes nothing - the settings have
# to be written through the Admin API (or by hand in Realm settings -> Email).
#
#   sh keycloak/apply-smtp.sh              # apply, then send a test email
#   sh keycloak/apply-smtp.sh --no-test    # apply only
#
# For Gmail, put this in backend/.env (the password is a 16-character Google
# *app password*, not your account password - Google Account -> Security ->
# 2-Step Verification -> App passwords):
#
#   KC_SMTP_HOST=smtp.gmail.com
#   KC_SMTP_PORT=587
#   KC_SMTP_AUTH=true
#   KC_SMTP_STARTTLS=true
#   KC_SMTP_SSL=false
#   KC_SMTP_USER=you@gmail.com
#   KC_SMTP_PASSWORD=xxxxxxxxxxxxxxxx
#   KC_SMTP_FROM=you@gmail.com
#
# Re-run keycloak/export-realm.sh afterwards; the export keeps ${KC_SMTP_*}
# placeholders, so no credential lands in git.
#
# No `set -e`: curl exits 23 (EPIPE) when a downstream `head -1` closes the
# pipe early, which would abort the script even though the call succeeded.
set -u
export MSYS_NO_PATHCONV=1   # Git Bash on Windows would mangle the URL paths

KC=${KC_URL:-http://localhost:8081}
REALM=${KC_REALM:-smartjourney}
ADMIN_USER=${KC_ADMIN_USER:-admin}
ADMIN_PASS=${KC_ADMIN_PASSWORD:-admin}
ENV_FILE="$(dirname "$0")/../.env"
TEST=yes
[ "${1:-}" = "--no-test" ] && TEST=no

[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE - copy .env.example first." >&2; exit 1; }

# Read KC_SMTP_* straight from .env so this script and the container agree on
# one source of truth. Values may legitimately be empty (user/password).
get() { sed -n "s/^$1=//p" "$ENV_FILE" | tr -d '\r' | head -1; }
HOST=$(get KC_SMTP_HOST);      PORT=$(get KC_SMTP_PORT)
FROM=$(get KC_SMTP_FROM);      DISPLAY=$(get KC_SMTP_FROM_DISPLAY_NAME)
AUTH=$(get KC_SMTP_AUTH);      USER=$(get KC_SMTP_USER)
PASS=$(get KC_SMTP_PASSWORD);  STARTTLS=$(get KC_SMTP_STARTTLS)
SSL=$(get KC_SMTP_SSL)

[ -n "$HOST" ] || { echo "KC_SMTP_HOST is not set in $ENV_FILE" >&2; exit 1; }
[ -n "$FROM" ] || { echo "KC_SMTP_FROM is not set in $ENV_FILE" >&2; exit 1; }
if [ "$AUTH" = "true" ] && { [ -z "$USER" ] || [ -z "$PASS" ]; }; then
  echo "KC_SMTP_AUTH=true but KC_SMTP_USER/KC_SMTP_PASSWORD are empty in $ENV_FILE" >&2
  exit 1
fi

token=$(curl -s -m 10 -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d client_id=admin-cli -d "username=$ADMIN_USER" -d "password=$ADMIN_PASS" -d grant_type=password |
  sed -E 's/.*"access_token":"([^"]+)".*/\1/')
[ -n "$token" ] || { echo "Could not log in to $KC as $ADMIN_USER" >&2; exit 1; }
H="Authorization: Bearer $token"
B="$KC/admin/realms/$REALM"

smtp=$(printf '{"host":"%s","port":"%s","from":"%s","fromDisplayName":"%s","auth":"%s","user":"%s","password":"%s","starttls":"%s","ssl":"%s"}' \
  "$HOST" "$PORT" "$FROM" "$DISPLAY" "$AUTH" "$USER" "$PASS" "$STARTTLS" "$SSL")

code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "$H" -H 'Content-Type: application/json' \
  "$B" -d "{\"smtpServer\":$smtp}")
echo "applied SMTP to realm $REALM -> HTTP $code  ($HOST:$PORT, auth=$AUTH, from=$FROM)"
[ "$code" = "204" ] || { echo "Keycloak rejected the update." >&2; exit 1; }

if [ "$TEST" = yes ]; then
  # Goes to the *admin* user's own email address, so set one on the master
  # admin account first if this reports 500.
  t=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
    "$B/testSMTPConnection" -d "$smtp")
  if [ "$t" = "204" ]; then
    echo "test email sent OK"
    [ "$HOST" = "mailpit" ] && echo "  (it is in Mailpit: http://localhost:8025)"
  else
    echo "test email FAILED -> HTTP $t" >&2
    echo "  Gmail: use a 16-char app password, port 587, STARTTLS=true, AUTH=true." >&2
    echo "  Check the container log: docker logs --tail 30 smartjourney_keycloak" >&2
    exit 1
  fi
fi
