import { pool } from "./db";

/*
 * Evolution-un mesajlarını Katibe-nin öz anbarına köçürmək.
 *
 * BURADA YAŞAYIR, SKRİPTDƏ YOX. Köçürmə əvvəl yalnız beş dəqiqəlik cron idi
 * (scripts/mirror-evolution.ts) və ekran anbarı oxuduğu üçün gələn cavab beş
 * dəqiqəyədək görünmürdü: telefonda mesaj var, paneldə yox. İndi eyni sorğu
 * vebhukdan da çağırılır (api/webhooks/evolution) — mesaj gələn kimi, bir
 * neçə sətir üçün. Sorğunun İKİ nüsxəsi olmamalıdır: biri düzələndə o birinin
 * unudulması ən adi səhvdir (docs/rules.md §8).
 *
 * IDEMPOTENT BY CONSTRUCTION: iki dəfə işləmək heç nəyi dəyişmir, yarımçıq
 * qalan gediş qaldığı yerdən davam edir, başqa mənbənin onsuz da daşıdığı
 * mesaj təkrar sətir yox, əlaqə qazanır. Görüləsi işi
 * katibe.message_source-a anti-join ilə tapır.
 *
 * WhatsApp-a münasibətdə yalnız oxu: Baileys-in artıq yazdığı sətirləri
 * köçürür.
 */

/** Text lives in a different place per message type; media may carry none. */
const BODY_SQL = `COALESCE(
  m.message->>'conversation',
  m.message->'extendedTextMessage'->>'text',
  m.message->'imageMessage'->>'caption',
  m.message->'videoMessage'->>'caption',
  m.message->'documentMessage'->>'fileName'
)`;

/**
 * The identity a conversation keeps when its address changes.
 *
 * A bare number where one is known, so the same person's @lid and
 * @s.whatsapp.net chats land on one key; the jid itself otherwise. Groups keep
 * their jid — a group is not a person and has nothing to merge with.
 *
 * The @lid bridge reaches 22.3% of those chats today (53.3% of their
 * messages). The rest keep their jid as the key and simply stay separate,
 * merging later as numbers are harvested — nothing has to be rebuilt for that,
 * because merging is a row in katibe.chat_jid, not a data migration.
 */
const PERSON_KEY_SQL = `CASE
  WHEN m.key->>'remoteJid' LIKE '%@s.whatsapp.net'
    THEN split_part(m.key->>'remoteJid', '@', 1)
  WHEN m.key->>'remoteJid' LIKE '%@lid' AND ln.phone_number IS NOT NULL
    THEN ln.phone_number
  ELSE m.key->>'remoteJid'
END`;

const CHAT_KIND_SQL = `CASE
  WHEN m.key->>'remoteJid' LIKE '%@g.us' THEN 'group'
  WHEN m.key->>'remoteJid' LIKE '%@broadcast' THEN 'broadcast'
  WHEN m.key->>'remoteJid' LIKE '%@s.whatsapp.net' THEN 'individual'
  WHEN m.key->>'remoteJid' LIKE '%@lid' AND ln.phone_number IS NOT NULL THEN 'individual'
  WHEN m.key->>'remoteJid' LIKE '%@lid' THEN 'lid'
  ELSE 'other'
END`;

/**
 * Evolution's messageType, reduced to the vocabulary this store uses.
 *
 * XAM AD EKRANA ÇIXMAMALIDIR. `ELSE` qolu tanımadığı tipi olduğu kimi
 * saxlayır və söhbətdə «ptvMessage — fayl yoxdur» kimi sətirlər görünürdü:
 * fayl əslində VAR idi, sadəcə Bubble həmin sözü tanımadığı üçün nə şəkli
 * çəkirdi, nə də düzgün adı yazırdı. Ən pisi albom uşaqları idi —
 * `associatedChildMessage` altında 1 735 real şəkil belə gizlənmişdi.
 *
 * Albomun uşağının öz tipi yoxdur, amma faylın yolu var: Evolution obyekti
 * `…/imageMessage/…` qovluğuna qoyur, yəni tip elə yoldadır.
 */
