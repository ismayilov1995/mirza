import { pool } from "./db";
import {
  monitorVisibilityJoins,
  monitorVisibleSql,
  type MonitorProfile,
  type MonitorScope,
  type VisibleChat,
} from "./access";
import { maskDisplayName, maskPhone, maskPhonesInText } from "./monitor";
import { classifyJid, type ChatType } from "./jid";
import { encodeChatId } from "./monitor-token";
import { contactDisplaySql, groupSubjectJoin, MEDIA_TYPES, nameJoins, phoneSql } from "./queries";

/*
 * Nəzarətçi görünüşünün BÜTÜN sorğuları. Başqa heç bir yerdən nəzarətçiyə
 * məlumat qaytarılmır.
 *
 * İki qayda, hər sorğuda:
 *   1. `monitorVisibleSql()` — gizlədilmiş söhbət heç vaxt sətir qaytarmır;
 *   2. `scope.windowStart` — pəncərədən köhnə mesaj heç vaxt oxunmur.
 *
 * Hər ikisi funksiyanın SQL-ində olmalıdır, çağıranda yox: süzgəci çağırana
 * buraxmaq "bir yerdə unutmaq" deməkdir və bu app-də məhz onun qarşısı alınır.
 *
 * WhatsApp-a TOXUNULMUR. Burada yalnız evolution_api-nin öz Postgres-i
 * oxunur — söhbətin "oxundu" olması riski yoxdur (bax src/lib/db.ts).
 */

export interface MonitorInstance {
  instanceId: string;
  instanceName: string;
  /** Satıcının adı (katibe.users) — nəzarətçi nömrəni yox, adamı axtarır. */
  ownerName: string | null;
  connectionStatus: string;
  /** Ona görünən söhbət sayı (pəncərə daxilində). */
  visibleChats: number;
  /** Qarşı tərəfin son sözü olan, yəni cavab gözləyən söhbətlər. */
  awaiting: number;
  lastActivityAt: number | null;
}

/**
 * Nəzarətçinin baxa bildiyi satıcılar.
 *
 * Saylar GÖRÜNƏN söhbətlərə görədir: gizlədilmiş qrupların sayı belə
 * sızmamalıdır, əks halda "burada 40 gizli söhbət var" özü bir məlumatdır.
 */
export async function getMonitorInstances(scope: MonitorScope): Promise<MonitorInstance[]> {
  if (scope.instances.length === 0) return [];

  const { rows } = await pool.query(
    `WITH last_msg AS (
       SELECT DISTINCT ON (m."instanceId", m.key->>'remoteJid')
              m."instanceId" AS instance_id,
              m.key->>'remoteJid' AS jid,
              m."messageTimestamp" AS ts,
              (m.key->>'fromMe')::boolean AS from_me
       FROM evolution_api."Message" m
       WHERE m."instanceId" = ANY($2::text[])
         AND m."messageTimestamp" >= $3
         AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
       ORDER BY m."instanceId", m.key->>'remoteJid', m."messageTimestamp" DESC
     ),
     visible AS (
       SELECT lm.instance_id, lm.ts, lm.from_me
       FROM last_msg lm
       LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = lm.jid
       ${monitorVisibilityJoins("lm.jid", "$1")}
       WHERE ${monitorVisibleSql("lm.jid", scope.profile)}
     )
     SELECT i.id, i.name, i."connectionStatus" AS connection_status,
            u.name AS owner_name,
            COALESCE(v.chats, 0) AS chats,
            COALESCE(v.awaiting, 0) AS awaiting,
            v.last_ts
     FROM evolution_api."Instance" i
     LEFT JOIN katibe.user_instances ui ON ui.instance_id = i.id AND ui.ended_at IS NULL
     LEFT JOIN katibe.users u ON u.id = ui.user_id
     LEFT JOIN (
       SELECT instance_id, COUNT(*) AS chats,
              COUNT(*) FILTER (WHERE NOT from_me) AS awaiting,
              MAX(ts) AS last_ts
       FROM visible GROUP BY instance_id
     ) v ON v.instance_id = i.id
     WHERE i.id = ANY($2::text[])
     ORDER BY u.name NULLS LAST, i.name`,
    [scope.monitorUserId, scope.instances, scope.windowStart],
  );

  return rows.map((r) => ({
    instanceId: r.id,
    instanceName: r.name,
    ownerName: r.owner_name,
    connectionStatus: r.connection_status,
    visibleChats: Number(r.chats),
    awaiting: Number(r.awaiting),
    lastActivityAt: r.last_ts === null ? null : Number(r.last_ts),
  }));
}

