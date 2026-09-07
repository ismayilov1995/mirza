import { pool } from "./db";
import {
  computeSalesStatsWithoutAccessCheck,
  type Range,
  type SalesMetrics,
  type SalesRow,
} from "./sales-stats";

/*
 * Həftəlik şəkillər və onların oxunması.
 *
 * sales-stats.ts «indi necədir» sualına cavab verir; bu fayl «əvvəl necə idi»
 * sualına. İkisi ayrıdır, çünki birincisi hər səhifə açılışında canlı
 * hesablanır, ikincisi isə bir dəfə yazılıb bir daha dəyişmir.
 *
 * Dizayn: docs/satici-fakt-qati-dizayn.md §7
 */

/*
 * BAYRAĞIN EKRANDAN ÇIXMASININ ÜÇ MƏNASI.
 *
 * Əvvəl bir mənası var idi — `closed` — və o, hər şeyi bir yerə yığırdı:
 * cavab getdiyi üçün öz-özünə bağlanan da, menecerin «lazımsız» deyib
 * susdurduğu da, müştəri dairəsindən çıxan da, möhlətə salınan da. Yəni rəqəm
 * «neçə problem həll olundu» sualının cavabı kimi oxunurdu, halbuki cavab
 * deyildi.
 *
 * ÖLÇÜLDÜ, İDDİA EDİLMƏDİ. 2026-08-24 həftəsində həll olmayan bağlanmaları
 * medianın kənarına çıxarmaq rəqəmi cəmi ~5% dəyişdi (Zemfira 7575 s → 7193 s)
 * — və maraqlısı odur ki, QISALTDI, uzatmadı: susdurulan bayraqlar orta
 * hesabla daha gec (15113 s) bağlanmışdı, çünki onlara insan əli saatlarla
 * sonra çatır. Deməli o vaxtkı əsas təhrif medianda yox, SAYDA idi: 97
 * «bağlanan»ın 11-i heç nə həll etməmişdi.
 *
 * MÖHLƏT BUNU KEYFİYYƏTCƏ DƏYİŞİR (düymə 2026-09-06-da əlavə olundu, ona görə
 * yuxarıdakı ölçmədə hələ payı yoxdur). Möhlətə salınan bayraq bağlanmır,
 * TƏXİRƏ SALINIR: müddət bitəndə problem qalıbsa TƏZƏ post kimi açılır, yəni
 * gözləmə saatı sıfırdan başlayır. Üç günlük gözləmə iki qısa parçaya bölünür
 * və ölçmədən ümumiyyətlə yox olur. Bu, medianı «bir az» dəyişən şey deyil —
 * ölçülməli olan müddəti görünməz edir.
 *
 * Ona görə üç ayrı say, və `closed` ümumiyyətlə YOXDUR: cəm heç bir sualın
 * cavabı deyildi, saxlansaydı isə növbəti oxucu yenidən onu «həll olundu»
 * kimi oxuyardı. Lazım olan yerdə `closedTotal()` ilə hesablanır.
 *
 * Dizayn və ölçmənin təfərrüatı: docs/satici-fakt-qati-dizayn.md §9.1
 */

/** Problem HƏQİQƏTƏN aradan qalxdı: cavab getdi, ya insan bağlayıb izah yazdı. */
const RESOLVED_REASONS = ["AUTO", "MANUAL"] as const;
/** Möhlət — iş qalır, bayraq müddət bitəndə geri qayıda bilər. */
const DEFERRED_REASONS = ["SNOOZED"] as const;

