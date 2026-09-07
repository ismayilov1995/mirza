import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { formatDuration } from "../format";
import type { Finding, WindowDigest } from "./types";

// Bir instans üçün BİR çağırış: model bütün tapıntıları bir yerdə görür və
// hər birinə lent mətni yazır. Tapıntı başına ayrıca çağırış həm baha olardı,
// həm də "üç söhbət eyni anda gözləyir" kimi mənzərəni modeldən gizlədərdi.
//
// Model rəqəm İCAD ETMİR: severity deterministik düsturdan gəlir, buradan ən
// çoxu ±2 düzəliş çıxa bilir və səbəb sahəsi məcburidir. Çağırış alınmasa
// templates.ts işə düşür — tapıntı heç vaxt itmir.

export const DEFAULT_MODEL = process.env.SUP_MODEL || "claude-haiku-4-5";
// Baza balı 8+ olan tapıntı Sonnet-ə gedir: ciddi vəziyyətin şərhi ucuz
// modelin ən çox səhv elədiyi yerdir.
export const HIGH_MODEL = process.env.SUP_MODEL_HIGH || "claude-sonnet-5";

const CommentarySchema = z.object({
  perFinding: z.array(
    z.object({
      dedupeKey: z.string().describe("Copied exactly from the input finding."),
      body: z
        .string()
        .describe(
          "1-3 sentences in Azerbaijani for the manager's feed: what is happening and why it matters. Only facts from the evidence — no invented numbers or names.",
        ),
      severityAdjust: z
        .number()
        .int()
        .min(-2)
        .max(0)
        .describe(
          "Downward-only adjustment to the deterministic severity, usually 0. Negative only when the evidence clearly shows the finding is less serious than the formula thinks.",
        ),
      adjustReason: z
        .string()
        .describe("One short Azerbaijani sentence explaining a non-zero adjustment. Empty string when severityAdjust is 0."),
    }),
  ),
});

export type Commentary = z.infer<typeof CommentarySchema>;

const SYSTEM_PROMPT = `Sən Dubay/Azərbaycan əsaslı parça və tekstil topdansatış şirkətində satış komandasına nəzarət edən köməkçisən. Adın Nəzarətçidir. Menecerin dashboard lentinə qısa müşahidələr yazırsan.

Sənə bir satıcının son pəncərəsinin İCMALI və deterministik detektorların TAPINTILARI verilir (JSON). Hər tapıntı üçün:
1. body — menecerə ünvanlanmış 1-3 cümləlik canlı, konkret müşahidə. Rəqəmləri sübutdan götür, adları çək. Quru "gecikmə var" yazma — "Aysel 6 saatdır gözləyir, 4 mesaj yazıb, səbri daralır" kimi yaz.
2. severityAdjust — adətən 0. Balı YALNIZ AZALDA bilərsən (-1/-2), artıra bilməzsən: rəqəmi deterministik düstur verir, sən ondan azını görürsən. Yalnız sübut açıq-aydın göstərirsə azalt — məsələn hal texniki görünür və real risk daşımır.
3. adjustReason — düzəliş 0 deyilsə SƏBƏBİNİ bir cümlə ilə yaz.

MÖVZU ƏN VACİBİDİR. Bəzi tapıntıların sübutunda chatSummary sahəsi olur —
söhbəti oxumuş təsnifatın bir cümləlik izahı: müştəri NƏ istəyib və bizdən nə
qalıb ("ölçülərini göndərib, qiymət və detal foto gözləyir"). Varsa, cümləyə
ONDAN BAŞLA, saatdan yox.

Səbəb sadədir: "3 saatdır cavab gözləyir" menecerin lentdə onsuz da gördüyü
rəqəmdir, onu sözlə təkrarlamaq sətri boş yerə uzadır. Menecerin bilmədiyi —
söhbətin NƏ barədə olduğudur. Düzgün: "Anoud ölçülərini və lining seçimini
göndərib, qiymət gözləyir — 3 saatdır cavab yoxdur." Yanlış: "Anoud 3 saat 26
dəqiqədir cavab gözləyir və status «bizdən cavab gözləyir»dir."

chatSummary yoxdursa mövzudan DANIŞMA — onu təxmin etmək qadağandır; belə
halda rəqəmlərlə kifayətlən.

TARİXÇƏ. Bəzi tapıntıların sübutunda history sahəsi olur — həmin müştərinin
KEÇMİŞİNDƏN gətirilmiş oxşar anlar, tarixi ilə. Varsa, ONDAN İSTİFADƏ ET:
"Aysel iyulun 12-də də eyni gecikmədən yazmışdı" kimi. Menecerin ehtiyacı olan
məhz budur — təkrarlanan problem birdəfəlikdən ağırdır.

Amma history NAMİZƏDDİR, fakt deyil: onu maşın oxşarlığa görə gətirib və
bəzən sadəcə köhnə adi yazışma olur. Yalnız indiki hadisə ilə AÇIQ-AYDIN eyni
mövzudadırsa işlət. Əlaqəsizdirsə, sanki yoxdur — ondan bəhs etmə, süni əlaqə
qurma. history sahəsi yoxdursa keçmiş haqqında HEÇ NƏ demə.

QADAĞAN: sübutda olmayan fakt, rəqəm, ad uydurmaq. Ümumi bilikdən müştəri tarixi icad etmək.
QADAĞAN: sistemin daxili kodlarını (WAITING_ON_US, CUSTOMER_DECIDING, FILLER, INTERVENE və s.) mətnə yazmaq — menecer onları tanımır. Nə demək istədiyini adi sözlərlə yaz.
Bütün mətnləri AZƏRBAYCAN DİLİNDƏ yaz.`;

