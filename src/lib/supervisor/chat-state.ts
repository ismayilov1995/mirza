import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { pool } from "../db";
import { clientScopeSql } from "./scope";
import type { ScopedInstanceId } from "../access";
import { formatDuration } from "../format";

// Söhbət halının LLM təsnifatı. Qaydaların görə bilmədiyi mühakimə buradadır:
// "qiymət verilib, müştəri düşünür" ilə "son mesaj onsuz da cavab istəmirdi"
// bir-birindən yalnız mətni OXUYARAQ ayrılır.
//
// Xərc intizamı üç qatdadır:
//   1. hal SAXLANILIR — təzə mesajı olmayan söhbət heç vaxt yenidən oxunmur;
//   2. Haiku təsnif edir, yalnız LOW confidence Sonnet-ə gedir;
//   3. çağırışa 8 söhbət partiyalanır (scripts/identify-clients.ts qaydası).

export const CHAT_STATES = [
  "WAITING_ON_US",
  "CUSTOMER_DECIDING",
  "IN_PROGRESS",
  "RESOLVED",
  "FILLER",
  "STALE",
  "FORWARDED_TO_BRANCH",
  "FOR_PR",
] as const;
export type ChatState = (typeof CHAT_STATES)[number];

export const STATE_LABELS: Record<ChatState, string> = {
  WAITING_ON_US: "Bizdən cavab gözləyir",
  CUSTOMER_DECIDING: "Müştəri qərar verir",
  IN_PROGRESS: "Gedişatdadır",
  RESOLVED: "Bağlanıb",
  FILLER: "Cavab tələb etmir",
  STALE: "Sönmüş",
  FORWARDED_TO_BRANCH: "Filiala yönləndirilib",
  FOR_PR: "PR üçün",
};

/**
 * Bayraq mövzusu OLMAYAN hallar: iş bizim tərəfdə deyil.
 *
 * Digər susdurulan hallardan (FILLER/RESOLVED) fərqi odur ki, bunlar
 * gizlənmir — /agent/handoff səhifəsində ayrıca siyahı kimi durur. Ona görə
 * süzgəc də bir pillə genişdir: HIGH-la yanaşı MEDIUM da keçir. "Görünməz
 * qalma" riski burada yoxdur, çünki söhbət başqa siyahıda görünür.
 */
export const HANDOFF_STATES: ChatState[] = ["FORWARDED_TO_BRANCH", "FOR_PR"];

/** SQL-də işlədilən sətir siyahısı — detektorlar və bağlama sorğuları üçün. */
export const HANDOFF_STATES_SQL = HANDOFF_STATES.map((s) => `'${s}'`).join(", ");

const HAIKU_MODEL = process.env.STATE_MODEL || "claude-haiku-4-5";
const ESCALATE_MODEL = process.env.STATE_MODEL_HIGH || "claude-sonnet-5";

/** Söhbət başına son N mesaj — ölçmə göstərdi ki, orta söhbətdə onsuz da
 * cəmi ~9 mətnli mesaj var, yəni 30 praktikada "bütün yaxın tarix" deməkdir. */
const MESSAGES_PER_CHAT = 30;
const MAX_CHARS_PER_MESSAGE = 300;
const CHATS_PER_CALL = 8;

const StateSchema = z.object({
  results: z.array(
    z.object({
      jid: z.string().describe("The chat id, copied exactly from the input."),
      state: z.enum(CHAT_STATES),
      confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
      reason: z.string().describe("One short Azerbaijani sentence citing what in the conversation decided the state."),
      identity: z
        .object({
          statedName: z.string().nullable().describe("Name the OTHER SIDE gave for themselves or their business, exactly as written. null if never stated."),
          city: z.string().nullable().describe("City or country the OTHER SIDE says they are in. null if never stated."),
          orderCode: z.string().nullable().describe("Order, invoice or tracking code belonging to this chat. null if none."),
          note: z.string().nullable().describe("Any other SHORT identifying detail about who they are, in Azerbaijani. null if none."),
        })
        .nullable()
        .describe("Only what the OTHER SIDE said about THEMSELVES. Never guess. null if nothing at all."),
    }),
  ),
});

