/**
 * Həftəlik satıcı faktlarını yazır.
 *
 * Ardıcıllıq vacibdir: əvvəlcə həftənin şəkli yazılır, sonra faktlar ondan
 * çıxarılır. Ayrı cron kimi planlaşdırmaq olardı və o zaman biri işləyib
 * digəri işləməyəndə faktlar sükutla köhnə şəkildən çıxardı — mirror-evolution
 * ilə refresh_chat_stats dərsi.
 *
 * QURU İŞLƏMƏ MODEL ÇAĞIRMIR: namizədləri çap edir, seçimi göstərmir.
 *
 * Run: INSIGHT_DRY_RUN=1 npm run insight:sales
 *      npm run insight:sales
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const { isoWeekRange, writeSnapshot, readSnapshots } = await import("../src/lib/sales-history");
  const insight = await import("../src/lib/sales-insight");

  const dry = process.env.INSIGHT_DRY_RUN === "1";

  // Keçən tam həftə və ondan əvvəlki — müqayisə üçün ikisi də lazımdır.
  const cur = isoWeekRange(1);
  const prev = isoWeekRange(2);
  console.log(`Dövr: ${ymd(cur.start)} … ${ymd(cur.end)} (əvvəlki: ${ymd(prev.start)})`);

  if (!dry) {
    await writeSnapshot(prev.start, prev.end);
    await writeSnapshot(cur.start, cur.end);
  }

  const snapshots = await readSnapshots(12);
  const current = snapshots.filter((s) => s.periodStart === ymd(cur.start));
  const previous = snapshots.filter((s) => s.periodStart === ymd(prev.start));
  if (current.length === 0) {
    console.log("Bu həftə üçün şəkil yoxdur — fakt yazılmadı.");
    await pool.end();
    return;
  }

  const candidates = insight.buildCandidates(current, previous);
  console.log(`Namizəd: ${candidates.length} (tavan: ${insight.MAX_INSIGHTS} seçim)`);
  for (const c of candidates) console.log(`  [${c.kind}/${c.direction}] ${c.facts}`);

  if (dry) {
    console.log("\nQURU İŞLƏMƏ — model çağırılmadı, heç nə yazılmadı.");
    await pool.end();
    return;
  }

  const { chosen, inputTokens, outputTokens } = await insight.generateInsights(candidates);
  const n = await insight.storeInsights(ymd(cur.start), ymd(cur.end), chosen);
  // Sonnet 5: $3 giriş / $15 çıxış (milyon token).
  const usd = (inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15;
  console.log(`\nYazıldı: ${n} fakt · ${inputTokens} giriş / ${outputTokens} çıxış token · $${usd.toFixed(4)}`);
  for (const c of chosen) console.log(`  • ${c.headline}`);

  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