export interface MonitorChatRow {
  /**
   * Söhbətin opaq açarı (bax monitor-token.ts). Xam JID QAYTARILMIR: fərdi
   * söhbətdə JID-in özü telefon nömrəsidir, yəni onu göndərmək maskalamanı
   * mənasız edərdi.
   */
  chat: string;
  name: string;
  chatType: ChatType;
  categoryName: string | null;
  /** Son mesajın qısa mətni — media üçün null, tipi `lastMessageType` deyir. */
  lastMessageText: string | null;
  lastMessageType: string;
  lastMessageFromMe: boolean;
  lastMessageAt: number;
  /** Son söz qarşı tərəfindir — cavab gözləyir. */
  awaiting: boolean;
}

export const MONITOR_CHAT_PAGE = 40;

/**
 * Bir satıcının söhbət siyahısı — WhatsApp Web-in sol sütunu.
 *
 * Sıralama son mesaja görədir, çünki nəzarətçinin sualı həmişə "indi nə olur"
 * sualıdır. Səhifələmə kursorludur (son mesajın vaxtı): səhifə açıq qalanda
 * yeni mesaj gəlirsə, offset-li səhifələmə sətirləri sürüşdürüb təkrarlayardı.
 *
 * QURULUŞ SÜRƏT ÜÇÜNDÜR, gözəllik üçün yox. Sorğu üç mərhələdir:
 *
 *   1. `per_chat` — pəncərədəki hər söhbətin YALNIZ son mesajı. DISTINCT ON
 *      (jid) + ORDER BY jid, ts DESC birbaşa Message_instanceId_remoteJid_ts_idx
 *      indeksinin sırasıdır, ona görə çeşidləmə olmur.
 *   2. `page` — görünmə süzgəci, kursor, axtarış, sonra LIMIT. Ad mənbələri
 *      burada UCUZ join-lərdir (etiket, qrup adı, Chat/Contact).
 *   3. Yalnız qalan 40 sətir üçün BAHALI ad həlqəsi (pushName-i mesajlardan
 *      çıxaran LATERAL) işləyir.
 *
 * Əvvəl bu ayrım yox idi: LATERAL bütün 800 söhbət üçün işləyirdi və siyahı
 * 1.1 saniyə çəkirdi — hər gələn mesajda yenilənən ekran üçün qəbuledilməz.
 */
