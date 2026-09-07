import { pool } from "../db";
import { systemScope } from "../access";
import type { SalesInstance } from "./types";

/**
 * Nəzarətçinin izlədiyi instanslar: sahibi HAZIRDA Sales kateqoriyalı user
 * olan aktiv təyinatlar. Kateqoriya adı ilə süzülür, ID ilə yox — admin
 * paneldə yeni Sales user yaradılıb instans alanda bu siyahıya öz-özünə
 * düşür, kod dəyişmir.
 */
export async function getSalesInstances(): Promise<SalesInstance[]> {
  const { rows } = await pool.query(
    `SELECT ui.instance_id, i.name AS instance_name, u.id AS user_id, u.name AS user_name
     FROM katibe.user_instances ui
     JOIN katibe.users u ON u.id = ui.user_id
     JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
     JOIN evolution_api."Instance" i ON i.id = ui.instance_id
     WHERE ui.ended_at IS NULL
     ORDER BY u.name ASC`,
  );
  // Cron prosesinin sessiyası yoxdur, ona görə markalama BURADA, bir dəfə
  // olur — və bu fayl systemScope-un icazəli yerlərindəndir (CI yoxlayır).
  // Bundan sonra bütün Nəzarətçi axını markalı ID daşıyır.
  return rows.map((r) => ({
    instanceId: systemScope(r.instance_id),
    instanceName: r.instance_name,
    userId: r.user_id,
    userName: r.user_name,
  }));
}

interface BusinessCalendar {
  timezone: string;
  /** "HH:MM:SS" — sla_rule_versions-dakı time sütunu bu formada gəlir. */
  businessStart: string;
  businessEnd: string;
  /** ISO həftə günləri, 1=B.e ... 7=Bazar. */
  businessDays: number[];
  /** Qaydası olmayan user üçün ehtiyat cədvəl işlədilib. */
  fallback: boolean;
}

// SLA qaydası olmayan user üçün ehtiyat təqvim. sla_target_seconds() NULL
// qaytaranda pozuntu hədəfi üçün ayrıca ehtiyat var (detectors.ts) — bu
// yalnız "iş saatıdır ya yox" sualına cavab verir.
const FALLBACK_CALENDAR: BusinessCalendar = {
  timezone: "Asia/Baku",
  businessStart: "09:00:00",
  businessEnd: "19:00:00",
  businessDays: [1, 2, 3, 4, 5, 6],
  fallback: true,
};

/** User-in bu an qüvvədə olan SLA qayda versiyasının təqvimi, yoxdursa ehtiyat. */
export async function getBusinessCalendar(userId: number): Promise<BusinessCalendar> {
  const { rows } = await pool.query(
    `SELECT v.timezone, v.business_start, v.business_end, v.business_days
     FROM katibe.user_sla_rules usr
     JOIN katibe.sla_rule_versions v
       ON v.rule_id = usr.rule_id
      AND tstzrange(v.effective_from, COALESCE(v.effective_to, 'infinity'::timestamptz)) @> now()
     WHERE usr.user_id = $1
       AND tstzrange(usr.assigned_at, COALESCE(usr.ended_at, 'infinity'::timestamptz)) @> now()
     LIMIT 1`,
    [userId],
  );
  if (rows.length === 0) return FALLBACK_CALENDAR;
  const r = rows[0];
  return {
    timezone: r.timezone,
    businessStart: String(r.business_start),
    businessEnd: String(r.business_end),
    businessDays: (r.business_days as number[]).map(Number),
    fallback: false,
  };
}

const SAMPLE_MINUTES = 5;

/**
 * Pəncərənin iş saatları ilə kəsişməsi, dəqiqə ilə.
 *
 * Dəqiq interval hesabı əvəzinə 5 dəqiqəlik addımlarla nümunə götürülür:
 * pəncərə ən çox 12 saatdır (144 nümunə), qərar isə "0-dır ya deyil" və
 * "1 saatdan çoxdur ya yox" səviyyəsindədir — bu dəqiqlik artıqlaması ilə
 * bəs edir və gün sərhədindən keçən pəncərələrdə timezone riyaziyyatı ilə
 * əlləşmir.
 */
export function businessOverlapMinutes(
  windowStart: Date,
  windowEnd: Date,
  cal: BusinessCalendar,
): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: cal.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const ISO_DOW: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const toMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const startMin = toMinutes(cal.businessStart);
  const endMin = toMinutes(cal.businessEnd);

  let overlap = 0;
  for (let t = windowStart.getTime(); t < windowEnd.getTime(); t += SAMPLE_MINUTES * 60_000) {
    const parts = fmt.formatToParts(new Date(t));
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const local = hour * 60 + minute;
    if (cal.businessDays.includes(ISO_DOW[weekday] ?? 0) && local >= startMin && local < endMin) {
      overlap += SAMPLE_MINUTES;
    }
  }
  return overlap;
}

