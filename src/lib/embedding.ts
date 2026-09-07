import OpenAI from "openai";
import { pool } from "./db";
import type { ScopedInstanceId } from "./access";

/*
 * Semantic retrieval over the message archive: chunking, embedding, and the
 * vector half of search.
 *
 * Read-only with respect to WhatsApp. Everything here reads rows Baileys has
 * already stored and writes only to katibe.message_chunk, so nothing in this
 * file can mark a chat or a message as read.
 */

/**
 * The embedding configurations this table can hold, side by side.
 *
 * Column names are taken from here and never from a caller, because a column
 * cannot be a bound parameter — this map is what keeps the variant out of the
 * SQL string as an injection route.
 */
export const VARIANTS = {
  qwen: {
    model: "Qwen/Qwen3-Embedding-8B",
    dims: 1024,
    column: "embedding",
    // DeepInfra speaks the OpenAI embeddings protocol, so the same client
    // reaches it with only the base URL changed.
    baseURL: "https://api.deepinfra.com/v1/openai",
    keyEnv: "DEEPINFRA_API_KEY",
    // `dimensions` is OpenAI's Matryoshka truncation and nobody else takes it;
    // this model is natively 4096 and gets cut to width in fitToWidth().
    sendDimensions: false,
    // Third-party gateways cap request bodies well below OpenAI's, and a
    // rejected batch costs a retry of everything in it.
    batch: 32,
    // Qwen wants its queries framed as an instruction while documents stay
    // plain; skipping that asymmetry is a measurable loss on its own
    // evaluations, so only the query side receives it.
    queryPrefix:
      "Instruct: Verilmiş sualı cavablandıran WhatsApp söhbət parçasını tap\nQuery: ",
  },
} as const;

export type Variant = keyof typeof VARIANTS;

/**
 * What the live search and the chunker use unless told otherwise.
 *
 * One entry is the normal state between comparisons. To run another, add a
 * column in SQL, add its entry here, then `npm run embed:variant` and
 * `npm run eval:search` — the sequence that retired three models today
 * (sql/2026-08-30_retire_losing_variants.sql carries their scores).
 */
export const DEFAULT_VARIANT: Variant = "qwen";

/**
 * Two models have been measured out of this job now.
 * text-embedding-3-small missed the answer entirely in four cases of five;
 * text-embedding-3-large in nearly three of five. Qwen3-Embedding-8B misses
 * one in four, and it costs a thirteenth of -large per token
 * (the table is in sql/2026-08-30_message_chunk_qwen_variant.sql and in
 * the commit that switched this over; reproduce it with npm run eval:search).
 */
export const EMBED_MODEL = VARIANTS[DEFAULT_VARIANT].model;

/** 1024 of the model's native 4096 — truncated and renormalised in embed(). */
export const EMBED_DIMS = VARIANTS[DEFAULT_VARIANT].dims;

/**
 * A pause this long ends a chunk.
 *
 * Half an hour is what separates "still the same conversation" from "they came
 * back later about something else" in these chats: a reply inside a live
 * exchange lands in seconds to minutes, while the next topic usually opens the
 * following morning.
 */
const GAP_SEC = 30 * 60;

/** Ceilings so one busy chat-day cannot become a single unsearchable chunk. */
const MAX_MESSAGES = 12;
const MAX_CHARS = 1500;

/**
 * Below this a chunk gets a row but no vector.
 *
 * An isolated "Onlar: ok" is a real chunk — nothing was said for half an hour
 * either side of it — but it has no retrievable meaning, and embedded it
 * lands plausibly close to almost any query and pushes real answers out of the
 * result list. Storing the row anyway is what keeps the forward-only scan
 * moving past it; skipping only the embedding is also what makes it free.
 * Exact search still finds these, because that half runs over Message itself.
 *
 * 25 and not higher, from the measured length distribution: below it sit
 * "Biz: Cox sagolun" and "Biz: Thank you 🙏🏻", above it "Onlar: Sabire xanim
 * gelin" — and at 40, which looked reasonable in the abstract, real sentences
 * like "Biz: Hello Yesterday you got 15k right?" were being dropped. Roughly a
 * tenth of chunks fall below this line.
 */
