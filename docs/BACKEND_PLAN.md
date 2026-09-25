# NestJS Backend — Implementation Plan

**Repo:** `backend/` · **Stack:** NestJS + Prisma + PostgreSQL (PostGIS) in Docker
**Written:** 2026-08-30 · **Status:** plan, not yet implemented (repo currently has only `docker-compose.yml`)

Companion doc: [`AI_BACKEND_ENDPOINTS.md`](AI_BACKEND_ENDPOINTS.md) — the AI backend's API contract this service integrates against.

---

## 1. Decisions taken

Four questions were settled before planning. Recording them here with rationale so they don't get
silently re-litigated later.

| Decision | Choice | Consequence |
|---|---|---|
| **AI backend ↔ database** | Direct connection | AI backend's `db_tool.py` / `calendar_tool.py` get rewritten from the Supabase SDK to `asyncpg` against the same `DATABASE_URL`. No network hop inside trip-planning; AI backend stays independently runnable. **Two services share one database** — see §2 for who owns what. |
| **PostGIS** | Keep it | `postgis/postgis:16-3.4` image, `geography(Point,4326)` columns as SRS/SAD specify. Costs some Prisma friction — mitigated in §4.2. |
| **Endpoint scope** | Core + admin | Auth, profile, chat/trip planning, saved itineraries, explore, budget tracker, admin (listings CRUD + verification, user management). **Deferred:** subscriptions/payments, FCM + email notifications, analytics dashboard. |
| **Auth depth** | ~~JWT + Google sign-in~~ **Keycloak (decided 2026-09-20)** | Keycloak 26 in Docker (`backend/keycloak/`) owns accounts, passwords, the SRS §3.1.1 password policy, Google sign-in (as an identity provider) and realm roles `traveler`/`admin`. NestJS issues **no tokens**: it verifies Keycloak's RS256 access tokens against the realm JWKS (`src/auth/`) and mirrors each user into `app_user` on first request (`src/users/`). Web uses next-auth; mobile will use a PKCE public client. **Email flows are on** (decided 2026-09-20): realm SMTP is configured from `KC_SMTP_*` env vars — locally the `mailpit` compose service (inbox at http://localhost:8025), in production a real provider — so Keycloak's forgot-password and verify-email screens work. |

### Deliberate deviations from SRS/SAD, to note in the report

- ~~**Email verification not enforced.**~~ **Resolved 2026-09-20.** SRS §3.1.1 (verification at
  registration) and §3.1.3 (password-reset emails) are both handled by Keycloak: `verifyEmail` and
  `resetPasswordAllowed` are on in the realm, mail goes out through the realm's SMTP settings
  (`KC_SMTP_*` in `.env`; Mailpit locally). Google sign-ins skip verification (`trustEmail`).
  One nuance vs. the SRS wording: Keycloak sends a verification *link*, not a numeric *code*.
- **Subscriptions, notifications, analytics deferred.** SRS §3.1.9/§3.1.10/§3.1.14. Their tables
  are omitted from the first migration rather than created-and-unused; adding them later is
  additive, not a breaking change.
