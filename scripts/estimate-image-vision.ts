/**
 * Şəkilləri modelə oxutmağın QİYMƏTİNİ ölçür — bir dənə də API çağırışı etmədən.
 *
 *   npm run estimate:vision
 *     VISION_DAYS=30        neçə günə baxılsın (default 30)
 *     VISION_INCOMING=1     yalnız GƏLƏN şəkillər (öz göndərdiyimizi onsuz da bilirik)
 *     VISION_RESIZE=768     göndərməzdən əvvəl uzun kənarı bu ölçüyə sal (0 = toxunma)
 *
 * NİYƏ REAL ÖLÇÜLƏRDƏN. Şəklin qiyməti onun PİKSEL ölçüsündən çıxır, sayından
 * yox. "Orta şəkil" uydurub çarpmaq yanlış cavab verir, çünki paylanma bərabər
 * deyil. Ona görə hesab bazadakı hər şəklin öz eni/hündürlüyü üzərində aparılır
 * (WhatsApp onları mesajın içində saxlayır).
 *
 * VƏ HEÇ NƏ GÖNDƏRMİR. scripts/identify-clients.ts-də bir dəfə əks səhv olmuşdu:
 * "quru rejim" API-ni çağırırdı, yalnız bazaya yazmırdı — yəni "bu nəyə oturacaq"
 * sualına cavab verə bilmirdi. Burada model kitabxanası ümumiyyətlə import
 * olunmur.
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

/* -------------------------------------------------------------- token modelləri */

interface Tier {
  maxLongEdge: number;
  maxTokens: number;
}

/**
 * Claude: şəkil 28×28 piksellik yamaqlara bölünür, hər yamaq bir vizual token.
 *   tokens = ⌈en/28⌉ × ⌈hünd/28⌉
 * Hər model üçün iki tavan var (uzun kənar və vizual token); hansısa aşılırsa
 * şəkil nisbəti saxlanmaqla kiçildilir. Mənbə: platform.claude.com/docs vision.
 */
function claudeTokens(w: number, h: number, tier: Tier): number {
  const patches = (ww: number, hh: number) => Math.ceil(ww / 28) * Math.ceil(hh / 28);
  let scale = 1;
  const longEdge = Math.max(w, h);
  if (longEdge > tier.maxLongEdge) scale = tier.maxLongEdge / longEdge;
  // Token tavanı ayrıca yoxlanılır: uzun kənarı qaydasında olan, amma çox
  // "kvadrat" şəkil hələ də tavanı aşa bilər.
  for (let i = 0; i < 8; i++) {
    const t = patches(Math.round(w * scale), Math.round(h * scale));
    if (t <= tier.maxTokens) break;
    scale *= Math.sqrt(tier.maxTokens / t) * 0.999;
  }
  return Math.min(patches(Math.round(w * scale), Math.round(h * scale)), tier.maxTokens);
}

/**
 * OpenAI GPT-5 / GPT-4.1 ailəsi: 32×32 yamaq + 1.2 əmsalı.
 *   tokens = ⌈⌈en/32⌉ × ⌈hünd/32⌉ × 1.2⌉ , şəkil əvvəlcə 2048-ə sığdırılır.
 */
function openaiPatchTokens(w: number, h: number): number {
  const longEdge = Math.max(w, h);
  const scale = longEdge > 2048 ? 2048 / longEdge : 1;
  const ww = Math.round(w * scale);
  const hh = Math.round(h * scale);
  return Math.ceil(Math.ceil(ww / 32) * Math.ceil(hh / 32) * 1.2);
}

/**
 * OpenAI gpt-4o-mini: kafel (tile) üsulu — 2833 baza + hər 512×512 kafelə 5667.
 * Rəqəmlər böyük görünür, çünki o modelin şəkil tokeni mətn tokenindən ucuzdur;
 * müqayisə yalnız DOLLARDA mənalıdır.
 */
function openaiTileTokens(w: number, h: number): number {
  let scale = 1;
  const longEdge = Math.max(w, h);
  if (longEdge > 2048) scale = 2048 / longEdge;
  let ww = w * scale;
  let hh = h * scale;
  const shortest = Math.min(ww, hh);
  if (shortest > 768) {
    const s = 768 / shortest;
    ww *= s;
    hh *= s;
  }
  const tiles = Math.ceil(ww / 512) * Math.ceil(hh / 512);
  return 2833 + tiles * 5667;
}

interface ModelSpec {
  id: string;
  /** $/MTok giriş. */
  inPrice: number;
  tokens: (w: number, h: number) => number;
  note: string;
}

// Claude qiymətləri: platform.claude.com pricing (2026-06 keşi).
// OpenAI qiymətləri: developers.openai.com/api/docs/pricing.
const MODELS: ModelSpec[] = [
  {
    id: "claude-haiku-4-5",
    inPrice: 1.0,
    tokens: (w, h) => claudeTokens(w, h, { maxLongEdge: 1568, maxTokens: 1568 }),
    note: "standart bənd — şəkil başına ən çoxu 1568 token",
  },
  {
    id: "claude-sonnet-5",
    inPrice: 2.0,
    tokens: (w, h) => claudeTokens(w, h, { maxLongEdge: 2576, maxTokens: 4784 }),
    note: "yüksək bənd (4.7+) — 3x-ə qədər çox token",
  },
  { id: "gpt-5-nano", inPrice: 0.05, tokens: openaiPatchTokens, note: "32px yamaq × 1.2" },
  { id: "gpt-5-mini", inPrice: 0.25, tokens: openaiPatchTokens, note: "32px yamaq × 1.2" },
  { id: "gpt-4.1-mini", inPrice: 0.4, tokens: openaiPatchTokens, note: "32px yamaq × 1.2" },
  { id: "gpt-4o-mini", inPrice: 0.15, tokens: openaiTileTokens, note: "kafel üsulu — 2833 + 5667/kafel" },
];

