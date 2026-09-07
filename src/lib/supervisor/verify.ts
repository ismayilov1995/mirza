import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { pool } from "../db";
import { formatDuration } from "../format";
import { fetchTranscripts, stripLoneSurrogates } from "./chat-state";
import type { ScopedInstanceId } from "../access";
import type { Finding } from "./types";

/*
 * Bayrağın DOĞRULANMASI — söhbəti oxuyan ikinci rəy.
 *
 * Detektorlar rəqəm sayır: "son mesaj qarşı tərəfdəndir, 43 saatdır cavab
 * getməyib". Bu doğrudur və çox vaxt kifayətdir, amma bəzən söhbəti oxuyan
 * adam dərhal görür ki, müştəri onsuz da cavab gözləmir — məsələ bağlanıb,
 * ya son mesaj sadəcə "sağ olun" idi, ya da razılaşdığımız kimi topu o
 * saxlayır. O fərqi yalnız MƏTN göstərir.
 *
 * DAİRƏ QƏSDƏN DARDIR (sahibin qərarı, 2026-08-26): yalnız Client kateqoriyalı
 * VƏ baza balı 6+ olan söhbətlər. Yəni doğrulama praktikada `unanswered`
 * detektorunun sancaqlanan tapıntılarına düşür — instans səviyyəli postlarda
 * (silence, customer_deciding siyahısı) oxunacaq bir söhbət yoxdur.
 *
 * NƏTİCƏ BAYRAĞI SİLMİR. "Cavab gözləmir" + HIGH əminlik balı 5-ə endirir —
 * lentin "diqqət" zolağı, yəni post hələ də görünür, sadəcə sancaqdan çıxır.
 * Model səhv edibsə, səhv gözlə görünən yerdə qalır. Bağlamaq hələ də yalnız
 * insanın işidir (severity.ts-dəki qayda pozulmur, yanına dar bir yol açılır).
 *
 * SUSDURMA YOXLAMASI da buradadır, eyni çağırışın içində: söhbətə artıq
 * reytinq 1 verilibsə, model saxlanmış xülasə ilə HAZIRKI son mesajları
 * müqayisə edir. Ayrıca çağırış açmaq iki dəfə eyni transkripti göndərmək
 * olardı.
 *
 * KEŞ: nəticə posta yazılır (verify_inbound_ts). Söhbətə təzə mesaj gəlməyibsə
 * eyni bayraq bir daha doğrulanmır — saatlıq gedişat eyni cavaba təkrar pul
 * verməsin.
 */

/** Doğrulama həmişə güclü modeldədir: bu, təsnifat yox, mühakimədir. */
export const VERIFY_MODEL = process.env.SUP_VERIFY_MODEL || "claude-sonnet-5";

/** Sahibin göstərişi: son 15 mesaj. */
const MESSAGES_PER_CHAT = 15;

/** Bir çağırışa neçə söhbət. 15 mesajlıq bloklar kiçikdir, 6 rahat yerləşir. */
const CHATS_PER_CALL = 6;

/** Bu baldan aşağı tapıntı doğrulanmır — sancaqlanmayan bayraq üçün pul verməyə dəyməz. */
const VERIFY_MIN_SEVERITY = 6;

/**
 * Doğrulamanın ömrü.
 *
 * Əsas keş açarı lastInboundTs-dir: təzə mesaj yoxdursa cavab da dəyişə
 * bilməz. Bir şey isə mesajsız da dəyişir — GÖZLƏMƏ VAXTI. Müştəri bir daha
 * yazmasa belə, baza balı saatlar keçdikcə qalxır; ömürsüz keşdə "cavab
 * gözləmir" qərarı həmin söhbəti əbədi 5-də dondurardı. Ona görə hər 12
 * saatdan bir yenidən soruşulur: ilişib qalmış bayraq üçün gündə iki əlavə
 * çağırış, hesablana bilən tavan.
 */
