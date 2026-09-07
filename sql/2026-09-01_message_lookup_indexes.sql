-- Söhbət ekranının iki yeni axtarışı üçün indekslər.
--
-- Hər ikisi bu gün əlavə olunan iki funksiyanın qiymətidir və ikisi də ÖLÇÜLƏRƏK
-- tapıldı, təxmin edilərək yox: yeni funksiya işlədi, səhifə 13,7 saniyəyə
-- çıxdı, plan oxundu, indeks quruldu, yenidən ölçüldü — 143 ms.
--
-- 1. CAVAB KONTEKSTİ. «Bu mesaj kimə cavabdır» üçün eyni söhbətdə stanza ID
--    axtarılır. Mövcud unikal indeks (remote_jid, stanza_id) bu axtarışa
--    yaramır, ona görə plan söhbətin BÜTÜN mesajlarını (40 310 sətir) bitmap
--    ilə oxuyub filtrləyirdi — hər cavab üçün ayrıca, 24 ms.
--
-- 2. TEQLƏR. «@12345…» teqinin sahibini tapmaq üçün sender_jid ilə axtarış
--    lazımdır; belə indeks ümumiyyətlə yox idi və 1,6 milyon sətir taranırdı.
--    Qismən indeksdir (sender_name IS NOT NULL): adı olmayan sətir bu axtarışa
--    onsuz da cavab vermir, ona görə indeksə düşməsinin mənası yoxdur.
--
-- CONCURRENTLY: cədvəl canlıdır və 1,6 milyon sətirdir; adi CREATE INDEX
-- yazmanı kilidləyərdi. Ona görə bu fayl tranzaksiyasızdır — CONCURRENTLY
-- BEGIN/COMMIT içində işləmir.

CREATE INDEX CONCURRENTLY IF NOT EXISTS message_chat_stanza_idx
  ON katibe.message (chat_id, stanza_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS message_sender_idx
  ON katibe.message (sender_jid, ts DESC)
  WHERE sender_name IS NOT NULL;
