import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getCategories,
  getChatDetail,
  getInstanceInfo,
  getRecentMessages,
  type ChatMessage,
} from "@/lib/queries";
import { setChatLabel } from "@/app/chat-actions";
import MediaAttachment from "@/components/MediaAttachment";
import {
  DEFAULT_SUMMARY_MODEL,
  getStoredSummary,
  getSummaryHistory,
  RELATIONSHIP_LABELS,
  SUMMARY_MODELS,
  type StoredSummary,
} from "@/lib/summary";
import { CHAT_TYPE_LABELS } from "@/lib/jid";
import { runAnalysis, askQuestion } from "./actions";
import {
  DEFAULT_LANG,
  getQuestions,
  getTranslatedSummary,
  isLang,
  LANGS,
  type Lang,
  type StoredQuestion,
} from "@/lib/chat-ai";
import AnalyzeButton from "@/components/AnalyzeButton";
import AnalyzePending from "@/components/AnalyzePending";
import styles from "../../../../dashboard.module.css";
import { requireInstance } from "@/lib/access";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

const dateFmt = new Intl.DateTimeFormat("az-AZ", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "Asia/Baku",
});

/** Opening view, and how much more each "load older" click reveals. */
const INITIAL_MESSAGES = 10;
const LOAD_STEP = 50;
/* A ceiling so a hand-edited ?n= cannot ask for a 90k-message page. */
const MAX_MESSAGES = 2000;