const KIND_SQL = `CASE
  WHEN m."messageType" IN ('conversation', 'extendedTextMessage') THEN 'text'
  WHEN m."messageType" = 'imageMessage' THEN 'image'
  WHEN m."messageType" = 'audioMessage' THEN 'audio'
  WHEN m."messageType" IN ('videoMessage', 'ptvMessage') THEN 'video'
  WHEN m."messageType" = 'documentMessage' THEN 'document'
  WHEN m."messageType" IN ('stickerMessage', 'lottieStickerMessage') THEN 'sticker'
  WHEN m."messageType" = 'locationMessage' THEN 'location'
  WHEN m."messageType" = 'contactMessage' THEN 'contact'
  WHEN m."messageType" = 'associatedChildMessage' THEN
    /* İki düzülüş var: adi mediada tip qovluğun adındadır
       (…/imageMessage/…), albom uşağında isə yalnız uzantı qalır
       (<jid>/8/1/<uuid>.jpg). Ona görə əvvəl qovluğa, sonra uzantıya baxılır. */
    CASE
      WHEN m.message->>'mediaUrl' LIKE '%/imageMessage/%' THEN 'image'
      WHEN m.message->>'mediaUrl' LIKE '%/videoMessage/%' THEN 'video'
      WHEN m.message->>'mediaUrl' LIKE '%/audioMessage/%' THEN 'audio'
      WHEN m.message->>'mediaUrl' LIKE '%/documentMessage/%' THEN 'document'
      WHEN split_part(split_part(m.message->>'mediaUrl', '?', 1), '.',
             array_length(string_to_array(split_part(m.message->>'mediaUrl', '?', 1), '.'), 1))
           IN ('jpg', 'jpeg', 'png', 'webp', 'gif') THEN 'image'
      WHEN split_part(split_part(m.message->>'mediaUrl', '?', 1), '.',
             array_length(string_to_array(split_part(m.message->>'mediaUrl', '?', 1), '.'), 1))
           IN ('mp4', 'mov', '3gp') THEN 'video'
      WHEN split_part(split_part(m.message->>'mediaUrl', '?', 1), '.',
             array_length(string_to_array(split_part(m.message->>'mediaUrl', '?', 1), '.'), 1))
           IN ('oga', 'ogg', 'opus', 'm4a', 'mp3') THEN 'audio'
      WHEN m.message->>'mediaUrl' IS NOT NULL THEN 'document'
      ELSE 'other'
    END
  ELSE COALESCE(m."messageType", 'other')
END`;

/**
 * Köçürülməyən tiplər — SAYĞAC DA BUNU İŞLƏTMƏLİDİR.
 *
 * Reaksiya başqa mesaja qoyulan emojidir, protokol mesajı texniki siqnaldır;
 * qalanlarının isə nə mətni var, nə faylı (albom qabı — uşaqları ayrıca gəlir,
 * şifrəli sistem mesajı, qrupa dəvət, sancaq). Söhbətdə «albumMessage — fayl
 * yoxdur» sətri kimi görünürdülər.
 *
 * Siyahı bir dənədir, çünki iki nüsxə dərhal ayrıldı: skriptin «neçə mesaj
 * gözləyir» sayğacı köhnə, qısa siyahını işlədirdi və ona görə 1 167 mesaj
 * gözləyir yazırdı — halbuki köçürüləsi yalnız 3-ü idi, qalan 1 164-ü heç vaxt
 * köçürülməyəcək. Sayğacın yalanı burada təhlükəlidir: «köçürmə dayanıb» kimi
 * oxunur.
 */
export const COPYABLE_SQL = `m."messageType" NOT IN (
  'reactionMessage', 'protocolMessage', 'albumMessage',
  'secretEncryptedMessage', 'pinInChatMessage',
  'groupInviteMessage', 'interactiveMessage'
)`;