export async function getMonitorChats(
  scope: MonitorScope,
  instanceId: string,
  { search = "", before = null, limit = MONITOR_CHAT_PAGE }: {
    search?: string;
    before?: number | null;
    limit?: number;
  } = {},
): Promise<{ chats: MonitorChatRow[]; nextCursor: number | null }> {
  const { rows } = await pool.query(
    `WITH per_chat AS (
       -- YALNIZ jid + son vaxt. Mesajın mətni burada QƏSDƏN yoxdur: 63 min
       -- sətri jsonb sütunu ilə birlikdə çeşidləmək sortu diskə salırdı.
       -- Dar sətirlə eyni çeşidləmə iki dəfə ucuzdur, mətn isə aşağıda
       -- yalnız səhifəyə düşən 40 söhbət üçün oxunur.
       SELECT DISTINCT ON (x.jid) x.jid, x.ts AS last_ts
       FROM (
         SELECT m.key->>'remoteJid' AS jid, m."messageTimestamp" AS ts
         FROM evolution_api."Message" m
         WHERE m."instanceId" = $2
           AND m."messageTimestamp" >= $3
           AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
       ) x
       ORDER BY x.jid, x.ts DESC
     ),
     page AS (
       SELECT p.*
       FROM per_chat p
       LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = p.jid
       LEFT JOIN evolution_api."Chat" ch ON ch."instanceId" = $2 AND ch."remoteJid" = p.jid
       LEFT JOIN evolution_api."Contact" ct ON ct."instanceId" = $2 AND ct."remoteJid" = p.jid
       ${groupSubjectJoin("p.jid", "gs")}
       ${monitorVisibilityJoins("p.jid", "$1")}
       WHERE ${monitorVisibleSql("p.jid", scope.profile)}
         AND ($4::bigint IS NULL OR p.last_ts < $4)
         AND (
           $5 = ''
           -- Axtarış ucuz mənbələr üzrədir. Mesajlardan çıxarılan pushName
           -- bura daxil deyil: onu axtarışa qatmaq bahalı həlqəni bütün
           -- söhbətlərə qaytarardı, yəni sürət üçün edilən ayrımı pozardı.
           OR COALESCE(cl.display_name, '') ILIKE '%' || $5 || '%'
           OR COALESCE(gs.subject, '') ILIKE '%' || $5 || '%'
           OR COALESCE(ch.name, '') ILIKE '%' || $5 || '%'
           OR COALESCE(ct."pushName", '') ILIKE '%' || $5 || '%'
           OR p.jid ILIKE '%' || $5 || '%'
         )
       ORDER BY p.last_ts DESC
       LIMIT $6
     )
     SELECT pg.jid, pg.last_ts, lm.from_me, lm.message_type, lm.text,
            ${contactDisplaySql("pg.jid")} AS display,
            cat.name AS category_name
     FROM page pg
     -- Son mesajın özü: (instanceId, jid, ts DESC) indeksi ilə 40 nöqtəvi
     -- axtarış. Eyni saniyədə iki mesaj varsa hər hansı biri götürülür —
     -- önbaxışda fərq yoxdur.
     LEFT JOIN LATERAL (
       SELECT (m2.key->>'fromMe')::boolean AS from_me,
              m2."messageType" AS message_type,
              COALESCE(
                m2.message->>'conversation',
                m2.message->'extendedTextMessage'->>'text',
                m2.message->'imageMessage'->>'caption',
                m2.message->'videoMessage'->>'caption',
                m2.message->'documentMessage'->>'fileName'
              ) AS text
       FROM evolution_api."Message" m2
       WHERE m2."instanceId" = $2
         AND m2.key->>'remoteJid' = pg.jid
         AND m2."messageTimestamp" = pg.last_ts
         AND m2."messageType" NOT IN ('protocolMessage', 'reactionMessage')
       LIMIT 1
     ) lm ON true
     ${nameJoins("pg.jid", "$2")}
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     ORDER BY pg.last_ts DESC`,
    [scope.monitorUserId, instanceId, scope.windowStart, before, search.trim(), limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const mask = scope.profile.maskPhones;

  return {
    chats: page.map((r) => ({
      chat: encodeChatId(instanceId, r.jid),
      name: (mask ? maskDisplayName(r.display) : r.display) ?? "Adsız söhbət",
      chatType: classifyJid(r.jid),
      categoryName: r.category_name,
      lastMessageText: mask ? maskPhonesInText(r.text) : r.text,
      lastMessageType: r.message_type ?? "conversation",
      lastMessageFromMe: r.from_me ?? false,
      lastMessageAt: Number(r.last_ts),
      awaiting: !r.from_me,
    })),
    nextCursor: hasMore ? Number(page[page.length - 1].last_ts) : null,
  };
}

export interface MonitorChatHeader {
  /** Opaq açar — xam JID deyil (bax MonitorChatRow.chat). */
  chat: string;
  name: string;
  chatType: ChatType;
  categoryName: string | null;
  /** Maskalanmış nömrə, ya da null. Tam nömrə buradan HEÇ VAXT çıxmır. */
  phone: string | null;
  messageCount: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
}

export async function getMonitorChatHeader(chat: VisibleChat): Promise<MonitorChatHeader | null> {
  const { scope, instanceId, jid } = chat;
  const { rows } = await pool.query(
    `SELECT ${contactDisplaySql("$2")} AS display,
            ${phoneSql("$2", "ln")} AS phone,
            cat.name AS category_name,
            (SELECT COUNT(*) FROM evolution_api."Message" m
              WHERE m."instanceId" = $1 AND m.key->>'remoteJid' = $2
                AND m."messageTimestamp" >= $3
                AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')) AS msg_count,
            (SELECT MIN(m."messageTimestamp") FROM evolution_api."Message" m
              WHERE m."instanceId" = $1 AND m.key->>'remoteJid' = $2
                AND m."messageTimestamp" >= $3) AS first_ts,
            (SELECT MAX(m."messageTimestamp") FROM evolution_api."Message" m
              WHERE m."instanceId" = $1 AND m.key->>'remoteJid' = $2) AS last_ts
     FROM (SELECT $2::text AS jid) j
     ${nameJoins("$2", "$1")}
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id`,
    [instanceId, jid, scope.windowStart],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const mask = scope.profile.maskPhones;
  return {
    chat: encodeChatId(instanceId, jid),
    name: (mask ? maskDisplayName(r.display) : r.display) ?? "Adsız söhbət",
    chatType: classifyJid(jid),
    categoryName: r.category_name,
    phone: mask ? maskPhone(r.phone) : r.phone,
    messageCount: Number(r.msg_count),
    firstMessageAt: r.first_ts === null ? null : Number(r.first_ts),
    lastMessageAt: r.last_ts === null ? null : Number(r.last_ts),
  };
}

export interface MonitorMessage {
  id: string;
  fromMe: boolean;
  /** Qrupda kimin yazdığı. Nömrə kimi görünürsə maskalanır. */
  senderName: string | null;
  text: string | null;
  messageType: string;
  timestamp: number;
  isMedia: boolean;
  mimetype: string | null;
  fileName: string | null;
  /** Səs mesajının mətni (scripts/transcribe-voice.ts) — varsa. */
  voiceText: string | null;
}

const MESSAGE_SELECT = `
  m.id,
  (m.key->>'fromMe')::boolean AS from_me,
  m."pushName" AS sender_name,
  COALESCE(
    m.message->>'conversation',
    m.message->'extendedTextMessage'->>'text',
    m.message->'imageMessage'->>'caption',
    m.message->'videoMessage'->>'caption',
    m.message->'documentMessage'->>'fileName'
  ) AS text,
  m."messageType" AS message_type,
  m."messageTimestamp" AS ts,
  (m."messageType" = ANY($4::text[])) AS is_media,
  COALESCE(
    m.message->'imageMessage'->>'mimetype',
    m.message->'videoMessage'->>'mimetype',
    m.message->'audioMessage'->>'mimetype',
    m.message->'documentMessage'->>'mimetype',
    m.message->'stickerMessage'->>'mimetype'
  ) AS mimetype,
  m.message->'documentMessage'->>'fileName' AS file_name,
  vt.text AS voice_text
`;

/**
 * Yazışmanın bir səhifəsi, köhnədən yeniyə.
 *
 * `before` verilirsə daha köhnə səhifə gətirilir ("yuxarı sürüşdür"), `after`
 * verilirsə yalnız yeni gələnlər ("canlı əlavə"). İkisi də eyni funksiyadadır
 * ki, pəncərə şərti (`windowStart`) bir yerdə qalsın — canlı yolun süzgəci
 * unutması ən asan səhv olardı.
 */
export async function getMonitorMessages(
  chat: VisibleChat,
  { before = null, after = null, limit = 40 }: {
    before?: number | null;
    after?: number | null;
    limit?: number;
  } = {},
): Promise<{ messages: MonitorMessage[]; hasOlder: boolean }> {
  const { scope, instanceId, jid } = chat;
  // Pəncərə həmişə qüvvədədir: `after` nə qədər köhnə verilsə də, 90 gündən
  // o tərəfə keçmir.
  const floorTs = Math.max(scope.windowStart, after ?? 0);

  /*
   * Sıralama istiqaməti sualın istiqamətidir.
   *
   * "Daha köhnə göstər" ən YENİ N köhnəni istəyir, ona görə DESC yığıb sonra
   * çevrilir. "Bundan sonra nə gəldi" isə ən KÖHNƏ N yenini istəyir — orada
   * DESC yığmaq eyni anda 50 mesaj gələn qrupda aradakıları səssizcə uduzardı.
   */
  const live = after !== null;
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT ${MESSAGE_SELECT}
       FROM evolution_api."Message" m
       LEFT JOIN katibe.voice_transcript vt ON vt.message_id = m.id
       WHERE m."instanceId" = $1
         AND m.key->>'remoteJid' = $2
         AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
         AND m."messageTimestamp" > $5
         AND ($6::bigint IS NULL OR m."messageTimestamp" < $6)
       ORDER BY m."messageTimestamp" ${live ? "ASC" : "DESC"}
       LIMIT $3 + 1
     ) page
     ORDER BY ts ASC`,
    [instanceId, jid, limit, MEDIA_TYPES, floorTs, before],
  );

  // Artıq sətir yalnız "daha var" sualına cavabdır; canlı yolda köhnə tarixçə
  // haqqında iddia edilmir.
  const hasOlder = !live && rows.length > limit;
  const page = rows.length > limit ? (live ? rows.slice(0, limit) : rows.slice(1)) : rows;
  const mask = scope.profile.maskPhones;

  return {
    hasOlder,
    messages: page.map((r) => ({
      id: r.id,
      fromMe: r.from_me,
      senderName: mask ? maskDisplayName(r.sender_name) : r.sender_name,
      text: mask ? maskPhonesInText(r.text) : r.text,
      messageType: r.message_type,
      timestamp: Number(r.ts),
      isMedia: r.is_media,
      mimetype: r.mimetype,
      fileName: r.file_name,
      voiceText: mask ? maskPhonesInText(r.voice_text) : r.voice_text,
    })),
  };
}

/**
 * Bir mesajın faylı üçün lazım olanlar — `getMediaRef()`-in nəzarətçi qapısı.
 *
 * Sorğu eynidir, açar fərqlidir: adi variant `ScopedInstanceId` (yəni "bu
 * nömrəyə icazən var") istəyir, bu isə `VisibleChat` (yəni "bu SÖHBƏTƏ icazən
 * var"). Nəzarətçi üçün ikincisi lazımdır — gizli qrupun şəkli də həmin
 * nömrənin instansındadır. Ona görə funksiya təkrarlanır, tip qapısı yox.
 */
export async function getMonitorMediaRef(
  chat: VisibleChat,
  messageId: string,
): Promise<{
  waMessageId: string;
  mimetype: string | null;
  fileName: string | null;
  storedUrl: string | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT (m.key->>'id')::text AS wa_message_id,
            m.message->>'mediaUrl' AS stored_url,
            COALESCE(
              m.message->'imageMessage'->>'mimetype',
              m.message->'videoMessage'->>'mimetype',
              m.message->'audioMessage'->>'mimetype',
              m.message->'documentMessage'->>'mimetype',
              m.message->'stickerMessage'->>'mimetype'
            ) AS mimetype,
            m.message->'documentMessage'->>'fileName' AS file_name
     FROM evolution_api."Message" m
     WHERE m."instanceId" = $1 AND m.id = $2 AND m."messageType" = ANY($3::text[])
     LIMIT 1`,
    [chat.instanceId, messageId, MEDIA_TYPES],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    waMessageId: r.wa_message_id,
    mimetype: r.mimetype,
    fileName: r.file_name,
    storedUrl: r.stored_url,
  };
}

/* ── Admin tərəf: qaydaları qurmaq üçün söhbət siyahısı ──────────────────── */

export interface MonitorRuleCandidate {
  jid: string;
  name: string;
  chatType: ChatType;
  categoryName: string | null;
  categoryId: number | null;
  /** Hazırda görünürmü. */
  visible: boolean;
  /** Qərarı kim verdi: söhbətin öz qaydası, kateqoriya, yoxsa tip default-u. */
  source: "chat" | "category" | "default";
  lastMessageAt: number | null;
  messageCount: number;
}

/**
 * Nəzarətçiyə təyin edilmiş nömrələrdəki söhbətlər, hazırkı görünmə vəziyyəti
 * ilə birlikdə — admin panelində "hansı qrup açıqdır" sualının cavabı.
 *
 * ADMİN ÜÇÜNDÜR: adlar burada MASKALANMIR və çağıran `requireAdmin()`
 * arxasında olmalıdır. Nəzarətçinin özü bu funksiyaya çıxa bilmir — /monitor
 * altındakı heç bir route onu çağırmır.
 *
 * Söhbətlər JID üzrə birləşdirilir, instans üzrə yox: qayda da JID-ə bağlıdır,
 * yəni bir qrupu bir dəfə bağlamaq kifayətdir.
 */
export async function getMonitorRuleCandidates(params: {
  monitorUserId: number;
  profile: MonitorProfile;
  instanceIds: string[];
  search?: string;
  type?: "all" | "group" | "individual";
  limit?: number;
}): Promise<MonitorRuleCandidate[]> {
  const { monitorUserId, profile, instanceIds, search = "", type = "all", limit = 100 } = params;
  if (instanceIds.length === 0) return [];

  const windowStart = Math.floor(Date.now() / 1000) - profile.historyDays * 86_400;
  const typeSql =
    type === "group" ? `AND a.jid LIKE '%@g.us'` : type === "individual" ? `AND a.jid NOT LIKE '%@g.us'` : "";

  const { rows } = await pool.query(
    `WITH agg AS (
       SELECT m.key->>'remoteJid' AS jid,
              MAX(m."messageTimestamp") AS last_ts,
              COUNT(*) AS msg_count
       FROM evolution_api."Message" m
       WHERE m."instanceId" = ANY($2::text[])
         AND m."messageTimestamp" >= $3
         AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
       GROUP BY 1
     )
     SELECT a.jid, a.last_ts, a.msg_count,
            ${contactDisplaySql("a.jid")} AS display,
            cl.category_id, cat.name AS category_name,
            ${monitorVisibleSql("a.jid", profile)} AS visible,
            CASE
              WHEN mcr.visibility IS NOT NULL THEN 'chat'
              WHEN mkr.visibility IS NOT NULL THEN 'category'
              ELSE 'default'
            END AS source
     FROM agg a
     -- Ad mənbələri instansdan asılıdır, qayda isə yox: hər cədvəldən BİR
     -- uyğun sətir kifayətdir, əks halda eyni qrup iki nömrədə iki sətir olardı.
     LEFT JOIN LATERAL (
       SELECT c.name FROM evolution_api."Chat" c
       WHERE c."remoteJid" = a.jid AND c."instanceId" = ANY($2::text[]) AND c.name IS NOT NULL
       LIMIT 1
     ) ch ON true
     LEFT JOIN LATERAL (
       SELECT c2."pushName" FROM evolution_api."Contact" c2
       WHERE c2."remoteJid" = a.jid AND c2."instanceId" = ANY($2::text[]) AND c2."pushName" IS NOT NULL
       LIMIT 1
     ) ct ON true
     LEFT JOIN LATERAL (
       SELECT MAX(pm."pushName") FILTER (WHERE COALESCE(pm."pushName", '') <> '') AS push_name
       FROM evolution_api."Message" pm
       WHERE pm."instanceId" = ANY($2::text[]) AND pm.key->>'remoteJid' = a.jid
         AND (pm.key->>'fromMe')::boolean = false
     ) pn ON true
     LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = a.jid
     ${groupSubjectJoin("a.jid", "gs")}
     LEFT JOIN katibe.lid_number ln ON ln.lid_jid = a.jid
     LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = a.jid
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     ${monitorVisibilityJoins("a.jid", "$1")}
     WHERE true ${typeSql}
       AND ($4 = '' OR ${contactDisplaySql("a.jid")} ILIKE '%' || $4 || '%' OR a.jid ILIKE '%' || $4 || '%')
     ORDER BY a.last_ts DESC
     LIMIT $5`,
    [monitorUserId, instanceIds, windowStart, search.trim(), limit],
  );

  return rows.map((r) => ({
    jid: r.jid,
    name: r.display ?? r.jid,
    chatType: classifyJid(r.jid),
    categoryId: r.category_id === null ? null : Number(r.category_id),
    categoryName: r.category_name,
    visible: r.visible,
    source: r.source,
    lastMessageAt: r.last_ts === null ? null : Number(r.last_ts),
    messageCount: Number(r.msg_count),
  }));
}
