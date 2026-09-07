/**
 * Scores semantic search against a fixed set of known-item queries.
 *
 * THE POINT. "Does this feel better?" is not a measurement, and every choice
 * downstream — a bigger embedding model, a reranker, different chunk
 * boundaries — is otherwise decided on the strength of whichever three results
 * someone happened to scroll past. This turns each of those into a number that
 * can be compared before and after.
 *
 * THE METHOD. Each case names one chunk and the question a person would ask to
 * find it. The queries are deliberately written around the chunk's own
 * wording, so a hit means the retriever understood the subject rather than
 * matched a string — which is exactly the capability ILIKE does not have and
 * this index is supposed to add.
 *
 * WHAT THE NUMBERS UNDERSTATE. One chunk per query is marked correct, but a
 * conversation usually spills across two or three neighbouring chunks, and any
 * of them may be an equally good answer. A run that puts a neighbour first is
 * scored as a miss. That makes every figure here a lower bound — fine for
 * comparing two configurations on the same set, misleading if read as "the
 * search is only this good".
 *
 * Spends a few cents per run: one embedding call per query, nothing else.
 *
 * Run:  npm run eval:search
 *   KATIBE_SEARCH_EVAL=path   the case file (default /var/lib/katibe/search-eval.json)
 *   EVAL_DEPTH=50             how deep to look for the expected chunk (default 50)
 *   EVAL_VARIANT=<name>       which VARIANTS entry to score (default: the live one)
 *   EVAL_RERANK=1             rerank the shortlist before scoring (spends a
 *                             little more: one cheap LLM call per query)
 */
import fs from "node:fs";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const EVAL_PATH = process.env.KATIBE_SEARCH_EVAL ?? "/var/lib/katibe/search-eval.json";

interface EvalCase {
  chunkId: number;
  query: string;
  about: string;
}

interface EvalSet {
  instanceId: string;
  cases: EvalCase[];
}

async function main() {
  const { searchSimilar, VARIANTS, DEFAULT_VARIANT } = await import("../src/lib/embedding");
  const { rerank, RERANK_MODEL } = await import("../src/lib/rerank");
  const { systemScope } = await import("../src/lib/access");
  const { pool } = await import("../src/lib/db");

  const variant = (process.env.EVAL_VARIANT ?? DEFAULT_VARIANT) as keyof typeof VARIANTS;
  if (!(variant in VARIANTS)) throw new Error(`Naməlum variant: ${variant}`);
  const useRerank = process.env.EVAL_RERANK === "1";

  if (!fs.existsSync(EVAL_PATH)) {
    throw new Error(`Ölçü dəsti tapılmadı: ${EVAL_PATH}`);
  }
  const set = JSON.parse(fs.readFileSync(EVAL_PATH, "utf8")) as EvalSet;
  const depth = Number(process.env.EVAL_DEPTH ?? 50);
  const scope = systemScope(set.instanceId);

  // Ranks are 1-based; 0 means the expected chunk never appeared.
  const ranks: number[] = [];
  const label = `${variant}${useRerank ? ` + rerank (${RERANK_MODEL})` : ""}`;
  console.log(`${set.cases.length} sorğu · ${depth} dərinlik · ${label}\n`);

  for (const c of set.cases) {
    // minScore 0 on purpose: the score floor is a display gate for the MCP
    // tool, and applying it here would score the gate rather than the ranking.
    const hits = await searchSimilar(scope, {
      query: c.query, limit: depth, minScore: 0, variant,
    });
    // The reranker only reorders what the index already found, so it can never
    // rescue a case the vector search missed entirely — which is the honest
    // way to read any improvement it shows here.
    const ordered = useRerank ? await rerank(c.query, hits, depth) : hits;
    const rank = ordered.findIndex((h) => h.id === c.chunkId) + 1;
    ranks.push(rank);
    const mark = rank === 1 ? "✓" : rank === 0 ? "✗" : `${rank}.`;
    console.log(`${mark.padEnd(4)} ${c.query}`);
    if (rank !== 1) console.log(`       gözlənilən: ${c.about}`);
  }

  const at = (k: number) => ranks.filter((r) => r >= 1 && r <= k).length;
  const mrr = ranks.reduce((s, r) => s + (r >= 1 ? 1 / r : 0), 0) / ranks.length;
  const pct = (n: number) => `${((n / ranks.length) * 100).toFixed(0)}%`;

  console.log(
    `\n${label} — recall@1 ${at(1)}/${ranks.length} (${pct(at(1))}) · ` +
      `recall@5 ${at(5)}/${ranks.length} (${pct(at(5))}) · ` +
      `recall@10 ${at(10)}/${ranks.length} (${pct(at(10))}) · ` +
      `MRR ${mrr.toFixed(3)}`,
  );
  // The ceiling: how often the answer was in the candidate list at all. No
  // amount of reordering can beat this, so it is the number that says whether
  // the next improvement belongs in the index or in the ranking.
  console.log(`tavan (recall@${depth}) ${at(depth)}/${ranks.length} (${pct(at(depth))})`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
