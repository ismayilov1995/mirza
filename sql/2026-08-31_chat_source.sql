-- Which sources contribute to each conversation.
--
-- Derived, not authored: it is exactly what you get by walking message and
-- message_source, and it exists because walking them took five seconds. The
-- list page needs two things per conversation — "may this caller see it" and
-- "which eras does it span" — and both are answered here by a lookup against
-- 5,615 chats instead of a scan across 1.66M messages.
--
-- ÇAĞIRAN: scripts/mirror-evolution.ts, hər köçürmənin sonunda (yalnız nəsə
-- yazılıbsa). Cron */5 dəqiqədə bir onu işlədir. Bu funksiyanı ayrıca
-- planlaşdırma, yazan skriptdən ayırma: 2026-08-31-ə qədər heç kim çağırmırdı
-- və bir gün ərzində 207 söhbətin sayları sürüşmüşdü.
--
-- Kept in step by katibe.refresh_chat_stats(), which recomputes rather than
-- increments, so it cannot drift away from the messages it describes.
CREATE TABLE IF NOT EXISTS katibe.chat_source (
  chat_id    bigint NOT NULL REFERENCES katibe.chat(id) ON DELETE CASCADE,
  source_id  text NOT NULL REFERENCES katibe.source(id) ON DELETE CASCADE,
  messages   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, source_id)
);

CREATE INDEX IF NOT EXISTS chat_source_source_idx ON katibe.chat_source (source_id);

ALTER TABLE katibe.chat_source OWNER TO evolution;

CREATE OR REPLACE FUNCTION katibe.refresh_chat_stats() RETURNS void AS $$
  WITH stat AS (
    SELECT chat_id, count(*) AS n, min(ts) AS first_ts, max(ts) AS last_ts
      FROM katibe.message GROUP BY chat_id
  ), touched AS (
    UPDATE katibe.chat c
       SET message_count = COALESCE(s.n, 0), first_ts = s.first_ts, last_ts = s.last_ts
      FROM stat s
     WHERE s.chat_id = c.id
       AND (c.message_count, c.first_ts, c.last_ts)
           IS DISTINCT FROM (s.n::int, s.first_ts, s.last_ts)
    RETURNING 1
  ), pairs AS (
    SELECT m.chat_id, ms.source_id, count(*) AS messages
      FROM katibe.message m
      JOIN katibe.message_source ms ON ms.message_id = m.id
     GROUP BY 1, 2
  ), upserted AS (
    INSERT INTO katibe.chat_source (chat_id, source_id, messages)
    SELECT chat_id, source_id, messages FROM pairs
    ON CONFLICT (chat_id, source_id) DO UPDATE SET messages = EXCLUDED.messages
    RETURNING 1
  )
  -- A conversation can lose a source only if messages are deleted, which does
  -- not happen here; the delete is for completeness rather than for a case we
  -- expect to hit.
  DELETE FROM katibe.chat_source cs
   WHERE NOT EXISTS (SELECT 1 FROM pairs p
                      WHERE p.chat_id = cs.chat_id AND p.source_id = cs.source_id);
$$ LANGUAGE sql;

ALTER FUNCTION katibe.refresh_chat_stats() OWNER TO evolution;