export interface FlagStats {
  opened: number;
  /** AUTO + MANUAL. Yeganə say ki, «satıcı işi bitirdi» deməkdir. */
  resolved: number;
  /** SNOOZED. Nə həll, nə rədd — təxirə salınmış iş. */
  deferred: number;
  /**
   * Qalanı: SCOPE (dairədən çıxdı), HANDOFF (iş filiala/PR-a keçdi),
   * RATED_NOISE («bu bayraq olmamalıydı»), MUTED (bir daha göstərmə) — və
   * səbəbi bilinməyən nadir sətir. Sonuncu qəsdən buradadır: izah edə
   * bilmədiyimiz bağlanmanı satıcının xanasına yazmaq, ölçünü ən asan
   * pozulan yerindən pozmaq olardı.
   */
  dismissed: number;
  /**
   * Açılışdan HƏLLƏ qədər median, saniyə — yalnız `resolved` üzərində.
   *
   * Adı `medianCloseSeconds` idi və məhz ad problemin yarısı idi: «bağlanma»
   * həll olmayan bağlanmaları da içinə alırdı, ona görə rəqəm nə həll sürətini,
   * nə də başqa bir şeyi ölçürdü — iki fərqli hadisənin qarışığı idi.
   */
  medianResolveSeconds: number | null;
  /** closed_reason → say. Tam bölgü burada qalır — qruplar onun xülasəsidir. */
  byReason: Record<string, number>;
}

/** Ekrandan çıxan bayraqların cəmi. Ölçü deyil, sadəcə cəm — bax yuxarıdakı qeydə. */
export function closedTotal(f: FlagStats): number {
  return f.resolved + f.deferred + f.dismissed;
}

export interface HourProfile {
  hour: number;
  outCount: number;
  opportunities: number;
  responseMedianSeconds: number | null;
}

export interface SnapshotPayload {
  total: SalesMetrics;
  byDayType: SalesRow["byDayType"];
  hours: HourProfile[];
  flags: FlagStats;
  /** Mövzu qarışığı — mövzu qatı qurulandan sonra dolur. */
  topics?: Record<string, { messages: number; responseMedianSeconds: number | null }>;
}

export interface Snapshot {
  userId: number;
  userName: string;
  periodStart: string;
  periodEnd: string;
  opportunities: number;
  unanswered: number;
  frtMedianSeconds: number | null;
  payload: SnapshotPayload;
}

function emptyFlags(): FlagStats {
  return { opened: 0, resolved: 0, deferred: 0, dismissed: 0, medianResolveSeconds: null, byReason: {} };
}

/**
 * Bayraq statistikası — açılan, həll olunan, təxirə salınan, gündəmdən çıxan.
 *
 * Bağlanma vaxtı BAĞLANDIĞI dövrə yazılır, açıldığı dövrə yox: «bu həftə həll
 * etdiklərimiz orta hesabla 3 saatda həll olunub» oxunaqlı cümlədir, «keçən
 * həftə açılanlar nə vaxtsa bağlanacaq» isə deyil.
 *
 * Median YALNIZ həll olunanlar üzərindədir. Bir kliklə susdurulan və ya
 * möhlətə salınan bayraq saniyələr içində ekrandan çıxır, ona görə onları
 * mediana qatmaq ölçünü öz mənasının əksinə çevirirdi.
 */
