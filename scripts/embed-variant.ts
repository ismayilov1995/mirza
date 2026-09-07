/**
 * Fills a second embedding column over chunks that already exist.
 *
 * Idle by design between comparisons: VARIANTS normally holds only the live
 * model, and this script then has nothing to fill. To run a new comparison,
 * add a column in SQL, add its entry to VARIANTS, and point EMBED_VARIANT at
 * it — the sequence that produced the table in
 * sql/2026-08-30_adopt_large_embedding.sql.
 *
 * This is the A/B facility, not part of the live path: scripts/embed-messages.ts
 * builds chunks and embeds them with the default variant, and this one takes
 * those same rows and embeds their text again with a different model, so the
 * two can be scored against each other on identical input
 * (scripts/eval-search.ts).
 *
 * Only chunks that already carry a default-variant vector are considered —
 * the ones deliberately left unembedded for being too short stay that way, so
 * both variants cover exactly the same set.
 *
 * SPENDS MONEY, and more of it than the default variant does:
 * text-embedding-3-large is about six times the price of -small.
 *
 * Run:  npm run embed:variant
 *   EMBED_VARIANT=large     which variant to fill (default large)
 *   EMBED_MAX_CHUNKS=0      ceiling per run, 0 = no ceiling (default 0)
 *   EMBED_BATCH=n           chunks per API call (default: the variant's own)
 *   EMBED_DRY_RUN=1         count and price it, call nothing, spend nothing
 */
import { loadEnvLocal } from "../mcp/env";
// Type-only, so it is erased at compile time and does not pull the module (and
// with it src/lib/db.ts) in before loadEnvLocal() has run.
import type { Variant } from "../src/lib/embedding";

loadEnvLocal();

/** $ per million input tokens, by variant. */
const PRICE_PER_MTOK: Record<string, number> = {
  large: 0.13,
  bge: 0.01,
  qwen: 0.01,
  qwen2k: 0.01,
};

/** See scripts/embed-messages.ts — pessimistic for az/ru mixed text. */
const CHARS_PER_TOKEN = 3.0;

async function main() {
  const { VARIANTS, embed, DEFAULT_VARIANT } = await import("../src/lib/embedding");
  const { pool } = await import("../src/lib/db");

  const variant = (process.env.EMBED_VARIANT ?? "") as Variant;
  if (!(variant in VARIANTS)) {
    throw new Error(
      `EMBED_VARIANT verilməyib və ya naməlumdur: "${variant}". ` +
        `Mövcud variantlar: ${Object.keys(VARIANTS).join(", ")}`,
    );
  }
  // Read the config before the is-it-the-default guard: after that check the
  // compiler narrows `variant` away entirely whenever VARIANTS holds a single
  // entry, which is the normal state between comparisons.
  const cfg: { model: string; dims: number; column: string; batch: number; queryPrefix: string } = VARIANTS[variant];
  const baseCol = VARIANTS[DEFAULT_VARIANT].column;
  if (variant === DEFAULT_VARIANT) {
    throw new Error(`${variant} standart variantdır — scripts/embed-messages.ts onu onsuz da doldurur.`);
  }
  const col = cfg.column;
  const maxChunks = Number(process.env.EMBED_MAX_CHUNKS ?? 0);
  const batchSize = Number(process.env.EMBED_BATCH ?? cfg.batch);
  const dryRun = process.env.EMBED_DRY_RUN === "1";

  const { rows: pend } = await pool.query(
    `SELECT count(*)::int AS n, COALESCE(sum(length(text)), 0)::bigint AS chars
       FROM katibe.message_chunk WHERE ${baseCol} IS NOT NULL AND ${col} IS NULL`,
  );
  const total = pend[0].n as number;
  const price = ((Number(pend[0].chars) / CHARS_PER_TOKEN) / 1_000_000) * (PRICE_PER_MTOK[variant] ?? 0);
  console.log(
    `${variant} (${cfg.model}, ${cfg.dims} ölçü) · ` +
      `${total} chunk gözləyir · təxmini $${price.toFixed(3)}${dryRun ? " · QURU İŞLƏMƏ" : ""}`,
  );
  if (dryRun || total === 0) {
    await pool.end();
    return;
  }

  let done = 0;
  for (;;) {
    if (maxChunks > 0 && done >= maxChunks) break;
    const want = maxChunks > 0 ? Math.min(batchSize, maxChunks - done) : batchSize;
    const { rows } = await pool.query(
      `SELECT id, text FROM katibe.message_chunk
        WHERE ${baseCol} IS NOT NULL AND ${col} IS NULL
        ORDER BY id LIMIT $1`,
      [want],
    );
    if (rows.length === 0) break;

    const vectors = await embed(rows.map((r) => r.text as string), variant);
    // One statement per batch: unnest pairs the ids with their vectors, so the
    // whole batch lands or none of it does.
    await pool.query(
      `UPDATE katibe.message_chunk c
          SET ${col} = v.vec::vector
         FROM (SELECT * FROM unnest($1::bigint[], $2::text[]) AS t(id, vec)) v
        WHERE c.id = v.id`,
      [rows.map((r) => r.id), vectors.map((x) => `[${x.join(",")}]`)],
    );
    done += rows.length;
    process.stdout.write(`\r  ${done}/${total} chunk        `);
  }
  console.log(`\rBitdi — ${variant} üçün ${done} chunk embed olundu.${" ".repeat(20)}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
