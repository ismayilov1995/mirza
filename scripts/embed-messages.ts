/**
 * Builds and embeds conversation chunks for semantic search.
 *
 * Runs in two modes without knowing the difference between them: the first
 * pass walks the whole archive, every later pass finds only what has arrived
 * since. Resumption lives in the data (katibe.message_chunk), not in a
 * checkpoint file, so an interrupted run costs nothing but the batch it was in
 * the middle of.
 *
 * SPENDS MONEY. Every chunk is one OpenAI embeddings call's worth of input.
 * The default ceiling is deliberately low; a full backfill is an explicit
 * EMBED_MAX_CHUNKS=0 (no ceiling) run.
 *
 * RETRIEVAL QUALITY, MEASURED. text-embedding-3-small matches these chats at
 * the level of topic, not of predicate: "gömrükdə yük saxlanılıb" reliably
 * finds the customs-declaration thread that ILIKE cannot, but "ödəniş gecikir"
 * returns conversations about money generally rather than about lateness. Much
 * of this archive is Latin-transliterated Azerbaijani without diacritics
 * ("Cox sagolun", "Uje kuryede imish") mixed with Russian, which is the worst
 * case for a small multilingual model. If precision needs to improve, the
 * lever was the model, and it has already been pulled: this now runs
 * text-embedding-3-large, which roughly doubled how often the right passage is
 * retrieved at all (sql/2026-08-30_adopt_large_embedding.sql). What remains
 * unfixed by any embedding model is ranking, which is why search reranks —
 * see src/lib/rerank.ts.
 *
 * Forward-only, like scripts/transcribe-voice.ts: a chat is revisited when it
 * has messages newer than its last chunk. A message that Baileys back-fills
 * with an older timestamp than one already chunked is therefore not picked up;
 * re-chunking such a chat means deleting its rows from katibe.message_chunk
 * and letting the next run rebuild them.
 *
 * Read-only with respect to WhatsApp — it reads rows Baileys already stored
 * and never calls a write endpoint, so it cannot mark anything as read.
 *
 * Run manually:  npm run embed:messages
 *   EMBED_INSTANCE_ID=...   only this instance (default: every instance)
 *   EMBED_MAX_CHUNKS=2000   spend ceiling per run, 0 = no ceiling (default 2000)
 *   EMBED_BATCH=64          chunks per API call (default 64)
 *   EMBED_DRY_RUN=1         chunk and price it, call nothing, spend nothing
 */
import { loadEnvLocal } from "../mcp/env";

// .env.local MUST be loaded before src/lib/db.ts, which reads DATABASE_URL at
// module scope — hence the dynamic imports inside main() below.
loadEnvLocal();

/** $ per million input tokens for text-embedding-3-large, the default variant. */
const PRICE_PER_MTOK = 0.13;

/**
 * Rough tokens-per-character for this archive. Azerbaijani and Russian
 * tokenise worse than English (~3.2 and ~2.6 chars per token against ~4), and
 * these chats mix all three; 3.0 is the pessimistic middle, so the printed
 * price is an over-estimate rather than a surprise.
 */
const CHARS_PER_TOKEN = 3.0;

function money(chars: number): string {
  return `$${(((chars / CHARS_PER_TOKEN) / 1_000_000) * PRICE_PER_MTOK).toFixed(4)}`;
}

async function main() {
  const { pendingChunks, embed, storeChunks, coverage, EMBED_MODEL, EMBED_DIMS, MIN_EMBED_CHARS } =
    await import("../src/lib/embedding");
  const { pool } = await import("../src/lib/db");

  const only = process.env.EMBED_INSTANCE_ID;
  const maxChunks = Number(process.env.EMBED_MAX_CHUNKS ?? 2000);
  const batchSize = Number(process.env.EMBED_BATCH ?? 64);
  const dryRun = process.env.EMBED_DRY_RUN === "1";

  const { rows: instances } = await pool.query(
    `SELECT DISTINCT "instanceId" AS id FROM evolution_api."Message"
      WHERE ($1::text IS NULL OR "instanceId" = $1) ORDER BY 1`,
    [only ?? null],
  );
  if (instances.length === 0) {
    console.log("Heç bir instans tapılmadı.");
    await pool.end();
    return;
  }

  console.log(
    `Model ${EMBED_MODEL} (${EMBED_DIMS} ölçü) · ${instances.length} instans` +
      `${maxChunks > 0 ? ` · limit ${maxChunks} chunk` : " · limitsiz"}` +
      `${dryRun ? " · QURU İŞLƏMƏ" : ""}`,
  );

  let done = 0;
  let skipped = 0;
  let chars = 0;
  for (const { id } of instances as { id: string }[]) {
    const before = await coverage(id);
    let forThis = 0;

    // The message fetch is bounded, not the chunk count, so ask for enough
    // messages to fill a batch even when the archive is all one-liners.
    for (;;) {
      if (maxChunks > 0 && done >= maxChunks) break;
      const want = maxChunks > 0 ? Math.min(batchSize, maxChunks - done) : batchSize;
      const drafts = (await pendingChunks(id, want * MAX_MESSAGES_PER_CHUNK)).slice(0, want);
      if (drafts.length === 0) break;

      // Chunks too short to mean anything get a row but no vector, so the
      // forward-only scan moves past them without being billed for them.
      const worth = drafts.filter((d) => d.text.length >= MIN_EMBED_CHARS);
      const thin = drafts.filter((d) => d.text.length < MIN_EMBED_CHARS);
      chars += worth.reduce((s, d) => s + d.text.length, 0);
      if (!dryRun) {
        if (worth.length > 0) await storeChunks(worth, await embed(worth.map((d) => d.text)));
        if (thin.length > 0) await storeChunks(thin, thin.map(() => null));
      }
      done += worth.length;
      skipped += thin.length;
      forThis += drafts.length;
      process.stdout.write(`\r  ${id} — ${forThis} chunk${" ".repeat(8)}`);

      // Dry runs write nothing, so the same drafts would come back forever.
      if (dryRun) break;
    }

    const after = dryRun ? before : await coverage(id);
    process.stdout.write(`\r  ${id} — +${forThis} chunk (cəmi ${after.chunks})${" ".repeat(20)}\n`);
  }

  console.log(
    dryRun
      ? `QURU İŞLƏMƏ — ${done} chunk hazırlandı (${skipped} qısa, embed olunmayacaq), ` +
        `təxmini ${money(chars)}, heç nə göndərilmədi.`
      : `Bitdi — ${done} chunk embed olundu, ${skipped} qısa olduğu üçün buraxıldı, ` +
        `təxmini ${money(chars)}.`,
  );
  await pool.end();
}

/** Mirrors MAX_MESSAGES in src/lib/embedding.ts — see the comment above. */
const MAX_MESSAGES_PER_CHUNK = 12;

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