const SYSTEM_PROMPT = `Sən Dubay/Azərbaycan əsaslı parça və tekstil topdansatış şirkətinin WhatsApp söhbətlərinin HAZIRKI VƏZİYYƏTİNİ təyin edirsən. Mesajlar Azərbaycan, türk, ingilis, ərəb və rus dillərində ola bilər. "BİZ" — şirkətin satıcısıdır, "QARŞI TƏRƏF" — yazışdığı şəxsdir. Hər mesajın qabağında nə vaxt yazıldığı göstərilir.

Hər söhbət üçün top KİMDƏDİR və nə gözlənilir — bunu son mesajların MƏZMUNUNDAN çıxar.

ƏVVƏLCƏ bu iki halı yoxla; onlar qalanlarından ÜSTÜNDÜR, çünki hər ikisində iş ümumiyyətlə bizim tərəfimizdə deyil:

FORWARDED_TO_BRANCH — biz qarşı tərəfi şirkətin BAŞQA FİLİALINA/komandasına (Dubay, Riyad və s.) yönləndirmişik və bunu ona bildirmişik: "Dubai team will contact you", "our Dubai branch will reach out", "let me share your number with our Riyadh team", "Dubaydakı mağazamıza nömrənizi göndərirəm" və bənzəri. Bundan sonra top həmin filialdadır — bizim burada cavab verməli olduğumuz bir şey qalmayıb. reason sahəsində HANSI filial olduğunu yaz. Yönləndirmədən SONRA qarşı tərəf yeni, ayrıca sual verib və biz cavabsız qoymuşuqsa, bu artıq FORWARDED_TO_BRANCH deyil, WAITING_ON_US-dur.
FOR_PR — qarşı tərəf müştəri DEYİL: əməkdaşlıq/reklam/PR təklifi ilə yazır. "We want to cooperate with you", "collaboration", "partnership", brend təklifi, blogger/influencer barter təklifi, sponsorluq, media sorğusu. Nə isə almaq istəmir — nə isə təklif edir.

Qalan hallar:

WAITING_ON_US — qarşı tərəf real sual verib, sifariş/qiymət istəyib və BİZ hələ cavab verməmişik. Cavabsız qalan REAL istək var.
CUSTOMER_DECIDING — BİZ qiymət/məlumat/nümunə vermişik, top qarşı tərəfdədir: düşünür, qərar verməyib. Satış sallanan haldadır.
IN_PROGRESS — canlı gediş-gəliş var və ya sifariş icradadır; heç kim ilişib qalmayıb.
RESOLVED — mövzu bağlanıb: sifariş çatdırılıb/hesablaşılıb/razılıq bitib, açıq heç nə qalmayıb.
FILLER — son mesaj(lar) nəzakətdir: "ok", "təşəkkür", salam, emoji. Cavab TƏLƏB ETMİR — kimsə cavab verməsə də heç nə itmir.
STALE — söhbət çoxdan sönüb, sonda da açıq istək görünmür.

DİQQƏT: FORWARDED_TO_BRANCH və FOR_PR yalnız MƏTNDƏ AÇIQ göründükdə seçilir. "Yəqin filiala getdi" kimi təxmin etmə — yönləndirmə cümləsini görməlisən. Şübhə varsa adi halları seç və confidence-i aşağı sal.
DİQQƏT: WAITING_ON_US ilə FILLER fərqi ən vacib qərardır — son mesaj qarşı tərəfdən olsa belə, məzmunu cavab istəmirsə bu FILLER-dir, WAITING_ON_US deyil. Eyni cür CUSTOMER_DECIDING yalnız BİZİM konkret təklif/qiymət verdiyimiz görünəndə seçilir.

confidence: HIGH — vəziyyət mətndən birmənalı görünür; MEDIUM — güclü ehtimal; LOW — mətn qısadır/qarışıqdır, əmin deyilsən.
reason sahəsini AZƏRBAYCAN DİLİNDƏ, söhbətdəki konkret şeyə istinadla yaz.

--- identity ---
Bu söhbətlərin çoxunda qarşı tərəfin nömrəsi bizə GÖRÜNMÜR (WhatsApp @lid gizlədir) və satıcı lentdə kimin gözlədiyini bilmir. Ona görə hər söhbət üçün qarşı tərəfin ÖZÜ haqqında DEDİYİ məlumatı da çıxar:

statedName — özünü və ya firmasını necə təqdim edib ("Mən Leyla", "Gəncədən Nurlan", "Bella Moda mağazası"). Yazıldığı kimi köçür.
city — özünün harada olduğunu deyibsə (şəhər/ölkə). Bizim ünvanımız YOX, onunku.
orderCode — bu söhbətə aid sifariş/qaimə/izləmə kodu.
note — yuxarıdakılara sığmayan qısa tanıdıcı detal (məsələn "toy üçün alan", "hər ay alan mağaza").

QAYDA: yalnız mətndə AÇIQ deyilən. Təxmin etmə, çıxarış etmə, uydurma. Deyilməyibsə null yaz. Qarşı tərəfin BİZİM işçimiz haqqında dedikləri onun kimliyi deyil. Şübhə varsa null.`;

