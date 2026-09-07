/**
 * Müştəri mesajlarının mövzu təsnifatı.
 *
 * QURU İŞLƏMƏ HEÇ BİR API ÇAĞIRIŞI ETMİR. identify-clients-də bir dəfə əksi
 * oldu — `DRY_RUN=1` yalnız baza yazısını atlayırdı və pul xərcləyirdi, yəni
 * «bu nə qədər tutacaq» sualına cavab verə bilmirdi. Burada qiymət yığılmış
 * paketlərdən hesablanır, model çağırılmır.
 *
 * Run: TOPIC_DRY_RUN=1 npm run classify:topics    (yalnız qiymət)
 *      npm run classify:topics                    (gündəlik artım)
 *      TOPIC_BACKFILL_DAYS=30 TOPIC_MAX=20000 npm run classify:topics
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

async function main() {
  const { pool } = await import("../src/lib/db");
  const topics = await import("../src/lib/topics");

  const days = Number(process.env.TOPIC_BACKFILL_DAYS ?? 2);
  const max = Number(process.env.TOPIC_MAX ?? 1500);
  const dry = process.env.TOPIC_DRY_RUN === "1";

  const short = dry ? 0 : await topics.labelShortMessages(days);
  const candidates = await topics.findCandidates(days, max);
  const estimate = topics.estimateCost(candidates);

  console.log(`Pəncərə: ${days} gün · tavan: ${max}`);
  if (!dry) console.log(`Qısa mesaj qayda ilə etiketləndi: ${short}`);
  console.log(
    `Namizəd: ${candidates.length} · paket: ${estimate.batches} · ` +
      `təxmini ${estimate.inputTokens} giriş / ${estimate.outputTokens} çıxış token · ` +
      `≈ $${estimate.usd.toFixed(3)} (${topics.TOPIC_MODEL})`,
  );

  if (dry) {
    console.log("\nQURU İŞLƏMƏ — model çağırılmadı, heç nə yazılmadı.");
    await pool.end();
    return;
  }
  if (candidates.length === 0) {
    console.log("Təsnif olunacaq mesaj yoxdur.");
    await pool.end();
    return;
  }

  let labelled = 0;
  let inTok = 0;
  let outTok = 0;
  let failed = 0;
  for (let i = 0; i < candidates.length; i += topics.BATCH_SIZE) {
    const batch = candidates.slice(i, i + topics.BATCH_SIZE);
    try {
      const r = await topics.classifyBatch(batch);
      labelled += r.labelled;
      inTok += r.inputTokens;
      outTok += r.outputTokens;
    } catch (e) {
      // Bir paketin uğursuzluğu qalanını dayandırmır: etiketlənməmiş mesaj
      // növbəti gedişatda yenidən namizəddir, çünki seçim «etiketi yoxdur»
      // şərtinə baxır.
      failed++;
      console.error(`  paket ${i / topics.BATCH_SIZE} uğursuz:`, (e as Error).message);
    }
    if ((i / topics.BATCH_SIZE) % 10 === 9) {
      console.log(`  … ${labelled} etiketləndi`);
    }
  }

  const usd = (inTok / 1e6) * topics.PRICE.input + (outTok / 1e6) * topics.PRICE.output;
  console.log(
    `\nEtiketləndi: ${labelled} · uğursuz paket: ${failed} · ` +
      `${inTok} giriş / ${outTok} çıxış token · $${usd.toFixed(3)}`,
  );
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