export async function flagStatsFor(range: Range): Promise<Map<number, FlagStats>> {
  const from = new Date(range.fromTs * 1000);
  const to = new Date(range.toTs * 1000);
  const resolved = [...RESOLVED_REASONS];
  const deferred = [...DEFERRED_REASONS];

  const [totals, reasons] = await Promise.all([
    pool.query<{
      user_id: number; opened: string; closed_total: string;
      resolved: string; deferred: string; median_resolve: string | null;
    }>(
      // `dismissed` burada sayılmır, çıxılır: səbəbləri bir-bir sadalasaq,
      // növbəti closed_reason əlavə olunanda o, səssizcə HEÇ BİR qrupa
      // düşməzdi və cəm tutmazdı. Çıxma isə naməlum səbəbi öz-özünə ən
      // ehtiyatlı xanaya yazır.
      `SELECT user_id,
              count(*) FILTER (WHERE created_at >= $1 AND created_at < $2) AS opened,
              count(*) FILTER (WHERE acknowledged_at >= $1 AND acknowledged_at < $2) AS closed_total,
              count(*) FILTER (WHERE acknowledged_at >= $1 AND acknowledged_at < $2
                                 AND closed_reason = ANY($3::text[])) AS resolved,
              count(*) FILTER (WHERE acknowledged_at >= $1 AND acknowledged_at < $2
                                 AND closed_reason = ANY($4::text[])) AS deferred,
              percentile_cont(0.5) WITHIN GROUP (
                ORDER BY EXTRACT(epoch FROM acknowledged_at - created_at)
              ) FILTER (WHERE acknowledged_at >= $1 AND acknowledged_at < $2
                          AND closed_reason = ANY($3::text[])) AS median_resolve
         FROM katibe.agent_posts
        WHERE kind = 'finding' AND user_id IS NOT NULL
        GROUP BY user_id`,
      [from, to, resolved, deferred],
    ),
    pool.query<{ user_id: number; closed_reason: string | null; n: string }>(
      `SELECT user_id, closed_reason, count(*) AS n
         FROM katibe.agent_posts
        WHERE kind = 'finding' AND user_id IS NOT NULL
          AND acknowledged_at >= $1 AND acknowledged_at < $2
        GROUP BY user_id, closed_reason`,
      [from, to],
    ),
  ]);

  const out = new Map<number, FlagStats>();
  for (const r of totals.rows) {
    const res = Number(r.resolved);
    const def = Number(r.deferred);
    out.set(Number(r.user_id), {
      opened: Number(r.opened),
      resolved: res,
      deferred: def,
      dismissed: Number(r.closed_total) - res - def,
      medianResolveSeconds: r.median_resolve === null ? null : Math.round(Number(r.median_resolve)),
      byReason: {},
    });
  }
  for (const r of reasons.rows) {
    const id = Number(r.user_id);
    const stats = out.get(id) ?? emptyFlags();
    stats.byReason[r.closed_reason ?? "BİLİNMİR"] = Number(r.n);
    out.set(id, stats);
  }
  return out;
}

/**
 * Mövzu qarışığı və mövzu üzrə cavab vaxtı.
 *
 * Cavab vaxtı burada SADƏ tərifdir: etiketlənmiş müştəri mesajından həmin
 * söhbətdəki NÖVBƏTİ cavabımıza qədər. Bu, cədvəldəki ART deyil və olmamalıdır
 * — ART epizod/imkan məntiqi üzərində qurulub, mövzu isə ayrı-ayrı mesajlara
 * yapışır. Fərqli sual, fərqli ölçü; adı da ona görə ayrıdır.
 */
export async function topicStatsFor(
  range: Range,
): Promise<Map<number, Record<string, { messages: number; responseMedianSeconds: number | null }>>> {
  const { rows } = await pool.query<{
    user_id: number; topic: string; messages: string; p50: string | null;
  }>(
    `WITH sales AS (
       SELECT ui.instance_id, u.id AS user_id
         FROM katibe.user_instances ui
         JOIN katibe.users u ON u.id = ui.user_id
         JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
        WHERE ui.ended_at IS NULL
     ),
     msgs AS (
       SELECT s.user_id, m.chat_id, m.id, m.ts, ms.direction
         FROM katibe.message m
         JOIN katibe.message_source ms ON ms.message_id = m.id
         JOIN sales s ON s.instance_id = ms.source_id
         JOIN katibe.chat c ON c.id = m.chat_id AND c.kind IN ('individual','lid')
        WHERE m.ts >= $1::int AND m.ts < $2::int + 86400
     ),
     nxt AS (
       SELECT user_id, id, ts, direction,
              MIN(ts) FILTER (WHERE direction = 'out') OVER (
                PARTITION BY user_id, chat_id ORDER BY ts
                ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS next_out_ts
         FROM msgs
     )
     SELECT n.user_id, t.topic, count(*) AS messages,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY n.next_out_ts - n.ts)
              FILTER (WHERE n.next_out_ts IS NOT NULL) AS p50
       FROM nxt n
       JOIN katibe.message_topic t ON t.message_id = n.id
      WHERE n.direction = 'in' AND n.ts < $2::int
      GROUP BY 1, 2`,
    [range.fromTs, range.toTs],
  );
  const out = new Map<number, Record<string, { messages: number; responseMedianSeconds: number | null }>>();
  for (const r of rows) {
    const id = Number(r.user_id);
    const rec = out.get(id) ?? {};
    rec[r.topic] = {
      messages: Number(r.messages),
      responseMedianSeconds: r.p50 === null ? null : Math.round(Number(r.p50)),
    };
    out.set(id, rec);
  }
  return out;
}

