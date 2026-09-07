import { pool } from "../src/lib/db";
import { systemScope } from "../src/lib/access";
import { classifyJid, type ChatType } from "../src/lib/jid";
import { searchExact, searchMeaning, namesFor as namesForScoped } from "../src/lib/search";
import { contactDisplaySql, groupSubjectJoin, phoneSql } from "../src/lib/queries";

/*
 * Every query in this file is a SELECT against Evolution API's own Postgres
 * database, which Baileys has already filled. Nothing here calls the Evolution
 * HTTP API, so nothing here can mark a chat or a message as read — the one
 * hard constraint the whole Katibe project is built around.
 */

/** Range filters compare the raw epoch column so the index on it is usable. */
const EPOCH_HOURS_AGO = `EXTRACT(epoch FROM now() - make_interval(hours => $2::int))::int`;

/** Text lives in a different place per message type; media may carry none. */
const TEXT_SQL = `COALESCE(
  m.message->>'conversation',
  m.message->'imageMessage'->>'caption',
  m.message->'videoMessage'->>'caption',
  m.message->'documentMessage'->>'fileName'
)`;

/*
 * What contactDisplaySql() needs, minus its pushName lookup: both queries that
 * use these joins already aggregate over Message, so they carry the name out of
 * that pass and hand it to NAME() instead of paying for a lookup per chat.
 */
const JOINS = (jidExpr: string) => `
  LEFT JOIN evolution_api."Chat" ch ON ch."instanceId" = $1 AND ch."remoteJid" = ${jidExpr}
  LEFT JOIN evolution_api."Contact" ct ON ct."instanceId" = $1 AND ct."remoteJid" = ${jidExpr}
  LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = ${jidExpr}
  LEFT JOIN katibe.lid_number ln ON ln.lid_jid = ${jidExpr}
  LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = ${jidExpr}
  ${groupSubjectJoin(jidExpr)}
  LEFT JOIN katibe.categories cat ON cat.id = cl.category_id`;

/** @param pushName where this query keeps the incoming-message pushName. */
const NAME = (pushName: string) => contactDisplaySql("a.jid", pushName);
const PHONE = phoneSql("a.jid", "ln");

export interface ChatRow {
  jid: string;
  name: string;
  chatType: ChatType;
  phone: string | null;
  category: string | null;
  messages: number;
  inbound: number;
  outbound: number;
  lastMessageAt: string;
  lastFromThem: boolean;
  lastText: string | null;
  lastSender: string | null;
  /** Hours their newest message has gone unanswered, or null if the ball is ours. */
  waitingHours: number | null;
}

export type ChatTypeArg = "all" | "group" | "individual";

const TYPE_WHERE: Record<ChatTypeArg, string> = {
  all: "TRUE",
  group: `a.jid LIKE '%@g.us'`,
  // @lid is an individual whose number WhatsApp masked, not a group — see src/lib/jid.ts.
  individual: `(a.jid LIKE '%@s.whatsapp.net' OR a.jid LIKE '%@lid')`,
};

/**
 * One row per chat with activity in the window, newest first.
 *
 * The window is in hours rather than days because the brief's natural unit is
 * "since yesterday evening", and rounding that up to a day pulls in a whole
 * extra morning of already-handled traffic.
 */
export async function listChats(
  instanceId: string,
  {
    hours = 48,
    type = "all",
    waitingOnly = false,
    search = "",
    limit = 50,
  }: { hours?: number; type?: ChatTypeArg; waitingOnly?: boolean; search?: string; limit?: number } = {},
): Promise<ChatRow[]> {
  const term = search.trim();
  const { rows } = await pool.query(
    `WITH win AS MATERIALIZED (
       SELECT m.key->>'remoteJid' AS jid,
              (m.key->>'fromMe')::boolean AS from_me,
              m."messageTimestamp" AS ts,
              m."pushName" AS push_name,
              COALESCE(${TEXT_SQL}, vt.text, '[' || m."messageType" || ']') AS text
         FROM evolution_api."Message" m
         LEFT JOIN katibe.voice_transcript vt ON vt.message_id = m.id AND vt.status = 'ok'
        WHERE m."instanceId" = $1
          AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
          AND m."messageTimestamp" > ${EPOCH_HOURS_AGO}
     ),
     a AS (
       SELECT jid,
              COUNT(*) AS messages,
              COUNT(*) FILTER (WHERE NOT from_me) AS inbound,
              COUNT(*) FILTER (WHERE from_me) AS outbound,
              MAX(ts) AS last_ts,
              (ARRAY_AGG(from_me ORDER BY ts DESC))[1] = false AS last_from_them,
              (ARRAY_AGG(text ORDER BY ts DESC))[1] AS last_text,
              (ARRAY_AGG(push_name ORDER BY ts DESC))[1] AS last_sender,
              -- last_sender is whoever spoke last, us included; this one is
              -- the CONTACT's own name and is what most @lid chats are called.
              MAX(push_name) FILTER (
                WHERE NOT from_me AND COALESCE(push_name, '') <> ''
              ) AS push_name
         FROM win GROUP BY jid
     )
     SELECT a.*, ${NAME("a.push_name")} AS name, ${PHONE} AS phone, cat.name AS category,
            CASE WHEN a.last_from_them
                 THEN ROUND((EXTRACT(epoch FROM now())::bigint - a.last_ts) / 3600.0, 1)
            END AS waiting_hours
       FROM a ${JOINS("a.jid")}
      WHERE ${TYPE_WHERE[type]}
        AND (${waitingOnly ? "a.last_from_them" : "TRUE"})
        AND (${term ? `(${NAME("a.push_name")} ILIKE $4 OR a.jid ILIKE $4)` : "TRUE"})
      ORDER BY a.last_ts DESC
      LIMIT $3`,
    term ? [instanceId, hours, limit, `%${term}%`] : [instanceId, hours, limit],
  );
  return rows.map(toChatRow);
}

