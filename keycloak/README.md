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

## Sending real password-reset / verification emails

Keycloak already sends these automatically - "forgot password" fires the mail
the moment the form is submitted. What decides whether it reaches a real inbox
is the realm's SMTP settings, and locally those point at the **mailpit**
container, which swallows everything and shows it at http://localhost:8025.
That is deliberate: no credentials needed, and a test can never email a real
person by accident.

To switch to a real provider, put its settings in `backend/.env` (`KC_SMTP_*`)
and run:

```sh
sh keycloak/apply-smtp.sh
```

It writes them into the running realm and sends a test message. The script
exists because the `KC_SMTP_*` variables in `docker-compose.yml` are only read
when a realm is **imported** - once the realm exists in `keycloak_db`, editing
`.env` alone changes nothing.

Gmail wants a 16-character **app password** (Google Account -> Security ->
2-Step Verification -> App passwords), not the account password:

```
KC_SMTP_HOST=smtp.gmail.com
KC_SMTP_PORT=587
KC_SMTP_AUTH=true
KC_SMTP_STARTTLS=true
KC_SMTP_SSL=false
KC_SMTP_USER=you@gmail.com
KC_SMTP_PASSWORD=xxxxxxxxxxxxxxxx
KC_SMTP_FROM=you@gmail.com
```

Re-run `keycloak/export-realm.sh` afterwards: the export keeps
`${KC_SMTP_*}` placeholders, so the credentials stay out of git.

## Login theme

Keycloak's sign-in, register, forgot-password, verify-email and
update-password pages use the `smartjourney` theme in
`keycloak/themes/smartjourney/login/`, styled to match the web app's sign-in
card. It builds on the built-in `keycloak.v2` theme and only adds
`resources/css/smartjourney.css` (styles), `resources/img/` (the mountain
background) and `messages/messages_en.properties` (wording such as "Welcome
Back"). There are no template copies, so it survives Keycloak upgrades.

`docker-compose.yml` mounts the folder into the container. For an existing
realm, switch it on once:

```sh
docker compose up -d keycloak    # recreate with the theme mount
sh keycloak/apply-theme.sh
```

A fresh import picks it up by itself (`"loginTheme": "smartjourney"` in
`realm-export.json`). `start-dev` doesn't cache themes, so after editing the
CSS or messages a browser refresh is enough.

## The `smartjourney-backend` service account

The admin endpoints change a user's realm role and enable/disable their
account, which only Keycloak can do - so NestJS authenticates as the
`smartjourney-backend` client (service account, no user login) and calls the
Admin REST API. It holds three realm-management roles and nothing else:
`view-users`, `manage-users` and `view-realm` (needed to look the `admin`
realm role up by name).

**A realm import does not restore this.** The client is in the export, but its
service-account user's role mappings are not - they live on a user, and the
export skips users. After a fresh import, run:

```sh
sh keycloak/grant-service-account-roles.sh
```

It grants the three roles and prints the client secret; put that in
`backend/.env` as `KEYCLOAK_ADMIN_CLIENT_SECRET` and restart the API. Without
it, `PATCH /admin/users/:id` fails with "Keycloak rejected the request (403)"
while everything else keeps working. Note the API caches its service-account
token for ~5 minutes, so a role granted just now takes effect on the next
token - restart the API if you want it immediately.

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
