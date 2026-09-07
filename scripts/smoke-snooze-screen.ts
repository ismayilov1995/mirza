/**
 * Möhlət düyməsinin ekran yoxlaması.
 *
 * smoke-snooze axını (susdurma, müddət, nəticə) məntiq qatında yoxlanır; bu isə
 * ekranın özünü: düymə görünürmü, KİMƏ görünür, möhlət verilmiş sıra nə yazır
 * və möhlətdən sonra qayıdan bayraq nişanını daşıyırmı.
 *
 * İkinci sual birincidən vacibdir: möhlət ekrandan bayraq gizlədən qərardır və
 * yalnız admindədir. Nəzarətçi bayrağı bağlaya bilir (bağlanan geri qayıdır),
 * möhlət isə lenti günlərlə boş saxlayır.
 *
 * Müvəqqəti hesab və sintetik postlar qurur, yoxlayır, sonra hamısını silir.
 * Parol skriptin içində yaradılır və heç yerə çap olunmur.
 *
 * Run: npm run smoke:snooze:screen   (xidmət və ya `npm run dev` işləməlidir)
 */
import { randomBytes } from "node:crypto";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const BASE = process.env.VERIFY_BASE_URL || "http://127.0.0.1:3000";

let failures = 0;
function check(ok: boolean, label: string, extra = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok    " : "PROBLEM"} ${label}${extra ? `  — ${extra}` : ""}`);
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/password");
  const { snoozePost } = await import("../src/lib/supervisor/ratings");

  const made: { users: number[]; posts: number[]; suppressions: number[] } = {
    users: [], posts: [], suppressions: [],
  };

  const login = async (username: string, password: string) => {
    const res = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      redirect: "manual",
    });
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error(`giriş alınmadı: ${username} (${res.status})`);
    return cookie;
  };

  const makeUser = async (role: "admin" | "monitor") => {
    const username = `smoke-mohlet-${role}-${randomBytes(3).toString("hex")}`;
    const password = randomBytes(18).toString("base64url");
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO katibe.dashboard_users (username, password_hash, role, active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [username, await hashPassword(password), role],
    );
    made.users.push(Number(rows[0].id));
    return { id: Number(rows[0].id), username, password };
  };

  try {
    // Sintetik bayraqlar üçün real instans və satıcı lazımdır — lent onlara
    // görə süzülür, uydurma ID ilə sıra ümumiyyətlə görünməzdi.
    const { rows: sample } = await pool.query(
      `SELECT instance_id, user_id FROM katibe.agent_posts
        WHERE user_id IS NOT NULL AND kind = 'finding'
        ORDER BY id DESC LIMIT 1`,
    );
    if (sample.length === 0) throw new Error("nümunə post tapılmadı");
    const { instance_id: instanceId, user_id: userId } = sample[0];
    const { rows: run } = await pool.query(`SELECT id FROM katibe.agent_runs ORDER BY id DESC LIMIT 1`);
    const runId = Number(run[0].id);

    const addPost = async (title: string, jid: string, afterSnoozeDays: number | null) => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO katibe.agent_posts
           (run_id, agent, instance_id, user_id, remote_jid, detector, kind, severity,
            base_severity, verdict, title, body, evidence, dedupe_key, after_snooze_days)
         VALUES ($1, 'nazaratchi', $2, $3, $4, 'unanswered', 'finding', 7, 7, 'INTERVENE',
                 $5, 'sınaq gövdəsi', '{"lastInboundTs": 333}'::jsonb, $6, $7)
         RETURNING id`,
        [runId, instanceId, userId, jid, title, `smoke-screen:${randomBytes(4).toString("hex")}`, afterSnoozeDays],
      );
      made.posts.push(Number(rows[0].id));
      return Number(rows[0].id);
    };

    const admin = await makeUser("admin");
    const monitor = await makeUser("monitor");
    // Admin yalnız icazə verilmiş instansları görür.
    await pool.query(
      `INSERT INTO katibe.dashboard_user_instances (user_id, instance_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [admin.id, instanceId],
    );

    // Üç sıra, üç fərqli hal: adi açıq bayraq (düymə görünməlidir), möhlətdən
    // sonra qayıtmış bayraq (nişan daşımalıdır) və möhlət veriləcək olan.
    // İlk ikisinin ID-si lazım deyil — onlar mətn üzrə axtarılır.
    await addPost("SMOKE açıq bayraq", "smoke-open@s.whatsapp.net", null);
    await addPost("SMOKE qayıdan bayraq", "smoke-back@s.whatsapp.net", 3);
    const snoozeId = await addPost("SMOKE möhlətli bayraq", "smoke-snoozed@s.whatsapp.net", null);

    const adminCookie = await login(admin.username, admin.password);
    const monitorCookie = await login(monitor.username, monitor.password);
    const get = async (path: string, cookie: string) => {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
      return { status: res.status, html: await res.text() };
    };

    console.log("\n1) düymə admindədir");
    const a1 = await get("/agent", adminCookie);
    check(a1.status === 200, "/agent admin üçün açılır", String(a1.status));
    check(a1.html.includes("SMOKE açıq bayraq"), "sınaq bayrağı lentdədir");
    check(a1.html.includes("Möhlət ver"), "«Möhlət ver» düyməsi görünür");

    console.log("\n2) nəzarətçidə YOXDUR");
    const m1 = await get("/monitor/bayraqlar", monitorCookie);
    check(m1.status === 200, "/monitor/bayraqlar nəzarətçi üçün açılır", String(m1.status));
    check(!m1.html.includes("Möhlət ver"), "nəzarətçi möhlət verə bilmir");

    console.log("\n3) möhlətdən sonra qayıdan bayraq");
    check(
      a1.html.includes("3 gün möhlət verilmişdi"),
      "qayıdan sıra «möhlət verilmişdi» nişanı daşıyır",
    );
    check(a1.html.includes("problem davam edir"), "nişan nəticəni deyir");

    console.log("\n4) möhlət verilmiş sıra");
    const snoozed = await snoozePost(snoozeId, 2, "sınaq", admin.id);
    if (snoozed.suppressionId) made.suppressions.push(snoozed.suppressionId);
    check(snoozed.closed, "post bağlandı");
    const a2 = await get("/agent", adminCookie);
    // Bağlanmış sıra «Bağlananlar» cədvəlinə düşür və orada qısa format işlənir
    // («2 gün möhlət · 8 sen-dək») — sütun uzun cümləni tutmur.
    check(a2.html.includes("2 gün möhlət ·"), "cədvəldə müddət yazılır");
    check(/2 gün möhlət · [^<]*-dək/.test(a2.html), "cədvəldə bitmə tarixi var");
    check(a2.html.includes('data-how="SNOOZED"'), "möhlət öz bağlanma səbəbi ilə işarələnib");
    // Möhlət verilən sıra açıq lentdən çıxmalıdır. «Bağlananlar» başlığından
    // ƏVVƏLKİ hissəyə baxılır: adın ümumiyyətlə yox olmasını yoxlamaq səhv
    // olardı — o, elə bağlananlar cədvəlində görünməlidir.
    const openPart = a2.html.slice(0, a2.html.indexOf("Bağlananlar"));
    check(!openPart.includes("SMOKE möhlətli bayraq"), "sıra açıq lentdən çıxdı");

    console.log(`\n${failures === 0 ? "hamısı qaydasındadır." : `${failures} problem.`}`);
    if (failures > 0) process.exitCode = 1;
  } finally {
    for (const id of made.suppressions) {
      await pool.query(`DELETE FROM katibe.agent_suppression_log WHERE suppression_id = $1`, [id]);
      await pool.query(`DELETE FROM katibe.agent_suppressions WHERE id = $1`, [id]);
    }
    if (made.posts.length) {
      await pool.query(`DELETE FROM katibe.agent_posts WHERE id = ANY($1::bigint[])`, [made.posts]);
    }
    if (made.users.length) {
      await pool.query(`DELETE FROM katibe.dashboard_user_instances WHERE user_id = ANY($1::int[])`, [made.users]);
      await pool.query(`DELETE FROM katibe.dashboard_users WHERE id = ANY($1::int[])`, [made.users]);
    }
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
