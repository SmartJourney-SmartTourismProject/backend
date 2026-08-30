# AI Backend — API Endpoint Reference

**For:** the NestJS backend (`backend/`), which is the only service that should call the AI backend directly.
**AI backend repo:** `ai-backend/` (Python / FastAPI)
**Generated from:** the live FastAPI OpenAPI schema, 2026-08-30. Verify against `GET /docs` (Swagger UI) if anything here looks stale.

---

## How it fits together

```
Next.js web  ─┐
              ├─► NestJS backend ──► AI backend (FastAPI)  ──► Gemini / OpenWeather / EONET / USGS / GDACS / Nominatim
Flutter app  ─┘        │                     │
                       └──── Postgres ◄──────┘
```

Per the SAD, the **frontends never call the AI backend directly** — they only talk to NestJS.
NestJS owns auth, persistence, and business rules; the AI backend is a stateless-ish planning
service it delegates to.

**No authentication on the AI backend.** It has no JWT/API-key layer by design (BUILD_PLAN §7,
Phase 5 step 2) — it assumes it is only reachable from NestJS on a private network. **Do not
expose it to the public internet.** In deployment, keep it on an internal network/VPC, or put it
behind NestJS entirely.

**CORS is currently wide open** (`allow_origins=["*"]` in `main.py`) to make local demo work.
Tighten this to the NestJS origin before any real deployment.

---

## Running it locally

```powershell
cd ai-backend
.venv\Scripts\Activate.ps1
python -m uvicorn main:app --reload
```

Default base URL: `http://localhost:8000`
Interactive docs: `http://localhost:8000/docs`

---

## Endpoint summary

| Method | Path | Purpose | NestJS should… |
|---|---|---|---|
| `POST` | `/trip-plan` | **The main one.** Generate/refine a trip itinerary | **Proxy** — this is the core integration |
| `GET` | `/auth/google/login` | Start Google Calendar OAuth consent | **Redirect** the user here (or re-implement in NestJS) |
| `GET` | `/auth/google/callback` | OAuth callback — exchanges code, stores tokens | Google calls this directly; don't proxy |
| `GET` | `/` | Liveness check | Health monitoring |
| `GET` | `/api/health` | Liveness check (detailed) | Health monitoring |
| `POST` | `/api/rag/index` | Index candidate data into the RAG vector store | Internal/admin only |
| `POST` | `/api/admin/sync/events` | Trigger the events data-ingest job | Admin panel only |
| `POST` | `/api/admin/sync/listings` | Trigger the listings data-ingest job | Admin panel only |

---

## `POST /trip-plan`

The primary endpoint. Runs the full multi-agent LangGraph pipeline:
`validate → policy → slot-fill → location → calendar → weather/disaster → recommend → plan → respond`.

### Request