const VERDICT_TTL_HOURS = Number(process.env.SUP_VERIFY_TTL_HOURS ?? 12);

/** "Cavab gözləmir" təsdiqlənəndə bal bura enir: hələ görünən, amma sancaqsız. */
export const VERIFIED_NOT_WAITING_SEVERITY = 5;

export const VERIFY_STATES = ["WAITING", "NOT_WAITING", "UNCLEAR"] as const;
export type VerifyState = (typeof VERIFY_STATES)[number];

const VerifySchema = z.object({
  results: z.array(
    z.object({
      jid: z.string().describe("The chat id, copied exactly from the input."),
      state: z
        .enum(VERIFY_STATES)
        .describe(
          "WAITING = the other side is genuinely waiting for a reply from us. NOT_WAITING = they are not: the matter is closed, the last message needed no answer, or the ball is deliberately on their side. UNCLEAR = the messages do not settle it.",
        ),
      confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
      reason: z
        .string()
        .describe("One or two short Azerbaijani sentences citing the concrete message that decided it."),
      sameAsDismissed: z
        .boolean()
        .nullable()
        .describe(
          "Only when dismissedSummary is present in the input: true if the situation now is materially the same as the one the manager already dismissed, false if something new has happened since. null when there is no dismissedSummary.",
        ),
    }),
  ),
});

const SYSTEM_PROMPT = `Sən Dubay/Azərbaycan əsaslı parça və tekstil topdansatış şirkətinin WhatsApp söhbətlərini oxuyursan. Mesajlar Azərbaycan, türk, ingilis, ərəb və rus dillərində ola bilər. "BİZ" — şirkətin satıcısıdır, "QARŞI TƏRƏF" — müştəridir. Hər mesajın qabağında nə vaxt yazıldığı göstərilir.

Avtomatik sistem bu söhbətləri "cavabsız qalıb" deyə bayraqlayıb — çünki son mesaj qarşı tərəfdəndir və üstündən çox vaxt keçib. Sənin işin O RƏQƏMİ YOX, MƏTNİ oxumaqdır və bir suala cavab verməkdir:

**Qarşı tərəf HƏQİQƏTƏN bizdən cavab gözləyir?**

WAITING — bəli: açıq sual, sifariş, qiymət istəyi, şikayət və ya təsdiq gözləyən şey var və biz cavab verməmişik.
NOT_WAITING — xeyr. Tipik hallar: mövzu bağlanıb (razılaşma bitib, mal göndərilib, ödəniş olunub); son mesaj sadəcə nəzakətdir ("ok", "sağ olun", "gözləyirəm", emoji, salam); topu qəsdən onlar saxlayır (biz qiymət vermişik, onlar düşünür və "baxıb yazaram" deyiblər); ya da qarşı tərəf özü "sonra yazaram / hələ lazım deyil" deyib.
UNCLEAR — mətn qısadır, kontekst çatmır, əmin deyilsən.

VERDİYİMİZ SÖZ DƏ GÖZLƏMƏDİR. "Ok" cavabının iki tam fərqli mənası var və
fərqi görmək bu işin ən vacib hissəsidir:

  • BİZ nəsə vəd etmişik — "eskizi hazırlayıb yazacağam", "qiyməti öyrənib
    xəbər verəcəyəm", "manequini hazırlayırıq", "nömrənizi göndərirəm" — və
    müştəri "Ok, təşəkkür" yazıb. Bu, WAITING-dir. Müştəri sual vermir, çünki
    ARXAYINDIR: söz bizdədir və o, sözün yerinə yetirilməsini gözləyir. Onun
    susması bağlanma yox, etibardır.
  • BİZ qiymət/nümunə/variant vermişik və TOP ONDADIR — qərar verməli olan
    odur. Bu, NOT_WAITING-dir.

Yəni sual "müştəri sual verirmi" deyil, "İŞ KİMİN TƏRƏFİNDƏDİR". Bizim
tərəfimizdədirsə — WAITING.

ÖZ CÜMLƏNLƏ ZİDDİYYƏT QADAĞANDIR. reason sahəsində "top bizim tərəfdədir",
"növbə bizdədir", "biz göndərməliyik" kimi bir şey yazırsansa, state MÜTLƏQ
WAITING olmalıdır. Ölçüldü: 51 "gözləmir" qərarının 4-ündə səbəb məhz bunu
deyirdi, yəni model öz cavabını özü təkzib edirdi — və həmin söhbətlərin
yarısında müştəri bir saat keçməmiş yenidən yazdı.

QAYDA: şübhə varsa WAITING və ya UNCLEAR seç. Səhvlərin qiyməti bərabər deyil — səhvən qalan bayraq bir kliklə bağlanır, səhvən söndürülən bayraq isə heç vaxt görünmür və müştəri itir. HIGH əminliyi yalnız mətn birmənalı olanda ver.

confidence: HIGH — qərar mətndən birbaşa oxunur; MEDIUM — güclü ehtimal; LOW — əmin deyilsən.
reason sahəsini AZƏRBAYCAN DİLİNDƏ yaz və söhbətdəki konkret mesaja istinad et. Sistemin daxili kodlarını (WAITING, NOT_WAITING və s.) mətnə yazma.

--- əvvəl rədd edilmiş bayraqlar ---
Bəzi söhbətlərdə girişdə "dismissedSummary" olacaq: menecer əvvəl həmin söhbətdə eyni tipli bayrağı "lazımsız" deyə rədd edib. Sənin əlavə işin sameAsDismissed sahəsidir — söhbətin HAZIRKI vəziyyəti həmin rədd edilmiş vəziyyətlə mahiyyətcə eynidirmi (true), yoxsa ondan sonra yeni bir şey baş verib (false)? Yeni sual, yeni sifariş, artan narazılıq, dəyişən mövzu — hamısı false deməkdir. dismissedSummary yoxdursa null yaz.`;

