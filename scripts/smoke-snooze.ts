/**
 * Möhlətin məntiq qatı — susdurma, müddət, klapanlar və nəticə hesabatı.
 *
 * Ekran tərəfi ayrıca yoxlanır (smoke-snooze-screen.ts); burada sual budur ki,
 * düymə basılandan sonra bazada nə baş verir: bayraq həqiqətən gizlənirmi,
 * müddət Bakı vaxtı ilə səhər 09:00-da bitirmi, ciddiləşən problem möhləti
 * keçirmi, və müddət bitəndən sonra nəticə («davam edir» / «həll olundu») bir
 * dəfə yazılırmı.
 *
 * SONUNCU ƏN VACİBİDİR. Möhlətin bütün mənası bitişindədir: səssizcə bitən
 * möhlət «bir daha göstərmə»nin zəif variantıdır və heç kimə lazım deyil.
 *
 * Sintetik post və susdurma qurur, yoxlayır, sonra hamısını silir.
 *
 * Run: npm run smoke:snooze
 */
import { loadEnvLocal } from "../mcp/env";

// .env.local MÜTLƏQ db.ts-dən əvvəl yüklənməlidir — src/lib/db.ts modul
// səviyyəsində DATABASE_URL oxuyur, ona görə bütün importlar dinamikdir.
loadEnvLocal();

const AGENT = "nazaratchi";
const FLOW_JID = "smoke-snooze@s.whatsapp.net";
const GATE_JID = "smoke-gate@s.whatsapp.net";