/**
 * Nəzarətçinin ÖZ iş pəncərəsi — SLA təqvimindən qəsdən genişdir.
 *
 * İki fərqli sual, iki fərqli təqvim:
 *   SLA təqvimi (yuxarıda)  — "bu mesaja nə vaxta qədər cavab verilməli idi".
 *                             Satıcının öhdəliyidir, pozuntu balı ondan çıxır,
 *                             ona görə TOXUNULMUR (10:00–19:00, B.e–Cümə).
 *   Nəzarət pəncərəsi (bu)  — "nəzarətçi nə vaxt baxsın". Baxış saatını
 *                             uzatmaq heç kimin hədəfini sərtləşdirmir:
 *                             axşam 19:30-da gələn mesajın hədəfi onsuz da
 *                             "iş saatından kənar" tarifidir (2 saat), sadəcə
 *                             indi həmin pozuntu səhərə qədər gözləmir.
 *
 * Standart: Bakı 09:00–21:00, B.e–Şənbə. .env.local-dan dəyişir.
 */
function coverageCalendar(): BusinessCalendar {
  const days = (process.env.SUP_COVERAGE_DAYS ?? "1,2,3,4,5,6")
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  return {
    timezone: process.env.SUP_COVERAGE_TZ ?? "Asia/Baku",
    businessStart: process.env.SUP_COVERAGE_START ?? "09:00:00",
    businessEnd: process.env.SUP_COVERAGE_END ?? "21:00:00",
    businessDays: days.length > 0 ? days : [1, 2, 3, 4, 5, 6],
    fallback: false,
  };
}

/**
 * Pəncərənin nəzarət saatları ilə kəsişməsi, dəqiqə ilə. 0 olanda gedişat
 * yalnız açıq bayraqları təzələyir və həll olunanları bağlayır — yeni post
 * açılmır, model çağırılmır.
 */
export function coverageOverlapMinutes(windowStart: Date, windowEnd: Date): number {
  return businessOverlapMinutes(windowStart, windowEnd, coverageCalendar());
}

/** Jurnal və lent mətnləri üçün: "09:00–21:00, B.e–Şənbə". */
export function coverageLabel(): string {
  const cal = coverageCalendar();
  const NAMES = ["", "B.e", "Ç.a", "Çər", "C.a", "Cümə", "Şən", "Baz"];
  const days = [...cal.businessDays].sort((a, b) => a - b);
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
  const span = days.length === 7 ? "hər gün" : contiguous && days.length > 1
    ? `${NAMES[days[0]]}–${NAMES[days[days.length - 1]]}`
    : days.map((d) => NAMES[d]).join(", ");
  return `${cal.businessStart.slice(0, 5)}–${cal.businessEnd.slice(0, 5)}, ${span}`;
}

/**
 * Nəzarətçinin söhbət dairəsi: kateqoriyası **Client** olanlar VƏ hələ heç
 * bir kateqoriyaya salınmamışlar. Qalan kateqoriyalar (Supplier, Production,
 * Accounting, Sales, Owner, PR, Other) satış nəzarətinin mövzusu deyil —
 * onlara nə bayraq qalxır, nə də model çağırılır.
 *
 * Etiketsiz nömrə QƏSDƏN dairənin içindədir: identify-clients gündə bir dəfə
 * işləyir və 5 mesajdan azına toxunmur, ona görə təzə müştəri saatlarla
 * etiketsiz qalır. Onu süzsək, yeni müştəri məhz ən vacib günündə —
 * birincisində — görünməz olardı.
 *
 * Süzgəc "Client-dir" yox, "başqa kateqoriyada DEYİL" kimi yazılıb; belə
 * olanda etiketi olmayan da, etiketi olub kateqoriyası boş qalan da içəridə
 * qalır (contact_labels.category_id NULL ola bilər — FK ON DELETE SET NULL).
 *
 * katibe.contact_labels qəsdən instansdan asılı deyil (adlar qlobaldır),
 * ona görə predikat yalnız JID ilə işləyir. Alias-lar `s`-lə başlayır ki,
 * çağıran sorğulardakı cl/cat alias-ları ilə toqquşmasın.
 */
export function clientScopeSql(jidExpr: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM katibe.contact_labels scl
    JOIN katibe.categories scat ON scat.id = scl.category_id
    WHERE scl.remote_jid = ${jidExpr} AND scat.name <> 'Client'
  )`;
}
