import { pool } from "../db";

// İnstansın WhatsApp bağlantısının vəziyyəti və tarixçəsi.
//
// Nəzarətçinin bütün tapıntıları evolution_api."Message" cədvəlindən gəlir,
// yəni SESSİYA SAĞ OLDUĞU MÜDDƏTDƏ doğrudur. Sessiya qopanda cədvəl donur:
// müştəri yazsa da gəlmir, satıcı telefondan cavab versə də düşmür. Bu halda
// köhnə bayraqlar yalan danışmağa başlayır — "cavabsız" saatı öz-özünə böyüyür,
// halbuki cavab çoxdan verilib. 2026-08-25-də Rouz və Rouz-2 dörd saat belə
// qaldı.
//
// Ona görə iki qərar bu modula bağlıdır:
//   1. Qopuq instans üçün gedişat ATLANIR (run.ts) və onun bayraqları lentdə
//      GİZLƏNİR (feed.ts) — yalnız "qopub" bayrağı görünür.
//   2. İnstans qayıdanda bayraqlar qopma anından etibarən YENİDƏN yoxlanılır:
//      hələ də keçərli olanlar qalır, həll olunmuşlar avtomatik bağlanır.
//
// Vəziyyət Evolution-un öz sətrindən oxunur, tarixçə isə burada saxlanılır
// (sql/2026-08-26_instance_connectivity.sql).

/**
 * Qayıdışdan sonra bu qədər gözlənilir.
 *
 * WhatsApp qoşulan kimi oflayn növbəni göndərir və Evolution onları bazaya
 * yazana qədər bir neçə dəqiqə keçir. Həmin ara pəncərədə yoxlama aparsaq,
 * hələ gəlib çatmamış cavabı "yoxdur" sayıb TƏZƏ yalan bayraq açardıq — yəni
 * düz qaçdığımız səhvi qapının o biri tərəfindən içəri buraxardıq.
 */
const SYNC_GRACE_MINUTES = 10;

/**
 * Qopmanı İLK DƏFƏ görəndə başlanğıc kimi nə götürülür.
 *
 * Öz tarixçəmiz boş olanda (ilk qurulma, uzun sürən qopma) "indi" demək
 * qopmanı təzəcə baş vermiş kimi göstərərdi. Evolution-un öz izləri daha
 * yaxındır: "disconnectionAt" doldurulubsa o, yoxdursa sətrin son yenilənmə
 * anı — status dəyişikliyi məhz onu yeniləyir. İkisi də köhnə ola bilər, ona
 * görə 24 saatdan geriyə buraxılmır: yenidən yoxlama pəncərəsi onsuz da o
 * qədərdir (run.ts).
 */
const OUTAGE_START = `GREATEST(
    COALESCE(i."disconnectionAt" AT TIME ZONE 'UTC', i."updatedAt" AT TIME ZONE 'UTC', now()),
    now() - interval '24 hours'
  )`;

export interface Connectivity {
  instanceId: string;
  instanceName: string;
  /** Evolution-dakı xam dəyər: 'open' | 'connecting' | 'close'. */
  status: string;
  online: boolean;
  /** Statusun son dəyişmə anı — qoşulu instans üçün "nə vaxtdan bəri qayıdıb". */
  changedAt: Date;
  /** Açıq qopmanın başlanğıcı; qoşulu ikən null. */
  downSince: Date | null;
  /** Qayıdış nişanı: bayraqlar bu andan etibarən yenidən yoxlanmalıdır. */
  revalidateFrom: Date | null;
}

function mapRow(r: Record<string, unknown>): Connectivity {
  const status = String(r.status);
  return {
    instanceId: String(r.instance_id),
    instanceName: String(r.instance_name ?? ""),
    status,
    online: status === "open",
    changedAt: new Date(r.changed_at as string),
    downSince: r.down_since ? new Date(r.down_since as string) : null,
    revalidateFrom: r.revalidate_from ? new Date(r.revalidate_from as string) : null,
  };
}

/**
 * Evolution-dakı indiki vəziyyəti oxuyur, tarixçəni yeniləyir və nəticəni
 * qaytarır. Həm gedişat (saatın 05-i), həm sağlamlıq yoxlaması (25-i) çağırır —
 * beləcə qopma və qayıdış anı yarım saatdan artıq gecikmir.
 *
 * Bir sorğu, bir gediş: status dəyişməyibsə yalnız checked_at yenilənir, yəni
 * changed_at doğrudan "nə vaxtdan bəri belədir" sualına cavab verir.
 */
