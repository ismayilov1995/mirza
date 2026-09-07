import { pool } from "./db";
import { requireAdmin } from "./access";

/*
 * Satıcıların yan-yana müqayisəsi — /admin/satis ekranının bütün rəqəmləri.
 *
 * NİYƏ AYRI FAYL. queries.ts iki mindən çox sətirdir və oradakı funksiyaların
 * hamısı BİR instansa baxır (ScopedInstanceId alır). Bu isə əks sualdır: bütün
 * satıcılar, bir sorğu, müqayisə üçün. Fərqli sual, fərqli sərhəd.
 *
 * TƏRİFLƏR getWorkloadStats() İLƏ EYNİDİR və qəsdən yenidən icad edilmir —
 * instans səhifəsindəki rəqəmlə bu ekrandakı rəqəm fərqlənsə, heç kim hansına
 * inanacağını bilməz. Sabitlər də oradan köçürülüb, çünki ikisi bir yerdən
 * gəlsəydi, biri dəyişəndə digəri səssizcə sürüşərdi.
 *
 * Dizayn: docs/satici-statistikasi-dizayn.md
 */

export type DayType = "week" | "sat" | "sun";

export const DAY_TYPES: DayType[] = ["week", "sat", "sun"];

export interface SalesMetrics {
  /** Cavab imkanı = ardıcıl müştəri mesajları seriyasının sonuncusu. */
  opportunities: number;
  unanswered: number;
  slaBreach: number;
  slaMeasured: number;
  /** SLA qaydası əhatə etməyən imkanlar — faizin məxrəcinə girmir. */
  slaUncovered: number;
  /** Cavablanmış imkanların median gözləməsi, saniyə. */
  responseMedianSeconds: number | null;
  frtMedianSeconds: number | null;
  artMedianSeconds: number | null;
  artP90Seconds: number | null;
}

export interface HeatCell {
  /** 1 = B.e … 7 = Bazar (ISO), Asia/Baku. */
  isoDow: number;
  /** 0…23, Asia/Baku. */
  hour: number;
  outCount: number;
  opportunities: number;
  responseMedianSeconds: number | null;
}

export interface SalesRow {
  userId: number;
  userName: string;
  /** null = nömrə təyin olunmayıb; sətir yenə də qalır. */
  instanceId: string | null;
  instanceName: string | null;
  total: SalesMetrics;
  byDayType: Record<DayType, SalesMetrics>;
  heat: HeatCell[];
}

export interface TeamMedians {
  unansweredPct: number | null;
  slaBreachPct: number | null;
  frtMedianSeconds: number | null;
  artMedianSeconds: number | null;
}

export interface SalesStats {
  range: Range;
  rows: SalesRow[];
  /** Komanda medianı: nömrəsi olan satıcıların dəyərlərinin medianı. */
  team: TeamMedians;
}

export interface Range {
  /** Unix saniyə, daxil. */
  fromTs: number;
  /** Unix saniyə, daxil deyil. */
  toTs: number;
}

/** Seçilə bilən pəncərələr. Başqa dəyər 30-a düşür. */
export const SALES_WINDOWS = [7, 30, 90] as const;

const EPISODE_GAP_SECONDS = 14 * 24 * 60 * 60;
const UNANSWERED_AFTER_SECONDS = 24 * 60 * 60;

export function normaliseDays(value: unknown): number {
  const n = Number(value);
  return (SALES_WINDOWS as readonly number[]).includes(n) ? n : 30;
}

function emptyMetrics(): SalesMetrics {
  return {
    opportunities: 0,
    unanswered: 0,
    slaBreach: 0,
    slaMeasured: 0,
    slaUncovered: 0,
    responseMedianSeconds: null,
    frtMedianSeconds: null,
    artMedianSeconds: null,
    artP90Seconds: null,
  };
}