function toChatRow(r: Record<string, unknown>): ChatRow {
  const jid = r.jid as string;
  return {
    jid,
    name: r.name as string,
    chatType: classifyJid(jid),
    phone: (r.phone as string) ?? null,
    category: (r.category as string) ?? null,
    messages: Number(r.messages),
    inbound: Number(r.inbound),
    outbound: Number(r.outbound),
    lastMessageAt: new Date(Number(r.last_ts) * 1000).toISOString(),
    lastFromThem: Boolean(r.last_from_them),
    lastText: (r.last_text as string) ?? null,
    lastSender: (r.last_sender as string) ?? null,
    waitingHours: r.waiting_hours === null || r.waiting_hours === undefined ? null : Number(r.waiting_hours),
  };
}

export interface ResolvedChat {
  jid: string;
  name: string;
  chatType: ChatType;
  phone: string | null;
  messages: number;
  lastMessageAt: string | null;
}

/**
 * Finds chats by name, phone number or raw JID, over all of history.
 *
 * Deliberately returns a list rather than a best guess: two suppliers can
 * share a first name, and a tool that silently picks one would have the model
 * reading the wrong conversation with no way to tell.
 */
export async function resolveChat(
  instanceId: string,
  query: string,
  limit = 10,
): Promise<ResolvedChat[]> {
  const term = query.trim();
  // A pasted number may carry +, spaces or dashes; JIDs never do.
  const digits = term.replace(/[^0-9]/g, "");
  // Counts come from one grouped pass over Message. As correlated subqueries
  // per candidate row this same lookup took ~4.6s on this instance.
  const { rows } = await pool.query(
    `WITH agg AS (
       SELECT key->>'remoteJid' AS jid, COUNT(*) AS messages, MAX("messageTimestamp") AS last_ts,
              MAX("pushName") FILTER (
                WHERE (key->>'fromMe')::boolean = false AND COALESCE("pushName", '') <> ''
              ) AS push_name
         FROM evolution_api."Message"
        WHERE "instanceId" = $1
        GROUP BY 1
     ),
     a AS (
       SELECT "remoteJid" AS jid FROM evolution_api."Chat" WHERE "instanceId" = $1
       UNION
       SELECT jid FROM agg
     )
     SELECT a.jid, ${NAME("g.push_name")} AS name, ${PHONE} AS phone,
            COALESCE(g.messages, 0) AS messages, g.last_ts
       FROM a
       LEFT JOIN agg g ON g.jid = a.jid
       ${JOINS("a.jid")}
      WHERE ${NAME("g.push_name")} ILIKE $2 OR a.jid ILIKE $2
         OR ($3 <> '' AND (${PHONE} LIKE '%' || $3 || '%' OR a.jid LIKE $3 || '@%'))
      ORDER BY COALESCE(g.messages, 0) DESC
      LIMIT $4`,
    [instanceId, `%${term}%`, digits, limit],
  );
  return rows.map((r) => ({
    jid: r.jid,
    name: r.name,
    chatType: classifyJid(r.jid),
    phone: r.phone ?? null,
    messages: Number(r.messages),
    lastMessageAt: r.last_ts ? new Date(Number(r.last_ts) * 1000).toISOString() : null,
  }));
}

/*
 * Search moved to src/lib/search.ts so the dashboard can use it too: pages get
 * a ScopedInstanceId from requireInstance() and may not call systemScope(),
 * which the CI boundary check enforces. This server has no session, so it is
 * one of the three places allowed the escape hatch — it applies the scope here
 * and the implementation stays single.
 */
