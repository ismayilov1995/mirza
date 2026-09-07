import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { pool } from "./db";
import type { ScopedInstanceId } from "./access";
import { classifyJid } from "./jid";

/**
 * Models offered in the dashboard's analysis dropdown.
 *
 * Sonnet 5 is the default: a chat summary is a summarization task, and at
 * $2/$10 per MTok it costs a fraction of Opus while reading these
 * conversations well. Opus 5 stays available per-chat for the ones worth
 * paying for. Haiku 4.5 predates adaptive thinking and rejects
 * `output_config.effort`, so it gets neither — hence the per-model config
 * rather than one shared request shape.
 */
export const SUMMARY_MODELS = {
  "claude-sonnet-5": {
    label: "Sonnet 5 — standart",
    hint: "Sürətli və ucuz, gündəlik istifadə üçün",
    adaptiveThinking: true,
    effort: "high" as const,
  },
  "claude-opus-5": {
    label: "Opus 5 — dərin analiz",
    hint: "Ən dəqiq, mürəkkəb yazışmalar üçün (baha)",
    adaptiveThinking: true,
    effort: "high" as const,
  },
  "claude-haiku-4-5": {
    label: "Haiku 4.5 — ən ucuz",
    hint: "Ən sürətli, sadə yazışmalar üçün",
    adaptiveThinking: false,
    effort: null,
  },
} as const;

export type SummaryModel = keyof typeof SUMMARY_MODELS;
export const DEFAULT_SUMMARY_MODEL: SummaryModel = "claude-sonnet-5";

export function isSummaryModel(value: unknown): value is SummaryModel {
  return typeof value === "string" && value in SUMMARY_MODELS;
}

const MAX_CHARS_PER_MESSAGE = 400;

/*
 * The whole conversation, budgeted by characters.
 *
 * This used to be the last 300 messages. That produced summaries that read
 * like a description of last week rather than of a relationship — and the cap
 * barely bound anyway: 1,540 of 1,643 chats here are under 300 messages. The
 * largest chat is ~250K characters (~71K tokens), comfortably inside the
 * model's context, so this ceiling is headroom against a future outlier rather
 * than a limit anything meets today. When it does bite it drops the OLDEST
 * text, keeping the recent conversation intact.
 */
export const MAX_TRANSCRIPT_CHARS = 600_000;

const SummarySchema = z.object({
  headline: z
    .string()
    .describe("Who this contact is and what the working relationship is. Name them and say what they do — not a generic label."),
  relationship: z
    .enum(["CLIENT", "SUPPLIER", "COLLEAGUE", "INTERNAL_GROUP", "OTHER"])
    .describe("Who the other side is, judged from how they talk and what they ask for."),
  summary: z
    .string()
    .describe(
      "What this relationship actually is and how it has gone: what they order or supply, how it has developed, what tends to go wrong. As long as it needs to be — no length target. Name people and specifics.",
    ),
  keyPeople: z
    .array(z.object({ name: z.string(), role: z.string() }))
    .describe("The people who actually appear in this conversation and what each does in it. Empty for a quiet 1:1."),
  concerns: z
    .array(z.string())
    .describe(
      "Friction visible in the conversation: repeated complaints, delays, questions left unanswered, anyone losing patience. This is the part a manager reads first. Empty only if the conversation really is smooth.",
    ),
  topics: z.array(z.string()).describe("Short topic labels, e.g. 'Sifariş', 'Çatdırılma'."),
  openItems: z
    .array(z.string())
    .describe("What is still unresolved and who it is waiting on. Empty array if nothing is open."),
});

export type ChatSummary = z.infer<typeof SummarySchema>;

export interface StoredSummary {
  id: string;
  summary: ChatSummary;
  messageCount: number;
  lastMessageTs: number;
  model: string;
  createdAt: string;
  /** True when messages have arrived since this summary was generated. */
  stale: boolean;
}