export default async function ChatDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string; jid: string }>;
  searchParams: Promise<{ n?: string; lang?: string }>;
}) {
  const { instanceId: rawInstanceId, jid: rawJid } = await params;
  const instanceId = await requireInstance(rawInstanceId);
  const jid = decodeURIComponent(rawJid);
  const sp = await searchParams;
  const limit = Math.min(MAX_MESSAGES, Math.max(INITIAL_MESSAGES, Number(sp.n) || INITIAL_MESSAGES));
  const lang: Lang = isLang(sp.lang) ? sp.lang : DEFAULT_LANG;

  const [info, chat, transcript, categories] = await Promise.all([
    getInstanceInfo(instanceId),
    getChatDetail(instanceId, jid),
    getRecentMessages(instanceId, jid, limit),
    getCategories(),
  ]);
  if (!info || !chat) notFound();
  const { messages, hasMore } = transcript;

  // Reading a stored analysis is free; nothing here starts a new one.
  const stored = await getStoredSummary(instanceId, jid);
  const history = await getSummaryHistory(instanceId, jid, stored?.id);
  const questions = await getQuestions(instanceId, jid);
  // Translating IS a paid call, but only the first time for a given analysis
  // and language — the result is cached against the analysis row.
  const shownSummary =
    stored && lang !== DEFAULT_LANG ? await getTranslatedSummary(instanceId, stored.id, lang) : stored?.summary;

  const title = chat.displayName ?? chat.knownName ?? chat.contactName;
  // With no name at all, contactName IS the number (or the hint), so the
  // subtitle would print it a second time right after the title.
  const titleIsName = chat.displayName !== null || chat.knownName !== null;

  return (
    <>
      <AppHeader section="Statistika" align="page" searchInstanceId={rawInstanceId} />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>{title}</div>
          <div className={styles.subtitle}>
            <Link href={`/i/${instanceId}`}>← {info.ownerUserName ?? info.name}</Link> ·{" "}
            {CHAT_TYPE_LABELS[chat.chatType]}
            {/* Supervisor lentində bu artıq görünür (contactDisplaySql) — bura
                heç vaxt gəlməyib. Nömrə varsa fakt kimi göstərilir; yoxdursa
                yazışmadan oxunan ipucu (ad, şəhər) onun yerini tutur. */}
            {!titleIsName ? "" : chat.phoneNumber ? ` · ${chat.phoneNumber}` : chat.identityHint ? ` · ${chat.identityHint}` : ""}
            {" · "}
            {chat.jid}
          </div>
        </div>
      </header>

      <section className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Ümumi mesaj</div>
          <div className={styles.cardValue}>{chat.messageCount.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Alındı</div>
          <div className={styles.cardValue}>{chat.received.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Göndərildi</div>
          <div className={styles.cardValue}>{chat.sent.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Kateqoriya</div>
          <div className={styles.cardValue} style={{ fontSize: 16 }}>
            {chat.categoryName ?? <span className={styles.jid}>təyin olunmayıb</span>}
          </div>
        </div>
      </section>

      {/* Naming lives on its own page for bulk work, but when you have just
          read a conversation you already know who this is — so the same edit
          is offered here, writing through the identical server action. */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Ad və kateqoriya</div>
          <div className={styles.legend}>ad qlobaldır — bütün cədvəllərdə görünəcək</div>
        </div>
        <form action={setChatLabel} className={styles.inlineForm}>
          <input type="hidden" name="jid" value={jid} />
          <input type="hidden" name="instanceId" value={instanceId} />
          <input
            className={styles.inlineInput}
            type="text"
            name="displayName"
            placeholder={chat.contactName || "Ad"}
            defaultValue={chat.displayName ?? ""}
          />
          <select className={styles.inlineInput} name="categoryId" defaultValue={chat.categoryId ?? ""}>
            <option value="">Kateqoriya…</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
          <button className={styles.rowButton} type="submit">
            Saxla
          </button>
        </form>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Son yazışma</div>
          <div className={styles.legend}>
            son {messages.length.toLocaleString("az-AZ")} mesaj
            {chat.messageCount > messages.length &&
              ` · ümumi ${chat.messageCount.toLocaleString("az-AZ")}`}
          </div>
        </div>
        {/* Oldest-first, so "load older" belongs above the transcript — that is
            where the history it prepends will appear. */}
        {hasMore && (
          <div style={{ marginBottom: 10 }}>
            <Link href={`/i/${instanceId}/chat/${rawJid}?n=${limit + LOAD_STEP}`} className={styles.rowButton}>
              ↑ Daha {LOAD_STEP} köhnə mesaj
            </Link>
          </div>
        )}
        <Transcript
          messages={messages}
          isGroup={chat.chatType === "group"}
        />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>AI xülasəsi</div>
          {stored && (
            <div className={styles.legend}>
              {dateFmt.format(new Date(stored.createdAt))} · {stored.model}
              {stored.stale && " · köhnəlib"}
              {lang !== DEFAULT_LANG && ` · ${LANGS[lang]} tərcüməsi`}
            </div>
          )}
          <LangSwitcher instanceId={instanceId} rawJid={rawJid} n={limit} lang={lang} />
        </div>

        {stored && shownSummary ? (
          <SummaryBody stored={stored} summary={shownSummary} />
        ) : (
          <NoAnalysisYet />
        )}

        <AnalysisForm
          instanceId={instanceId}
          jid={jid}
          label={stored ? (stored.stale ? "Yenidən təhlil et" : "Yeni təhlil") : "Təhlil et"}
        />

        {history.length > 0 && (
          <>
            <div className={styles.summaryLabel}>Əvvəlki təhlillər</div>
            <ul className={styles.summaryList}>
              {history.map((h) => (
                <li key={h.id} className={styles.jid}>
                  {dateFmt.format(new Date(h.createdAt))} · {h.model} ·{" "}
                  {h.messageCount.toLocaleString("az-AZ")} mesaj
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Bu söhbətə sual ver</div>
          <div className={styles.legend}>
            cavab yalnız yazışmadan gəlir — tapılmasa &quot;yoxdur&quot; deyir
          </div>
        </div>
        <form action={askQuestion}>
          <input type="hidden" name="instanceId" value={instanceId} />
          <input type="hidden" name="jid" value={jid} />
          <input type="hidden" name="lang" value={lang} />
          <div className={styles.inlineForm}>
            <input
              className={styles.inlineInput}
              type="text"
              name="question"
              maxLength={500}
              placeholder="Məsələn: qiymət neçə deyilmişdi?"
              style={{ flex: 1, minWidth: 240 }}
            />
            <AnalyzeButton label="Soruş" />
          </div>
          <AnalyzePending />
        </form>
        <QuestionList questions={questions} />
      </section>

      <div className={styles.footer}>Katibe · Evolution API üzərindən, yalnız oxu rejimində</div>
    </div>
    </>
  );
}

function NoAnalysisYet() {
  return (
    <div className={styles.empty}>
      Bu söhbət hələ təhlil edilməyib. Model seçib &quot;Təhlil et&quot; düyməsinə basın — nəticə bazada
      saxlanılacaq, növbəti dəfə açanda təkrar xərc çıxmayacaq.
    </div>
  );
}

function SummaryBody({
  stored,
  summary,
}: {
  stored: StoredSummary;
  /** The original analysis, or its cached translation. */
  summary: import("@/lib/summary").ChatSummary;
}) {
  const s = summary;
  return (
    <div>
      <div className={styles.summaryHead}>
        <span className={styles.pill}>{RELATIONSHIP_LABELS[s.relationship]}</span>
        <span className={styles.summaryHeadline}>{s.headline}</span>
      </div>

      <p className={styles.summaryText}>{s.summary}</p>

      {/* Analyses stored before these fields existed simply omit them, so every
          new section is guarded rather than assumed. */}
      {(s.concerns ?? []).length > 0 && (
        <>
          <div className={styles.summaryLabel}>Diqqət tələb edən</div>
          <ul className={styles.summaryList}>
            {(s.concerns ?? []).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      )}

      {(s.keyPeople ?? []).length > 0 && (
        <>
          <div className={styles.summaryLabel}>Kimlər iştirak edir</div>
          <ul className={styles.summaryList}>
            {(s.keyPeople ?? []).map((p) => (
              <li key={p.name}>
                <strong>{p.name}</strong> — {p.role}
              </li>
            ))}
          </ul>
        </>
      )}

      {s.topics.length > 0 && (
        <>
          <div className={styles.summaryLabel}>Mövzular</div>
          <div className={styles.pillList}>
            {s.topics.map((t) => (
              <span key={t} className={styles.pill}>
                {t}
              </span>
            ))}
          </div>
        </>
      )}

      {s.openItems.length > 0 && (
        <>
          <div className={styles.summaryLabel}>Açıq məsələlər</div>
          <ul className={styles.summaryList}>
            {s.openItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}

      <div className={styles.jid} style={{ marginTop: 14 }}>
        {stored.messageCount.toLocaleString("az-AZ")} mesaj əsasında
        {stored.stale && " · o vaxtdan yeni mesajlar gəlib"}
      </div>
    </div>
  );
}

function AnalysisForm({ instanceId, jid, label }: { instanceId: string; jid: string; label: string }) {
  return (
    <form action={runAnalysis}>
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="jid" value={jid} />
      <div className={styles.inlineForm}>
        <select className={styles.inlineInput} name="model" defaultValue={DEFAULT_SUMMARY_MODEL}>
          {Object.entries(SUMMARY_MODELS).map(([id, cfg]) => (
            <option key={id} value={id}>
              {cfg.label} — {cfg.hint}
            </option>
          ))}
        </select>
        <AnalyzeButton label={label} />
      </div>
      <AnalyzePending />
    </form>
  );
}

const MEDIA_LABEL: Record<string, string> = {
  imageMessage: "🖼️ şəkil",
  videoMessage: "🎬 video",
  audioMessage: "🎙️ səsli mesaj",
  documentMessage: "📄 sənəd",
  stickerMessage: "🏷️ stiker",
  locationMessage: "📍 məkan",
  contactMessage: "👤 kontakt",
  albumMessage: "🖼️ albom",
  ptvMessage: "🎬 video mesaj",
};

const msgTimeFmt = new Intl.DateTimeFormat("az-AZ", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Baku",
});

function Transcript({
  messages,
  isGroup,
}: {
  messages: ChatMessage[];
  isGroup: boolean;
}) {
  if (messages.length === 0) {
    return <div className={styles.empty}>Bu söhbətdə mesaj tapılmadı.</div>;
  }
  return (
    <div className={styles.transcript}>
      {messages.map((m) => (
        <div key={m.id} className={m.fromMe ? styles.bubbleOutRow : styles.bubbleInRow}>
          <div className={m.fromMe ? styles.bubbleOut : styles.bubbleIn}>
            {/* In a group, who spoke is part of the meaning; in a 1:1 it is always the same two sides. */}
            {!m.fromMe && isGroup && m.senderName && (
              <div className={styles.bubbleSender}>{m.senderName}</div>
            )}
            {/* A photo with a caption is both — show the file and the words. */}
            {m.isMedia ? (
              <>
                <MediaAttachment
                  messageId={m.id}
                  messageType={m.messageType}
                  archived={m.archived}
                  mimetype={m.mimetype}
                  fileName={m.fileName}
                  label={MEDIA_LABEL[m.messageType] ?? m.messageType}
                />
                {m.text && <div className={styles.bubbleText}>{m.text}</div>}
                {m.messageType === "audioMessage" && <VoiceText message={m} />}
              </>
            ) : m.text ? (
              <div className={styles.bubbleText}>{m.text}</div>
            ) : (
              <div className={styles.bubbleMedia}>{MEDIA_LABEL[m.messageType] ?? m.messageType}</div>
            )}
            <div className={styles.bubbleTime}>
              {m.fromMe ? "Biz" : "Onlar"} · {msgTimeFmt.format(new Date(m.timestamp * 1000))}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LangSwitcher({
  instanceId,
  rawJid,
  n,
  lang,
}: {
  instanceId: string;
  rawJid: string;
  n: number;
  lang: Lang;
}) {
  return (
    <div className={styles.rangeGroup}>
      {(Object.keys(LANGS) as Lang[]).map((code) => (
        <Link
          key={code}
          href={`/i/${instanceId}/chat/${rawJid}?n=${n}${code === DEFAULT_LANG ? "" : `&lang=${code}`}`}
          className={`${styles.rangeLink} ${code === lang ? styles.rangeLinkActive : ""}`}
          prefetch={false}
        >
          {LANGS[code]}
        </Link>
      ))}
    </div>
  );
}

function QuestionList({ questions }: { questions: StoredQuestion[] }) {
  if (questions.length === 0) {
    return (
      <div className={styles.empty}>
        Hələ sual verilməyib. Sual yalnız bu söhbətin mesajları əsasında cavablandırılır.
      </div>
    );
  }
  return (
    <div>
      {questions.map((q) => (
        <div key={q.id} className={styles.qaItem}>
          <div className={styles.qaQuestion}>{q.question}</div>
          <div className={styles.summaryText}>
            {/* found=false is a real answer, not a failure — it means the
                conversation genuinely does not say. Marked so it cannot be
                mistaken for a finding. */}
            {!q.found && <span className={styles.pill}>yazışmada tapılmadı</span>}{" "}
            {q.answer}
          </div>
          {q.evidence.length > 0 && (
            <>
              <div className={styles.summaryLabel}>Yazışmadan sitatlar</div>
              <ul className={styles.summaryList}>
                {q.evidence.map((e, i) => (
                  <li key={i} className={styles.qaEvidence}>
                    {e}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className={styles.jid}>{dateFmt.format(new Date(q.createdAt))}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * The text under a voice note — in every state, including the ones that used
 * to render nothing.
 *
 * A pending note previously showed just the player, which is what "I only see
 * the voice message" looks like: the transcript was on its way but the page
 * gave no sign of it. Silence is the one thing this must never do, so each
 * outcome says what it is.
 */
function VoiceText({ message }: { message: ChatMessage }) {
  if (message.voiceText) {
    return (
      <div className={styles.bubbleText}>
        <span className={styles.voiceBadge}>🎙️ mətn</span> {message.voiceText}
      </div>
    );
  }
  switch (message.voiceStatus) {
    case "ok":
      // Transcribed successfully, but the model heard no speech.
      return <div className={styles.jid}>🎙️ səsdə nitq tapılmadı</div>;
    case "unavailable":
      return (
        <div className={styles.jid} title="WhatsApp təxminən 3 həftədən sonra faylı silir">
          🎙️ səs faylı artıq mövcud deyil — mətnə çevrilə bilmədi
        </div>
      );
    case "failed":
      return <div className={styles.jid}>🎙️ mətnə çevrilmədi — bir azdan yenidən cəhd olunacaq</div>;
    default:
      // No row yet. The webhook normally lands within seconds of the message.
      return <div className={styles.jid}>🎙️ mətnə çevrilir…</div>;
  }
}