- **`Admin_Profile` kept as a separate table** (per SAD §9's ER diagram) rather than folded into a
  `User.role` column, even though `role` alone would suffice at this scope.

---

## 2. Architecture — who owns what

```
Next.js web ─┐
             ├──► NestJS (backend/) ──HTTP──► AI backend (ai-backend/)
Flutter app ─┘          │                            │
                        └──────► PostgreSQL ◄────────┘
                                (Docker, PostGIS)
```

**Both services connect to the same database.** That is a deliberate choice (decision 1), so the
ownership split needs to be explicit:

| Table | NestJS | AI backend |
|---|---|---|
| `user`, `traveler_profile`, `admin_profile` | **owns** (read/write) | reads `traveler_profile` only |
| `district`, `category` | reads (+ admin seeding) | reads |
| `travel_listing`, `listing_image` | **owns** admin CRUD + verification | reads verified rows; **writes** unverified rows from the Overpass ingest job |
| `local_event` | **owns** admin CRUD + verification | reads verified rows; **writes** unverified rows from the events ingest job |
| `itinerary`, `itinerary_day`, `itinerary_item` | **owns** (sole writer) | never touches |
| `expense` | **owns** | never touches |
| `chat_session`, `chat_message` | **owns** | never touches |
| `google_oauth_tokens` | never touches | **owns** (Calendar consent flow) |
| `activity_log` | **owns** | never touches |

The only genuinely shared-write tables are `travel_listing` and `local_event`: the AI backend's
scheduled ingest jobs insert rows with `is_verified = false`, and NestJS's admin endpoints flip
them to `true`. That's the designed workflow (BUILD_PLAN Phase 3 step 5), not a conflict — but it
does mean **neither service may assume it is the only writer**. Use `external_ref` for idempotent
upserts on the ingest side.

### Two separate Google OAuth flows — do not conflate

1. **Google sign-in (authentication)** — *Keycloak owns this* (identity provider `google` in realm
   `smartjourney`; the web app sends `kc_idp_hint=google`). NestJS never talks to Google for sign-in.
2. **Google Calendar consent (authorization)** — *AI backend already owns this.* User grants
   free/busy read access so trip dates can be suggested. Endpoints
   `GET /auth/google/login`, `GET /auth/google/callback` **on the AI backend**.

They use different scopes and store different things:

| | Sign-in (NestJS) | Calendar consent (AI backend) |
|---|---|---|
| Purpose | Prove identity → issue JWT | Read free/busy to suggest trip dates |
| Scope | `openid email profile` | `https://www.googleapis.com/auth/calendar.freebusy` |
| Stores | `user.google_id` (no tokens kept) | access + refresh token in `google_oauth_tokens` |
| Redirect URI | `http://localhost:3000/api/v1/auth/google/callback` | `http://localhost:8000/auth/google/callback` |
| Env vars | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `GOOGLE_CALENDAR_CLIENT_ID` / `GOOGLE_CALENDAR_CLIENT_SECRET` |
| Triggered when | User clicks "Sign in with Google" | User clicks "Connect my calendar" |

**Concrete steps to keep them separate:**

1. In the Google Cloud console, register **both** redirect URIs on the project's OAuth client (or
   create two clients — cleaner, and lets you revoke calendar access without breaking login).
2. Keep the env var names distinct exactly as above. The AI backend already uses the
   `GOOGLE_CALENDAR_*` names — do **not** reuse them in NestJS.
3. NestJS **must not re-implement** calendar consent. To connect a calendar, it links/redirects
   the user to the AI backend's `GET /auth/google/login?user_id=<uuid>`, which already handles the
   flow with a signed, 10-minute-expiring `state` token.
4. A user signing in with Google has **not** granted calendar access — those are independent
   grants. Track them separately in the UI (`user.google_id` present ≠ calendar connected; check
   for a `google_oauth_tokens` row for that).

---

## 3. Infrastructure

### 3.1 `docker-compose.yml` — needs three fixes

Current file uses `postgres:16-alpine`, which **has no PostGIS** — every `geography(Point,4326)`
column will fail to create. Replace with:

```yaml
services:
  db:
    image: postgis/postgis:16-3.4          # was postgres:16-alpine — PostGIS required
    container_name: local_postgres
    environment:
      POSTGRES_USER: ${POSTGRES_USER}       # was hardcoded
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "5432:5432"
    volumes:
      - db_data:/var/lib/postgresql/data
    healthcheck:                            # so the API doesn't start before the DB is ready
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: always

volumes:
  db_data:
```

Move credentials to a gitignored `.env` (currently `shaluka` / `1234` are committed). Fine for
local, but they must not survive into the AWS deployment — flag now so it isn't forgotten.

Add a `backend/Dockerfile` + an `api` service to compose later, once the app exists; not needed
for local dev where NestJS runs on the host against the containerised DB.

### 3.2 Environment variables

