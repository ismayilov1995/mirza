-- Söhbət statistikasının sürüşməsi: itirilən yeniləmə (lost update).
--
-- SİMPTOM. katibe.chat_source.messages siyahıda «N mesaj» sayını, last_ts isə
-- nömrə seçiləndə sətrin içindəki son mesaj vaxtını və sıralamanı verir.
-- 2026-09-06 axşamı, tam yenidən hesablamadan ~80 dəqiqə sonra üç cüt sürüşmüşdü
-- (hər biri bir mesaj geri), birinin son mesaj vaxtı isə DOQQUZ SAAT köhnə idi.
-- Tam yenidən hesablamadan iki dəqiqə sonra yenidən bir cüt sürüşdü — davamlıdır.
--
-- SƏBƏB, ayrıca sxemdə təkrarlanıb sübut edildi. READ COMMITTED-də anlıq görüntü
-- İFADƏNİN BAŞLANĞICINDA götürülür və funksiyanın gövdəsi bir ifadə idi, yəni
-- say ilə yazı arasında keçən bütün müddətdə funksiya köhnə dünyanı görürdü:
--
--   A başlayır (2 mesaj görür) ─────────────────────► A 2 yazır
--            B: 3-üncü mesaj gəlir → B 3 yazır ─┘
--   nəticə: 2. Həqiqət: 3.
--
-- Ölçmə (race sxemi, pg_sleep ilə genişləndirilmiş pəncərə):
--   düzəlişdən əvvəl → chat_source 2 / 200,  həqiqət 3 / 300   ← itirilib
--   düzəlişdən sonra → chat_source 3 / 300,  həqiqət 3 / 300   ← düzgün
--
-- Vebhuk yolu hər gələn mesajda yeniləmə işlətdiyi üçün belə üst-üstə düşmələr
-- nadir hal deyil, adi haldır.
--
-- DÜZƏLİŞ. Hesablamadan ƏVVƏL söhbət sətri kilidlənir. Funksiya çağırışı bir
-- tranzaksiyadır, yəni kilid sonadək saxlanılır; ikinci ifadə isə READ
-- COMMITTED-də YENİ anlıq görüntü götürür və kilidi gözləyərkən commit olunan
-- hər şeyi görür. Beləliklə eyni söhbət üçün iki yeniləmə növbəyə düzülür və
-- sonuncu həmişə ən təzə sayı yazır.
--
-- ORDER BY id — hər iki yükləmə kilidləri EYNİ ardıcıllıqla alsın deyə, yoxsa
-- tam və alt-çoxluq variantları bir-birini deadlock-a sala bilərdi.
--
-- Saatlıq barışdırma (scripts/reconcile-chat-stats.ts) qalır: kilid yarışı
-- kəsir, amma proses öldürülməsi və ya gələcək başqa bir səbəb üçün müstəqil
-- yoxlama hələ də lazımdır — sürüşənin sayı loga düşür.

BEGIN;

-- ALT ÇOXLUQ — vebhuk və köçürmə yolu (əsas yük buradadır).
CREATE OR REPLACE FUNCTION katibe.refresh_chat_stats(chats bigint[]) RETURNS void AS $$
  SELECT 1 FROM katibe.chat WHERE id = ANY(chats) ORDER BY id FOR UPDATE;

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

-- TAM — saatlıq barışdırma. Bura da kilid lazımdır: kilidsiz variant təmir
-- edərkən özü də köhnə say yazıb təzəsini poza bilərdi. Bütün söhbətlər ~5
-- saniyəyə kilidlənir; saatda bir dəfə bu qəbul ediləndir və vebhuk yolu
-- yalnız gözləyir, itirmir.
CREATE OR REPLACE FUNCTION katibe.refresh_chat_stats() RETURNS void AS $$
  SELECT 1 FROM katibe.chat ORDER BY id FOR UPDATE;

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
  -- Söhbət mənbəsini yalnız mesajlar silinəndə itirə bilir; bu, burada baş
  -- vermir. Silmə tamlıq üçündür, gözlədiyimiz hal üçün deyil.
  DELETE FROM katibe.chat_source cs
   WHERE NOT EXISTS (SELECT 1 FROM pairs p
                      WHERE p.chat_id = cs.chat_id AND p.source_id = cs.source_id);
$$ LANGUAGE SQL;

ALTER FUNCTION katibe.refresh_chat_stats() OWNER TO evolution;

COMMIT;
