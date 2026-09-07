import { pool } from "./db";
import type { ScopedInstanceId } from "./access";
import { classifyJid, type ChatType } from "./jid";

/** Joins katibe.group_subject under the alias knownNameSql() expects. */
export function groupSubjectJoin(jidExpr: string, alias = "gs"): string {
  return `LEFT JOIN katibe.group_subject ${alias} ON ${alias}.remote_jid = ${jidExpr}`;
}

/**
 * The dialable phone number for a chat, or null when WhatsApp hides it.
 *
 * Two sources, and they don't overlap: a plain `@s.whatsapp.net` JID *is* the
 * number, while an `@lid` only has one if the pairing was recovered into
 * katibe.lid_number (see scripts/harvest-lid-numbers.ts — most are not, and
 * cannot be).
 *
 * @param jidExpr SQL expression yielding the JID
 * @param lidNumber alias of katibe.lid_number
 */
export function phoneSql(jidExpr: string, lidNumber: string): string {
  return `COALESCE(
    ${lidNumber}.phone_number,
    CASE WHEN ${jidExpr} LIKE '%@s.whatsapp.net' THEN split_part(${jidExpr}, '@', 1) END
  )`;
}

/**
 * The short identity hint the model read out of the conversation, as one
 * string — "Leyla, Gəncə" — or NULL when nothing was ever stated.
 *
 * @param ci alias of katibe.chat_identity
 */
export function identityHintSql(ci: string): string {
  return `NULLIF(concat_ws(', ',
    NULLIF(${ci}.stated_name, ''),
    NULLIF(${ci}.city, ''),
    NULLIF(${ci}.order_code, ''),
    NULLIF(${ci}.note, '')
  ), '')`;
}

/**
 * The joins knownNameSql()/contactDisplaySql() need, under the aliases they
 * expect. They live next to those functions because a missing join is a loud
 * Postgres error, but a join under the WRONG alias silently costs a name.
 *
 * `pn` has no table behind it: the name is the pushName WhatsApp puts on the
 * contact's own incoming messages. Most @lid chats have no Contact row at all,
 * and this loop is the only thing that names them.
 *
 * That loop is also the expensive part — one index lookup per row. A caller
 * listing many chats must therefore page FIRST and resolve names for the page
 * only (getMonitorChats, getChatBase), or take the pushName out of an
 * aggregate it is already computing (CHAT_BASE_SQL) and pass it in.
 */
export function nameJoins(jidExpr: string, instanceParam: string): string {
  return `
  LEFT JOIN evolution_api."Chat" ch ON ch."instanceId" = ${instanceParam} AND ch."remoteJid" = ${jidExpr}
  LEFT JOIN evolution_api."Contact" ct ON ct."instanceId" = ${instanceParam} AND ct."remoteJid" = ${jidExpr}
  LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = ${jidExpr}
  ${groupSubjectJoin(jidExpr, "gs")}
  LEFT JOIN LATERAL (
    SELECT MAX(pm."pushName") FILTER (WHERE COALESCE(pm."pushName", '') <> '') AS push_name
    FROM evolution_api."Message" pm
    WHERE pm."instanceId" = ${instanceParam}
      AND pm.key->>'remoteJid' = ${jidExpr}
      AND (pm.key->>'fromMe')::boolean = false
  ) pn ON true
  LEFT JOIN katibe.lid_number ln ON ln.lid_jid = ${jidExpr}
  LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = ${jidExpr}
`;
}

/**
 * The best name actually KNOWN for a chat, or NULL when nobody ever supplied
 * one. This is the part of contactDisplaySql() that is a name rather than a
 * substitute for one, which is why it is separate: "does this chat still need
 * a label" must be the same question as "did we print a name for it".
 *
 * Order, and why:
 *   1. the contact label — a human (or identify-clients) decided this;
 *   2. then the type split, which is NOT cosmetic. On a group row
 *      Contact.pushName is some participant's personal name, not the group's
 *      — 372 group chats here disagree ("Rolando Salilin" for
 *      "Otpravka LEKAL ve TRIAL"), so groups take their subject and never a
 *      pushName. Individuals have it the other way round;
 *   3. for individuals, the pushName on their own incoming messages, which is
 *      all most @lid chats ever have.
 *
 * WhatsApp sends the LID's own digits as pushName when the contact has no
 * display name, and Evolution stores that verbatim. Such a "name" is the id
 * again, not an answer to "who is this" — it has to lose to the number and to
 * the conversation hint, so every candidate is checked against the JID's local
 * part before it counts.
 *
 * @param pushName SQL for the incoming-message pushName; override when it
 *   comes from an aggregate the caller already has instead of nameJoins' pn.
 */
export function knownNameSql(jidExpr: string, pushName = "pn.push_name"): string {
  const local = `split_part(${jidExpr}, '@', 1)`;
  const real = (expr: string) => `NULLIF(NULLIF(${expr}, ''), ${local})`;
  return `COALESCE(
    ${real("cl.display_name")},
    CASE WHEN ${jidExpr} LIKE '%@g.us'
         THEN COALESCE(${real("gs.subject")}, ${real("ch.name")})
         ELSE COALESCE(${real('ct."pushName"')}, ${real("ch.name")}, ${real(pushName)}) END
  )`;
}

/**
 * What to CALL a chat, best available first — never a bare JID.
 *
 * The fallbacks below a real name are not equally trustworthy, so they are
 * ordered and labelled rather than blended:
 *
 *   1. knownNameSql() — an actual name
 *   2. resolved number — a fact, but only ~10% of @lid chats have one
 *   3. identity hint   — what they SAID about themselves; a hint, not a fact
 *   4. the id, explicitly marked as unresolved
 *
 * Steps 2-4 are the @lid problem: 81% of active @lid chats have nothing from
 * step 1, and the panel used to print the bare JID for every one of them.
 * When the best we have is a number or a bare id, the hint is appended rather
 * than dropped — "994xx… · Leyla, Gəncə" beats either half alone.
 *
 * Requires the joins from nameJoins().
 */
export function contactDisplaySql(jidExpr: string, pushName = "pn.push_name"): string {
  const known = knownNameSql(jidExpr, pushName);
  const phone = phoneSql(jidExpr, "ln");
  const hint = identityHintSql("ci");
  // A name and a number are not alternatives — a pushName like "AN" or "A"
  // identifies nobody, while the number can be looked up. So when both exist
  // they are shown together; NULLIF drops the tail when the "name" IS the
  // number (a plain @s.whatsapp.net contact with no display name), which
  // would otherwise print "994… · 994…".
  //
  // NULL propagates through ||, so a missing name still falls through to the
  // next branch instead of producing a stray separator.
  return `COALESCE(
    ${known} || COALESCE(' · ' || NULLIF(${phone}, ${known}), ''),
    ${phone} || COALESCE(' · ' || ${hint}, ''),
    ${hint},
    CASE WHEN ${jidExpr} LIKE '%@g.us'
         THEN 'Qrup ' || left(split_part(${jidExpr}, '@', 1), 6) || '… (ad yoxdur)'
         ELSE 'LID ' || left(split_part(${jidExpr}, '@', 1), 6) || '… (nömrə tanınmır)' END
  )`;
}

export interface TopContact {
  contact: string;
  jid: string;
  received: number;
  sent: number;
  total: number;
  avgPerDay: number;
}


export interface ResponseTime {
  contact: string;
  jid: string;
  avgReplySeconds: number;
  replyCount: number;
}

// Gaps longer than this are treated as "a new conversation started", not a slow
// reply, so a chat that goes quiet overnight doesn't wreck the average.
const MAX_REPLY_GAP_SECONDS = 12 * 3600;

/*
 * Range filters compare the RAW epoch column, not `to_timestamp(col) > now() - …`.
 *
 * Both forms select exactly the same rows — verified across 7/14/30/90/365-day
 * windows and both instances. The difference is that wrapping the column in
 * to_timestamp() hides it from the index: Postgres cannot prove the function is
 * monotonic, so it reads every index entry for the instance and filters. Against
 * "Message_instanceId_remoteJid_ts_idx" the raw form seeks instead.
 *
 * `$2` is the day count, bound by the caller.
 */
const EPOCH_DAYS_AGO = `EXTRACT(epoch FROM now() - make_interval(days => $2::int))::int`;

/*
 * Midnight today in Asia/Baku, as an epoch.
 *
 * The `::timestamp` cast is load-bearing and easy to lose. Without it, `date AT
 * TIME ZONE 'Asia/Baku'` resolves as timestamptz→timestamp (reading UTC midnight
 * as a Baku wall clock) instead of timestamp→timestamptz, which lands the
 * boundary four hours late and silently undercounts the morning. Caught by a
 * differential check that read 20 messages where the old form read 52.
 */
const EPOCH_BAKU_TODAY =
  `EXTRACT(epoch FROM (((now() AT TIME ZONE 'Asia/Baku')::date)::timestamp) AT TIME ZONE 'Asia/Baku')::int`;


export interface Overview {
  totalMessages: number;
  totalContacts: number;
  totalChats: number;
  messagesToday: number;
}

export interface AdminOverview {
  totalUsers: number;
  totalInstances: number;
  assignedInstances: number;
}

/**
 * Cross-tenant counts for the admin area: how many Katibe users are set up,
 * how many Evolution API instances exist, and how many of those instances
 * have already been mapped to a user (katibe.user_instances).
 */
export async function getAdminOverview(): Promise<AdminOverview> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM katibe.users) AS total_users,
       (SELECT COUNT(*) FROM evolution_api."Instance") AS total_instances,
       (SELECT COUNT(*) FROM katibe.user_instances WHERE ended_at IS NULL) AS assigned_instances`,
  );
  const r = rows[0];
  return {
    totalUsers: Number(r.total_users),
    totalInstances: Number(r.total_instances),
    assignedInstances: Number(r.assigned_instances),
  };
}

export interface Branch {
  id: number;
  name: string;
}

export async function getBranches(): Promise<Branch[]> {
  const { rows } = await pool.query(`SELECT id, name FROM katibe.branches ORDER BY name ASC`);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export interface Category {
  id: number;
  name: string;
}

export async function getCategories(): Promise<Category[]> {
  const { rows } = await pool.query(`SELECT id, name FROM katibe.categories ORDER BY name ASC`);
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

export interface KatibeUser {
  id: number;
  name: string;
  branchName: string | null;
  categoryName: string | null;
  instanceCount: number;
}

export async function getUsers(): Promise<KatibeUser[]> {
  const { rows } = await pool.query(
    `SELECT
       u.id,
       u.name,
       b.name AS branch_name,
       c.name AS category_name,
       (SELECT COUNT(*) FROM katibe.user_instances ui WHERE ui.user_id = u.id AND ui.ended_at IS NULL) AS instance_count
     FROM katibe.users u
     LEFT JOIN katibe.branches b ON b.id = u.branch_id
     LEFT JOIN katibe.categories c ON c.id = u.category_id
     ORDER BY u.name ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    branchName: r.branch_name,
    categoryName: r.category_name,
    instanceCount: Number(r.instance_count),
  }));
}