```
DATABASE_URL=postgresql://user:pass@localhost:5432/smartjourney?schema=public
KEYCLOAK_ISSUER=http://localhost:8081/realms/smartjourney   # tokens are verified against <issuer>/protocol/openid-connect/certs
KEYCLOAK_AUDIENCE=smartjourney-api                          # added to tokens by the audience mapper on the smartjourney-web client
KEYCLOAK_DB_USER / KEYCLOAK_DB_PASSWORD / KEYCLOAK_DB_NAME   # Keycloak's own Postgres (docker-compose)
GOOGLE_SIGNIN_CLIENT_ID / GOOGLE_SIGNIN_CLIENT_SECRET         # Keycloak's Google identity provider (distinct from the AI backend's calendar client)
KEYCLOAK_WEB_CLIENT_SECRET                                   # secret of the smartjourney-web client; same value as frontend-web's KEYCLOAK_CLIENT_SECRET
AI_BACKEND_URL=http://localhost:8000
AI_BACKEND_TIMEOUT_MS=120000    # trip-plan chains several APIs + 1-2 Gemini calls
```

The AI backend keeps its own `.env`; only `DATABASE_URL` needs to match.

---

## 4. Database

### 4.1 Tables in scope

Derived from SAD §9's ER diagram and BUILD_PLAN §3, trimmed to the chosen scope.

**Identity:** `app_user` (with `keycloak_id`; no `password_hash`/`google_id` — migration 0007), `traveler_profile`, `admin_profile`. ~~`refresh_token`~~ dropped: Keycloak issues and rotates refresh tokens.
**Reference:** `district`, `category`
**Content:** `travel_listing`, `listing_image`, `local_event`
**Planning:** `chat_session`, `chat_message`, `itinerary`, `itinerary_day`, `itinerary_item`
**Budget:** `expense`
**AI backend:** `google_oauth_tokens`
**Audit:** `activity_log`

**Deferred (not in the first migration):** `subscription_plan`, `subscription`,
`notification_settings`, `notification`, `device`, `system_analytics`, `pickme_zone`.
`pickme_zone` is deferred because `check_pickme_coverage()` in the AI backend is still a stub that
returns `True` — no point creating a table nothing queries. `travel_listing.pickme_available`
stays as a plain boolean.

Key columns worth calling out now:

- `travel_listing.is_verified` (bool, default `false`, **indexed**) — the approval gate. Every
  public read filters on it.
- `travel_listing.external_ref` — OSM/source id, for idempotent re-sync upserts.
- `itinerary_item` needs `latitude`/`longitude` even for custom activities, so a saved trip can be
  re-plotted on the map without another AI call.
- `chat_session.ai_session_id` — the `session_id` the AI backend returns. This is what makes
  multi-turn refinement work across page reloads.
- Index every foreign key, plus `district_id` and `is_verified` (BUILD_PLAN §3 calls these out —
  the recommendation queries filter on them constantly).

### 4.2 Prisma + PostGIS — the friction and the fix

Prisma has no native `geography` type. Two things are needed:

**a) Enable the extension** in `schema.prisma`:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  extensions = [postgis]
}
```

**b) Declare the column as unsupported, and expose readable coordinates.** A field typed
`Unsupported(...)` cannot be selected through the normal Prisma client at all — so reading a
listing's coordinates would otherwise require `$queryRaw` everywhere, which is miserable.

**Decided approach — Postgres generated columns**, added via raw SQL in the migration:

```sql
ALTER TABLE travel_listing
  ADD COLUMN latitude  double precision
    GENERATED ALWAYS AS (ST_Y(location::geometry)) STORED,
  ADD COLUMN longitude double precision
    GENERATED ALWAYS AS (ST_X(location::geometry)) STORED;
