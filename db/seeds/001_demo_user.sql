-- Demo traveler account.
--
-- Auth (BACKEND_PLAN.md §7 Phase 2) is deliberately being built LAST, but
-- chat_session.user_id and itinerary.user_id are both NOT NULL foreign keys -
-- so the chat/trip-planning endpoints cannot persist anything without some
-- user row to hang it off. This seeds exactly one, with a fixed UUID so the
-- API layer can reference it as a constant until real JWT auth replaces it.
--
-- password_hash is deliberately NULL: this account is not sign-in-able, and
-- leaving it NULL means no placeholder credential can ever be mistaken for a
-- working one. Once auth lands, delete this row (or set a real hash through
-- the normal registration path) and remove DEMO_USER_ID from the API layer.
--
-- Idempotent - safe to re-apply.
--     docker exec -i smartjourney_postgres psql -U smartjourney -d smartjourney \
--       < backend/db/seeds/001_demo_user.sql

INSERT INTO app_user (id, email, name, role, email_verified, is_active)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'demo@smartjourney.local',
    'Demo Traveler',
    'traveler',
    true,
    true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO traveler_profile (user_id, travel_interests, travel_style, currency)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    ARRAY['culture', 'history'],
    'balanced',
    'LKR'
)
ON CONFLICT (user_id) DO NOTHING;
