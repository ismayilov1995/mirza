import { pool } from "../db";
import { AGENT_KEY } from "./run";
import type { ScopedInstanceId } from "../access";
import { getCommentsByPost, type PostComment } from "./comments";
import type { VerifyState } from "./verify";

// Lentin oxu tərəfi. Kontakt adı posta yazılan anda evidence.contact-da
// dondurulub — lent sorğusu Message cədvəlinə toxunmur, ona görə ucuzdur.
//
// QOPUQ İNSTANSIN BAYRAQLARI GÖSTƏRİLMİR. Sessiya ölü ikən baza donur: satıcı
// telefondan cavab yazsa da bura düşmür, ona görə "3 saatdır cavabsız" sətri
// artıq ölçü yox, yalan olur. Belə bayraqlar silinmir və bağlanmır — sadəcə
// instans qayıdana qədər gizlənir (qayıdanda gedişat hamısını yenidən yoxlayır,
// run.ts). Yerində bir sətir qalır: hansı nömrə qopub və neçə bayraq gözləyir.
// Yeganə istisna 'instance_health' postudur — qopmanın özünü elan edən odur.

export interface AgentPost {
  id: number;
  agent: string;
  instanceId: string;
  instanceName: string | null;
  userName: string | null;
  remoteJid: string | null;
  detector: string;
  kind: "finding" | "all_clear";
  severity: number;
  baseSeverity: number;
  severityReason: string | null;
  verdict: "INTERVENE" | "OK";
  title: string;
  body: string;
  evidence: Record<string, unknown>;
  llmModel: string | null;
  timesSeen: number;
  lastSeenAt: string;
  createdAt: string;
  acknowledgedAt: string | null;
  /**
   * MANUAL = admin bağladı, AUTO = problem öz-özünə aradan qalxdı,
   * SCOPE = söhbət müştəri dairəsindən çıxdı, RATED_NOISE = menecer
   * «Lazımsız» qiyməti verdi, HANDOFF = iş Dubaya/PR-a keçdi,
   * SNOOZED = möhlət verildi (bax `snoozeDays`).
   */
  closedReason:
    | "MANUAL" | "AUTO" | "SCOPE" | "RATED_NOISE" | "HANDOFF" | "MUTED" | "SNOOZED" | null;
  /** Möhlət verilmiş post: neçə gün və hansı ana qədər. */
  snoozeDays: number | null;
  snoozedUntil: string | null;
  /**
   * Bu post bitmiş möhlətdən SONRA qayıdıb — möhlət neçə gün idi.
   *
   * `snoozeDays` ilə eyni rəqəm deyil və eyni post da deyil: möhlət verilən
   * sıra bağlanıb yerində qalır, bu isə onun yerinə açılmış təzə sıradır.
   */
  afterSnoozeDays: number | null;
  /** "Həll edildi" DEYİL — bağlamadan izah. Severity-yə toxunmur. */
  comments: PostComment[];
  /** Söhbətin son 15 mesajını oxumuş doğrulama (verify.ts) — yoxdursa null. */
  verify: {
    state: VerifyState;
    confidence: "HIGH" | "MEDIUM" | "LOW";
    reason: string | null;
    model: string | null;
    at: string;
  } | null;
  /** Menecerin 1-5 qiyməti (ratings.ts) — verilməyibsə null. */
  rating: {
    value: number;
    note: string | null;
    ratedBy: string | null;
    at: string;
  } | null;
}

/** Qopuq instans: bayraqları müvəqqəti gizlədilib. */
export interface FrozenInstance {
  instanceId: string;
  instanceName: string | null;
  userName: string | null;
  /** Evolution-dakı xam vəziyyət: 'connecting' | 'close'. */
  status: string;
  /** Gizlədilmiş açıq bayraqların sayı. */
  hiddenCount: number;
  /** Qopmanın başlanğıcı — bilinmirsə null. */
  downSince: string | null;
}