/* --------------------------------------------------------------------- hesabat */

const INSTANCES = [
  "c7be87e8-92ca-441f-988f-55ecedf02dc5",
  "dae2e0f1-2d86-42ac-bf57-e7f72048c19e",
  "9f4f23ff-c13d-4afb-bcff-550fde03913b",
];

/** Şəkillə birlikdə gedən mətn (sistem promptu + söhbət konteksti) — təxmini. */
const TEXT_TOKENS_PER_IMAGE = 400;
/** Şəkil başına gözlənilən çıxış (qısa təsvir + struktur cavab). */
const OUT_TOKENS_PER_IMAGE = 120;

async function main() {
  const { pool } = await import("../src/lib/db");
  const days = Number(process.env.VISION_DAYS ?? 30);
  const incomingOnly = process.env.VISION_INCOMING === "1";
  const resizeTo = Number(process.env.VISION_RESIZE ?? 0);

  const { rows } = await pool.query<{ w: string; h: string; from_me: boolean }>(
    `SELECT (m.message->'imageMessage'->>'width')::int AS w,
            (m.message->'imageMessage'->>'height')::int AS h,
            (m.key->>'fromMe')::boolean AS from_me
     FROM evolution_api."Message" m
     WHERE m."instanceId" = ANY($1::text[])
       AND (m.key->>'remoteJid' LIKE '%@s.whatsapp.net' OR m.key->>'remoteJid' LIKE '%@lid')
       AND m."messageType" = 'imageMessage'
       AND m."messageTimestamp" > EXTRACT(epoch FROM now() - make_interval(days => $2::int))::int
       AND m.message->'imageMessage'->>'width' IS NOT NULL`,
    [INSTANCES, days],
  );

  const images = rows
    .filter((r) => !incomingOnly || !r.from_me)
    .map((r) => {
      let w = Number(r.w);
      let h = Number(r.h);
      if (resizeTo > 0) {
        const longEdge = Math.max(w, h);
        if (longEdge > resizeTo) {
          const s = resizeTo / longEdge;
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
      }
      return { w, h };
    });

  if (images.length === 0) {
    console.log("Ölçüsü bilinən şəkil tapılmadı.");
    await pool.end();
    return;
  }

  const perDay = images.length / days;
  console.log(
    `${images.length} şəkil / ${days} gün (${perDay.toFixed(0)}/gün)` +
      (incomingOnly ? ", YALNIZ GƏLƏN" : ", gələn+gedən") +
      (resizeTo ? `, göndərməzdən əvvəl uzun kənar ${resizeTo}px-ə salınıb` : ", orijinal ölçüdə") +
      ` — HEÇ BİR API ÇAĞIRIŞI EDİLMƏDİ\n`,
  );

  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);
  console.log(
    pad("model", 18) + padL("tok/şəkil", 11) + padL("giriş tok", 12) + padL("aylıq $", 10) + "  qeyd",
  );
  console.log("-".repeat(85));

  for (const m of MODELS) {
    let visual = 0;
    for (const im of images) visual += m.tokens(im.w, im.h);
    const inputTokens = visual + images.length * TEXT_TOKENS_PER_IMAGE;
    // Çıxış qiymətini bilmirik desək yanlış olar, amma o, girişin yanında
    // kiçikdir və modeldən modelə fərqlidir — ona görə hesabat GİRİŞ üzərindədir
    // və çıxış ayrıca sətirdə xatırladılır.
    const monthly = (inputTokens / 1e6) * m.inPrice * (30 / days);
    console.log(
      pad(m.id, 18) +
        padL(Math.round(visual / images.length).toLocaleString("az-AZ"), 11) +
        padL(Math.round(inputTokens).toLocaleString("az-AZ"), 12) +
        padL("$" + monthly.toFixed(2), 10) +
        "  " +
        m.note,
    );
  }

  console.log(
    `\nQeyd: rəqəmlər yalnız GİRİŞ tokenidir. Şəkil başına ~${TEXT_TOKENS_PER_IMAGE} mətn tokeni ` +
      `(prompt + söhbət konteksti) əlavə edilib; çıxış (~${OUT_TOKENS_PER_IMAGE} tok/şəkil) ` +
      `modeldən asılıdır və ümumi məbləğin kiçik hissəsidir.`,
  );
  console.log(
    `Düsturlar: Claude ⌈en/28⌉×⌈hünd/28⌉ vizual token (bənd tavanı ilə); ` +
      `GPT-5/4.1 ⌈⌈en/32⌉×⌈hünd/32⌉×1.2⌉; gpt-4o-mini 2833 + 5667×kafel.`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
