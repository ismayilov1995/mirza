import { pool } from "./db";
import type { ScopedSourceId } from "./access";
import { embed, VARIANTS, DEFAULT_VARIANT } from "./embedding";

/*
 * Reading the canonical store — nine years of conversation in one place.
 *
 * Separate from src/lib/queries.ts on purpose. That file reads Evolution and
 * answers operational questions: who is waiting, how fast did we reply, what
 * happened this week. This one reads katibe.message and answers a different
 * one: what did we say to this person, ever. The two will converge when the
 * rest of the app moves across, and until then keeping them apart means the
 * live dashboard cannot accidentally start averaging 2017 into its metrics.
 *
 * Every function takes ScopedSourceId[] and filters by it. That is not a
 * formality: the archive belongs to one person, and a viewer who can see one
 * Evolution instance must not see nine years of somebody else's phone.
 */

export interface ArchiveChat {
  id: number;
  title: string;
  personKey: string;
  kind: string;
  messages: number;
  firstTs: number;
  lastTs: number;
  /** Which sources contribute to this conversation — 'archive', 'evolution'. */
  sources: string[];
}

/**
 * Conversations visible to the caller, busiest first.
 *
 * The source filter is an EXISTS rather than a join so a conversation is
 * counted once however many sources it spans; joining would multiply the
 * counts by exactly the overlap we worked to collapse.
 */
export async function listArchiveChats(
  sources: ScopedSourceId[],
  { search = "", limit = 60, offset = 0 }: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ chats: ArchiveChat[]; total: number }> {
  if (sources.length === 0) return { chats: [], total: 0 };
  const like = search.trim() ? `%${search.trim()}%` : null;

  // Visibility and the source list both come from katibe.chat_source, which
  // is 6,659 rows against 1.66M messages. The honest version — an EXISTS into
  // message_source per conversation — was five seconds, and count(*) OVER ()
  // made it worse by denying the planner any chance to stop early.
  const { rows: page } = await pool.query(
    `SELECT c.id, c.person_key, c.kind, COALESCE(c.title, c.person_key) AS title,
            c.first_ts, c.last_ts,
            sum(cs.messages)::bigint AS messages,
            array_agg(DISTINCT CASE WHEN cs.source_id LIKE 'archive:%'
                                    THEN 'archive' ELSE 'evolution' END) AS sources,
            count(*) OVER () AS total
       FROM katibe.chat c
       JOIN katibe.chat_source cs ON cs.chat_id = c.id
      WHERE cs.source_id = ANY($1::text[])
        AND c.last_ts IS NOT NULL
        AND ($2::text IS NULL
             OR COALESCE(c.title, '') ILIKE $2 OR c.person_key ILIKE $2)
      GROUP BY c.id, c.person_key, c.kind, c.title, c.first_ts, c.last_ts
      ORDER BY c.last_ts DESC
      LIMIT $3 OFFSET $4`,
    [sources, like, limit, offset],
  );
  if (page.length === 0) return { chats: [], total: 0 };

  return {
    total: Number(page[0].total),
    chats: page.map((r) => ({
      id: Number(r.id),
      title: r.title as string,
      personKey: r.person_key as string,
      kind: r.kind as string,
      messages: Number(r.messages),
      firstTs: Number(r.first_ts),
      lastTs: Number(r.last_ts),
      sources: (r.sources as string[]) ?? [],
    })),
  };
}

export interface ArchiveMessage {
  id: number;
  ts: number;
  direction: "in" | "out";
  senderName: string | null;
  body: string | null;
  kind: string;
  /** Media object key in Spaces, or null when the file never made it. */
  objectKey: string | null;
  storage: string | null;
}

/** One conversation's own header — asked for separately so the transcript query stays simple. */
export async function archiveChat(
  sources: ScopedSourceId[],
  chatId: number,
): Promise<ArchiveChat | null> {
  if (sources.length === 0) return null;
  const { chats } = await listArchiveChats(sources, { limit: 1000 });
  return chats.find((c) => c.id === chatId) ?? null;
}

/**
 * A page of a conversation, oldest-first within the page.
 *
 * Paged from the END by default because that is where a reader starts: the
 * newest messages, with "load older" walking backwards. A nine-year
 * conversation cannot be rendered whole and should not try.
 */
