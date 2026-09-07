/**
 * İnstansın sağ olub-olmadığını yoxlayır və ölübsə lentə bayraq qaldırır.
 *
 * Niyə var: 2026-08-25-də Rouz və Rouz-2 saat 14:18-də (UTC) sessiyanı itirdi,
 * 14:41-də Evolution QR limitini doldurub daha cəhd etməyi dayandırdı — və
 * DÖRD SAAT heç kim bilmədi. Nəzarətçi bu müddətdə donmuş məlumat üzərində
 * işləməyə davam etdi: satıcı telefonundan cavab yazsa da baza görmür, ona
 * görə açıq bayraq bağlana bilmir və "cavabsız" kimi qırmızı qalır. Yəni ölü
 * instans yalnız susmur, həm də YALAN bayraq istehsal edir.
 *
 * Üç yoxlama, qəsdən fərqli sərtlikdə:
 *
 *   DOWN   — connectionStatus 'open' deyil VƏ nömrə nə vaxtsa qoşulub.
 *            Deterministikdir, yalan siqnal verə bilmir, və bugünkü hadisəni
 *            məhz bu tutardı.
 *   YARIMÇIQ — instans yaradılıb, amma QR heç vaxt oxudulmayıb (ownerJid
 *            boşdur). Bu, QOPMA DEYİL: qopmayan şey qopa bilməz, bura nə mesaj
 *            gəlib, nə də gələcək. LENTƏ HEÇ NƏ YAZILMIR — yalnız jurnala.
 *            Əvvəl ikisi eyni sayılırdı və «Murad» sınaq nömrəsi günlərlə
 *            9 ballıq «qopub» kimi durdu; sonra ayrıca aşağı bala salındı, o da
 *            hər saat təkrarlandı və eyni işi gördü. Yalan və ya təkrarlanan
 *            bayraq həqiqi bayrağı yeyir, ona görə indi bayraq yoxdur.
 *   SUSQUN — status 'open' yazır, amma İŞ SAATLARINDA saatlarla mesaj yoxdur.
 *            Bu, statusun özünün yalan danışdığı hala qarşıdır: monitor
 *            `no.connection`-da vəziyyəti YALNIZ YADDAŞDA 'close' edir,
 *            bazadakı sətrə toxunmur (monitor.service.ts), yəni bazadakı
 *            status prinsipcə köhnə qala bilər.
 *
 * SUSQUN yalnız iş saatlarında baxılır — gecə sakitliyi nasazlıq deyil.
 *
 * Postlar lentə Nəzarətçi ilə eyni agent altında düşür ki, eyni yerdə
 * görünsün, amma detector 'instance_health'-dir və autoCloseMissing onu
 * QƏSDƏN kənarda saxlayır (persist.ts): bu postu yalnız bu skript bağlaya
 * bilər — instans doğrudan qayıdanda.
 *
 * Bu post həm də lentdə görünən YEGANƏ postdur, o nömrə qopuq ikən: qalanları
 * feed.ts gizlədir, çünki donmuş baza üzərində hesablanmış vaxtlar yalan olur.
 *
 * WhatsApp-a qarşı ancaq oxuyur.
 *
 * Əl ilə:  npm run check:health
 *   HEALTH_DRY_RUN=1        nə yazacağını göstər, HEÇ NƏ yazma
 *   HEALTH_SILENT_HOURS=3   "susqun" həddi (default 3 saat)
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const DRY_RUN = process.env.HEALTH_DRY_RUN === "1";
const SILENT_HOURS = Number(process.env.HEALTH_SILENT_HOURS ?? 3);
const AGENT = "nazaratchi";
const DETECTOR = "instance_health";
const TZ = "Asia/Baku";
const BUSINESS_START = 9;
const BUSINESS_END = 19;

/** Bakı vaxtı ilə iş saatındayıqmı (B.e–Şənbə, 09–19). */
function inBusinessHours(now: Date): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  if (weekday === "Sun") return false;
  return hour >= BUSINESS_START && hour < BUSINESS_END;
}