/** 168 xanalıq xəritəni 24 saatlıq profilə yığır — şəkildə saat lazımdır, gün yox. */
function hourProfile(row: SalesRow): HourProfile[] {
  const byHour = new Map<number, { out: number; opp: number; weighted: number }>();
  for (const c of row.heat) {
    const acc = byHour.get(c.hour) ?? { out: 0, opp: 0, weighted: 0 };
    acc.out += c.outCount;
    acc.opp += c.opportunities;
    if (c.responseMedianSeconds !== null) acc.weighted += c.responseMedianSeconds * c.opportunities;
    byHour.set(c.hour, acc);
  }
  return [...byHour.entries()]
    .map(([hour, a]) => ({
      hour,
      outCount: a.out,
      opportunities: a.opp,
      // Medianlar toplana bilmir, ona görə burada imkanla çəkilmiş ortadır —
      // adı da elə yazılır ki, başqa yerdəki medianla qarışdırılmasın.
      responseMedianSeconds: a.opp > 0 && a.weighted > 0 ? Math.round(a.weighted / a.opp) : null,
    }))
    .sort((a, b) => a.hour - b.hour);
}

/** Asia/Baku-da həftənin bazar ertəsi, `weeksAgo` həftə əvvəl. */
export function isoWeekRange(weeksAgo: number): { start: Date; end: Date } {
  const now = new Date();
  // Bakı ofseti tzdata-dan asılıdır; Date-in öz UTC hesabı ilə gün sərhədini
  // tapmaq üçün yerli tarixi sətir kimi alırıq.
  const local = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Baku" }));
  const dow = (local.getDay() + 6) % 7; // 0 = B.e
  const monday = new Date(local);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - dow - weeksAgo * 7);
  const end = new Date(monday);
  end.setDate(end.getDate() + 7);
  return { start: monday, end };
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Bir həftənin şəklini yazır. Yenidən hesablayır, artırmır — eyni həftə üçün
 * ikinci dəfə işləmək sətri əvəz edir (refresh_chat_stats() presedenti).
 */
export async function writeSnapshot(start: Date, end: Date): Promise<number> {
  const range: Range = {
    fromTs: Math.floor(start.getTime() / 1000),
    toTs: Math.floor(end.getTime() / 1000),
  };
  const [stats, flags, topics] = await Promise.all([
    computeSalesStatsWithoutAccessCheck(range),
    flagStatsFor(range),
    topicStatsFor(range),
  ]);

  let written = 0;
  for (const row of stats.rows) {
    if (row.instanceId === null) continue; // nömrəsiz satıcının şəkli olmur
    const payload: SnapshotPayload = {
      total: row.total,
      byDayType: row.byDayType,
      hours: hourProfile(row),
      flags: flags.get(row.userId) ?? emptyFlags(),
      topics: topics.get(row.userId) ?? {},
    };
    await pool.query(
      `INSERT INTO katibe.sales_snapshot
         (user_id, period_start, period_end, payload, opportunities, unanswered, frt_median)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, period_start) DO UPDATE
         SET period_end = EXCLUDED.period_end, payload = EXCLUDED.payload,
             opportunities = EXCLUDED.opportunities, unanswered = EXCLUDED.unanswered,
             frt_median = EXCLUDED.frt_median, computed_at = now()`,
      [
        row.userId, ymd(start), ymd(end), JSON.stringify(payload),
        row.total.opportunities, row.total.unanswered, row.total.frtMedianSeconds,
      ],
    );
    written++;
  }
  return written;
}

