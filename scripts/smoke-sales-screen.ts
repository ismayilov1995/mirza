/**
 * /admin/satis ekranının uçdan-uca yoxlanışı.
 *
 * smoke-sales-stats.ts rəqəmlərin öz-özü ilə ziddiyyətə düşmədiyini yoxlayır;
 * bu isə ekranın açıldığını VƏ bağlı olduğunu. İkincisi birincisindən vacibdir:
 * ekran satıcıları yan-yana qoyur, ona görə viewer üçün 403 olmalıdır — açıq
 * qalsa, səhifə qüsursuz işləyər və sadəcə başqasının rəqəmini göstərər.
 *
 * İki müvəqqəti hesab qurur (admin + viewer), yoxlayır, sonra silir. Parol
 * skriptin içində yaradılır və heç yerə çap olunmur.
 *
 * Run: npm run smoke:sales:screen   (əvvəldən `npm run dev` işləməlidir)
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

  const accounts: { id: number; username: string; password: string; role: string }[] = [];
  const make = async (role: "admin" | "viewer") => {
    const username = `smoke-satis-${role}-${randomBytes(3).toString("hex")}`;
    const password = randomBytes(18).toString("base64url");
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO katibe.dashboard_users (username, password_hash, role, active)
       VALUES ($1, $2, $3, true) RETURNING id`,
      [username, await hashPassword(password), role],
    );
    accounts.push({ id: rows[0].id, username, password, role });
    return { username, password };
  };

  const login = async (username: string, password: string): Promise<string | null> => {
    const res = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      redirect: "manual",
    });
    return res.headers.getSetCookie()
      .find((c) => c.startsWith("katibe_session="))?.split(";")[0] ?? null;
  };

  const get = async (path: string, cookie: string) => {
    const r = await fetch(`${BASE}${path}`, {
      headers: { cookie }, redirect: "manual", signal: AbortSignal.timeout(60_000),
    });
    return { status: r.status, body: await r.text() };
  };

  try {
    const adminAcc = await make("admin");
    const viewerAcc = await make("viewer");
    const adminCookie = await login(adminAcc.username, adminAcc.password);
    const viewerCookie = await login(viewerAcc.username, viewerAcc.password);
    if (!adminCookie || !viewerCookie) {
      console.error("Giriş alınmadı — yoxlama dayandı.");
      failures++;
      return;
    }

    const { rows: sales } = await pool.query<{ name: string }>(
      `SELECT u.name FROM katibe.users u
       JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'`,
    );

    console.log("\nEKRAN:");
    const page = await get("/admin/satis", adminCookie);
    check(page.status === 200, "admin ekranı aça bilir", `status ${page.status}`);
    check(page.body.includes("Satıcılar"), "ekranın adı yerindədir");
    check(page.body.includes("Müqayisə"), "müqayisə cədvəli render olunur");
    check(page.body.includes("Gün × saat"), "istilik xəritəsi render olunur");
    check(page.body.includes("Gün növünə görə"), "gün növü paneli render olunur");
    check(page.body.includes("Şənbə") && page.body.includes("Bazar"),
      "şənbə və bazar ayrı sütundur");
    for (const s of sales) {
      check(page.body.includes(s.name), `cədvəldə ${s.name} sətri var`);
    }
    check(page.body.includes("Nömrə təyin olunmayıb") || sales.length === 0,
      "nömrəsiz satıcı sətri izahla qalır");

    check(page.body.includes("Cavab borcu"), "sütun adları jarqondan təmizdir");
    check(page.body.includes("Bu rəqəmlər nə deməkdir"), "izah bölməsi var");
    check(page.body.includes("Nə görünür"), "faktlar paneli var");

    console.log("\nDİL:");
    const ru = await get("/admin/satis?lang=ru", adminCookie);
    check(ru.status === 200 && ru.body.includes("Продавцы"), "rus dili işləyir");
    check(ru.body.includes("Ждут ответа"), "rus dilində sütun adı tərcümə olunub");
    const en = await get("/admin/satis?lang=en", adminCookie);
    check(en.status === 200 && en.body.includes("Salespeople"), "ingilis dili işləyir");
    const badLang = await get("/admin/satis?lang=zz", adminCookie);
    check(badLang.status === 200 && badLang.body.includes("Satıcılar"),
      "tanınmayan dil AZ-yə düşür");
    // Dil də süzgəcdir: başqa süzgəc dəyişəndə itməməlidir.
    check(ru.body.includes("lang=ru") && ru.body.includes("m=volume"),
      "dil seçimi digər süzgəc linklərində qalır");

    console.log("\nİCAZƏ:");
    const viewer = await get("/admin/satis", viewerCookie);
    check(viewer.status === 403, "viewer 403 alır", `status ${viewer.status}`);
    const anon = await fetch(`${BASE}/admin/satis`, { redirect: "manual" });
    check(anon.status === 307 || anon.status === 302,
      "girişsiz istifadəçi /login-ə yönlənir", `status ${anon.status}`);

    console.log("\nSÜZGƏC:");
    const wide = await get("/admin/satis?d=90", adminCookie);
    check(wide.status === 200 && wide.body.includes("son 90 gün"),
      "90 günlük pəncərə seçilə bilir");
    const junk = await get("/admin/satis?d=zibil", adminCookie);
    check(junk.status === 200 && junk.body.includes("son 30 gün"),
      "tanınmayan pəncərə 30-a düşür");
    const volume = await get("/admin/satis?d=30&m=volume", adminCookie);
    check(volume.status === 200 && volume.body.includes("yazılan cavabların sayı"),
      "həcm rejimi işləyir");
    // Bir süzgəc dəyişəndə digəri itməməlidir (docs/rules.md §8).
    check(volume.body.includes("m=speed") && volume.body.includes("d=30"),
      "rejim linki pəncərəni saxlayır");
  } finally {
    for (const a of accounts) {
      await pool.query(`DELETE FROM katibe.dashboard_users WHERE id = $1`, [a.id]);
    }
    console.log(failures === 0 ? "\nNƏTİCƏ: keçdi." : `\nNƏTİCƏ: ${failures} PROBLEM.`);
    await pool.end();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