export interface AgentFeed {
  /** 6+ bal, hələ bağlanmayıb — lentin başında sancaqlı. */
  pinned: AgentPost[];
  /** Açıq, amma bayraq həddinin altında (izləməli olanlar). */
  open: AgentPost[];
  /** Bağlananlar — ayrıca cədvəl: kim/nə bağlayıb görünür. */
  closed: AgentPost[];
  /** Xülasə paneli üçün: bu gün neçəsi bağlandı və sonuncusu nə vaxt. */
  closedToday: number;
  lastClosedAt: string | null;
  /** Filtr düymələri üçün: lentdə postu olan satıcılar. */
  people: { userId: number; userName: string }[];
  /** Qopuq olduğu üçün bayraqları gizlədilən instanslar — lentin başındakı xəbərdarlıq. */
  frozen: FrozenInstance[];
}

/** Filtr: yalnız bu satıcının postları. undefined = hamısı. */
export interface FeedFilter {
  userId?: number;
}

/**
 * Açıq postun görünmə şərti: instansın sessiyası sağ olmalıdır.
 *
 * 'instance_health' istisnadır — qopmanı elan edən postun məhz qopuq ikən
 * görünməsi lazımdır. Instance sətri tapılmasa (LEFT JOIN) post gizlədilmir:
 * naməlum vəziyyətə görə susmaq, bayrağı itirməkdir.
 */
const LIVE_INSTANCE_ONLY = `(p.detector = 'instance_health'
    OR i."connectionStatus" IS NULL OR i."connectionStatus" = 'open')`;

const POST_SELECT = `
  SELECT p.id, p.agent, p.instance_id, i.name AS instance_name, u.name AS user_name,
         p.remote_jid, p.detector, p.kind, p.severity, p.base_severity,
         p.severity_reason, p.verdict, p.title, p.body, p.evidence, p.llm_model,
         p.times_seen, p.last_seen_at, p.created_at, p.acknowledged_at, p.closed_reason,
         p.snooze_days, p.snoozed_until, p.after_snooze_days,
         p.verify_state, p.verify_confidence, p.verify_reason, p.verify_model, p.verified_at,
         r.rating, r.note AS rating_note, r.updated_at AS rated_at, ru.username AS rated_by
  FROM katibe.agent_posts p
  LEFT JOIN katibe.users u ON u.id = p.user_id
  LEFT JOIN evolution_api."Instance" i ON i.id = p.instance_id
  LEFT JOIN katibe.agent_post_ratings r ON r.agent_post_id = p.id
  LEFT JOIN katibe.dashboard_users ru ON ru.id = r.rated_by`;

function mapPost(r: Record<string, unknown>, comments: PostComment[] = []): AgentPost {
  return {
    id: Number(r.id),
    agent: String(r.agent),
    instanceId: String(r.instance_id),
    instanceName: (r.instance_name as string) ?? null,
    userName: (r.user_name as string) ?? null,
    remoteJid: (r.remote_jid as string) ?? null,
    detector: String(r.detector),
    kind: r.kind as AgentPost["kind"],
    severity: Number(r.severity),
    baseSeverity: Number(r.base_severity),
    severityReason: (r.severity_reason as string) ?? null,
    verdict: r.verdict as AgentPost["verdict"],
    title: String(r.title),
    body: String(r.body),
    evidence: (r.evidence as Record<string, unknown>) ?? {},
    llmModel: (r.llm_model as string) ?? null,
    timesSeen: Number(r.times_seen),
    lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
    createdAt: new Date(r.created_at as string).toISOString(),
    acknowledgedAt: r.acknowledged_at ? new Date(r.acknowledged_at as string).toISOString() : null,
    closedReason: (r.closed_reason as AgentPost["closedReason"]) ?? null,
    snoozeDays: r.snooze_days === null || r.snooze_days === undefined ? null : Number(r.snooze_days),
    snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until as string).toISOString() : null,
    afterSnoozeDays:
      r.after_snooze_days === null || r.after_snooze_days === undefined
        ? null
        : Number(r.after_snooze_days),
    comments,
    verify: r.verify_state
      ? {
          state: r.verify_state as VerifyState,
          confidence: r.verify_confidence as "HIGH" | "MEDIUM" | "LOW",
          reason: (r.verify_reason as string) ?? null,
          model: (r.verify_model as string) ?? null,
          at: new Date(r.verified_at as string).toISOString(),
        }
      : null,
    rating: r.rating
      ? {
          value: Number(r.rating),
          note: (r.rating_note as string) ?? null,
          ratedBy: (r.rated_by as string) ?? null,
          at: new Date(r.rated_at as string).toISOString(),
        }
      : null,
  };
}