export const MIN_EMBED_CHARS = 25;

/** Text lives in a different place per message type; media may carry none. */
const TEXT_SQL = `COALESCE(
  m.message->>'conversation',
  m.message->'extendedTextMessage'->>'text',
  m.message->'imageMessage'->>'caption',
  m.message->'videoMessage'->>'caption',
  m.message->'documentMessage'->>'fileName'
)`;

export interface ChunkDraft {
  instanceId: string;
  remoteJid: string;
  startTs: number;
  endTs: number;
  messageIds: string[];
  text: string;
}

interface SourceMessage {
  id: string;
  jid: string;
  ts: number;
  fromMe: boolean;
  sender: string | null;
  text: string;
}

/**
 * Messages that still need chunking, oldest first, grouped by chat.
 *
 * Two things are going on here.
 *
 * `resume` restarts each chat from the *start* of its newest chunk rather than
 * its end. That chunk is usually still open — the conversation was mid-flight
 * when the last run happened — and rebuilding it from its own start lets it
 * grow, landing on the same start_ts and so on the unique index, which turns
 * the write into an update instead of a duplicate.
 *
 * `fresh` then throws away every chat that has nothing new past its last
 * chunk. Without it the reopened tails of all several-hundred already-finished
 * chats would sit at the front of this jid-ordered LIMIT, be rebuilt
 * identically, be discarded by dropUnchanged, and leave the caller looking at
 * an empty batch while untouched chats waited behind them.
 */
async function pendingMessages(instanceId: string, limit: number): Promise<SourceMessage[]> {
  const { rows } = await pool.query(
    `WITH resume AS (
       SELECT remote_jid, max(start_ts) AS from_ts, max(end_ts) AS done_ts
         FROM katibe.message_chunk
        WHERE instance_id = $1
        GROUP BY remote_jid
     ),
     fresh AS (
       SELECT DISTINCT m.key->>'remoteJid' AS jid
         FROM evolution_api."Message" m
         LEFT JOIN katibe.voice_transcript vt ON vt.message_id = m.id AND vt.status = 'ok'
         LEFT JOIN resume r ON r.remote_jid = m.key->>'remoteJid'
        WHERE m."instanceId" = $1
          AND COALESCE(${TEXT_SQL}, vt.text) IS NOT NULL
          AND (r.done_ts IS NULL OR m."messageTimestamp" > r.done_ts)
     )
     SELECT m.id,
            m.key->>'remoteJid' AS jid,
            m."messageTimestamp" AS ts,
            (m.key->>'fromMe')::boolean AS from_me,
            m."pushName" AS sender,
            COALESCE(${TEXT_SQL}, vt.text) AS text
       FROM evolution_api."Message" m
       JOIN fresh f ON f.jid = m.key->>'remoteJid'
       LEFT JOIN katibe.voice_transcript vt ON vt.message_id = m.id AND vt.status = 'ok'
       LEFT JOIN resume r ON r.remote_jid = m.key->>'remoteJid'
      WHERE m."instanceId" = $1
        AND COALESCE(${TEXT_SQL}, vt.text) IS NOT NULL
        AND (r.from_ts IS NULL OR m."messageTimestamp" >= r.from_ts)
      ORDER BY m.key->>'remoteJid', m."messageTimestamp"
      LIMIT $2`,
    [instanceId, limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    jid: r.jid as string,
    ts: Number(r.ts),
    fromMe: r.from_me as boolean,
    sender: (r.sender as string | null) ?? null,
    text: (r.text as string).trim(),
  }));
}

/**
 * One line per message, speaker-labelled so the model can tell sides apart.
 *
 * A numeric pushName is dropped rather than printed. In groups WhatsApp often
 * reports the participant's bare number as their name, and embedding
 * "90774687449109: göndərin" spends tokens on a digit string that means
 * nothing and drags the vector toward every other number in the archive.
 */
