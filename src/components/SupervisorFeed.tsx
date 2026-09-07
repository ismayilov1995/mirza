import Link from "next/link";
import {
  getAgentFeed, getLastRunAt, getQuietStats,
  type AgentFeed, type AgentPost, type FrozenInstance,
} from "@/lib/supervisor/feed";
import { severityBand, type SeverityBand } from "@/lib/supervisor/types";
import { myInstances, requireSession, type Role, type ScopedInstanceId } from "@/lib/access";
import { formatDuration } from "@/lib/format";
import { commentAgentPost, rateAgentPost } from "@/app/agent-actions";
import CloseFlagForm from "./CloseFlagForm";
import {
  Badge, Button, EvidenceBox, FlagRow, Input, FilterChip, Panel, ResolvedStrip,
  StatCard, StatGrid,
} from "@/components/ui";
import ui from "@/components/ui/ui.module.css";
import { maskPhones } from "@/lib/mask";
import { VERIFY_STATE_LABELS } from "@/lib/supervisor/verify";
import { RATING_LABELS } from "@/lib/supervisor/ratings";
import ChatQuickView from "@/components/ChatQuickView";
import MuteFlagButton from "@/components/MuteFlagButton";
import SnoozeFlagButton from "@/components/SnoozeFlagButton";
import styles from "@/app/dashboard.module.css";

// Nəzarətçi lenti. Düzüm Claude Design "Nezaretci Lenti" (2026-08-25) dizaynından.
//
// Əvvəl hər tapıntı WhatsApp qabarcığı idi. 14 bayraq eyni göründüyü üçün
// "indi nəyə baxım" sualına cavab yox idi. İndi hər sıranın solunda bal reyi
// var, zolaq rəngi haşiyədən oxunur (kritik qırmızı / ciddi kəhrəba / diqqət
// mavi) və yalnız kritik sıralar fon işığı alır.
//
// Server komponentdir: satıcı filtri URL-dədir (?u=<id>), ona görə client JS
// lazım gəlmir. Canlı yenilənməni səhifədəki <LiveUpdates /> verir.

export const AGENT_PERSONAS: Record<string, { name: string; emoji: string }> = {
  nazaratchi: { name: "Nəzarətçi", emoji: "🕵️" },
};

/** Detektorun lentdəki qısa etiketi — daxili ad heç vaxt ekrana çıxmır. */
const DETECTOR_LABELS: Record<string, string> = {
  unanswered: "cavabsız",
  customer_deciding: "qərar mərhələsi",
  silence: "susqunluq",
  all_clear: "hesabat",
};

/** Bağlanma səbəbinin lentdəki adı — daxili kod heç vaxt ekrana çıxmır. */
const CLOSE_LABELS: Record<NonNullable<AgentPost["closedReason"]>, string> = {
  MANUAL: "Əl ilə bağlandı",
  AUTO: "Öz-özünə həll olundu",
  SCOPE: "Müştəri siyahısından çıxdı",
  RATED_NOISE: "«Lazımsız» qiyməti verildi",
  HANDOFF: "İş filiala/PR-a keçdi",
  MUTED: "Bir daha göstərilməyəcək",
  SNOOZED: "Möhlət verildi",
};

/**
 * Möhlət verilmiş sıranın mətni — «nə vaxt geri qayıdır» ilə birlikdə.
 *
 * Tarixsiz «Möhlət verildi» yarımçıq cavabdır: menecerin növbəti sualı elə
 * «hansı gün?» olur və onu tapmaq üçün audit səhifəsinə getmək lazım gələrdi.
 *
 * İki uzunluq, çünki iki yer var: bağlanmış sıranın zolağında yer boldur və
 * saat da yazılır, «Bağlananlar» cədvəlinin sütununda isə yalnız gün sığır.
 */
function snoozeLabel(post: AgentPost, compact = false): string {
  if (post.snoozeDays === null) return CLOSE_LABELS.SNOOZED;
  if (!post.snoozedUntil) return `${post.snoozeDays} gün möhlət verildi`;
  const until = new Intl.DateTimeFormat("az-AZ", {
    timeZone: "Asia/Baku",
    day: "numeric",
    month: compact ? "short" : "long",
    ...(compact ? {} : { hour: "2-digit" as const, minute: "2-digit" as const }),
  }).format(new Date(post.snoozedUntil));
  return compact
    ? `${post.snoozeDays} gün möhlət · ${until}-dək`
    : `${post.snoozeDays} gün möhlət verildi — ${until}-dək`;
}

function bakuTime(iso: string): string {
  const d = new Date(iso);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("az-AZ", { timeZone: "Asia/Baku", ...o }).format(d);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baku" }).format(new Date());
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baku" }).format(d);
  const time = fmt({ hour: "2-digit", minute: "2-digit" });
  return day === today ? time : `${fmt({ day: "numeric", month: "short" })} ${time}`;
}

