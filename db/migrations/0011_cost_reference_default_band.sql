-- Which price band to assume when a listing declares none, as data.
--
-- This rule was a Python dict: {"attraction": 1, "restaurant": 2, "hotel": 2}.
-- It had already been wrong once. A single assumed band of 2 was applied to
-- every category, and cost_reference prices an attraction at band 2 as 1,500
-- LKR - so with 336 of 339 verified attractions carrying no band, every beach,
-- viewpoint and rampart was billed an entry fee that does not exist. Budgets
-- the traveler is actually tracking reported charges for free places.
--
-- Fixing it in code meant a deploy to change a number that is really a fact
-- about Sri Lankan tourism, and left the rule in a different place from the
-- prices it selects between. Here, the band that fills a gap sits in the same
-- table as the bands themselves: adding a category is a row, and revising the
-- assumption for one is an UPDATE.
--
-- Exactly one row per (district_id, category) may be the default, enforced
-- below rather than trusted - two defaults would make the estimate depend on
-- row order, which is the kind of bug that appears only in production.

ALTER TABLE cost_reference
    ADD COLUMN is_assumed_default boolean NOT NULL DEFAULT false;

-- Attractions: band 1, priced at 0.00. Most Sri Lankan attractions have no
-- entry fee, and a budget must not invent one. This understates genuinely
-- ticketed sites (Sigiriya, the national museums); those are meant to carry a
-- real price_level of their own rather than be covered by an assumption.
UPDATE cost_reference SET is_assumed_default = true
    WHERE district_id IS NULL AND category = 'attraction' AND price_level = 1;

-- Meals and rooms are never free, so assuming so would understate every trip.
-- The mid band is the honest guess. Note the seed data has several band-2 rows
-- per category (different units/costs); only the cheapest is marked, so the
-- assumption is the conservative one.
UPDATE cost_reference SET is_assumed_default = true
    WHERE id IN (
        SELECT DISTINCT ON (category) id
        FROM cost_reference
        WHERE district_id IS NULL AND category IN ('restaurant', 'hotel', 'transport')
          AND price_level = 2
        ORDER BY category, typical_cost ASC
    );

CREATE UNIQUE INDEX cost_reference_one_default_per_category
    ON cost_reference (COALESCE(district_id, '00000000-0000-0000-0000-000000000000'::uuid), category)
    WHERE is_assumed_default;
