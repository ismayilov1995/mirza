-- Substring search over the canonical store.
--
-- Same lesson the live search already paid for: ILIKE '%needle%' over a
-- million rows is a sequential scan, and a trigram GIN index turns it into
-- milliseconds. There it took one query from 5,029 ms to 471 ms; here the
-- table is eight times larger, so the index is not optional.
--
-- Built CONCURRENTLY: the importers write to this table and an ordinary
-- CREATE INDEX would block them for the duration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS message_body_trgm_idx
  ON katibe.message USING gin (body gin_trgm_ops);

-- The archive screen orders by recency inside a conversation, and the chat
-- list asks each conversation for its newest message. Both walk this.
CREATE INDEX CONCURRENTLY IF NOT EXISTS message_chat_recent_idx
  ON katibe.message (chat_id, ts DESC, id);