/**
 * «Bu mənbə bu mesajı artıq köçürüb?» — SAYĞAC DA BUNU İŞLƏTMƏLİDİR.
 *
 * İKİ QOL, ÇÜNKİ BİR QOL SONSUZ DÖNGƏ YARADIRDI.
 *
 * Birinci qol açıq olanıdır: elə bu Evolution sətri bağlanıbmı.
 *
 * İkinci qol Evolution-un EYNİ mesajı İKİ SƏTİR kimi saxladığı hal üçündür
 * (fərqli `id`, eyni `remoteJid`+`stanzaId`). Anbarda onlar bir mesaja yığılır
 * — `katibe.message` unikal açarı `(remote_jid, stanza_id)`-dir. Amma
 * `katibe.message_source`-un birincil açarı `(message_id, source_id)`-dir, yəni
 * bir mənbə bir mesaj üçün YALNIZ BİR `external_id` yaza bilər. Ona görə ikinci
 * sətir heç vaxt öz `external_id`-si ilə bağlana bilmir:
 *
 *     tapılır → yazılmağa çalışılır → ON CONFLICT köhnə sətri yeniləyir
 *     → yenidən tapılır → …
 *
 * Yalnız birinci qol olanda `mirror-evolution.ts`-in `for(;;)` döngəsi
 * `read === 0` şərtinə HEÇ VAXT çatmırdı. 2026-09-06-da ölçüldü: gözləyən 3
 * mesaj, sayğac 6 746 — eyni üç sətir 2 248 dəfə oxunub. Cron hər 5 dəqiqədən
 * bir yenisini açdığı üçün 4 saatda 243 proses yığılmışdı, 2 nüvəli maşında
 * load average 37, swap 4 GB-dan 3.7 GB dolu, bütün panel dayanmışdı.
 *
 * İkinci qol sualı düzgün qoyur: «bu mesaj bu mənbədən anbardadırmı», «bu SƏTİR
 * bağlanıbmı» yox. Cavab köçürmədən dərhal sonra «bəli» olur, yəni görüləsi iş
 * yenə də məlumatın öz faktıdır — sadəcə indi bitə bilən faktdır.
 *
 * Məlumat itmir: mesajın özü onsuz da birinci gedişdə yazılır və `ins`-dəki
 * COALESCE birləşməsi orada baş verir; ikinci sətrin əlavə verəcəyi heç nə
 * yoxdur, çünki mətn və istinad artıq doludur.
 *
 * `$1` mənbə (instans) ID-sidir, `m` isə evolution_api."Message" aliasıdır —
 * hər iki çağırış yerində belədir.
 */
export const ALREADY_MIRRORED_SQL = `(
  EXISTS (
    SELECT 1 FROM katibe.message_source ms
     WHERE ms.source_id = $1 AND ms.external_id = m.id)
  OR EXISTS (
    SELECT 1 FROM katibe.message km
      JOIN katibe.message_source ms2
        ON ms2.message_id = km.id AND ms2.source_id = $1
     WHERE km.remote_jid = m.key->>'remoteJid'
       AND km.stanza_id = m.key->>'id')
)`;

export interface MirrorResult {
  /** Bu gedişdə oxunan (köçürüləsi) sətir sayı. */
  read: number;
  wrote: number;
  linked: number;
  /**
   * Yeni yazılan mənbə əlaqəsi — yenilənən yox.
   *
   * İRƏLİLƏYİŞİN YEGANƏ DÜRÜST ÖLÇÜSÜ. `linked` ON CONFLICT qolunu da sayır,
   * yəni sıfırdan böyük ola-ola gözləyənlərin sayı dəyişməyə bilər; döngə
   * məhz buna görə dayana bilmirdi (bax ALREADY_MIRRORED_SQL).
   */
  linkedNew: number;
  /** Toxunulan söhbətlər — statistika yalnız onlar üçün yenilənir. */
  chatIds: number[];
}

/**
 * Bir instansın köçürülməmiş mesajlarından ən çoxu `limit` ədədi.
 *
 * Bir ifadə: ya bütöv düşür, ya heç. Öldürülmüş gedişi sadəcə yenidən
 * işlətmək təhlükəsizdir.
 */
