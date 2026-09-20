# Keycloak realm config

`realm-export.json` is the `smartjourney` realm (clients, roles, password
policy, identity providers, auth flows) exported from Keycloak. `docker compose
up` runs Keycloak with `--import-realm`, so a fresh `keycloak_db` volume gets
this realm automatically. If the realm already exists in the volume the import
is skipped - it never overwrites what's in the admin console.

What is deliberately **not** in the file:

- **Users** - exported with `--users skip`. Register through the app or create
  them in the admin console. Give yourself the `admin` realm role there.
- **Signing keys** (`org.keycloak.keys.KeyProvider`) - stripped so nobody can
  forge tokens from the repo. Keycloak generates new keys on import; tokens
  issued by another machine's Keycloak won't validate here, which is fine.
- **Google client secret** - the identity provider entry reads
  `${GOOGLE_SIGNIN_CLIENT_ID}` / `${GOOGLE_SIGNIN_CLIENT_SECRET}` from the
  container environment (set in `backend/.env`, see `.env.example`).
- **`smartjourney-web` client secret** - likewise `${KEYCLOAK_WEB_CLIENT_SECRET}`.
  The same value goes in `frontend-web/.env.local` as `KEYCLOAK_CLIENT_SECRET`.

## Changing realm config

Edit in the admin console (http://localhost:8081, realm `smartjourney`), then
re-export so the change is reproducible:

```sh
./keycloak/export-realm.sh
```

Review the diff, then commit. The script strips keys and users and re-applies
the env placeholders for the Google secret.

## Wiping and re-importing from scratch

```sh
docker compose down
docker volume rm backend_keycloak_db_data
docker compose up -d
```

(The app database volume `backend_db_data` is untouched.)