/**
 * Lentin bütün mətn sahələrindən nömrələri silir.
 *
 * `evidence` də daxildir: onun içindəki sətir dəyərləri (kontakt adı, sitat
 * gətirilmiş mesaj) ekranda göstərilir. Sətir olmayan dəyərlərə (say, vaxt)
 * toxunulmur — maskalama mətn qaydasıdır, tip çevirməsi deyil.
 */
function maskFeed(feed: AgentFeed): AgentFeed {
  const m = (t: string | null): string | null => (t === null ? null : maskPhones(t));

  /*
   * `evidence` sərbəst formalı JSON-dur və DƏRİNDİR: «N təklif gözləyir»
   * postunun sübutu `top: [{contact, jid, waited}]` massividir. Yalnız üst
   * səviyyəni maskalamaq onu buraxırdı — nəzarətçinin ekranında «Saudi 8995 ·
   * 966500000005» sətri və `…/chat/966500000005@s.whatsapp.net` linki belə
   * görünürdü.
   *
   * JID SİLİNİR, maskalanmır: o, ünvandır və maskalanmış forması heç nəyə
   * yaramır, amma React açarı kimi belə brauzerə düşür (RSC yükündə açar da
   * serializasiya olunur — sızma məhz oradan da gedirdi).
   */
  const maskDeep = (v: unknown): unknown => {
    if (typeof v === "string") return maskPhones(v);
    if (Array.isArray(v)) return v.map(maskDeep);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => k !== "jid" && k !== "remoteJid")
          .map(([k, x]) => [k, maskDeep(x)]),
      );
    }
    return v;
  };
  const maskEvidence = (e: Record<string, unknown>): Record<string, unknown> =>
    maskDeep(e) as Record<string, unknown>;
  const post = (p: AgentPost): AgentPost => ({
    ...p,
    title: maskPhones(p.title),
    body: maskPhones(p.body),
    severityReason: m(p.severityReason),
    evidence: maskEvidence(p.evidence),
    comments: p.comments.map((c) => ({ ...c, comment: maskPhones(c.comment) })),
    verify: p.verify ? { ...p.verify, reason: m(p.verify.reason) } : null,
    rating: p.rating ? { ...p.rating, note: m(p.rating.note) } : null,
  });
  return {
    ...feed,
    pinned: feed.pinned.map(post),
    open: feed.open.map(post),
    closed: feed.closed.map(post),
  };
}

function chatHref(post: AgentPost): string {
  return post.remoteJid !== null
    ? `/i/${post.instanceId}/chat/${encodeURIComponent(post.remoteJid)}`
    : `/i/${post.instanceId}`;
}

/**
 * Gözləmə çipi: "43 saat / hədəf 3 saat".
 *
 * Hədəfi yanında göstərmək qərar üçün lazımdır — 43 saat özü heç nə demir,
 * hədəfin 3 saat olduğunu görəndə isə pozuntunun miqyası dərhal oxunur.
 */
function waitChip(post: AgentPost): string | null {
  const e = post.evidence as { waitedSeconds?: number; targetSeconds?: number; oldestSeconds?: number };
  if (typeof e.waitedSeconds === "number") {
    const waited = formatDuration(e.waitedSeconds);
    return typeof e.targetSeconds === "number"
      ? `${waited} / hədəf ${formatDuration(e.targetSeconds)}`
      : waited;
  }
  if (typeof e.oldestSeconds === "number") return `ən köhnəsi ${formatDuration(e.oldestSeconds)}`;
  return null;
}

/**
 * Siyahı postunun ("N təklif qərar gözləyir") ən köhnə beşi.
 *
 * Maskalanmış rejimdə sıra LİNK DEYİL: hədəf `/i/<instans>/…` ekranıdır və
 * nəzarətçi onu onsuz da aça bilmir (403), üstəlik ünvanın özü xam JID
 * daşıyırdı. Açar da JID deyil — RSC yükündə açar serializasiya olunur.
 */
function EvidenceList({ post, masked = false }: { post: AgentPost; masked?: boolean }) {
  const e = post.evidence as {
    top?: { contact: string; jid?: string; waited: string; isClient: boolean }[];
  };
  if (!e.top?.length) return null;

  return (
    <div className={styles.sfEvidence}>
      <div className={styles.sfEvidenceHead}>
        <span>Ən köhnə {e.top.length}-i</span>
        {!masked && (
          <Link href={`/i/${post.instanceId}/base`} className={styles.sfEvidenceWait}>
            hamısına bax →
          </Link>
        )}
      </div>
      {e.top.map((t, i) => {
        const row = (
          <>
            <span className={styles.sfEvidenceName}>
              <span className={styles.sfDot} data-client={t.isClient ? "1" : "0"} />
              <span title={t.contact}>{t.contact}</span>
            </span>
            <span className={styles.sfEvidenceWait}>{t.waited}</span>
          </>
        );
        return masked || !t.jid ? (
          <div key={i} className={styles.sfEvidenceRow}>{row}</div>
        ) : (
          <Link
            key={t.jid}
            href={`/i/${post.instanceId}/chat/${encodeURIComponent(t.jid)}`}
            className={styles.sfEvidenceRow}
          >
            {row}
          </Link>
        );
      })}
      <div className={styles.sfEvidenceFoot}>
        <span className={styles.sfEvidenceName}>
          <span className={styles.sfDot} data-client="1" /> mövcud müştəri
        </span>
        <span className={styles.sfEvidenceName}>
          <span className={styles.sfDot} data-client="0" /> potensial
        </span>
      </div>
    </div>
  );
}

