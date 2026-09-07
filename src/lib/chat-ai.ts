import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { pool } from "./db";
import type { ScopedInstanceId } from "./access";
import { fetchChatTranscript, type ChatSummary } from "./summary";

/** Languages an analysis or answer can be shown in. */
export const LANGS = {
  az: "Azərbaycan",
  en: "English",
  ru: "Русский",
  tr: "Türkçe",
  ar: "العربية",
} as const;
export type Lang = keyof typeof LANGS;
export const DEFAULT_LANG: Lang = "az";
export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && v in LANGS;
}

/*
 * Translation runs on the cheapest capable model regardless of what produced
 * the analysis. Rewriting finished Azerbaijani prose into Russian is not the
 * job that needed Opus; paying Opus rates to do it would be waste.
 */
const TRANSLATE_MODEL = "claude-haiku-4-5";

/*
 * Questions are answered by a mid-tier model. This one cannot be cheapened the
 * same way: the whole value is refusing to answer when the transcript does not
 * say, and that discipline is exactly what small models lose first.
 */
const ANSWER_MODEL = "claude-sonnet-5";


const AnswerSchema = z.object({
  found: z
    .boolean()
    .describe(
      "true if the conversation gives enough to answer — including by reasoning over what is written. false only when there is nothing in it to base an answer on.",
    ),
  answer: z
    .string()
    .describe(
      "The answer. Reasoning from the conversation is expected; inventing facts that are not in it is not. Be specific — name people and what they said.",
    ),
  evidence: z
    .array(z.string())
    .describe(
      "Verbatim quotes the answer rests on, including the ones a conclusion was drawn from. Empty only when found is false.",
    ),
});
export type ChatAnswer = z.infer<typeof AnswerSchema>;

const ANSWER_SYSTEM = `Sən bir WhatsApp yazışmasının TAM tarixçəsini oxuyub ona dair suala cavab verirsən.

Sənə söhbətin hamısı verilir. Sual çox vaxt sadə axtarış deyil, MÜHAKİMƏ tələb edir: "kim ən çox narahatdır", "kim cavab ala bilmir", "hansı problem təkrarlanır". Belə suallara cavab vermək sənin işindir.

NƏ ETMƏLİSƏN:
1. Bütün yazışmanı nəzərə al — yalnız son mesajları yox. Təkrarlanan şikayətlər, cavabsız qalan suallar, tonun dəyişməsi, kimin nə qədər gözlədiyi — bunların hamısı yazışmada görünən dəlillərdir.
2. Yazışmadan NƏTİCƏ ÇIXARMAQ icazəlidir və çox vaxt tələb olunur. "Ghadeer eyni sualı üç dəfə təkrarlayıb və cavab almayıb" — bu, mətndən çıxan əsaslandırılmış nəticədir, uydurma deyil.
3. Nəticəni hansı mesajlara əsaslandırdığını evidence sahəsində OLDUĞU KİMİ göstər. Nəticə çıxarırsansa, onu doğuran sətirləri gətir.
4. Konkret ol. "Bəziləri narahatdır" pis cavabdır; "Ghadeer və Marcel — hər ikisi ölçü dəyişikliyini soruşub, cavab gecikib" yaxşı cavabdır.

NƏ ETMƏMƏLİSƏN — bu, mütləq qadağadır:
5. Yazışmada OLMAYAN faktı uydurma. Rəqəm, qiymət, tarix, ad, məbləğ — bunları yalnız mətndə varsa yaz. Xatırladığın və ya ehtimal etdiyin heç nəyi əlavə etmə.
6. Ümumi biliyindən fakt gətirmə. Yalnız bu yazışma sənin mənbəyindir.
7. Yazışma sualı cavablandırmaq üçün heç bir əsas vermirsə — found=false qoy və bunu sadəcə bildir. "Bilmirəm" düzgün cavabdır.

FƏRQ VACİBDİR: mətndə olmayan faktı yazmaq səhvdir; mətndə görünəndən nəticə çıxarmaq isə tələb olunan işdir. found=false yalnız o zaman ki, yazışmada mühakimə qurmaq üçün heç nə yoxdur — sual üçün hazır bir cümlə tapılmadığı üçün yox.

Yazışma çox dillidir. Sitatları orijinal dildə saxla, cavabın özünü tələb olunan dildə yaz.`;