export interface UserInstanceRef {
  instanceId: string;
  instanceName: string;
  connectionStatus: string;
}

export interface UserWithInstances {
  id: number;
  name: string;
  branchName: string | null;
  categoryName: string | null;
  instances: UserInstanceRef[];
}

/**
 * Users for the landing-page picker, each with the instance(s) assigned to
 * them — clicking an instance is what takes you into the actual dashboard
 * (src/app/i/[instanceId]). A user with zero instances still shows up (so
 * the admin sees they need one assigned) but has nothing clickable.
 */
export async function getUsersWithInstances(): Promise<UserWithInstances[]> {
  const { rows } = await pool.query(
    `SELECT
       u.id,
       u.name,
       b.name AS branch_name,
       c.name AS category_name,
       ui.instance_id,
       i.name AS instance_name,
       i."connectionStatus" AS connection_status
     FROM katibe.users u
     LEFT JOIN katibe.branches b ON b.id = u.branch_id
     LEFT JOIN katibe.categories c ON c.id = u.category_id
     LEFT JOIN katibe.user_instances ui ON ui.user_id = u.id AND ui.ended_at IS NULL
     LEFT JOIN evolution_api."Instance" i ON i.id = ui.instance_id
     ORDER BY u.name ASC, i.name ASC`,
  );
  const byUser = new Map<number, UserWithInstances>();
  for (const r of rows) {
    if (!byUser.has(r.id)) {
      byUser.set(r.id, {
        id: r.id,
        name: r.name,
        branchName: r.branch_name,
        categoryName: r.category_name,
        instances: [],
      });
    }
    if (r.instance_id) {
      byUser.get(r.id)!.instances.push({
        instanceId: r.instance_id,
        instanceName: r.instance_name,
        connectionStatus: r.connection_status,
      });
    }
  }
  return Array.from(byUser.values());
}

export interface InstanceInfo {
  id: string;
  name: string;
  connectionStatus: string;
  ownerUserName: string | null;
}

/** Looked up once per dashboard page load to show whose instance this is and confirm it exists. */
export async function getInstanceInfo(instanceId: ScopedInstanceId): Promise<InstanceInfo | null> {
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i."connectionStatus" AS connection_status, u.name AS owner_user_name
     FROM evolution_api."Instance" i
     LEFT JOIN katibe.user_instances ui ON ui.instance_id = i.id AND ui.ended_at IS NULL
     LEFT JOIN katibe.users u ON u.id = ui.user_id
     WHERE i.id = $1`,
    [instanceId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return { id: r.id, name: r.name, connectionStatus: r.connection_status, ownerUserName: r.owner_user_name };
}

export interface CategoryStat {
  categoryId: number | null;
  categoryName: string;
  chatCount: number;
  received: number;
  sent: number;
  total: number;
  /** Mean of the per-chat average reply time, in seconds. Null with too few replies to measure. */
  avgReplySeconds: number | null;
  /** Chats whose latest message came from the other side — still waiting on us. */
  awaitingUs: number;
}

export interface ChatDetail {
  jid: string;
  /** Never a bare JID — falls back to number, hint, then a marked id. */
  contactName: string;
  /**
   * The name part of contactName alone, or null when nobody ever supplied a
   * name. The header uses it to avoid printing the number twice: contactName
   * carries the number itself once there is no name to carry.
   */
  knownName: string | null;
  chatType: ChatType;
  displayName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  messageCount: number;
  received: number;
  sent: number;
  firstMessageTs: number | null;
  lastMessageTs: number | null;
  /** Dialable number, when there is one — see phoneSql(). Supervisor lentində
   * artıq görünür, amma bu səhifədə heç vaxt olmayıb. */
  phoneNumber: string | null;
  /** Yazışmadan oxunan "Leyla, Gəncə" tipli ipucu — nömrə yoxdursa fallback. */
  identityHint: string | null;
}

/**
 * Header facts for one chat's detail page. Null only when the JID has neither
 * a Chat row nor any message — it deliberately does NOT require a Chat row,
 * since some conversations exist only as messages (see CHAT_BASE_SQL).
 */
/*
 * DISTINCT ON (key->>'id') in the message queries below is deliberate.
 *
 * evolution_api."Message" is able to hold the same WhatsApp message twice. Its
 * Prisma model keys on a generated cuid and declares no @@unique over the
 * WhatsApp id, so the `skipDuplicates: true` on the history-sync createMany
 * (whatsapp.baileys.service.ts:1055) has no constraint to act against and does
 * nothing at all — every full history sync re-inserts what was already stored.
 *
 * The 38,179 copies that had accumulated were removed on 2026-08-25, so today
 * these clauses are a no-op. They stay because the *cause* is still live: until
 * a unique index exists on ("instanceId", (key->>'id')), the next full history
 * sync brings the duplicates straight back. Removing them re-opens the bug.
 */
export async function getChatDetail(instanceId: ScopedInstanceId, jid: string): Promise<ChatDetail | null> {
  const { rows } = await pool.query(
    `WITH uniq AS (
       SELECT DISTINCT ON (m.key->>'id')
              (m.key->>'fromMe')::boolean AS from_me, m."messageTimestamp" AS ts
       FROM evolution_api."Message" m
       WHERE m."instanceId" = $1 AND m.key->>'remoteJid' = $2
       ORDER BY m.key->>'id', m.id
     ),
     stats AS (
       SELECT
         COUNT(*) AS message_count,
         COUNT(*) FILTER (WHERE NOT from_me) AS received,
         COUNT(*) FILTER (WHERE from_me) AS sent,
         MIN(ts) AS first_ts,
         MAX(ts) AS last_ts
       FROM uniq
     )
     SELECT
       ${contactDisplaySql("$2")} AS contact_name,
       ${knownNameSql("$2")} AS known_name,
       cl.display_name,
       cl.category_id,
       cat.name AS category_name,
       stats.message_count, stats.received, stats.sent, stats.first_ts, stats.last_ts,
       (ch."remoteJid" IS NOT NULL) AS has_chat_row,
       ${phoneSql("$2", "ln")} AS phone_number,
       ${identityHintSql("ci")} AS identity_hint
     FROM stats
     ${nameJoins("$2", "$1")}
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id`,
    [instanceId, jid],
  );
  if (rows.length === 0) return null;
  if (Number(rows[0].message_count) === 0 && !rows[0].has_chat_row) return null;
  const r = rows[0];
  return {
    jid,
    contactName: r.contact_name,
    knownName: r.known_name,
    chatType: classifyJid(jid),
    displayName: r.display_name,
    categoryId: r.category_id === null ? null : Number(r.category_id),
    categoryName: r.category_name,
    messageCount: Number(r.message_count),
    received: Number(r.received),
    sent: Number(r.sent),
    firstMessageTs: r.first_ts === null ? null : Number(r.first_ts),
    lastMessageTs: r.last_ts === null ? null : Number(r.last_ts),
    phoneNumber: r.phone_number,
    identityHint: r.identity_hint,
  };
}

export interface ChatMessage {
  id: string;
  fromMe: boolean;
  senderName: string | null;
  text: string | null;
  messageType: string;
  timestamp: number;
  /** This message carries a picture, video, audio, document or sticker. */
  isMedia: boolean;
  /** The file itself is in our S3 bucket, so fetching it costs WhatsApp nothing. */
  archived: boolean;
  mimetype: string | null;
  fileName: string | null;
  /** OpenAI transcription of a voice note, once scripts/transcribe-voice.ts has run. */
  voiceText: string | null;
  /** 'ok' | 'unavailable' | 'failed', or null when it has not been attempted yet. */
  voiceStatus: string | null;
}

export interface ChatTranscript {
  messages: ChatMessage[];
  /** There is older history beyond what was returned. */
  hasMore: boolean;
}

/** Message types that carry a downloadable file. */
export const MEDIA_TYPES = [
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
  "stickerMessage",
] as const;

/**
 * The tail of a conversation, oldest-first so it reads like a chat.
 *
 * Strictly a SELECT against evolution_api."Message" — reading messages here
 * never touches the Evolution API, so nothing is marked as read.
 *
 * Text lives in a different place per message type; media with no caption
 * returns null text and the UI shows a type badge instead.
 */
export async function getRecentMessages(
  instanceId: ScopedInstanceId,
  jid: string,
  limit = 10,
): Promise<ChatTranscript> {
  // One row over the asked-for limit, purely to answer "is there more?" without
  // a second count query over the same rows.
  const { rows } = await pool.query(
    `SELECT * FROM (
     SELECT * FROM (
       SELECT DISTINCT ON (m.key->>'id')
         m.id,
         (m.key->>'fromMe')::boolean AS from_me,
         m."pushName" AS sender_name,
         COALESCE(
           m.message->>'conversation',
           m.message->'imageMessage'->>'caption',
           m.message->'videoMessage'->>'caption',
           m.message->'documentMessage'->>'fileName'
         ) AS text,
         m."messageType" AS message_type,
         m."messageTimestamp" AS ts,
         (m."messageType" = ANY($4::text[])) AS is_media,
         -- Evolution writes a presigned S3 URL here once the upload lands.
         -- We only read whether it EXISTS: the stored signature expires after
         -- seven days, so the bytes are always re-fetched server-side.
         (m.message ? 'mediaUrl') AS archived,
         COALESCE(
           m.message->'imageMessage'->>'mimetype',
           m.message->'videoMessage'->>'mimetype',
           m.message->'audioMessage'->>'mimetype',
           m.message->'documentMessage'->>'mimetype',
           m.message->'stickerMessage'->>'mimetype'
         ) AS mimetype,
         m.message->'documentMessage'->>'fileName' AS file_name,
         vt.text AS voice_text,
         vt.status AS voice_status
       FROM evolution_api."Message" m
       LEFT JOIN katibe.voice_transcript vt ON vt.message_id = m.id
       WHERE m."instanceId" = $1
         AND m.key->>'remoteJid' = $2
         AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
       -- DISTINCT ON needs its key first; the outer query restores time order.
       ORDER BY m.key->>'id', m.id
     ) deduped
     ORDER BY ts DESC
     LIMIT $3 + 1
   ) recent
   ORDER BY ts ASC`,
    [instanceId, jid, limit, MEDIA_TYPES],
  );
  // The extra row is the oldest one, and the result is sorted oldest-first.
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(1) : rows;
  return {
    hasMore,
    messages: page.map((r) => ({
      id: r.id,
      fromMe: r.from_me,
      senderName: r.sender_name,
      text: r.text,
      messageType: r.message_type,
      timestamp: Number(r.ts),
      isMedia: r.is_media,
      archived: r.archived,
      mimetype: r.mimetype,
      fileName: r.file_name,
      voiceText: r.voice_text,
      voiceStatus: r.voice_status,
    })),
  };
}

export interface MediaRef {
  /** Our row id — a cuid, and what the page URL carries. */
  messageId: string;
  /**
   * WhatsApp's own message id, from key->>'id'. NOT the same value as `id`,
   * and it is the one Evolution looks messages up by, so re-downloading with
   * the row id silently finds nothing.
   */
  waMessageId: string;
  messageType: string;
  mimetype: string | null;
  fileName: string | null;
  /** Presigned S3 URL Evolution stored at upload time. Expires after 7 days. */
  storedUrl: string | null;
}

/**
 * Everything needed to serve one message's file, scoped to the instance.
 *
 * Scoping by instanceId is not decoration: the message id comes off a URL, and
 * without it one tenant could read another's media by guessing an id.
 */
export async function getMediaRef(instanceId: ScopedInstanceId, messageId: string): Promise<MediaRef | null> {
  const { rows } = await pool.query(
    `SELECT m.id, (m.key->>'id')::text AS wa_message_id, m."messageType",
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
    [instanceId, messageId, MEDIA_TYPES],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    messageId: r.id,
    waMessageId: r.wa_message_id,
    messageType: r.messageType,
    mimetype: r.mimetype,
    fileName: r.file_name,
    storedUrl: r.stored_url,
  };
}