export async function archiveTranscript(
  sources: ScopedSourceId[],
  chatId: number,
  { before, limit = 60 }: { before?: number; limit?: number } = {},
): Promise<ArchiveMessage[]> {
  if (sources.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT m.id, m.ts, m.direction, m.sender_name, m.body, m.kind,
            md.object_key, md.storage
       FROM katibe.message m
       LEFT JOIN katibe.media md ON md.message_id = m.id
      WHERE m.chat_id = $2
        AND ($3::int IS NULL OR m.ts < $3)
        AND EXISTS (SELECT 1 FROM katibe.message_source ms
                     WHERE ms.message_id = m.id AND ms.source_id = ANY($1::text[]))
      ORDER BY m.ts DESC, m.id DESC
      LIMIT $4`,
    [sources, chatId, before ?? null, limit],
  );
  // Fetched newest-first so the LIMIT takes the right end; reversed here so the
  // page reads downwards the way a conversation does.
  return rows.reverse().map((r) => ({
    id: Number(r.id),
    ts: Number(r.ts),
    direction: r.direction as "in" | "out",
    senderName: (r.sender_name as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    kind: r.kind as string,
    objectKey: (r.object_key as string | null) ?? null,
    storage: (r.storage as string | null) ?? null,
  }));
}

export interface ArchiveHit extends ArchiveMessage {
  chatId: number;
  chatTitle: string;
}

/**
 * Substring search across everything the caller can see.
 *
 * ILIKE, not a tsquery — the same reason as the live search: these
 * conversations mix Azerbaijani, Russian, English and Arabic, and no single
 * Postgres text-search configuration stems all four. The trigram index
 * (sql/2026-08-31_archive_search_index.sql) is what keeps it fast over 1.66M
 * rows.
 *
 * Meaning-based search comes later, over the same rows; this half is the one
 * that finds an order number, and it would still be needed afterwards.
 */
export async function searchArchive(
  sources: ScopedSourceId[],
  { query, limit = 50, chatId }: { query: string; limit?: number; chatId?: number },
): Promise<ArchiveHit[]> {
  if (sources.length === 0 || query.trim().length < 2) return [];
  const { rows } = await pool.query(
    `SELECT m.id, m.ts, m.direction, m.sender_name, m.body, m.kind,
            md.object_key, md.storage,
            m.chat_id, COALESCE(c.title, c.person_key) AS chat_title
       FROM katibe.message m
       JOIN katibe.chat c ON c.id = m.chat_id
       LEFT JOIN katibe.media md ON md.message_id = m.id
      WHERE m.body ILIKE $2
        AND ($4::bigint IS NULL OR m.chat_id = $4)
        AND EXISTS (SELECT 1 FROM katibe.message_source ms
                     WHERE ms.message_id = m.id AND ms.source_id = ANY($1::text[]))
      ORDER BY m.ts DESC
      LIMIT $3`,
    [sources, `%${query.trim()}%`, limit, chatId ?? null],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    ts: Number(r.ts),
    direction: r.direction as "in" | "out",
    senderName: (r.sender_name as string | null) ?? null,
    body: (r.body as string | null) ?? null,
    kind: r.kind as string,
    objectKey: (r.object_key as string | null) ?? null,
    storage: (r.storage as string | null) ?? null,
    chatId: Number(r.chat_id),
    chatTitle: r.chat_title as string,
  }));
}

/** What the store currently holds, for the screen's header. */
export async function archiveSummary(
  sources: ScopedSourceId[],
): Promise<{ messages: number; chats: number; firstTs: number | null; lastTs: number | null }> {
  if (sources.length === 0) return { messages: 0, chats: 0, firstTs: null, lastTs: null };
  // From the stored statistics, for the same reason the list is: counting
  // 1.66M rows to render a header is not a trade worth making. Global rather
  // than per-source — see the note on katibe.chat's columns.
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(message_count), 0) AS messages,
            count(*) AS chats,
            min(first_ts) AS first_ts, max(last_ts) AS last_ts
       FROM katibe.chat WHERE last_ts IS NOT NULL`,
  );
  return {
    messages: Number(rows[0].messages),
    chats: Number(rows[0].chats),
    firstTs: rows[0].first_ts === null ? null : Number(rows[0].first_ts),
    lastTs: rows[0].last_ts === null ? null : Number(rows[0].last_ts),
  };
}

/**
 * Arxivin mənbələri — yan panel üçün.
 *
 * Nəzarətdə seçici "nömrə" deyir, burada "mənbə": arxivə həm canlı WhatsApp
 * nömrələri, həm də köçürülmüş köhnə fayllar (`archive:business`) axır və
 * ikisini bir adla çağırmaq yanıldıcı olardı — biri hələ də böyüyür, digəri
 * donub.
 *
 * Saylar `katibe.chat_source`-dan gəlir, çünki bir söhbət bir neçə mənbədə
 * görünə bilər: eyni adam həm köhnə arxivdə, həm bugünkü nömrədə yazıb.
 */