export async function mirrorBatch(
  instanceId: string,
  limit: number,
  bucket: string,
  /** Yalnız bu vaxtdan sonrakı mesajlar; null = hamısı. */
  sinceTs: number | null = null,
): Promise<MirrorResult> {
  const { rows } = await pool.query(`WITH src AS (
             SELECT m.id AS external_id,
                    m.key->>'remoteJid' AS remote_jid,
                    m.key->>'id' AS stanza_id,
                    m."messageTimestamp" AS ts,
                    CASE WHEN (m.key->>'fromMe')::boolean THEN 'out' ELSE 'in' END AS direction,
                    m.key->>'participant' AS sender_jid,
                    m."pushName" AS sender_name,
                    ${BODY_SQL} AS body,
                    ${KIND_SQL} AS kind,
                    ${PERSON_KEY_SQL} AS person_key,
                    ${CHAT_KIND_SQL} AS chat_kind,
                    /*
                     * Cavab verilən mesajın ID-si.
                     *
                     * WhatsApp onu contextInfo-da saxlayır, amma HANSI açarın
                     * altında olduğu mesaj tipindən asılıdır
                     * (extendedTextMessage, imageMessage, …). jsonb yol
                     * axtarışı tipi soruşmadan birincisini tapır — yəni yeni
                     * mesaj tipi çıxanda siyahı köhnəlmir.
                     *
                     * Bu sütun köçürmədə ÜMUMİYYƏTLƏ yox idi: anbardakı 1,67
                     * milyon mesajdan yalnız 6-sında cavab istinadı vardı
                     * (onlar da arxiv ixracından) və heç bir ekran «bu mesaj
                     * kimə cavabdır» sualına cavab verə bilmirdi.
                     */
                    jsonb_path_query_first(m.message,
                      '$.**.contextInfo.stanzaId') #>> '{}' AS reply_to,
                    m.message->>'mediaUrl' AS media_url,
                    -- Presigned ünvandan yalnız yol qalır; qalan iki addım
                    -- aşağıda, med CTE-sindədir.
                    regexp_replace(split_part(m.message->>'mediaUrl', '?', 1),
                                   '^https?://[^/]+/', '') AS media_path
               FROM evolution_api."Message" m
               LEFT JOIN katibe.lid_number ln ON ln.lid_jid = m.key->>'remoteJid'
              WHERE m."instanceId" = $1
                /*
                 * Vaxt həddi — VEBHUK YOLU ÜÇÜN.
                 *
                 * Sorğu köçürüləsi sətri anti-join ilə tapır və ən köhnədən
                 * başlayır; demək olar hər şey artıq köçürülüb, ona görə beş
                 * yeni sətri tapmaq üçün instansın bütün tarixçəsi taranırdı:
                 * ölçülüb — 3 984 ms. Hər gələn mesajda dörd saniyə qəbul
                 * edilməzdir. Hədd verilsə (instanceId, messageTimestamp)
                 * indeksi işə düşür; skript isə NULL verir və heç nə dəyişmir.
                 */
                AND ($4::int IS NULL OR m."messageTimestamp" >= $4)
                AND m.key->>'id' IS NOT NULL
                /*
                 * Reaksiya və protokol mesajları YAZIŞMA DEYİL.
                 *
                 * Reaksiya başqa mesaja qoyulan emojidir, protokol mesajı isə
                 * texniki siqnaldır (silinmə, şifrə yenilənməsi). Köçürmə
                 * onları adi mesaj kimi yazırdı və söhbətdə «reactionMessage —
                 * fayl yoxdur» sətri kimi görünürdülər: mətn yox, fayl yox,
                 * mənası yox — sadəcə oxunuşu pozan sətir.
                 */
                /*
                 * Mətni də, faylı da olmayan tiplər: albom qabı (uşaqları
                 * ayrıca gəlir), şifrəli sistem mesajı, qrupa dəvət, sancaq.
                 * Onlar söhbətdə «albumMessage — fayl yoxdur» sətri kimi
                 * görünürdü — nə mətn, nə fayl, nə məna.
                 */
                AND ${COPYABLE_SQL}
                AND NOT ${ALREADY_MIRRORED_SQL}
              ORDER BY m."messageTimestamp"
              LIMIT $2
           ),
           -- Chats first: a message cannot be inserted before the conversation
           -- it belongs to exists.
           new_chat AS (
             INSERT INTO katibe.chat (person_key, kind)
             SELECT DISTINCT person_key, chat_kind FROM src
             ON CONFLICT (person_key) DO UPDATE SET updated_at = now()
             RETURNING id, person_key
           ),
           chat_map AS (
             SELECT person_key, id FROM new_chat
             UNION
             SELECT c.person_key, c.id FROM katibe.chat c
              WHERE c.person_key IN (SELECT person_key FROM src)
           ),
           -- Recording the address is what lets a second address for the same
           -- person merge into this chat later.
           jid_link AS (
             INSERT INTO katibe.chat_jid (remote_jid, chat_id)
             SELECT DISTINCT s.remote_jid, cm.id
               FROM src s JOIN chat_map cm ON cm.person_key = s.person_key
             ON CONFLICT (remote_jid) DO NOTHING
             RETURNING 1
           ),
           ins AS (
             INSERT INTO katibe.message
               (chat_id, remote_jid, stanza_id, ts, direction, sender_jid,
                sender_name, body, kind, reply_to)
             SELECT DISTINCT ON (s.remote_jid, s.stanza_id)
                    cm.id, s.remote_jid, s.stanza_id, s.ts, s.direction,
                    s.sender_jid, s.sender_name, s.body, s.kind, s.reply_to
               FROM src s JOIN chat_map cm ON cm.person_key = s.person_key
              ORDER BY s.remote_jid, s.stanza_id, s.ts
             ON CONFLICT (remote_jid, stanza_id) DO UPDATE
               -- The earliest timestamp wins: instances record their own
               -- receipt time and 5,104 duplicate keys disagree about it, so
               -- the smallest is the closest to when it was actually sent.
               SET ts = LEAST(katibe.message.ts, EXCLUDED.ts),
                   body = COALESCE(katibe.message.body, EXCLUDED.body),
                   -- Bir mənbə istinadı bilirsə, o qalır: arxiv ixracı onu
                   -- saxlamır, Evolution isə saxlayır.
                   reply_to = COALESCE(katibe.message.reply_to, EXCLUDED.reply_to),
                   sender_name = COALESCE(katibe.message.sender_name, EXCLUDED.sender_name),
                   -- 'out' if ANY instance sent it. In a group our own message
                   -- reads as incoming to our other phones (8,933 messages
                   -- disagree this way), and the question the dashboard asks
                   -- is whether OUR SIDE sent it, not which phone did.
                   direction = CASE WHEN katibe.message.direction = 'out'
                                      OR EXCLUDED.direction = 'out'
                                    THEN 'out' ELSE 'in' END
             RETURNING id, chat_id, remote_jid, stanza_id
           ),
           linked AS (
             INSERT INTO katibe.message_source
               (message_id, source_id, external_id, direction)
             -- direction kept exactly as this instance saw it, so the
             -- comparison against Evolution can stay strict.
             /*
              * DISTINCT ON (i.id) — bir dəstədə eyni mesajın iki Evolution
              * sətri ola bilər (yuxarıda, ALREADY_MIRRORED_SQL). Onda bu
              * INSERT eyni (message_id, source_id) cütünü iki dəfə yazmağa
              * çalışırdı və Postgres bütün dəstəni ləğv edirdi: «ON CONFLICT
              * DO UPDATE command cannot affect row a second time». Dəstə
              * bütövlükdə düşdüyü üçün gediş də dayanırdı.
              */
             SELECT DISTINCT ON (i.id) i.id, $1, s.external_id, s.direction
               FROM ins i JOIN src s
                 ON s.remote_jid = i.remote_jid AND s.stanza_id = i.stanza_id
              ORDER BY i.id, s.external_id
             ON CONFLICT (message_id, source_id) DO UPDATE
               SET direction = EXCLUDED.direction
             /*
              * xmax = 0 YENİ sətir deməkdir, yenilənmiş yox. Çağıran buna
              * görə irəliləyişin olub-olmadığını bilir: ON CONFLICT qolu
              * işləyəndə də sətir qaytarılır, yəni sadə count(*) «iş
              * gördüm» kimi oxunur, halbuki gözləyənlərin sayı azalmır.
              */
             RETURNING (xmax = 0) AS is_new
           ),
           -- Media is a pointer, never a copy: the archive alone is 75.57 GB
           -- against 43 GB free on this host.
           med AS (
             INSERT INTO katibe.media (message_id, storage, object_key)
             SELECT i.id,
                    CASE WHEN s.media_url IS NULL THEN 'absent' ELSE 'evolution' END,
                    /*
                     * Saxlanılan ünvan presigned-dır və vaxtı bitir; davamlı
                     * olan yalnız obyektin açarıdır. Ünvandan açara üç addım
                     * var və üçü də lazımdır — biri buraxılanda fayl S3-dən
                     * OXUNMUR (2 103 media məhz belə itmişdi):
                     *
                     *   1. sorğu sətri atılır (yuxarıda, media_path),
                     *   2. yolun birinci hissəsi bucket adıdır — o da atılır,
                     *      çünki ünvan https://<endpoint>/<bucket>/<açar>
                     *      üslubundadır,
                     *   3. faiz kodlaşdırması açılır: URL-də @ → %40,
                     *      boşluq → %20, İ → %C4%B0; həqiqi açarda isə onlar
                     *      olduğu kimidir.
                     */
                    CASE WHEN s.media_url IS NULL THEN NULL
                         ELSE katibe.url_decode(
                                CASE WHEN strpos(s.media_path, $3 || '/') = 1
                                     THEN substr(s.media_path, length($3) + 2)
                                     ELSE s.media_path END)
                    END
               FROM ins i JOIN src s
                 ON s.remote_jid = i.remote_jid AND s.stanza_id = i.stanza_id
              WHERE s.kind <> 'text'
             ON CONFLICT (message_id) DO NOTHING
             RETURNING 1
           )
           SELECT (SELECT count(*) FROM src) AS read,
                  (SELECT count(*) FROM ins) AS wrote,
                  (SELECT count(*) FROM linked) AS linked,
                  (SELECT count(*) FROM linked WHERE is_new) AS linked_new,
                  /* Hansı söhbətlərə toxunuldu — statistikanı yalnız onlar
                     üçün yeniləmək lazımdır (refreshChatStats). */
                  (SELECT array_agg(DISTINCT chat_id) FROM ins) AS chat_ids`, [instanceId, limit, bucket, sinceTs]);
  return {
    read: Number(rows[0].read),
    wrote: Number(rows[0].wrote),
    linked: Number(rows[0].linked),
    linkedNew: Number(rows[0].linked_new),
    chatIds: ((rows[0].chat_ids as (string | number)[] | null) ?? []).map(Number),
  };
}