export type ChatBaseSort = "slowest" | "waiting" | "volume" | "fastest";

export interface ChatBaseRow {
  jid: string;
  contact: string;
  chatType: ChatType;
  categoryName: string | null;
  /** How long the other side waits for us, in seconds. Null if never measured. */
  ourReplySeconds: number | null;
  ourReplyCount: number;
  /** How long we wait for them. */
  theirReplySeconds: number | null;
  theirReplyCount: number;
  /** Seconds their last message has gone unanswered, or null if the ball is ours. */
  waitingSeconds: number | null;
  messageCount: number;
}

/**
 * Per-chat response behaviour: how long the other side waits for us, and how
 * long we wait for them.
 *
 * Both directions come from the same pass over consecutive message pairs — a
 * reply is a message whose predecessor came from the opposite side. Gaps
 * longer than MAX_REPLY_GAP_SECONDS are treated as a new conversation rather
 * than a very slow reply, so an overnight pause doesn't distort the average.
 *
 * `waitingSeconds` is the live one: their message is the most recent, and
 * this is how long it has sat there.
 */
export async function getChatBase(
  instanceId: ScopedInstanceId,
  days = 30,
  sort: ChatBaseSort = "slowest",
  limit = 100,
): Promise<ChatBaseRow[]> {
  const order =
    sort === "waiting"
      ? `waiting_seconds DESC NULLS LAST`
      : sort === "volume"
        ? `message_count DESC`
        : sort === "fastest"
          ? `our_reply_seconds ASC NULLS LAST`
          : `our_reply_seconds DESC NULLS LAST`;

  const { rows } = await pool.query(
    `WITH win AS MATERIALIZED (
       SELECT
         m.key->>'remoteJid' AS jid,
         (m.key->>'fromMe')::boolean AS from_me,
         m."messageTimestamp" AS ts
       FROM evolution_api."Message" m
       WHERE m."instanceId" = $1
         AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
         AND m."messageTimestamp" > ${EPOCH_DAYS_AGO}
     ),
     paired AS (
       SELECT jid, from_me, ts,
              LAG(ts) OVER w AS prev_ts,
              LAG(from_me) OVER w AS prev_from_me
       FROM win
       WINDOW w AS (PARTITION BY jid ORDER BY ts)
     ),
     agg AS (
       SELECT
         jid,
         COUNT(*) AS message_count,
         -- We answered them: our message follows theirs.
         ROUND(AVG(ts - prev_ts) FILTER (
           WHERE from_me AND prev_from_me = false AND (ts - prev_ts) BETWEEN 1 AND $3::int)) AS our_reply_seconds,
         COUNT(*) FILTER (
           WHERE from_me AND prev_from_me = false AND (ts - prev_ts) BETWEEN 1 AND $3::int) AS our_reply_count,
         -- They answered us.
         ROUND(AVG(ts - prev_ts) FILTER (
           WHERE from_me = false AND prev_from_me AND (ts - prev_ts) BETWEEN 1 AND $3::int)) AS their_reply_seconds,
         COUNT(*) FILTER (
           WHERE from_me = false AND prev_from_me AND (ts - prev_ts) BETWEEN 1 AND $3::int) AS their_reply_count,
         -- Unanswered only when the newest message in the window is theirs.
         CASE WHEN (ARRAY_AGG(from_me ORDER BY ts DESC))[1] = false
              THEN EXTRACT(EPOCH FROM now())::bigint - MAX(ts)
         END AS waiting_seconds
       FROM paired GROUP BY jid
     ),
     -- Sorting and the cut happen BEFORE any name is resolved: nothing here
     -- orders by the name, and nameJoins' pushName loop costs one lookup per
     -- row. On this table that is 100 rows instead of every chat in the window.
     top AS (
       SELECT * FROM agg ORDER BY ${order} LIMIT $4
     )
     SELECT
       t.*,
       ${contactDisplaySql("t.jid")} AS contact,
       cat.name AS category_name
     FROM top t
     ${nameJoins("t.jid", "$1")}
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     ORDER BY ${order}`,
    [instanceId, days, MAX_REPLY_GAP_SECONDS, limit],
  );

  const n = (v: unknown) => (v === null ? null : Number(v));
  return rows.map((r) => ({
    jid: r.jid,
    contact: r.contact,
    chatType: classifyJid(r.jid),
    categoryName: r.category_name,
    ourReplySeconds: n(r.our_reply_seconds),
    ourReplyCount: Number(r.our_reply_count),
    theirReplySeconds: n(r.their_reply_seconds),
    theirReplyCount: Number(r.their_reply_count),
    waitingSeconds: n(r.waiting_seconds),
    messageCount: Number(r.message_count),
  }));
}

export interface DirectoryEntry {
  jid: string;
  chatType: ChatType;
  /** Dialable number, when there is one — see phoneSql(). */
  phoneNumber: string | null;
  displayName: string | null;
  groupSubject: string | null;
  categoryId: number | null;
  categoryName: string | null;
  /** Instance names this JID has a conversation in. */
  instances: InstanceRef[];
  messageCount: number;
}

/**
 * The shared contact directory: every JID a human has named or categorised,
 * across all instances.
 *
 * katibe.contact_labels is keyed by remote_jid alone, so one name already
 * applies everywhere the number appears. This view exists to make that
 * visible and editable in one place, and to show which accounts each contact
 * actually talks to.
 */
export async function getDirectory(
  search = "",
  { categoryId, limit = 1000 }: { categoryId?: number | "none"; limit?: number } = {},
): Promise<DirectoryEntry[]> {
  const term = search.trim();
  // "none" is a real choice, not the absence of one: a contact someone named
  // but never categorised is exactly what a reviewer wants to find.
  const categoryWhere =
    categoryId === "none"
      ? `cl.category_id IS NULL`
      : typeof categoryId === "number"
        ? `cl.category_id = ${categoryId}`
        : `TRUE`;
  const { rows } = await pool.query(
    `WITH labeled AS (
       SELECT remote_jid AS jid FROM katibe.contact_labels
     ),
     per_jid AS (
       SELECT m.key->>'remoteJid' AS jid,
              COUNT(*) AS message_count,
              JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT('id', i.id, 'name', i.name)) AS instances
       FROM evolution_api."Message" m
       JOIN evolution_api."Instance" i ON i.id = m."instanceId"
       WHERE m.key->>'remoteJid' IN (SELECT jid FROM labeled)
       GROUP BY 1
     )
     SELECT
       l.jid,
       ${phoneSql("l.jid", "ln")} AS phone_number,
       cl.display_name,
       gs.subject AS group_subject,
       cl.category_id,
       cat.name AS category_name,
       COALESCE(p.instances, '[]'::jsonb) AS instances,
       COALESCE(p.message_count, 0) AS message_count
     FROM labeled l
     JOIN katibe.contact_labels cl ON cl.remote_jid = l.jid
     LEFT JOIN katibe.group_subject gs ON gs.remote_jid = l.jid
     LEFT JOIN katibe.lid_number ln ON ln.lid_jid = l.jid
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     LEFT JOIN per_jid p ON p.jid = l.jid
     WHERE ${categoryWhere}
       ${term ? `AND (cl.display_name ILIKE $2 OR l.jid ILIKE $2 OR gs.subject ILIKE $2)` : ""}
     ORDER BY COALESCE(p.message_count, 0) DESC
     LIMIT $1`,
    term ? [limit, `%${term}%`] : [limit],
  );
  return rows.map((r) => ({
    jid: r.jid,
    chatType: classifyJid(r.jid),
    phoneNumber: r.phone_number,
    displayName: r.display_name,
    groupSubject: r.group_subject,
    categoryId: r.category_id,
    categoryName: r.category_name,
    instances: r.instances ?? [],
    messageCount: Number(r.message_count),
  }));
}

export interface UnassignedInstance {
  id: string;
  name: string;
  connectionStatus: string;
  number: string | null;
}

/** Evolution API instances that don't yet appear in katibe.user_instances. */
export async function getUnassignedInstances(): Promise<UnassignedInstance[]> {
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i."connectionStatus" AS connection_status, i.number
     FROM evolution_api."Instance" i
     WHERE NOT EXISTS (SELECT 1 FROM katibe.user_instances ui WHERE ui.instance_id = i.id AND ui.ended_at IS NULL)
     ORDER BY i.name ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    connectionStatus: r.connection_status,
    number: r.number,
  }));
}

export interface InstanceAssignment {
  instanceId: string;
  instanceName: string;
  connectionStatus: string;
  userId: number;
  userName: string;
}

export async function getInstanceAssignments(): Promise<InstanceAssignment[]> {
  const { rows } = await pool.query(
    `SELECT
       ui.instance_id,
       i.name AS instance_name,
       i."connectionStatus" AS connection_status,
       u.id AS user_id,
       u.name AS user_name
     FROM katibe.user_instances ui
     JOIN evolution_api."Instance" i ON i.id = ui.instance_id
     JOIN katibe.users u ON u.id = ui.user_id
     WHERE ui.ended_at IS NULL
     ORDER BY u.name ASC, i.name ASC`,
  );
  return rows.map((r) => ({
    instanceId: r.instance_id,
    instanceName: r.instance_name,
    connectionStatus: r.connection_status,
    userId: r.user_id,
    userName: r.user_name,
  }));
}

export interface AdminInstance {
  id: string;
  name: string;
  number: string | null;
  connectionStatus: string;
  /** Hazırkı sahibi — təyinat bağlanmayıbsa. */
  ownerName: string | null;
}