/** One past analysis, for the "previous runs" list. */
export interface SummaryHistoryEntry {
  id: string;
  model: string;
  createdAt: string;
  messageCount: number;
}

const SYSTEM_PROMPT = `Sən bir WhatsApp biznes yazışmasını təhlil edirsən. Şirkət Dubay/Azərbaycan əsaslı parça və tekstil topdansatışı ilə məşğuldur — mesajlar Azərbaycan, türk, ingilis, ərəb və rus dillərində ola bilər.

Sənə söhbətin TAM tarixçəsi verilir. "BİZ" — şirkətin öz işçisidir, "QARŞI TƏRƏF" — yazışdığı şəxs/qrupdur.

Vəzifən: bu münasibətin nə olduğunu və necə getdiyini başa düşmək. Qarşı tərəfin MÜŞTƏRİ, TƏCHİZATÇI, yoxsa İŞ YOLDAŞI olduğunu ayırd etmək xüsusilə vacibdir.

NƏ ETMƏLİSƏN:
1. Bütün tarixçəni oxu. Münasibətin necə başladığı, nəyin təkrarlandığı, tonun necə dəyişdiyi — bunlar yalnız bütövlükdə görünür.
2. Yazışmadan NƏTİCƏ ÇIXARMAQ tələb olunur. "Bu müştəri hər sifarişdə gecikmədən şikayətlənir" — bu, mətndən çıxan əsaslandırılmış nəticədir, uydurma deyil.
3. KONKRET ol. Adları çək, nəyin baş verdiyini yaz. "Sifarişlər müzakirə olunur" faydasız cümlədir; "Ghadeer korset sifarişlərini idarə edir, son iki ayda tikiş xətti üstündə üç dəfə problem çıxıb" faydalıdır.
4. Sürtünməni gizlətmə. Gecikmə, cavabsız qalan sual, əsəbləşən müştəri, təkrarlanan şikayət — bunlar menecerin ilk oxuduğu hissədir.

NƏ ETMƏMƏLİSƏN:
5. Yazışmada OLMAYAN faktı uydurma. Rəqəm, qiymət, tarix, ad, məbləğ — yalnız mətndə varsa yaz.
6. Ümumi biliyindən fakt gətirmə. Yalnız bu yazışma mənbədir.

FƏRQ VACİBDİR: mətndə olmayan faktı yazmaq səhvdir; mətndə görünəndən nəticə çıxarmaq isə məhz tələb olunan işdir.

Uzunluq hədəfi yoxdur — nə qədər lazımdırsa o qədər yaz, amma boş cümlə yazma. Bütün mətn cavablarını AZƏRBAYCAN DİLİNDƏ yaz.`;

export interface MessageRow {
  from_me: boolean;
  push_name: string | null;
  text: string | null;
  message_type: string;
  ts: number;
}

// Media without a caption still tells the model something happened, so each
// type gets a placeholder rather than being dropped.
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

export interface FetchedTranscript {
  transcript: string;
  messageCount: number;
  isGroup: boolean;
  /** True when the character budget forced older messages out. */
  trimmed: boolean;
}

/**
 * Reads one account's copy of a chat and renders it for a model.
 *
 * Shared by the analysis and by ad-hoc questions so the two can never disagree
 * about what the conversation contains — an answer citing a line the summary
 * never saw would be worse than either being wrong alone.
 *
 * Transcribed voice notes are joined in as ordinary text: a chat where half the
 * content is voice is exactly the one a written summary is most useful for.
 */
