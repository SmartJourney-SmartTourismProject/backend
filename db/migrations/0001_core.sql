-- Core schema for the AI backend. Canonical, hand-written SQL (decision D13,
-- docs/master_plan/PROJECT_MASTER_PLAN.md) - NestJS later runs `prisma db pull`
-- against this rather than owning migrations itself. Full rationale and
-- ownership table in docs/master_plan/DATA_PLATFORM.md §2.

-- ─────────────────────────── reference ───────────────────────────

CREATE TABLE district (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          text NOT NULL UNIQUE,              -- "Kandy"
    province      text NOT NULL,
    osm_relation_id bigint UNIQUE,                   -- provenance; NOT a hardcoded list
    center        geography(Point,4326) NOT NULL,
    boundary      geometry(MultiPolygon,4326),       -- geometry (not geography) for ST_Contains
    source        text NOT NULL DEFAULT 'osm',
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX district_boundary_gix ON district USING gist (boundary);
CREATE INDEX district_center_gix   ON district USING gist (center);
CREATE INDEX district_name_trgm    ON district USING gin (name gin_trgm_ops);

CREATE TABLE category (
    id    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name  text NOT NULL UNIQUE                       -- hotel | restaurant | attraction
);

-- canonical interest tags + how raw OSM/Foursquare tags map onto them
CREATE TABLE tag_vocabulary (
    tag         text PRIMARY KEY,                    -- "culture", "beach", "hike", "food"
    label       text NOT NULL,
    is_outdoor  boolean NOT NULL DEFAULT false       -- drives weather filtering
);

CREATE TABLE tag_mapping (
    source        text NOT NULL,                     -- osm | foursquare | wikidata
    source_key    text NOT NULL,                     -- "tourism=viewpoint", "amenity=restaurant"
    tag           text NOT NULL REFERENCES tag_vocabulary(tag),
    PRIMARY KEY (source, source_key, tag)
);

-- ─────────────────────────── content ───────────────────────────

CREATE TABLE travel_listing (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    district_id          uuid NOT NULL REFERENCES district(id),
    category_id          uuid NOT NULL REFERENCES category(id),
    name                 text NOT NULL,
    description          text,
    location             geography(Point,4326) NOT NULL,
    latitude             double precision GENERATED ALWAYS AS (ST_Y(location::geometry)) STORED,
    longitude            double precision GENERATED ALWAYS AS (ST_X(location::geometry)) STORED,
    tags                 text[] NOT NULL DEFAULT '{}',
    price_level          smallint CHECK (price_level BETWEEN 1 AND 4),
    price_per_night      numeric(12,2),              -- hotels, real price when known
    currency             char(3) NOT NULL DEFAULT 'LKR',
    rating               numeric(2,1) CHECK (rating BETWEEN 1.0 AND 5.0),
    rating_count         integer NOT NULL DEFAULT 0,
    opening_hours        jsonb,                      -- OSM opening_hours, parsed
    photo_url            text,
    has_public_transit   boolean NOT NULL DEFAULT false,
    nearest_transit_stop text,
    source               text NOT NULL,              -- osm | foursquare | booking | admin
    external_ref         text NOT NULL,
    is_verified          boolean NOT NULL DEFAULT false,
    is_active            boolean NOT NULL DEFAULT true,
    last_seen_at         timestamptz NOT NULL DEFAULT now(),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, external_ref)
);
CREATE INDEX listing_location_gix ON travel_listing USING gist (location);
CREATE INDEX listing_tags_gin     ON travel_listing USING gin (tags);
CREATE INDEX listing_lookup       ON travel_listing (district_id, category_id, is_verified, is_active);
CREATE INDEX listing_name_trgm    ON travel_listing USING gin (name gin_trgm_ops);

CREATE TABLE listing_image (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id  uuid NOT NULL REFERENCES travel_listing(id) ON DELETE CASCADE,
    url         text NOT NULL,
    caption     text,
    attribution text                                 -- Wikimedia/OSM licence line
);
CREATE INDEX listing_image_listing ON listing_image (listing_id);