export interface ViewSource {
  id: string;
  name: string;
  kind: "evolution" | "archive";
  chats: number;
  live: boolean;
}

export async function listViewSources(sources: ScopedSourceId[]): Promise<ViewSource[]> {
  if (sources.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT s.id, s.kind, s.label, i.name AS instance_name,
            i."connectionStatus" AS status,
            COALESCE(cs.chats, 0)::int AS chats
       FROM katibe.source s
       LEFT JOIN evolution_api."Instance" i ON i.id = s.id
       LEFT JOIN (SELECT source_id, count(*)::int AS chats
                    FROM katibe.chat_source GROUP BY source_id) cs ON cs.source_id = s.id
      WHERE s.id = ANY($1)
      ORDER BY s.kind DESC, COALESCE(i.name, s.label, s.id)`,
    [sources],
  );
  return rows.map((r) => ({
    id: String(r.id),
    /* Arxiv etiketi idxal izini daşıyır ("business · 2026-08-30T12:39:04Z").
       Yan paneldə yalnız adı qalır: vaxt damğası idxalın texniki qeydidir,
       mənbəni seçən adam üçün məlumat deyil. */
    name:
      (r.instance_name as string)
      ?? ((r.label as string) ?? String(r.id)).split(" · ")[0],
    kind: r.kind === "archive" ? "archive" : "evolution",
    chats: Number(r.chats),
    /* Arxiv mənbəyi heç vaxt "canlı" deyil və olmamalıdır: fayl donub, yaşıl
       nöqtə isə "bura hələ mesaj gəlir" deməkdir. */
    live: r.kind !== "archive" && r.status === "open",
  }));
}

export interface MeaningHit {
  chunkId: number;
  chatId: number;
  chatTitle: string;
  startTs: number;
  endTs: number;
  text: string;
  /** 0..1, higher is closer. Cosine distance subtracted from one. */
  score: number;
}

/**
 * Meaning-based search across the whole store.
 *
 * The companion to searchArchive(), not a replacement for it. Measured on the
 * live archive earlier, substring search is the only half that can be trusted
 * for an order number or an amount, and this half is the only one that finds
 * the right conversation when the words differ. Both run; neither is enough.
 *
 * Chunks, not messages, because that was measured too: a third of what people
 * send is "ok", whose vector sits near everything and answers nothing, and a
 * chunk carries the short lines along with the sentence they replied to.
 *
 * The score floor is a noise gate rather than a relevance ranking — on this
 * corpus cosine separates a true hit from a clearly unrelated one by about
 * four hundredths, so callers should read the chunks rather than trust the
 * ordering.
 */
export async function searchArchiveMeaning(
  sources: ScopedSourceId[],
  { query, limit = 12, minScore = 0.45 }:
    { query: string; limit?: number; minScore?: number },
): Promise<MeaningHit[]> {
  if (sources.length === 0 || query.trim().length < 2) return [];
  const cfg = VARIANTS[DEFAULT_VARIANT];
  const [vector] = await embed([cfg.queryPrefix + query.trim()]);
  const literal = `[${vector.join(",")}]`;

  // ef_search must exceed what we intend to keep: pgvector defaults it to 40
  // and applies the visibility filter AFTER the index walk, so a narrow limit
  // would come back short. That cost an hour on the live search once already.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(80, limit * 8)}`);
    const { rows } = await client.query(
      `SELECT k.id, k.chat_id, k.start_ts, k.end_ts, k.text,
              COALESCE(c.title, c.person_key) AS chat_title,
              1 - (k.embedding <=> $2::vector) AS score
         FROM katibe.chunk k
         JOIN katibe.chat c ON c.id = k.chat_id
        WHERE k.embedding IS NOT NULL
          AND EXISTS (SELECT 1 FROM katibe.chat_source cs
                       WHERE cs.chat_id = k.chat_id AND cs.source_id = ANY($1::text[]))
        ORDER BY k.embedding <=> $2::vector
        LIMIT $3`,
      [sources, literal, limit * 4],
    );
    await client.query("COMMIT");
    return rows
      .map((r) => ({
        chunkId: Number(r.id),
        chatId: Number(r.chat_id),
        chatTitle: r.chat_title as string,
        startTs: Number(r.start_ts),
        endTs: Number(r.end_ts),
        text: r.text as string,
        score: Number(r.score),
      }))
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