/**
 * Answers a question about one chat, from that chat's transcript alone.
 *
 * Scoped to a single account's copy for the same reason analyses are: a direct
 * chat's JID belongs to the other party, so it is shared across accounts.
 */
export async function askAboutChat(
  instanceId: ScopedInstanceId,
  jid: string,
  question: string,
  lang: Lang = DEFAULT_LANG,
): Promise<ChatAnswer & { id: string; createdAt: string }> {
  // Same builder the analysis uses, so an answer can never cite a line the
  // summary never saw — or miss one it did.
  const { transcript, messageCount, isGroup, trimmed } = await fetchChatTranscript(instanceId, jid);

  /*
   * The transcript is cached; the question is not.
   *
   * Prompt caching is a prefix match, so the split has to fall on the
   * stability boundary: everything up to and including the transcript is
   * identical for every question about this chat, and only the question and
   * the requested output language vary. Putting the breakpoint at the end of
   * the whole prompt instead would write a fresh cache entry per question and
   * never read one.
   *
   * The language line therefore sits AFTER the breakpoint even though it reads
   * like a preamble — asking the same chat something in Russian must not evict
   * the Azerbaijani cache entry.
   *
   * This pays off from the second question onward: a cache write costs ~1.25x
   * the input, a read ~0.1x. Asking exactly one question about a chat is
   * slightly more expensive than not caching, which is the trade taken here
   * because follow-up questions are the point of the feature.
   */
  const client = new Anthropic();
  const res = await client.messages.parse({
    model: ANSWER_MODEL,
    max_tokens: 16000,
    // "Who is most frustrated here" is a reading of the whole conversation, not
    // a lookup. Without thinking the model answered from the surface and fell
    // back on "not stated in the transcript"; adaptive thinking is what lets it
    // actually weigh the history it is now given.
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: zodOutputFormat(AnswerSchema) },
    system: ANSWER_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Söhbət növü: ${isGroup ? "QRUP" : "FƏRDİ"}\n` +
              (trimmed
                ? `Söhbətin son hissəsi (${messageCount} mesajdan kəsilib):\n\n`
                : `Söhbətin TAM tarixçəsi (${messageCount} mesaj):\n\n`) +
              transcript,
            cache_control: { type: "ephemeral" },
          },
          {
            type: "text",
            text: `Cavabın dili: ${LANGS[lang]}\n\nSUAL: ${question}`,
          },
        ],
      },
    ],
  });

  // Zero reads across repeated questions means something upstream is varying —
  // the surest way to lose caching silently is for it to never announce itself.
  const usage = res.usage;
  console.log(
    `[chat-ai] ${ANSWER_MODEL} kəş-yazıldı=${usage.cache_creation_input_tokens ?? 0} ` +
      `kəş-oxundu=${usage.cache_read_input_tokens ?? 0} giriş=${usage.input_tokens} ` +
      `çıxış=${usage.output_tokens}`,
  );
  const parsed = res.parsed_output;
  if (!parsed) throw new Error("AI cavabı oxunmadı, yenidən cəhd edin.");

  // An answer with no quote behind it is exactly the failure mode this feature
  // exists to avoid, so it is demoted rather than shown as a finding.
  const grounded = parsed.found && parsed.evidence.length > 0;

  const { rows: ins } = await pool.query(
    `INSERT INTO katibe.chat_question
       (instance_id, remote_jid, question, answer, found, evidence, model, lang)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [instanceId, jid, question, parsed.answer, grounded,
     JSON.stringify(parsed.evidence), ANSWER_MODEL, lang],
  );
  return {
    ...parsed,
    found: grounded,
    id: String(ins[0].id),
    createdAt: new Date(ins[0].created_at).toISOString(),
  };
}

export interface StoredQuestion {
  id: string;
  question: string;
  answer: string;
  found: boolean;
  evidence: string[];
  lang: string;
  createdAt: string;
}