export interface StaleChat {
  jid: string;
  lastMessageTs: number;
}

/**
 * Yenidən təsnif olunmalı söhbətlər: pəncərədə mesajı olan VƏ (heç halı
 * yoxdur VƏ YA halından sonra təzə mesaj gəlib). Dəyişməyənlər siyahıya
 * düşmür — sabit rejimdə bu, saatda bir ovuc söhbətdir.
 *
 * Dairə detektorlarla eynidir (clientScopeSql): tədarükçü/istehsalat söhbətini
 * təsnif etmək çıxarılmış pul deməkdir — nəticəsinə onsuz da heç bir detektor
 * baxmayacaq.
 */
export async function findStaleChats(
  instanceId: ScopedInstanceId,
  {
    sinceDays,
    limit,
    missingIdentity = false,
    flaggedOnly = false,
  }: { sinceDays: number; limit: number; missingIdentity?: boolean; flaggedOnly?: boolean },
): Promise<StaleChat[]> {
  // missingIdentity: kimlik backfill-i. Adi şərt "halı köhnəlib"dir, amma
  // kimlik sahələri hal təsnifatından SONRA əlavə olundu — artıq təsnif
  // olunmuş 1300 söhbət heç vaxt yenidən oxunmayacaqdı, yəni ipucusuz
  // qalacaqdı. Bu rejim onları bir dəfə gəzir. chat_identity sətri olan
  // söhbət (boş sətir də daxil) təkrar götürülmür.
  // flaggedOnly: açıq bayrağı olan söhbətləri halı TƏZƏ olsa da yenidən oxu.
  // Adi şərt "hal köhnəlib"dir və yeni bir hal əlavə olunanda kifayət etmir:
  // dünən RESOLVED yazılmış söhbət heç vaxt yenidən oxunmayacaq, deməli
  // FORWARDED_TO_BRANCH kimi sonradan gələn hallar köhnə söhbətlərə heç vaxt
  // yapışmazdı. Bu rejim məhz bayraq daşıyanları — yəni qiyməti olanları —
  // bir dəfə gəzir.
  const staleCond = missingIdentity
    ? `NOT EXISTS (SELECT 1 FROM katibe.chat_identity ci WHERE ci.remote_jid = a.jid)`
    : flaggedOnly
      ? `EXISTS (SELECT 1 FROM katibe.agent_posts p
                 WHERE p.instance_id = $1 AND p.remote_jid = a.jid
                   AND p.acknowledged_at IS NULL AND p.kind = 'finding')`
      : `cs.remote_jid IS NULL OR a.last_ts > cs.last_message_ts`;
  // Adi rejimdə sıra "ən təzə əvvəl"dir — düzgündür, çünki halın köhnəlməsi
  // vaxtla bağlıdır. Backfill-də isə bu TƏRSİNƏ işləyir: LID eşlənməsi məhz
  // trafiklə yığılır, ona görə ən təzə söhbətlərin nömrəsi ONSUZ DA var və
  // növbənin başını tutur (ölçmə: ilk 75 söhbətin 75-i tanınmış LID idi).
  // Heç nə ilə tanınmayanlar — işin bütün məqsədi — sona qalırdı. Backfill-də
  // əvvəl nömrəsi OLMAYANLAR gəlir; iş yarımçıq kəsilsə belə, pul ən çox
  // ehtiyacı olan söhbətlərə xərclənmiş olur.
  const order = missingIdentity
    ? `(EXISTS (SELECT 1 FROM katibe.lid_number ln2 WHERE ln2.lid_jid = a.jid)
        OR a.jid LIKE '%@s.whatsapp.net') ASC, a.last_ts DESC`
    : `a.last_ts DESC`;
  const { rows } = await pool.query(
    `WITH active AS (
       SELECT m.key->>'remoteJid' AS jid, MAX(m."messageTimestamp") AS last_ts
       FROM evolution_api."Message" m
       WHERE m."instanceId" = $1
         AND (m.key->>'remoteJid' LIKE '%@s.whatsapp.net' OR m.key->>'remoteJid' LIKE '%@lid')
         AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
         AND m."messageTimestamp" > EXTRACT(epoch FROM now() - make_interval(days => $2::int))::int
         AND ${clientScopeSql("m.key->>'remoteJid'")}
       GROUP BY 1
     )
     SELECT a.jid, a.last_ts
     FROM active a
     LEFT JOIN katibe.chat_state cs
       ON cs.instance_id = $1 AND cs.remote_jid = a.jid
     WHERE ${staleCond}
     ORDER BY ${order}
     LIMIT $3`,
    [instanceId, sinceDays, limit],
  );
  return rows.map((r) => ({ jid: r.jid, lastMessageTs: Number(r.last_ts) }));
}