/**
 * Admin siyahısı üçün BÜTÜN nömrələr — təyin olunanı da, olunmayanı da.
 *
 * Mesaj sayğacı qəsdən yoxdur: beş instans üçün `COUNT(*)` 1,5 saniyə çəkir və
 * bu səhifə hər admin əməliyyatından sonra yenidən qurulur. Rəqəm yalnız
 * lazım olan yerdə — silmə təsdiqində — bir instans üçün oxunur.
 */
export async function getAdminInstances(): Promise<AdminInstance[]> {
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i.number, i."connectionStatus" AS connection_status, u.name AS owner_name
       FROM evolution_api."Instance" i
       LEFT JOIN katibe.user_instances ui ON ui.instance_id = i.id AND ui.ended_at IS NULL
       LEFT JOIN katibe.users u ON u.id = ui.user_id
      ORDER BY i.name ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    number: r.number,
    connectionStatus: r.connection_status,
    ownerName: r.owner_name,
  }));
}

export interface LabeledChat {
  jid: string;
  contactName: string;
  chatType: ChatType;
  needsLabel: boolean;
  displayName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  /** Total messages ever exchanged in this chat — the list's sort key. */
  msgCount: number;
  /** Their message is the newest one AND recent — someone is still waiting on us. */
  awaitingReply: boolean;
  /** Pending AI proposal, if one exists and hasn't been accepted/rejected yet. */
  suggestion: ChatSuggestion | null;
}

export interface ChatSuggestion {
  name: string | null;
  categoryId: number | null;
  categoryName: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string | null;
}

/** How many chats the instance page opens with. */
export const RECENT_CHATS_LIMIT = 30;

export interface RecentChat {
  jid: string;
  /** Resolved name — never a bare JID, see contactDisplaySql(). */
  contact: string;
  chatType: ChatType;
  categoryName: string | null;
  /** Epoch seconds of the newest message. */
  lastTs: number;
  lastFromMe: boolean;
  /** Body of the newest message, or null when it carries no text (media). */
  lastText: string | null;
  lastType: string;
  /** Their message is the newest one — the ball is in our court. */
  awaiting: boolean;
}

/*
 * The windows getRecentChats() tries, in order.
 *
 * A recency list is nearly always answered by the first one, and the window is
 * what makes it fast: with a timestamp bound Postgres walks
 * Message_instanceId_ts_idx (~35-110ms here), while an unbounded "newest
 * message per chat" degrades into a seq scan of every message the instance
 * ever received — measured at 1.2s.
 *
 * The later entries exist for accounts that have gone quiet: a number with no
 * traffic for a week must still show its last conversations rather than an
 * empty panel. null means no bound at all, and is only ever reached by an
 * instance that has been silent for a year.
 */
const RECENT_WINDOWS_DAYS = [7, 30, 365, null] as const;

/**
 * The newest conversations, most recent first — the "what is happening right
 * now" list, as opposed to getChats(), which ranks by lifetime volume.
 *
 * Sorted and cut BEFORE names are resolved, so the pushName lookup in
 * nameJoins() runs for 30 rows rather than for every chat on the account.
 */
export async function getRecentChats(
  instanceId: ScopedInstanceId,
  limit = RECENT_CHATS_LIMIT,
): Promise<RecentChat[]> {
  for (const days of RECENT_WINDOWS_DAYS) {
    const rows = await recentChatsWindow(instanceId, limit, days);
    // A short answer is only trustworthy from the widest window: anywhere else
    // it means the window cut the list, not that the chats do not exist.
    if (rows.length >= limit || days === null) return rows;
  }
  return [];
}

async function recentChatsWindow(
  instanceId: ScopedInstanceId,
  limit: number,
  days: number | null,
): Promise<RecentChat[]> {
  const windowSql = days === null ? "TRUE" : `m."messageTimestamp" > $3`;
  const args: unknown[] = [instanceId, limit];
  if (days !== null) args.push(Math.floor(Date.now() / 1000) - days * 86_400);

  const { rows } = await pool.query(
    `WITH per_chat AS (
       -- Newest message per chat, and nothing else: the text itself is read
       -- below, for the rows that survive the cut. Carrying the jsonb column
       -- through this sort is what made the monitor's first version slow.
       SELECT DISTINCT ON (m.key->>'remoteJid')
              m.key->>'remoteJid' AS jid,
              m."messageTimestamp" AS last_ts
       FROM evolution_api."Message" m
       WHERE m."instanceId" = $1
         AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
         AND ${windowSql}
       ORDER BY m.key->>'remoteJid', m."messageTimestamp" DESC
     ),
     page AS (
       SELECT * FROM per_chat ORDER BY last_ts DESC LIMIT $2
     )
     SELECT p.jid, p.last_ts, lm.from_me, lm.message_type, lm.text,
            ${contactDisplaySql("p.jid")} AS contact,
            cat.name AS category_name
     FROM page p
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
       WHERE m2."instanceId" = $1
         AND m2.key->>'remoteJid' = p.jid
         AND m2."messageTimestamp" = p.last_ts
         AND m2."messageType" NOT IN ('protocolMessage', 'reactionMessage')
       LIMIT 1
     ) lm ON true
     ${nameJoins("p.jid", "$1")}
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     ORDER BY p.last_ts DESC`,
    args,
  );

  return rows.map((r) => ({
    jid: r.jid,
    contact: r.contact,
    chatType: classifyJid(r.jid),
    categoryName: r.category_name,
    lastTs: Number(r.last_ts),
    lastFromMe: r.from_me === true,
    lastText: r.text,
    lastType: r.message_type ?? "conversation",
    awaiting: r.from_me === false,
  }));
}

// One screenful at a time — the full list runs to hundreds of chats, and
// rendering them all is what made changing a filter feel slow.
export const CHAT_PAGE_SIZE = 50;

// Chats below this many messages are hidden by default. Of ~930 JIDs on a
// live instance, 160 have no messages at all and another 442 have five or
// fewer — mostly one-off pings and stale Chat rows Evolution wrote but never
// filled. They pushed the real conversations off the first pages.
//
// The exception in msg_meta.awaiting_reply is the important half: a quiet
// chat whose newest message came from THEM is someone waiting on a reply, so
// it stays visible no matter how short it is.
export const MIN_CHAT_MESSAGES = 6;

// How recently a chat must have gone unanswered for the exception above to
// apply. Unbounded, it rescues 264 chats reaching back to May 2025; at 30
// days it rescues the 19 that someone could still act on.
export const AWAITING_RECENT_DAYS = 30;

export type ChatFilter = "unnamed" | "named" | "all" | "suggested";
export type ChatTypeFilter = "all" | "group" | "individual" | "lid";

export interface ChatListResult {
  chats: LabeledChat[];
  totalChats: number;
  unnamedCount: number;
  namedCount: number;
  /** Pending AI proposals awaiting accept/reject, across the whole instance. */
  suggestedCount: number;
  shown: number;
  /** Rows matching the current filter, before paging — drives the pager. */
  matchCount: number;
  /** Low-volume chats the default filter is holding back, so the UI can offer them. */
  quietCount: number;
  page: number;
  pageCount: number;
}

/**
 * Every chat for an instance, resolved into one row per JID.
 *
 * Built from Chat rows UNION the JIDs that only appear in Message — Evolution
 * doesn't always write a Chat row, and without the union those conversations
 * show up in the stats tables but are unreachable in the naming list.
 *
 * Names come from contactDisplaySql(), the same expression the monitor and the
 * supervisor feed use, so one chat cannot be called two different things in
 * two places. The pushName it needs is lifted out of msg_meta rather than
 * looked up per row — see the note there.
 */
const CHAT_BASE_SQL = `
  WITH msg_meta AS (
    SELECT key->>'remoteJid' AS jid,
           MAX("messageTimestamp") AS last_ts,
           COUNT(*) AS msg_count,
           -- The newest message came from them, i.e. they are waiting on us.
           -- A chat in that state is never hidden by the low-volume filter,
           -- however few messages it has: an unanswered customer is exactly
           -- the one we must not lose off the bottom of the list.
           (ARRAY_AGG((key->>'fromMe')::boolean ORDER BY "messageTimestamp" DESC))[1] = false
             AS last_from_them,
           -- ...but only while it is still actionable. 264 chats on this
           -- instance are short and unanswered, and all but 19 of them trail
           -- back as far as May 2025 — one-off pings nobody was ever going to
           -- answer. Without the recency bound the exception hands the clutter
           -- straight back.
           ((ARRAY_AGG((key->>'fromMe')::boolean ORDER BY "messageTimestamp" DESC))[1] = false
            AND to_timestamp(MAX("messageTimestamp")) > now() - make_interval(days => ${AWAITING_RECENT_DAYS}))
             AS awaiting_reply,
           -- The name most @lid chats have and no other table carries. It is
           -- taken here, out of a scan that is happening anyway, precisely so
           -- the list does NOT need nameJoins' per-row lookup: this query
           -- resolves a name for every chat before filtering, because both the
           -- search box and the unnamed/named counts read it.
           MAX("pushName") FILTER (
             WHERE (key->>'fromMe')::boolean = false AND COALESCE("pushName", '') <> ''
           ) AS push_name
    FROM evolution_api."Message" WHERE "instanceId" = $1 GROUP BY 1
  ),
  all_jids AS (
    SELECT "remoteJid" AS jid FROM evolution_api."Chat" WHERE "instanceId" = $1
    UNION
    SELECT jid FROM msg_meta
  ),
  resolved AS (
    SELECT
      j.jid,
      ${contactDisplaySql("j.jid", "mm.push_name")} AS contact_name,
      -- Exactly the question the list is a queue for: is there a real name, or
      -- only a substitute? Same expression that produced contact_name, so the
      -- 🏷️ badge can never contradict what is printed next to it.
      (${knownNameSql("j.jid", "mm.push_name")} IS NULL) AS needs_label,
      cl.display_name,
      cl.category_id,
      cat.name AS category_name,
      COALESCE(to_timestamp(mm.last_ts), ch."updatedAt") AS activity_at,
      COALESCE(mm.msg_count, 0) AS msg_count,
      COALESCE(mm.last_from_them, false) AS last_from_them,
      COALESCE(mm.awaiting_reply, false) AS awaiting_reply,
      sg.suggested_name,
      sg.suggested_category_id,
      sgcat.name AS suggested_category_name,
      sg.confidence AS suggestion_confidence,
      sg.reason AS suggestion_reason
    FROM all_jids j
    LEFT JOIN evolution_api."Chat" ch ON ch."instanceId" = $1 AND ch."remoteJid" = j.jid
    LEFT JOIN evolution_api."Contact" ct ON ct."instanceId" = $1 AND ct."remoteJid" = j.jid
    LEFT JOIN msg_meta mm ON mm.jid = j.jid
    LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = j.jid
    ${groupSubjectJoin("j.jid")}
    LEFT JOIN katibe.lid_number ln ON ln.lid_jid = j.jid
    LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = j.jid
    LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
    LEFT JOIN katibe.chat_suggestion sg
      ON sg.remote_jid = j.jid AND sg.resolved_at IS NULL
    LEFT JOIN katibe.categories sgcat ON sgcat.id = sg.suggested_category_id
  )`;

