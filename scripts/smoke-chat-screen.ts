/**
 * Ortaq söhbət ekranının uçdan-uca yoxlanışı.
 *
 * verify-access-control.ts "nə sızmır" sualına cavab verir; bu isə "nə
 * işləyir" sualına. İkisi ayrıdır, çünki tam bağlı bir ekran birinci
 * yoxlamadan qüsursuz keçər.
 *
 * Müvəqqəti hesab qurur, ona mövcud instansları verir, brauzerin getdiyi
 * yolla gedir (login → səhifə → API), sonra hesabı silir. Parol skriptin
 * içində yaradılır və heç yerə çap olunmur.
 *
 * Run: npm run smoke:chat
 */
import { randomBytes } from "node:crypto";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const BASE = process.env.VERIFY_BASE_URL || "http://127.0.0.1:3000";
const USER = `smoke-${randomBytes(4).toString("hex")}`;
const PASSWORD = randomBytes(18).toString("base64url");

let failures = 0;
function check(ok: boolean, label: string, extra = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok    " : "PROBLEM"} ${label}${extra ? `  — ${extra}` : ""}`);
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/password");

  const { rows: created } = await pool.query<{ id: number }>(
    `INSERT INTO katibe.dashboard_users (username, password_hash, role, active)
     VALUES ($1, $2, 'viewer', true) RETURNING id`,
    [USER, await hashPassword(PASSWORD)],
  );
  const userId = created[0].id;

  const cleanup = async () => {
    await pool.query(`DELETE FROM katibe.dashboard_users WHERE id = $1`, [userId]);
  };

  try {
    // Bütün instanslar və arxiv mənbəyi — ekranın dolu halını görmək üçün.
    await pool.query(
      `INSERT INTO katibe.dashboard_user_instances (user_id, instance_id)
       SELECT $1, s.id FROM katibe.source s WHERE s.kind = 'evolution'
       ON CONFLICT DO NOTHING`,
      [userId],
    );
    const { rows: owner } = await pool.query<{ owner_user_id: number }>(
      `SELECT owner_user_id FROM katibe.source
        WHERE kind = 'archive' AND owner_user_id IS NOT NULL LIMIT 1`,
    );
    if (owner.length > 0) {
      await pool.query(`UPDATE katibe.dashboard_users SET katibe_user_id = $2 WHERE id = $1`,
        [userId, owner[0].owner_user_id]);
    }

    const res = await fetch(`${BASE}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
      redirect: "manual",
    });
    const cookie = res.headers.getSetCookie()
      .find((c) => c.startsWith("katibe_session="))?.split(";")[0];
    if (!cookie) {
      console.error("Giriş alınmadı — yoxlama dayandı.");
      process.exitCode = 1;
      return;
    }
    const get = async (p: string) => {
      const r = await fetch(`${BASE}${p}`, { headers: { cookie }, redirect: "manual",
        signal: AbortSignal.timeout(30_000) });
      return { status: r.status, body: await r.text() };
    };

    console.log("EKRAN:");
    const page = await get("/arxiv");
    check(page.status === 200, "/arxiv açılır", `status ${page.status}`);
    check(page.body.includes("Söhbətlər"), "başlıq render olunur");
    check(page.body.includes("oxundu"), "yalnız-oxu izahı görünür");
    /* Arxiv nəzarət ekranı ilə eyni çərçivədədir: yan paneldə mənbə siyahısı,
       siyahının başında tablar. Biri yoxdursa iki ekran yenidən ayrılıb. */
    check(page.body.includes("Mənbə"), "yan paneldə mənbə siyahısı var");
    check(page.body.includes("Cavabsız") && page.body.includes("Bayraqlı"),
      "siyahı tabları render olunur");

    /*
     * Dörd iş ekranı EYNİ çərçivədədir: yan panel + başlıq. Biri köhnə
     * başlığa qayıdarsa, aşağıdakı yoxlama onu tutur — "İş" bölməsi yalnız
     * ortaq naviqasiyada var (WorkSidebar).
     */
    for (const [path, title] of [["/", "Nömrələr"], ["/agent", "Nəzarətçi"]] as const) {
      const p = await get(path);
      check(p.status === 200, `${path} açılır`, `status ${p.status}`);
      check(p.body.includes(title), `${path} başlığı render olunur`);
      check(p.body.includes("Yalnız oxu rejimi"), `${path} yan paneli var`);
      check(!p.body.includes("📋") && !p.body.includes("🕵️"),
        `${path} köhnə emoji başlığından təmizdir`);
    }

    console.log("\nMƏLUMAT:");
    const chats = await get("/api/sohbet/arxiv/chats");
    check(chats.status === 200, "söhbət siyahısı", `status ${chats.status}`);
    const list = JSON.parse(chats.body) as { chats: { id: number; title: string }[]; total: number };
    check(list.chats.length > 0, "söhbət qayıdır", `${list.total} söhbət`);

    const first = list.chats[0];
    const conv = await get(`/api/sohbet/arxiv/messages?chat=${first.id}&n=40`);
    check(conv.status === 200, "yazışma açılır", `status ${conv.status}`);
    const thread = JSON.parse(conv.body) as { messages: { id: number; ts: number }[] };
    check(thread.messages.length > 0, "mesajlar gəlir", `${thread.messages.length} mesaj`);

    // Təkrarlanma — çoxmənbəli mesajlar bir dəfə görünməlidir.
    const ids = thread.messages.map((m) => m.id);
    check(new Set(ids).size === ids.length, "mesajlar təkrarlanmır",
      `${ids.length} sətir, ${new Set(ids).size} fərqli`);
    // Sıralama — köhnədən yeniyə.
    const sorted = thread.messages.every((m, i, a) => i === 0 || a[i - 1].ts <= m.ts);
    check(sorted, "vaxt sırası düzgündür");

    /*
     * Lövbərli pəncərə — axtarış nəticəsindən mesaja tullanmağın arxa tərəfi.
     *
     * Yoxlanan şey «tapıntı pəncərənin İÇİNDƏDİR»: əvvəl yazışma həmişə
     * sondan oxunurdu, ona görə köhnə tapıntı gələn cavabda ümumiyyətlə
     * olmurdu və ekran sadəcə söhbəti açırdı.
     */
    console.log("\nLÖVBƏR:");
    const deep = await get(`/api/sohbet/arxiv/messages?chat=${first.id}&n=400`);
    const deepMsgs = (JSON.parse(deep.body) as { messages: { id: number; ts: number }[] }).messages;
    const oldest = deepMsgs[0];
    const anchored = await get(
      `/api/sohbet/arxiv/messages?chat=${first.id}&n=10&at=${oldest.id}&f=10`);
    check(anchored.status === 200, "lövbərli oxunuş cavab verir", `status ${anchored.status}`);
    const win = JSON.parse(anchored.body) as {
      messages: { id: number; ts: number }[]; more: boolean; moreNewer: boolean; anchored: boolean;
    };
    check(win.anchored, "lövbər tapıldı");
    check(win.messages.some((m) => m.id === oldest.id), "axtarılan mesaj pəncərədədir");
    check(win.messages.every((m, i, a) => i === 0 || a[i - 1].ts <= m.ts),
      "lövbərli pəncərə vaxt sırasındadır");
    check(deepMsgs.length > 20 ? win.moreNewer : true, "pəncərədən sonra davamı var");
    /* Tanınmayan lövbər ekranı sındırmamalıdır: yazışma adi qaydada açılır. */
    const badAnchor = await get(`/api/sohbet/arxiv/messages?chat=${first.id}&n=10&at=999999999`);
    check(badAnchor.status === 200, "tanınmayan lövbər 200 qaytarır", `status ${badAnchor.status}`);
    check(JSON.parse(badAnchor.body).anchored === false, "tanınmayan lövbər sonuncu mesajlara qayıdır");

    console.log("\nAXTARIŞ:");
    const search = await get("/api/sohbet/arxiv/search?q=" + encodeURIComponent('"invoice" OR sifariş'));
    check(search.status === 200, "axtarış işləyir", `status ${search.status}`);
    const hits = JSON.parse(search.body) as { hits: unknown[]; chats: number };
    check(hits.hits.length > 0, "axtarış nəticə qaytarır", `${hits.hits.length} nəticə`);

    console.log("\nYAZMA:");
    const star = await fetch(`${BASE}/api/sohbet/arxiv/star`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ messageId: thread.messages[0].id, on: true }),
    });
    check(star.status === 200, "ulduz qoyulur", `status ${star.status}`);
    const { rows: st } = await pool.query(
      `SELECT 1 FROM katibe.starred_message WHERE user_id = $1 AND message_id = $2`,
      [userId, thread.messages[0].id]);
    check(st.length === 1, "ulduz bazada saxlanılıb");

    const readTs = thread.messages[thread.messages.length - 1].ts;
    const read = await fetch(`${BASE}/api/sohbet/arxiv/read`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ chatId: first.id, ts: readTs }),
    });
    check(read.status === 200, "oxunma izi yazılır", `status ${read.status}`);
    const { rows: rm } = await pool.query<{ last_read_ts: number }>(
      `SELECT last_read_ts FROM katibe.read_marker WHERE user_id = $1 AND chat_id = $2`,
      [userId, first.id]);
    check(rm.length === 1 && Number(rm[0].last_read_ts) === readTs, "iz doğru vaxtdadır");

    // Geri getmir: köhnə damğa göndərilsə də iz yerində qalmalıdır.
    await fetch(`${BASE}/api/sohbet/arxiv/read`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ chatId: first.id, ts: readTs - 100_000 }),
    });
    const { rows: rm2 } = await pool.query<{ last_read_ts: number }>(
      `SELECT last_read_ts FROM katibe.read_marker WHERE user_id = $1 AND chat_id = $2`,
      [userId, first.id]);
    check(Number(rm2[0].last_read_ts) === readTs, "iz geri getmir");

    // Açılış izi: ekranda "baxılıb / baxılmayıb" məhz bundan gəlir.
    const { rows: op } = await pool.query<{ opened_at: string | null; opened_count: number }>(
      `SELECT opened_at, opened_count FROM katibe.read_marker
        WHERE user_id = $1 AND chat_id = $2`, [userId, first.id]);
    check(op[0].opened_at !== null, "açılış vaxtı yazılıb");
    check(Number(op[0].opened_count) === 2, "açılış sayı artır", `${op[0].opened_count}×`);
    const listAfter = await get("/api/sohbet/arxiv/chats");
    const seen = (JSON.parse(listAfter.body).chats as { id: number; openedAt: string | null }[])
      .find((c) => c.id === first.id);
    check(seen?.openedAt !== null && seen?.openedAt !== undefined,
      "siyahı açılış vəziyyətini qaytarır");
    const unopened = (JSON.parse(listAfter.body).chats as { openedAt: string | null }[])
      .filter((c) => c.openedAt === null).length;
    check(unopened > 0, "açılmamış söhbətlər ayırd edilir", `${unopened} açılmayıb`);

    /*
     * Tab süzgəcləri.
     *
     * «Cavabsız» sıraların HAMISI həqiqətən cavabsız olmalıdır — süzgəc
     * serverdədir və səhifələnmədən ƏVVƏL işləməlidir, yoxsa ikinci səhifə
     * süzülməmiş gələr və heç kim fərqinə varmaz.
     */
    console.log("\nTABLAR:");
    const awaiting = await get("/api/sohbet/arxiv/chats?tab=awaiting");
    check(awaiting.status === 200, "cavabsız tabı cavab verir", `status ${awaiting.status}`);
    const aw = JSON.parse(awaiting.body) as {
      chats: { id: number; awaiting: boolean }[]; total: number;
    };
    check(aw.chats.length > 0, "cavabsız tabı sıra qaytarır", `${aw.total} söhbət`);
    check(aw.chats.every((c) => c.awaiting === true),
      "cavabsız tabında yalnız cavabsızlar var",
      `${aw.chats.filter((c) => !c.awaiting).length} yad sıra`);
    check(aw.total < list.total, "cavabsız tabı siyahını daraldır",
      `${aw.total} / ${list.total}`);

    /*
     * İki oxunma siqnalı qarışdırılmamalıdır: biri satıcının telefonundakı
     * nişandır, digəri bu istifadəçinin paneldəki izi. Eyni sıra üçün ikisi
     * ayrı-ayrı sahələrdə gəlməlidir.
     */
    const sig = JSON.parse(listAfter.body).chats as
      { id: number; salesUnread: number; unread: number; openedAt: string | null }[];
    check(sig.every((c) => typeof c.salesUnread === "number" && c.salesUnread >= 0),
      "satıcı oxunmamışı hər sırada var");
    check(sig.some((c) => c.salesUnread > 0), "satıcı oxunmamışı sıfırdan böyük ola bilir",
      `${sig.filter((c) => c.salesUnread > 0).length} sırada var`);
    const opened = sig.find((c) => c.id === first.id);
    check(opened !== undefined && opened.unread === 0 && opened.openedAt !== null,
      "açılan söhbət bu istifadəçi üçün oxunmuş sayılır");
    check(sig.some((c) => c.salesUnread > 0 && c.openedAt === null),
      "iki siqnal bir-birindən asılı deyil",
      "satıcı açmayıb + nəzarətçi baxmayıb eyni sırada ola bilir");

    const flagged = await get("/api/sohbet/arxiv/chats?tab=flagged");
    check(flagged.status === 200, "bayraqlı tabı cavab verir", `status ${flagged.status}`);
    const fl = JSON.parse(flagged.body) as { total: number };
    check(fl.total <= list.total, "bayraqlı tabı siyahını genişləndirmir",
      `${fl.total} / ${list.total}`);

    // Tanınmayan tab boş ekran yox, tam siyahı verməlidir.
    const bogus = await get("/api/sohbet/arxiv/chats?tab=yoxdur");
    check(bogus.status === 200 && JSON.parse(bogus.body).total === list.total,
      "tanınmayan tab tam siyahıya düşür");

    // Zolaq süzgəci: tanınmayan ID boş nəticə verməlidir, xəta yox.
    const lane = await get("/api/sohbet/arxiv/chats?instance=yoxdur");
    check(lane.status === 200 && JSON.parse(lane.body).total === 0,
      "tanınmayan satıcı süzgəci boş nəticə verir");

    console.log("\nTEMA:");
    const themed = async (pref: string) => {
      const r = await fetch(`${BASE}/arxiv`, {
        headers: { cookie: `${cookie}; katibe_theme=${pref}` },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      return (await r.text()).match(/data-theme="([a-z]+)"/)?.[1] ?? "(yoxdur)";
    };
    check((await themed("light")) === "light", "işıqlı seçim serverdə tətbiq olunur");
    check((await themed("dark")) === "dark", "tünd seçim serverdə tətbiq olunur");
    // "Sistem" serverdə bilinmir; tündlə başlayır və <head>-dəki skript düzəldir.
    check((await themed("system")) === "dark", "sistem seçimi tündlə başlayır");
    check((await themed("zibil")) === "dark", "tanınmayan dəyər tündə düşür");
    check(page.body.includes("prefers-color-scheme: light"),
      "ilk boyanışdan əvvəlki skript var (yanıb-sönmə olmur)");
    check(page.body.includes('aria-label="Tema"'), "tema seçici ekrandadır");

    const home = await get("/");
    check(home.body.includes('aria-label="Tema"'), "köhnə ekranlarda da seçici var");

    console.log(failures === 0 ? "\nNƏTİCƏ: keçdi." : `\nNƏTİCƏ: ${failures} PROBLEM.`);
  } finally {
    await cleanup();
    await pool.end();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
