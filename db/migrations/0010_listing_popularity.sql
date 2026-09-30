-- A real, free popularity signal for listings.
--
-- Why this is needed: almost every listing comes from OpenStreetMap, where a
-- world-famous landmark and a node someone dropped on a map last week are the
-- same shape - a name and a coordinate. Only 3 of 339 verified attractions and
-- 1 of 1,543 restaurants carry a rating, so the scorer had nothing to tell them
-- apart and ranked purely on proximity. That is how a one-day Galle plan
-- skipped Galle Fort Ramparts in favour of an unrated node that was nearer.
--
-- Star ratings and review text for arbitrary places are owned by Google and
-- TripAdvisor: paid, and their terms forbid storing the ratings. Wikipedia
-- pageviews are free, unmetered, need no key, and carry no caching restriction
-- (CC BY-SA, attribution only) - and they measure the thing that actually
-- matters here: how many people care about this place. Sampled 2026-09-30 over
-- 12 months: Sigiriya 275,216, Temple of the Tooth 76,106, Galle Fort 52,038,
-- Nine Arch Bridge 32,444.
--
-- Nullable throughout: a small guesthouse has no Wikipedia article and never
-- will, which is not an error. The scorer treats a missing value as "no
-- evidence", the same as a missing rating.

ALTER TABLE travel_listing
    -- The matched article title, stored so a wrong match is auditable and
    -- fixable rather than an unexplained number. An earlier enrichment pass
    -- matched articles by nearest-coordinate and attached the Galle Services
    -- Club to three unrelated bastions; keeping the title makes that visible.
    ADD COLUMN wikipedia_title text,
    -- Total pageviews over the sampled window. Raw count, not a normalized
    -- score: normalization belongs in the scorer, where the scale can change
    -- without a migration.
    ADD COLUMN popularity integer,
    -- When the figure was last refreshed, so the connector can re-check the
    -- stalest rows first instead of re-fetching everything every run.
    ADD COLUMN popularity_checked_at timestamptz;

-- The connector's own work queue: "listings not checked recently, oldest
-- first". Partial, because rows that can never match an article are the
-- majority and there is no reason to index them.
CREATE INDEX listing_popularity_refresh
    ON travel_listing (popularity_checked_at NULLS FIRST)
    WHERE is_active;