export async function getAgentFeed(
  scope: ScopedInstanceId[],
  { userId, limit = 30 }: FeedFilter & { limit?: number } = {},
): Promise<AgentFeed> {
  // Lent bütün satıcıların tapıntılarını bir yerdə göstərir, ona görə instans
  // şərti burada MƏCBURİDİR — əks halda bir nömrəyə girişi olan adam hamısının
  // müştəri adlarını, telefonlarını və gözləmə müddətlərini oxuyurdu.
  if (scope.length === 0) {
    return { pinned: [], open: [], closed: [], closedToday: 0, lastClosedAt: null, people: [], frozen: [] };
  }
  // Satıcı filtri: NULL olanda şərt sönür, ona görə eyni sorğu hər iki halda
  // işləyir və ayrıca sorğu mətni saxlamağa ehtiyac qalmır.
  const who = userId ?? null;
  const [pinned, open, closed, summary, people, frozen, commentsByPost] = await Promise.all([
    pool.query(
      `${POST_SELECT}
       WHERE p.agent = $1 AND p.instance_id = ANY($2::text[])
         AND ($3::int IS NULL OR p.user_id = $3::int)
         AND p.severity >= 6 AND p.acknowledged_at IS NULL
         AND ${LIVE_INSTANCE_ONLY}
       ORDER BY p.severity DESC, p.last_seen_at DESC`,
      [AGENT_KEY, scope, who],
    ),
    pool.query(
      `${POST_SELECT}
       WHERE p.agent = $1 AND p.instance_id = ANY($3::text[])
         AND ($4::int IS NULL OR p.user_id = $4::int)
         AND p.severity < 6 AND p.acknowledged_at IS NULL
         AND ${LIVE_INSTANCE_ONLY}
       ORDER BY p.severity DESC, p.last_seen_at DESC
       LIMIT $2`,
      [AGENT_KEY, limit, scope, who],
    ),
    pool.query(
      `${POST_SELECT}
       WHERE p.agent = $1 AND p.instance_id = ANY($3::text[])
         AND ($4::int IS NULL OR p.user_id = $4::int)
         AND p.acknowledged_at IS NOT NULL
       ORDER BY p.acknowledged_at DESC
       LIMIT $2`,
      [AGENT_KEY, limit, scope, who],
    ),
    // Xülasə paneli və "Bağlananlar" başlığı: bu gün (Bakı) neçəsi bağlandı.
    pool.query(
      `SELECT COUNT(*) FILTER (
                WHERE (p.acknowledged_at AT TIME ZONE 'Asia/Baku')::date
                      = (now() AT TIME ZONE 'Asia/Baku')::date
              ) AS today,
              MAX(p.acknowledged_at) AS last_at
       FROM katibe.agent_posts p
       WHERE p.agent = $1 AND p.instance_id = ANY($2::text[])
         AND ($3::int IS NULL OR p.user_id = $3::int)
         AND p.acknowledged_at IS NOT NULL`,
      [AGENT_KEY, scope, who],
    ),
    // Filtr düymələri: yalnız lentdə həqiqətən postu olan satıcılar görünsün.
    pool.query(
      `SELECT DISTINCT p.user_id, u.name
       FROM katibe.agent_posts p
       JOIN katibe.users u ON u.id = p.user_id
       WHERE p.agent = $1 AND p.instance_id = ANY($2::text[])
       ORDER BY u.name`,
      [AGENT_KEY, scope],
    ),
    // Gizlədilənlərin hesabatı. Qopma anı öz tarixçəmizdən gəlir; o hələ
    // yazılmayıbsa Evolution-un öz izləri işlədilir (connectivity.ts-dəki
    // eyni zəncir): disconnectionAt, yoxdursa sətrin son yenilənmə anı.
    pool.query(
      `SELECT p.instance_id, i.name AS instance_name, u.name AS user_name,
              i."connectionStatus"::text AS status,
              COUNT(*) FILTER (WHERE p.detector <> 'instance_health') AS hidden,
              COALESCE(MIN(ic.down_since),
                       MIN(COALESCE(i."disconnectionAt", i."updatedAt") AT TIME ZONE 'UTC')) AS down_since
       FROM katibe.agent_posts p
       JOIN evolution_api."Instance" i ON i.id = p.instance_id AND i."connectionStatus" <> 'open'
       LEFT JOIN katibe.users u ON u.id = p.user_id
       LEFT JOIN katibe.instance_connectivity ic ON ic.instance_id = p.instance_id
       WHERE p.agent = $1 AND p.instance_id = ANY($2::text[])
         AND ($3::int IS NULL OR p.user_id = $3::int)
         AND p.acknowledged_at IS NULL
       GROUP BY p.instance_id, i.name, u.name, i."connectionStatus"
       HAVING COUNT(*) FILTER (WHERE p.detector <> 'instance_health') > 0
       ORDER BY hidden DESC`,
      [AGENT_KEY, scope, who],
    ),
    getCommentsByPost(AGENT_KEY, scope, who),
  ]);
  const withComments = (r: Record<string, unknown>) =>
    mapPost(r, commentsByPost.get(Number(r.id)) ?? []);
  return {
    pinned: pinned.rows.map(withComments),
    open: open.rows.map(withComments),
    closed: closed.rows.map(withComments),
    closedToday: Number(summary.rows[0]?.today ?? 0),
    lastClosedAt: summary.rows[0]?.last_at ? new Date(summary.rows[0].last_at).toISOString() : null,
    people: people.rows.map((r) => ({ userId: Number(r.user_id), userName: String(r.name) })),
    frozen: frozen.rows.map((r) => ({
      instanceId: String(r.instance_id),
      instanceName: (r.instance_name as string) ?? null,
      userName: (r.user_name as string) ?? null,
      status: String(r.status),
      hiddenCount: Number(r.hidden),
      downSince: r.down_since ? new Date(r.down_since as string).toISOString() : null,
    })),
  };
}

