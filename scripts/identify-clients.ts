/**
 * Client-first sweep over individual WhatsApp numbers.
 *
 * Knowing which numbers are CLIENTS is what every other analysis hangs off
 * of, so this script asks that question directly instead of picking a
 * category out of a flat list: for each number it decides "does this side buy
 * from us?", and only then, for the ones that don't, what they are instead.
 *
 * Scope is individual chats only — @s.whatsapp.net and @lid (a @lid is a
 * one-to-one contact whose number WhatsApp has masked, NOT a group). Groups
 * are left to `npm run suggest:chats`.
 *
 * Two exclusions come from how the business actually works, and they cut the
 * candidate pool by more than a tenth before a single token is spent:
 *   - a number that appears as a participant in ANY group is not a client —
 *     that is staff, a supplier or a partner;
 *   - a number that more than one of our accounts talks to directly is not a
 *     client either — a customer belongs to one salesperson.
 *
 * What happens to a proposal depends on how sure the model is:
 *   HIGH          applied immediately (katibe.chat_suggestion resolution
 *                 'AUTO'), because ~430 numbers can't be reviewed by hand;
 *   MEDIUM / LOW  queued at /admin/suggestions for a human to accept in bulk.
 * An auto-applied label is never final: the same page lists them and can
 * revert any one of them.
 *
 * Read-only towards WhatsApp/Evolution API: it only SELECTs from
 * evolution_api tables and never calls the Evolution API, so it can never
 * mark anything as read.
 *
 * Run manually:  npm run identify:clients
 *   CLIENT_MAX_CHATS=50   how many numbers to process this run (default 200)
 *   CLIENT_MIN_MESSAGES=5 skip numbers with less history than this (default 5)
 *   CLIENT_REDO=1         also re-examine numbers proposed before but never resolved
 *   CLIENT_DRY_RUN=1      print what it would do, write nothing
 *   CLIENT_PROVIDER=      'openai' (default) or 'anthropic'
 *   CLIENT_MODEL=         override the model for the chosen provider
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { applySuggestion } from "../src/lib/suggestions";

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

type Provider = "openai" | "anthropic";

const PROVIDER: Provider = process.env.CLIENT_PROVIDER === "anthropic" ? "anthropic" : "openai";
// A mini-tier model is the right size for this: the question is a yes/no about
// who buys from whom, decided from a short excerpt, and the reason field keeps
// every call auditable either way.
const DEFAULT_MODEL: Record<Provider, string> = {
  openai: "gpt-5.4-mini",
  // Deciding "does this side buy from us?" is classification, not analysis.
  // Haiku does it at $1/$5 per MTok against Sonnet's $3/$15, and this sweep
  // runs over hundreds of numbers.
  anthropic: "claude-haiku-4-5",
};
const MODEL = process.env.CLIENT_MODEL || DEFAULT_MODEL[PROVIDER];
const MAX_CHATS = Number(process.env.CLIENT_MAX_CHATS ?? 200);
const MIN_MESSAGES = Number(process.env.CLIENT_MIN_MESSAGES ?? 5);
const REDO = process.env.CLIENT_REDO === "1";
const DRY_RUN = process.env.CLIENT_DRY_RUN === "1";
// Several chats per call keeps cost sane; each still gets enough of its own
// history to be recognizable.
const CHATS_PER_CALL = 8;
const MESSAGES_PER_CHAT = 30;
const MAX_CHARS_PER_MESSAGE = 200;
const CLIENT_CATEGORY = "Client";

// Running totals for the end-of-run cost line.
let usageIn = 0;
let usageOut = 0;

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

/**
 * One classification call, against whichever provider is configured.
 *
 * Both SDKs are handed the same zod schema and validate against it themselves,
 * so a malformed answer raises here and the caller's retry loop handles it —
 * there is no hand-rolled JSON parsing on either path. The result comes back
 * as `unknown` and the caller re-parses it, because the two SDKs' generic
 * helpers don't agree on a shared return type.
 */
async function classify(
  schema: z.ZodType,
  input: string,
  instructions: string,
): Promise<unknown> {
  if (PROVIDER === "openai") {
    const client = new OpenAI();
    const response = await client.responses.parse({
      model: MODEL,
      instructions,
      input,
      text: { format: zodTextFormat(schema, "results") },
    });
    const parsed = response.output_parsed;
    if (!parsed) throw new Error("model returned no parsed output");
    return parsed;
  }

  const client = new Anthropic();
  // Adaptive thinking and `effort` arrived with the 4.6 generation. Haiku 4.5
  // rejects both with a 400, so they are only sent to models that take them.
  const modern = !/haiku-4-5|sonnet-4-5/.test(MODEL);
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    ...(modern ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: {
      ...(modern ? { effort: "medium" as const } : {}),
      format: zodOutputFormat(schema),
    },
    system: instructions,
    messages: [{ role: "user", content: input }],
  });
  // Adaptive thinking bills as output, so the visible verdicts are a poor guide
  // to what a batch actually cost. Record it.
  usageIn += response.usage.input_tokens;
  usageOut += response.usage.output_tokens;
  return response.parsed_output;
}

