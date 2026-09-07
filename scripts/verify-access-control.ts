/**
 * Giriş nəzarətinin CANLI yoxlanışı — "sızma yoxdur" iddiasının empirik sübutu.
 *
 * Kompilyator markalı tiplərlə hər sorğunun icazədən keçdiyini sübut edir, amma
 * kompilyator SQL-in içini oxumur. Bu skript isə real HTTP üzərindən yoxlayır:
 * müvəqqəti bir viewer hesabı yaradır, ona YALNIZ bir nömrə verir, sonra
 * BAŞQA nömrənin real ID-ləri ilə hər giriş nöqtəsini döyür.
 *
 * İki tərəfli yoxlama qəsdəndir:
 *   - viewer üçün hər hədəf 403/404/boş olmalıdır;
 *   - admin üçün eyni hədəflər 200 olmalıdır.
 * İkincisi olmasa, hər şeyin sadəcə sınıq olduğu da "təhlükəsiz" görünərdi.
 *
 *   npx tsx scripts/verify-access-control.ts
 *     VERIFY_BASE_URL=http://127.0.0.1:3000   (default)
 *     VERIFY_KEEP=1                            test hesablarını silmə (debug)
 *
 * Yalnız oxuyur; yaratdığı yeganə şeylər müvəqqəti test hesablarıdır (bir
 * viewer, bir admin) və sonda hər ikisi silinir. Parollar təsadüfidir və heç
 * yerə çap olunmur.
 */
import { randomBytes } from "node:crypto";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const BASE = process.env.VERIFY_BASE_URL || "http://127.0.0.1:3000";
/**
 * SVG-ni mətndən çıxarır — yoxlama ikon koordinatlarını telefon saymasın.
 *
 * İki forma var: səhifədə adi `<svg>…</svg>`, RSC yükündə isə qaçırılmış
 * `\u003cpath d=\\"M16 10a2 2 0 0 1…\\"`. İkincisi ilk düzəlişdən sonra da
 * qalmışdı və «6 telefon nömrəsi» kimi görünürdü. `d` atributu yalnız SVG-də
 * olur, ona görə onun dəyərini bütövlükdə atmaq təhlükəsizdir.
 */
function stripSvg(html: string): string {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/d=\\?"[^"\\]*\\?"/g, " ")
    .replace(/viewBox=\\?"[^"\\]*\\?"/g, " ");
}

const TEST_USER = `verify-${randomBytes(4).toString("hex")}`;

interface Probe {
  name: string;
  path: string;
  /** Bu cavab məlumat sızdırırmı? Default: 200 = sızma. */
  leaks?: (status: number, body: string) => boolean;
  /**
   * Hədəf qorunan nömrənin özünə aiddir. Belə hədəf privat nömrə üçün ADMIN-ə
   * də bağlı olmalıdır — yoldan çıxarmaq olmaz, çünki bəzi yollar (məsələn
   * /api/media/<mesaj-id>) instans ID-sini daşımır.
   */
  targetsSecret?: boolean;
}

