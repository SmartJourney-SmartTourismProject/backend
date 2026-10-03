-- Email notifications (SRS §3.1.10, previously deferred - BACKEND_PLAN.md §1).
--
-- notification_settings: one row per user, written by the web app's
--   Settings > Notifications tab. No row = the defaults below (the same
--   defaults the tab shows), so existing users need no backfill. Email is
--   OFF until the user opts in; the per-type switches decide which events
--   are worth an email once it is on. push_enabled / sound_* are stored so
--   the tab remembers them, but nothing delivers push yet (no FCM).
--
-- notification: a log of every notification sent, and the dedupe guard -
--   (user_id, dedupe_key) is UNIQUE, so "trip X starts tomorrow" or "trip X
--   went over budget" is emailed once, however often the scheduler or an
--   expense edit re-detects it. A failed send deletes its row so the next
--   run retries.
CREATE TABLE IF NOT EXISTS notification_settings (
    user_id         uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    trip_reminders  boolean NOT NULL DEFAULT true,
    weather_alerts  boolean NOT NULL DEFAULT true,
    budget_alerts   boolean NOT NULL DEFAULT true,
    push_enabled    boolean NOT NULL DEFAULT true,
    email_enabled   boolean NOT NULL DEFAULT false,
    sound_enabled   boolean NOT NULL DEFAULT true,
    sound_volume    smallint NOT NULL DEFAULT 65 CHECK (sound_volume BETWEEN 0 AND 100),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification (
    id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
    type        text NOT NULL CHECK (type IN ('trip_reminder', 'trip_saved', 'weather_alert', 'budget_alert', 'test')),
    channel     text NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'push')),
    dedupe_key  text NOT NULL,
    subject     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notification_user_dedupe UNIQUE (user_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS notification_user_recent ON notification (user_id, created_at DESC);
