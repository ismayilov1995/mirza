-- Hər (söhbət, mənbə) cütü üçün son mesaj vaxtı.
--
-- NİYƏ. Yan paneldə nömrə seçiləndə siyahı düzgün daralırdı (yalnız həmin
-- nömrənin iştirak etdiyi söhbətlər), amma SƏTRİN İÇİ daralmırdı: önizləmə
-- mətni, son mesaj vaxtı və sıralama söhbətin BÜTÜN mənbələri üzrə
-- hesablanırdı. Nəticədə «Rouz-219» seçən adam sətirdə principal-ın son
-- mesajını oxuyurdu və seçimin mənası yox olurdu.
--
-- Sıralama səhifələmədən ƏVVƏL lazımdır, yəni onu sətir-sətir alt sorğu ilə
-- hesablamaq olmazdı (982 söhbət üçün 982 alt sorğu). `messages` sütunu onsuz
-- da burada denormalizasiya olunub — `last_ts` onun yanında öz yerindədir.
--
-- Yazan yeniləyir: katibe.refresh_chat_stats() hər köçürmədən sonra çağırılır
-- (mirror-evolution.ts). Ayrı cron və ya «sonra əl ilə» variantı seçilmir —
-- ayrılan iki addım nə vaxtsa ayrılmış qalır (docs/rules.md §8).

BEGIN;

ALTER TABLE katibe.chat_source ADD COLUMN IF NOT EXISTS last_ts integer;

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
    SELECT m.chat_id, ms.source_id, count(*) AS messages, max(m.ts) AS last_ts
      FROM katibe.message m
      JOIN katibe.message_source ms ON ms.message_id = m.id
     GROUP BY 1, 2
  ), upserted AS (
    INSERT INTO katibe.chat_source (chat_id, source_id, messages, last_ts)
    SELECT chat_id, source_id, messages, last_ts FROM pairs
    ON CONFLICT (chat_id, source_id) DO UPDATE
      SET messages = EXCLUDED.messages, last_ts = EXCLUDED.last_ts
    RETURNING 1
  )
  -- A conversation can lose a source only if messages are deleted, which does
  -- not happen here; the delete is for completeness rather than for a case we
  -- expect to hit.
  DELETE FROM katibe.chat_source cs
   WHERE NOT EXISTS (SELECT 1 FROM pairs p
                      WHERE p.chat_id = cs.chat_id AND p.source_id = cs.source_id);
$$ LANGUAGE SQL;

ALTER FUNCTION katibe.refresh_chat_stats() OWNER TO evolution;

COMMIT;

SELECT katibe.refresh_chat_stats();

SELECT count(*) AS cut, count(last_ts) AS vaxti_olan FROM katibe.chat_source;
