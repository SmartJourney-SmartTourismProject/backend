#!/usr/bin/env sh
# Re-export the smartjourney realm from the running container into
# keycloak/realm-export.json, minus users and signing keys, with the Google
# IdP secret replaced by env placeholders. Run from backend/ or keycloak/.
set -eu
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1   # Git Bash on Windows would otherwise mangle /opt/... paths

docker exec smartjourney_keycloak rm -rf /tmp/kc-export
docker exec smartjourney_keycloak /opt/keycloak/bin/kc.sh export \
  --realm smartjourney --dir /tmp/kc-export --users skip >/dev/null 2>&1 \
  || { echo "export failed - is smartjourney_keycloak running?" >&2; exit 1; }
docker cp smartjourney_keycloak:/tmp/kc-export/smartjourney-realm.json realm-export.json

PY=$(command -v python3 || command -v python || echo ../../.venv/Scripts/python.exe)
"$PY" - <<'PYEOF'
import io, json
p = "realm-export.json"
realm = json.load(io.open(p, encoding="utf-8"))
realm.get("components", {}).pop("org.keycloak.keys.KeyProvider", None)
realm.pop("users", None)
for c in realm.get("clients", []):
    if c.get("clientId") == "smartjourney-web":
        c["secret"] = "${KEYCLOAK_WEB_CLIENT_SECRET}"
    if c.get("clientId") == "smartjourney-backend":
        c["secret"] = "${KEYCLOAK_ADMIN_CLIENT_SECRET}"
realm["smtpServer"] = {
    "host": "${KC_SMTP_HOST}", "port": "${KC_SMTP_PORT}",
    "from": "${KC_SMTP_FROM}", "fromDisplayName": "${KC_SMTP_FROM_DISPLAY_NAME}",
    "auth": "${KC_SMTP_AUTH}", "user": "${KC_SMTP_USER}", "password": "${KC_SMTP_PASSWORD}",
    "starttls": "${KC_SMTP_STARTTLS}", "ssl": "${KC_SMTP_SSL}",
}
for idp in realm.get("identityProviders", []):
    if idp.get("alias") == "google":
        idp["config"]["clientId"] = "${GOOGLE_SIGNIN_CLIENT_ID}"
        idp["config"]["clientSecret"] = "${GOOGLE_SIGNIN_CLIENT_SECRET}"
with io.open(p, "w", encoding="utf-8", newline="\n") as f:
    json.dump(realm, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("wrote", p)
PYEOF