/** percentile_cont float8 qaytarır; saniyə tam ədəd kimi oxunur, null qalır. */
function seconds(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

export function unansweredPct(m: SalesMetrics): number | null {
  return m.opportunities > 0 ? (m.unanswered / m.opportunities) * 100 : null;
}

export function slaBreachPct(m: SalesMetrics): number | null {
  return m.slaMeasured > 0 ? (m.slaBreach / m.slaMeasured) * 100 : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const SALES_USERS_SQL = `
  SELECT u.id, u.name, ui.instance_id, i.name AS instance_name
  FROM katibe.users u
  JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
  LEFT JOIN katibe.user_instances ui ON ui.user_id = u.id AND ui.ended_at IS NULL
  LEFT JOIN evolution_api."Instance" i ON i.id = ui.instance_id
  ORDER BY u.name ASC`;

/*
 * Bir keçid, dörd grain.
 *
 * GROUPING SETS seçilib, çünki median bucketlərdən toplana bilmir: hər qrup öz
 * percentile_cont-unu almalıdır. ART (cavab grainində) və FRT (epizod
 * grainində) imkan sətirlərindən fərqli çoxluqlardır, ona görə ayrı hissə kimi
 * gəlir və TS tərəfində açara görə birləşdirilir — amma hamısı EYNİ seq
 * zəncirindən çıxır, yəni katibe.message bir dəfə gəzilir.
 *
 * Ölçülüb (2026-09-05, canlı baza): 30 gün 2.3 s, 90 gün 3.6 s.
 */
const STATS_SQL = `
WITH sales AS (
  SELECT ui.instance_id, u.id AS user_id
  FROM katibe.user_instances ui
  JOIN katibe.users u ON u.id = ui.user_id
  JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
  WHERE ui.ended_at IS NULL
),
msgs AS (
  SELECT s.user_id, s.instance_id, m.chat_id, m.ts, ms.direction
  FROM katibe.message m
  JOIN katibe.message_source ms ON ms.message_id = m.id
  JOIN sales s ON s.instance_id = ms.source_id
  JOIN katibe.chat c ON c.id = m.chat_id AND c.kind IN ('individual','lid')
  -- Pəncərənin SAĞ kənarına 24 saat artıq baxılır: pəncərənin son saatında
  -- gələn mesaja cavab ertəsi gün gedə bilər və o cavab görünməsə, sətir
  -- «cavabsız» sayılardı. İmkanın ÖZÜ isə yalnız pəncərə daxilində sayılır
  -- (aşağıda ts < $2), yəni əlavə 24 saat sayğaca girmir.
  WHERE m.ts >= $1::int AND m.ts < $2::int + $4::int
    AND NOT EXISTS (
      SELECT 1 FROM katibe.contact_labels cl
      JOIN katibe.categories cat ON cat.id = cl.category_id
      WHERE cl.remote_jid = m.remote_jid AND cat.name <> 'Client')
),
seq AS (
  SELECT *,
    LAG(ts) OVER w AS prev_ts, LAG(direction) OVER w AS prev_dir,
    LEAD(direction) OVER w AS next_dir,
    MIN(ts) FILTER (WHERE direction = 'out') OVER (
      PARTITION BY user_id, chat_id ORDER BY ts
      ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS next_out_ts
  FROM msgs WINDOW w AS (PARTITION BY user_id, chat_id ORDER BY ts)
),
epi AS (
  SELECT *, SUM(CASE WHEN prev_ts IS NULL OR ts - prev_ts > $3::int THEN 1 ELSE 0 END)
              OVER (PARTITION BY user_id, chat_id ORDER BY ts) AS episode_no
  FROM seq
),
local AS (
  SELECT *,
    EXTRACT(isodow FROM to_timestamp(ts) AT TIME ZONE 'Asia/Baku')::int AS isodow,
    EXTRACT(hour   FROM to_timestamp(ts) AT TIME ZONE 'Asia/Baku')::int AS hour,
    EXTRACT(isodow FROM to_timestamp(prev_ts) AT TIME ZONE 'Asia/Baku')::int AS prev_isodow
  FROM epi
),
opp AS (
  SELECT user_id, isodow, hour,
    CASE WHEN isodow = 7 THEN 'sun' WHEN isodow = 6 THEN 'sat' ELSE 'week' END AS day_type,
    ts AS arrived, next_out_ts,
    -- Cavab gəlməyibsə gözləmə pəncərənin sonuna (və ya indiyə, hansı daha
    -- erkəndirsə) qədər sayılır. Keçmiş həftənin şəkli bu gün çəkiləndə
    -- «indiyə qədər» yazılsaydı, köhnə həftələr hər gün daha da pisləşərdi.
    COALESCE(next_out_ts, LEAST(EXTRACT(epoch FROM now())::int, $2::int + $4::int)) - ts AS waited,
    katibe.sla_target_seconds(instance_id, to_timestamp(ts)) AS target
  FROM local WHERE direction = 'in' AND ts < $2::int AND (next_dir IS NULL OR next_dir = 'out')
),
reply AS (
  SELECT user_id, chat_id, episode_no, ts, ts - prev_ts AS gap,
    CASE WHEN prev_isodow = 7 THEN 'sun' WHEN prev_isodow = 6 THEN 'sat' ELSE 'week' END AS day_type
  FROM local
  WHERE direction = 'out' AND prev_dir = 'in' AND prev_ts < $2::int
    AND (ts - prev_ts) BETWEEN 1 AND $4::int
),
first_reply AS (
  SELECT DISTINCT ON (user_id, chat_id, episode_no) user_id, day_type, gap
  FROM reply ORDER BY user_id, chat_id, episode_no, ts
),
outgoing AS (
  SELECT user_id, isodow, hour FROM local WHERE direction = 'out' AND ts < $2::int
)
SELECT 'opp' AS part, user_id, day_type,
       CASE WHEN GROUPING(hour) = 0 THEN isodow END AS isodow,
       CASE WHEN GROUPING(hour) = 0 THEN hour END AS hour,
       count(*) AS n,
       count(*) FILTER (WHERE next_out_ts IS NULL OR waited > $4::int) AS unanswered,
       count(*) FILTER (WHERE target IS NOT NULL AND waited > target) AS sla_breach,
       count(*) FILTER (WHERE target IS NOT NULL) AS sla_measured,
       count(*) FILTER (WHERE target IS NULL) AS sla_uncovered,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY next_out_ts - arrived)
         FILTER (WHERE next_out_ts IS NOT NULL) AS p50,
       NULL::float8 AS p90
FROM opp
GROUP BY GROUPING SETS ((user_id), (user_id, day_type), (user_id, isodow, hour))
UNION ALL
SELECT 'art', user_id, day_type, NULL, NULL, count(*), 0, 0, 0, 0,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY gap),
       percentile_cont(0.9) WITHIN GROUP (ORDER BY gap)
FROM reply GROUP BY GROUPING SETS ((user_id), (user_id, day_type))
UNION ALL
SELECT 'frt', user_id, day_type, NULL, NULL, count(*), 0, 0, 0, 0,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY gap), NULL
FROM first_reply GROUP BY GROUPING SETS ((user_id), (user_id, day_type))
UNION ALL
SELECT 'out', user_id, NULL, isodow, hour, count(*), 0, 0, 0, 0, NULL, NULL
FROM outgoing GROUP BY user_id, isodow, hour`;

interface UserRow {
  id: number;
  name: string;
  instance_id: string | null;
  instance_name: string | null;
}

interface StatRow {
  part: "opp" | "art" | "frt" | "out";
  user_id: number;
  day_type: DayType | null;
  isodow: number | null;
  hour: number | null;
  n: string;
  unanswered: string;
  sla_breach: string;
  sla_measured: string;
  sla_uncovered: string;
  p50: string | null;
  p90: string | null;
}

/**
 * requireAdmin-i ATLAYIR — yalnız sessiyası olmayan skriptlər üçün.
 *
 * Adı qəsdən uzun və axtarıla biləndir: scripts/check-access-boundaries.sh onun
 * src/app/ altında görünməsini qadağan edir, çünki orada görünməsi admin
 * ekranının hamıya açıldığı deməkdir. Ekran getSalesStats()-i çağırır.
 */
export async function computeSalesStatsWithoutAccessCheck(range: Range): Promise<SalesStats> {
  const [{ rows: users }, { rows: stats }] = await Promise.all([
    pool.query<UserRow>(SALES_USERS_SQL),
    pool.query<StatRow>(STATS_SQL, [
      range.fromTs, range.toTs, EPISODE_GAP_SECONDS, UNANSWERED_AFTER_SECONDS,
    ]),
  ]);

  const byUser = new Map<number, SalesRow>();
  for (const u of users) {
    byUser.set(u.id, {
      userId: u.id,
      userName: u.name,
      instanceId: u.instance_id,
      instanceName: u.instance_name,
      total: emptyMetrics(),
      byDayType: { week: emptyMetrics(), sat: emptyMetrics(), sun: emptyMetrics() },
      heat: [],
    });
  }

  // Xanalar açarla toplanır: imkan hissəsi ilə həcm hissəsi ayrı sətirlərdə gəlir.
  const heat = new Map<number, Map<string, HeatCell>>();
  const cellOf = (userId: number, isoDow: number, hour: number): HeatCell => {
    let cells = heat.get(userId);
    if (!cells) heat.set(userId, (cells = new Map()));
    const key = `${isoDow}:${hour}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { isoDow, hour, outCount: 0, opportunities: 0, responseMedianSeconds: null };
      cells.set(key, cell);
    }
    return cell;
  };

  for (const r of stats) {
    const row = byUser.get(r.user_id);
    if (!row) continue; // satıcılıqdan çıxarılmış user — sətri yoxdur, rəqəmi də.

    if (r.part === "out") {
      if (r.isodow === null || r.hour === null) continue;
      cellOf(r.user_id, r.isodow, r.hour).outCount = Number(r.n);
      continue;
    }

    if (r.part === "opp" && r.hour !== null && r.isodow !== null) {
      const cell = cellOf(r.user_id, r.isodow, r.hour);
      cell.opportunities = Number(r.n);
      cell.responseMedianSeconds = seconds(r.p50);
      continue;
    }

    const target: SalesMetrics = r.day_type === null ? row.total : row.byDayType[r.day_type];

    if (r.part === "opp") {
      target.opportunities = Number(r.n);
      target.unanswered = Number(r.unanswered);
      target.slaBreach = Number(r.sla_breach);
      target.slaMeasured = Number(r.sla_measured);
      target.slaUncovered = Number(r.sla_uncovered);
      target.responseMedianSeconds = seconds(r.p50);
    } else if (r.part === "art") {
      target.artMedianSeconds = seconds(r.p50);
      target.artP90Seconds = seconds(r.p90);
    } else {
      target.frtMedianSeconds = seconds(r.p50);
    }
  }

  for (const [userId, cells] of heat) {
    const row = byUser.get(userId);
    if (row) row.heat = [...cells.values()].sort((a, b) => a.isoDow - b.isoDow || a.hour - b.hour);
  }

  const rows = [...byUser.values()];
  // Komanda medianı yalnız nömrəsi olanlardan: nömrəsiz satıcının sıfırları
  // medianı aşağı çəkərdi və heç kim onun səbəbini ekranda görməzdi.
  const measured = rows.filter((r) => r.instanceId !== null && r.total.opportunities > 0);
  const pick = (fn: (r: SalesRow) => number | null): number | null =>
    median(measured.map(fn).filter((v): v is number => v !== null));

  return {
    range,
    rows,
    team: {
      unansweredPct: pick((r) => unansweredPct(r.total)),
      slaBreachPct: pick((r) => slaBreachPct(r.total)),
      frtMedianSeconds: pick((r) => r.total.frtMedianSeconds),
      artMedianSeconds: pick((r) => r.total.artMedianSeconds),
    },
  };
}

/**
 * «Son N gün» — ekranın işlətdiyi forma.
 *
 * Diapazon indi funksiyanın özündən yox, çağırandan gəlir: şəkil cədvəli
 * keçmiş həftələri doldurmalıdır və «son N gün» o sualı verə bilmir.
 */
export function lastDays(days: number): Range {
  const toTs = Math.floor(Date.now() / 1000);
  return { fromTs: toTs - normaliseDays(days) * 86400, toTs };
}

/** Ekranın yeganə girişi — icazə yoxlaması funksiyanın içindədir. */
export async function getSalesStats(range: Range): Promise<SalesStats> {
  await requireAdmin();
  return computeSalesStatsWithoutAccessCheck(range);
}