export interface QuietStats {
  activeChats: number;
  medianReplySeconds: number | null;
  closedFlags: number;
}

/**
 * Boş hal üçün rəqəmlər.
 *
 * "Açıq bayraq yoxdur" tək başına quru sətirdir və oxucuya sistemin işlədiyini
 * göstərmir. Bu üç rəqəm onu "hər şey yoxlanıldı və qaydasındadır"a çevirir.
 */
export async function getQuietStats(scope: ScopedInstanceId[]): Promise<QuietStats> {
  if (scope.length === 0) return { activeChats: 0, medianReplySeconds: null, closedFlags: 0 };
  const { rows } = await pool.query(
    `WITH msgs AS (
       SELECT m.key->>'remoteJid' AS jid,
              (m.key->>'fromMe')::boolean AS from_me,
              m."messageTimestamp" AS ts
       FROM evolution_api."Message" m
       WHERE m."instanceId" = ANY($1::text[])
         AND (m.key->>'remoteJid' LIKE '%@s.whatsapp.net' OR m.key->>'remoteJid' LIKE '%@lid')
         AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
         AND m."messageTimestamp" >= EXTRACT(epoch FROM
               (((now() AT TIME ZONE 'Asia/Baku')::date)::timestamp) AT TIME ZONE 'Asia/Baku')::int
     ),
     seq AS (
       SELECT from_me, ts,
              LAG(ts) OVER w AS prev_ts,
              LAG(from_me) OVER w AS prev_from_me
       FROM msgs WINDOW w AS (PARTITION BY jid ORDER BY ts)
     )
     SELECT
       (SELECT COUNT(DISTINCT jid) FROM msgs) AS active_chats,
       (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ts - prev_ts))
          FROM seq WHERE from_me AND prev_from_me = false AND ts - prev_ts BETWEEN 1 AND 43200) AS median_reply,
       (SELECT COUNT(*) FROM katibe.agent_posts p
         WHERE p.agent = $2 AND p.instance_id = ANY($1::text[])
           AND p.acknowledged_at IS NOT NULL) AS closed_flags`,
    [scope, AGENT_KEY],
  );
  const r = rows[0];
  return {
    activeChats: Number(r.active_chats ?? 0),
    medianReplySeconds: r.median_reply === null ? null : Number(r.median_reply),
    closedFlags: Number(r.closed_flags ?? 0),
  };
}