export async function getQuestions(
  instanceId: ScopedInstanceId,
  jid: string,
  limit = 10,
): Promise<StoredQuestion[]> {
  const { rows } = await pool.query(
    `SELECT id, question, answer, found, evidence, lang, created_at
     FROM katibe.chat_question
     WHERE instance_id = $1 AND remote_jid = $2
     ORDER BY created_at DESC LIMIT $3`,
    [instanceId, jid, limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    question: r.question,
    answer: r.answer,
    found: r.found,
    evidence: (r.evidence as string[]) ?? [],
    lang: r.lang,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

const TranslatedSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  topics: z.array(z.string()),
  openItems: z.array(z.string()),
  concerns: z.array(z.string()),
  // Names stay as written; only the role is translated.
  keyPeople: z.array(z.object({ name: z.string(), role: z.string() })),
});

/**
 * The stored analysis in another language, generated once and cached.
 *
 * Only the prose fields travel. `relationship` is an enum the UI maps to its
 * own labels, and translating it would break that mapping.
 */
export async function getTranslatedSummary(
  instanceId: ScopedInstanceId,
  summaryId: string,
  lang: Lang,
): Promise<ChatSummary | null> {
  // instanceId ŞƏRTDİR, bəzək deyil. Əvvəl bu funksiya yalnız summary_id alırdı
  // və `WHERE id = $1` ilə oxuyurdu — yəni ardıcıl bir bigint təxmin etməklə
  // istənilən nömrənin istənilən söhbətinin AI analizi oxunurdu. İndi analiz
  // yalnız çağıranın öz nömrəsindən gələ bilər.
  const { rows: cached } = await pool.query(
    `SELECT t.payload
     FROM katibe.summary_translation t
     JOIN katibe.chat_summary s ON s.id = t.summary_id AND s.instance_id = $3
     WHERE t.summary_id = $1 AND t.lang = $2`,
    [summaryId, lang, instanceId],
  );
  const { rows: base } = await pool.query(
    `SELECT summary FROM katibe.chat_summary WHERE id = $1 AND instance_id = $2`,
    [summaryId, instanceId],
  );
  if (base.length === 0) return null;
  const original = base[0].summary as ChatSummary;
  if (lang === DEFAULT_LANG) return original;
  if (cached.length > 0) {
    return { ...original, ...(cached[0].payload as object) } as ChatSummary;
  }

  // A translation is a nicety; the analysis underneath it is the content. If
  // the model call fails for any reason — no credit, a timeout, a bad response
  // — the caller gets the original text back rather than an error page.
  try {
    return await translate(original, summaryId, lang);
  } catch {
    return original;
  }
}

async function translate(original: ChatSummary, summaryId: string, lang: Lang): Promise<ChatSummary> {
  const client = new Anthropic();
  const res = await client.messages.parse({
    model: TRANSLATE_MODEL,
    // Analyses got much longer when they stopped being capped at "2-4
    // sentences"; 4000 left no headroom for a full translation of one.
    max_tokens: 8000,
    output_config: { format: zodOutputFormat(TranslatedSchema) },
    system:
      `Sən tərcüməçisən. Verilən mətni ${LANGS[lang]} dilinə tərcümə et.\n` +
      `Məna dəqiq qalsın. Heç nə əlavə etmə, heç nə çıxarma, şərh yazma.\n` +
      `Xüsusi adlar, şirkət adları, rəqəmlər və valyutalar olduğu kimi qalsın.`,
    messages: [
      {
        role: "user",
        content:
          `Aşağıdakı JSON-un BÜTÜN mətn sahələrini ${LANGS[lang]} dilinə tərcümə et. ` +
          `Sahə adlarını (headline, summary, concerns, keyPeople, topics, openItems) ` +
          `və "name" dəyərlərini DƏYİŞMƏ; qalan bütün mətni tərcümə et. ` +
          `Heç bir mətni olduğu kimi qaytarma — hamısı ${LANGS[lang]} dilində olmalıdır.\n\n` +
          JSON.stringify(
          {
            headline: original.headline,
            summary: original.summary,
            topics: original.topics,
            openItems: original.openItems,
            // Older stored analyses predate these fields.
            concerns: original.concerns ?? [],
            keyPeople: original.keyPeople ?? [],
          },
          null,
          2,
        ),
      },
    ],
  });
  const parsed = res.parsed_output;
  if (!parsed) return original;

  await pool.query(
    `INSERT INTO katibe.summary_translation (summary_id, lang, payload, model)
     VALUES ($1,$2,$3,$4) ON CONFLICT (summary_id, lang) DO UPDATE
       SET payload = EXCLUDED.payload, model = EXCLUDED.model, created_at = now()`,
    [summaryId, lang, JSON.stringify(parsed), TRANSLATE_MODEL],
  );
  return { ...original, ...parsed };
}
