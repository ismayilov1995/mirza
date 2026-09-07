-- Denormalised conversation statistics, because the honest query was 14 seconds.
--
-- Ordering 5,298 conversations by their newest message meant grouping 1.66M
-- rows on every page load. The numbers themselves barely move — the archive is
-- fixed and the live side appends a few thousand a day — so they are stored
-- and refreshed by whatever writes messages.
--
-- These are GLOBAL, deliberately: they order and prefilter the list, and the
-- per-conversation figures a caller is actually shown are still counted
-- through their own sources for the page's own rows. Storing a per-viewer
-- count would mean one row per viewer per chat to keep correct, which is a
-- cache invalidation problem in exchange for a number nobody reads closely.
ALTER TABLE katibe.chat
  ADD COLUMN IF NOT EXISTS message_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_ts integer,
  ADD COLUMN IF NOT EXISTS last_ts integer;

CREATE INDEX IF NOT EXISTS chat_last_ts_idx ON katibe.chat (last_ts DESC NULLS LAST);

-- One statement, safe to run at any time: it derives everything from
-- katibe.message rather than incrementing, so it cannot drift.
CREATE OR REPLACE FUNCTION katibe.refresh_chat_stats() RETURNS void AS $$
  UPDATE katibe.chat c
     SET message_count = COALESCE(s.n, 0),
         first_ts = s.first_ts,
         last_ts = s.last_ts
    FROM (SELECT chat_id, count(*) AS n, min(ts) AS first_ts, max(ts) AS last_ts
            FROM katibe.message GROUP BY chat_id) s
   WHERE s.chat_id = c.id
     AND (c.message_count, c.first_ts, c.last_ts)
         IS DISTINCT FROM (s.n::int, s.first_ts, s.last_ts);
$$ LANGUAGE sql;

ALTER FUNCTION katibe.refresh_chat_stats() OWNER TO evolution;
