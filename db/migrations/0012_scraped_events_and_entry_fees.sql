-- Storage for the two scraped sources vetted in
-- ai-backend/docs/master_plan/SCRAPE_SOURCES.md: friday.lk events and the
-- Central Cultural Fund's heritage-site ticket prices.

-- ─────────────────────────── events ───────────────────────────
-- Where a scraped event came from. friday.lk's content is copyrighted, so we
-- keep facts only and always link back; the admin reviewing a pending event
-- also needs the page to check it against.
ALTER TABLE local_event
    ADD COLUMN source_url text;

-- ─────────────────────────── entry fees ───────────────────────────
-- 336 of 339 verified attractions carry no price_level, so the budget prices
-- them at the free default band (0011) - right for beaches and temples, wrong
-- for Sigiriya (USD 35). Real fees are scraped into this staging table and
-- only reach a budget once an admin approves the row.
--
-- A separate table, not columns on travel_listing: the scraped site name has
-- to be matched to a listing ("Sigiriya" -> "Sigiriya Rock Fortress"), that
-- match can be wrong, and it needs its own review state. listing_id is NULL
-- until a match is made, by the connector or by the admin.
CREATE TABLE listing_entry_fee (
    id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    listing_id     uuid REFERENCES travel_listing(id) ON DELETE SET NULL,
    site_name      text NOT NULL,                   -- as the source writes it
    -- Foreign-visitor prices, LKR, VAT included (CCF publishes nothing else).
    foreign_adult  numeric(12,2),
    foreign_child  numeric(12,2),                   -- CCF "half ticket"
    local_adult    numeric(12,2),                   -- NULL: not published
    currency       char(3) NOT NULL DEFAULT 'LKR',
    source         text NOT NULL,                   -- ccf | admin
    source_url     text,
    external_ref   text NOT NULL,
    status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected')),
    fetched_at     timestamptz NOT NULL DEFAULT now(),
    reviewed_at    timestamptz,
    reviewed_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
    UNIQUE (source, external_ref)
);

-- The planner LEFT JOINs approved fees onto listings; two approved rows for
-- one listing would duplicate that listing in every search. Enforced here,
-- not trusted to the admin UI.
CREATE UNIQUE INDEX entry_fee_one_approved_per_listing
    ON listing_entry_fee (listing_id)
    WHERE status = 'approved' AND listing_id IS NOT NULL;

-- The admin review queue.
CREATE INDEX entry_fee_status ON listing_entry_fee (status, fetched_at DESC);
