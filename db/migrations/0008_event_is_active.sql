-- Gives local_event the same active/inactive flag travel_listing already has,
-- so the admin panel can tell three states apart:
--
--   pending   is_verified = false AND is_active = true   (awaiting review)
--   approved  is_verified = true                         (public)
--   rejected  is_active   = false                        (reviewed and refused)
--
-- Without it a rejected event is indistinguishable from an unreviewed one and
-- would sit in the moderation queue forever, since the ingest jobs keep
-- re-upserting it (docs/BACKEND_ALIGNMENT.md §7).
--
-- Safe for the AI backend's ingest: it never writes this column, so the
-- default keeps newly ingested events in the pending queue, and an admin's
-- rejection survives the next re-sync.

ALTER TABLE local_event
    ADD COLUMN is_active boolean NOT NULL DEFAULT true;

-- The moderation queue reads exactly this pair, per district.
CREATE INDEX event_moderation ON local_event (is_verified, is_active, district_id);