function line(m: SourceMessage): string {
  const named = m.sender && !/^[\d\s+]+$/.test(m.sender) ? m.sender : null;
  const who = m.fromMe ? "Biz" : (named ?? "Onlar");
  return `${who}: ${m.text}`;
}

/**
 * Groups an ordered message stream into chunks.
 *
 * Exported for the sake of being testable without a database: the boundary
 * rules are the one part of this file that is worth pinning down.
 */
export function buildChunks(messages: SourceMessage[], instanceId: string): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  let current: SourceMessage[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    out.push({
      instanceId,
      remoteJid: current[0].jid,
      startTs: current[0].ts,
      endTs: current[current.length - 1].ts,
      messageIds: current.map((m) => m.id),
      text: current.map(line).join("\n"),
    });
    current = [];
    chars = 0;
  };

  for (const m of messages) {
    const prev = current[current.length - 1];
    const breaks =
      prev !== undefined &&
      (m.jid !== prev.jid ||
        m.ts - prev.ts > GAP_SEC ||
        current.length >= MAX_MESSAGES ||
        chars >= MAX_CHARS);
    if (breaks) flush();
    current.push(m);
    chars += m.text.length;
  }
  flush();
  return out;
}

/**
 * Cuts a vector down to the column's width, renormalising as it goes.
 *
 * Only ever shortens: a model trained with Matryoshka keeps its strongest
 * signal in the leading dimensions, so a prefix is a usable embedding — but
 * only once it is unit length again, because cosine distance in pgvector does
 * not normalise for us and a truncated prefix is shorter than one.
 */
function fitToWidth(v: number[], dims: number): number[] {
  if (v.length <= dims) return v;
  const cut = v.slice(0, dims);
  const norm = Math.hypot(...cut);
  return norm === 0 ? cut : cut.map((x) => x / norm);
}

/** pgvector's text input format. */
function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

/** One client per variant: they differ by endpoint and by credential. */
const clients = new Map<Variant, OpenAI>();

function clientFor(variant: Variant): OpenAI {
  const existing = clients.get(variant);
  if (existing) return existing;
  const cfg = VARIANTS[variant];
  const apiKey = process.env[cfg.keyEnv];
  if (!apiKey) {
    throw new Error(
      `${cfg.keyEnv} yoxdur — "${variant}" varianti (${cfg.model}) onsuz işləmir.`,
    );
  }
  const made = new OpenAI({ apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) });
  clients.set(variant, made);
  return made;
}

/**
 * Embeds a batch of texts in one request.
 *
 * `dimensions` is what makes the 512-wide column legal: without it the API
 * returns 1536 floats and the insert fails on the type, rather than silently
 * storing something mis-shaped.
 */
/**
 * Keçici sayılan xətalar — təkrar cəhd etməyə dəyənlər.
 *
 * `engine_overloaded` bura 136,001 chunk-dan sonra düşdü: səkkiz paralel
 * çağırış provayderin modelini doldurdu, tək bir "Model busy, retry later"
 * cavabı isə saatlarla davam edən işi öldürdü. Xəta məlumat problemi deyil,
 * növbə problemidir — təkrar etmək düzgün cavabdır.
 */
function isTransient(e: unknown): boolean {
  const err = e as { status?: number; code?: string; message?: string };
  if (err?.status === 429 || (err?.status ?? 0) >= 500) return true;
  const text = `${err?.code ?? ""} ${err?.message ?? ""}`.toLowerCase();
  return /overload|busy|timeout|rate.?limit|temporar|econnreset|socket hang up/.test(text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function embed(
  texts: string[],
  variant: Variant = DEFAULT_VARIANT,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  let lastError: unknown;
  // Beş cəhd, eksponensial geri çəkilmə ilə: 1s, 2s, 4s, 8s. Uzun backfill
  // saatlarla işləyir və provayderin bir dəqiqəlik dolmasına görə hər şeyi
  // itirməməlidir. Beşdən sonra atır — sonsuz təkrar sakit ilişmədir.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await embedOnce(texts, variant);
    } catch (e) {
      lastError = e;
      if (!isTransient(e) || attempt === 4) throw e;
      const wait = 1000 * 2 ** attempt;
      console.error(
        `[embed] keçici xəta, ${wait}ms sonra təkrar (${attempt + 1}/4):`,
        (e as Error).message?.slice(0, 100),
      );
      await sleep(wait);
    }
  }
  throw lastError;
}

