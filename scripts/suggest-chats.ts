/**
 * Proposes a name and a category for chats that don't have one yet, using
 * Claude, and stores the proposals in katibe.chat_suggestion for the admin to
 * accept or reject in the dashboard.
 *
 * Nothing here writes katibe.contact_labels — a suggestion only becomes a real
 * label when a human accepts it in the UI.
 *
 * Read-only towards WhatsApp/Evolution API: it only SELECTs from
 * evolution_api tables and never calls the Evolution API, so it can never
 * mark anything as read.
 *
 * Works across every instance: a chat is identified by JID alone, so a group
 * two employees are both in is suggested once, not once per account. The
 * conversation is read from whichever account saw most of it.
 *
 * Run manually:  npm run suggest:chats
 *   SUGGEST_MAX_CHATS=50   how many chats to process this run (default 200)
 *   SUGGEST_REDO=1         also re-suggest chats already suggested but unresolved
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

// Standalone script (run via tsx, outside the Next.js runtime), so Next's
// automatic .env.local loading doesn't apply here — load it by hand.
function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
loadEnvLocal();

const MODEL = "claude-opus-5";
const MAX_CHATS = Number(process.env.SUGGEST_MAX_CHATS ?? 200);
const REDO = process.env.SUGGEST_REDO === "1";
// Several chats per call keeps cost sane; each still gets enough of its own
// history to be recognizable.
const CHATS_PER_CALL = 8;
const MESSAGES_PER_CHAT = 25;
const MAX_CHARS_PER_MESSAGE = 200;

const MEDIA_LABEL: Record<string, string> = {
  imageMessage: "[şəkil]",
  videoMessage: "[video]",
  audioMessage: "[səsli mesaj]",
  documentMessage: "[sənəd]",
  stickerMessage: "[stiker]",
  locationMessage: "[məkan]",
  contactMessage: "[kontakt]",
  albumMessage: "[şəkil albomu]",
  ptvMessage: "[video mesaj]",
};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing in env");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const client = new Anthropic();

  const { rows: categories } = await pool.query(`SELECT id, name FROM katibe.categories ORDER BY id`);
  if (categories.length === 0) {
    console.log("Heç bir kateqoriya yaradılmayıb — əvvəlcə admin panelindən kateqoriya əlavə edin.");
    await pool.end();
    return;
  }
  const categoryIds = categories.map((c) => c.id as number);

  // The model picks a category by id, constrained to the ones that exist.
  const SuggestionSchema = z.object({
    results: z.array(
      z.object({
        jid: z.string().describe("The chat id, copied exactly from the input."),
        suggestedName: z
          .string()
          .describe(
            "A short human-readable name for this contact/group in the conversation's own language — a person, company, or group name. Use an empty string if the conversation gives no basis for one.",
          ),
        categoryId: z
          .union([z.literal(categoryIds[0]), ...categoryIds.slice(1).map((id) => z.literal(id))])
          .describe("The id of the best-fitting category."),
        confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
        reason: z.string().describe("One short sentence in Azerbaijani explaining the choice."),
      }),
    ),
  });

  const categoryList = categories.map((c) => `  ${c.id} = ${c.name}`).join("\n");
  const SYSTEM_PROMPT = `Sən Dubay/Azərbaycan əsaslı parça və tekstil topdansatış şirkətinin WhatsApp yazışmalarını təsnif edirsən. Mesajlar Azərbaycan, türk, ingilis, ərəb və rus dillərində ola bilər.

"BİZ" — şirkətin öz işçisidir. "QARŞI TƏRƏF" — yazışdığı şəxs və ya qrupdur.

Hər söhbət üçün iki şey təyin et:

1) suggestedName — qarşı tərəf üçün qısa, oxunaqlı ad. Yazışmadan çıxar: şəxsin adı, şirkət adı, qrupun mövzusu (məs. "DHL Dubai", "Anup — İpək təchizatçısı", "Riyad mağaza qrupu"). Yazışmada heç bir əsas yoxdursa boş sətir ("") qaytar — uydurma.

2) categoryId — bu siyahıdan ən uyğun olanı:
${categoryList}

Kateqoriya seçimində qarşı tərəfin KİM olduğuna bax: mal alan son müştəridirmi, mal satan təchizatçı/istehsalçıdırmı, şirkətin öz işçisidirmi, yoxsa mühasibatlıq/ödəniş məsələsidirmi.

confidence: yazışma aydındırsa HIGH, dolayı işarələr varsa MEDIUM, demək olar ki heç nə yoxdursa LOW.

reason sahəsini AZƏRBAYCAN DİLİNDƏ yaz.`;

  const skipClause = REDO
    ? `AND NOT EXISTS (SELECT 1 FROM katibe.chat_suggestion s
                       WHERE s.remote_jid = t.jid AND s.resolved_at IS NOT NULL)`
    : `AND NOT EXISTS (SELECT 1 FROM katibe.chat_suggestion s WHERE s.remote_jid = t.jid)`;

  // Chats worth suggesting for: no human label yet, and enough traffic that
  // there's something to judge from. best_instance is the account that saw
  // most of the conversation, which is the copy worth reading.
  const { rows: targets } = await pool.query(
    `WITH msg_meta AS (
       SELECT key->>'remoteJid' AS jid, "instanceId", COUNT(*) AS cnt, MAX("messageTimestamp") AS last_ts
       FROM evolution_api."Message" GROUP BY 1, 2
     ),
     per_jid AS (
       SELECT jid,
              SUM(cnt) AS cnt,
              MAX(last_ts) AS last_ts,
              (ARRAY_AGG("instanceId" ORDER BY cnt DESC))[1] AS best_instance
       FROM msg_meta GROUP BY 1
     ),
     t AS (SELECT jid, cnt, last_ts, best_instance FROM per_jid WHERE cnt >= 5)
     SELECT t.jid, t.cnt, t.best_instance
     FROM t
     WHERE NOT EXISTS (SELECT 1 FROM katibe.contact_labels cl WHERE cl.remote_jid = t.jid)
       ${skipClause}
     ORDER BY t.last_ts DESC
     LIMIT $1`,
    [MAX_CHATS],
  );

  if (targets.length === 0) {
    console.log("Təklif ediləcək yeni söhbət yoxdur.");
    await pool.end();
    return;
  }

  const totalBatches = Math.ceil(targets.length / CHATS_PER_CALL);
  console.log(`${targets.length} söhbət tapıldı, ${totalBatches} partiyada göndəriləcək...`);

  let stored = 0;
  for (let i = 0; i < targets.length; i += CHATS_PER_CALL) {
    const batch = targets.slice(i, i + CHATS_PER_CALL);
    const batchNum = i / CHATS_PER_CALL + 1;

    const blocks: string[] = [];
    for (const t of batch) {
      const { rows: msgs } = await pool.query(
        `SELECT * FROM (
           SELECT (m.key->>'fromMe')::boolean AS from_me, m."pushName" AS push_name,
                  COALESCE(m.message->>'conversation',
                           m.message->'imageMessage'->>'caption',
                           m.message->'videoMessage'->>'caption',
                           m.message->'documentMessage'->>'fileName') AS text,
                  m."messageType" AS message_type, m."messageTimestamp" AS ts
           FROM evolution_api."Message" m
           WHERE m."instanceId" = $1 AND m.key->>'remoteJid' = $2
             AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
           ORDER BY m."messageTimestamp" DESC LIMIT $3
         ) r ORDER BY ts ASC`,
        [t.best_instance, t.jid, MESSAGES_PER_CHAT],
      );
      const isGroup = String(t.jid).endsWith("@g.us");
      const lines = msgs
        .map((m) => {
          const body = (m.text ?? "").trim() || MEDIA_LABEL[m.message_type] || "";
          if (!body) return null;
          const who = m.from_me
            ? "BİZ"
            : isGroup && m.push_name
              ? `QARŞI TƏRƏF (${m.push_name})`
              : "QARŞI TƏRƏF";
          return `${who}: ${body.slice(0, MAX_CHARS_PER_MESSAGE)}`;
        })
        .filter(Boolean);
      if (lines.length === 0) continue;
      blocks.push(
        `### ${t.jid} (${isGroup ? "QRUP" : "FƏRDİ"}, ${t.cnt} mesaj)\n${lines.join("\n")}`,
      );
    }

    if (blocks.length === 0) {
      console.log(`  partiya ${batchNum}/${totalBatches}: mətn tapılmadı, keçilir`);
      continue;
    }

    let parsed: z.infer<typeof SuggestionSchema> | null = null;
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await client.messages.parse({
          model: MODEL,
          max_tokens: 8000,
          thinking: { type: "adaptive" },
          output_config: { effort: "medium", format: zodOutputFormat(SuggestionSchema) },
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: blocks.join("\n\n") }],
        });
        parsed = response.parsed_output;
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  partiya ${batchNum}/${totalBatches}: cəhd ${attempt}/${MAX_ATTEMPTS} — ${message}`);
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    if (!parsed) {
      // Left unsuggested — the next run picks these up again, since nothing
      // was written to chat_suggestion for them.
      console.error(`  partiya ${batchNum}/${totalBatches}: bütün cəhdlər uğursuz, keçilir`);
      continue;
    }

    const byJid = new Map(batch.map((b) => [b.jid as string, b]));
    for (const r of parsed.results) {
      if (!byJid.has(r.jid)) continue;
      await pool.query(
        `INSERT INTO katibe.chat_suggestion
           (instance_id, remote_jid, suggested_name, suggested_category_id, confidence, reason, model)
         VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7)
         ON CONFLICT (remote_jid) DO UPDATE SET
           suggested_name = EXCLUDED.suggested_name,
           suggested_category_id = EXCLUDED.suggested_category_id,
           confidence = EXCLUDED.confidence,
           reason = EXCLUDED.reason,
           model = EXCLUDED.model,
           created_at = now(),
           resolved_at = NULL,
           resolution = NULL`,
        [byJid.get(r.jid)?.best_instance ?? null, r.jid, r.suggestedName.trim(), r.categoryId, r.confidence, r.reason, MODEL],
      );
      stored++;
    }
    console.log(`  partiya ${batchNum}/${totalBatches} bitdi (${stored} toplam)`);
  }

  console.log(`Bitdi: ${stored} söhbət üçün təklif hazırlandı.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