```json
{
  "message": "Plan a 3-day trip to Kandy, budget $300, interested in culture and history",
  "language": "en",
  "user_id": "optional-uuid",
  "client_gps": { "lat": 7.29, "lon": 80.63 },
  "session_id": "optional-uuid"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | **yes** | The traveler's raw natural-language request. Everything else is optional. |
| `language` | string | no | Defaults to `"en"`. |
| `user_id` | string \| null | no | When present, the AI backend looks up saved preferences (interests / travel style / budget) to fill gaps. |
| `client_gps` | `{lat, lon}` \| null | no | Traveler's current position, if the client has it. Omit to fall through to IP geolocation. |
| `session_id` | string \| null | no | **Omit on the first message.** Pass back the `session_id` from the previous response to continue the same conversation (see *Multi-turn* below). |

### Response

```json
{
  "session_id": "eaa63a15-f817-4e0b-af54-a82cf39d22b9",
  "destination": "Kandy",
  "itinerary": [
    {
      "day": 1,
      "date": "2026-08-29",
      "items": [
        {
          "time": "09:00",
          "type": "hotel",
          "name": "Kandy Lake View Hotel",
          "notes": "Check in and settle in with views of Kandy Lake.",
          "lat": 7.2931,
          "lon": 80.6392
        }
      ]
    }
  ],
  "estimated_cost": 230.0,
  "budget_notes": "Estimated cost of $230 stays comfortably within the $300 budget.",
  "weather": {
    "current": { "temp": 24.5, "condition": "Clouds", "humidity": 78 },
    "forecast": [
      { "date": "2026-08-29", "temp_min": 22.1, "temp_max": 28.4,
        "condition": "Rain", "rain_probability": 0.6 }
    ]
  },
  "disaster": { "safe": true, "active_events": [] },
  "final_response": "Here's your trip plan for Kandy: 3 day(s) planned, estimated cost 230.0.",
  "errors": [],
  "completed_steps": []
}
```

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | **Always returned.** Persist it against the user's chat session — it's how follow-up messages work. |
| `destination` | string \| null | Resolved by the AI from `message`. `null` when it had to ask a clarifying question. |
| `itinerary` | array | Day-by-day plan. `items[].lat`/`lon` are present on every stop — use them for map pins. Empty array when nothing could be planned. |
| `estimated_cost` | number \| null | AI's cost estimate. **Currency is implicitly USD** — see *Known gaps*. |
| `budget_notes` | string \| null | The AI's explanation of budget fit — surface this in the UI when present, especially when the budget was exceeded. |
| `weather` | object \| null | `null` when weather couldn't be fetched (no API key, destination not geocodable, API down). The plan still completes. |
| `disaster` | object \| null | `{safe, active_events[]}`. May also carry `"note": "disaster data unavailable"` when all three sources failed — that's different from a confident "safe". |
| `final_response` | string \| null | **Chat-display text.** Either a plan summary or a clarification question. This is what you render in the chat bubble. |
| `errors` | string[] | **Advisory, not necessarily fatal** — see below. |
| `completed_steps` | string[] | Debug only. Always `[]` unless the AI backend runs with `DEBUG=true`. Ignore in production. |

### Interpreting `errors` — important

A non-empty `errors` array does **not** mean the request failed. The AI backend degrades
gracefully by design (BUILD_PLAN §8). Judge success by whether `itinerary` has content:

- `itinerary` non-empty + `errors` non-empty → **a usable plan with caveats.** Show the plan;
  the caveats are already summarized in `final_response`.
- `itinerary` empty + `errors` non-empty → genuine failure. `final_response` explains it.
- `itinerary` empty + `errors` empty → the AI asked a clarifying question. `final_response`
  *is* the question (e.g. `"Which destination would you like to visit?"`) — render it and wait
  for the user's next message.

Common advisory entry: `"location_unresolved: need to ask user for start location"` — means
GPS/IP both failed and the user didn't mention an origin. The plan is still valid.

### Multi-turn conversations

The AI backend supports refining an existing plan rather than starting over:

1. First message: send **without** `session_id`. Store the returned `session_id`.
2. Follow-up: send the new message **with** that `session_id`. The destination, budget,
   interests, and the existing itinerary all carry over automatically; the new message is
   treated as a *modification* ("make it cheaper", "swap the temple for something indoors",
   "I'm starting from Polonnaruwa").

An unrecognized `session_id` is treated as a fresh first turn — it won't error.

**Caveat for NestJS:** session state currently lives in a **local JSON file** inside the AI
backend container (`app/utils/session_store.py`), not in Postgres. That means it won't survive a
container rebuild and won't work if you run more than one AI-backend instance behind a load
balancer. Either keep it to a single instance for now, or plan to move that state into the shared
database (this is a known open item — see `ai-backend/docs/NEXT_STEPS.md`).

### Errors

| Status | When |
|---|---|
| `200` | Normal — including graceful-degradation cases. Check `errors`/`itinerary` as above. |
| `422` | Validation error — e.g. `message` missing, or malformed `client_gps`. |
| `500` | Unhandled server error. |

**Timeouts:** a single call chains several external APIs plus 1–2 Gemini calls. Typical
responses take **5–20 seconds**; a slow/retrying Gemini call can push past 60s. Set your NestJS
HTTP client timeout generously (60–120s) and consider making this async in the UI (loading state,
per SRS §3.4.1's "display loading indicators").

---

## `GET /auth/google/login`

Starts the Google Calendar OAuth consent flow. When a user connects their calendar, the AI
backend can read their free/busy days and suggest trip dates.

**Query params:** `user_id` (required)

**Response:** `302` redirect to Google's consent screen.

The `state` parameter is a **signed, 10-minute-expiring token** (not the raw `user_id`) for CSRF
protection.

---

## `GET /auth/google/callback`

Google redirects here after consent. Exchanges the code for tokens and stores them.

**Query params:** `code` (required), `state` (required — the signed token from above)

**Response:** `{"status": "connected", "user_id": "..."}`, or `400` if `state` is invalid/expired.

**NestJS shouldn't call this** — Google does. Just make sure the redirect URI registered in the
Google Cloud console matches `GOOGLE_CALENDAR_REDIRECT_URI` in the AI backend's `.env`.

---

## `GET /` and `GET /api/health`

Liveness checks. `GET /` returns `{"status": "ok", "service": "smart-tourism-ai-backend"}`.
Use either for container health checks / uptime monitoring.

---

## `POST /api/rag/index`

Indexes candidate listing data into the RAG vector store. Called by the data pipeline, not by
user-facing flows.

```json
{ "data": { "hotel": [ { "id": "...", "name": "...", "description": "..." } ] },
  "destination": "Kandy" }
```

---

## `POST /api/admin/sync/events` · `POST /api/admin/sync/listings`

Manually trigger the data-ingest jobs (Ticketmaster events; Overpass listings + prices). Both
return immediately (`{"status": "started"}`) and run in the background — the sync itself takes
several minutes across 25 districts. Check the AI backend's logs for completion.

These also run automatically on a schedule (events weekly, listings monthly) via APScheduler.

**Wire these to the Admin Panel only**, behind an admin role check in NestJS — they're
unauthenticated on the AI backend side.

---

## What NestJS should persist

The AI backend does **not** save itineraries to the database. When `/trip-plan` returns a plan
that the user chooses to keep, NestJS should write it into `itinerary` / `itinerary_day` /
`itinerary_item` (SAD §9), mapping `itinerary[].items[]` onto `itinerary_item` rows and keeping
`lat`/`lon` so the map can be re-rendered later without another AI call.

Chat history (SRS §3.10 "conversational data") is likewise NestJS's to store — the AI backend
only keeps enough state to make the *next* follow-up message work.

---

## Known gaps to be aware of

- **Currency**: `estimated_cost` has no currency field and the prompts assume USD, while the SRS
  mockups show LKR. Decide where conversion/labelling happens — probably NestJS or the UI.
- **Budget adherence**: the AI explains budget overruns in `budget_notes` but doesn't always pick
  the cheapest available option. Surface `budget_notes` prominently rather than trusting
  `estimated_cost` to respect the requested budget.
- **Session storage**: local file, not shared DB (see *Multi-turn* above).
- **No rate limiting**: SAD §10.3 specifies queueing beyond ~20 req/sec; not implemented. Fine at
  current scale; NestJS is the natural place to add throttling if it ever matters.