export interface VerifyCandidate {
  jid: string;
  contact: string | null;
  detector: string;
  dedupeKey: string;
  baseSeverity: number;
  /** Son GƏLƏN mesajın vaxtı — həm keş açarı, həm promptdakı gözləmə hesabı. */
  lastInboundTs: number;
  evidence: Record<string, unknown>;
  /** Bu söhbətdə qüvvədə olan susdurma varsa, onun xülasəsi. */
  dismissedSummary?: string;
}

export interface VerifyVerdict {
  state: VerifyState;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  /** Yalnız dismissedSummary verilmiş söhbətlərdə mənalıdır. */
  sameAsDismissed: boolean | null;
  model: string;
  /** Doğrulama anındakı son gələn mesaj — posta keş açarı kimi yazılır. */
  inboundTs: number;
}

export interface VerifyStats {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Keşdən gələn (yəni pulsuz) doğrulamaların sayı. */
  cached: number;
  failedBatches: number;
}

export function emptyVerifyStats(): VerifyStats {
  return { llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, cached: 0, failedBatches: 0 };
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
 * Tapıntı doğrulanmalıdırmı?
 *
 * İki qapı, hər ikisi sahibin qərarı: Client kateqoriyalı VƏ 6+ bal. Susdurma
 * yoxlaması ayrıca yoldur (gateFindings) — orada bal şərti yoxdur, çünki
 * susdurulmuş söhbətdə sual "bayraq düzdürmü" yox, "vəziyyət dəyişibmi"dir.
 */
export function needsVerification(finding: Finding): boolean {
  return (
    finding.jid !== null &&
    finding.baseSeverity >= VERIFY_MIN_SEVERITY &&
    finding.evidence.isClient === true &&
    typeof finding.evidence.lastInboundTs === "number"
  );
}

/**
 * Açıq postlara yazılmış köhnə doğrulamalar.
 *
 * Açar dedupe_key-dir, post ID-si yox: gedişat postu yazmazdan ƏVVƏL
 * doğrulayır, ona görə əlində hələ ID yoxdur.
 */
export async function loadCachedVerdicts(
  agent: string,
  instanceId: string,
  dedupeKeys: string[],
): Promise<Map<string, VerifyVerdict>> {
  const map = new Map<string, VerifyVerdict>();
  if (dedupeKeys.length === 0) return map;
  const { rows } = await pool.query(
    `SELECT dedupe_key, verify_state, verify_confidence, verify_reason, verify_model, verify_inbound_ts
     FROM katibe.agent_posts
     WHERE agent = $1 AND instance_id = $2 AND acknowledged_at IS NULL
       AND dedupe_key = ANY($3::text[]) AND verify_state IS NOT NULL
       AND verified_at > now() - make_interval(hours => $4::int)`,
    [agent, instanceId, dedupeKeys, VERDICT_TTL_HOURS],
  );
  for (const r of rows) {
    map.set(String(r.dedupe_key), {
      state: r.verify_state as VerifyState,
      confidence: r.verify_confidence as VerifyVerdict["confidence"],
      reason: String(r.verify_reason ?? ""),
      sameAsDismissed: null,
      model: String(r.verify_model ?? VERIFY_MODEL),
      inboundTs: Number(r.verify_inbound_ts ?? 0),
    });
  }
  return map;
}

async function callModel(
  model: string,
  input: string,
): Promise<{ parsed: z.infer<typeof VerifySchema>; inTok: number; outTok: number }> {
  const client = new Anthropic();
  // Adaptiv düşünmə və `effort` 4.6 nəslindəndir; 4.5 modelləri 400 qaytarır
  // (bax chat-state.ts və identify-clients.ts-dəki eyni qorumaya).
  const modern = !/haiku-4-5|sonnet-4-5/.test(model);
  const response = await client.messages.parse({
    model,
    max_tokens: 8000,
    ...(modern ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: {
      // Bu, axtarış yox, mühakimədir — söhbəti çəkib-ölçmək lazımdır.
      ...(modern ? { effort: "high" as const } : {}),
      format: zodOutputFormat(VerifySchema),
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: stripLoneSurrogates(input) }],
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("model returned no parsed output");
  return {
    parsed: VerifySchema.parse(parsed),
    inTok: response.usage.input_tokens,
    outTok: response.usage.output_tokens,
  };
}

/**
 * Verilmiş namizədləri doğrulayır. Keşə BURADA baxılmır — çağıran onu
 * gateFindings-də edir, çünki keş açarını (lastInboundTs) yalnız o bilir.
 */
export async function verifyCandidates(
  instanceId: ScopedInstanceId,
  candidates: VerifyCandidate[],
  stats: VerifyStats,
  {
    dryRun = false,
    hints = null,
    maxCalls = Infinity,
  }: { dryRun?: boolean; hints?: string | null; maxCalls?: number } = {},
): Promise<Map<string, VerifyVerdict>> {
  const verdicts = new Map<string, VerifyVerdict>();
  if (candidates.length === 0) return verdicts;

  const blocks = await fetchTranscripts(
    instanceId,
    candidates.map((c) => ({ jid: c.jid, lastMessageTs: c.lastInboundTs })),
    MESSAGES_PER_CHAT,
  );
  const byJid = new Map(candidates.map((c) => [c.jid, c]));
  const nowSec = Math.floor(Date.now() / 1000);

  const renderBlock = (jid: string, transcript: string): string => {
    const c = byJid.get(jid)!;
    const head = {
      jid,
      contact: c.contact,
      waited: formatDuration(Math.max(0, nowSec - c.lastInboundTs)),
      msgsWaiting: c.evidence.msgsWaiting ?? null,
      dismissedSummary: c.dismissedSummary ?? null,
    };
    return `### ${jid}\n${JSON.stringify(head)}\n${transcript}`;
  };

  // fetchTranscripts blokun içinə "### <jid>" başlığını özü yazır; burada
  // ondan sonrakı hissə götürülüb öz başlığımızla birləşdirilir, yoxsa iki
  // başlıq üst-üstə düşərdi.
  const rendered = blocks
    .filter((b) => byJid.has(b.jid))
    .map((b) => renderBlock(b.jid, b.text.split("\n").slice(1).join("\n")));

  if (dryRun) {
    const chars = rendered.reduce((n, t) => n + t.length, 0);
    const calls = Math.ceil(rendered.length / CHATS_PER_CALL);
    console.log(
      `  [dry] doğrulama: ${rendered.length} söhbət, ${calls} ${VERIFY_MODEL} çağırışı, ` +
        `~${Math.round(chars / 3.5) + calls * 900} giriş token (göndərilmədi)`,
    );
    return verdicts;
  }

  for (let i = 0; i < rendered.length; i += CHATS_PER_CALL) {
    const batch = rendered.slice(i, i + CHATS_PER_CALL);
    // Xərc tavanı. Dolanda qalan söhbətlər DOĞRULANMIR — yəni bayraqları
    // olduğu kimi, sancaqlı qalır. Tavanın işə düşməsi heç vaxt bayraq
    // söndürmür, yalnız ikinci rəyi növbəti gedişata saxlayır.
    if (stats.llmCalls >= maxCalls) {
      console.warn(
        `  doğrulama tavanı (${maxCalls}) doldu — ${rendered.length - i} söhbət bu gedişatda doğrulanmadı.`,
      );
      break;
    }
    try {
      // Menecerin əvvəlki qiymətləri (ratings.ts) partiyanın BAŞINA qoyulur:
      // model söhbətləri oxumazdan əvvəl bu evdə nəyin lazımsız sayıldığını
      // bilsin.
      const res = await callModel(
        VERIFY_MODEL,
        hints ? `${hints}\n\n${batch.join("\n\n")}` : batch.join("\n\n"),
      );
      stats.llmCalls++;
      stats.inputTokens += res.inTok;
      stats.outputTokens += res.outTok;
      stats.costUsd += costOf(VERIFY_MODEL, res.inTok, res.outTok);
      for (const r of res.parsed.results) {
        const c = byJid.get(r.jid);
        if (!c) continue;
        verdicts.set(c.dedupeKey, {
          state: r.state,
          confidence: r.confidence,
          reason: r.reason,
          sameAsDismissed: r.sameAsDismissed,
          model: VERIFY_MODEL,
          inboundTs: c.lastInboundTs,
        });
      }
    } catch (err) {
      // Doğrulama alınmasa bayraq OLDUĞU KİMİ qalır — sancaqlı. Çağırışın
      // uğursuzluğu heç vaxt bayrağı söndürmür.
      stats.failedBatches++;
      console.error(
        `  doğrulama partiyası alınmadı (${batch.length} söhbət, bayraqlar toxunulmaz qaldı):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return verdicts;
}

/**
 * Doğrulamanın bala təsiri.
 *
 * YEGANƏ yol ki, model 6+ balı bayraq həddinin altına endirə bilir — və o da
 * yalnız söhbəti oxumuş, HIGH əminlikli "cavab gözləmir" cavabı ilə. Qalan
 * hər şey (MEDIUM, LOW, UNCLEAR, WAITING) balı olduğu kimi saxlayır.
 * severity.ts-dəki applyAdjustment qaydası pozulmur: ora rəqəmlərə baxan
 * şərh modelidir, bura isə mətni oxuyan ayrıca çağırış.
 */
export function applyVerification(severity: number, verdict: VerifyVerdict | null): number {
  if (!verdict) return severity;
  if (verdict.state !== "NOT_WAITING" || verdict.confidence !== "HIGH") return severity;
  return Math.min(severity, VERIFIED_NOT_WAITING_SEVERITY);
}

export const VERIFY_STATE_LABELS: Record<VerifyState, string> = {
  WAITING: "cavab gözləyir",
  NOT_WAITING: "cavab gözləmir",
  UNCLEAR: "aydın deyil",
};