export interface TranscriptBlock {
  jid: string;
  lastMessageTs: number;
  text: string;
  messageCount: number;
}

/**
 * Son N mesaj, yalnız mətn (səs transkripti mətn sayılır), yaş nişanı ilə.
 *
 * `limit` parametri verify.ts üçün açıldı: bayrağı doğrulayan çağırış son 15
 * mesajı oxuyur, hal təsnifatı isə 30-u. Sorğunun özü eynidir — iki yerdə iki
 * fərqli "söhbəti oxu" yazmaq, birində səs transkriptini join etməyi
 * unutmağın ən qısa yoludur.
 */
export async function fetchTranscripts(
  instanceId: ScopedInstanceId,
  chats: StaleChat[],
  limit: number = MESSAGES_PER_CHAT,
): Promise<TranscriptBlock[]> {
  const blocks: TranscriptBlock[] = [];
  for (const c of chats) {
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT (m.key->>'fromMe')::boolean AS from_me,
                COALESCE(m.message->>'conversation',
                         m.message->'extendedTextMessage'->>'text',
                         m.message->'imageMessage'->>'caption',
                         m.message->'videoMessage'->>'caption',
                         vt.text) AS text,
                m."messageTimestamp" AS ts
         FROM evolution_api."Message" m
         LEFT JOIN katibe.voice_transcript vt ON vt.message_id = m.id AND vt.status = 'ok'
         WHERE m."instanceId" = $1 AND m.key->>'remoteJid' = $2
           AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
         ORDER BY m."messageTimestamp" DESC LIMIT $3
       ) r WHERE r.text IS NOT NULL AND r.text <> '' ORDER BY ts ASC`,
      [instanceId, c.jid, limit],
    );
    if (rows.length === 0) continue;
    const nowSec = Math.floor(Date.now() / 1000);
    const lines = rows.map((m) => {
      const age = formatDuration(Math.max(0, nowSec - Number(m.ts)));
      return `[${age} əvvəl] ${m.from_me ? "BİZ" : "QARŞI TƏRƏF"}: ${String(m.text).slice(0, MAX_CHARS_PER_MESSAGE)}`;
    });
    blocks.push({
      jid: c.jid,
      lastMessageTs: c.lastMessageTs,
      text: `### ${c.jid}\n${lines.join("\n")}`,
      messageCount: rows.length,
    });
  }
  return blocks;
}