let failures = 0;
function ok(label: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok    " : "PROBLEM"} ${label}${extra ? `  — ${extra}` : ""}`);
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const {
    escalatesPast,
    loadActiveSuppressions,
    loadPendingSnoozeOutcomes,
    markSnoozeBroken,
    snoozePost,
    suppressionFor,
  } = await import("../src/lib/supervisor/ratings");
  const { gateFindings } = await import("../src/lib/supervisor/gate");
  type Finding = import("../src/lib/supervisor/types").Finding;
  type ScopedInstanceId = import("../src/lib/access").ScopedInstanceId;

  // Sintetik bayraq üçün REAL instans və satıcı lazımdır: süzgəc və lent hər
  // ikisinə görə süzülür, uydurma ID ilə heç bir yol keçilməzdi.
  const { rows: sample } = await pool.query(
    `SELECT instance_id, user_id FROM katibe.agent_posts
      WHERE user_id IS NOT NULL AND kind = 'finding' ORDER BY id DESC LIMIT 1`,
  );
  if (sample.length === 0) throw new Error("nümunə post tapılmadı");
  const instanceId = sample[0].instance_id as ScopedInstanceId;
  const userId = sample[0].user_id;
  const { rows: run } = await pool.query(`SELECT id FROM katibe.agent_runs ORDER BY id DESC LIMIT 1`);
  const runId = Number(run[0].id);
  const { rows: admin } = await pool.query(`SELECT id FROM katibe.dashboard_users ORDER BY id LIMIT 1`);
  const adminId = Number(admin[0].id);

  const posts: number[] = [];
  const sups: number[] = [];
  const addPost = async (jid: string, severity: number) => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO katibe.agent_posts
         (run_id, agent, instance_id, user_id, remote_jid, detector, kind, severity,
          base_severity, verdict, title, body, evidence, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, 'unanswered', 'finding', $6, $6, 'INTERVENE',
               'SMOKE möhlət', 'sınaq gövdəsi', '{"lastInboundTs": 111}'::jsonb, $7)
       RETURNING id`,
      [runId, AGENT, instanceId, userId, jid, severity, `smoke-snooze:${Date.now()}:${jid}`],
    );
    posts.push(Number(rows[0].id));
    return Number(rows[0].id);
  };

  try {
    // ---- A. Axın: möhlət → müddət → nəticə -------------------------------
    const postId = await addPost(FLOW_JID, 7);

    console.log("\nA1) 3 günlük möhlət");
    const snoozed = await snoozePost(postId, 3, "çatdırılma cümə axşamı", adminId);
    ok("susdurma açıldı", snoozed.suppressionId !== null);
    ok("post bağlandı", snoozed.closed);
    const supId = snoozed.suppressionId!;
    sups.push(supId);
    const { rows: p1 } = await pool.query(
      `SELECT closed_reason, snooze_days, snoozed_until FROM katibe.agent_posts WHERE id = $1`,
      [postId],
    );
    ok("bağlanma səbəbi SNOOZED", p1[0].closed_reason === "SNOOZED", String(p1[0].closed_reason));
    ok("post 3 gün saxlayır", Number(p1[0].snooze_days) === 3);
    // Bitiş anı sualın yarısıdır: «hansı gün» kifayət etmir, «neçədə» də
    // hesablanır və səhv saat bayrağı gecə yarısı geri gətirərdi.
    ok(
      "bitiş Bakı vaxtı ilə 09:00",
      new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Baku", hour: "2-digit", minute: "2-digit" })
        .format(new Date(p1[0].snoozed_until)) === "09:00",
      new Date(p1[0].snoozed_until).toISOString(),
    );

    console.log("\nA2) müddət qüvvədə");
    const active = await loadActiveSuppressions(AGENT, instanceId);
    const finding: Finding = {
      detector: "unanswered", jid: FLOW_JID, contact: "SMOKE", baseSeverity: 7,
      title: "t", evidence: { lastInboundTs: 111 },
    };
    const sup = suppressionFor(active, finding);
    ok("susdurma tapıldı", sup !== null);
    ok("möhlət kimi oxunur", sup?.snoozeDays === 3, String(sup?.snoozeDays));
    ok("eyni balda klapan bağlıdır", sup !== null && !escalatesPast(finding, sup));
    ok("bal +2 olanda klapan açılır", sup !== null && escalatesPast({ ...finding, baseSeverity: 9 }, sup));
    const pending0 = await loadPendingSnoozeOutcomes(AGENT, instanceId);
    ok("müddət bitməmiş nəticə gözlənilmir", !pending0.has(`unanswered:${FLOW_JID}`));

    console.log("\nA3) müddət bitir");
    await pool.query(
      `UPDATE katibe.agent_suppressions SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [supId],
    );
    const after = await loadActiveSuppressions(AGENT, instanceId);
    ok("susdurma artıq qüvvədə deyil", suppressionFor(after, finding) === null);
    const { rows: log1 } = await pool.query(
      `SELECT outcome, reason FROM katibe.agent_suppression_log WHERE suppression_id = $1
       ORDER BY id DESC LIMIT 1`,
      [supId],
    );
    ok("jurnalda EXPIRED", log1[0]?.outcome === "EXPIRED", String(log1[0]?.reason));
    const pending = await loadPendingSnoozeOutcomes(AGENT, instanceId);
    const item = pending.get(`unanswered:${FLOW_JID}`);
    ok("nəticə gözləyənlər arasındadır", item !== undefined);
    ok("gün sayı saxlanıb", item?.days === 3);

    console.log("\nA4) bayraq qayıdır → möhlət pozuldu");
    await markSnoozeBroken(item!, runId, 8, { contact: "SMOKE" });
    const { rows: log2 } = await pool.query(
      `SELECT outcome, reason FROM katibe.agent_suppression_log WHERE suppression_id = $1
       ORDER BY id DESC LIMIT 1`,
      [supId],
    );
    ok("jurnalda SNOOZE_BROKEN", log2[0]?.outcome === "SNOOZE_BROKEN", String(log2[0]?.reason));
    // İkinci çağırış jurnalda ikinci sətir yaratmamalıdır: gedişat saatda bir
    // işləyir və eyni möhlət hər dəfə yenidən «pozuldu» kimi yazılsa, audit
    // səhifəsi bir bayrağın altında onlarla eyni sətir göstərərdi.
    await markSnoozeBroken(item!, runId, 8, { contact: "SMOKE" });
    const { rows: cnt } = await pool.query(
      `SELECT count(*) AS n FROM katibe.agent_suppression_log
        WHERE suppression_id = $1 AND outcome = 'SNOOZE_BROKEN'`,
      [supId],
    );
    ok("təkrar çağırış sətir yazmır", Number(cnt[0].n) === 1, `${cnt[0].n} sətir`);
    ok(
      "nəticə siyahısından çıxdı",
      !(await loadPendingSnoozeOutcomes(AGENT, instanceId)).has(`unanswered:${FLOW_JID}`),
    );

    console.log("\nA5) möhlət tutur (bayraq qayıtmır)");
    await pool.query(
      `UPDATE katibe.agent_suppressions
          SET snooze_reported_at = NULL, revoked_at = now() - interval '72 hours' WHERE id = $1`,
      [supId],
    );
    await loadPendingSnoozeOutcomes(AGENT, instanceId);
    const { rows: log3 } = await pool.query(
      `SELECT outcome, reason FROM katibe.agent_suppression_log WHERE suppression_id = $1
       ORDER BY id DESC LIMIT 1`,
      [supId],
    );
    ok("jurnalda SNOOZE_KEPT", log3[0]?.outcome === "SNOOZE_KEPT", String(log3[0]?.reason));

    console.log("\nA6) sərhədlər");
    ok("300 gün rədd olunur", (await snoozePost(postId, 300, null, adminId)).suppressionId === null);

    // ---- B. Süzgəc: gate.ts budaqları ------------------------------------
    const gatePostId = await addPost(GATE_JID, 6);
    const gateSnooze = await snoozePost(gatePostId, 2, null, adminId);
    const gateSupId = gateSnooze.suppressionId!;
    sups.push(gateSupId);
    const gateFinding: Finding = {
      detector: "unanswered", jid: GATE_JID, contact: "SMOKE", baseSeverity: 6,
      title: "SMOKE gate", evidence: { lastInboundTs: 222 },
    };
    const args = { agent: AGENT, instanceId, runId, dryRun: false, hints: null, maxCalls: 0 };

    console.log("\nB1) möhlət qüvvədə — süzgəc");
    const g1 = await gateFindings({ ...args, findings: [gateFinding] });
    ok("bayraq lentə çıxmır", g1.kept.length === 0, `${g1.kept.length} saxlanıldı`);
    ok("susdurulmuş sayılır", g1.suppressed === 1);
    // Möhlətdə modelə sual verilmir: cavab qərarı dəyişmir və hər gedişat pul
    // yandırardı — üstəlik menecerin öz verdiyi möhləti ləğv edərdi.
    ok("model çağırılmadı", g1.stats.llmCalls === 0);
    const { rows: gl } = await pool.query(
      `SELECT outcome, reason FROM katibe.agent_suppression_log WHERE suppression_id = $1
       ORDER BY id DESC LIMIT 1`,
      [gateSupId],
    );
    ok("jurnala möhlət sətri düşdü", gl[0]?.outcome === "SUPPRESSED", String(gl[0]?.reason));

    console.log("\nB2) eyni mesaj vəziyyətində jurnal şişmir");
    await gateFindings({ ...args, findings: [gateFinding] });
    const { rows: gc } = await pool.query(
      `SELECT count(*) AS n FROM katibe.agent_suppression_log WHERE suppression_id = $1`,
      [gateSupId],
    );
    ok("jurnalda bir sətir qaldı", Number(gc[0].n) === 1, `${gc[0].n} sətir`);

    console.log("\nB3) vəziyyət ciddiləşir (6 → 8)");
    const g2 = await gateFindings({ ...args, findings: [{ ...gateFinding, baseSeverity: 8 }] });
    ok("bayraq möhləti keçir", g2.kept.length === 1);
    ok("buraxılma sayılır", g2.released === 1);
    ok("nişan yoxdur — möhlət hələ bitməyib", g2.kept[0]?.afterSnooze === null);

    console.log("\nB4) müddət bitir, problem davam edir");
    await pool.query(
      `UPDATE katibe.agent_suppressions
          SET expires_at = now() - interval '1 minute', snooze_reported_at = NULL WHERE id = $1`,
      [gateSupId],
    );
    const g3 = await gateFindings({ ...args, findings: [gateFinding] });
    ok("bayraq lentə qayıdır", g3.kept.length === 1);
    ok("nişan qoyuldu", g3.kept[0]?.afterSnooze?.days === 2, String(g3.kept[0]?.afterSnooze?.days));

    console.log(`\n${failures === 0 ? "hamısı qaydasındadır." : `${failures} problem.`}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    for (const id of sups) {
      await pool.query(`DELETE FROM katibe.agent_suppression_log WHERE suppression_id = $1`, [id]);
      await pool.query(`DELETE FROM katibe.agent_suppressions WHERE id = $1`, [id]);
    }
    if (posts.length) {
      await pool.query(`DELETE FROM katibe.agent_posts WHERE id = ANY($1::bigint[])`, [posts]);
    }
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
