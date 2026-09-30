-- Backfill each saved trip's own start/end date from its days.
--
-- Until 2026-10-01, TripsService.saveTrip stored a date on every
-- itinerary_day but never on the itinerary itself, so every Saved
-- Itineraries card read "Dates not set" and a finished trip could never be
-- recognised as Past (TripsService now derives Past from end_date). New
-- saves set both; this fills in the trips saved before that.
UPDATE itinerary i
SET start_date = d.first_day,
    end_date   = d.last_day
FROM (
    SELECT itinerary_id, min(date) AS first_day, max(date) AS last_day
    FROM itinerary_day
    WHERE date IS NOT NULL
    GROUP BY itinerary_id
) d
WHERE d.itinerary_id = i.id
  AND i.start_date IS NULL
  AND i.end_date IS NULL;
