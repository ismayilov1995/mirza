-- Makes the literal half of search fast enough to render with the page.
--
-- Substring search over a year of one account's messages took five seconds:
-- the planner finds the rows by instance, then extracts the text out of JSONB
-- and runs ILIKE on every one of them — 103,580 rows scanned, 32,446 discarded
-- by the filter for a single query. Nothing indexes that, because ILIKE
-- '%needle%' is unanchored and the text is not a column.
--
-- A trigram GIN index over the same COALESCE expression does index it. The
-- expression has to be written exactly as the query writes it or the planner
-- will not match the two, which is why this repeats src/lib/search.ts verbatim
-- rather than tidying it.
--
-- CONCURRENTLY because this is Evolution's own table and Baileys is writing to
-- it continuously; an ordinary CREATE INDEX takes a lock that would stall
-- incoming messages for the duration of the build.
--
-- Adding an index to a table Prisma owns is already established here — see
-- 2026-08-26_message_remote_jid_idx.sql. Prisma leaves indexes it does not
-- know about alone unless someone force-resets the schema.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS message_text_trgm_idx
  ON evolution_api."Message" USING gin (
    (COALESCE(
      message->>'conversation',
      message->'imageMessage'->>'caption',
      message->'videoMessage'->>'caption',
      message->'documentMessage'->>'fileName'
    )) gin_trgm_ops
  );