async function login(username: string, password: string): Promise<string | null> {
  const res = await fetch(`${BASE}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
    redirect: "manual",
  });
  if (!res.ok) return null;
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("katibe_session="));
  return cookie ? cookie.split(";")[0] : null;
}

async function probe(cookie: string, p: Probe): Promise<{ status: number; body: string }> {
  const res = await fetch(`${BASE}${p.path}`, {
    headers: { cookie },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text().catch(() => "");
  return { status: res.status, body: body.slice(0, 4000) };
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const { createAccount, setInstanceGrants } = await import("../src/lib/accounts");
  const { encodeChatId } = await import("../src/lib/monitor-token");

  // --- Hədəf məlumatı: qorunan nömrə (privat olan, yoxsa ilk) və icazəli nömrə
  const { rows: instances } = await pool.query<{ id: string; name: string; private: boolean }>(
    `SELECT i.id, i.name, COALESCE(ia.private, false) AS private
     FROM evolution_api."Instance" i
     LEFT JOIN katibe.instance_access ia ON ia.instance_id = i.id
     ORDER BY COALESCE(ia.private, false) DESC, i.name`,
  );
  if (instances.length < 2) {
    console.error("Yoxlama üçün ən azı 2 instans lazımdır.");
    await pool.end();
    process.exit(1);
  }
  const secret = instances[0];
  const allowedInst = instances[instances.length - 1];
  if (secret.id === allowedInst.id) {
    console.error("Qorunan və icazəli nömrə eyni çıxdı.");
    await pool.end();
    process.exit(1);
  }

  // Qorunan nömrədən real ID-lər — təxmini deyil, faktiki hədəflər.
  const { rows: msg } = await pool.query<{ id: string; jid: string }>(
    `SELECT id, key->>'remoteJid' AS jid FROM evolution_api."Message"
     WHERE "instanceId" = $1 ORDER BY "messageTimestamp" DESC LIMIT 1`,
    [secret.id],
  );
  const { rows: media } = await pool.query<{ id: string }>(
    `SELECT id FROM evolution_api."Message"
     WHERE "instanceId" = $1 AND "messageType" IN ('imageMessage','documentMessage','audioMessage','videoMessage')
     ORDER BY "messageTimestamp" DESC LIMIT 1`,
    [secret.id],
  );
  const { rows: summary } = await pool.query<{ id: string }>(
    `SELECT id FROM katibe.chat_summary WHERE instance_id = $1 ORDER BY id DESC LIMIT 1`,
    [secret.id],
  );

  const secretJid = msg[0]?.jid ?? "";
  const probes: Probe[] = [
    { name: "instans paneli", path: `/i/${secret.id}`, targetsSecret: true },
    { name: "chat base", path: `/i/${secret.id}/base`, targetsSecret: true },
    { name: "etiketlər", path: `/i/${secret.id}/labels`, targetsSecret: true },
    ...(secretJid
      ? [{ name: "söhbət transkripti", path: `/i/${secret.id}/chat/${encodeURIComponent(secretJid)}`, targetsSecret: true }]
      : []),
    ...(secretJid && summary[0]
      ? [
          {
            name: "tərcümə olunmuş analiz",
            path: `/i/${secret.id}/chat/${encodeURIComponent(secretJid)}?lang=en`,
            targetsSecret: true,
          },
        ]
      : []),
    ...(media[0] ? [{ name: "media faylı", path: `/api/media/${media[0].id}`, targetsSecret: true }] : []),
    // QR yalnız admin səlahiyyətidir, instans icazəsi deyil — ona görə
    // targetsSecret qoyulmur: admin onu görməlidir.
    { name: "instans statusu (QR)", path: `/api/instance/status?name=${encodeURIComponent(secret.name)}` },
    { name: "admin paneli", path: "/admin" },
    { name: "admin · hesablar", path: "/admin/accounts" },
    { name: "admin · kontaktlar", path: "/admin/contacts" },
    { name: "admin · SLA", path: "/admin/sla" },
    { name: "admin · təkliflər", path: "/admin/suggestions" },
    { name: "MCP parametrləri", path: "/settings/mcp" },
    {
      name: "canlı axın (öz nömrəsi deyil)",
      path: `/api/live?instanceId=${secret.id}`,
      targetsSecret: true,
    },
    {
      // Ana səhifə hər kəsə açıqdır — sızma qorunan nömrənin ID-sinin
      // görünməsidir, statusun özü yox.
      name: "ana səhifə (gizli nömrə görünür?)",
      path: "/",
      leaks: (status, body) => status === 200 && body.includes(secret.id),
    },
    {
      name: "Nəzarətçi lenti (gizli nömrə görünür?)",
      path: "/agent",
      leaks: (status, body) => status === 200 && body.includes(secret.id),
    },
  ];

  // --- Müvəqqəti viewer hesabı: yalnız icazəli nömrə
  const testPassword = randomBytes(18).toString("base64url");
  const testId = await createAccount({
    username: TEST_USER,
    email: null,
    password: testPassword,
    role: "viewer",
    mustChangePassword: false,
    createdBy: null,
  });
  await setInstanceGrants(testId, [allowedInst.id], null);

  // İkinci mərhələ üçün müvəqqəti admin. Parol soruşulmur və heç yerə çap
  // olunmur: skript CI-da da işləməlidir və sirr transkriptə düşməməlidir.
  const adminUser = `${TEST_USER}-admin`;
  const adminPassword = randomBytes(18).toString("base64url");
  const adminId = await createAccount({
    username: adminUser,
    email: null,
    password: adminPassword,
    role: "admin",
    mustChangePassword: false,
    createdBy: null,
  });

  // Üçüncü mərhələ: nəzarətçi. İcazəli nömrə ona da verilir — sual "nömrəyə
  // çıxışı varmı" deyil, "həmin nömrənin İÇİNDƏ nə görür" sualıdır.
  const monitorUser = `${TEST_USER}-monitor`;
  const monitorPassword = randomBytes(18).toString("base64url");
  const monitorId = await createAccount({
    username: monitorUser,
    email: null,
    password: monitorPassword,
    role: "monitor",
    mustChangePassword: false,
    createdBy: null,
  });
  await setInstanceGrants(monitorId, [allowedInst.id], null);

  const cleanup = async () => {
    if (process.env.VERIFY_KEEP === "1") {
      console.log(`\n(test hesabları saxlanıldı: ${TEST_USER}, ${adminUser}, ${monitorUser})`);
      return;
    }
    await pool.query(`DELETE FROM katibe.dashboard_users WHERE id = ANY($1::int[])`, [
      [testId, adminId, monitorId],
    ]);
  };

  try {
    console.log(`Qorunan nömrə : ${secret.name}${secret.private ? " (privat)" : ""}`);
    console.log(`İcazəli nömrə : ${allowedInst.name}`);
    console.log(`Test hesabı   : ${TEST_USER} (viewer)\n`);

    const viewerCookie = await login(TEST_USER, testPassword);
    if (!viewerCookie) {
      console.error("Test hesabı ilə giriş alınmadı — app işləyirmi?");
      await cleanup();
      await pool.end();
      process.exit(1);
    }

    // --- 1-ci mərhələ: viewer heç birinə çata bilməməlidir
    let failures = 0;
    console.log("VIEWER — hər hədəf bağlı olmalıdır:");
    for (const p of probes) {
      const { status, body } = await probe(viewerCookie, p);
      const leaked = p.leaks ? p.leaks(status, body) : status === 200;
      if (leaked) failures++;
      console.log(`  ${leaked ? "SIZMA " : "bağlı "} ${String(status).padEnd(3)} ${p.name}`);
    }

    // --- 2-ci mərhələ: admin çata bilməlidir (yoxlama fərq qoyurmu?)
    {
      const adminCookie = await login(adminUser, adminPassword);
      if (!adminCookie) {
        console.error("Admin girişi alınmadı — 2-ci mərhələ atlandı.");
        failures++;
      } else {
        console.log("\nADMIN — eyni hədəflər açıq olmalıdır:");
        for (const p of probes) {
          const { status } = await probe(adminCookie, p);
          // Privat nömrə admin üçün də bağlıdır — bu, gözlənilən davranışdır.
          const expectedClosed = secret.private && p.targetsSecret === true;
          const ok = expectedClosed ? status !== 200 : status === 200;
          if (!ok) failures++;
          console.log(
            `  ${ok ? "ok    " : "PROBLEM"} ${String(status).padEnd(3)} ${p.name}` +
              (expectedClosed ? "  (privat — bağlı olmalıdır)" : ""),
          );
        }
      }
    }

    // --- 3-cü mərhələ: nəzarətçi rolu
    {
      const monitorCookie = await login(monitorUser, monitorPassword);
      if (!monitorCookie) {
        console.error("Nəzarətçi girişi alınmadı — 3-cü mərhələ atlandı.");
        failures++;
      } else {
        console.log("\nNƏZARƏTÇİ — app-in qalan hissəsi bağlı olmalıdır:");
        for (const p of probes) {
          // Nəzarətçi üçün İCAZƏLİ nömrə də bağlıdır: onun yeganə yolu
          // /monitor-dur, /i/... deyil.
          const { status } = await probe(monitorCookie, p);
          const leaked = status === 200;
          if (leaked) failures++;
          console.log(`  ${leaked ? "SIZMA " : "bağlı "} ${String(status).padEnd(3)} ${p.name}`);
        }

        // Nəzarətçiyə İCAZƏLİ nömrədə görünməli/görünməməli olanlar.
        const windowStart = Math.floor(Date.now() / 1000) - 90 * 86_400;
        const pick = async (like: string) => {
          const { rows } = await pool.query<{ jid: string }>(
            `SELECT key->>'remoteJid' AS jid FROM evolution_api."Message"
             WHERE "instanceId" = $1 AND key->>'remoteJid' LIKE $2 AND "messageTimestamp" >= $3
             ORDER BY "messageTimestamp" DESC LIMIT 1`,
            [allowedInst.id, like, windowStart],
          );
          return rows[0]?.jid ?? null;
        };
        const groupJid = await pick("%@g.us");
        const directJid = await pick("%@s.whatsapp.net");

        const check = (ok: boolean, label: string, extra = "") => {
          if (!ok) failures++;
          console.log(`  ${ok ? "ok    " : "PROBLEM"} ${label}${extra ? ` — ${extra}` : ""}`);
        };

        // Bayraq ekranı nəzarətçiyə AÇIQDIR (tək icazəli qapı), amma orada
        // nömrə görünməməlidir. Ekran açıq olduğu üçün "bağlıdır" siyahısında
        // yoxlana bilmir — maskalamanın özü yoxlanılır, çünki sızıntı məhz
        // açıq səhifədə olur.
        console.log("\nNƏZARƏTÇİ — öz ekranları:");
        /* Yazışmalar ekranı da yoxlanılır, təkcə bayraqlar yox. Səbəb real
           hadisədir: qlobal başlıq requireSession() çağırırdı, o isə nəzarətçini
           /monitor-a yönləndirir — yəni /monitor öz-özünə yönləndirirdi və
           nəzarətçi hesabı ERR_TOO_MANY_REDIRECTS alırdı. Admin hesabında
           görünmürdü. Bu sətir həmin sinif səhvi tutur. */
        const chats = await probe(monitorCookie, { name: "monitor", path: "/monitor" });
        check(chats.status === 200, "yazışmalar ekranı açıqdır (yönləndirmə dövrəsi yoxdur)",
          `status ${chats.status}`);

        const flags = await probe(monitorCookie, {
          name: "flags",
          path: "/monitor/bayraqlar",
        });
        check(flags.status === 200, "bayraq ekranı açıqdır", `status ${flags.status}`);
        /*
         * Telefona bənzər ardıcıllıqlar — amma ikonların içindən yox.
         *
         * Lucide ikonları SVG yollarıdır və koordinatları rəqəmdir:
         * `d="M12 2a5 5 0 0 1 10 0"` bu şablona telefon kimi düşürdü. Beş belə
         * «nömrə» hesabatda görünürdü və HƏQİQİ sızmanı (bağlananlar
         * cədvəlindəki xam kontakt nömrələri) onların arasında itirirdi.
         * Yalan siqnal həqiqi siqnalı yeyir, ona görə əvvəlcə SVG-lər atılır.
         *
         * Hədd də 9 rəqəmə qaldırıldı: yığıla bilən ən qısa beynəlxalq nömrə
         * o qədərdir və `yığıla bilən nömrə qalmayıb` yoxlaması ilə eynidir.
         */
        const flagsText = stripSvg(flags.body);
        const phoneish = /(?:^|[^\d])(\d[\d\s().-]{5,}\d)(?:[^\d]|$)/g;
        const leaked = [...flagsText.matchAll(phoneish)]
          .map((m) => m[1].replace(/\D/g, ""))
          .filter((d) => d.length >= 9 && d.length <= 15);
        check(leaked.length === 0, "bayraq ekranında telefon nömrəsi yoxdur",
          leaked.length ? `${leaked.length} ədəd, məs. ${leaked[0].slice(0, 4)}…` : "");
        check(!/@s\.whatsapp\.net|@lid/.test(flags.body),
          "bayraq ekranında xam JID yoxdur");

        console.log("\nNƏZARƏTÇİ — söhbət səviyyəsində süzgəc:");

        const own = await probe(monitorCookie, {
          name: "own",
          path: `/api/monitor/chats?instanceId=${allowedInst.id}`,
        });
        check(own.status === 200, "öz nömrəsinin söhbət siyahısı açıqdır", `status ${own.status}`);

        const foreign = await probe(monitorCookie, {
          name: "foreign",
          path: `/api/monitor/chats?instanceId=${secret.id}`,
        });
        check(foreign.status !== 200, "başqa nömrənin siyahısı bağlıdır", `status ${foreign.status}`);

        if (groupJid) {
          // Siyahıda xam JID yox, opaq token olur — yoxlama da token üzərindən
          // olmalıdır, yoxsa "JID yoxdur" həmişə doğru çıxar və heç nə yoxlamaz.
          const groupToken = encodeChatId(allowedInst.id, groupJid);
          check(!own.body.includes(groupToken), "qrup siyahıda görünmür (default gizli)");
          check(!own.body.includes(groupJid), "siyahıda xam JID yoxdur");
          const g = await probe(monitorCookie, {
            name: "group",
            path: `/api/monitor/messages?instanceId=${allowedInst.id}&chat=${encodeURIComponent(groupToken)}`,
          });
          check(g.status !== 200, "gizli qrupun yazışması bağlıdır", `status ${g.status}`);
        } else {
          console.log("  (bu nömrədə pəncərə daxilində qrup yoxdur — atlandı)");
        }

        if (directJid) {
          const directToken = encodeChatId(allowedInst.id, directJid);
          const d = await probe(monitorCookie, {
            name: "direct",
            path: `/api/monitor/messages?instanceId=${allowedInst.id}&chat=${encodeURIComponent(directToken)}`,
          });
          check(d.status === 200, "fərdi söhbət açıqdır (default görünür)", `status ${d.status}`);

          // Nömrə maskalanmalıdır: xam rəqəmlər cavabda görünməməlidir.
          const digits = directJid.split("@")[0];
          check(
            digits.length < 9 || !d.body.includes(digits),
            "cavabda xam telefon nömrəsi yoxdur",
          );

          // Söhbət qaydası tətbiq olunanda dərhal bağlanmalıdır.
          await pool.query(
            `INSERT INTO katibe.monitor_chat_rule (user_id, remote_jid, visibility)
             VALUES ($1, $2, 'deny')
             ON CONFLICT (user_id, remote_jid) DO UPDATE SET visibility = 'deny'`,
            [monitorId, directJid],
          );
          const denied = await probe(monitorCookie, {
            name: "denied",
            path: `/api/monitor/messages?instanceId=${allowedInst.id}&chat=${encodeURIComponent(directToken)}`,
          });
          check(denied.status !== 200, "gizlədilən söhbət dərhal bağlanır", `status ${denied.status}`);

          const crossToken = encodeChatId(secret.id, directJid);
          const cross = await probe(monitorCookie, {
            name: "cross",
            path: `/api/monitor/messages?instanceId=${allowedInst.id}&chat=${encodeURIComponent(crossToken)}`,
          });
          check(cross.status !== 200, "başqa nömrənin tokeni açılmır", `status ${cross.status}`);
        } else {
          console.log("  (bu nömrədə pəncərə daxilində fərdi söhbət yoxdur — atlandı)");
        }
      }
    }

    // --- 4-cü mərhələ: ortaq söhbət ekranının arxa tərəfi (/api/sohbet/*)
    //
    // Yeni səth, yeni yoxlama. Ekranın özü paylaşılan olduğu üçün icazənin
    // yalnız marşrutda yaşadığını sübut etmək lazımdır: eyni komponent iki
    // fərqli cavab almalıdır, çünki iki fərqli qapıdan keçir.
    {
      const monitorCookie = await login(monitorUser, monitorPassword);
      const viewerCookie2 = await login(TEST_USER, testPassword);
      if (monitorCookie && viewerCookie2) {
        console.log("\nORTAQ EKRAN — /api/sohbet:");
        const check = (ok: boolean, label: string, extra = "") => {
          if (!ok) failures++;
          console.log(`  ${ok ? "ok    " : "PROBLEM"} ${label}${extra ? `  — ${extra}` : ""}`);
        };

        // Nəzarətçi arxiv səthinə çıxa bilməməlidir: orada requireSession()
        // işləyir və o, nəzarətçini /monitor-a atır.
        const arch = await probe(monitorCookie, { name: "arxiv", path: "/api/sohbet/arxiv/chats" });
        check(arch.status !== 200, "nəzarətçi arxiv səthini aça bilmir", `status ${arch.status}`);

        // Öz səthi isə açıq olmalıdır, yoxsa yoxlama heç nə sübut etmir.
        const own = await probe(monitorCookie, { name: "nezaret", path: "/api/sohbet/nezaret/chats" });
        check(own.status === 200, "nəzarətçi öz səthini aça bilir", `status ${own.status}`);

        // Ən vacibi: maskalanmış səthdən xam nömrə çıxmamalıdır. JID
        // formatının özü (…@s.whatsapp.net) telefon nömrəsidir.
        check(
          !/\d{7,}@s\.whatsapp\.net/.test(own.body) && !/"\+?\d{9,}"/.test(own.body),
          "nəzarətçinin cavabında xam nömrə yoxdur",
        );
        /* Maska formatı "+994 50 *** ** 75"-dir: ölkə kodu və son iki rəqəm
           qalır ki, nəzarətçi iki müştərini ayırd edə bilsin, ortası isə
           yoxdur — yəni nömrə yığıla bilməz. Əvvəlki daha sərt forma ("•••75")
           heç nə qazandırmırdı, çünki o da yığıla bilmirdi, amma tanınmırdı da.

           Şərt İKİ QOLLUDUR və qəsdən belədir: ya maska görünür, ya da
           cavabda ümumiyyətlə yığıla bilən rəqəm ardıcıllığı yoxdur. Əvvəl
           yalnız birinci qol vardı və yoxlama MƏLUMATDAN asılı idi — həmin
           nömrənin bütün söhbətlərinin adı kontakt adıdırsa, maskalanacaq
           nömrə olmur və yoxlama heç bir sızma olmadan "PROBLEM" verirdi.
           Yalan siqnal isə həqiqi siqnalı yeyir. Təhlükəsizlik iddiası
           zəifləmir: xam nömrə çıxan kimi ikinci qol pozulur. */
        const maskSeen = /\*\*\* \*\* \d\d/.test(own.body);
        /* Yalnız MƏTN sahələrinə baxılır. İlk variant bütün gövdəni tarayırdı
           və "ts":1788157734 kimi unix damğalarını telefon sandı — yoxlamanın
           özü yalan həyəcan verirsə, növbəti dəfə ona inanılmır. */
        const dialable = [...own.body.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
          .flatMap((m) => m[1].match(/\+?\d[\d\s\-().]{7,13}\d/g) ?? [])
          .filter((t) => {
            const d = t.replace(/\D/g, "");
            return d.length >= 9 && d.length <= 15;
          });
        check(maskSeen || dialable.length === 0,
          "nömrələr maskalanıb (+994 50 *** ** 75 formatı)",
          maskSeen ? "" : "maskalanacaq nömrəli başlıq yoxdur");
        check(dialable.length === 0, "yığıla bilən nömrə qalmayıb",
          dialable.length > 0 ? dialable.slice(0, 2).join(", ") : "");

        // Uydurulmuş səth adı heç bir məlumat verməməlidir.
        const bogus = await probe(viewerCookie2, { name: "uydurma", path: "/api/sohbet/filan/chats" });
        check(bogus.status !== 200, "tanınmayan səth bağlıdır", `status ${bogus.status}`);

        // Nəzarətçi tarixçə pəncərəsindən kənara çıxa bilməməlidir.
        const old = await probe(monitorCookie, {
          name: "köhnə",
          path: "/api/sohbet/nezaret/search?q=&from=2017-01-01&kinds=text",
        });
        if (old.status === 200) {
          /* Gövdə kəsilmiş ola bilər (probe onu 4000 simvolda saxlayır), ona
             görə JSON.parse yox, damğaları birbaşa çıxarırıq — yoxlanan şey
             onsuz da bir ədəddir, quruluş deyil. */
          const stamps = [...old.body.matchAll(/"ts":(\d+)/g)].map((m) => Number(m[1]));
          const floor = Math.floor(Date.now() / 1000) - 400 * 86_400;
          const oldest = stamps.length > 0 ? Math.min(...stamps) : Math.floor(Date.now() / 1000);
          check(oldest > floor, "pəncərədən kənar mesaj qaytarılmır",
            `ən köhnə ${new Date(oldest * 1000).toISOString().slice(0, 10)}, ${stamps.length} damğa`);
        }
      }
    }

    console.log(
      failures === 0
        ? "\nNƏTİCƏ: keçdi — heç bir hədəf sızmadı."
        : `\nNƏTİCƏ: ${failures} PROBLEM tapıldı.`,
    );
    await cleanup();
    await pool.end();
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    await cleanup();
    await pool.end();
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