/**
 * Şərh lenti — "Həll edildi"dən fərqli. Görünən hər kəs (viewer/Sales daxil)
 * yaza bilər, çünki bayrağı susdurmur, yalnız izah əlavə edir (bax
 * agent-actions.ts:commentAgentPost).
 */
function CommentThread({ post }: { post: AgentPost }) {
  if (post.comments.length === 0) return null;
  return (
    <div className={ui.comments}>
      {post.comments.map((c) => (
        <div key={c.id} className={ui.comment}>
          <span className={ui.commentMeta}>
            {c.userName} · {bakuTime(c.createdAt)}
          </span>
          <span className={ui.commentText}>{c.comment}</span>
        </div>
      ))}
    </div>
  );
}

function CommentForm({ postId }: { postId: number }) {
  return (
    <form action={commentAgentPost} className={ui.commentForm}>
      <input type="hidden" name="postId" value={postId} />
      <Input
        size="sm"
        type="text"
        name="comment"
        placeholder="Şərh yaz — komandaya görünür"
        maxLength={2000}
        required
      />
      <Button type="submit" size="sm">Əlavə et</Button>
    </form>
  );
}

/**
 * Doğrulamanın izi.
 *
 * Doğrulama balı 6-dan 5-ə endirəndə sıra sancaqdan çıxır — və oxucu niyəsini
 * bilməsə, bu, "sistem bayrağı itirdi" kimi görünür. Ona görə nəticə HƏMİŞƏ
 * yazılır, hətta bal dəyişməyəndə də: "oxudum, hələ də gözləyir" cümləsi
 * bayrağın arxasındakı ikinci rəydir.
 */
function VerifyNote({ post }: { post: AgentPost }) {
  if (!post.verify) return null;
  const downgraded = post.verify.state === "NOT_WAITING" && post.verify.confidence === "HIGH";
  return (
    <EvidenceBox
      label={`Söhbət oxundu · ${VERIFY_STATE_LABELS[post.verify.state]}${
        post.verify.confidence === "HIGH" ? "" : ` (${post.verify.confidence.toLowerCase()})`
      }`}
    >
      {post.verify.reason}
      {downgraded ? (
        <>
          {post.verify.reason ? " " : null}
          Bal bu səbəbdən 5-ə endirildi — bayraq bağlanmadı, yalnız sancaqdan çıxdı.
        </>
      ) : null}
    </EvidenceBox>
  );
}

/**
 * Menecerin 1-5 qiyməti. Yalnız admin görür.
 *
 * 1 xüsusi düymədir və bunu gizlətmirik: postu bağlayır və həmin söhbətdə eyni
 * bayrağı susdurur. Qalan qiymətlər heç nəyi dəyişmir — onlar yalnız datasetə
 * yazılır ki, model növbəti dəfə menecerin nəyi dəyərli saydığını görsün.
 */
