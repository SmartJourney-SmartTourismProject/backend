-- Profile picture. Stored inline as a small data URL (the web app resizes it
-- to ~192px JPEG before upload, so a row stays in the tens of KB) rather than
-- adding file storage for one image per user. NULL = show initials.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS avatar_url text;
