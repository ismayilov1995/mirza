/**
 * Chunks and embeds the canonical store, so nine years become searchable by
 * meaning rather than only by substring.
 *
 * 1,365,882 messages carry text — about 45 MB, which chunks to roughly 380,000
 * conversation windows and costs about $0.15 at Qwen3-Embedding-8B's rate.
 *
 * The chunking rules are the live side's, and they were measured there: a run
 * of consecutive messages rather than one message, because a third of what
 * people send is "ok" and a vector for that sits near everything and answers
 * nothing; a thirty-minute pause ends a run; and a window under 25 characters
 * gets a row but no vector, which keeps the forward-only scan moving past it
 * for free.
 *
 * IDEMPOTENT, like everything else that writes to this store: work is found by
 * asking which conversations have messages past their last chunk, so an
 * interrupted run resumes and a finished one embeds nothing.
 *
 * SPENDS MONEY. The default ceiling is deliberately low; the full pass is an
 * explicit CHUNK_MAX=0.
 *
 * DROP THE HNSW INDEX BEFORE A LARGE LOAD, AND REBUILD IT AFTER. Measured on
 * this table at 173,000 rows: writing 512 vectors took 139 SECONDS with the
 * index in place and 94 MILLISECONDS without it. Embedding the same 512 takes
 * 2.8 seconds, so with the index the database was fifty times slower than the
 * model and the whole job ran at ten chunks a second instead of a hundred and
 * fifty.
 *
 * It is worth naming how long that took to find. Throughput was blamed first
 * on request concurrency, then on the size of each pass; both were raised,
 * neither helped, because both were on the read side. A benchmark showed the
 * endpoint delivering 185 chunks a second while the job managed ten — and only
 * then did timing the INSERT itself become the obvious next move.
 *
 *   DROP INDEX katibe.chunk_embedding_idx;
 *   -- run this script --
 *   CREATE INDEX CONCURRENTLY chunk_embedding_idx
 *     ON katibe.chunk USING hnsw (embedding vector_cosine_ops);
 *
 * Semantic search over the archive falls back to a sequential scan while the
 * index is gone: slow, but working. Nothing else is affected — exact search,
 * the chat list and the live MCP search read other tables.
 *
 * Run:  npm run chunk:store
 *   CHUNK_MAX=0        chunks per run, 0 = no ceiling (default 0)
 *   CHUNK_BATCH=256    chunks per embedding call (default 256)
 *   CHUNK_CHATS=800    conversations gathered per pass (default 800)
 *   CHUNK_PARALLEL=6   embedding calls in flight at once (default 6)
 *   CHUNK_DRY_RUN=1    build and price them, call nothing
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

/** A pause this long ends a chunk — see src/lib/embedding.ts for why 30 min. */
const GAP_SEC = 30 * 60;
const MAX_MESSAGES = 12;
const MAX_CHARS = 1500;

/** $ per million input tokens, Qwen3-Embedding-8B on DeepInfra. */
const PRICE_PER_MTOK = 0.01;
/** Pessimistic for az/ru mixed text — see scripts/embed-messages.ts. */
const CHARS_PER_TOKEN = 3.0;

interface Row {
  id: string;
  chat_id: string;
  ts: number;
  direction: string;
  sender_name: string | null;
  body: string;
}

interface Draft {
  chatId: number;
  startTs: number;
  endTs: number;
  messageIds: string[];
  text: string;
}

/** One line per message, speaker-labelled; numeric names are dropped as noise. */
function line(r: Row): string {
  const named = r.sender_name && !/^[\d\s+]+$/.test(r.sender_name) ? r.sender_name : null;
  return `${r.direction === "out" ? "Biz" : (named ?? "Onlar")}: ${r.body}`;
}

