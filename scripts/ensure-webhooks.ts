/**
 * Vebhuku olmayan instansa vebhuk qurur.
 *
 * Niyə lazımdır: Evolution-da qlobal vebhuk sönülüdür
 * (WEBHOOK_GLOBAL_ENABLED=false), yəni vebhuk HƏR instansa ayrıca qurulmalıdır,
 * və yeni instans yaradılanda bunu edən heç bir addım yoxdur. Nəticə 2026-08-25
 * -də göründü: Rouz və Zemfira o günün əvvəlində yaradılmışdı, ikisində də
 * vebhuk yox idi — Zemfira gündə ~1900 mesaj alırdı və lentdəki canlı
 * göstərici onun səhifəsində əbədi "mesaj gözlənilir"də qalırdı, HEÇ BİR
 * xəta görünmədən. Səssiz sıradan çıxma ən pis növüdür, ona görə bu skript
 * saatda bir yoxlayır.
 *
 * Qlobal vebhuku açmaq alternativ idi, seçilmədi: Evolution-un restartını
 * tələb edir və artıq öz vebhuku olan instanslara hadisələr İKİ DƏFƏ gedərdi.
 *
 * Nə düzəldilir (yalnız fərq olanda POST gedir — təkrar işlətmək təhlükəsizdir):
 *   - vebhuk ümumiyyətlə yoxdur
 *   - enabled = false
 *   - url başqa yerə baxır
 *   - x-katibe-webhook-secret başlığı yoxdur (onsuz endpoint 401 verir və
 *     hadisələr səssizcə itir)
 *   - MESSAGES_UPSERT / SEND_MESSAGE hadisələri siyahıda yoxdur
 *
 * WhatsApp-a qarşı ancaq oxuyur: Evolution-un yalnız KONFİQURASİYA endpoint-i
 * çağırılır, mesaja toxunulmur, heç nə oxunmuş işarələnmir.
 *
 * Əl ilə:  npm run ensure:webhooks
 *   WEBHOOK_DRY_RUN=1   nəyi dəyişəcəyini yaz, HEÇ NƏ etmə
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

const WEBHOOK_URL = process.env.KATIBE_WEBHOOK_URL || "http://127.0.0.1:3000/api/webhooks/evolution";
const REQUIRED_EVENTS = ["MESSAGES_UPSERT", "SEND_MESSAGE"] as const;
const SECRET_HEADER = "x-katibe-webhook-secret";
const DRY_RUN = process.env.WEBHOOK_DRY_RUN === "1";

async function main() {
  const { pool } = await import("../src/lib/db");

  const apiUrl = process.env.EVOLUTION_API_URL?.replace(/\/+$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY;
  const secret = process.env.KATIBE_WEBHOOK_SECRET;
  // Sirr olmadan vebhuk qurmaq DAHA PİSDİR: konfiqurasiya "var" görünər, amma
  // hər POST 401 alıb səssizcə itər. Ona görə burada dayanırıq.
  if (!apiUrl || !apiKey) throw new Error("EVOLUTION_API_URL / EVOLUTION_API_KEY .env.local-da yoxdur");
  if (!secret) throw new Error("KATIBE_WEBHOOK_SECRET .env.local-da yoxdur");

  const { rows } = await pool.query(
    `SELECT i.id, i.name, w.enabled, w.url, w.events, w.headers
     FROM evolution_api."Instance" i
     LEFT JOIN evolution_api."Webhook" w ON w."instanceId" = i.id
     ORDER BY i.name`,
  );

  let fixed = 0;
  for (const r of rows) {
    const events: string[] = Array.isArray(r.events) ? r.events : [];
    const headers = (r.headers ?? {}) as Record<string, string>;
    const problems: string[] = [];
    if (r.enabled === null || r.enabled === undefined) problems.push("vebhuk yoxdur");
    else if (!r.enabled) problems.push("söndürülüb");
    if (r.enabled != null && r.url !== WEBHOOK_URL) problems.push(`url başqadır (${r.url})`);
    if (r.enabled != null && !headers[SECRET_HEADER]) problems.push("sirr başlığı yoxdur");
    const missing = REQUIRED_EVENTS.filter((e) => !events.includes(e));
    if (r.enabled != null && missing.length > 0) problems.push(`hadisə çatmır: ${missing.join(", ")}`);

    if (problems.length === 0) continue;

    console.log(`${r.name}: ${problems.join("; ")}${DRY_RUN ? " — DRY RUN, toxunulmadı" : ""}`);
    if (DRY_RUN) continue;

    // Ad yola qoyulur, ona görə kodlaşdırılır — instans adında boşluq ola bilər.
    const res = await fetch(`${apiUrl}/webhook/set/${encodeURIComponent(r.name)}`, {
      method: "POST",
      headers: { apikey: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: WEBHOOK_URL,
          headers: { [SECRET_HEADER]: secret },
          byEvents: false,
          base64: false,
          events: [...REQUIRED_EVENTS],
        },
      }),
    });
    if (!res.ok) {
      // Cavab gövdəsi çap EDİLMİR: Evolution qurulmuş vebhuku geri qaytarır,
      // içində də sirr başlığı olur, jurnal isə oxunaqlıdır.
      console.error(`  ${r.name}: alınmadı — HTTP ${res.status}`);
      continue;
    }
    console.log(`  ${r.name}: vebhuk quruldu.`);
    fixed++;
  }

  if (fixed === 0 && !DRY_RUN) console.log(`${rows.length} instans yoxlanıldı, hamısında vebhuk qaydasındadır.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