/**
 * Söhbətin sayları və son mesaj vaxtı — YAZAN yeniləyir.
 *
 * Siyahının sıralaması və «N mesaj» sayı bu sütunlardan gəlir; köçürmə onları
 * pozur. Ayrı cron variantı qəsdən seçilmir: ayrılan iki addım nə vaxtsa
 * ayrılmış qalır (sql/2026-09-01_chat_source_last_ts.sql).
 *
 * `chatIds` verilirsə yalnız o söhbətlər hesablanır — vebhuk yolu bir mesaj
 * üçün bütün anbarı (~7 saniyə) yenidən saymamalıdır.
 */
export async function refreshChatStats(chatIds?: number[]): Promise<void> {
  if (chatIds && chatIds.length === 0) return;
  if (chatIds) {
    await pool.query(`SELECT katibe.refresh_chat_stats($1::bigint[])`, [chatIds]);
    return;
  }
  await pool.query(`SELECT katibe.refresh_chat_stats()`);
}

/** Media açarından kəsilən bucket adı; olmadan media yolu düzgün yazılmır. */
export function mirrorBucket(): string | null {
  return process.env.S3_BUCKET || null;
}

/*
 * Vebhuk yolu: eyni anda yalnız bir köçürmə, instans başına.
 *
 * Mesajlar dəstə ilə gəlir (bir söhbətə beş sətir bir saniyədə) və hər biri
 * üçün ayrıca sorğu açmaq eyni işi beş dəfə görmək olardı — özü də paralel,
 * yəni eyni sətirlərə görə bir-birini gözləyərək.
 */