```

```prisma
model TravelListing {
  id        String                                    @id @default(uuid())
  location  Unsupported("geography(Point, 4326)")?
  latitude  Float?                                    // generated — read-only
  longitude Float?                                    // generated — read-only
  // ...
}
```

This gives one source of truth (`location`) with coordinates readable through the ordinary Prisma
client, and keeps PostGIS available for real spatial queries via `$queryRaw` when needed. It also
lets the AI backend `SELECT latitude, longitude` directly and **delete its EWKB hex-decoding code**
(`_parse_ewkb_point` in `db_tool.py`).

**✅ Verified on 2026-08-30** against the real `postgis/postgis:16-3.4` container
(PostGIS `3.4 USE_GEOS=1 USE_PROJ=1 USE_STATS=1`). Inserting
`ST_GeogFromText('POINT(80.6337 7.2906)')` and selecting the generated columns returned
`latitude = 7.2906`, `longitude = 80.6337`. The `IMMUTABLE` requirement holds for
`ST_Y(geography::geometry)`. No fallback needed — build on this.

Prisma will also try to "fix" the `Unsupported` columns on every `migrate dev` — expect to
hand-edit generated migration SQL occasionally. Budget a little time for this; it's the known cost
of decision 2.

---

## 5. API endpoints

Conventions: base path `/api/v1`. 🔓 public · 🔒 authenticated · 🛡️ admin only.
All list endpoints paginate (`?page=`, `?limit=`).

### 5.1 Auth — none in NestJS (Keycloak hosts it)

**There are no `/auth/*` endpoints in NestJS.** Register, login, refresh, logout, Google sign-in,
forgot-password and change-password are all Keycloak screens/endpoints on realm `smartjourney`
(`http://localhost:8081/realms/smartjourney`). Clients obtain an access token from Keycloak
(web: next-auth, confidential client `smartjourney-web`; mobile: PKCE public client, to be added)
and send it as `Authorization: Bearer <token>` on every NestJS request.

What NestJS does (`src/auth/`, `src/users/`):

| Piece | Behaviour |
|---|---|
| `JwtStrategy` | RS256 signature against `KEYCLOAK_ISSUER/protocol/openid-connect/certs` (cached JWKS), plus `iss` and `aud = KEYCLOAK_AUDIENCE` checks. No per-request call to Keycloak. |
| `JwtAuthGuard` | **Global.** Every route requires a token unless marked `@Public()` (health, explore reads). Fails closed. |
| `RolesGuard` | **Global.** Enforces `@Roles('admin')` from the token's `realm_access.roles`. 403 otherwise. |
| `UsersService.ensureFromToken` | JIT provisioning: on each authenticated request, upsert `app_user` by `keycloak_id` (= token `sub`), create an empty `traveler_profile` on first sign-in, mirror `email`/`name`/`role`. Result is `request.user` (`@CurrentUser()` / `@CurrentUser('id')`). Short in-memory cache so it isn't a write per call. |

Password rule per SRS §3.1.1 (8–12 chars, ≥1 upper, ≥1 lower, ≥1 digit, ≥1 special) is enforced by
the realm's **password policy** in Keycloak, so web and mobile inherit it automatically. `/auth/me`
is replaced by `GET /users/me` (§5.2).

Realm config is reproducible: `backend/keycloak/realm-export.json` is imported on first boot
(`start-dev --import-realm`); re-export with `keycloak/export-realm.sh` after changing anything in
the admin console. Secrets in it are `${ENV}` placeholders resolved from `backend/.env`.

### 5.2 Users & profile — `/users`

| | Method | Path | Purpose |
|---|---|---|---|
| 🔒 | GET | `/users/me` | Account details |
| 🔒 | PATCH | `/users/me` | Update name, phone, `location_enabled` |
| 🔒 | PATCH | `/users/me/password` | Change password (requires current password) |
| 🔒 | GET | `/users/me/preferences` | Travel profile — interests, style, budget, currency, language |
| 🔒 | PATCH | `/users/me/preferences` | Update it |
| 🔒 | DELETE | `/users/me` | Soft-delete / deactivate |

`/users/me/preferences` is what makes the AI backend's profile-based defaulting actually work —
it writes the `traveler_profile` columns (`travel_interests`, `travel_style`, `default_budget`)
that `db_tool.get_user_profile()` reads. **Until a profile row has real values, SRS §12's
"Plan a trip to Kandy" scripted case cannot pass end-to-end** (currently a known open item in
`ai-backend/docs/NEXT_STEPS.md`).

### 5.3 Chat & trip planning — `/chat`

The chat *is* the planning interface (SRS §3.9.1.4). This is the core AI integration.

| | Method | Path | Purpose |
|---|---|---|---|
| 🔒 | POST | `/chat/sessions` | Start a new planning conversation |
| 🔒 | GET | `/chat/sessions` | List recent chats (sidebar) |
| 🔒 | GET | `/chat/sessions/:id` | Full message history |
| 🔒 | POST | `/chat/sessions/:id/messages` | **Send a message → AI backend → persist + return plan** |
| 🔒 | PATCH | `/chat/sessions/:id` | Rename |
| 🔒 | DELETE | `/chat/sessions/:id` | Delete |

`POST /chat/sessions/:id/messages` is the important one:

1. Persist the user's message to `chat_message`.
2. `POST` to the AI backend's `/trip-plan` with `{message, user_id, client_gps?, session_id: <chat_session.ai_session_id>}`.
3. Store the returned `session_id` on `chat_session.ai_session_id` (first turn only).
4. Persist the assistant's `final_response` as a `chat_message`.
5. Return the AI's full response (itinerary, weather, disaster, budget_notes) to the client.

Treat `errors` as advisory, not fatal — see `AI_BACKEND_ENDPOINTS.md`. Use a long HTTP timeout
(`AI_BACKEND_TIMEOUT_MS`); typical latency is 5–20s.

### 5.4 Saved itineraries — `/trips`

| | Method | Path | Purpose |
|---|---|---|---|
| 🔒 | POST | `/trips` | Save a generated plan → `itinerary` + `itinerary_day` + `itinerary_item` |
| 🔒 | GET | `/trips` | List — `?status=upcoming\|draft\|past` (the mockup's three tabs) |
| 🔒 | GET | `/trips/:id` | Full itinerary with days and items |
| 🔒 | PATCH | `/trips/:id` | Rename, change status/dates |
| 🔒 | DELETE | `/trips/:id` | Delete |

Ownership check on every route — a user may only touch their own itineraries.

### 5.5 Explore — `/districts`, `/categories`, `/listings`, `/events`

| | Method | Path | Purpose |
|---|---|---|---|
| 🔓 | GET | `/districts` | All 25 districts (filter dropdowns) |
| 🔓 | GET | `/categories` | hotel / restaurant / attraction |
| 🔓 | GET | `/listings` | Search — `?district=&category=&q=&minRating=&page=` |
| 🔓 | GET | `/listings/:id` | Detail + images |
| 🔓 | GET | `/events` | `?district=&from=&to=` |
| 🔓 | GET | `/events/:id` | Detail |

Public per SRS §3.1.7 ("any user can explore"). **Every public read must filter
`is_verified = true`** — that filter is the entire point of the approval workflow.

### 5.6 Budget tracker — `/trips/:tripId/expenses`, `/budget`

| | Method | Path | Purpose |
|---|---|---|---|
| 🔒 | GET | `/trips/:tripId/expenses` | Recent expenses table |
| 🔒 | POST | `/trips/:tripId/expenses` | Add expense (date, description, category, amount) |
| 🔒 | PATCH | `/expenses/:id` | Edit |
| 🔒 | DELETE | `/expenses/:id` | Delete |
| 🔒 | GET | `/trips/:tripId/budget` | Summary: total, spent, remaining, daily average, by-category |
| 🔒 | GET | `/budget/summary` | Across all trips — the "Budgets by trip" panel |

Compute summaries in SQL (`GROUP BY category`), not by loading every row into JS.

### 5.7 Admin — `/admin`

All 🛡️ — `RolesGuard` on the whole controller.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/stats` | Dashboard cards: registered travelers, itineraries generated, pending verifications |
| GET | `/admin/listings` | All listings **including unverified** — `?isVerified=&district=&category=` |
| POST | `/admin/listings` | Create |
| PATCH | `/admin/listings/:id` | Edit |
| DELETE | `/admin/listings/:id` | Delete |
| POST | `/admin/listings/:id/verify` | Approve → `is_verified = true` |
| POST | `/admin/listings/:id/reject` | Reject |
| GET | `/admin/events` | Same shape as listings |
| POST/PATCH/DELETE | `/admin/events[/:id]` | CRUD |
| POST | `/admin/events/:id/verify` · `/reject` | Approval |
| GET | `/admin/users` | List/search — `?q=&role=&status=` |
| GET | `/admin/users/:id` | Detail (**never** return `password_hash`) |
| PATCH | `/admin/users/:id` | Change role / activate / deactivate |
| GET | `/admin/users/:id/activity` | `activity_log` entries (SRS §3.1.13) |

`/admin/stats` omits "subscription revenue" from the SRS mockup, since subscriptions are out of
scope this round.

**Built 2026-09-25** (`src/admin/`), with these decisions worth recording:

- **No `status` column.** pending / approved / rejected are derived from the
  `(is_verified, is_active)` pair both content tables already carry - rejected is
  `is_active = false`, added for `local_event` by migration `0008`. The AI backend's ingest jobs
  re-upsert these rows and never write those two columns, so an admin's decision survives the next
  sync. Without a way to mark "reviewed and refused", a rejected row would reappear in the queue
  forever.
- **Public reads now filter `is_active` too** (`explore.service.ts`), not just `is_verified` -
  otherwise deactivating an approved listing would leave it visible to travellers.
- **Reject over delete.** `DELETE` exists but is for genuinely bad rows (duplicates, test data); an
  ingest job will simply re-create anything deleted on its next run.
- **User role/status changes go to Keycloak first** (`KeycloakAdminService`, service account
  `smartjourney-backend`) and are then mirrored into `app_user`. Writing only to `app_user` would be
  undone within minutes by the JIT sync, which mirrors the token. A user's existing token keeps its
  old roles until it refreshes (≤5 min) - inherent to stateless JWT auth.
- **Self-protection:** an admin cannot remove their own admin role or deactivate their own account.
- Every admin action writes an `activity_log` row (SRS §3.1.13), and an audit-write failure is
  logged rather than failing the action itself.

### 5.8 Health

| | Method | Path |
|---|---|---|
| 🔓 | GET | `/health` — liveness + DB connectivity + AI-backend reachability |

---

## 6. AI backend migration work (Supabase SDK → asyncpg)

Separate repo, but part of this plan since decision 1 requires it. Three files:

| File | Change |
|---|---|
| `app/tools/db_tool.py` | Replace `acreate_client` / `.table().select()` with `asyncpg` queries against `DATABASE_URL`. Keep every function signature identical — nothing else in the AI backend changes. Delete `_parse_ewkb_point` and select the generated `latitude`/`longitude` columns instead (§4.2). |
| `app/tools/calendar_tool.py` | Same, for `google_oauth_tokens`. |
| `app/data/supabase_writer.py` | Rename → `postgres_writer.py`; rewrite inserts as `asyncpg` upserts on `external_ref`. Keeps `ST_GeomFromText('POINT(lon lat)', 4326)` for writes. |

Preserve the existing **mock-data / local-file fallbacks** — they're what let the AI backend and
its 110-test suite run with no database at all. The tests already mock at the client boundary, so
they'll need their fakes swapped from a Supabase-shaped client to an asyncpg-shaped one.

Add `asyncpg` to `requirements.txt`; `supabase` can be dropped. `SUPABASE_URL`/`SUPABASE_KEY`
disappear from settings in favour of the existing `DATABASE_URL`.

`ai-backend/docs/db_migrations.sql` becomes obsolete once the NestJS migration owns the schema —
its two items (`google_oauth_tokens`, and `traveler_profile.default_budget` / `home_location`)
are folded into §4.1 above. Delete it after Phase 0.

---

## 7. Build order

Phases are sequential unless marked parallel. Each ends in something verifiable.

**Phase 0 — Infrastructure** ✅ done 2026-09-03

1. `docker-compose.yml` (§3.1): swap to `postgis/postgis:16-3.4`, add the healthcheck, move
   `shaluka`/`1234` into a gitignored `.env` with `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`.
2. `docker compose up -d` → confirm the container reports healthy.
   > **Gotcha hit on first run:** Postgres only runs its init (creating `POSTGRES_USER`/`POSTGRES_DB`)
   > on an **empty** data directory. Because `db_data` already existed from the earlier
   > `postgres:16-alpine` run, the new credentials were ignored and login failed with
   > `role "smartjourney" does not exist`. Fix without destroying anything: create the role inside
   > the existing cluster —
   > `CREATE ROLE smartjourney WITH LOGIN PASSWORD '…' SUPERUSER;`
   > `ALTER DATABASE smartjourney OWNER TO smartjourney;`
   > (Or `docker compose down -v` to wipe and re-init, if the volume is known to be empty.)

3. **Gate: prove the generated-column approach (§4.2) on the real image before anything depends
   on it.** ✅ **Done 2026-08-30 — passed** (see §4.2). Kept here for re-running after any image
   upgrade:
   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE TABLE _probe (
     id serial PRIMARY KEY,
     location geography(Point,4326),
     latitude  double precision GENERATED ALWAYS AS (ST_Y(location::geometry)) STORED,
     longitude double precision GENERATED ALWAYS AS (ST_X(location::geometry)) STORED
   );
   INSERT INTO _probe (location) VALUES (ST_GeogFromText('POINT(80.6337 7.2906)'));
   SELECT latitude, longitude FROM _probe;   -- expect 7.2906, 80.6337
   DROP TABLE _probe;
   ```
   If Postgres rejects the generated expression as non-`IMMUTABLE`, fall back to plain
   `latitude`/`longitude` columns written alongside `location` in application code (§4.2) — and
   update this plan to say so.
4. Scaffold NestJS (`nest new`), `prisma init`, wire `DATABASE_URL`, enable the
   `postgresqlExtensions` preview feature. ✅ **Done 2026-09-03** — see below.

*Done when:* the container is healthy, the probe above returns the right coordinates, and
~~`prisma migrate dev` runs cleanly against it~~ **`prisma db pull` introspects the live schema
cleanly** — updated per `docs/BACKEND_ALIGNMENT.md §1` (decision D13): Prisma introspects this
schema, it does not own/migrate it, so `migrate dev` is never run against these tables at all.

**✅ Step 4 done 2026-09-03.** `nest new` (NestJS 12, TypeScript, npm) scaffolded into this directory
without disturbing `db/`, `docs/`, `.env`, or `docker-compose.yml`. Prisma pinned to **7.10.0**
(the latest *stable* release — `npm install prisma@latest` resolved to `8.0.0-rc.12`, a release
candidate, which was deliberately avoided). `prisma init` + `schema.prisma` edited exactly per §4.2
(`previewFeatures = ["postgresqlExtensions"]`, `extensions = [postgis]`). `npx prisma db pull`
against the real running `smartjourney_postgres` container introspected **27 models** cleanly, with
exactly the `Unsupported("geography"/"geometry")` warnings §4.2 predicted and no others —
`travel_listing.latitude`/`longitude` came through as ordinary readable `Float?` fields via the
generated `STORED` columns, confirming that design decision against the real schema, not just on
paper.

**One real friction point §4.2 didn't anticipate** (it was written against an older Prisma): Prisma 7
requires an explicit driver adapter — `new PrismaClient()` with no arguments throws
`PrismaClientInitializationError` at runtime. Fixed by installing `@prisma/adapter-pg` + `pg` and
wiring a `PrismaService`/`PrismaModule` (`src/prisma/`) that constructs the client with
`new PrismaPg({ connectionString: process.env.DATABASE_URL })`. Every future feature module injects
`PrismaService`; nothing should construct `PrismaClient` directly.

**Live-verified, not just "builds":** `npm run build` succeeds; `node dist/main.js` starts cleanly and
logs `PrismaService: Connected to Postgres via Prisma.`; a live query returned real counts matching
the AI backend's own data — 25 districts, 6,572 listings, same Kandy district UUID seen throughout
the AI backend's own testing. Same database, both sides reading it correctly.

**Phase 1 — Schema + seed** ✅ superseded by real data, not manual seeding
The schema (§4.1) and its data both already exist, via a different path than originally planned: the
AI backend's own Phase 1–3 (`ai-backend/docs/master_plan/PROJECT_MASTER_PLAN.md`) applied the full
migration set (`backend/db/migrations/0001_core.sql`/`0002_identity_planning.sql`, run by
`backend/db/migrate.py`) and ingested **real** listings via OSM/Booking/Ticketmaster connectors — 25
real districts, 6,572 real listings across all of them, not 15–20 mock rows across 4 cities. No
manual seed script is needed or should be written; `prisma db pull` (Phase 0, above) is what makes
this real data visible to NestJS.
*Done when:* ~~schema matches SAD §9 for in-scope tables; seed runs idempotently~~ — verified instead
via Phase 0's live query (25 districts, 6,572 listings returned through the generated Prisma client).

**Phase 2 — Auth** ✅ done 2026-09-20 (Keycloak, not bcrypt/JWT — see §1, §5.1)
Keycloak realm + Google IdP + password policy (`backend/keycloak/`) · web login via next-auth · NestJS
`AuthModule` (JWKS validation, global `JwtAuthGuard` + `RolesGuard`, `@Public()`, `@Roles()`,
`@CurrentUser()`) · migration `0007_keycloak_identity.sql` · JIT provisioning · `DEMO_USER_ID` shim and
`db/seeds/001_demo_user.sql` removed — chat/trips/budget now scope every query to `request.user.id`.
*Verified:* no/invalid token → 401 on protected routes, public routes open; real Keycloak token →
`app_user` row provisioned and data written under it. Still to do here: `GET/PATCH /users/me`
(§5.2), and the mobile PKCE client.

**Phase 3 — Explore (§5.5)** — *can run parallel with Phase 4*
Read-only listing/event/district endpoints with filtering and pagination. Straightforward, and gives the web frontend something real to build against early.

**Phase 4 — Chat + trip planning (§5.3, §5.4)** — **the critical path**
The AI backend proxy, chat persistence, itinerary saving. This is the one that proves the whole architecture end-to-end.
*Done when:* a message posted to `/chat/sessions/:id/messages` returns a real itinerary, a follow-up refines it via the stored `ai_session_id`, and `POST /trips` persists it.

**Phase 5 — AI backend DB migration (§6)** — *parallel, needs only Phase 1*
Independent of Phases 2–4; whoever is free can take it.

**Phase 6 — Budget tracker (§5.6)**

**Phase 7 — Admin (§5.7)**

**→ Start the Next.js frontend once Phase 4 lands.** At that point auth, explore, and chat all
exist, which is enough to build every main screen against a real API. Flutter last — it reuses
whatever the web app proves out.

---

## 8. Open items and risks

| Item | Note |
|---|---|
| **PostGIS generated columns** | Verify in Phase 0 (§4.2). Fallback documented. Highest-uncertainty technical item in this plan. |
| **Prisma vs. `Unsupported` migrations** | Expect occasional hand-editing of generated migration SQL. Known cost of keeping PostGIS. |
| **Currency** | AI backend's `estimated_cost` has no currency and assumes USD; SRS mockups show LKR. Decide where conversion/labelling lives — recommend storing a `currency` column on `itinerary`/`expense` and deciding display in the frontend. Not resolved. |
| **Two writers on `travel_listing`** | Ingest jobs (AI backend) and admin CRUD (NestJS). Use `external_ref` upserts; don't assume sole ownership. |
| **AI session state** | The AI backend stores multi-turn state in a **local JSON file**, not the DB — so it won't survive a container rebuild or work across multiple AI-backend instances. Either run a single instance, or move that state into `chat_session` as a later improvement. |
| **Committed DB credentials** | `shaluka`/`1234` in `docker-compose.yml`. Move to gitignored `.env` in Phase 0; never reuse in deployment. |
| **AI backend is unauthenticated** | By design (internal service). Must stay on a private network — never expose it publicly. NestJS is the only permitted caller. |
| **Email-dependent flows** | ~~Stubbed.~~ Live via Keycloak + realm SMTP. Production still needs real `KC_SMTP_*` credentials (Gmail app password / SES) — Mailpit is dev-only. |
