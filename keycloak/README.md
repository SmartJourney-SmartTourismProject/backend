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
- **SMTP settings** (`smtpServer`) - `${KC_SMTP_*}` placeholders. Locally these
  point at the `mailpit` compose service; every mail Keycloak sends (verify
  email, reset password, test message) shows up at http://localhost:8025.

## Google sign-in links to an existing account automatically

The `google` identity provider uses the `first broker login auto-link` flow (a
copy of Keycloak's built-in one) instead of the default. In it, "Confirm link
existing account" and the account-verification options are DISABLED and
"Automatically set existing user" (`idp-auto-link`) is REQUIRED.

Why: by default, when Google returns an email that already belongs to a realm
account, Keycloak stops and demands the user prove ownership - by clicking an
emailed link or entering that account's password. In local dev the mail goes to
Mailpit, not a real inbox, so that screen is a dead end; in production it is
simply a confusing extra step for a user who just clicked "Sign in with Google".

This is safe here specifically because Google verifies the email addresses it
asserts, which is the same assumption `trustEmail: true` on the provider already
makes. **Do not reuse this flow for an identity provider that does not verify
email addresses** - there, auto-linking on a matching address would let anyone
who can claim that address take over the local account.

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