export async function fetchChatTranscript(
  instanceId: ScopedInstanceId,
  jid: string,
): Promise<FetchedTranscript> {
  const { rows } = await pool.query(
    `SELECT
       (m.key->>'fromMe')::boolean AS from_me,
       m."pushName" AS push_name,
       COALESCE(
         m.message->>'conversation',
         m.message->'imageMessage'->>'caption',
         m.message->'videoMessage'->>'caption',
         m.message->'documentMessage'->>'fileName',
         vt.text
       ) AS text,
       m."messageType" AS message_type,
       m."messageTimestamp" AS ts
     FROM evolution_api."Message" m
     LEFT JOIN katibe.voice_transcript vt ON vt.message_id = m.id AND vt.status = 'ok'
     WHERE m."instanceId" = $1
       AND m.key->>'remoteJid' = $2
       AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
     ORDER BY m."messageTimestamp" ASC`,
    [instanceId, jid],
  );
  if (rows.length === 0) throw new Error("Bu söhbətdə təhlil ediləcək mesaj yoxdur.");

  const isGroup = classifyJid(jid) === "group";
  let transcript = renderChatTranscript(rows as MessageRow[], isGroup);
  if (!transcript) {
    throw new Error("Bu söhbətdə mətn tapılmadı (yalnız media mesajları var).");
  }
  let trimmed = false;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(-MAX_TRANSCRIPT_CHARS);
    // Drop the partial first line so the transcript never starts mid-sentence.
    transcript = transcript.slice(transcript.indexOf("\n") + 1);
    trimmed = true;
  }
  return { transcript, messageCount: rows.length, isGroup, trimmed };
}

/**
 * The conversation as the model sees it.
 *
 * Exported so ad-hoc questions (lib/chat-ai.ts) read the transcript in exactly
 * the same shape the analysis did — otherwise an answer could cite a line the
 * summary never saw, or miss one it did.
 */
export function renderChatTranscript(rows: MessageRow[], isGroup: boolean): string {
  const lines: string[] = [];
  for (const r of rows) {
    const body = r.text?.trim() || MEDIA_LABEL[r.message_type] || null;
    if (!body) continue;
    // In a group, who spoke matters; in a 1:1 it's always the same two sides.
    const speaker = r.from_me
      ? "BİZ"
      : isGroup && r.push_name
        ? `QARŞI TƏRƏF (${r.push_name})`
        : "QARŞI TƏRƏF";
    lines.push(`${speaker}: ${body.slice(0, MAX_CHARS_PER_MESSAGE)}`);
  }
  return lines.join("\n");
}

/**
 * Newest stored analysis for one account's copy of a chat.
 *
 * Scoped by instance as well as JID. It used to key on the JID alone, on the
 * theory that a group both employees are in is one conversation and need only
 * be analysed once. That holds for groups and is flatly wrong for direct
 * chats: the JID is the *other person's* address, so Ismayil↔Fərid and
 * Rouz↔Fərid share a JID while being entirely different conversations — and
 * one account's analysis surfaced in the other's chat. 20 direct JIDs on this
 * database are shared that way.
 *
 * Now each account gets its own analysis of its own copy, groups included.
 */
export async function getStoredSummary(instanceId: ScopedInstanceId, jid: string): Promise<StoredSummary | null> {
  const { rows } = await pool.query(
    `SELECT
       s.id, s.summary, s.message_count, s.last_message_ts, s.model, s.created_at,
       (SELECT COUNT(*) FROM evolution_api."Message" m
          WHERE m."instanceId" = s.instance_id
            AND m.key->>'remoteJid' = s.remote_jid) AS current_count
     FROM katibe.chat_summary s
     WHERE s.instance_id = $1 AND s.remote_jid = $2
     ORDER BY s.created_at DESC
     LIMIT 1`,
    [instanceId, jid],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: String(r.id),
    summary: r.summary as ChatSummary,
    messageCount: r.message_count,
    lastMessageTs: r.last_message_ts,
    model: r.model,
    createdAt: new Date(r.created_at).toISOString(),
    stale: Number(r.current_count) > r.message_count,
  };
}

