#!/usr/bin/env sh
# Switches the running realm's login pages to the SmartJourney theme
# (keycloak/themes/smartjourney, mounted by docker-compose.yml).
#
# Why this exists: realm-export.json sets "loginTheme": "smartjourney", but
# that is only read when Keycloak *imports* the realm. Once the realm exists
# in keycloak_db the import is skipped, so the setting has to be written
# through the Admin API (or by hand: Realm settings -> Themes -> Login theme).
#
#   docker compose up -d keycloak    # recreate with the theme mount first
#   sh keycloak/apply-theme.sh
#
# Same approach as apply-smtp.sh.
set -u
export MSYS_NO_PATHCONV=1   # Git Bash on Windows would mangle the URL paths

KC=${KC_URL:-http://localhost:8081}
REALM=${KC_REALM:-smartjourney}
ADMIN_USER=${KC_ADMIN_USER:-admin}
ADMIN_PASS=${KC_ADMIN_PASSWORD:-admin}
THEME=${KC_LOGIN_THEME:-smartjourney}

token=$(curl -s -m 10 -X POST "$KC/realms/master/protocol/openid-connect/token" \
  -d client_id=admin-cli -d "username=$ADMIN_USER" -d "password=$ADMIN_PASS" -d grant_type=password |
  sed -E 's/.*"access_token":"([^"]+)".*/\1/')
[ -n "$token" ] || { echo "Could not log in to $KC as $ADMIN_USER" >&2; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  "$KC/admin/realms/$REALM" -d "{\"loginTheme\":\"$THEME\"}")
echo "set login theme of realm $REALM to '$THEME' -> HTTP $code"
[ "$code" = "204" ] || { echo "Keycloak rejected the update." >&2; exit 1; }

# A theme Keycloak can't find falls back to the default silently, so check
# that the realm's sign-in page really links the theme's stylesheet.
WEB=${WEB_URL:-http://localhost:3000}
page=$(curl -s -m 10 "$KC/realms/$REALM/protocol/openid-connect/auth?client_id=smartjourney-web&response_type=code&scope=openid&redirect_uri=$WEB/api/auth/callback/keycloak")
case "$page" in
  *"login/$THEME/css/smartjourney.css"*) found=yes ;;
  *) found=no ;;
esac
if [ "$found" = yes ]; then
  echo "theme is live - open $KC/realms/$REALM/account to see the sign-in page"
else
  echo "WARNING: the sign-in page is not using $THEME's stylesheet." >&2
  echo "  Is the container running with the theme mount? docker compose up -d keycloak" >&2
  exit 1
fi