const TYPE_SQL: Record<Exclude<ChatTypeFilter, "all">, string> = {
  group: `jid LIKE '%@g.us'`,
  individual: `jid LIKE '%@s.whatsapp.net'`,
  lid: `jid LIKE '%@lid'`,
};

/**
 * `named` picks the named/unnamed slice, `type` narrows to groups or
 * individuals, and `search` matches the resolved name or the raw JID. Counts
 * respect `type` and `search` but not `named`, so the UI can say "of the
 * groups matching this search, 12 still need a name".
 */
export async function getChats(
  instanceId: ScopedInstanceId,
  {
    named = "unnamed",
    type = "all",
    search = "",
    page = 1,
    includeQuiet = false,
  }: {
    named?: ChatFilter;
    type?: ChatTypeFilter;
    search?: string;
    page?: number;
    /** Drop the low-volume gate and list every chat, however few messages it has. */
    includeQuiet?: boolean;
  } = {},
): Promise<ChatListResult> {
  const namedWhere =
    named === "unnamed"
      ? `needs_label`
      : named === "named"
        ? `NOT needs_label`
        : named === "suggested"
          ? `suggestion_confidence IS NOT NULL`
          : `TRUE`;
  const typeWhere = type === "all" ? "TRUE" : TYPE_SQL[type];
  const term = search.trim();
  // Each query binds only the parameters it actually references — an unused
  // placeholder makes Postgres fail with 42P18 (can't infer its type).
  const searchClause = (idx: number) =>
    term ? `(contact_name ILIKE $${idx} OR jid ILIKE $${idx})` : `TRUE`;
  const searchArgs = term ? [`%${term}%`] : [];

  // A search is asked of the whole instance, so it reaches past the
  // low-volume gate the same way it reaches past the named/unnamed tab.
  // MIN_CHAT_MESSAGES is a module constant, not user input, so interpolating
  // it here cannot carry a parameter through.
  const volumeWhere =
    includeQuiet || term
      ? `TRUE`
      : `(msg_count >= ${MIN_CHAT_MESSAGES} OR awaiting_reply)`;

  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const offset = (safePage - 1) * CHAT_PAGE_SIZE;

  // One round trip, so the expensive `resolved` CTE (which aggregates the
  // whole Message table) is built once instead of once per query. Running the
  // page and the counts separately doubled the cost of every filter change.
  const { rows } = await pool.query(
    `${CHAT_BASE_SQL},
     filtered AS (
       SELECT * FROM resolved WHERE ${typeWhere} AND ${searchClause(4)}
     ),
     visible AS (
       SELECT * FROM filtered WHERE ${volumeWhere}
     ),
     counts AS (
       SELECT
         (SELECT COUNT(*) FROM visible) AS total,
         (SELECT COUNT(*) FROM visible WHERE needs_label) AS unnamed,
         (SELECT COUNT(*) FROM visible WHERE suggestion_confidence IS NOT NULL) AS suggested,
         (SELECT COUNT(*) FROM visible WHERE ${namedWhere}) AS matched,
         (SELECT COUNT(*) FROM filtered) - (SELECT COUNT(*) FROM visible) AS quiet
     ),
     page AS (
       SELECT jid, contact_name, needs_label, display_name, category_id, category_name,
              msg_count, awaiting_reply,
              suggested_name, suggested_category_id, suggested_category_name,
              suggestion_confidence, suggestion_reason
       FROM visible
       WHERE ${namedWhere}
       -- Busiest first: the whole point of the list is to name the chats that
       -- actually carry traffic. activity_at only breaks ties.
       ORDER BY msg_count DESC, activity_at DESC NULLS LAST
       LIMIT $2 OFFSET $3
     )
     SELECT c.total, c.unnamed, c.suggested, c.matched, c.quiet, p.*
     FROM counts c LEFT JOIN page p ON true`,
    [instanceId, CHAT_PAGE_SIZE, offset, ...searchArgs],
  );

  // The LEFT JOIN keeps one all-null row when the page is empty, so the counts
  // still come back for a filter that matches nothing.
  const first = rows[0];
  const total = Number(first?.total ?? 0);
  const unnamed = Number(first?.unnamed ?? 0);
  const matchCount = Number(first?.matched ?? 0);
  const pageRows = rows.filter((r) => r.jid !== null);

  return {
    chats: pageRows.map((r) => ({
      jid: r.jid,
      contactName: r.contact_name,
      chatType: classifyJid(r.jid),
      needsLabel: r.needs_label,
      displayName: r.display_name,
      categoryId: r.category_id,
      categoryName: r.category_name,
      msgCount: Number(r.msg_count),
      awaitingReply: r.awaiting_reply,
      suggestion: r.suggestion_confidence
        ? {
            name: r.suggested_name,
            categoryId: r.suggested_category_id,
            categoryName: r.suggested_category_name,
            confidence: r.suggestion_confidence,
            reason: r.suggestion_reason,
          }
        : null,
    })),
    totalChats: total,
    unnamedCount: unnamed,
    namedCount: total - unnamed,
    suggestedCount: Number(first?.suggested ?? 0),
    shown: pageRows.length,
    matchCount,
    quietCount: Number(first?.quiet ?? 0),
    page: safePage,
    pageCount: Math.max(1, Math.ceil(matchCount / CHAT_PAGE_SIZE)),
  };
}