function RatingBar({ post, role }: { post: AgentPost; role: Role }) {
  if (role !== "admin") return null;
  const current = post.rating?.value ?? null;

  return (
    <div className={styles.sfRating}>
      <form action={rateAgentPost} className={styles.sfRatingForm}>
        <input type="hidden" name="postId" value={post.id} />
        <span className={styles.sfRatingLabel}>Bu bayraq nə qədər dəyərli idi?</span>
        <span className={styles.sfRatingButtons}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="submit"
              name="rating"
              value={n}
              className={styles.sfRatingButton}
              data-active={current === n ? "1" : "0"}
              data-noise={n === 1 ? "1" : "0"}
              title={n === 1 ? `${RATING_LABELS[n]} — bağla və bu söhbətdə susdur` : RATING_LABELS[n]}
            >
              {n}
            </button>
          ))}
        </span>
        <input
          type="text"
          name="note"
          maxLength={1000}
          placeholder="səbəb (istəyə görə) — 1 verəndə susdurmanın izahı olur"
          className={styles.sfRatingNote}
          defaultValue={post.rating?.note ?? ""}
        />
      </form>
      {current !== null ? (
        <div className={styles.sfRatingCurrent}>
          {current} · {RATING_LABELS[current]}
          {post.rating?.ratedBy ? ` · ${post.rating.ratedBy}` : ""} · {bakuTime(post.rating!.at)}
          {current === 1 ? " · bu söhbətdə eyni bayraq susdurulub (30 gün)" : ""}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Bal zolağı süzgəci.
 *
 * Dizaynın çipləri ilə eyni bölgüdür (types.ts:SEVERITY_BANDS), yalnız
 * "hamısı" əlavə olunub. Bölgü burada təkrar YAZILMIR — zolağı severityBand()
 * hesablayır, bura yalnız hansı zolağın seçildiyini saxlayır.
 */
export type BandFilter = "hamısı" | SeverityBand;

const BAND_CHIPS: { key: BandFilter; label: string; color: string }[] = [
  { key: "hamısı", label: "hamısı", color: "var(--text-faint)" },
  { key: "kritik", label: "9–10 kritik", color: "var(--band-kritik)" },
  { key: "ciddi", label: "6–8 ciddi", color: "var(--band-ciddi)" },
  { key: "diqqet", label: "4–5 diqqət", color: "var(--band-diqqet)" },
];

function inBand(post: AgentPost, band: BandFilter): boolean {
  return band === "hamısı" || severityBand(post.severity) === band;
}

/**
 * Ən uzun gözləyən bayrağın çipi — kartın rəqəmi buradan gəlir.
 *
 * Hədəf də qaytarılır, çünki "16 saat" özü heç nə demir: hədəfin 2 saat
 * olduğunu görəndə pozuntunun miqyası oxunur.
 */
function longestWait(posts: AgentPost[]): { value: string; hint: string } {
  let worst: { waited: number; target: number | null } | null = null;
  for (const p of posts) {
    const e = p.evidence as { waitedSeconds?: number; targetSeconds?: number };
    if (typeof e.waitedSeconds !== "number") continue;
    if (worst === null || e.waitedSeconds > worst.waited) {
      worst = { waited: e.waitedSeconds, target: typeof e.targetSeconds === "number" ? e.targetSeconds : null };
    }
  }
  if (worst === null) return { value: "—", hint: "gözləyən yoxdur" };
  return {
    value: formatDuration(worst.waited),
    hint: worst.target === null ? "hədəf təyin olunmayıb" : `hədəf ${formatDuration(worst.target)}`,
  };
}

function Row({
  post,
  role,
  masked = false,
  chatHrefOverride,
  last = false,
}: {
  post: AgentPost;
  role: Role;
  masked?: boolean;
  chatHrefOverride?: string;
  last?: boolean;
}) {
  // Maskalama RENDER anındadır: nömrə bazada da, hesabla işləyənlərin
  // ekranında da olduğu kimi qalır. Burada gizlədilir, çünki agentin haqlı
  // olub-olmadığını mühakimə etmək üçün müştərinin nömrəsi lazım deyil.
  const mask = masked ? maskPhones : (t: string | null | undefined) => t ?? "";
  const who = [post.userName, post.instanceName].filter(Boolean).join(" · ");
  const contact = (post.evidence.contact as string) ?? null;
  const title = mask(contact ?? post.title);

  /* Eyni səbəb: chatHref xam JID-i URL-ə yazır. Maskalanmış rejimdə başlıq
     yalnız hazır gələn opaq linkə bağlanır, öz-özünə link qurmur. */
  const href = masked ? chatHrefOverride : chatHref(post);

  const closed = post.acknowledgedAt !== null;
  const canClose = role === "admin" || role === "monitor";

  /* Söhbətə keçid düyməsi bağlama formasının içindədir, çünki dizaynda hər
     ikisi eyni sualın cavabıdır: "bağlamazdan əvvəl nə edim?" Forma yoxdursa
     düymə tək qalır və alt sətrə düşür. */
  const openChat = href ? (
    <Button size="sm" icon="external-link" href={href}>
      {post.remoteJid === null ? "Səhifəyə bax" : "Yazışmaya bax"}
    </Button>
  ) : null;

  return (
    <FlagRow
      score={post.severity}
      title={title}
      href={href}
      wait={waitChip(post) ?? undefined}
      who={who || undefined}
      detector={post.kind === "all_clear" ? "hesabat" : (DETECTOR_LABELS[post.detector] ?? post.detector)}
      repeat={
        post.afterSnoozeDays !== null ? (
          /* Pozulmuş möhlət «N-ci dəfə» nişanını əvəz edir, onunla yan-yana
             durmur: təkrar sayı bu sıra üçün onsuz da 1-dir (post təzədir) və
             iki nişan eyni sualın — «bunu əvvəl də görmüşəmmi?» — iki fərqli
             cavabını verərdi. Möhlət cavabı daha dəqiqdir. */
          <Badge tone="serious" variant="soft" size="xs" shape="md" icon="timer">
            {`${post.afterSnoozeDays} gün möhlət verilmişdi — problem davam edir`}
          </Badge>
        ) : post.timesSeen > 1 ? (
          `${post.timesSeen}-ci dəfə`
        ) : undefined
      }
      body={mask(post.body)}
      reason={post.severityReason ?? undefined}
      last={last}
      time={`${bakuTime(post.lastSeenAt)}${
        post.llmModel === null && post.kind === "finding" ? " · şablon" : ""
      }`}
      actions={
        <>
          {/* Maskalanmış rejimdə sürətli baxış YOXDUR, və bu, rahatlıq məsələsi
              deyil: ChatQuickView xam JID daşıyır, JID isə elə telefon
              nömrəsidir. Onu brauzerə ötürmək ekrandakı maskalamanı teatra
              çevirərdi. Nəzarətçi yazışmanı /monitor-dan oxuyur. */}
          {!masked && post.remoteJid !== null ? (
            <ChatQuickView instanceId={post.instanceId} jid={post.remoteJid} fullHref={chatHref(post)} />
          ) : null}
          {/* Bağlanmış sıralarda söhbətə keçid alt sətirdə qalır — forma artıq
              yoxdur, amma "niyə bağlandı" sualı söhbətdən yoxlanır. */}
          {closed && openChat}
          {/* «Bir daha göstərmə» yalnız söhbətə bağlı bayraqda var: susdurmanın
              açarı söhbətdir, instans səviyyəli siyahını susdurmaq mümkün deyil
              (ratings.ts:mutePostForever). */}
          {/* Möhlət «Bir daha göstərmə»dən ƏVVƏL durur, çünki daha yumşaqdır və
              menecerin real cavabı çox vaxt elə odur: «bilirəm, cümə axşamına
              qədər vaxt ver». Sərt düymə sonda qalanda təsadüfən basılmır. */}
          {role === "admin" && post.remoteJid !== null ? (
            <SnoozeFlagButton
              postId={post.id}
              contact={mask(contact ?? post.title)}
              detectorLabel={DETECTOR_LABELS[post.detector] ?? post.detector}
            />
          ) : null}
          {role === "admin" && post.remoteJid !== null ? (
            <MuteFlagButton
              postId={post.id}
              contact={mask(contact ?? post.title)}
              detectorLabel={DETECTOR_LABELS[post.detector] ?? post.detector}
            />
          ) : null}
        </>
      }
    >
      <VerifyNote post={post} />

      <EvidenceList post={post} masked={masked} />

      {closed ? (
        <ResolvedStrip time={post.acknowledgedAt ? bakuTime(post.acknowledgedAt) : undefined}>
          {post.closedReason === "SNOOZED"
            ? snoozeLabel(post)
            : CLOSE_LABELS[post.closedReason ?? "MANUAL"]}
        </ResolvedStrip>
      ) : null}

      {/* Bağlamaq admin və nəzarətçidədir, hər ikisində SƏBƏBLƏ. Qeydsiz
          variant burada idi və server tərəfi qeyd tələb edəndən sonra
          səssizcə heç nə etmirdi — forma ilə əməliyyat bir yerdə dəyişməlidir. */}
      {!closed && canClose ? <CloseFlagForm postId={post.id} before={openChat} /> : null}

      <CommentThread post={post} />
      <CommentForm postId={post.id} />
      <RatingBar post={post} role={role} />
    </FlagRow>
  );
}

/**
 * Qopuq nömrələr üçün xəbərdarlıq zolağı.
 *
 * Bayraqlar silinmir, sadəcə gizlədilir: sessiya ölü ikən onların rəqəmləri
 * (nə qədər gözlədi, neçə mesaj) ölçü olmaqdan çıxır — satıcının telefondan
 * verdiyi cavab bazaya düşmür, ona görə "cavabsız" saatı öz-özünə böyüyür.
 * Oxucuya yalan rəqəm göstərməkdənsə, səbəbi göstərmək düzdür.
 */
function FrozenNotice({ frozen }: { frozen: FrozenInstance[] }) {
  const total = frozen.reduce((n, f) => n + f.hiddenCount, 0);
  return (
    <div className={styles.sfFrozen}>
      <span className={styles.sfFrozenIcon}>⚠️</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className={styles.sfFrozenTitle}>
          {frozen.length === 1 ? "Bir nömrə WhatsApp-dan qopub" : `${frozen.length} nömrə WhatsApp-dan qopub`}
        </div>
        <div className={styles.sfFrozenText}>
          Sessiya qopanda baza donur: müştərinin yazdığı gəlmir, satıcının telefondan verdiyi cavab
          düşmür. Ona görə bu nömrələrin {total} bayrağı müvəqqəti gizlədilib — göstərdikləri vaxt
          artıq doğru deyil. Nömrə qoşulan kimi Nəzarətçi qopma anından etibarən hamısını yenidən
          yoxlayır: həll olunanlar bağlanır, qalanları geri qayıdır.
        </div>
        <div className={styles.sfFrozenList}>
          {frozen.map((f) => (
            <div key={f.instanceId} className={styles.sfFrozenRow}>
              <span className={styles.sfFrozenName}>{f.userName ?? f.instanceName ?? f.instanceId}</span>
              <span className={styles.sfFrozenCount}>{f.hiddenCount} bayraq gizlədildi</span>
              <span className={styles.sfFrozenMeta}>
                vəziyyət: {f.status}
                {f.downSince ? ` · ${bakuTime(f.downSince)}-dən bəri (${formatDuration(outageSeconds(f.downSince))})` : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function outageSeconds(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
}

export default async function SupervisorFeed({
  userId,
  scope: scopeOverride,
  role: roleOverride,
  masked = false,
  chatLinks,
  band = "hamısı",
  basePath = "/agent",
  keep,
}: {
  userId?: number;
  /**
   * Nəzarətçi üçün verilir, çünki myInstances() requireSession()-dan keçir və
   * o, monitor rolunu /monitor-a qaytarır — yönləndirmə qəsdəndir və rolun
   * təhlükəsiz paylanmasının səbəbidir.
   */
  scope?: ScopedInstanceId[];
  role?: Role;
  /** Telefon nömrələri gizlədilsin — nəzarətçinin ekranı üçün. */
  masked?: boolean;
  /**
   * postId → söhbətə keçid ünvanı, HAZIR halda.
   *
   * Maskalanmış rejimdə link burada qurulmur, çünki onu qurmaq üçün JID
   * lazımdır və JID telefon nömrəsidir. Çağıran onu server tərəfdə opaq
   * tokenlə hazırlayır və yalnız nəzarətçinin GÖRƏ BİLDİYİ söhbətlər üçün
   * verir — görünməyənə keçid göstərmək 403-ə aparan yalan vəd olardı.
   */
  chatLinks?: Record<number, string>;
  /**
   * Bal zolağı süzgəci — URL-dədir, ona görə səhifə server komponenti qalır.
   *
   * Süzgəc HƏR İKİ siyahıya tətbiq olunur: "4–5 diqqət" seçiləndə sancaqlı
   * siyahı boşalır və izləmədəkilər qalır. Yalnız birinə tətbiq etmək
   * seçimin nəyi süzdüyünü qeyri-müəyyən edərdi.
   */
  band?: BandFilter;
  /**
   * Süzgəc linklərinin bazası. Standart olaraq /agent, çünki lent orada doğulub
   * — amma nəzarətçi eyni lenti /monitor/bayraqlar-dan oxuyur və oradakı çip
   * /agent-ə aparsaydı, requireSession() onu geri qaytarardı: süzgəc səssizcə
   * işləməzdi.
   */
  basePath?: string;
  /**
   * Süzgəc linklərində saxlanılacaq əlavə parametrlər.
   *
   * Admin önizləməsi üçün (`?as=<nəzarətçi>`): süzgəcə klikləyəndə parametr
   * düşsəydi, ekran önizləmədən çıxıb 403 verərdi — yəni ilk klik önizləməni
   * bağlayardı.
   */
  keep?: Record<string, string>;
} = {}) {
  const [derivedScope, session] = scopeOverride
    ? [scopeOverride, null]
    : await Promise.all([myInstances(), requireSession()]);
  const scope = derivedScope;
  const role: Role = roleOverride ?? session?.role ?? "viewer";
  const rawFeed = await getAgentFeed(scope, { userId });
  const lastRunAt = await getLastRunAt();

  /*
   * MASKALAMA BİR YERDƏ, sıraların yanında yox.
   *
   * Əvvəl hər render yeri özü maskalayırdı (başlıq, gövdə) və nəticədə bir
   * neçə sahə unudulmuşdu: doğrulama səbəbi, bal izahı, şərhlər və bağlananlar
   * cədvəlindəki ad. Onların hamısını model və ya insan yazır — yəni içində
   * müştərinin nömrəsi ola bilər və olurdu da (nəzarətçinin ekranında xam
   * «966500000005» belə görünürdü).
   *
   * İndi lent oxunan kimi bir dəfə maskalanır. Yeni sahə əlavə edən adam onu
   * ayrıca yadda saxlamalı deyil: mətn sahəsi buradan keçir.
   */
  const maskName = masked ? maskPhones : (t: string | null | undefined) => t ?? "";
  const feed = masked ? maskFeed(rawFeed) : rawFeed;
  const nothingOpen = feed.pinned.length === 0 && feed.open.length === 0;
  const quiet = nothingOpen ? await getQuietStats(scope) : null;

  /* Süzgəc linkləri: satıcı və zolaq birlikdə saxlanılır — birini dəyişəndə
     digəri itsəydi, iki addımdan sonra adam harada olduğunu bilməzdi. */
  const filterHref = (next: { u?: number | undefined; b?: BandFilter }) => {
    const u = "u" in next ? next.u : userId;
    const b = next.b ?? band;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(keep ?? {})) q.set(k, v);
    if (u !== undefined) q.set("u", String(u));
    if (b !== "hamısı") q.set("b", b);
    const s = q.toString();
    return s ? `${basePath}?${s}` : basePath;
  };

  const pinned = feed.pinned.filter((p) => inBand(p, band));
  const watching = feed.open.filter((p) => inBand(p, band));
  const worst = longestWait([...feed.pinned, ...feed.open]);

  return (
    <>
      {feed.frozen.length > 0 ? <FrozenNotice frozen={feed.frozen} /> : null}

      {/* Dörd rəqəm, dörd sual: nəyə indi bax, nə növbədədir, bu gün nə
          bitdi, ən pis hal nədir. Beşincisi yoxdur — kart sırası uzananda
          hər biri az oxunur. */}
      <StatGrid style={{ marginBottom: "var(--space-9)" }}>
        <StatCard
          label="Açıq bayraq"
          value={String(pinned.length)}
          hint="6–10 bal · müdaxilə gözləyir"
          tone="critical"
        />
        <StatCard
          label="İzləmədə"
          value={String(watching.length)}
          hint="1–5 bal · iş siyahısı"
        />
        <StatCard
          label="Bu gün bağlandı"
          value={String(feed.closedToday)}
          hint={feed.lastClosedAt ? `son ${bakuTime(feed.lastClosedAt)}` : "səbəblə bağlanır"}
          tone="brand"
        />
        <StatCard
          label="Ən uzun gözləmə"
          value={worst.value}
          hint={worst.hint}
          tone="serious"
        />
      </StatGrid>

      <div className={ui.filterBar} style={{ marginBottom: "var(--space-9)" }}>
        {feed.people.length > 1 ? (
          <div className={ui.filterGroup}>
            <span className={ui.filterLabel}>Satıcı</span>
            <FilterChip href={filterHref({ u: undefined })} active={userId === undefined}>
              Hamısı
            </FilterChip>
            {feed.people.map((p) => (
              <FilterChip key={p.userId} href={filterHref({ u: p.userId })} active={userId === p.userId}>
                {p.userName}
              </FilterChip>
            ))}
          </div>
        ) : <span />}

        {/* Rəng nümunəsi çipin içindədir, amma tək daşıyıcı deyil: yanındakı
            "9–10 kritik" yazısı eyni məlumatı sözlə verir. */}
        <div className={ui.filterGroup}>
          <span className={ui.filterLabel}>Bal</span>
          {BAND_CHIPS.map((b) => (
            <FilterChip key={b.key} href={filterHref({ b: b.key })} shape="md" active={band === b.key}>
              <span className={ui.bandSwatch} style={{ ["--band" as string]: b.color }} />
              {b.label}
            </FilterChip>
          ))}
        </div>
      </div>

      {pinned.length > 0 ? (
        <Panel
          title="Sancaqlı bayraqlar"
          hint={`${pinned.length} sıra · səbəb yazılmadan bağlanmır`}
          pad={false}
          style={{ marginBottom: "var(--space-9)" }}
        >
          {pinned.map((post, i) => (
            <Row key={post.id} post={post} role={role} masked={masked}
              chatHrefOverride={chatLinks?.[post.id]} last={i === pinned.length - 1} />
          ))}
        </Panel>
      ) : null}

      {watching.length > 0 ? (
        <Panel
          title="İzləmədə"
          hint={`${watching.length} sıra · 1–5 bal`}
          pad={false}
          style={{ marginBottom: "var(--space-9)" }}
        >
          {watching.map((post, i) => (
            <Row key={post.id} post={post} role={role} masked={masked}
              chatHrefOverride={chatLinks?.[post.id]} last={i === watching.length - 1} />
          ))}
        </Panel>
      ) : null}

      {/* Süzgəc boşluğu ilə həqiqi boşluq eyni şey deyil: birincisi seçimi
          geri almağı təklif edir, ikincisi "hər şey qaydasındadır" deyir. */}
      {pinned.length === 0 && watching.length === 0 && !nothingOpen ? (
        <Panel>
          <div style={{ textAlign: "center", color: "var(--text-muted)", fontSize: "var(--text-reading)" }}>
            Bu süzgəclə açıq bayraq yoxdur.{" "}
            <Link href={filterHref({ u: undefined, b: "hamısı" })}>Hamısını göstər</Link>
          </div>
        </Panel>
      ) : null}

      {nothingOpen ? (
        <div className={styles.sfEmpty}>
          <span className={styles.sfEmptyDot} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className={styles.sfEmptyTitle}>
              {feed.frozen.length > 0 ? "Qoşulu nömrələrdə açıq bayraq yoxdur" : "Açıq bayraq yoxdur"}
            </div>
            <div className={styles.sfEmptyText}>
              {feed.frozen.length > 0
                ? "Qoşulu nömrələrin bütün söhbətləri hədəf vaxtı içindədir; qopuq nömrələr yuxarıda göstərilib."
                : "Bütün söhbətlər hədəf vaxtı içindədir."}{" "}
              Yoxlama 09:00–21:00 arası (B.e–Şənbə) saatda bir gəlir.
            </div>
            {quiet ? (
              <div className={styles.sfStats}>
                <div>
                  <div className={styles.sfStatNum}>{quiet.activeChats}</div>
                  <div className={styles.sfStatLabel}>bu gün aktiv söhbət</div>
                </div>
                <div>
                  <div className={styles.sfStatNum}>
                    {quiet.medianReplySeconds === null ? "—" : formatDuration(quiet.medianReplySeconds)}
                  </div>
                  <div className={styles.sfStatLabel}>median cavab sürəti</div>
                </div>
                <div>
                  <div className={styles.sfStatNum}>{quiet.closedFlags}</div>
                  <div className={styles.sfStatLabel}>bağlanan bayraq</div>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {feed.closed.length > 0 ? (
        <details className={styles.sfClosed}>
          <summary className={styles.sfClosedSummary}>
            <span className={styles.sfClosedTitle}>Bağlananlar</span>
            <span className={styles.sfClosedMeta}>
              {feed.closedToday} · bu gün
              {feed.lastClosedAt ? ` · son ${bakuTime(feed.lastClosedAt)}` : ""}
            </span>
            <span className={styles.sfClosedToggle}>aç / bağla</span>
          </summary>
          <div className={styles.sfClosedBody}>
            <table className={styles.sfClosedTable}>
              <thead>
                <tr>
                  <th>Söhbət</th>
                  <th>Satıcı</th>
                  <th>Bal</th>
                  <th>Necə bağlandı</th>
                  <th style={{ textAlign: "right" }}>Vaxt</th>
                </tr>
              </thead>
              <tbody>
                {feed.closed.map((post) => {
                  /*
                   * Bağlanmış sıra da açıq sıra ilə EYNİ qaydalardan keçir.
                   *
                   * Keçmirdi: bu cədvəl adı xam yazır və linki özü qururdu
                   * (`/i/<instans>/chat/<jid>`), yəni nəzarətçinin ekranında
                   * müştərinin telefon nömrəsi həm mətndə, həm URL-də görünürdü
                   * — halbuki elə həmin nömrə iki santimetr yuxarıda, açıq
                   * sıralarda maskalanmışdı. verify:access bunu «bayraq
                   * ekranında 5 telefon nömrəsi» kimi tuturdu.
                   *
                   * Link də yalnız hazır gələn opaq token ilə qurulur: xam
                   * JID-li ünvan nəzarətçi üçün onsuz da 403-dür, yəni yalan
                   * vəd olardı.
                   */
                  const name = maskName((post.evidence.contact as string) ?? post.title);
                  const href = masked ? chatLinks?.[post.id] : chatHref(post);
                  return (
                    <tr key={post.id}>
                      <td className={styles.sfCellName}>
                        {href ? (
                          <Link href={href} className={styles.chatLink} title={name}>
                            {name}
                          </Link>
                        ) : (
                          <span title={name}>{name}</span>
                        )}
                      </td>
                      <td className={styles.sfCellMuted}>{post.userName ?? "—"}</td>
                      <td className={styles.sfCellNum} data-band={severityBand(post.severity)}>
                        {post.severity}
                      </td>
                      <td>
                        {/* Möhlət bu cədvəlin yeganə sətridir ki, hekayəsi
                            bitməyib: qalanları «bağlandı» deməkdir, bu isə
                            «filan günə qədər gizlədilib». Ona görə tarixsiz
                            göstərilə bilməz. */}
                        <span className={styles.sfHow} data-how={post.closedReason ?? "MANUAL"}>
                          <span className={styles.sfHowDot} />
                          {post.closedReason === "SNOOZED"
                            ? snoozeLabel(post, true)
                            : CLOSE_LABELS[post.closedReason ?? "MANUAL"]}
                        </span>
                      </td>
                      <td className={styles.sfCellRight}>
                        {post.acknowledgedAt ? bakuTime(post.acknowledgedAt) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className={styles.sfNote}>
              Bağlanmaq son söz deyil — problem davam edərsə Nəzarətçi onu təzə post kimi yenidən
              açır.
            </div>
          </div>
        </details>
      ) : null}

      {lastRunAt ? (
        <div className={styles.footer}>Son yoxlama {bakuTime(lastRunAt)}</div>
      ) : null}
    </>
  );
}

export function SupervisorFeedSkeleton() {
  return (
    <div className={styles.sfList} style={{ padding: 15 }}>
      <div className={styles.summaryLoading}>
        <div className={styles.spinner} />
        Lent yüklənir…
      </div>
    </div>
  );
}
