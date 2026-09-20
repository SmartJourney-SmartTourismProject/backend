-- NestJS's domain (BACKEND_PLAN.md §4.1), created here per decision D13 so
-- both services can migrate against one schema from day one. NestJS owns
-- these tables' writes; the AI backend only ever reads traveler_profile
-- (docs/master_plan/DATA_PLATFORM.md §2 ownership table).
--
-- "user" is a reserved word in SQL - named app_user throughout, mapped back
-- with @@map("app_user") when NestJS's Prisma schema is introspected.

CREATE TABLE app_user (
    id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    email             text NOT NULL UNIQUE,
    password_hash     text,                          -- null for Google-only accounts
    name              text,
    phone             text,
    google_id         text UNIQUE,
    email_verified    boolean NOT NULL DEFAULT false,
    role              text NOT NULL DEFAULT 'traveler',   -- traveler | admin
    is_active         boolean NOT NULL DEFAULT true,
    location_enabled  boolean NOT NULL DEFAULT false,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE traveler_profile (
    user_id           uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    travel_interests  text[] NOT NULL DEFAULT '{}',   -- constrained to tag_vocabulary.tag by the API layer
    travel_style      text,                           -- budget | balanced | luxury
    default_budget    numeric(12,2),
    currency          char(3) NOT NULL DEFAULT 'LKR',
    home_location     geography(Point,4326),
    updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_profile (
    user_id     uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    granted_at  timestamptz NOT NULL DEFAULT now(),
    granted_by  uuid REFERENCES app_user(id)
);

CREATE TABLE refresh_token (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    expires_at  timestamptz NOT NULL,
    revoked_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_token_user ON refresh_token (user_id);

CREATE TABLE chat_session (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    ai_session_id uuid,                               -- ties this chat to ai_session (0001) - the AI backend's session_id
    title         text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_session_user ON chat_session (user_id, updated_at DESC);

CREATE TABLE chat_message (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id  uuid NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    role        text NOT NULL,                        -- user | assistant
    content     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_message_session ON chat_message (session_id, created_at);

CREATE TABLE itinerary (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id        uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    district_id    uuid REFERENCES district(id),
    title          text,
    start_date     date,
    end_date       date,
    travelers      integer NOT NULL DEFAULT 1,
    budget         numeric(12,2),
    estimated_cost numeric(12,2),
    currency       char(3) NOT NULL DEFAULT 'LKR',
    status         text NOT NULL DEFAULT 'draft',      -- draft | upcoming | past
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX itinerary_user ON itinerary (user_id, status);

CREATE TABLE itinerary_day (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    itinerary_id uuid NOT NULL REFERENCES itinerary(id) ON DELETE CASCADE,
    day_number   integer NOT NULL,
    date         date
);
CREATE INDEX itinerary_day_parent ON itinerary_day (itinerary_id);

CREATE TABLE itinerary_item (
    id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    itinerary_day_id uuid NOT NULL REFERENCES itinerary_day(id) ON DELETE CASCADE,
    listing_id       uuid REFERENCES travel_listing(id),
    event_id         uuid REFERENCES local_event(id),
    item_type        text NOT NULL,                    -- attraction | hotel | restaurant | event | travel
    name             text NOT NULL,
    latitude         double precision,                 -- kept even for custom items, so a saved
    longitude        double precision,                 -- trip re-plots without another AI call
    start_time       time,
    end_time         time,
    est_cost         numeric(12,2),
    order_index      integer NOT NULL DEFAULT 0,
    notes            text
);
CREATE INDEX itinerary_item_day ON itinerary_item (itinerary_day_id, order_index);

CREATE TABLE expense (
    id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    itinerary_id uuid NOT NULL REFERENCES itinerary(id) ON DELETE CASCADE,
    category     text NOT NULL,
    amount       numeric(12,2) NOT NULL,
    currency     char(3) NOT NULL DEFAULT 'LKR',
    description  text,
    occurred_at  date NOT NULL DEFAULT CURRENT_DATE,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expense_itinerary ON expense (itinerary_id);

CREATE TABLE activity_log (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     uuid REFERENCES app_user(id),
    action      text NOT NULL,
    detail      jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_user ON activity_log (user_id, created_at DESC);

-- Deferred FKs from 0001's AI-runtime tables, now that app_user exists.
ALTER TABLE ai_session
    ADD CONSTRAINT ai_session_user_fk FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
ALTER TABLE google_oauth_tokens
    ADD CONSTRAINT google_oauth_tokens_user_fk FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE;
