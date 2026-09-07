-- Status (story) axınlarını anbardan çıxarır.
--
-- NƏ İDİ. Arxiv idxalı ixracdakı hər "chat" sətrini söhbət sayırdı, o cümlədən
-- status yayımçılarını: 347 ədəd `<nömrə>@status` və bir dənə `status@broadcast`.
-- Onlardan 317-si BİR DƏNƏ də mesajı olmayan boş qabıq idi (ixrac yayımçının
-- adını saxlayır, postlarını yox), qalan 31-i isə 145 status postu daşıyırdı.
--
-- NİYƏ GEDİR. Status yazışma deyil — 24 saatlıq paylaşımdır və panelin hər
-- qatı onu onsuz da kənarda saxlayır: webhook `status@broadcast`-ı atır
-- (api/webhooks/evolution), nəzarətçi detektorları yalnız fərdi söhbətlərə
-- baxır, nəzarətçinin görmə qaydası `%@broadcast`-ı həmişə gizlədir
-- (access.ts). Yəni bu sətirlər heç bir ekranda işə yaramır, amma
-- `katibe.chat`-ın 6%-ni tutur və mənbəsi olmayan 317 söhbət kimi hər
-- baxışda sual doğurur.
--
-- YAYIM SİYAHISI QALIR. `<rəqəm>@broadcast` (bir söhbət, 14 mesaj) silinmir:
-- o, satıcının müştərilərə göndərdiyi həqiqi mesajdır. Fərq jiddədir, ona görə
-- şərt `kind = 'broadcast'` deyil, məhz status ünvanlarıdır.
--
-- ÜNVAN DOMENİ İLƏ, SONLUQ İLƏ YOX. Status axınının İKİ yazılışı var:
-- `<nömrə>@status` və `<lid>@lid.status` — ikincisi WhatsApp nömrəni gizlədən
-- @lid dövrünün formasıdır. `LIKE '%@status'` ikincisini BURAXIR: ilk gedişat
-- 348 sətri apardı, 19-u yerində qaldı. Domen üzrə müqayisə hər iki yazılışı
-- da tutur və gələcək üçüncüsünü də görünən edir (chat_jid-də domen siyahısı
-- beş dənədir, yenisi dərhal gözə dəyir).
--
-- TƏKRAR OLMAYACAQ: scripts/import-archive.ts artıq status söhbətlərini
-- idxal etmir (STATUS_KIND). Bu fayl yalnız artıq düşmüş sətirləri aparır.
--
-- Kaskad: chat → chat_jid, chat_source, message (→ message_source, media),
-- chunk, read_marker.

BEGIN;

CREATE TEMP TABLE status_chats ON COMMIT DROP AS
SELECT c.id
  FROM katibe.chat c
 WHERE EXISTS (
         SELECT 1 FROM katibe.chat_jid j
          WHERE j.chat_id = c.id
            AND (j.remote_jid = 'status@broadcast'
                 OR split_part(j.remote_jid, '@', 2) IN ('status', 'lid.status'))
       )
   -- Yalnız BÜTÜN ünvanları status olan söhbət. Bir söhbətə həm status, həm
   -- normal ünvan bağlanıbsa (birləşmə), onu silmək yazışmanı da aparardı.
   AND NOT EXISTS (
         SELECT 1 FROM katibe.chat_jid j2
          WHERE j2.chat_id = c.id
            AND j2.remote_jid <> 'status@broadcast'
            AND split_part(j2.remote_jid, '@', 2) NOT IN ('status', 'lid.status')
       );

SELECT count(*) AS silinecek_sohbet FROM status_chats;
SELECT count(*) AS silinecek_mesaj
  FROM katibe.message m JOIN status_chats s ON s.id = m.chat_id;

DELETE FROM katibe.chat c USING status_chats s WHERE s.id = c.id;

COMMIT;

-- Sayğaclar mesajdan hesablanır, ona görə silmədən sonra bir dəfə təzələnir.
SELECT katibe.refresh_chat_stats();