function buildChunks(rows: Row[]): Draft[] {
  const out: Draft[] = [];
  let cur: Row[] = [];
  let chars = 0;
  const flush = () => {
    if (cur.length === 0) return;
    out.push({
      chatId: Number(cur[0].chat_id),
      startTs: cur[0].ts,
      endTs: cur[cur.length - 1].ts,
      messageIds: cur.map((r) => r.id),
      text: cur.map(line).join("\n"),
    });
    cur = [];
    chars = 0;
  };
  for (const r of rows) {
    const prev = cur[cur.length - 1];
    if (
      prev !== undefined &&
      (r.chat_id !== prev.chat_id ||
        r.ts - prev.ts > GAP_SEC ||
        cur.length >= MAX_MESSAGES ||
        chars >= MAX_CHARS)
    ) {
      flush();
    }
    cur.push(r);
    chars += r.body.length;
  }
  flush();
  return out;
}

async function main() {
  const { embed, MIN_EMBED_CHARS, EMBED_MODEL } = await import("../src/lib/embedding");
  const { pool } = await import("../src/lib/db");

  const maxChunks = Number(process.env.CHUNK_MAX ?? 0);
  const batchSize = Number(process.env.CHUNK_BATCH ?? 256);
  // Large, because the query that finds the conversations is not cheap: it
  // asks 1.66M messages which ones have text past their last chunk, and that
  // costs about 4.7 seconds however few it returns.
  //
  // Early passes are full of big conversations and the overhead disappears
  // against them. In the tail they are small ones, and at 200 per pass the
  // fixed cost became most of the wall clock — throughput sat at ten chunks a
  // second with eight embedding calls in flight, which means the endpoint was
  // idling while Postgres worked. Gathering more per pass pays the 4.7 seconds
  // once for far more work.
  const chatBatch = Number(process.env.CHUNK_CHATS ?? 800);
  // The embedding endpoint is network-bound, not compute-bound here: one call
  // of 64 texts takes about ten seconds whatever else is happening, so serial
  // batches ran at five chunks a second and the full pass would have taken
  // seventeen hours. Six in flight is the difference between a coffee and a
  // working day; it is a knob because the right number belongs to the
  // provider's patience rather than to this code.
  const parallel = Math.max(1, Number(process.env.CHUNK_PARALLEL ?? 6));
  const dryRun = process.env.CHUNK_DRY_RUN === "1";

  console.log(`Model ${EMBED_MODEL}${dryRun ? " · QURU İŞLƏMƏ" : ""}`);

  let done = 0;
  let skipped = 0;
  let chars = 0;
  const t0 = Date.now();

  for (;;) {
    if (maxChunks > 0 && done >= maxChunks) break;

    // Conversations with text past whatever was last chunked. Restarting each
    // one from the START of its newest chunk lets a chunk that was still open
    // grow, landing on the same head id and so on the unique index — an update
    // rather than a duplicate.
    const { rows: chats } = await pool.query(
      `WITH resume AS (
         SELECT chat_id, max(start_ts) AS from_ts, max(end_ts) AS done_ts
           FROM katibe.chunk GROUP BY chat_id
       )
       SELECT c.id, COALESCE(r.from_ts, 0) AS from_ts
         FROM katibe.chat c
         LEFT JOIN resume r ON r.chat_id = c.id
        WHERE EXISTS (
                SELECT 1 FROM katibe.message m
                 WHERE m.chat_id = c.id
                   AND m.body IS NOT NULL AND length(m.body) > 0
                   AND (r.done_ts IS NULL OR m.ts > r.done_ts))
        ORDER BY c.last_ts DESC NULLS LAST
        LIMIT $1`,
      [chatBatch],
    );
    if (chats.length === 0) break;

    const { rows } = await pool.query(
      `SELECT m.id::text, m.chat_id::text, m.ts, m.direction, m.sender_name, m.body
         FROM katibe.message m
         JOIN unnest($1::bigint[], $2::int[]) AS w(chat_id, from_ts)
           ON w.chat_id = m.chat_id
        WHERE m.body IS NOT NULL AND length(m.body) > 0
          AND m.ts >= w.from_ts
        ORDER BY m.chat_id, m.ts, m.id`,
      [chats.map((c) => Number(c.id)), chats.map((c) => Number(c.from_ts))],
    );

    const drafts = buildChunks(rows as unknown as Row[]);
    // Unchanged rebuilds are dropped before they cost anything: resumption
    // deliberately reopens each conversation's newest chunk, and most of the
    // time nothing was added to it.
    const { rows: have } = await pool.query(
      `SELECT chat_id, message_ids[1] AS head, text FROM katibe.chunk
        WHERE chat_id = ANY($1::bigint[])`,
      [chats.map((c) => Number(c.id))],
    );
    const stored = new Map(
      have.map((r) => [`${r.chat_id}:${r.head}`, r.text as string]),
    );
    const fresh = drafts.filter(
      (d) => stored.get(`${d.chatId}:${d.messageIds[0]}`) !== d.text,
    );
    if (fresh.length === 0) break;

    for (let i = 0; i < fresh.length; i += batchSize * parallel) {
      if (maxChunks > 0 && done >= maxChunks) break;
      const group = fresh.slice(i, i + batchSize * parallel);
      const slices: Draft[][] = [];
      for (let k = 0; k < group.length; k += batchSize) {
        slices.push(group.slice(k, k + batchSize));
      }

      // Embeddings for the whole group are fetched at once; the writes stay
      // sequential, since Postgres is not the slow part and interleaved
      // upserts on the same conflict target would only contend.
      const embedded = dryRun
        ? slices.map(() => [] as number[][])
        : await Promise.all(
            slices.map((sl) => {
              const w = sl.filter((d) => d.text.length >= MIN_EMBED_CHARS);
              return w.length > 0 ? embed(w.map((d) => d.text)) : Promise.resolve([]);
            }),
          );

      for (const [sliceIdx, slice] of slices.entries()) {
      const worth = slice.filter((d) => d.text.length >= MIN_EMBED_CHARS);
      const thin = slice.filter((d) => d.text.length < MIN_EMBED_CHARS);
      chars += worth.reduce((s, d) => s + d.text.length, 0);

      if (!dryRun) {
        const vectors = embedded[sliceIdx];
        const all = [
          ...worth.map((d, k) => ({ d, v: vectors[k] as number[] | null })),
          ...thin.map((d) => ({ d, v: null })),
        ];
        if (all.length > 0) {
          const values: unknown[] = [];
          const tuples = all.map(({ d, v }, k) => {
            const p = k * 6;
            values.push(
              d.chatId, d.startTs, d.endTs, d.messageIds, d.text,
              v === null ? null : `[${v.join(",")}]`,
            );
            return `($${p + 1},$${p + 2},$${p + 3},$${p + 4}::bigint[],$${p + 5},$${p + 6}::vector,'${EMBED_MODEL}')`;
          });
          await pool.query(
            `INSERT INTO katibe.chunk
               (chat_id, start_ts, end_ts, message_ids, text, embedding, model)
             VALUES ${tuples.join(",")}
             ON CONFLICT (chat_id, (message_ids[1])) DO UPDATE
               SET end_ts = EXCLUDED.end_ts, message_ids = EXCLUDED.message_ids,
                   text = EXCLUDED.text, embedding = EXCLUDED.embedding,
                   model = EXCLUDED.model, created_at = now()`,
            values,
          );
        }
      }
      done += worth.length;
      skipped += thin.length;
      }
      const rate = done / Math.max(1, (Date.now() - t0) / 1000);
      process.stdout.write(
        `\r  ${done.toLocaleString()} chunk · ${skipped.toLocaleString()} qısa · ${Math.round(rate)}/san   `,
      );
    }
    if (dryRun) break;
  }

  const price = ((chars / CHARS_PER_TOKEN) / 1_000_000) * PRICE_PER_MTOK;
  console.log(
    `\n${dryRun ? "QURU İŞLƏMƏ — " : "Bitdi — "}${done.toLocaleString()} chunk` +
      `, ${skipped.toLocaleString()} qısa olduğu üçün buraxıldı, təxmini $${price.toFixed(3)}.`,
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
