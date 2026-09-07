/**
 * Satıcı statistikasının invariantları.
 *
 * Bu, "rəqəm düzdürmü" yoxlaması deyil — canlı bazada düz cavab bilinmir.
 * Yoxlanan şey sorğunun ÖZ-ÖZÜ ilə ziddiyyətə düşməməsidir: hissələr toplama
 * bərabərdir, saylar bir-birini keçmir, median yalnız cavablanmış sətirdən
 * gəlir. Sorğu pozulanda bunlardan biri mütləq sınır.
 *
 * Run: npm run smoke:sales
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

let failures = 0;
function check(ok: boolean, label: string, extra = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok    " : "PROBLEM"} ${label}${extra ? `  — ${extra}` : ""}`);
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const { computeSalesStatsWithoutAccessCheck, DAY_TYPES, lastDays } = await import("../src/lib/sales-stats");

  const started = Date.now();
  const stats = await computeSalesStatsWithoutAccessCheck(lastDays(30));
  const elapsed = Date.now() - started;

  console.log(`\n30 günlük statistika: ${stats.rows.length} satıcı, ${elapsed} ms\n`);
  check(stats.rows.length > 0, "ən azı bir satıcı sətri var", `${stats.rows.length} sətir`);
  check(elapsed < 15000, "30 günlük sorğu 15 saniyədən tezdir", `${elapsed} ms`);
  check(stats.range.toTs - stats.range.fromTs === 30 * 86400, "diapazon qaytarılır");

  for (const r of stats.rows) {
    const sum = DAY_TYPES.reduce((acc, d) => acc + r.byDayType[d].opportunities, 0);
    check(sum === r.total.opportunities,
      `${r.userName}: gün növləri cəmi ümumi ilə üst-üstə düşür`,
      `${sum} = ${r.total.opportunities}`);
    check(DAY_TYPES.every((d) => r.byDayType[d] !== undefined),
      `${r.userName}: hər üç gün növü var`);
    /* 100% cavabsız real biznes vəziyyəti deyil, sınmış sorğudur — bir dəfə
       məhz belə sındı: gözləmə hesabı cavab gəlmiş sətirlərə də tətbiq
       olunurdu və hər sətir cavabsız görünürdü. */
    check(r.total.opportunities < 20 || r.total.unanswered < r.total.opportunities,
      `${r.userName}: cavabsızlıq 100% deyil`,
      `${r.total.unanswered} / ${r.total.opportunities}`);
    check(r.total.unanswered <= r.total.opportunities,
      `${r.userName}: cavabsız sayı imkandan çox deyil`,
      `${r.total.unanswered} / ${r.total.opportunities}`);
    check(r.total.slaBreach <= r.total.slaMeasured,
      `${r.userName}: SLA pozuntusu ölçülənlərdən çox deyil`,
      `${r.total.slaBreach} / ${r.total.slaMeasured}`);
    check(r.total.slaMeasured + r.total.slaUncovered === r.total.opportunities,
      `${r.userName}: ölçülən + ölçülməyən = imkan`,
      `${r.total.slaMeasured} + ${r.total.slaUncovered} = ${r.total.opportunities}`);
    check(r.heat.every((c) => c.isoDow >= 1 && c.isoDow <= 7 && c.hour >= 0 && c.hour <= 23),
      `${r.userName}: xəritə xanaları sərhəd daxilindədir`);
    check(r.heat.length <= 7 * 24, `${r.userName}: xəritədə 168-dən çox xana yoxdur`,
      `${r.heat.length}`);
    check(r.heat.every((c) => c.responseMedianSeconds === null || c.opportunities > 0),
      `${r.userName}: median yalnız imkanı olan xanada var`);
    check(r.heat.reduce((a, c) => a + c.opportunities, 0) === r.total.opportunities,
      `${r.userName}: xəritədəki imkanlar cəmi ümumi ilə üst-üstə düşür`);
  }

  // Nömrəsi olmayan satıcı da sətir alır — gizlətmək "statistikası yaxşıdır"
  // kimi oxunardı.
  const { rows: noPhone } = await pool.query<{ n: string }>(
    `SELECT u.name AS n FROM katibe.users u
     JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
     WHERE NOT EXISTS (SELECT 1 FROM katibe.user_instances ui
                       WHERE ui.user_id = u.id AND ui.ended_at IS NULL)`,
  );
  for (const p of noPhone) {
    const row = stats.rows.find((r) => r.userName === p.n);
    check(row !== undefined && row.instanceId === null,
      `nömrəsiz satıcı sətri qalır: ${p.n}`);
  }

  // ——— Şəkillər və faktlar ———
  const { closedTotal, readSnapshots } = await import("../src/lib/sales-history");
  const snaps = await readSnapshots(12);
  console.log(`\nŞƏKİL: ${snaps.length} sətir`);
  check(snaps.length > 0, "həftəlik şəkil var");
  for (const s of snaps) {
    const d = s.payload.byDayType;
    const sum = d.week.opportunities + d.sat.opportunities + d.sun.opportunities;
    check(sum === s.payload.total.opportunities,
      `${s.periodStart} ${s.userName}: şəkildə gün növləri cəmi tutur`);
    check(s.opportunities === s.payload.total.opportunities,
      `${s.periodStart} ${s.userName}: sütun və payload eyni rəqəmi deyir`);
    check(s.payload.hours.length <= 24, `${s.periodStart} ${s.userName}: saat profili sərhəddədir`);

    /* Bayraq qrupları: heç bir bayraq üç xana arasında itməməlidir.
       `dismissed` çıxma ilə hesablanır (sales-history.ts), ona görə səhv
       qruplaşdırma özünü məhz burada — cəmin tutmaması kimi — göstərir. */
    const f = s.payload.flags;
    const byReasonSum = Object.values(f.byReason).reduce((n, v) => n + v, 0);
    check(closedTotal(f) === byReasonSum,
      `${s.periodStart} ${s.userName}: bayraq qrupları səbəb bölgüsü ilə tutur`,
      `${closedTotal(f)} = ${byReasonSum}`);
    check(f.resolved >= 0 && f.deferred >= 0 && f.dismissed >= 0,
      `${s.periodStart} ${s.userName}: heç bir qrup mənfi deyil`);
    /* Median həll olunanlar üzərindədir: həll yoxdursa rəqəm də olmamalıdır.
       Əks hal köhnə səhvin qayıtdığını bildirər — susdurulmuş bayraqdan
       hesablanmış «sürətli» median. */
    check(f.resolved > 0 || f.medianResolveSeconds === null,
      `${s.periodStart} ${s.userName}: həll yoxdursa median da yoxdur`,
      String(f.medianResolveSeconds));
  }

  /* Faktın altındakı quru rəqəm sətri boş qalmamalıdır: cümləni model yazır,
     rəqəmi kod verir və ikisi yan-yana olmasa uydurma tutula bilməz. */
  const { rows: insights } = await pool.query<{ basis: string; evidence: object; kind: string }>(
    `SELECT basis, evidence, kind FROM katibe.sales_insight
      WHERE period_start = (SELECT max(period_start) FROM katibe.sales_insight)`,
  );
  console.log(`\nFAKT: ${insights.length} sətir`);
  for (const i of insights) {
    check(i.basis.trim().length > 0, `${i.kind}: «nədən çıxdı» sətri var`);
    check(Object.keys(i.evidence ?? {}).length > 0, `${i.kind}: sübut JSON-u boş deyil`);
  }
  check(insights.length <= 8, "bir dövrdə 8-dən çox fakt yoxdur", `${insights.length}`);

  console.log(failures === 0 ? "\nNƏTİCƏ: keçdi." : `\nNƏTİCƏ: ${failures} PROBLEM.`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