/*
 * WhatsApp mətnlərində tək qalmış surroqat kod nöqtələri olur (yarımçıq
 * emoji). JSON.stringify onları olduğu kimi buraxır, API isə gövdəni oxuya
 * bilmir və bütün partiya 400 ilə itir — backfill-də iki partiya məhz belə
 * itmişdi. Cütü olmayan surroqat əvəzedici simvolla dəyişdirilir.
 */
export function stripLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

async function callModel(model: string, input: string): Promise<{ parsed: z.infer<typeof StateSchema>; inTok: number; outTok: number }> {
  const client = new Anthropic();
  const modern = !/haiku-4-5|sonnet-4-5/.test(model);
  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    ...(modern ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: {
      ...(modern ? { effort: "medium" as const } : {}),
      format: zodOutputFormat(StateSchema),
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: stripLoneSurrogates(input) }],
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("model returned no parsed output");
  return { parsed: StateSchema.parse(parsed), inTok: response.usage.input_tokens, outTok: response.usage.output_tokens };
}

export interface ClassifyStats {
  classified: number;
  escalated: number;
  failedBatches: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// $/MTok — scripts/identify-clients.ts-dəki cədvəllə eyni.
const PRICE: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5": [2, 10],
  "claude-opus-5": [5, 25],
};

function costOf(model: string, inTok: number, outTok: number): number {
  const [pin, pout] = PRICE[model] ?? [0, 0];
  return (inTok / 1e6) * pin + (outTok / 1e6) * pout;
}

/**
 * Modelin söhbətdən oxuduğu kimlik ipuclarını saxlayır.
 *
 * Sahə-sahə COALESCE: ad bir söhbətdə, şəhər aylar sonra başqa mesajda üzə
 * çıxa bilər, ona görə boş cavab əvvəl öyrənilmiş dəyəri SİLMİR. Hamısı null
 * gələndə (adi hal — söhbətlərin çoxunda adam özü haqqında heç nə demir)
 * ümumiyyətlə sorğu getmir.
 *
 * remote_jid ilə açarlanır, instansla yox: adam eyni adamdır. source_instance_id
 * yalnız mənbəni göstərir — dairə məhdudiyyəti deyil.
 */
async function saveIdentity(
  instanceId: ScopedInstanceId,
  jid: string,
  identity: z.infer<typeof StateSchema>["results"][number]["identity"] | undefined,
  // ^ nullable in the schema too: a batch must never be lost because the model
  //   had nothing to say about who someone is.
  confidence: string,
  model: string,
): Promise<void> {
  const clean = (v: string | null | undefined) => {
    const t = (v ?? "").trim();
    // Model bəzən boşluğu "null"/"yoxdur" sözü ilə doldurur; onlar dəyər deyil.
    if (!t || /^(null|none|n\/a|yoxdur|bilinmir|—|-)$/i.test(t)) return null;
    return t.slice(0, 120);
  };
  const statedName = clean(identity?.statedName);
  const city = clean(identity?.city);
  const orderCode = clean(identity?.orderCode);
  const note = clean(identity?.note);
  // Boş nəticədə də SƏTİR yazılır. "Baxdıq, heç nə demirdi" ilə "heç baxmadıq"
  // fərqlənməlidir — yoxsa özü haqqında heç nə deməyən müştəri hər backfill-də
  // yenidən pul xərcləyər. Sahələr NULL qalır, sonrakı gedişat COALESCE ilə
  // doldura bilər.

  await pool.query(
    `INSERT INTO katibe.chat_identity
       (remote_jid, stated_name, city, order_code, note, confidence, model, source_instance_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (remote_jid) DO UPDATE SET
       stated_name = COALESCE(EXCLUDED.stated_name, katibe.chat_identity.stated_name),
       city        = COALESCE(EXCLUDED.city,        katibe.chat_identity.city),
       order_code  = COALESCE(EXCLUDED.order_code,  katibe.chat_identity.order_code),
       note        = COALESCE(EXCLUDED.note,        katibe.chat_identity.note),
       confidence  = EXCLUDED.confidence,
       model       = EXCLUDED.model,
       source_instance_id = COALESCE(katibe.chat_identity.source_instance_id, EXCLUDED.source_instance_id),
       updated_at  = now()`,
    [jid, statedName, city, orderCode, note, confidence, model, instanceId],
  );
}

