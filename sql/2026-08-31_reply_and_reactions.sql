-- Cavab istinadlarını doldurur, reaksiya/protokol sətirlərini çıxarır.
--
-- 1. CAVAB. «Bu mesaj kimə cavabdır» sualına panel heç vaxt cavab verə
--    bilmirdi: köçürmə `reply_to` sütununu ÜMUMİYYƏTLƏ yazmırdı. Anbardakı
--    1 667 596 mesajdan yalnız 6-sında istinad vardı (onlar da arxiv
--    ixracından gəlib və hədəfləri anbarda yoxdur).
--
--    WhatsApp istinadı `contextInfo.stanzaId`-də saxlayır, amma hansı açarın
--    altında olduğu mesaj tipindən asılıdır — ona görə jsonb yol axtarışı
--    işlədilir, açar siyahısı yox: yeni tip çıxanda siyahı köhnəlmir.
--
-- 2. REAKSİYA VƏ PROTOKOL. Reaksiya başqa mesaja qoyulan emojidir, protokol
--    mesajı isə texniki siqnaldır (silinmə, şifrə yenilənməsi). Köçürmə onları
--    adi mesaj kimi yazırdı və söhbətdə «reactionMessage — fayl yoxdur» sətri
--    kimi görünürdülər: nə mətn, nə fayl, nə məna.
--
-- TƏKRAR OLMAYACAQ: scripts/mirror-evolution.ts artıq istinadı yazır və bu iki
-- tipi köçürmür. Bu fayl yalnız mövcud sətirləri düzəldir.

BEGIN;

-- --- 1. cavab istinadları -------------------------------------------------
UPDATE katibe.message m
   SET reply_to = q.stanza
  FROM (
    SELECT ms.message_id,
           jsonb_path_query_first(e.message, '$.**.contextInfo.stanzaId') #>> '{}' AS stanza
      FROM katibe.message_source ms
      JOIN katibe.source src ON src.id = ms.source_id AND src.kind = 'evolution'
      JOIN evolution_api."Message" e ON e.id = ms.external_id
     WHERE jsonb_path_query_first(e.message, '$.**.contextInfo.stanzaId') IS NOT NULL
  ) q
 WHERE q.message_id = m.id
   AND q.stanza IS NOT NULL
   AND m.reply_to IS NULL;

-- --- 2. yazışma olmayan sətirlər ------------------------------------------
-- Kaskad: message → message_source, media.
DELETE FROM katibe.message WHERE kind IN ('reactionMessage', 'protocolMessage');

COMMIT;

-- Sayğaclar mesajdan hesablanır — silmədən sonra bir dəfə təzələnir.
SELECT katibe.refresh_chat_stats();

SELECT
  (SELECT count(*) FROM katibe.message WHERE reply_to IS NOT NULL) AS istinadi_olan,
  (SELECT count(*) FROM katibe.message m
     JOIN katibe.message t ON t.chat_id = m.chat_id AND t.stanza_id = m.reply_to
    WHERE m.reply_to IS NOT NULL) AS hedefi_tapilan,
  (SELECT count(*) FROM katibe.message WHERE kind IN ('reactionMessage','protocolMessage')) AS qalan_zibil;