CREATE TABLE local_event (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    district_id    uuid NOT NULL REFERENCES district(id),
    name           text NOT NULL,
    description    text,
    start_datetime timestamptz NOT NULL,
    end_datetime   timestamptz,
    venue_name     text,
    location       geography(Point,4326),
    latitude       double precision GENERATED ALWAYS AS (ST_Y(location::geometry)) STORED,
    longitude      double precision GENERATED ALWAYS AS (ST_X(location::geometry)) STORED,
    tags           text[] NOT NULL DEFAULT '{}',
    price_min      numeric(12,2),
    price_max      numeric(12,2),
    currency       char(3) NOT NULL DEFAULT 'LKR',
    source         text NOT NULL,                    -- ticketmaster | admin
    external_ref   text NOT NULL,
    is_verified    boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source, external_ref)
);
CREATE INDEX event_window   ON local_event (district_id, start_datetime, end_datetime);
CREATE INDEX event_location ON local_event USING gist (location);

-- ─────────────────────────── cost model ───────────────────────────

CREATE TABLE cost_reference (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    district_id  uuid REFERENCES district(id),       -- NULL = national fallback
    category     text NOT NULL,                      -- hotel|restaurant|attraction|transport
    price_level  smallint NOT NULL CHECK (price_level BETWEEN 1 AND 4),
    unit         text NOT NULL,                      -- per_night|per_meal|per_entry|per_km
    typical_cost numeric(12,2) NOT NULL,
    currency     char(3) NOT NULL DEFAULT 'LKR',
    source_note  text,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (district_id, category, price_level, unit)
);

-- ─────────────────────────── geo caches ───────────────────────────

-- Replaces app/data/sri_lanka_districts.py's hardcoded lookup entirely.
CREATE TABLE geo_resolution (
    query_norm    text PRIMARY KEY,                  -- lower(trim(input))
    display_name  text NOT NULL,
    location      geography(Point,4326) NOT NULL,
    district_id   uuid REFERENCES district(id),
    confidence    text NOT NULL,                     -- high|medium|low
    provider      text NOT NULL,                     -- nominatim|google|district_table
    resolved_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE travel_time (
    origin_key   text NOT NULL,                      -- "6.9271,79.8612" rounded to 4dp
    dest_key     text NOT NULL,
    mode         text NOT NULL DEFAULT 'drive',
    minutes      double precision NOT NULL,
    km           double precision NOT NULL,
    provider     text NOT NULL,                      -- ors|haversine
    fetched_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (origin_key, dest_key, mode)
);

-- ─────────────────────────── AI runtime ───────────────────────────

CREATE TABLE ai_session (
    session_id   uuid PRIMARY KEY,
    user_id      uuid,                               -- FK added in 0002
    state        jsonb NOT NULL,                     -- the carry-over fields only (AGENT_ARCHITECTURE.md §5)
    react_trace  jsonb,                               -- last turn's traces, debug/report material
    turn_count   integer NOT NULL DEFAULT 1,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX ai_session_expiry ON ai_session (expires_at);
CREATE INDEX ai_session_user   ON ai_session (user_id);

CREATE TABLE google_oauth_tokens (
    user_id       uuid PRIMARY KEY,
    access_token  text NOT NULL,
    refresh_token text,
    token_expiry  timestamptz,
    scope         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────── pipeline audit ───────────────────────────

CREATE TABLE data_source (
    name           text PRIMARY KEY,                 -- osm_listings, booking_prices, …
    display_name   text NOT NULL,
    cadence        text NOT NULL,                    -- daily|weekly|monthly|quarterly|manual
    is_enabled     boolean NOT NULL DEFAULT true,
    requires_key   boolean NOT NULL DEFAULT false,
    last_success_at timestamptz
);

CREATE TABLE data_source_run (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    source        text NOT NULL REFERENCES data_source(name),
    district_id   uuid REFERENCES district(id),
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz,
    status        text NOT NULL DEFAULT 'running',   -- running|success|partial|failed
    rows_fetched  integer NOT NULL DEFAULT 0,
    rows_upserted integer NOT NULL DEFAULT 0,
    error         text
);
CREATE INDEX dsr_recent ON data_source_run (source, started_at DESC);