export async function getOverview(instanceId: ScopedInstanceId): Promise<Overview> {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM evolution_api."Message" WHERE "instanceId" = $1) AS total_messages,
       (SELECT COUNT(*) FROM evolution_api."Contact" WHERE "instanceId" = $1) AS total_contacts,
       (SELECT COUNT(*) FROM evolution_api."Chat" WHERE "instanceId" = $1) AS total_chats,
       (SELECT COUNT(*) FROM evolution_api."Message" WHERE "instanceId" = $1
          AND "messageTimestamp" >= ${EPOCH_BAKU_TODAY}) AS messages_today`,
    [instanceId],
  );
  const r = rows[0];
  return {
    totalMessages: Number(r.total_messages),
    totalContacts: Number(r.total_contacts),
    totalChats: Number(r.total_chats),
    messagesToday: Number(r.messages_today),
  };
}

export interface RangeStats {
  topContacts: TopContact[];
  responseTimes: ResponseTime[];
  categoryStats: CategoryStat[];
}

/**
 * Every day-range statistic in one round trip, over a single scan of the
 * Message table.
 *
 * Previously each of these was its own query, and six concurrent sequential
 * scans of a 134MB table turned a ~200ms question into ~3s of contention on
 * this box. The `win` CTE is MATERIALIZED so the scan happens once and the
 * aggregates all read from its result; name resolution is joined afterwards,
 * against the few hundred aggregated rows rather than the 88k raw ones.
 *
 * `win` spans exactly the requested range. It used to span 2x, because the
 * since-removed trend-comparison section needed the previous period; nothing
 * left here looks back that far, so the scan is half what it was.
 */
export async function getRangeStats(instanceId: ScopedInstanceId, days = 14): Promise<RangeStats> {
  const { rows } = await pool.query(
    `WITH win AS MATERIALIZED (
       SELECT
         m.key->>'remoteJid' AS jid,
         (m.key->>'fromMe')::boolean AS from_me,
         m."messageTimestamp" AS ts
       FROM evolution_api."Message" m
       WHERE m."instanceId" = $1
         AND m."messageTimestamp" > ${EPOCH_DAYS_AGO}
     ),
     per_jid AS (
       SELECT jid,
              COUNT(*) FILTER (WHERE NOT from_me) AS received,
              COUNT(*) FILTER (WHERE from_me) AS sent,
              COUNT(*) AS current_total,
              -- The newest message in the window came from them, i.e. the
              -- ball is in our court.
              (ARRAY_AGG(from_me ORDER BY ts DESC))[1] = false AS last_from_them
       FROM win GROUP BY 1
     ),
     -- Categories only. The category breakdown groups every chat in the
     -- window, but nobody reads a name off it — and naming every chat here
     -- would run the pushName lookup hundreds of times for the 25 rows that
     -- actually reach the screen. Names are joined onto those below.
     named AS (
       SELECT p.*, cl.category_id, cat.name AS category_name
       FROM per_jid p
       LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = p.jid
       LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     ),
     gaps AS (
       SELECT jid, ts - prev_ts AS gap FROM (
         SELECT jid, ts, from_me,
                LAG(ts) OVER w AS prev_ts,
                LAG(from_me) OVER w AS prev_from_me
         FROM win
         WINDOW w AS (PARTITION BY jid ORDER BY ts)
       ) o
       WHERE from_me AND prev_from_me = false AND (ts - prev_ts) BETWEEN 1 AND $3::int
     ),
     replies AS (
       SELECT g.jid, ROUND(AVG(g.gap)) AS avg_reply_seconds, COUNT(*) AS reply_count
       FROM gaps g GROUP BY g.jid HAVING COUNT(*) >= 3
     ),
     top AS (
       SELECT jid, received, sent, current_total
       FROM named WHERE current_total > 0 ORDER BY current_total DESC LIMIT $4
     ),
     fastest AS (
       SELECT r.jid, r.avg_reply_seconds, r.reply_count
       FROM replies r ORDER BY r.avg_reply_seconds ASC LIMIT $5
     )
     SELECT
       (SELECT COALESCE(json_agg(x), '[]') FROM (
          SELECT ${contactDisplaySql("t.jid")} AS contact, t.jid, t.received, t.sent,
                 t.current_total AS total,
                 ROUND(t.current_total::numeric / $2::numeric, 1) AS avg_per_day
          FROM top t ${nameJoins("t.jid", "$1")}
          ORDER BY t.current_total DESC) x) AS top_contacts,
       (SELECT COALESCE(json_agg(x), '[]') FROM (
          SELECT ${contactDisplaySql("f.jid")} AS contact, f.jid, f.avg_reply_seconds, f.reply_count
          FROM fastest f ${nameJoins("f.jid", "$1")}
          ORDER BY f.avg_reply_seconds ASC) x) AS response_times,
       (SELECT COALESCE(json_agg(x), '[]') FROM (
          SELECT
            n.category_id,
            COALESCE(n.category_name, 'Kateqoriyasız') AS category_name,
            COUNT(*) AS chat_count,
            SUM(n.received) AS received,
            SUM(n.sent) AS sent,
            SUM(n.current_total) AS total,
            -- How quickly we answer this category, and how often we leave it
            -- hanging: the two numbers that turn volume into service quality.
            ROUND(AVG(r.avg_reply_seconds)) AS avg_reply_seconds,
            COUNT(*) FILTER (WHERE n.last_from_them) AS awaiting_us
          FROM named n
          LEFT JOIN replies r ON r.jid = n.jid
          WHERE n.current_total > 0
          GROUP BY n.category_id, n.category_name
          ORDER BY SUM(n.current_total) DESC) x) AS category_stats`,
    [instanceId, days, MAX_REPLY_GAP_SECONDS, 15, 10],
  );

  const r = rows[0];
  const num = (v: unknown) => Number(v);
  return {
    topContacts: (r.top_contacts as TopContact[]).map((c) => ({
      ...c, received: num(c.received), sent: num(c.sent), total: num(c.total), avgPerDay: num((c as unknown as { avg_per_day: number }).avg_per_day),
    })),
    responseTimes: (r.response_times as unknown as { contact: string; jid: string; avg_reply_seconds: number; reply_count: number }[]).map((x) => ({
      contact: x.contact, jid: x.jid, avgReplySeconds: num(x.avg_reply_seconds), replyCount: num(x.reply_count),
    })),
    categoryStats: (
      r.category_stats as unknown as {
        category_id: number | null; category_name: string; chat_count: number;
        received: number; sent: number; total: number;
        avg_reply_seconds: number | null; awaiting_us: number;
      }[]
    ).map((c) => ({
      categoryId: c.category_id, categoryName: c.category_name, chatCount: num(c.chat_count),
      received: num(c.received), sent: num(c.sent), total: num(c.total),
      avgReplySeconds: c.avg_reply_seconds === null ? null : num(c.avg_reply_seconds),
      awaitingUs: num(c.awaiting_us),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Client sweep review
 *
 * scripts/identify-clients.ts applies its HIGH-confidence calls on its own
 * and leaves the rest here. These queries feed /admin/suggestions, which is
 * where a human confirms the uncertain ones in bulk and can take back any
 * automatic label that got it wrong.
 * ------------------------------------------------------------------ */

/** The category the whole sweep is about, looked up by name. */
export async function getClientCategoryId(): Promise<number | null> {
  const { rows } = await pool.query(`SELECT id FROM katibe.categories WHERE name = 'Client'`);
  return rows[0]?.id ?? null;
}

export type SuggestionFilter = "client" | "other" | "all";

/** An account that has this conversation, and where to open it. */
export interface InstanceRef {
  id: string;
  name: string;
}

export interface PendingSuggestion {
  jid: string;
  chatType: ChatType;
  /** Dialable number, when there is one — see phoneSql(). */
  phoneNumber: string | null;
  /** The name WhatsApp itself knows, if any — an accept never overwrites it. */
  ownName: string | null;
  suggestedName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  isClient: boolean;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string | null;
  messageCount: number;
  instances: InstanceRef[];
}

// Same name resolution as applySuggestion() uses, so the review page shows
// exactly the name an accept would keep.
const OWN_NAME_SQL = `
  COALESCE(
    gs.subject,
    (SELECT c.name FROM evolution_api."Chat" c
      WHERE c."remoteJid" = s.remote_jid AND c.name IS NOT NULL LIMIT 1),
    (SELECT ct."pushName" FROM evolution_api."Contact" ct
      WHERE ct."remoteJid" = s.remote_jid AND ct."pushName" IS NOT NULL LIMIT 1)
  )`;

/**
 * Proposals still waiting on a human, client-first.
 *
 * Ordering is the point: the numbers the sweep thinks are clients come first,
 * then the surest calls, then the busiest chats — so reviewing top-down spends
 * attention where it changes the most.
 */
export async function getPendingSuggestions(
  filter: SuggestionFilter = "all",
  limit = 300,
): Promise<PendingSuggestion[]> {
  const clientId = await getClientCategoryId();
  const where =
    filter === "client" && clientId !== null
      ? `AND s.suggested_category_id = ${clientId}`
      : filter === "other" && clientId !== null
        ? `AND (s.suggested_category_id IS DISTINCT FROM ${clientId})`
        : ``;

  const { rows } = await pool.query(
    `WITH pending AS (
       SELECT remote_jid FROM katibe.chat_suggestion WHERE resolved_at IS NULL
     ),
     per_jid AS (
       SELECT m.key->>'remoteJid' AS jid,
              COUNT(*) AS message_count,
              JSONB_AGG(DISTINCT JSONB_BUILD_OBJECT('id', i.id, 'name', i.name)) AS instances
       FROM evolution_api."Message" m
       JOIN evolution_api."Instance" i ON i.id = m."instanceId"
       -- = ANY(ARRAY(...)), not IN (SELECT ...): the second one plans as a
       -- hash semi-join, which means reading all 254k messages instead of
       -- probing "Message_remoteJid_idx" for the hundred jids we care about.
       WHERE m.key->>'remoteJid' = ANY (ARRAY(SELECT remote_jid FROM pending))
       GROUP BY 1
     )
     SELECT s.remote_jid AS jid,
            ${OWN_NAME_SQL} AS own_name,
            ${phoneSql("s.remote_jid", "ln")} AS phone_number,
            s.suggested_name,
            s.suggested_category_id,
            cat.name AS category_name,
            s.confidence,
            s.reason,
            COALESCE(p.message_count, 0) AS message_count,
            COALESCE(p.instances, '[]'::jsonb) AS instances
     FROM katibe.chat_suggestion s
     LEFT JOIN katibe.group_subject gs ON gs.remote_jid = s.remote_jid
     LEFT JOIN katibe.lid_number ln ON ln.lid_jid = s.remote_jid
     LEFT JOIN katibe.categories cat ON cat.id = s.suggested_category_id
     LEFT JOIN per_jid p ON p.jid = s.remote_jid
     WHERE s.resolved_at IS NULL ${where}
     ORDER BY (s.suggested_category_id IS NOT DISTINCT FROM $2) DESC,
              CASE s.confidence WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
              COALESCE(p.message_count, 0) DESC
     LIMIT $1`,
    [limit, clientId],
  );

  return rows.map((r) => ({
    jid: r.jid,
    chatType: classifyJid(r.jid),
    phoneNumber: r.phone_number,
    ownName: r.own_name,
    suggestedName: r.suggested_name,
    categoryId: r.suggested_category_id,
    categoryName: r.category_name,
    isClient: clientId !== null && r.suggested_category_id === clientId,
    confidence: r.confidence,
    reason: r.reason,
    messageCount: Number(r.message_count),
    instances: r.instances ?? [],
  }));
}

export interface SuggestionCounts {
  pending: number;
  pendingClients: number;
  auto: number;
  autoClients: number;
}

export async function getSuggestionCounts(): Promise<SuggestionCounts> {
  const clientId = await getClientCategoryId();
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE resolved_at IS NULL) AS pending,
       COUNT(*) FILTER (WHERE resolved_at IS NULL
                          AND suggested_category_id IS NOT DISTINCT FROM $1) AS pending_clients,
       COUNT(*) FILTER (WHERE resolution = 'AUTO') AS auto,
       COUNT(*) FILTER (WHERE resolution = 'AUTO'
                          AND suggested_category_id IS NOT DISTINCT FROM $1) AS auto_clients
     FROM katibe.chat_suggestion`,
    [clientId],
  );
  return {
    pending: Number(rows[0]?.pending ?? 0),
    pendingClients: Number(rows[0]?.pending_clients ?? 0),
    auto: Number(rows[0]?.auto ?? 0),
    autoClients: Number(rows[0]?.auto_clients ?? 0),
  };
}

export interface AutoAppliedLabel {
  jid: string;
  chatType: ChatType;
  name: string;
  categoryName: string | null;
  isClient: boolean;
  reason: string | null;
  appliedAt: string;
  messageCount: number;
}

/**
 * Labels the sweep wrote by itself, newest first — the audit trail for
 * everything that skipped review, and where a wrong one gets reverted.
 *
 * Only rows whose label is still the automatic one are listed: editing a
 * contact by hand afterwards makes it a human decision, not something to
 * offer an "undo" for.
 */
export async function getAutoAppliedLabels(limit = 200): Promise<AutoAppliedLabel[]> {
  const clientId = await getClientCategoryId();
  const { rows } = await pool.query(
    `WITH auto AS (
       SELECT remote_jid FROM katibe.chat_suggestion WHERE resolution = 'AUTO'
     ),
     per_jid AS (
       SELECT m.key->>'remoteJid' AS jid, COUNT(*) AS message_count
       FROM evolution_api."Message" m
       WHERE m.key->>'remoteJid' = ANY (ARRAY(SELECT remote_jid FROM auto))
       GROUP BY 1
     )
     SELECT s.remote_jid AS jid,
            COALESCE(cl.display_name, ${OWN_NAME_SQL}, s.remote_jid) AS name,
            cl.category_id,
            cat.name AS category_name,
            s.reason,
            s.resolved_at,
            COALESCE(p.message_count, 0) AS message_count
     FROM katibe.chat_suggestion s
     JOIN katibe.contact_labels cl ON cl.remote_jid = s.remote_jid
     LEFT JOIN katibe.group_subject gs ON gs.remote_jid = s.remote_jid
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     LEFT JOIN per_jid p ON p.jid = s.remote_jid
     WHERE s.resolution = 'AUTO'
       AND cl.category_id IS NOT DISTINCT FROM s.suggested_category_id
     ORDER BY (cl.category_id IS NOT DISTINCT FROM $2) DESC, s.resolved_at DESC
     LIMIT $1`,
    [limit, clientId],
  );
  return rows.map((r) => ({
    jid: r.jid,
    chatType: classifyJid(r.jid),
    name: r.name,
    categoryName: r.category_name,
    isClient: clientId !== null && r.category_id === clientId,
    reason: r.reason,
    appliedAt: r.resolved_at,
    messageCount: Number(r.message_count),
  }));
}

export interface CategoryCount {
  /** Null on the "no category" row, which is a bucket like any other here. */
  id: number | null;
  name: string;
  contacts: number;
  /** How many of them you could actually dial — see phoneSql(). */
  withNumber: number;
}

/**
 * Every category with how many contacts sit in it, for the directory's filter
 * bar. Empty categories are included: seeing a zero is how you notice a
 * category nobody uses.
 */