/**
 * Köhnə formatlı şəkli yeni sahələrə çevirir.
 *
 * `payload` bazada JSON kimi durur və bir dəfə yazılandan sonra dəyişmir, ona
 * görə 2026-09-06-dan əvvəlki sətirlərdə `resolved`/`deferred`/`dismissed`
 * yoxdur — yerində `closed` var. Sayları BƏRPA ETMƏK OLUR, çünki `byReason`
 * tam bölgünü saxlayıb; qrup yalnız onun xülasəsidir.
 *
 * MEDİAN BƏRPA OLUNMUR və null qalır. Köhnə rəqəm bütün səbəbləri bir yerə
 * yığmışdı, yəni yeni ölçünün cavabını verə bilməz. Onu «təxminən eynidir»
 * deyib keçirmək, məhz düzəltdiyimiz səhvi tarixə köçürmək olardı — müqayisə
 * cədvəlində keçən həftə süni şəkildə sürətli görünərdi. «Rəqəm yoxdur» isə
 * ekranda «—» kimi görünür və heç kimi aldatmır.
 *
 * Bərpa oluna bilən həftələr (postları hələ silinməmiş olanlar) sadəcə
 * yenidən yazıla bilər: `SNAPSHOT_WEEKS=n npm run snapshot:sales`.
 */
function normaliseFlags(raw: unknown): FlagStats {
  const f = (raw ?? {}) as Partial<FlagStats> & { closed?: number };
  const byReason = f.byReason ?? {};
  if (typeof f.resolved === "number") {
    return {
      opened: f.opened ?? 0,
      resolved: f.resolved,
      deferred: f.deferred ?? 0,
      dismissed: f.dismissed ?? 0,
      medianResolveSeconds: f.medianResolveSeconds ?? null,
      byReason,
    };
  }
  const count = (keys: readonly string[]) =>
    keys.reduce((n, k) => n + (byReason[k] ?? 0), 0);
  const total = Object.values(byReason).reduce((n, v) => n + v, 0);
  const resolved = count(RESOLVED_REASONS);
  const deferred = count(DEFERRED_REASONS);
  return {
    opened: f.opened ?? 0,
    resolved,
    deferred,
    // Köhnə sətirdə `closed` ilə `byReason` cəmi fərqlənə bilər (səbəbsiz
    // bağlanma «BİLİNMİR» açarına düşürdü) — böyüyü götürülür ki, heç bir
    // bayraq yolda itməsin.
    dismissed: Math.max(f.closed ?? 0, total) - resolved - deferred,
    medianResolveSeconds: null,
    byReason,
  };
}

function normalisePayload(payload: SnapshotPayload): SnapshotPayload {
  return { ...payload, flags: normaliseFlags(payload.flags) };
}

/** Ən yeni `limit` həftənin şəkli, köhnədən yeniyə. */
export async function readSnapshots(limit = 12): Promise<Snapshot[]> {
  const { rows } = await pool.query(
    `SELECT s.user_id, u.name, s.period_start, s.period_end, s.opportunities,
            s.unanswered, s.frt_median, s.payload
       FROM katibe.sales_snapshot s
       JOIN katibe.users u ON u.id = s.user_id
      WHERE s.period_start >= (
        SELECT COALESCE(min(period_start), CURRENT_DATE)
          FROM (SELECT DISTINCT period_start FROM katibe.sales_snapshot
                 ORDER BY period_start DESC LIMIT $1) p)
      ORDER BY s.period_start ASC, u.name ASC`,
    [limit],
  );
  return rows.map((r) => ({
    userId: Number(r.user_id),
    userName: r.name as string,
    periodStart: ymd(r.period_start as Date),
    periodEnd: ymd(r.period_end as Date),
    opportunities: Number(r.opportunities),
    unanswered: Number(r.unanswered),
    frtMedianSeconds: r.frt_median === null ? null : Number(r.frt_median),
    // Şəkil bir daha dəyişmir, ona görə köhnə format oxunuş anında çevrilir —
    // bazaya toxunmadan, hər oxucu üçün bir dəfə.
    payload: normalisePayload(r.payload as SnapshotPayload),
  }));
}
