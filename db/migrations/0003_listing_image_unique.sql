-- listing_image had no natural dedup key, so `ON CONFLICT DO NOTHING`
-- without a matching constraint is silently a no-op in Postgres - every
-- re-run of wikidata_enrich would otherwise insert a duplicate row per
-- listing. Found while wiring app/data/connectors/wikidata_enrich.py.
ALTER TABLE listing_image ADD CONSTRAINT listing_image_listing_url_uq UNIQUE (listing_id, url);
