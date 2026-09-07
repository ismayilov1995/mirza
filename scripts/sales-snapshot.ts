/**
 * Satıcı metriklərinin həftəlik şəklini yazır.
 *
 * Standart olaraq YALNIZ tamamlanmış həftələr yazılır: yarımçıq həftənin
 * şəkli hər gün dəyişər və «əvvəl belə idi» iddiasının altını oyardı. Cari
 * həftə onsuz da ekranda canlı hesablanır.
 *
 * Run: npm run snapshot:sales            (keçən həftə)
 *      SNAPSHOT_WEEKS=12 npm run snapshot:sales   (12 həftə geriyə doldurma)
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

async function main() {
  const { pool } = await import("../src/lib/db");
  const { isoWeekRange, writeSnapshot } = await import("../src/lib/sales-history");

  const weeks = Math.max(1, Math.min(52, Number(process.env.SNAPSHOT_WEEKS ?? 1)));
  console.log(`${weeks} həftə yazılır (tamamlanmışlar, ən yenidən köhnəyə):`);

  let total = 0;
  for (let i = 1; i <= weeks; i++) {
    const { start, end } = isoWeekRange(i);
    const started = Date.now();
    const n = await writeSnapshot(start, end);
    total += n;
    console.log(
      `  ${start.toISOString().slice(0, 10)} … ${end.toISOString().slice(0, 10)}  ` +
        `${n} satıcı  ${Date.now() - started} ms`,
    );
  }
  console.log(`\nCəmi ${total} sətir yazıldı.`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
