import { pool } from "./db";
import type { ScopedInstanceId } from "./access";
import { classifyJid, type ChatType } from "./jid";
import { contactDisplaySql, nameJoins } from "./queries";
import { searchSimilar } from "./embedding";
import { rerank, RERANK_CANDIDATES } from "./rerank";

/*
 * Searching the message archive, in the two ways it can be searched.
 *
 * This lives in src/lib rather than in mcp/ because the dashboard needs it too.
 * Scope is a parameter and never derived here: pages get their
 * ScopedInstanceId from requireInstance(), while callers with no session — the
 * MCP server, the cron scripts — mint one through the escape hatch in
 * src/lib/access.ts, which scripts/check-access-boundaries.sh confines to
 * their directories. Naming that function in this file would fail the check,
 * which greps rather than parses: a comment and a call look alike to it, and
 * that is the right trade for a boundary you never want quietly widened.
 */

/** Text lives in a different place per message type; media may carry none. */
const TEXT_SQL = `COALESCE(
  m.message->>'conversation',
  m.message->'imageMessage'->>'caption',
  m.message->'videoMessage'->>'caption',
  m.message->'documentMessage'->>'fileName'
)`;

/** Range filters compare the raw epoch column so the index on it is usable. */
const EPOCH_HOURS_AGO = `EXTRACT(epoch FROM now() - make_interval(hours => $2::int))::int`;

export interface FoundMessage {
  /** Evolution's own row id — what the archive screen is looked up by. */
  id: string;
  jid: string;
  chatName: string;
  chatType: ChatType;
  fromMe: boolean;
  sender: string | null;
  at: string;
  text: string;
  /** The text came from a transcribed voice note, not from typed text. */
  fromVoice: boolean;
}

/** Resolved display names for a set of JIDs, in one round trip. */
export async function namesFor(
  instanceId: ScopedInstanceId,
  jids: string[],
): Promise<Map<string, string>> {
  if (jids.length === 0) return new Map();
  const { rows } = await pool.query(
    `WITH a AS (SELECT unnest($2::text[]) AS jid)
     SELECT a.jid, ${contactDisplaySql("a.jid")} AS name FROM a ${nameJoins("a.jid", "$1")}`,
    [instanceId, jids],
  );
  return new Map(rows.map((r) => [r.jid as string, r.name as string]));
}

/**
 * Substring search across the account's messages.
 *
 * ILIKE, not a tsquery: the chats mix Azerbaijani, Russian, English and Arabic,
 * and no single Postgres text-search configuration stems all four. Substring
 * matching has no such opinion, and with the trigram index behind it
 * (sql/2026-08-30_message_text_trigram.sql) it answers in milliseconds.
 *
 * This half is what finds an order number or an amount, and no amount of
 * semantic search replaces it — which is why both run.
 *
 * WHY THE UNION. The obvious form of this query is one scan with
 * `(message_text ILIKE $5 OR transcript ILIKE $5)`, and it was that for a
 * while. An OR spanning two tables cannot use an index on either side, so
 * Postgres read every message of the account and ran ILIKE on each: 103,580
 * rows, five seconds. Split into two branches the first one hits the trigram
 * index and returns in about four milliseconds, and the second scans a table
 * of a few hundred transcripts, which costs nothing.
 */
export async function searchExact(
  instanceId: ScopedInstanceId,
  {
    query,
    hours = 24 * 30,
    jid,
    limit = 50,
  }: { query: string; hours?: number; jid?: string; limit?: number },
): Promise<FoundMessage[]> {
  const scope = `m."instanceId" = $1
        AND m."messageTimestamp" > ${EPOCH_HOURS_AGO}
        AND ($4::text IS NULL OR m.key->>'remoteJid' = $4)`;
  const { rows } = await pool.query(
    `WITH typed AS (
       SELECT m.id, m.key->>'remoteJid' AS jid, (m.key->>'fromMe')::boolean AS from_me,
              m."pushName" AS sender, m."messageTimestamp" AS ts,
              ${TEXT_SQL} AS text, NULL::text AS voice_text
         FROM evolution_api."Message" m
        WHERE ${scope} AND ${TEXT_SQL} ILIKE $5
        ORDER BY m."messageTimestamp" DESC
        LIMIT $3
     ),
     spoken AS (
       SELECT m.id, m.key->>'remoteJid' AS jid, (m.key->>'fromMe')::boolean AS from_me,
              m."pushName" AS sender, m."messageTimestamp" AS ts,
              NULL::text AS text, vt.text AS voice_text
         FROM katibe.voice_transcript vt
         JOIN evolution_api."Message" m ON m.id = vt.message_id
        WHERE vt.status = 'ok' AND vt.text ILIKE $5 AND ${scope}
        ORDER BY m."messageTimestamp" DESC
        LIMIT $3
     )
     -- DISTINCT ON guards the one case where a message could appear twice: a
     -- voice note that also carries a caption matching the same query.
     SELECT DISTINCT ON (id) * FROM (SELECT * FROM typed UNION ALL SELECT * FROM spoken) u
     ORDER BY id, ts DESC`,
    [instanceId, hours, limit, jid ?? null, `%${query}%`],
  );
  if (rows.length === 0) return [];
  // DISTINCT ON had to order by id; newest-first is what a reader wants, and
  // the two branches each returned up to `limit`, so the merge is re-cut here.
  const newest = rows.sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, limit);
  const names = await namesFor(instanceId, [...new Set(newest.map((r) => r.jid as string))]);
  return newest.map((r) => ({
    id: String(r.id),
    jid: r.jid,
    chatName: names.get(r.jid) ?? r.jid,
    chatType: classifyJid(r.jid),
    fromMe: r.from_me,
    sender: r.sender ?? null,
    at: new Date(Number(r.ts) * 1000).toISOString(),
    text: (r.text ?? r.voice_text) as string,
    fromVoice: r.text === null && r.voice_text !== null,
  }));
}