/**
 * Verilmiş söhbətləri təsnif edib katibe.chat_state-ə yazır.
 * LOW confidence çıxanlar bir dəfə Sonnet-ə təkrar göndərilir; onun cavabı
 * (confidence nə olur olsun) son sözdür. Partiya xətası tapıntı itirmir —
 * yazılmamış söhbət növbəti gedişatda yenə "stale" sayılır.
 */
export async function classifyChats(
  instanceId: ScopedInstanceId,
  chats: StaleChat[],
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<ClassifyStats> {
  const stats: ClassifyStats = {
    classified: 0,
    escalated: 0,
    failedBatches: 0,
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  const blocks = await fetchTranscripts(instanceId, chats);

  if (dryRun) {
    const chars = blocks.reduce((n, b) => n + b.text.length, 0);
    const calls = Math.ceil(blocks.length / CHATS_PER_CALL);
    console.log(
      `  [dry] ${blocks.length} söhbət, ${calls} çağırış, ~${Math.round(chars / 3.5) + calls * 1200} giriş token (göndərilmədi)`,
    );
    return stats;
  }

  for (let i = 0; i < blocks.length; i += CHATS_PER_CALL) {
    const batch = blocks.slice(i, i + CHATS_PER_CALL);
    const byJid = new Map(batch.map((b) => [b.jid, b]));
    type Verdict = z.infer<typeof StateSchema>["results"][number] & { model: string };
    let verdicts: Verdict[] = [];

    try {
      const first = await callModel(HAIKU_MODEL, batch.map((b) => b.text).join("\n\n"));
      stats.llmCalls++;
      stats.inputTokens += first.inTok;
      stats.outputTokens += first.outTok;
      stats.costUsd += costOf(HAIKU_MODEL, first.inTok, first.outTok);

      const low = first.parsed.results.filter((r) => r.confidence === "LOW" && byJid.has(r.jid));
      verdicts = first.parsed.results
        .filter((r) => r.confidence !== "LOW")
        .map((r) => ({ ...r, model: HAIKU_MODEL }));

      if (low.length > 0) {
        // Haiku əmin deyil — həmin söhbətlər Sonnet-ə. Sonnet də LOW desə,
        // LOW olaraq yazılır: detektorlar LOW halı ehtiyatla işlədir.
        try {
          const esc = await callModel(
            ESCALATE_MODEL,
            low.map((r) => byJid.get(r.jid)!.text).join("\n\n"),
          );
          stats.llmCalls++;
          stats.inputTokens += esc.inTok;
          stats.outputTokens += esc.outTok;
          stats.costUsd += costOf(ESCALATE_MODEL, esc.inTok, esc.outTok);
          stats.escalated += low.length;
          verdicts = verdicts.concat(esc.parsed.results.map((r) => ({ ...r, model: ESCALATE_MODEL })));
        } catch (err) {
          console.error("  eskalasiya alınmadı, Haiku LOW nəticələri saxlanılır:", err instanceof Error ? err.message : err);
          verdicts = verdicts.concat(low.map((r) => ({ ...r, model: HAIKU_MODEL })));
        }
      }
    } catch (err) {
      stats.failedBatches++;
      console.error(`  partiya alınmadı (${batch.length} söhbət keçildi):`, err instanceof Error ? err.message : err);
      continue;
    }

    for (const v of verdicts) {
      const b = byJid.get(v.jid);
      if (!b) continue;
      await pool.query(
        `INSERT INTO katibe.chat_state
           (instance_id, remote_jid, state, confidence, reason, model, last_message_ts, message_count, classified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (instance_id, remote_jid) DO UPDATE SET
           state = EXCLUDED.state,
           confidence = EXCLUDED.confidence,
           reason = EXCLUDED.reason,
           model = EXCLUDED.model,
           last_message_ts = EXCLUDED.last_message_ts,
           message_count = EXCLUDED.message_count,
           classified_at = now()`,
        [instanceId, v.jid, v.state, v.confidence, v.reason, v.model, b.lastMessageTs, b.messageCount],
      );
      await saveIdentity(instanceId, v.jid, v.identity, v.confidence, v.model);
      stats.classified++;
    }
  }
  return stats;
}