export interface LlmResult {
  bodies: Map<string, { body: string; severityAdjust: number; adjustReason: string }>;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export function pickModel(findings: Finding[]): string {
  return findings.some((f) => f.baseSeverity >= 8) ? HIGH_MODEL : DEFAULT_MODEL;
}

/** LLM promptunun görəcəyi giriş — dry-run da bunu ölçüb xərc təxmin edir. */
export function buildInput(
  userName: string,
  windowHours: number,
  digest: WindowDigest,
  findings: { dedupeKey: string; finding: Finding }[],
  /** Menecerin əvvəlki 1/5 qiymətləri (ratings.ts) — mətnin tonunu ona görə qur. */
  hints: string | null = null,
): string {
  const payload = JSON.stringify(
    {
      salesperson: userName,
      windowHours: Math.round(windowHours * 10) / 10,
      digest: {
        ...digest,
        longestWait: digest.longestWaitSeconds === null ? null : formatDuration(digest.longestWaitSeconds),
        medianReply: digest.medianReplySeconds === null ? null : formatDuration(digest.medianReplySeconds),
      },
      findings: findings.map(({ dedupeKey, finding }) => ({
        dedupeKey,
        detector: finding.detector,
        contact: finding.contact,
        baseSeverity: finding.baseSeverity,
        evidence: finding.evidence,
      })),
    },
    null,
    1,
  );
  return hints ? `${hints}\n\n${payload}` : payload;
}

export async function generateCommentary(model: string, input: string): Promise<LlmResult> {
  const client = new Anthropic();
  // Adaptiv düşünmə və `effort` 4.6 nəslindən gəlib; Haiku 4.5 hər ikisini
  // 400 ilə rədd edir (bax scripts/identify-clients.ts-dəki eyni qərar).
  const modern = !/haiku-4-5|sonnet-4-5/.test(model);
  const response = await client.messages.parse({
    model,
    // 4000 ilə hər gedişat kəsilirdi: 20+ tapıntılı instansda cavab yarımçıq
    // qalır, JSON parse olunmur və bütün postlar şablon mətnə düşürdü
    // (loglarda "Unterminated string in JSON"). Modern modellərdə düşünmə
    // tokenləri də bu büdcədən yeyir. Tavan yalnız tavandır — ödəniş
    // həqiqətən yazılan tokenlərə gedir.
    max_tokens: 16000,
    ...(modern ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: {
      ...(modern ? { effort: "medium" as const } : {}),
      format: zodOutputFormat(CommentarySchema),
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: input }],
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("model returned no parsed output");

  const bodies = new Map<string, { body: string; severityAdjust: number; adjustReason: string }>();
  for (const p of parsed.perFinding) {
    bodies.set(p.dedupeKey, {
      body: p.body,
      severityAdjust: p.severityAdjust,
      adjustReason: p.adjustReason,
    });
  }
  return {
    bodies,
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
