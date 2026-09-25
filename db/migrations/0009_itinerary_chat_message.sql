-- Links a saved itinerary back to the chat message its card was rendered
-- from. Required by code already on main (commit 844d494: chat.service.ts,
-- trips.service.ts, save-trip.dto.ts) which shipped without the matching
-- migration, so the schema this file creates was missing and NestJS would not
-- compile against the generated client.
--
-- UNIQUE is the point, not a nicety: it is what makes "Save itinerary"
-- idempotent. Re-clicking the button on the same card - after a refresh, say -
-- finds the existing trip instead of inserting a duplicate.
--
-- ON DELETE SET NULL, not CASCADE: deleting a chat must not silently take the
-- trips saved from it. They survive, merely unlinked. chat.service.ts removes
-- them explicitly only when the user ticks "also delete related saved
-- itineraries".

ALTER TABLE itinerary
    ADD COLUMN chat_message_id uuid UNIQUE
        REFERENCES chat_message(id) ON DELETE SET NULL;
