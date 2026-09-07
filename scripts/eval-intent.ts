/**
 * Scores the reading detector against hand-labelled conversations.
 *
 * WHAT IS BEING MEASURED, and why it is not accuracy. The supervisor's feed is
 * only worth opening if what it says is true. A missed complaint is invisible;
 * an invented one at severity 9 teaches the manager to stop reading. So the
 * headline number here is the FALSE POSITIVE RATE on ordinary traffic, and the
 * cases are sampled at random rather than enriched with positives — the mix
 * has to be the one the detector will actually meet, where roughly one window
 * in twelve carries anything at all.
 *
 * Low-confidence labels are excluded from strict scoring. They are the ones a
 * person from the business would judge better than a model reading text: a
 * customer answering a quoted price with three sad emojis is a reaction, and
 * whether that is an objection is not something this harness should assert.
 *
 * Spends a few cents per run: one classification call per batch of twenty.
 *
 * Run:  npm run eval:intent
 *   KATIBE_INTENT_EVAL=path  the case file (default /var/lib/katibe/intent-eval.json)
 *   EVAL_STRICT=0            include low-confidence labels in scoring
 */
import fs from "node:fs";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const EVAL_PATH = process.env.KATIBE_INTENT_EVAL ?? "/var/lib/katibe/intent-eval.json";

interface Label {
  chunkId: number;
  kind: string;
  confidence: "high" | "low";
  why: string;
}

async function main() {
  const { classifyWindows } = await import("../src/lib/supervisor/intent");
  const { pool } = await import("../src/lib/db");

  if (!fs.existsSync(EVAL_PATH)) throw new Error(`Dəst tapılmadı: ${EVAL_PATH}`);
  const set = JSON.parse(fs.readFileSync(EVAL_PATH, "utf8")) as { labels: Label[] };
  const strict = process.env.EVAL_STRICT !== "0";
  const labels = strict ? set.labels.filter((l) => l.confidence === "high") : set.labels;

  const { rows } = await pool.query(
    `SELECT id, text FROM katibe.message_chunk WHERE id = ANY($1::bigint[])`,
    [labels.map((l) => l.chunkId)],
  );
  const textById = new Map(rows.map((r) => [Number(r.id), r.text as string]));
  const cases = labels.filter((l) => textById.has(l.chunkId));
  if (cases.length !== labels.length) {
    console.log(`${labels.length - cases.length} parça bazada tapılmadı — atlanır.`);
  }

  const found = await classifyWindows(cases.map((c) => textById.get(c.chunkId) as string));
  const predicted = new Map<number, string>();
  for (const f of found) predicted.set(f.index, f.kind);

  let tp = 0, fp = 0, fn = 0, tn = 0, wrongKind = 0;
  const mistakes: string[] = [];
  for (const [i, c] of cases.entries()) {
    const p = predicted.get(i) ?? "none";
    if (c.kind === "none" && p === "none") tn++;
    else if (c.kind === "none") {
      fp++;
      mistakes.push(`  YALAN  [${c.chunkId}] model: ${p} · əslində: yox — ${c.why}`);
    } else if (p === "none") {
      fn++;
      mistakes.push(`  BURAXDI[${c.chunkId}] gözlənilən: ${c.kind} — ${c.why}`);
    } else if (p === c.kind) tp++;
    else {
      // Hadisəni gördü, növünü səhv saldı. Bu, yalan bayraqdan yüngüldür —
      // menecer yenə də baxmalı olan söhbətə yönəldilir.
      wrongKind++;
      mistakes.push(`  NÖV   [${c.chunkId}] model: ${p} · əslində: ${c.kind}`);
    }
  }

  const flags = tp + wrongKind + fp;
  const positives = tp + wrongKind + fn;
  const pct = (a: number, b: number) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(0)}%`);

  console.log(`\n${cases.length} hal${strict ? " (yalnız aydın etiketlər)" : ""}\n`);
  for (const m of mistakes) console.log(m);
  console.log(
    `\ndoğru bayraq ${tp}${wrongKind ? ` (+${wrongKind} növü səhv)` : ""} · ` +
      `yalan bayraq ${fp} · buraxılan ${fn} · toxunulmayan ${tn}`,
  );
  console.log(
    `dəqiqlik ${pct(tp + wrongKind, flags)} (qaldırılan bayraqların neçəsi real) · ` +
      `tapma ${pct(tp + wrongKind, positives)} (real hadisələrin neçəsi tutuldu)`,
  );
  // Lentə düşən yükün ölçüsü: bu nisbət gündəlik həcmə vurulur.
  console.log(`yalan-müsbət nisbəti ${pct(fp, fp + tn)} (hadisəsiz söhbətlərin neçəsi bayraqlandı)`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
