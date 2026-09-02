# NestJS Backend — Alignment with the AI Master Plan

**Written:** 2026-09-02
**Reads with:** [`BACKEND_PLAN.md`](BACKEND_PLAN.md) (still the plan of record for NestJS itself) and
[`../../ai-backend/docs/master_plan/PROJECT_MASTER_PLAN.md`](../../ai-backend/docs/master_plan/PROJECT_MASTER_PLAN.md).

This file records **only what changes** in `BACKEND_PLAN.md` because of the AI-backend rework. Everything
not mentioned here stands as written.

---

## 1. Schema ownership reverses — Prisma introspects, it does not own

`BACKEND_PLAN.md` §4 assumes Prisma migrations define the schema. That blocks the AI backend, which
needs tables **now** and cannot wait for `nest new` + `prisma init` + auth.

**New arrangement (decision D13):**

- Canonical DDL: `backend/db/migrations/*.sql`, applied by `backend/db/migrate.py`.
  Full schema in [`DATA_PLATFORM.md §2`](../../ai-backend/docs/master_plan/DATA_PLATFORM.md).
- `0001_core.sql` — districts (with OSM boundary polygons), categories, tag vocabulary, listings,
  events, cost reference, geo/travel-time caches, `ai_session`, OAuth tokens, pipeline audit.
- `0002_identity_planning.sql` — `app_user`, `traveler_profile`, `admin_profile`, `refresh_token`,
  `chat_session`, `chat_message`, `itinerary`, `itinerary_day`, `itinerary_item`, `expense`,
  `activity_log`. NestJS's domain, created by the same runner.
- NestJS then runs **`prisma db pull`** to generate `schema.prisma` from the live database, and uses
  Prisma purely as a client.

**Why this is better here, not just faster:** `BACKEND_PLAN.md` §8 lists "Prisma vs. `Unsupported`
migrations" as its top risk — hand-editing generated SQL every time a `geography` column moves. Writing
the SQL directly removes that risk entirely rather than mitigating it. The generated
`latitude`/`longitude` columns (already verified against `postgis/postgis:16-3.4` on 2026-08-30) work
identically either way.

**Cost, stated honestly:** you lose `prisma migrate dev`'s change-tracking on future schema edits. The
`schema_migration` table + checksum guard covers the same ground with less magic, and every migration is
reviewable SQL.

---

## 2. New tables NestJS should know about

Beyond `BACKEND_PLAN.md` §4.1:

| Table | Owner | Why NestJS cares |
|---|---|---|
| `ai_session` | AI backend | Replaces the local JSON file flagged in §8's risk table. `chat_session.ai_session_id` now points at a **real row**, so multi-turn survives container rebuilds. NestJS reads it for debugging only; never writes. |
| `geo_resolution`, `travel_time` | AI backend | Caches. NestJS ignores them. |
| `data_source`, `data_source_run` | AI backend | **Surface these in the admin panel.** "Last successful sync per source" is the single most useful ops view you can give an admin, and it's one query. |
| `tag_vocabulary`, `tag_mapping` | AI ingest + admin | The canonical interest tags. `/users/me/preferences` should offer `travel_interests` **from this table**, not a free-text field — otherwise a user's saved interests never match a listing's tags and preference scoring silently degrades to the neutral 0.5 prior. |
| `cost_reference` | admin | Admin-editable cost table. Worth a small CRUD screen; it directly drives every budget estimate. |
| `listing_image` | shared | Now carries `attribution` (OSM/Wikimedia licence line). **Display it** — it's a licence condition, not a nicety. |

`travel_listing` and `local_event` gain: `tags text[]`, `price_level`, `price_per_night`, `currency`,
`rating_count`, `is_active`, `last_seen_at`, and a `UNIQUE (source, external_ref)` constraint. The
admin verify/reject flow in §5.7 is unchanged and is now more important, since the AI reads only
`is_verified = true`.

---

## 3. `/trip-plan` response changes

`AI_BACKEND_ENDPOINTS.md` needs updating after AI Phase 7. New/changed fields:

| Field | Change |
|---|---|
| `currency` | **New.** Always `"LKR"`. `estimated_cost` is LKR, not implicit USD — this closes the currency open item in both plans (D14). |
| `plan_source` | **New.** `"llm"` or `"fallback"`. `"fallback"` means the deterministic planner produced it (Gemini failed or its output failed validation twice). The plan is fully valid; the prose is plainer. **Do not treat it as an error.** |
| `itinerary[].items[].listing_id` | **New.** The DB row each stop came from. Use it when persisting `itinerary_item` instead of matching on name. |
| `itinerary[].items[].est_cost` + `cost_basis` | **New.** Per-item cost and whether it's `exact` / `reference` / `national`. Surface `reference`/`national` as approximate in the UI. |
| `data_freshness` | **New.** `{listings_synced_at, events_synced_at}`. Worth showing on the explore screens. |
| `completed_steps` | **Replaced** by `trace` (ReAct steps), still debug-gated. |
| `errors` | Unchanged semantics — still advisory. The interpretation table in `AI_BACKEND_ENDPOINTS.md` stays correct. |

**One behaviour change to plan for:** if Postgres is down, `/trip-plan` now returns **503**, where it
previously returned a plausible-looking plan built from mock data. Handle 503 as a retryable outage in
the chat proxy and show a real error to the user. This is strictly better — the old behaviour meant a
database outage was invisible and the user was shown fabricated places.

---

## 4. Preferences must use the canonical tag vocabulary

`BACKEND_PLAN.md` §5.2 correctly identifies `/users/me/preferences` as what makes profile-based
defaulting work. One addition: `travel_interests` must be constrained to `tag_vocabulary.tag` values
(offer them from `GET /tags`, a new public endpoint). Free-text interests like `"chilling by the sea"`
will never intersect a listing's `tags`, so `pref()` returns the neutral prior and preference — the
heaviest weight in the scorer, at 0.45–0.50 — stops doing anything at all.

---

## 5. Build order handshake

| AI phase | Unblocks NestJS |
|---|---|
| AI Phase 1 (schema + districts) | `prisma db pull` works → **Phase 2 Auth can start** |
| AI Phase 2 (ingestion) | Real listings exist → **Phase 3 Explore** has data |
| AI Phase 3 (mocks gone) | `/trip-plan` returns real data → **Phase 4 Chat** is meaningful |
| AI Phase 7 (session in DB) | `chat_session.ai_session_id` is durable → multi-turn works across restarts |

Unchanged from `BACKEND_PLAN.md` §7: **start the Next.js frontend once Phase 4 lands.**

Also unchanged and still true: the AI backend has no auth and must stay on a private network; CORS
`allow_origins=["*"]` in `ai-backend/main.py` must be tightened before any deployment.

---

## 6. What `BACKEND_PLAN.md` §6 no longer needs

§6 ("AI backend migration work, Supabase SDK → asyncpg") is **done** — completed 2026-08-30. Its final
paragraph instructs preserving the mock-data fallbacks; that is now **reversed** by decision D5. Treat
§6 as historical.
