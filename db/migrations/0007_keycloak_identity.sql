-- Identity moves to Keycloak (realm `smartjourney`, backend/keycloak/).
--
-- Keycloak now owns credentials, Google sign-in, the password policy and
-- realm roles; NestJS only verifies its RS256 access tokens (src/auth/) and
-- keeps a mirror row per user so the NOT NULL user_id foreign keys on
-- chat_session / itinerary / ai_session have something to point at. That row
-- is created on a user's first authenticated request from the token claims
-- (JIT provisioning, src/users/users.service.ts) - there is no registration
-- endpoint any more.
--
-- Deliberately kept: app_user.role (mirrored from the token's realm roles on
-- every request, so admin lists can filter without calling Keycloak) and
-- admin_profile (SAD §9). Not touched: the seeded demo row from
-- db/seeds/001_demo_user.sql - it has no keycloak_id, can't be signed into,
-- and deleting it would cascade through any chat/trip data teammates
-- created against it while auth was pending.

ALTER TABLE app_user
    ADD COLUMN keycloak_id uuid UNIQUE,          -- the token's `sub`; null only for the legacy demo row
    DROP COLUMN password_hash,                   -- Keycloak stores credentials
    DROP COLUMN google_id;                       -- Google is a Keycloak identity provider now

-- Refresh tokens are issued and rotated by Keycloak; NestJS never sees them.
DROP TABLE IF EXISTS refresh_token;