/** Earlier analyses of the same chat, newest first, excluding the current one. */
export async function getSummaryHistory(
  instanceId: ScopedInstanceId,
  jid: string,
  excludeId?: string,
): Promise<SummaryHistoryEntry[]> {
  const { rows } = await pool.query(
    `SELECT id, model, created_at, message_count
     FROM katibe.chat_summary
     WHERE instance_id = $1 AND remote_jid = $2
       AND ($3::bigint IS NULL OR id <> $3::bigint)
     ORDER BY created_at DESC
     LIMIT 10`,
    [instanceId, jid, excludeId ?? null],
  );
  return rows.map((r) => ({
    id: String(r.id),
    model: r.model,
    createdAt: new Date(r.created_at).toISOString(),
    messageCount: r.message_count,
  }));
}

/**
 * Runs a fresh analysis and appends it to the history.
 *
 * Only ever called from an explicit user action — opening a chat never
 * triggers it, so no page view spends API credit on its own.
 *
 * Read-only towards WhatsApp: it only SELECTs from evolution_api."Message",
 * so it can never mark anything as read.
 */
export async function generateSummary(
  instanceId: ScopedInstanceId,
  jid: string,
  model: SummaryModel = DEFAULT_SUMMARY_MODEL,
): Promise<StoredSummary> {
  // The caller's own account, not "whichever copy is fullest". Reading the
  // other account's copy is how one employee's conversation ended up
  // summarised on another's chat page.
  const { transcript, messageCount: readCount, isGroup, trimmed } = await fetchChatTranscript(instanceId, jid);

  const cfg = SUMMARY_MODELS[model];
  const client = new Anthropic();
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    ...(cfg.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
    output_config: {
      ...(cfg.effort ? { effort: cfg.effort } : {}),
      format: zodOutputFormat(SummarySchema),
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content:
          `Söhbət növü: ${isGroup ? "QRUP" : "FƏRDİ"}\n` +
          (trimmed
            ? `Söhbətin son hissəsi (${readCount} mesajdan kəsilib):\n\n`
            : `Söhbətin TAM tarixçəsi (${readCount} mesaj):\n\n`) +
          transcript,
      },
    ],
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("AI cavabı oxunmadı, yenidən cəhd edin.");

  // Adaptive thinking is billed as output, so the visible summary length is a
  // poor guide to what a run actually cost. Log the real figures.
  const u = response.usage;
  console.log(
    `[summary] ${model} giriş=${u.input_tokens} çıxış=${u.output_tokens} ` +
      `(${readCount} mesaj, ${transcript.length} simvol)`,
  );

  // This account's copy only, and over the whole chat rather than the window
  // we summarised — getStoredSummary compares against the same figure to
  // decide whether a summary has gone stale, so the two must count alike.
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) AS c FROM evolution_api."Message"
     WHERE "instanceId" = $1 AND key->>'remoteJid' = $2`,
    [instanceId, jid],
  );
  const messageCount = Number(countRows[0].c);
  const { rows: tsRows } = await pool.query(
    `SELECT MAX("messageTimestamp") AS ts FROM evolution_api."Message"
     WHERE "instanceId" = $1 AND key->>'remoteJid' = $2`,
    [instanceId, jid],
  );
  const lastMessageTs = Number(tsRows[0].ts);

  const { rows: inserted } = await pool.query(
    `INSERT INTO katibe.chat_summary
       (instance_id, remote_jid, summary, message_count, last_message_ts, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [instanceId, jid, JSON.stringify(parsed), messageCount, lastMessageTs, model],
  );

  return {
    id: String(inserted[0].id),
    summary: parsed,
    messageCount,
    lastMessageTs,
    model,
    createdAt: new Date(inserted[0].created_at).toISOString(),
    stale: false,
  };
}

export const RELATIONSHIP_LABELS: Record<ChatSummary["relationship"], string> = {
  CLIENT: "🛒 Müştəri",
  SUPPLIER: "📦 Təchizatçı",
  COLLEAGUE: "👔 İş yoldaşı",
  INTERNAL_GROUP: "🏢 Daxili qrup",
  OTHER: "❓ Digər",
};