export async function getCategoryCounts(): Promise<CategoryCount[]> {
  const { rows } = await pool.query(
    `SELECT c.id, c.name,
            COUNT(cl.remote_jid)::int AS contacts,
            COUNT(*) FILTER (
              WHERE cl.remote_jid LIKE '%@s.whatsapp.net' OR ln.lid_jid IS NOT NULL
            )::int AS with_number
     FROM katibe.categories c
     LEFT JOIN katibe.contact_labels cl ON cl.category_id = c.id
     LEFT JOIN katibe.lid_number ln ON ln.lid_jid = cl.remote_jid
     GROUP BY c.id, c.name

     UNION ALL

     SELECT NULL, 'Kateqoriyasız',
            COUNT(*)::int,
            COUNT(*) FILTER (
              WHERE cl.remote_jid LIKE '%@s.whatsapp.net' OR ln.lid_jid IS NOT NULL
            )::int
     FROM katibe.contact_labels cl
     LEFT JOIN katibe.lid_number ln ON ln.lid_jid = cl.remote_jid
     WHERE cl.category_id IS NULL

     ORDER BY contacts DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    contacts: Number(r.contacts),
    withNumber: Number(r.with_number),
  }));
}


// --- SLA qaydaları ---------------------------------------------------------
//
// Qaydanın konfiqi DƏYİŞMİR, YENİ VERSİYA yaranır (sql/2026-08-24_sla_rules.sql).
// Səbəb: heç bir cavab vaxtı bazada saxlanmır — getWorkloadStats() hər dəfə
// yenidən hesablayır. Ona görə qaydanı yerində redaktə etmək keçən həftənin
// rəqəmlərini də səssizcə dəyişərdi. Ölçmə həmişə müştəri mesajının GƏLDİYİ
// ana düşən versiyanı tapır.

export interface SlaRuleConfig {
  /** IANA zona adı ('Asia/Baku'), offset yox — DST buna görə düz işləyir. */
  timezone: string;
  /** Yerli divar saatı, 'HH:MM'. */
  businessStart: string;
  businessEnd: string;
  /** ISO gün nömrələri: 1=B.e … 7=Bazar. */
  businessDays: number[];
  targetBusinessMinutes: number;
  targetOffhoursMinutes: number;
  targetWeekendMinutes: number;
}

export interface SlaRuleVersion extends SlaRuleConfig {
  id: number;
  version: number;
  /** null = «əvvəldən» (bazada -infinity). Qayda yaranmazdan əvvəlki vaxtı da əhatə edir. */
  effectiveFrom: Date | null;
  /** null = hələ qüvvədədir. */
  effectiveTo: Date | null;
}

/**
 * pg sürücüsü 'infinity'/'-infinity' timestamptz-i Date yox, ±Infinity ƏDƏDİ
 * kimi qaytarır. Onu Date sanıb .getTime() çağırmaq səhifəni uçurur, ona görə
 * sərhəd dəyərləri burada null-a çevrilir və UI-da söz kimi göstərilir.
 */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  return null;
}

export interface SlaRule {
  id: number;
  name: string;
  retiredAt: Date | null;
  /** Hazırda qüvvədə olan versiya. */
  current: SlaRuleVersion | null;
  versionCount: number;
  /** İndi bu qaydaya bağlı istifadəçilər — silinməni bloklayan say. */
  attachedUserCount: number;
  /** Nə vaxtsa bağlı olmuşlar — bunlar varsa qayda ancaq arxivlənə bilər. */
  everAttachedUserCount: number;
}

function mapVersion(r: Record<string, unknown>): SlaRuleVersion | null {
  if (r.v_id === null || r.v_id === undefined) return null;
  return {
    id: Number(r.v_id),
    version: Number(r.version),
    effectiveFrom: toDate(r.effective_from),
    effectiveTo: toDate(r.effective_to),
    timezone: r.timezone as string,
    businessStart: String(r.business_start).slice(0, 5),
    businessEnd: String(r.business_end).slice(0, 5),
    businessDays: (r.business_days as number[]).map(Number),
    targetBusinessMinutes: Number(r.target_business_minutes),
    targetOffhoursMinutes: Number(r.target_offhours_minutes),
    targetWeekendMinutes: Number(r.target_weekend_minutes),
  };
}

const VERSION_COLUMNS = `v.id AS v_id, v.version, v.effective_from, v.effective_to, v.timezone,
       v.business_start, v.business_end, v.business_days,
       v.target_business_minutes, v.target_offhours_minutes, v.target_weekend_minutes`;

export async function getSlaRules(): Promise<SlaRule[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r.name, r.retired_at, ${VERSION_COLUMNS},
       (SELECT COUNT(*) FROM katibe.sla_rule_versions x WHERE x.rule_id = r.id) AS version_count,
       (SELECT COUNT(*) FROM katibe.user_sla_rules u WHERE u.rule_id = r.id AND u.ended_at IS NULL) AS attached_now,
       (SELECT COUNT(DISTINCT u.user_id) FROM katibe.user_sla_rules u WHERE u.rule_id = r.id) AS attached_ever
     FROM katibe.sla_rules r
     LEFT JOIN katibe.sla_rule_versions v ON v.rule_id = r.id AND v.effective_to IS NULL
     ORDER BY (r.retired_at IS NOT NULL), r.name ASC`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    retiredAt: r.retired_at,
    current: mapVersion(r),
    versionCount: Number(r.version_count),
    attachedUserCount: Number(r.attached_now),
    everAttachedUserCount: Number(r.attached_ever),
  }));
}

/** Bütün qaydaların versiyaları, rule_id-yə görə qruplanmış — yenidən köhnəyə. */
export async function getSlaRuleVersionsByRule(): Promise<Map<number, SlaRuleVersion[]>> {
  const { rows } = await pool.query(
    `SELECT v.rule_id, ${VERSION_COLUMNS} FROM katibe.sla_rule_versions v
     ORDER BY v.rule_id, v.version DESC`,
  );
  const byRule = new Map<number, SlaRuleVersion[]>();
  for (const r of rows) {
    const id = Number(r.rule_id);
    if (!byRule.has(id)) byRule.set(id, []);
    byRule.get(id)!.push(mapVersion(r)!);
  }
  return byRule;
}

/**
 * Seçim üçün IANA zona adları. Offset deyil ad saxlanır (DST buna görə düz
 * işləyir), ona görə siyahı da elə bazanın öz tzdata-sından gəlir — əl ilə
 * yazılmış siyahı tzdata yenilənəndə köhnəlirdi.
 */
export async function getTimezoneNames(): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT name FROM pg_timezone_names
     WHERE name LIKE '%/%' AND name NOT LIKE 'posix/%' AND name NOT LIKE 'right/%'
     ORDER BY name`,
  );
  return rows.map((r) => r.name as string);
}

export interface UserSlaAssignment {
  userId: number;
  userName: string;
  ruleId: number | null;
  ruleName: string | null;
  assignedAt: Date | null;
}

/** Admin ekranı üçün: kimin indi hansı qaydası var. */
export async function getUserSlaAssignments(): Promise<UserSlaAssignment[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.name, usr.rule_id, r.name AS rule_name, usr.assigned_at
     FROM katibe.users u
     LEFT JOIN katibe.user_sla_rules usr ON usr.user_id = u.id AND usr.ended_at IS NULL
     LEFT JOIN katibe.sla_rules r ON r.id = usr.rule_id
     ORDER BY u.name ASC`,
  );
  return rows.map((r) => ({
    userId: Number(r.id),
    userName: r.name,
    ruleId: r.rule_id === null ? null : Number(r.rule_id),
    ruleName: r.rule_name,
    assignedAt: toDate(r.assigned_at),
  }));
}

/**
 * Yeni qayda + onun 1-ci versiyası.
 *
 * effective_from = -infinity: mövcud olmayan qaydaya görə heç nə ölçülə
 * bilməzdi, ona görə onu keçmişə şamil etmək təhlükəsizdir — və yeni qayda
 * dərhal mövcud tarixçəni əhatə edir. Keçmişi qoruyan şey redaktədir
 * (updateSlaRule), yaratma yox.
 */
export async function createSlaRule(name: string, config: SlaRuleConfig): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO katibe.sla_rules (name) VALUES ($1) RETURNING id`,
      [name],
    );
    const ruleId = Number(rows[0].id);
    await insertVersion(client, ruleId, 1, "-infinity", config);
    await client.query("COMMIT");
    return ruleId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Redaktə = cari versiyanı indi bağla, növbətisini indidən aç.
 * Keçmiş ölçmələr köhnə versiyanı tapmağa davam edir.
 *
 * Konfiq eyni qalıbsa heç nə etmir — mənasız versiya yığını olmasın.
 * Qaytarır: yeni versiya yarandımı.
 */
export async function updateSlaRule(ruleId: number, config: SlaRuleConfig): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT ${VERSION_COLUMNS} FROM katibe.sla_rule_versions v
       WHERE v.rule_id = $1 AND v.effective_to IS NULL FOR UPDATE`,
      [ruleId],
    );
    const current = rows.length ? mapVersion(rows[0]) : null;
    if (current && sameConfig(current, config)) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(
      `UPDATE katibe.sla_rule_versions SET effective_to = now()
       WHERE rule_id = $1 AND effective_to IS NULL`,
      [ruleId],
    );
    await insertVersion(client, ruleId, (current?.version ?? 0) + 1, "now", config);
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function sameConfig(a: SlaRuleConfig, b: SlaRuleConfig): boolean {
  return (
    a.timezone === b.timezone &&
    a.businessStart === b.businessStart &&
    a.businessEnd === b.businessEnd &&
    a.businessDays.slice().sort().join(",") === b.businessDays.slice().sort().join(",") &&
    a.targetBusinessMinutes === b.targetBusinessMinutes &&
    a.targetOffhoursMinutes === b.targetOffhoursMinutes &&
    a.targetWeekendMinutes === b.targetWeekendMinutes
  );
}

async function insertVersion(
  client: { query: (q: string, v?: unknown[]) => Promise<unknown> },
  ruleId: number,
  version: number,
  from: "-infinity" | "now",
  config: SlaRuleConfig,
): Promise<void> {
  await client.query(
    `INSERT INTO katibe.sla_rule_versions
       (rule_id, version, effective_from, timezone, business_start, business_end, business_days,
        target_business_minutes, target_offhours_minutes, target_weekend_minutes)
     VALUES ($1, $2, ${from === "-infinity" ? "'-infinity'::timestamptz" : "now()"},
             $3, $4, $5, $6::smallint[], $7, $8, $9)`,
    [
      ruleId,
      version,
      config.timezone,
      config.businessStart,
      config.businessEnd,
      config.businessDays,
      config.targetBusinessMinutes,
      config.targetOffhoursMinutes,
      config.targetWeekendMinutes,
    ],
  );
}

export async function renameSlaRule(ruleId: number, name: string): Promise<void> {
  await pool.query(`UPDATE katibe.sla_rules SET name = $2 WHERE id = $1`, [ruleId, name]);
}

/**
 * Silmə iki cürdür və fərq vacibdir:
 *
 *  - heç vaxt heç kimə bağlanmayıb -> həqiqətən silinir (səhvən yaradılıb,
 *    ona görə heç bir ölçmə ona istinad edə bilməz);
 *  - nə vaxtsa bağlanıb -> yalnız arxivlənir (retired_at), çünki keçmiş
 *    ölçmələr hələ də onun versiyalarını tapmalıdır.
 *
 * İndi kiməsə bağlıdırsa heç biri olmur. Bunu baza da saxlayır
 * (user_sla_rules.rule_id ON DELETE RESTRICT) — UI yeganə maneə deyil.
 */
