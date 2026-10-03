# SmartJourney Backend (NestJS API)

The API for **SmartJourney**, an AI trip planner for Sri Lanka. The web frontend talks **only** to this service. This service is the trust boundary: it checks Keycloak tokens and roles, owns all user data, and forwards trip-planning requests to the AI backend (`ai-backend`, FastAPI).

```
Browser → frontend-web (Next.js, :3000) → backend (NestJS, :3001) → ai-backend (FastAPI, :8000)
                  └──────── Keycloak (:8081) ◄──┘        └──► PostgreSQL + PostGIS (:5432), Redis (:6379)
```

## Modules (`src/`)

| Module | What it does |
|---|---|
| `auth` | Keycloak JWT validation, `@Public()` / `@Roles('admin')` guards, just-in-time user provisioning |
| `users` | Profile, avatar, phone, travel preferences, location setting |
| `chat` | Chat sessions and messages; calls the AI backend's `/trip-plan` (sends `X-Internal-Token`) |
| `trips` | Saved itineraries, trip dates, upcoming/past |
| `budget` | Per-trip budget summary, expenses, spend by category |
| `explore` | Districts, categories, tags, listings, events (public read) |
| `admin` | Listing/event moderation, entry-fee review, users and roles (through the Keycloak admin API), analytics, AI model and API key settings |
| `health` | `GET /health` for the deploy health check |

Every query is scoped by the signed-in user's id. Another user's resource returns **404**, so it can't be told apart from one that doesn't exist.

## Folder guide

| Path | Contents |
|---|---|
| `db/migrations/*.sql` | **The database schema.** Plain SQL, applied in order by `db/migrate.py` (not Prisma Migrate) |
| `prisma/schema.prisma` | Prisma client model, introspected from the SQL schema |
| `keycloak/` | `realm-export.json` (realm, clients, roles, password policy, no users) and helper scripts; see `keycloak/README.md` |
| `docker-compose.yml` | Local infrastructure: Postgres/PostGIS, Redis, Keycloak (+ its DB), Mailpit |
| `deploy/` | Production on AWS EC2: `compose.prod.yml`, `Caddyfile`, `deploy.sh`, `release.sh`, `backup.sh`, `restore-data.sh`, Dockerfiles, `MANUAL_SETUP.md` |
| `Dockerfile` | Production image of this API |
| `.github/workflows/ci.yml` | CI (lint, unit and e2e tests), then build images to GHCR and deploy |
| `test/` | e2e suites: `app`, `access-control` (ownership and 404s), `security` |

## Run locally

Full instructions (all four services, env files, data, accounts) are in the **Local Setup Guide**: `Documentation/User Manual/3_Local_Setup_Guide.pdf`. The short version for this service:

```powershell
docker compose up -d                        # infrastructure; wait ~30 s for Keycloak
copy .env.example .env                      # then fill in secrets
..\ai-backend\.venv\Scripts\python.exe db\migrate.py   # apply SQL migrations (needs psycopg; the ai-backend venv has it)
npm install
npx prisma generate                         # required on a fresh clone
npm start                                   # http://localhost:3001
```

## Build and test

```powershell
npm run build          # compile to dist/
npm run lint           # oxlint
npm test               # unit tests (vitest): 146 tests, 2026-10-03
npm run test:e2e       # e2e suites in test/ (need the docker infrastructure)
npm run test:security  # security e2e only
npm run test:access    # access-control e2e only
npm run test:cov       # coverage report → coverage/
```

## Production

Deployed as a Docker image (GHCR) on one AWS EC2 instance behind Caddy (HTTPS), together with the AI backend, Keycloak, Postgres and Redis. The frontend runs on Vercel at https://aismartjourney.vercel.app. Step-by-step server setup: [`deploy/MANUAL_SETUP.md`](deploy/MANUAL_SETUP.md).
