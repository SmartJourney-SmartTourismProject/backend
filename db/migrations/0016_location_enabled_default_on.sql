-- "Enable location access" now actually gates whether the app asks for and
-- sends the traveler's location (it used to be saved but never read). Make it
-- on by default, and on for existing accounts: nobody could meaningfully have
-- chosen "off" before, since the setting had no effect and still defaulted to
-- false. Travelers can turn it off in Settings.
ALTER TABLE app_user ALTER COLUMN location_enabled SET DEFAULT true;
UPDATE app_user SET location_enabled = true WHERE location_enabled = false;