export type SlaRuleDeleteResult = "deleted" | "retired" | "blocked";

export async function deleteOrRetireSlaRule(ruleId: number): Promise<SlaRuleDeleteResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM katibe.user_sla_rules WHERE rule_id = $1 AND ended_at IS NULL) AS attached_now,
         (SELECT COUNT(*) FROM katibe.user_sla_rules WHERE rule_id = $1) AS attached_ever`,
      [ruleId],
    );
    if (Number(rows[0].attached_now) > 0) {
      await client.query("ROLLBACK");
      return "blocked";
    }
    if (Number(rows[0].attached_ever) > 0) {
      await client.query(`UPDATE katibe.sla_rules SET retired_at = now() WHERE id = $1`, [ruleId]);
      await client.query("COMMIT");
      return "retired";
    }
    await client.query(`DELETE FROM katibe.sla_rule_versions WHERE rule_id = $1`, [ruleId]);
    await client.query(`DELETE FROM katibe.sla_rules WHERE id = $1`, [ruleId]);
    await client.query("COMMIT");
    return "deleted";
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * İstifadəçiyə qayda təyin edir (ruleId = null -> qaydasız qalır).
 *
 * assigned_at seçimi qəsdəndir: istifadəçinin İLK təyinatı onun ən köhnə
 * mesajına qədər geri çəkilir — o vaxta qədər heç bir qayda qüvvədə
 * olmadığı üçün geri çəkmək heç nəyi yenidən yazmır, amma tarixçəni əhatə
 * edir. Sonrakı dəyişikliklər isə indidən başlayır, yəni keçmiş rəqəmlər
 * olduğu kimi qalır. (Eyni məntiq: user_instances, assignment_history.)
 */
export async function setUserSlaRule(userId: number, ruleId: number | null): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: existing } = await client.query(
      `SELECT COUNT(*) AS n FROM katibe.user_sla_rules WHERE user_id = $1`,
      [userId],
    );
    const firstEver = Number(existing[0].n) === 0;

    await client.query(
      `UPDATE katibe.user_sla_rules SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`,
      [userId],
    );

    if (ruleId !== null) {
      await client.query(
        `INSERT INTO katibe.user_sla_rules (user_id, rule_id, assigned_at)
         VALUES ($1, $2, CASE WHEN $3::boolean THEN COALESCE(
             (SELECT to_timestamp(MIN(m."messageTimestamp"))
              FROM evolution_api."Message" m
              JOIN katibe.user_instances ui ON ui.instance_id = m."instanceId" AND ui.user_id = $1),
             now()) ELSE now() END)`,
        [userId, ruleId, firstEver],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export interface WorkloadStats {
  /** İlk cavab vaxtı — mediana, saniyə. */
  frtMedianSeconds: number | null;
  /** Bütün cavablar — mediana və p90, saniyə. */
  artMedianSeconds: number | null;
  artP90Seconds: number | null;
  /** 24 saat ərzində cavabsız qalmış müştəri mesajları. */
  unansweredCount: number;
  /** Müştəri mesajlarının ümumi sayı (cavabsız faizini hesablamaq üçün). */
  customerMessageCount: number;
  /** Hədəfdən gec olan (və ya hədəfi keçib hələ cavabsız) imkanlar. */
  slaBreachCount: number;
  /** Bunun içində: hədəf keçib, hələ də cavab yoxdur. */
  slaUnansweredBreachCount: number;
  /** SLA hədəfi tapılan cavab imkanlarının sayı — faizin məxrəci. */
  slaMeasuredCount: number;
  /** O anda qayda təyin olunmadığı üçün ölçülə bilməyənlər. */
  slaUncoveredCount: number;
  replyCount: number;
}

/** Söhbətin yeni "epizod" sayılması üçün lazım olan sükut — 14 gün. */
const EPISODE_GAP_SECONDS = 14 * 24 * 60 * 60;
/** Müştəri mesajı bundan sonra cavabsız sayılır. */
const UNANSWERED_AFTER_SECONDS = 24 * 60 * 60;

/**
 * Bir nömrə üzrə iş yükü metrikaları: FRT, ART (mediana/p90), cavabsızlar,
 * SLA pozuntuları. Yalnız fərdi söhbətlər — qrup söhbətində "kim kimə cavab
 * verdi" anlayışı yoxdur.
 *
 * FRT/ART xamdır — iş saatına görə kəsmə yoxdur, yəni gecə 23:00-da gələn
 * mesaja səhər 09:00-da verilən cavab 10 saat kimi görünür.
 *
 * SLA isə artıq konfiqlidir: hədəf müştəri mesajının GƏLDİYİ ana görə seçilir
 * (iş günü/iş saatı, iş günü/qeyri-iş saatı, qeyri-iş günü) və o adamın həmin
 * andakı qaydasından gəlir — katibe.sla_target_seconds().
 *
 * DİQQƏT — saat DAYANMIR. İş saatından kənarda gələn mesaja daha uzun hədəf
 * verilir, amma vaxt divar saatı ilə axır: bağlanmağa 10 dəqiqə qalmış gələn
 * mesaj 1 saatlıq hədəfini iş saatından sonra da xərcləyir. Bu, qəsdən belədir
 * (üç ayrı hədəf məhz bunun üçündür); "saatı dayandırmaq" istənsə hədəf seçimi
 * deyil, ölçmə düsturu dəyişməlidir.
 *
 * Qaydası olmayan adam SIFIR pozuntu yox, ÖLÇÜLMƏMİŞ sayılır
 * (slaUncoveredCount) — yoxsa qaydasızlıq mükəmməl nəticə kimi görünərdi.
 */
export async function getWorkloadStats(instanceId: ScopedInstanceId, days = 30): Promise<WorkloadStats> {
  const { rows } = await pool.query(
    `WITH msgs AS (
       SELECT
         m.key->>'remoteJid' AS jid,
         (m.key->>'fromMe')::boolean AS from_me,
         m."messageTimestamp" AS ts
       FROM evolution_api."Message" m
       WHERE m."instanceId" = $1
         AND (m.key->>'remoteJid') NOT LIKE '%@g.us'
         AND (m.key->>'remoteJid') <> 'status@broadcast'
         AND m."messageTimestamp" > ${EPOCH_DAYS_AGO}
     ),
     seq AS (
       SELECT jid, from_me, ts,
              LAG(ts)      OVER w AS prev_ts,
              LAG(from_me) OVER w AS prev_from_me,
              LEAD(from_me) OVER w AS next_from_me,
              -- növbəti agent cavabının vaxtı: cavabsızları tapmaq üçün
              MIN(ts) FILTER (WHERE from_me) OVER (
                PARTITION BY jid ORDER BY ts
                ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
              ) AS next_agent_ts
       FROM msgs
       WINDOW w AS (PARTITION BY jid ORDER BY ts)
     ),
     -- 14 gündən uzun sükutdan sonrası yeni epizoddur; FRT epizod başına sayılır
     marked AS (
       SELECT *, CASE WHEN prev_ts IS NULL OR ts - prev_ts > $3::int THEN 1 ELSE 0 END AS ep_start
       FROM seq
     ),
     epi AS (
       SELECT *, SUM(ep_start) OVER (PARTITION BY jid ORDER BY ts) AS episode_no FROM marked
     ),
     replies AS (
       SELECT jid, episode_no, ts, (ts - prev_ts) AS gap
       FROM epi
       WHERE from_me AND prev_from_me = false AND (ts - prev_ts) BETWEEN 1 AND $4::int
     ),
     first_replies AS (
       SELECT DISTINCT ON (jid, episode_no) gap
       FROM replies ORDER BY jid, episode_no, ts
     ),
     customer_msgs AS (
       SELECT (next_agent_ts IS NULL OR next_agent_ts - ts > $4::int) AS unanswered
       FROM epi WHERE NOT from_me
     ),
     -- Bir "cavab imkanı" = ardıcıl müştəri mesajları seriyasının SONUNCUSU
     -- (növbəti mesaj bizimdir) və ya ümumiyyətlə cavablanmamış sonuncu mesaj.
     -- Seriyanın ortasındakılar sayılmır: 5 mesajlıq bir seriya 5 pozuntu kimi
     -- görünərdi. Başlanğıc anı ART-ın ölçdüyü anla eynidir, ona görə yanaşı
     -- duran rəqəmlər eyni şeyi ölçür.
     opportunities AS (
       SELECT ts AS arrived_ts, next_agent_ts
       FROM epi
       WHERE NOT from_me AND (next_from_me IS NULL OR next_from_me)
     ),
     sla AS (
       SELECT
         o.next_agent_ts IS NULL AS never_answered,
         -- cavab gəlibsə gözləmə = cavaba qədər; gəlməyibsə = İNDİYƏ qədər,
         -- yəni cavabsız qalmaq da hədəf keçəndən sonra pozuntudur.
         COALESCE(o.next_agent_ts, EXTRACT(epoch FROM now())::bigint) - o.arrived_ts AS waited,
         katibe.sla_target_seconds($1, to_timestamp(o.arrived_ts)) AS target
       FROM opportunities o
     )
     SELECT
       (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)) FROM first_replies) AS frt_median,
       (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)) FROM replies)       AS art_median,
       (SELECT ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)) FROM replies)       AS art_p90,
       (SELECT COUNT(*) FROM replies)                                                      AS reply_count,
       (SELECT COUNT(*) FROM customer_msgs)                                                AS customer_msgs,
       (SELECT COUNT(*) FROM customer_msgs WHERE unanswered)                               AS unanswered,
       (SELECT COUNT(*) FROM sla WHERE target IS NOT NULL AND waited > target)             AS sla_breaches,
       (SELECT COUNT(*) FROM sla WHERE target IS NOT NULL AND waited > target
                                   AND never_answered)                                     AS sla_unanswered_breaches,
       (SELECT COUNT(*) FROM sla WHERE target IS NOT NULL)                                 AS sla_measured,
       (SELECT COUNT(*) FROM sla WHERE target IS NULL)                                     AS sla_uncovered`,
    [instanceId, days, EPISODE_GAP_SECONDS, UNANSWERED_AFTER_SECONDS],
  );
  const r = rows[0];
  return {
    frtMedianSeconds: r.frt_median === null ? null : Number(r.frt_median),
    artMedianSeconds: r.art_median === null ? null : Number(r.art_median),
    artP90Seconds: r.art_p90 === null ? null : Number(r.art_p90),
    unansweredCount: Number(r.unanswered),
    customerMessageCount: Number(r.customer_msgs),
    slaBreachCount: Number(r.sla_breaches),
    slaUnansweredBreachCount: Number(r.sla_unanswered_breaches),
    slaMeasuredCount: Number(r.sla_measured),
    slaUncoveredCount: Number(r.sla_uncovered),
    replyCount: Number(r.reply_count),
  };
}
