-- Mesaj tiplərini düzəldir: xam adlar ekrandan çıxır, gizlənmiş fayllar açılır.
--
-- NƏ İDİ. Köçürmə tanımadığı `messageType`-ı olduğu kimi saxlayırdı və söhbətdə
-- «ptvMessage — fayl yoxdur», «albumMessage — fayl yoxdur», «secretEncrypted
-- Message — fayl yoxdur» sətirləri görünürdü. İki ayrı problem bir yerdə idi:
--
--   1. FAYLI OLANLAR. `associatedChildMessage` (albom uşağı) altında 1 735
--      real şəkil/video, `ptvMessage`-də 26 video, `lottieStickerMessage`-də
--      12 stiker vardı. Bubble bu sözləri tanımadığı üçün nə şəkli çəkirdi, nə
--      də adını düzgün yazırdı — fayl var idi, sadəcə görünmürdü.
--
--   2. BOŞ OLANLAR. `albumMessage` (uşaqları ayrıca gəlir), `secretEncrypted
--      Message`, `pinInChatMessage`, `groupInviteMessage`, `interactiveMessage`
--      — nə mətni var, nə faylı. Onlar yazışma deyil.
--
-- Albomun uşağının öz tipi yoxdur, amma faylın YOLU var: Evolution obyekti
-- `…/imageMessage/…` qovluğuna qoyur, yəni tip elə açardadır.
--
-- TƏKRAR OLMAYACAQ: mirror-evolution.ts artıq həm xəritəni, həm süzgəci
-- daşıyır. Bu fayl yalnız mövcud sətirləri düzəldir.

BEGIN;

-- --- 1. faylı olan tiplər öz adına qayıdır ---------------------------------
UPDATE katibe.message m
   SET kind = CASE
     WHEN md.object_key LIKE '%/imageMessage/%' THEN 'image'
     WHEN md.object_key LIKE '%/videoMessage/%' THEN 'video'
     WHEN md.object_key LIKE '%/audioMessage/%' THEN 'audio'
     WHEN md.object_key LIKE '%/documentMessage/%' THEN 'document'
     WHEN md.object_key LIKE '%/stickerMessage/%' THEN 'sticker'
     ELSE 'other'
   END
  FROM katibe.media md
 WHERE md.message_id = m.id
   AND m.kind = 'associatedChildMessage'
   AND md.object_key IS NOT NULL;

UPDATE katibe.message SET kind = 'video'    WHERE kind = 'ptvMessage';
UPDATE katibe.message SET kind = 'sticker'  WHERE kind = 'lottieStickerMessage';
UPDATE katibe.message SET kind = 'location' WHERE kind = 'locationMessage';
UPDATE katibe.message SET kind = 'contact'  WHERE kind = 'contactMessage';

-- Faylsız qalan albom uşaqları: qabıq sətirdir, məzmunu yoxdur.
DELETE FROM katibe.message WHERE kind = 'associatedChildMessage';

-- --- 2. yazışma olmayan tiplər ---------------------------------------------
DELETE FROM katibe.message
 WHERE kind IN ('albumMessage', 'secretEncryptedMessage', 'pinInChatMessage',
                'groupInviteMessage', 'interactiveMessage');

COMMIT;

SELECT katibe.refresh_chat_stats();

SELECT kind, count(*) FROM katibe.message
 WHERE kind NOT IN ('text','image','audio','video','document','sticker','link',
                    'contact','location','system')
 GROUP BY 1 ORDER BY 2 DESC;
