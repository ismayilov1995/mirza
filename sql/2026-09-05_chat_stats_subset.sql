-- Statistikanı yalnız TOXUNULAN söhbətlər üçün yeniləmək.
--
-- NİYƏ. katibe.refresh_chat_stats() bütün anbarı yenidən sayır (~7 saniyə) və
-- bu, beş dəqiqəlik köçürmə üçün normal idi. İndi köçürmə vebhukdan da
-- çağırılır — mesaj gələn kimi, bir-iki sətir üçün — və orada yeddi saniyəlik
-- tam sayım həm mənasızdır, həm də hər gələn mesajda təkrarlanardı.
--
-- Arqumentli variant AYRI funksiya deyil, eyni funksiyanın yükləməsidir:
-- hesablama düsturu bir yerdə qalsın deyə. Bir fərq var və qəsdəndir —
-- burada chat_source-dan SİLMƏ yoxdur: alt çoxluğa baxan sorğu «bu cütün
-- mesajı qalmayıb» sualına cavab verə bilməz.

BEGIN;

CREATE OR REPLACE FUNCTION katibe.refresh_chat_stats(chats bigint[]) RETURNS void AS $$
  WITH stat AS (
    SELECT m.chat_id, count(*) AS n, min(m.ts) AS first_ts, max(m.ts) AS last_ts
      FROM katibe.message m
     WHERE m.chat_id = ANY(chats)
     GROUP BY m.chat_id
  ), touched AS (
    UPDATE katibe.chat c
       SET message_count = COALESCE(s.n, 0), first_ts = s.first_ts, last_ts = s.last_ts
      FROM stat s
     WHERE s.chat_id = c.id
       AND (c.message_count, c.first_ts, c.last_ts)
           IS DISTINCT FROM (s.n::int, s.first_ts, s.last_ts)
    RETURNING 1
  ), pairs AS (
    SELECT m.chat_id, ms.source_id, count(*) AS messages, max(m.ts) AS last_ts
      FROM katibe.message m
      JOIN katibe.message_source ms ON ms.message_id = m.id
     WHERE m.chat_id = ANY(chats)
     GROUP BY 1, 2
  )
  INSERT INTO katibe.chat_source (chat_id, source_id, messages, last_ts)
  SELECT chat_id, source_id, messages, last_ts FROM pairs
  ON CONFLICT (chat_id, source_id) DO UPDATE
    SET messages = EXCLUDED.messages, last_ts = EXCLUDED.last_ts;
$$ LANGUAGE SQL;

ALTER FUNCTION katibe.refresh_chat_stats(bigint[]) OWNER TO evolution;

COMMIT;