function formatAge(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m} dəq`;
  return `${h} saat ${m} dəq`;
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const { createRun, finishRun, upsertPost, dedupeKeyFor } = await import("../src/lib/supervisor/persist");
  const { syncConnectivity } = await import("../src/lib/supervisor/connectivity");

  // Qopma və qayıdış anı burada da qeydə alınır (saatın 25-i), gedişatda da
  // (05-i) — beləcə nə qopmanın başlanğıcı, nə də qayıdış nişanı yarım saatdan
  // artıq gecikir. Nişanı görən gedişat bayraqları qopma anından yenidən
  // yoxlayır (src/lib/supervisor/connectivity.ts).
  if (!DRY_RUN) await syncConnectivity();

  // Bütün instanslar — yalnız Sales olanlar yox. principal Production-dur,
  // amma onun da ölməsi bilinməlidir.
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i."connectionStatus" AS status,
            -- Bir dəfə də olsun qoşulubsa, WhatsApp öz JID-ini yazıb və o
            -- sətirdə qalır. Yəni "heç vaxt qoşulmayıb" sualının cavabı
            -- statusda yox, buradadır: 'connecting' həm təzə yaradılmış, həm
            -- də sessiyasını itirmiş instansın statusudur.
            i."ownerJid" IS NOT NULL AS paired,
            i."createdAt" AS created_at,
            ui.user_id,
            (SELECT MAX(m."messageTimestamp") FROM evolution_api."Message" m
              WHERE m."instanceId" = i.id) AS last_ts
     FROM evolution_api."Instance" i
     LEFT JOIN katibe.user_instances ui ON ui.instance_id = i.id AND ui.ended_at IS NULL
     ORDER BY i.name`,
  );

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const business = inBusinessHours(now);

  interface Problem {
    id: string;
    name: string;
    userId: number | null;
    severity: number;
    title: string;
    body: string;
    evidence: Record<string, unknown>;
  }
  const problems: Problem[] = [];
  const healthy: string[] = [];
  /** Təzə yaradılıb, QR-ı hələ gözləyən nömrələr — problem deyil, jurnal üçün. */
  const pairing: string[] = [];

  for (const r of rows) {
    const lastTs = r.last_ts === null ? null : Number(r.last_ts);
    const silentFor = lastTs === null ? null : nowSec - lastTs;

    // Heç vaxt qoşulmamış instans: yarımçıq qalmış QR. Bayraq QALDIRILMIR.
    //
    // Əvvəl altı saatdan sonra "məlumat" zolağında post açılırdı. Nəticə:
    // yaradılıb unudulmuş bir nömrə lentdə HƏR SAAT eyni sətri yazdı və
    // bayraq günlərlə orada qaldı. Bu, lentin dəyərini yeyir — hər saat
    // təkrarlanan bir şeyə adam beş dəfədən sonra baxmır, sonra da yanındakı
    // ƏSL bayrağa baxmır.
    //
    // Qopmayan şey qopa bilməz: bura nə mesaj gəlib, nə də gələcək, ona görə
    // itirilən məlumat yoxdur. Yarımçıq iş jurnalda görünür (aşağıda), lentdə
    // yox. Nömrə lazımdırsa QR oxudulur, lazım deyilsə /admin-dən silinir.
    if (!r.paired) {
      const ageHours = (now.getTime() - new Date(r.created_at).getTime()) / 3_600_000;
      pairing.push(`${r.name} (${formatAge(ageHours * 3600)})`);
      continue;
    }

    if (r.status !== "open") {
      // Sahibi olan nömrənin qopması ən yüksək deterministik baldır: arxasında
      // canlı müştəri yazışması var və hər dəqiqə itən mesaj deməkdir. Sahibsiz
      // qoşulu nömrə də bilinməlidir, amma o, kiminsə növbəsini dayandırmır.
      const assigned = r.user_id !== null;
      const downFor = silentFor !== null ? formatAge(silentFor) : null;
      problems.push({
        id: r.id,
        name: r.name,
        userId: r.user_id ?? null,
        severity: assigned ? 9 : 6,
        // Müddət başlıqdadır: qopma davam etdikcə hər saat yenilənən sətir
        // lentdə "hələ də qopuqdur" deyir, susmuş bir bayraq yox.
        title: assigned
          ? `${r.name} WhatsApp-dan qopub (${r.status})` +
            (downFor ? ` — ${downFor}-dir mesaj gəlmir` : "")
          : `${r.name} qopub (${r.status}) — bu nömrə heç kimə bağlı deyil`,
        body:
          `Instansın vəziyyəti "${r.status}"dır, "open" deyil` +
          (downFor ? `, son mesaj ${downFor} əvvəl gəlib` : "") +
          `. Bu nömrə üzrə nə yeni mesaj gəlir, nə də satıcının cavabı bazaya düşür, ` +
          `ona görə həmin nömrənin qalan bayraqları lentdə müvəqqəti gizlədilib — ` +
          `göstərdikləri vaxt artıq doğru olmazdı. Nömrə qoşulan kimi hamısı qopma ` +
          `anından etibarən yenidən yoxlanılır. Sessiya bərpa olunmursa QR yenidən ` +
          `oxudulmalıdır.` +
          (assigned
            ? ``
            : ` Bu nömrə bir dəfə qoşulub, amma heç bir istifadəçiyə bağlı deyil — ` +
              `ona görə bal aşağıdır: kimsə onun cavabını gözləmir.`),
        evidence: { status: r.status, assigned, lastMessageTs: lastTs, silentForSeconds: silentFor },
      });
      continue;
    }

    // Status "open" deyir. Yalan da danışa bilər — mesaj axını ilə yoxlanılır.
    if (business && silentFor !== null && silentFor > SILENT_HOURS * 3600) {
      problems.push({
        id: r.id,
        name: r.name,
        userId: r.user_id ?? null,
        severity: 6,
        title: `${r.name} "open" görünür, amma ${formatAge(silentFor)}-dir səssizdir`,
        body:
          `İş saatındayıq və bu instansda ${formatAge(silentFor)}-dir bir dənə də mesaj yoxdur, ` +
          `halbuki vəziyyəti "open" yazır. Status köhnə qalmış ola bilər: qopma anında ` +
          `monitor vəziyyəti yalnız yaddaşda dəyişir, bazadakı sətir olduğu kimi qalır. ` +
          `Nömrənin doğrudan işlədiyini yoxlamaq lazımdır.`,
        evidence: { status: r.status, lastMessageTs: lastTs, silentForSeconds: silentFor, silentHours: SILENT_HOURS },
      });
      continue;
    }

    healthy.push(r.name);
  }

  for (const p of problems) console.log(`  ${p.name}: ${p.title}`);
  if (healthy.length > 0) console.log(`  qaydasında: ${healthy.join(", ")}`);
  if (pairing.length > 0) console.log(`  QR gözləyir: ${pairing.join(", ")}`);

  if (DRY_RUN) {
    console.log(`DRY RUN — ${problems.length} problem, heç nə yazılmadı.`);
    await pool.end();
    return;
  }

  // Sağalmış instansın bayrağını bağla. Yalnız bu detector-a toxunur.
  const openIds = healthy.map((n) => rows.find((r) => r.name === n)!.id);
  let closed = 0;
  if (openIds.length > 0) {
    const { rowCount } = await pool.query(
      `UPDATE katibe.agent_posts
       SET acknowledged_at = now(), closed_reason = 'AUTO'
       WHERE agent = $1 AND detector = $2 AND acknowledged_at IS NULL
         AND instance_id = ANY($3::text[])`,
      [AGENT, DETECTOR, openIds],
    );
    closed = rowCount ?? 0;
  }

  if (problems.length === 0) {
    if (closed > 0) console.log(`${closed} sağlamlıq bayrağı bağlandı — hamısı qaydasındadır.`);
    else console.log(`${rows.length} instans yoxlanıldı, hamısı qaydasındadır.`);
    await pool.end();
    return;
  }

  const runId = await createRun(AGENT, "health", now, now);
  for (const p of problems) {
    await upsertPost({
      runId,
      agent: AGENT,
      instanceId: p.id,
      // Sahibi olmayan instans da yoxlanılır; sütun NULL qəbul edir.
      userId: p.userId as number,
      finding: {
        detector: DETECTOR,
        jid: null,
        contact: null,
        baseSeverity: p.severity,
        title: p.title,
        evidence: p.evidence,
      },
      kind: "finding",
      severity: p.severity,
      severityReason: null,
      verdict: "INTERVENE",
      body: p.body,
      llmModel: null,
      dedupeKey: dedupeKeyFor(AGENT, DETECTOR, p.id, null),
      // Sağlamlıq postu söhbət deyil — doğrulanacaq mətn yoxdur.
      verify: null,
      // Sağlamlıq postu söhbətə bağlı deyil — ona möhlət verilə bilmir.
      afterSnoozeDays: null,
    });
  }
  await finishRun(runId, {
    status: "ok",
    instanceCount: rows.length,
    findingCount: problems.length,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  console.log(`${problems.length} problem lentə yazıldı${closed > 0 ? `, ${closed} köhnə bayraq bağlandı` : ""}.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