export type { FoundMessage, SemanticHit } from "../src/lib/search";

export const searchMessages = (
  instanceId: string,
  opts: { query: string; hours?: number; jid?: string; limit?: number },
) => searchExact(systemScope(instanceId), opts);

export const searchSemantic = (
  instanceId: string,
  opts: { query: string; hours?: number; jid?: string; limit?: number },
) => searchMeaning(systemScope(instanceId), opts);

export const namesFor = (instanceId: string, jids: string[]) =>
  namesForScoped(systemScope(instanceId), jids);

export interface BriefMessage {
  jid: string;
  fromMe: boolean;
  sender: string | null;
  at: string;
  text: string | null;
  messageType: string;
  fromVoice: boolean;
  /** In a group: this message mentions us, or replies to something we wrote. */
  addressesUs: boolean;
}

/**
 * Every message in the window, in one pass, with just enough context to decide
 * whether it concerns the owner.
 *
 * Mentions are detected in the message TEXT, not in Baileys' contextInfo.
 * Evolution normalises what it stores: a mention arrives here as a plain
 * `conversation` string reading "@38315470376995 update var ?", and the
 * `mentionedJid` / quoted-`participant` fields are gone (0 rows on this
 * database carry an extendedTextMessage at all). The contextInfo check is kept
 * as a harmless fallback for versions that do store it.
 *
 * The "@…" in the text is the owner's @lid local part, never their phone
 * number — which is why ownerKeys carries both (see resolveOwner).
 */
export async function windowMessages(
  instanceId: string,
  hours: number,
  ownerKeys: string[],
): Promise<BriefMessage[]> {
  const { rows } = await pool.query(
    `SELECT m.key->>'remoteJid' AS jid,
            (m.key->>'fromMe')::boolean AS from_me,
            m."pushName" AS sender,
            m."messageTimestamp" AS ts,
            m."messageType" AS message_type,
            ${TEXT_SQL} AS text,
            vt.text AS voice_text,
            COALESCE(
              m.message->'extendedTextMessage'->'contextInfo',
              m.message->'imageMessage'->'contextInfo',
              m.message->'videoMessage'->'contextInfo',
              m.message->'audioMessage'->'contextInfo',
              m.message->'documentMessage'->'contextInfo'
            ) AS context
       FROM evolution_api."Message" m
       LEFT JOIN katibe.voice_transcript vt ON vt.message_id = m.id AND vt.status = 'ok'
      WHERE m."instanceId" = $1
        AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
        AND m."messageTimestamp" > ${EPOCH_HOURS_AGO}
      ORDER BY m."messageTimestamp" ASC`,
    [instanceId, hours],
  );
  return rows.map((r) => {
    const ctx = (r.context ?? null) as { mentionedJid?: string[]; participant?: string } | null;
    const addressed = (jid: unknown) =>
      typeof jid === "string" && ownerKeys.some((k) => jid.startsWith(k));
    const body = (r.text ?? r.voice_text ?? "") as string;
    const mentionedInText = ownerKeys.some((k) => body.includes(`@${k}`));
    const mentioned = mentionedInText || (ctx?.mentionedJid ?? []).some(addressed);
    // A reply to one of our own messages is addressed to us as surely as a mention.
    const quotedUs = addressed(ctx?.participant);
    return {
      jid: r.jid,
      fromMe: r.from_me,
      sender: r.sender ?? null,
      at: new Date(Number(r.ts) * 1000).toISOString(),
      text: (r.text ?? r.voice_text) ?? null,
      messageType: r.message_type,
      fromVoice: r.text === null && r.voice_text !== null,
      addressesUs: mentioned || quotedUs,
    };
  });
}

export interface DailyCount {
  day: string;
  inbound: number;
  outbound: number;
}

/** Message volume per day in Asia/Baku — the timezone every other Katibe stat uses. */
export async function dailyCounts(instanceId: string, days: number): Promise<DailyCount[]> {
  const { rows } = await pool.query(
    `SELECT to_char(to_timestamp(m."messageTimestamp") AT TIME ZONE 'Asia/Baku', 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE (m.key->>'fromMe')::boolean = false) AS inbound,
            COUNT(*) FILTER (WHERE (m.key->>'fromMe')::boolean) AS outbound
       FROM evolution_api."Message" m
      WHERE m."instanceId" = $1
        AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
        AND m."messageTimestamp" > EXTRACT(epoch FROM now() - make_interval(days => $2::int))::int
      GROUP BY 1 ORDER BY 1 DESC`,
    [instanceId, days],
  );
  return rows.map((r) => ({ day: r.day, inbound: Number(r.inbound), outbound: Number(r.outbound) }));
}
