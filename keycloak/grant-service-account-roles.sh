#!/usr/bin/env sh
# Grants the smartjourney-backend service account the realm-management roles
# the admin endpoints need, and prints its client secret.
#
# Run this once after a fresh `--import-realm` boot: a realm export contains
# the client itself but NOT its service-account user's role mappings (those
# live on a user, and the export deliberately skips users), so without this
# PATCH /admin/users/:id fails with "Keycloak rejected the request (403)".
#
#   sh keycloak/grant-service-account-roles.sh
#
# Then copy the printed secret into backend/.env as KEYCLOAK_ADMIN_CLIENT_SECRET
# and restart the API.
# No `set -e`: curl exits 23 (EPIPE) when a downstream `head -1` closes the
# pipe early, which would abort the script even though the call succeeded.
# Each step below checks its own result instead.
set -u
export MSYS_NO_PATHCONV=1   # Git Bash on Windows would mangle the URL paths

KC=${KC_URL:-http://localhost:8081}
REALM=${KC_REALM:-smartjourney}
ADMIN_USER=${KC_ADMIN_USER:-admin}
ADMIN_PASS=${KC_ADMIN_PASSWORD:-admin}
CLIENT=${KEYCLOAK_ADMIN_CLIENT_ID:-smartjourney-backend}
# view-realm is needed to read the `admin` realm role by name before mapping it.
ROLES="view-users manage-users view-realm"

token=$(curl -s -m 10 -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d client_id=admin-cli -d "username=$ADMIN_USER" -d "password=$ADMIN_PASS" -d grant_type=password |
  sed -E 's/.*"access_token":"([^"]+)".*/\1/')
[ -n "$token" ] || { echo "Could not log in to $KC as $ADMIN_USER" >&2; exit 1; }
H="Authorization: Bearer $token"
B="$KC/admin/realms/$REALM"

cid=$(curl -s -H "$H" "$B/clients?clientId=$CLIENT" | grep -oE '"id":"[^"]+"' | head -1 | cut -d'"' -f4)
[ -n "$cid" ] || { echo "Client $CLIENT not found in realm $REALM - import the realm first." >&2; exit 1; }
sa=$(curl -s -H "$H" "$B/clients/$cid/service-account-user" | grep -oE '"id":"[^"]+"' | head -1 | cut -d'"' -f4)
rm_id=$(curl -s -H "$H" "$B/clients?clientId=realm-management" | grep -oE '"id":"[^"]+"' | head -1 | cut -d'"' -f4)

for role in $ROLES; do
  rep=$(curl -s -H "$H" "$B/clients/$rm_id/roles/$role")
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$H" -H 'Content-Type: application/json' \
    "$B/users/$sa/role-mappings/clients/$rm_id" -d "[$rep]")
  echo "  $role -> HTTP $code"
done

echo
echo "granted: $(curl -s -H "$H" "$B/users/$sa/role-mappings/clients/$rm_id" | grep -oE '"name":"[^"]+"' | cut -d'"' -f4 | tr '\n' ' ')"
echo "KEYCLOAK_ADMIN_CLIENT_SECRET=$(curl -s -H "$H" "$B/clients/$cid/client-secret" | grep -oE '"value":"[^"]+"' | cut -d'"' -f4)"