const inFlight = new Map<string, Promise<number>>();

/**
 * İndi gələn mesajı anbara yaz — Evolution-un vebhukundan çağırılır.
 *
 * Nəticəni gözləmək lazım deyil və gözlənilmir: vebhuk «göndər və unut»dur.
 * Xəta udulur, çünki beş dəqiqəlik cron onsuz da eyni işi yenidən görür —
 * bu yol yalnız SÜRƏTDİR, zəmanət deyil.
 */
export async function mirrorNow(instanceId: string, limit = 200): Promise<number> {
  const running = inFlight.get(instanceId);
  if (running) return running;
  const task = (async () => {
    const bucket = mirrorBucket();
    if (!bucket) {
      console.error("[mirror] S3_BUCKET yoxdur — köçürmə buraxıldı.");
      return 0;
    }
    /* İki saat: vebhuk indi gələn mesaj üçündür, geridə qalanı beş dəqiqəlik
       cron onsuz da götürür. Pəncərəni geniş saxlamağın yeganə nəticəsi hər
       mesajda daha uzun tarama olardı. */
    const since = Math.floor(Date.now() / 1000) - 2 * 3600;
    const r = await mirrorBatch(instanceId, limit, bucket, since);
    if (r.chatIds.length > 0) await refreshChatStats(r.chatIds);
    return r.read;
  })().finally(() => inFlight.delete(instanceId));
  inFlight.set(instanceId, task);
  return task;
}
