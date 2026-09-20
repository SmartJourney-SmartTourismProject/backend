-- Tracks when a listing was last checked against Foursquare, so
-- foursquare_enrich.py's 90-day cooldown (docs/master_plan/DATA_PLATFORM.md
-- §5.1) can skip recently-checked rows instead of re-spending its capped
-- monthly budget on the same listings every run.
ALTER TABLE travel_listing ADD COLUMN foursquare_checked_at timestamptz;
CREATE INDEX travel_listing_foursquare_checked ON travel_listing (foursquare_checked_at);