export async function syncConnectivity(readOnly = false): Promise<Map<string, Connectivity>> {
  // Dry-run heç nə yazmır — vəziyyət canlı sətirdən, tarixçə isə yaddaşdakı
  // sətirdən oxunur.
  if (readOnly) {
    const { rows } = await pool.query(
      `SELECT i.id AS instance_id, i.name AS instance_name, i."connectionStatus"::text AS status,
              COALESCE(c.changed_at, now()) AS changed_at,
              COALESCE(c.down_since,
                       CASE WHEN i."connectionStatus" <> 'open' THEN ${OUTAGE_START} END) AS down_since,
              c.revalidate_from
       FROM evolution_api."Instance" i
       LEFT JOIN katibe.instance_connectivity c ON c.instance_id = i.id`,
    );
    return new Map(rows.map((r) => [String(r.instance_id), mapRow(r)]));
  }

  const { rows } = await pool.query(
    `WITH live AS (
       SELECT i.id, i.name, i."connectionStatus"::text AS status, ${OUTAGE_START} AS outage_start
       FROM evolution_api."Instance" i
     ),
     upserted AS (
       INSERT INTO katibe.instance_connectivity AS ic (instance_id, status, changed_at, checked_at, down_since)
       SELECT l.id, l.status, now(), now(),
              CASE WHEN l.status <> 'open' THEN l.outage_start END
       FROM live l
       ON CONFLICT (instance_id) DO UPDATE SET
         status = EXCLUDED.status,
         checked_at = now(),
         changed_at = CASE WHEN ic.status IS DISTINCT FROM EXCLUDED.status
                           THEN now() ELSE ic.changed_at END,
         -- Qopma davam edirsə başlanğıc dəyişmir; qoşulanda təmizlənir.
         down_since = CASE WHEN EXCLUDED.status <> 'open'
                           THEN COALESCE(ic.down_since, EXCLUDED.down_since, now()) END,
         -- Qopuq → qoşulu keçidi nişanı qoyur. Nişan artıq varsa (əvvəlki
         -- qayıdış hələ yoxlanılmayıb) KÖHNƏSİ saxlanılır: pəncərə geniş
         -- qalsın, dar yox.
         revalidate_from = CASE
           WHEN EXCLUDED.status = 'open' AND ic.status <> 'open'
             THEN LEAST(
                    COALESCE(ic.revalidate_from, 'infinity'::timestamptz),
                    COALESCE(ic.down_since, ic.changed_at)
                  )
           ELSE ic.revalidate_from END
       RETURNING instance_id, status, changed_at, down_since, revalidate_from
     )
     SELECT u.*, l.name AS instance_name FROM upserted u JOIN live l ON l.id = u.instance_id`,
  );
  return new Map(rows.map((r) => [String(r.instance_id), mapRow(r)]));
}

/** Yazmadan oxu — lent və skriptlər üçün. */
export async function getConnectivity(instanceId: string): Promise<Connectivity | null> {
  const { rows } = await pool.query(
    `SELECT c.instance_id, c.status, c.changed_at, c.down_since, c.revalidate_from, i.name AS instance_name
     FROM katibe.instance_connectivity c
     JOIN evolution_api."Instance" i ON i.id = c.instance_id
     WHERE c.instance_id = $1`,
    [instanceId],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

/**
 * Qayıdış nişanı var və oflayn növbənin gəlməsi üçün kifayət qədər vaxt keçib?
 *
 * Keçməyibsə gedişat instansı normal (dar) pəncərə ilə yoxlayır və nişan
 * yerində qalır — növbəti saatda təzədən baxılır.
 */
export function readyForRevalidation(c: Connectivity, now: Date = new Date()): boolean {
  if (!c.online || c.revalidateFrom === null) return false;
  return now.getTime() - c.changedAt.getTime() >= SYNC_GRACE_MINUTES * 60_000;
}

/** Yenidən yoxlama bitdi — nişan silinir. */
export async function clearRevalidation(instanceId: string): Promise<void> {
  await pool.query(
    `UPDATE katibe.instance_connectivity SET revalidate_from = NULL WHERE instance_id = $1`,
    [instanceId],
  );
}

/** "4 saat 12 dəq" — jurnal və lent mətnləri üçün. */
export function formatOutage(since: Date, now: Date = new Date()): string {
  const mins = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  const h = Math.floor(mins / 60);
  return h === 0 ? `${mins} dəq` : `${h} saat ${mins % 60} dəq`;
}