/**
 * Açıq (6+ bal, bağlanmamış) bayraqların sayı — naviqasiyadakı nişan üçün.
 *
 * getAgentFeed()-in yerinə ayrıca sayğac var, çünki yazışmalar ekranının bu
 * rəqəmdən başqa lentə ehtiyacı yoxdur: bir nişan üçün yeddi sorğu qaldırmaq
 * səhifəni yavaşladardı. Şərtlər sancaqlı siyahı ilə EYNİDİR — nişan siyahının
 * uzunluğunu göstərməlidir, ona yaxın bir rəqəmi yox.
 */
export async function countOpenFlags(scope: readonly ScopedInstanceId[]): Promise<number> {
  if (scope.length === 0) return 0;
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::int AS n
       FROM katibe.agent_posts p
       LEFT JOIN evolution_api."Instance" i ON i.id = p.instance_id
      WHERE p.agent = $1 AND p.instance_id = ANY($2::text[])
        AND p.severity >= 6 AND p.acknowledged_at IS NULL
        AND ${LIVE_INSTANCE_ONLY}`,
    [AGENT_KEY, scope],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Son gedişat nə vaxt olub — lentin başlığında "axırıncı yoxlama" üçün. */
export async function getLastRunAt(): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT finished_at FROM katibe.agent_runs
     WHERE agent = $1 AND status IN ('ok', 'error') ORDER BY id DESC LIMIT 1`,
    [AGENT_KEY],
  );
  return rows.length && rows[0].finished_at ? new Date(rows[0].finished_at).toISOString() : null;
}

export interface RunState {
  /** Hazırda gedişat işləyir (və ilişib qalmayıb). */
  running: boolean;
  /** İşləyən gedişatın başlama vaxtı. */
  startedAt: string | null;
  finishedAt: string | null;
  status: string | null;
  findingCount: number;
  /** Gedişatın öz yazdığı hesab; köhnə sətirlərdə yoxdur. */
  costUsd: number | null;
}

/**
 * Sonuncu gedişatın vəziyyəti — "indi işlə" düyməsi bunun üstündə oturur.
 *
 * "İşləyir" vəziyyəti 15 dəqiqə ilə məhdudlaşır: gedişat çökərsə sətir
 * `running` qalır, məhdudiyyət olmasa düymə həmişəlik kilidlənərdi. Əsl
 * qoruma onsuz da bazadadır (pg advisory lock) — bu, yalnız göstəricidir.
 */
export async function getRunState(): Promise<RunState> {
  // İki ayrı sual, qəsdən. "İşləyir?" hər gedişata baxır — kilid hamısını
  // eyni cür bağlayır. "Son yoxlama" isə yalnız TAM yoxlamalara: revalidate
  // və health gedişatları saniyənin altında bitir və 0 tapıntı ilə qapanır,
  // onları göstərmək saatlıq yoxlamanın nəticəsini gizlədərdi.
  const [live, last] = await Promise.all([
    pool.query(
      `SELECT started_at FROM katibe.agent_runs
        WHERE agent = $1 AND status = 'running'
          AND started_at > now() - interval '15 minutes'
        ORDER BY id DESC LIMIT 1`,
      [AGENT_KEY],
    ),
    pool.query(
      `SELECT status, finished_at, finding_count, cost_usd
         FROM katibe.agent_runs
        WHERE agent = $1 AND status IN ('ok', 'error') AND trigger IN ('cron', 'manual')
        ORDER BY id DESC LIMIT 1`,
      [AGENT_KEY],
    ),
  ]);
  const runningSince = live.rows[0]?.started_at ?? null;
  const r = last.rows[0];
  if (!r) {
    return {
      running: runningSince !== null,
      startedAt: runningSince ? new Date(runningSince).toISOString() : null,
      finishedAt: null,
      status: null,
      findingCount: 0,
      costUsd: null,
    };
  }
  return {
    running: runningSince !== null,
    startedAt: runningSince ? new Date(runningSince).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    status: r.status,
    findingCount: Number(r.finding_count ?? 0),
    costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd),
  };
}

/**
 * Kölgə rejimi: lent həmişə /agent səhifəsindədir; ana səhifəyə YALNIZ
 * SUPERVISOR_FEED=main olanda çıxır. Kod dəyişikliyi yox, .env.local sətri.
 */
export function isFeedOnMainPage(): boolean {
  return process.env.SUPERVISOR_FEED === "main";
}
