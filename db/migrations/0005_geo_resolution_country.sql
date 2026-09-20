-- Lets geo_resolution cache an out-of-country detection (e.g. "New York" ->
-- confidence='out_of_country', country='United States') alongside genuine
-- Sri Lankan matches, so a repeated out-of-scope destination is answered
-- from cache instead of re-querying Nominatim every time.
ALTER TABLE geo_resolution ADD COLUMN country text;
