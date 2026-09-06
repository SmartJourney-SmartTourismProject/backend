-- chat_message only ever stored the assistant's rendered text
-- (final_response), never the structured plan (itinerary/estimated_cost/
-- plan_source/destination) that came back alongside it. That's why
-- reloading a chat session (refresh, or switching away and back) showed
-- the message bubble but lost the itinerary summary card entirely - there
-- was nothing to reconstruct it from. Nullable since every row before this
-- migration (and every user-role row going forward) has none.
ALTER TABLE chat_message ADD COLUMN plan jsonb;