export interface SemanticHit {
  jid: string;
  chatName: string;
  chatType: ChatType;
  /** Start of the window this excerpt covers. */
  at: string;
  text: string;
  /** 1 same subject only, 2 relevant, 3 answers the question. */
  grade: number;
}

/**
 * Meaning-based counterpart to searchExact.
 *
 * Different unit on purpose: ILIKE answers with the one message that contained
 * the string, while this answers with the stretch of conversation the query is
 * about — which is the only thing a nearest-neighbour hit can honestly claim.
 *
 * Two stages, because they fix different failures. The index decides what is
 * retrievable and is graded on subject: ask what the courier costs and it
 * returns an exchange about a courier that never mentions a price. The
 * reranker then reads question and passage together and drops exactly those —
 * on the measured set it took recall@1 from 13% to 31%.
 *
 * The shortlist is deliberately much larger than the result: reranking can
 * only reorder what the index fetched, so the candidates are where the ceiling
 * is set and the fifty cost nothing but prompt tokens.
 */
export async function searchMeaning(
  instanceId: ScopedInstanceId,
  { query, hours, jid, limit = 6 }:
    { query: string; hours?: number; jid?: string; limit?: number },
): Promise<SemanticHit[]> {
  const candidates = await searchSimilar(instanceId, {
    query, hours, jid,
    limit: RERANK_CANDIDATES,
    // No score floor here: the cosine score is a poor relevance signal on this
    // text, and the reranker is a better judge of the same question. Gating
    // first would only hide candidates from it.
    minScore: 0,
  });
  if (candidates.length === 0) return [];

  const ranked = await rerank(query, candidates, limit);
  // Grade 1 is "same subject, does not answer it" — the exact failure this
  // stage exists to remove, so it is not worth showing.
  const kept = ranked.filter((r) => r.grade >= 2);
  if (kept.length === 0) return [];

  const names = await namesFor(instanceId, [...new Set(kept.map((h) => h.jid))]);
  return kept.map((h) => ({
    jid: h.jid,
    chatName: names.get(h.jid) ?? h.jid,
    chatType: classifyJid(h.jid),
    at: new Date(h.startTs * 1000).toISOString(),
    text: h.text,
    grade: h.grade,
  }));
}

/** Where a hit lives in the archive screen: which conversation, which message. */
export interface ArchiveAnchor {
  chatId: number;
  messageId: number;
}

/*
 * Nəticədən MESAJIN ÖZÜNƏ keçmək — id-lərin tərcüməsi.
 *
 * Axtarış Evolution-un cədvəlində işləyir, oxunan ekran isə birləşdirilmiş
 * anbarda (katibe.message): eyni mesajın iki id-si var. Tərcüməsiz nəticəyə
 * basmaq yalnız «söhbəti aç» deməkdir və adam tapdığı sətri min mesajın
 * içində əl ilə axtarır — şikayət elə bu idi.
 *
 * Əhatə arqumentdən gəlir: source_id evolution mənbələrində instans id-nin
 * özüdür (access.ts:monitorSources), yəni ScopedInstanceId burada həm də
 * mənbə açarıdır.
 */
export async function archiveAnchors(
  instanceId: ScopedInstanceId,
  ids: string[],
): Promise<Map<string, ArchiveAnchor>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT ms.external_id, m.id, m.chat_id
       FROM katibe.message_source ms
       JOIN katibe.message m ON m.id = ms.message_id
      WHERE ms.source_id = $1 AND ms.external_id = ANY($2::text[])`,
    [instanceId, ids],
  );
  return new Map(
    rows.map((r) => [
      r.external_id as string,
      { chatId: Number(r.chat_id), messageId: Number(r.id) },
    ]),
  );
}

/**
 * The same, for a hit that is a stretch of conversation rather than one row.
 *
 * Semantic search answers with a window, so there is no single message to
 * translate; the honest target is the first message inside the window, which
 * is where a reader would start reading anyway.
 */
export async function archiveAnchorAt(
  instanceId: ScopedInstanceId,
  jid: string,
  ts: number,
): Promise<ArchiveAnchor | null> {
  const { rows } = await pool.query(
    `SELECT m.id, m.chat_id
       FROM katibe.chat_jid cj
       JOIN katibe.message m ON m.chat_id = cj.chat_id
      WHERE cj.remote_jid = $2
        AND m.ts >= $3
        AND EXISTS (SELECT 1 FROM katibe.chat_source cs
                     WHERE cs.chat_id = cj.chat_id AND cs.source_id = $1)
      ORDER BY m.ts, m.id
      LIMIT 1`,
    [instanceId, jid, ts],
  );
  return rows.length === 0
    ? null
    : { chatId: Number(rows[0].chat_id), messageId: Number(rows[0].id) };
}