async function embedOnce(texts: string[], variant: Variant): Promise<number[][]> {
  const cfg = VARIANTS[variant];
  const res = await clientFor(variant).embeddings.create({
    model: cfg.model,
    ...(cfg.sendDimensions ? { dimensions: cfg.dims } : {}),
    input: texts,
  });
  // The API documents that results come back in input order, but it also
  // carries an explicit index — sorting by it costs nothing and removes the
  // chance of pairing a vector with the wrong chunk.
  return [...res.data]
    .sort((a, b) => a.index - b.index)
    .map((d) => fitToWidth(d.embedding, cfg.dims));
}

/**
 * Writes chunks and their vectors, updating any chunk that already exists.
 *
 * A null vector is a chunk deliberately left unembedded (see MIN_EMBED_CHARS);
 * searchSimilar skips those rows.
 */
export async function storeChunks(
  chunks: ChunkDraft[],
  vectors: (number[] | null)[],
): Promise<void> {
  if (chunks.length === 0) return;
  const values: unknown[] = [];
  const tuples = chunks.map((c, i) => {
    const p = i * 7;
    values.push(
      c.instanceId, c.remoteJid, c.startTs, c.endTs, c.messageIds, c.text,
      vectors[i] === null ? null : toVectorLiteral(vectors[i] as number[]),
    );
    return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},$${p + 5}::text[],$${p + 6},$${p + 7}::vector,'${EMBED_MODEL}')`;
  });
  await pool.query(
    `INSERT INTO katibe.message_chunk
       (instance_id, remote_jid, start_ts, end_ts, message_ids, text,
        ${VARIANTS[DEFAULT_VARIANT].column}, model)
     VALUES ${tuples.join(",")}
     ON CONFLICT (instance_id, remote_jid, (message_ids[1])) DO UPDATE
       SET start_ts = EXCLUDED.start_ts,
           end_ts = EXCLUDED.end_ts,
           message_ids = EXCLUDED.message_ids,
           text = EXCLUDED.text,
           ${VARIANTS[DEFAULT_VARIANT].column} = EXCLUDED.${VARIANTS[DEFAULT_VARIANT].column},
           model = EXCLUDED.model,
           created_at = now()`,
    values,
  );
}

/**
 * Drops drafts that are byte-identical to what is already stored.
 *
 * Resumption deliberately rebuilds each chat's newest chunk (see
 * pendingMessages), and most of the time nothing was added to it. Without this
 * filter every run would re-embed one chunk per chat forever — a bill that
 * grows with the number of chats and buys nothing.
 */
async function dropUnchanged(instanceId: string, drafts: ChunkDraft[]): Promise<ChunkDraft[]> {
  if (drafts.length === 0) return drafts;
  const { rows } = await pool.query(
    `SELECT message_ids[1] AS head, text
       FROM katibe.message_chunk
      WHERE instance_id = $1 AND message_ids[1] = ANY($2::text[])`,
    [instanceId, drafts.map((d) => d.messageIds[0])],
  );
  const stored = new Map(rows.map((r) => [r.head as string, r.text as string]));
  return drafts.filter((d) => stored.get(d.messageIds[0]) !== d.text);
}

/** Chunks that still need an embedding, oldest first. */
export async function pendingChunks(instanceId: string, limit: number): Promise<ChunkDraft[]> {
  const messages = await pendingMessages(instanceId, limit);
  return dropUnchanged(instanceId, buildChunks(messages, instanceId));
}

export interface SimilarChunk {
  /** katibe.message_chunk.id — lets a hit be expanded back into its messages. */
  id: number;
  jid: string;
  startTs: number;
  endTs: number;
  messageIds: string[];
  text: string;
  /** 0..1, higher is closer. Cosine distance subtracted from one. */
  score: number;
}

/**
 * Chunks closest in meaning to a query.
 *
 * The instance filter is a WHERE on an HNSW scan, which pgvector applies
 * *after* the index walk — so with several accounts in one table a narrow
 * `limit` could come back short. `limit * 4` is fetched and cut afterwards,
 * which at this table size costs nothing measurable.
 *
 * The 0.45 floor is measured, not chosen: on this archive a true hit for
 * "gömrükdə yük saxlanılıb" scores 0.48 and the first clearly-unrelated chunk
 * sits at 0.44. It is a noise gate and nothing more — cosine score on this
 * text is a weak relevance signal (see the note in scripts/embed-messages.ts),
 * so callers should read the chunks rather than trust the ordering.
 */
export async function searchSimilar(
  instanceId: ScopedInstanceId,
  { query, hours, jid, limit = 12, minScore = 0.45, variant = DEFAULT_VARIANT, beforeTs }:
    {
      query: string; hours?: number; jid?: string; limit?: number;
      minScore?: number; variant?: Variant;
      /**
       * Yalnız bu epoch anından ƏVVƏL bitən parçalar.
       *
       * "Bu, əvvəl də olub?" sualı üçün lazımdır: onsuz ən yaxın nəticə
       * sualın özünü doğuran parça olur, çünki mətn eynidir.
       */
      beforeTs?: number;
    },
): Promise<SimilarChunk[]> {
  // Documents were embedded plain, so only the query side carries the prefix.
  const [vector] = await embed([VARIANTS[variant].queryPrefix + query], variant);
  // Interpolated, not bound — a column name cannot be a parameter. The value
  // comes from VARIANTS and the type forbids anything else reaching here.
  const col = VARIANTS[variant].column;

  /*
   * hnsw.ef_search caps how many candidates the index walk considers, and
   * pgvector defaults it to 40 — so asking for 50 results returned 33, and
   * every filter below (instance, window, score) was thinning an already
   * truncated list rather than a real one. It has to exceed the number of rows
   * we intend to keep, with room for what the filters will discard.
   *
   * SET LOCAL inside an explicit transaction, not SET: the pool hands the same
   * connection to unrelated queries afterwards, and a session-level setting
   * would follow it there.
   */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL hnsw.ef_search = ${Math.max(40, limit * 8)}`);
  const { rows } = await client.query(
    `SELECT id, remote_jid, start_ts, end_ts, message_ids, text,
            1 - (${col} <=> $2::vector) AS score
       FROM katibe.message_chunk
      WHERE instance_id = $1
        AND ${col} IS NOT NULL
        AND ($3::int IS NULL
             OR end_ts > EXTRACT(epoch FROM now() - make_interval(hours => $3::int))::int)
        AND ($4::text IS NULL OR remote_jid = $4)
        AND ($6::int IS NULL OR end_ts < $6)
      ORDER BY ${col} <=> $2::vector
      LIMIT $5`,
    [instanceId, toVectorLiteral(vector), hours ?? null, jid ?? null, limit * 4,
     beforeTs ?? null],
  );
    await client.query("COMMIT");
    return rows
      .map((r) => ({
        id: Number(r.id),
        jid: r.remote_jid as string,
        startTs: Number(r.start_ts),
        endTs: Number(r.end_ts),
        messageIds: r.message_ids as string[],
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

/** How much of the archive is embedded, for the script's progress line. */
export async function coverage(instanceId: string): Promise<{ chunks: number; lastTs: number | null }> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS chunks, max(end_ts)::int AS last_ts
       FROM katibe.message_chunk WHERE instance_id = $1`,
    [instanceId],
  );
  return { chunks: rows[0].chunks as number, lastTs: (rows[0].last_ts as number | null) ?? null };
}