async function main() {
  const keyName = PROVIDER === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[keyName]) throw new Error(`${keyName} missing in env`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

  const { rows: categories } = await pool.query(`SELECT id, name FROM katibe.categories ORDER BY id`);
  const clientCategory = categories.find((c) => c.name === CLIENT_CATEGORY);
  if (!clientCategory) {
    // The whole point of this script is the Client label; without that
    // category there is nothing to write.
    console.error(`"${CLIENT_CATEGORY}" kateqoriyası yoxdur — əvvəlcə admin panelindən yaradın.`);
    await pool.end();
    process.exit(1);
  }
  const CLIENT_ID = clientCategory.id as number;
  const otherCategories = categories.filter((c) => c.id !== CLIENT_ID);
  const otherIds = otherCategories.map((c) => c.id as number);

  // isClient is the decision; otherCategoryId only says what a non-client is
  // instead, so the model can't answer "client" and "supplier" at once.
  const SweepSchema = z.object({
    results: z.array(
      z.object({
        jid: z.string().describe("The chat id, copied exactly from the input."),
        isClient: z
          .boolean()
          .describe("True if the other side BUYS from us (asks our prices, places orders, pays us)."),
        otherCategoryId: z
          .number()
          .int()
          .describe(
            `If isClient is false, the id of what they are instead — one of: ${otherIds.join(", ")}. Use 0 when isClient is true.`,
          ),
        suggestedName: z
          .string()
          .describe(
            "A short human-readable name for this contact in the conversation's own language — a person or company name. Use an empty string if the conversation gives no basis for one.",
          ),
        confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
        reason: z.string().describe("One short sentence in Azerbaijani explaining the choice."),
      }),
    ),
  });

  const otherList = otherCategories.map((c) => `  ${c.id} = ${c.name}`).join("\n");
  const SYSTEM_PROMPT = `Sən Dubay/Azərbaycan əsaslı parça və tekstil topdansatış şirkətinin WhatsApp yazışmalarını təsnif edirsən. Mesajlar Azərbaycan, türk, ingilis, ərəb və rus dillərində ola bilər.

"BİZ" — şirkətin öz işçisidir. "QARŞI TƏRƏF" — yazışdığı nömrədir.

ƏSAS SUAL: qarşı tərəf MÜŞTƏRİdirmi (isClient)?

MÜŞTƏRİ = BİZDƏN mal alan tərəfdir. Əlamətlər:
  - bizdən qiymət soruşur ("neçəyədir", "metri neçəyə", "qiymət verin")
  - bizə sifariş verir — metraj, rəng, ölçü, model seçir
  - BİZ ona qiymət/hesab/faktura/nümunə/katalog göndəririk
  - O BİZƏ ödəniş edir, çatdırılma/göndəriş vaxtını soruşur

MÜŞTƏRİ DEYİL (isClient = false), onda otherCategoryId seç:
${otherList}
  - BİZ ondan alırıqsa, o bizə qiymət verirsə → təchizatçı
  - rəngləmə, toxuma, tikiş, kəsim, emal danışılırsa → istehsal
  - bank, ödəniş sənədi, hesabat, mühasibatlıq → mühasibatlıq
  - şirkətin öz işçisi/sahibi → daxili
  - şəxsi söhbət, reklam, aidiyyəti olmayan → digər

HƏLLEDİCİ QAYDA: axının istiqamətinə bax. Pul BİZƏ gəlir, mal BİZDƏN çıxırsa → MÜŞTƏRİ. Pul BİZDƏN çıxır, mal BİZƏ gəlirsə → MÜŞTƏRİ DEYİL.

suggestedName — qarşı tərəf üçün qısa, oxunaqlı ad (şəxsin adı, şirkət adı, məs. "Elvin — Bakı mağaza"). Yazışmada heç bir əsas yoxdursa boş sətir ("") qaytar — UYDURMA.

confidence — DİQQƏT: HIGH verdiyin qərar İNSAN YOXLAMASI OLMADAN dərhal tətbiq olunur. Ona görə:
  HIGH   — yazışmada FAKTİKİ alqı-satqı görünür: konkret sifariş, ölçü/metraj razılaşması, ödəniş, göndəriş. Şübhə yoxdur.
  MEDIUM — güclü işarələr var, amma faktiki alış görünmür
  LOW    — yazışma qısadır, salamlaşmadan ibarətdir və ya istiqamət bəlli deyil

HIGH VERMƏ, əgər:
  - qarşı tərəf sadəcə ünvan/iş saatı soruşubsa və ya "baxmaq istəyirəm" deyibsə
  - "ala bilər", "ehtimal var", "maraqlanır" kimi bir mühakimə qurursansa — bu MEDIUM-dur
  - yalnız bir-iki mesaj var
Potensial alıcı (lead) MÜŞTƏRİ DEYİL — faktiki alış olmayıbsa isClient=true versən belə, confidence ən çoxu MEDIUM olmalıdır.

reason sahəsini AZƏRBAYCAN DİLİNDƏ yaz.`;

  const skipClause = REDO
    ? `AND NOT EXISTS (SELECT 1 FROM katibe.chat_suggestion s
                       WHERE s.remote_jid = t.jid AND s.resolved_at IS NOT NULL)`
    : `AND NOT EXISTS (SELECT 1 FROM katibe.chat_suggestion s WHERE s.remote_jid = t.jid)`;

  // Individual numbers only, with enough traffic that there's something to
  // judge from. best_instance is the account that saw most of the
  // conversation, which is the copy worth reading.
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
     -- Rule 1: a client is never in any group. Being a participant in one
     -- means this number belongs to staff, a supplier, or a partner — the
     -- company's own orbit, not a customer's. Group messages carry the
     -- speaker in key->>'participant', in the same @lid form as a direct JID.
     group_members AS (
       SELECT DISTINCT key->>'participant' AS jid
       FROM evolution_api."Message"
       WHERE key->>'remoteJid' LIKE '%@g.us' AND key ? 'participant'
     ),
     -- Rule 2: a client is not a contact shared with the principal account.
     -- If more than one of our numbers talks to them directly, they are
     -- someone the company deals with rather than one salesperson's customer.
     shared_contacts AS (
       SELECT jid FROM msg_meta GROUP BY jid HAVING count(DISTINCT "instanceId") > 1
     ),
     t AS (
       SELECT jid, cnt, last_ts, best_instance FROM per_jid
       WHERE cnt >= $2
         AND (jid LIKE '%@s.whatsapp.net' OR jid LIKE '%@lid')
         AND jid NOT IN (SELECT jid FROM group_members)
         AND jid NOT IN (SELECT jid FROM shared_contacts)
     )
     SELECT t.jid, t.cnt, t.best_instance
     FROM t
     WHERE NOT EXISTS (SELECT 1 FROM katibe.contact_labels cl WHERE cl.remote_jid = t.jid)
       ${skipClause}
     ORDER BY t.last_ts DESC
     LIMIT $1`,
    [MAX_CHATS, MIN_MESSAGES],
  );

  if (targets.length === 0) {
    console.log("Yoxlanılacaq yeni fərdi nömrə yoxdur.");
    await pool.end();
    return;
  }

  const totalBatches = Math.ceil(targets.length / CHATS_PER_CALL);
  let dryChars = 0;
  let dryBatches = 0;
  console.log(
    `${targets.length} fərdi nömrə tapıldı, ${totalBatches} partiyada ${MODEL} modelinə göndəriləcək${DRY_RUN ? " (DRY RUN)" : ""}...`,
  );

  const stats = { clientsAuto: 0, otherAuto: 0, queued: 0, clientsQueued: 0 };

  for (let i = 0; i < targets.length; i += CHATS_PER_CALL) {
    const batch = targets.slice(i, i + CHATS_PER_CALL);
    const batchNum = i / CHATS_PER_CALL + 1;

    const blocks: string[] = [];
    for (const t of batch) {
      const { rows: msgs } = await pool.query(
        `SELECT * FROM (
           SELECT (m.key->>'fromMe')::boolean AS from_me,
                  COALESCE(m.message->>'conversation',
                           m.message->'extendedTextMessage'->>'text',
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
      const lines = msgs
        .map((m) => {
          const body = (m.text ?? "").trim() || MEDIA_LABEL[m.message_type] || "";
          if (!body) return null;
          return `${m.from_me ? "BİZ" : "QARŞI TƏRƏF"}: ${body.slice(0, MAX_CHARS_PER_MESSAGE)}`;
        })
        .filter(Boolean);
      if (lines.length === 0) continue;
      blocks.push(`### ${t.jid} (FƏRDİ NÖMRƏ, ${t.cnt} mesaj)\n${lines.join("\n")}`);
    }

    if (blocks.length === 0) {
      console.log(`  partiya ${batchNum}/${totalBatches}: mətn tapılmadı, keçilir`);
      continue;
    }

    if (DRY_RUN) {
      // Estimate rather than call: a dry run exists to answer "what will this
      // cost", and it cannot do that by spending money to find out.
      const chars = blocks.join("\n\n").length;
      dryChars += chars;
      dryBatches++;
      console.log(
        `  partiya ${batchNum}/${totalBatches}: ${batch.length} nömrə, ${chars} simvol (göndərilmədi)`,
      );
      continue;
    }

    let parsed: z.infer<typeof SweepSchema> | null = null;
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Same prompt, same schema, either provider — only the call shape
        // differs, so switching model is a config change and never a
        // re-tuning of how the question is asked.
        parsed = SweepSchema.parse(await classify(SweepSchema, blocks.join("\n\n"), SYSTEM_PROMPT));
        break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`  partiya ${batchNum}/${totalBatches}: cəhd ${attempt}/${MAX_ATTEMPTS} — ${message}`);
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    if (!parsed) {
      // Left unproposed — the next run picks these up again, since nothing
      // was written to chat_suggestion for them.
      console.error(`  partiya ${batchNum}/${totalBatches}: bütün cəhdlər uğursuz, keçilir`);
      continue;
    }

    const byJid = new Map(batch.map((b) => [b.jid as string, b]));
    for (const r of parsed.results) {
      const target = byJid.get(r.jid);
      if (!target) continue;

      // isClient is the answer; otherCategoryId only applies when it's false,
      // so a "client + supplier" contradiction can't reach the database.
      const categoryId = r.isClient
        ? CLIENT_ID
        : otherIds.includes(r.otherCategoryId)
          ? r.otherCategoryId
          : null;
      if (categoryId === null) continue;

      if (DRY_RUN) {
        console.log(
          `  ${r.confidence.padEnd(6)} ${r.isClient ? "CLIENT " : "       "} ${r.jid} — ${r.suggestedName || "(adsız)"} :: ${r.reason}`,
        );
        continue;
      }

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
        [target.best_instance, r.jid, r.suggestedName.trim(), categoryId, r.confidence, r.reason, MODEL],
      );

      if (r.confidence === "HIGH") {
        const applied = await applySuggestion(pool, r.jid, "AUTO");
        if (applied) {
          if (r.isClient) stats.clientsAuto++;
          else stats.otherAuto++;
        }
      } else {
        stats.queued++;
        if (r.isClient) stats.clientsQueued++;
      }
    }
    console.log(
      `  partiya ${batchNum}/${totalBatches} bitdi — avtomatik ${stats.clientsAuto} client / ${stats.otherAuto} digər, təsdiq gözləyən ${stats.queued}`,
    );
  }

  if (DRY_RUN) {
    // ~3.5 characters per token for this mostly-Latin, multi-lingual text, plus
    // a per-call allowance for the system prompt and the output schema.
    const inTok = Math.round(dryChars / 3.5) + dryBatches * 900;
    const outTok = dryBatches * 700; // structured verdicts for 8 numbers
    const fmt = (n: number) => n.toLocaleString("az-AZ");
    console.log(
      `\nTƏXMİNİ XƏRC — ${dryBatches} çağırış, giriş ~${fmt(inTok)} token, çıxış ~${fmt(outTok)} token`,
    );
    for (const [name, inPrice, outPrice] of [
      ["claude-haiku-4-5", 1, 5],
      ["claude-sonnet-5", 2, 10],
    ] as const) {
      const usd = (inTok / 1e6) * inPrice + (outTok / 1e6) * outPrice;
      console.log(`  ${name.padEnd(18)} ~$${usd.toFixed(3)}`);
    }
    console.log("DRY RUN bitdi — heç nə göndərilmədi, heç nə yazılmadı.");
  } else {
    console.log(
      `Bitdi: ${stats.clientsAuto} nömrə avtomatik Client işarələndi, ${stats.otherAuto} digər kateqoriya, ${stats.queued} təklif təsdiq gözləyir (${stats.clientsQueued}-i Client). Yoxlamaq üçün: /admin/suggestions`,
    );
    const price: Record<string, [number, number]> = {
      "claude-haiku-4-5": [1, 5],
      "claude-sonnet-5": [2, 10],
      "claude-opus-5": [5, 25],
    };
    const [pin, pout] = price[MODEL] ?? [0, 0];
    console.log(
      `XƏRC: giriş ${usageIn.toLocaleString("az-AZ")}, çıxış ${usageOut.toLocaleString("az-AZ")} token` +
        (pin ? ` — ~$${((usageIn / 1e6) * pin + (usageOut / 1e6) * pout).toFixed(3)} (${MODEL})` : ""),
    );
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
