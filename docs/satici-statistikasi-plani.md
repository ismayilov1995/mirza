# Satıcı statistikası ekranı — icra planı

> **Agent işçilər üçün:** planı addım-addım icra et; hər addım bir hərəkətdir.
> Qutucuqlar (`- [ ]`) izləmə üçündür.

**Məqsəd:** `/admin/satis` ekranı — satıcıları yan-yana müqayisə edən cədvəl,
gün × saat istilik xəritəsi və iş günü / şənbə / bazar paneli.

**Arxitektura:** Bir SQL sorğusu (`GROUPING SETS`) kanonik anbardan dörd grain
qaytarır; TypeScript onu satıcı obyektlərinə yığır; ekran server komponentidir,
süzgəclər URL-də yaşayır. Yeni cədvəl, migration və cron YOXDUR.

**Texnologiya:** Next.js (App Router, server komponentlər), `pg`, Postgres
`GROUPING SETS` + `percentile_cont`, mövcud `src/components/ui` primitivləri.

**Spesifikasiya:** `docs/satici-statistikasi-dizayn.md` — plan ondan
arqumentləşir, icra edən hər ikisini oxuyur.

## Qlobal məhdudiyyətlər

- **Dil:** bütün UI mətni Azərbaycan dilində. Ekranın adı **«Satıcılar»**, URL
  `/admin/satis` — başqa ad işlədilmir.
- **`docs/rules.md` məcburidir:** `AppShell` + `AppHeader` + `TopBar` çərçivəsi,
  xam rəng/ölçü/boşluq yoxdur, rəqəmlər `--font-numeric` + `tabular-nums`,
  rəng tək daşıyıcı deyil, süzgəclər URL-də, telefon sərhədi `860px`, cədvəl
  öz qabında sürüşür.
- **Ölçmə sabitləri** `getWorkloadStats()` ilə eyni: epizod fasiləsi
  `1209600` san (14 gün), cavabsızlıq həddi `86400` san (24 saat), ART
  tavanı `86400` san.
- **Zona:** `Asia/Baku`, gün və saat həmişə bu zonada.
- **Dairə:** `chat.kind IN ('individual','lid')`, `contact_labels`-da
  `Client`-dən fərqli kateqoriya YOXDURSA (Nəzarətçinin `clientScopeSql()`
  qaydası), mənbə `kind='evolution'`.
- **Gün növü:** `week` (isodow 1–5), `sat` (6), `sun` (7); müştəri mesajının
  GƏLDİYİ ana görə.
- **İcazə:** ekran `requireAdmin()` ilə qorunur.

---

### Task 1: Sorğu qatı

**Fayllar:**
- Yarat: `src/lib/sales-stats.ts`
- Yarat: `scripts/smoke-sales-stats.ts`
- Dəyiş: `package.json` (skript: `"smoke:sales": "tsx scripts/smoke-sales-stats.ts"`)
- Dəyiş: `scripts/check-access-boundaries.sh` (üçüncü yoxlama)

**İnterfeyslər:**
- İşlədir: `pool` (`@/lib/db`), `requireAdmin` (`@/lib/access`).
- Verir (sonrakı tasklar bunlara söykənir):

```ts
export type DayType = "week" | "sat" | "sun";

export interface SalesMetrics {
  opportunities: number;
  unanswered: number;
  slaBreach: number;
  slaMeasured: number;
  slaUncovered: number;
  /** Cavablanmış imkanların median gözləməsi, saniyə. */
  responseMedianSeconds: number | null;
  frtMedianSeconds: number | null;
  artMedianSeconds: number | null;
  artP90Seconds: number | null;
}

export interface HeatCell {
  isoDow: number;   // 1..7
  hour: number;     // 0..23
  outCount: number;
  opportunities: number;
  responseMedianSeconds: number | null;
}

export interface SalesRow {
  userId: number;
  userName: string;
  instanceId: string | null;
  instanceName: string | null;
  total: SalesMetrics;
  byDayType: Record<DayType, SalesMetrics>;
  heat: HeatCell[];
}

export interface SalesStats {
  days: number;
  rows: SalesRow[];
  /** Komanda medianı — sətirlərin dəyərlərinin medianı, satıcı sayına görə. */
  team: {
    unansweredPct: number | null;
    slaBreachPct: number | null;
    frtMedianSeconds: number | null;
    artMedianSeconds: number | null;
  };
}

export async function getSalesStats(days: number): Promise<SalesStats>;
export async function computeSalesStatsWithoutAccessCheck(days: number): Promise<SalesStats>;
```

- [ ] **Addım 1: Yoxlama skriptini yaz (hələ uğursuz olacaq)**

`scripts/smoke-sales-stats.ts`:

```ts
/**
 * Satıcı statistikasının invariantları.
 *
 * Bu, "rəqəm düzdürmü" yoxlaması deyil — canlı bazada düz cavab bilinmir.
 * Yoxlanan şey sorğunun ÖZ-ÖZÜ ilə ziddiyyətə düşməməsidir: hissələr toplama
 * bərabərdir, faizlər sərhəddədir, median cavablanmış sətirdən gəlir.
 * Sorğu pozulanda bunlardan biri mütləq sınır.
 *
 * Run: npm run smoke:sales
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

let failures = 0;
function check(ok: boolean, label: string, extra = "") {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok    " : "PROBLEM"} ${label}${extra ? `  — ${extra}` : ""}`);
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const { computeSalesStatsWithoutAccessCheck } = await import("../src/lib/sales-stats");

  const started = Date.now();
  const stats = await computeSalesStatsWithoutAccessCheck(30);
  const elapsed = Date.now() - started;

  check(stats.rows.length > 0, "ən azı bir satıcı sətri var", `${stats.rows.length} sətir`);
  check(elapsed < 15000, "30 günlük sorğu 15 saniyədən tezdir", `${elapsed} ms`);

  for (const r of stats.rows) {
    const d = r.byDayType;
    const sum = d.week.opportunities + d.sat.opportunities + d.sun.opportunities;
    check(sum === r.total.opportunities,
      `${r.userName}: gün növləri cəmi ümumi ilə üst-üstə düşür`,
      `${sum} = ${r.total.opportunities}`);
    check(r.total.unanswered <= r.total.opportunities,
      `${r.userName}: cavabsız sayı imkandan çox deyil`);
    check(r.total.slaBreach <= r.total.slaMeasured,
      `${r.userName}: SLA pozuntusu ölçülənlərdən çox deyil`);
    check(r.total.slaMeasured + r.total.slaUncovered === r.total.opportunities,
      `${r.userName}: ölçülən + ölçülməyən = imkan`);
    check(r.heat.every((c) => c.isoDow >= 1 && c.isoDow <= 7 && c.hour >= 0 && c.hour <= 23),
      `${r.userName}: istilik xəritəsinin xanaları sərhəd daxilindədir`);
    check(r.heat.length <= 7 * 24, `${r.userName}: xəritədə 168-dən çox xana yoxdur`,
      `${r.heat.length}`);
    check(r.heat.every((c) => c.responseMedianSeconds === null || c.opportunities > 0),
      `${r.userName}: median yalnız imkanı olan xanada var`);
  }

  // Nömrəsi olmayan satıcı da sətir alır — gizlətmək "statistikası yaxşıdır"
  // kimi oxunardı.
  const { rows: noPhone } = await pool.query<{ n: string }>(
    `SELECT u.name AS n FROM katibe.users u
     JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
     WHERE NOT EXISTS (SELECT 1 FROM katibe.user_instances ui
                       WHERE ui.user_id = u.id AND ui.ended_at IS NULL)`,
  );
  for (const p of noPhone) {
    const row = stats.rows.find((r) => r.userName === p.n);
    check(row !== undefined && row.instanceId === null,
      `nömrəsiz satıcı sətri qalır: ${p.n}`);
  }

  console.log(failures === 0 ? "\nNƏTİCƏ: keçdi." : `\nNƏTİCƏ: ${failures} PROBLEM.`);
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

`package.json`-un `scripts` blokuna əlavə et:

```json
    "smoke:sales": "tsx scripts/smoke-sales-stats.ts",
```

- [ ] **Addım 2: İşlət və uğursuz olduğunu gör**

Run: `npm run smoke:sales`
Gözlənilən: `Cannot find module '../src/lib/sales-stats'` ilə dayanır.

- [ ] **Addım 3: `src/lib/sales-stats.ts` yaz**

Sorğu canlı bazada yoxlanılıb (30 gün, 2.3 s). Olduğu kimi köçür:

```ts
import { pool } from "./db";
import { requireAdmin } from "./access";

/* ... tiplər yuxarıdakı «İnterfeyslər» blokundan olduğu kimi ... */

const EPISODE_GAP_SECONDS = 14 * 24 * 60 * 60;
const UNANSWERED_AFTER_SECONDS = 24 * 60 * 60;

const SQL = `
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
  WHERE m.ts > EXTRACT(epoch FROM now() - make_interval(days => $1::int))::int
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
  SELECT *, SUM(CASE WHEN prev_ts IS NULL OR ts - prev_ts > $2::int THEN 1 ELSE 0 END)
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
    COALESCE(next_out_ts, EXTRACT(epoch FROM now())::int) - ts AS waited,
    katibe.sla_target_seconds(instance_id, to_timestamp(ts)) AS target
  FROM local WHERE direction = 'in' AND (next_dir IS NULL OR next_dir = 'out')
),
reply AS (
  SELECT user_id, chat_id, episode_no, ts, ts - prev_ts AS gap,
    CASE WHEN prev_isodow = 7 THEN 'sun' WHEN prev_isodow = 6 THEN 'sat' ELSE 'week' END AS day_type
  FROM local WHERE direction = 'out' AND prev_dir = 'in' AND (ts - prev_ts) BETWEEN 1 AND $3::int
),
first_reply AS (
  SELECT DISTINCT ON (user_id, chat_id, episode_no) user_id, day_type, gap
  FROM reply ORDER BY user_id, chat_id, episode_no, ts
),
outgoing AS (
  SELECT user_id, isodow, hour FROM local WHERE direction = 'out'
)
SELECT 'opp' AS part, user_id, day_type,
       CASE WHEN GROUPING(hour) = 0 THEN isodow END AS isodow,
       CASE WHEN GROUPING(hour) = 0 THEN hour END AS hour,
       count(*) AS n,
       count(*) FILTER (WHERE next_out_ts IS NULL OR waited > $3::int) AS unanswered,
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
```

Yığma qaydaları (TS tərəfi):

1. Satıcı siyahısı AYRICA sorğudan gəlir — nömrəsi olmayan satıcı da sətir
   almalıdır, mesaj sorğusunda isə onun heç bir sətri yoxdur:

```sql
SELECT u.id, u.name, ui.instance_id, i.name AS instance_name
FROM katibe.users u
JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
LEFT JOIN katibe.user_instances ui ON ui.user_id = u.id AND ui.ended_at IS NULL
LEFT JOIN evolution_api."Instance" i ON i.id = ui.instance_id
ORDER BY u.name ASC
```

2. `part='opp'` + `day_type IS NULL` + `hour IS NULL` → `total`-ın imkan/
   cavabsız/SLA/`responseMedianSeconds` sahələri.
3. `part='opp'` + `day_type` doludur → `byDayType[dayType]`.
4. `part='opp'` + `hour` doludur → `heat` xanasının `opportunities` və
   `responseMedianSeconds` sahələri.
5. `part='art'` → `artMedianSeconds` (`p50`), `artP90Seconds` (`p90`).
6. `part='frt'` → `frtMedianSeconds` (`p50`).
7. `part='out'` → `heat` xanasının `outCount` sahəsi.
8. Boş gün növü sıfır metriklə doldurulur — `byDayType.sun` heç vaxt
   `undefined` olmamalıdır, yoxsa ekran üç sütunun birini itirər.
9. `percentile_cont` `float8` qaytarır; `Math.round` ilə tam saniyəyə
   yuvarlaqlaşdır, `null` olduğu kimi saxla.
10. `team` medianları TS-də hesablanır: hər metrik üçün **nömrəsi olan**
    satıcıların dəyərləri sıralanır və ortadakı götürülür (cüt saydakı iki
    ortanın ortalaması). Nömrəsiz satıcı medianı sürüşdürməməlidir.

İki ixrac:

```ts
/** Sessiyası olmayan proseslər (smoke skripti) üçün. Səhifədən ÇAĞIRILMIR. */
export async function computeSalesStatsWithoutAccessCheck(days: number): Promise<SalesStats> { /* yuxarıdakı sorğu + yığma */ }

/** Ekranın işlətdiyi yeganə giriş. */
export async function getSalesStats(days: number): Promise<SalesStats> {
  await requireAdmin();
  return computeSalesStatsWithoutAccessCheck(days);
}
```

`days` yalnız `7 | 30 | 90` ola bilər; başqa dəyər `30`-a düşür (parametr
sorğuya `$1` kimi gedir, amma sərhədi funksiya özü qoyur).

- [ ] **Addım 4: Yoxlamanı işlət, keçdiyini gör**

Run: `npm run smoke:sales`
Gözlənilən: `NƏTİCƏ: keçdi.`

- [ ] **Addım 5: Sərhəd yoxlamasına üçüncü qayda əlavə et**

`scripts/check-access-boundaries.sh`-ə, ikinci yoxlamadan sonra:

```bash
# 3. computeSalesStatsWithoutAccessCheck() requireAdmin-i atlayır — yalnız
#    sessiyası olmayan skriptlər üçündür. src/app/ altında görünməsi admin
#    ekranının hamıya açıldığı deməkdir.
SALES_ALLOWED='^(scripts/|src/lib/sales-stats\.ts)'
sales_hits=$(grep -rn "computeSalesStatsWithoutAccessCheck" --include="*.ts" --include="*.tsx" src scripts mcp 2>/dev/null \
             | grep -vE "$SALES_ALLOWED" || true)

if [ -n "$sales_hits" ]; then
  echo "computeSalesStatsWithoutAccessCheck() icazəsiz yerdə işlədilib:"
  echo "$sales_hits"
  fail=1
else
  echo "ok: satıcı statistikası yalnız requireAdmin-dən keçir"
fi
```

Run: `npm run check:access`
Gözlənilən: üç sətir də `ok:`.

- [ ] **Addım 6: Commit**

```bash
git add src/lib/sales-stats.ts scripts/smoke-sales-stats.ts scripts/check-access-boundaries.sh package.json
git commit -m "feat(satıcı): satıcı statistikasının sorğu qatı"
```

---

### Task 2: Ekran, müqayisə cədvəli və gün növü paneli

**Fayllar:**
- Yarat: `src/app/admin/satis/page.tsx`
- Yarat: `src/app/admin/satis/SalesTable.tsx`
- Yarat: `src/app/admin/satis/DayTypePanel.tsx`
- Yarat: `src/app/admin/satis/satis.module.css`
- Yarat: `scripts/smoke-sales-screen.ts`
- Dəyiş: `package.json` (`"smoke:sales:screen": "tsx scripts/smoke-sales-screen.ts"`)
- Dəyiş: `src/app/admin/page.tsx` (ekrana link)

**İnterfeyslər:**
- İşlədir: `getSalesStats`, `SalesStats`, `SalesRow`, `SalesMetrics`, `DayType`
  (Task 1); `AppShell`, `TopBar`, `Panel`, `FilterChip`, `EmptyState`
  (`@/components/ui`); `AppHeader`; `formatDuration` (`@/lib/format`).
- Verir: `SalesTable({ stats }: { stats: SalesStats })`,
  `DayTypePanel({ stats }: { stats: SalesStats })`.

- [ ] **Addım 1: Ekranın yoxlama skriptini yaz**

`scripts/smoke-sales-screen.ts` — `scripts/smoke-chat-screen.ts` ilə eyni
qəlibdə: müvəqqəti hesab qurur, login olur, səhifəni çəkir, hesabı silir.
Yoxlanan dörd şey:

```ts
    // admin görür
    const admin = await get("/admin/satis", adminCookie);
    check(admin.status === 200, "admin ekranı aça bilir", String(admin.status));
    check(admin.body.includes("Satıcılar"), "ekranın adı yerindədir");
    for (const name of salesNames) {
      check(admin.body.includes(name), `cədvəldə ${name} sətri var`);
    }
    // viewer görmür
    const viewer = await get("/admin/satis", viewerCookie);
    check(viewer.status === 403, "viewer 403 alır", String(viewer.status));
    // pəncərə süzgəci URL-dədir və işləyir
    const wide = await get("/admin/satis?d=90", adminCookie);
    check(wide.status === 200 && wide.body.includes("90 gün"),
      "90 günlük pəncərə seçilə bilir");
```

`salesNames` bazadan gəlir:

```sql
SELECT u.name FROM katibe.users u
JOIN katibe.categories c ON c.id = u.category_id AND c.name = 'Sales'
```

- [ ] **Addım 2: İşlət, uğursuz olduğunu gör**

Run: `npm run dev` (ayrı terminalda), sonra `npm run smoke:sales:screen`
Gözlənilən: `/admin/satis` 404 verir, yoxlamalar PROBLEM göstərir.

- [ ] **Addım 3: Səhifəni yaz**

`src/app/admin/satis/page.tsx`:

```tsx
import { Suspense } from "react";
import { AppShell, FilterChip, TopBar } from "@/components/ui";
import AppHeader from "@/components/AppHeader";
import { requireAdmin } from "@/lib/access";
import { getSalesStats } from "@/lib/sales-stats";
import SalesTable from "./SalesTable";
import DayTypePanel from "./DayTypePanel";

export const dynamic = "force-dynamic";

const WINDOWS = [7, 30, 90];

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const days = WINDOWS.includes(Number(sp.d)) ? Number(sp.d) : 30;
  return (
    <AppShell
      top={<AppHeader section="Admin" />}
      header={
        <TopBar
          title="Satıcılar"
          subtitle={`Cavab sürəti və cavabsızlıq · son ${days} gün · müştəri yazışmaları`}
          actions={WINDOWS.map((w) => (
            <FilterChip key={w} href={`/admin/satis?d=${w}`} active={w === days}>
              {w} gün
            </FilterChip>
          ))}
        />
      }
    >
      <Suspense key={days} fallback={<div>Statistika hesablanır…</div>}>
        <SalesSections days={days} />
      </Suspense>
    </AppShell>
  );
}

async function SalesSections({ days }: { days: number }) {
  const stats = await getSalesStats(days);
  return (
    <>
      <SalesTable stats={stats} />
      <DayTypePanel stats={stats} />
    </>
  );
}
```

`FilterChip`-in həqiqi propları `src/components/ui/index.tsx`-dən yoxlanır və
lazım gələrsə çağırış ona uyğunlaşdırılır — komponent dəyişdirilmir.

- [ ] **Addım 4: `SalesTable` yaz**

Sütunlar: Satıcı · İmkan · Median FRT · Median ART · p90 ART · **Cavabsız %**
· **SLA-ya düşmə %** · Ölçülməyən.

Qaydalar:
- Faiz böyük, mütləq say onun altında kiçik (`421 / 3923`) — həcm ilə davranış
  qarışmasın.
- Hər faizin altında komanda medianından fərq: `+4.2 s.p.` / `−1.1 s.p.`
  (`s.p.` = faiz bəndi). Vaxtlarda fərq `formatDuration` ilə.
- Pisləşmə rənglə YANAŞI söz daşıyır (`title` + `aria-label`):
  «komanda medianından 4.2 bənd yuxarı».
- Sıralama nömrəsi yoxdur; sıra ad üzrədir.
- Nömrəsi olmayan satıcının sətrində rəqəm yerinə «nömrə təyin olunmayıb» +
  `/admin`-ə link.
- `slaUncovered > 0` olan sətirdə «ölçülməyən N» çipi — SLA faizinin
  məxrəci yalnız ölçülənlərdir və bu, ekranda deyilməlidir.
- Cədvəl `.tableScroll` qabında (`overflow-x: auto`), gövdə sürüşmür.

- [ ] **Addım 5: `DayTypePanel` yaz**

Hər satıcı üçün üç sütun: **İş günləri · Şənbə · Bazar**. Hər sütunda:
imkan sayı, median cavab (`formatDuration`), cavabsız %.

Panelin altında bir sətirlik izah, `docs/rules.md` §4-ə görə:

> Şənbə SLA qaydasında həftə sonu sayılır (hədəf 180 dəq), ona görə şənbənin
> SLA faizi daha yumşaq hədəflə hesablanır. Cavabsızlıq faizi isə hər üç
> sütunda eyni qayda ilə ölçülür (24 saat).

- [ ] **Addım 6: `/admin` səhifəsinə link əlavə et**

`src/app/admin/page.tsx`-dəki mövcud bölmə linkləri qəlibi ilə: «Satıcılar —
cavab sürəti və cavabsızlıq müqayisəsi» → `/admin/satis`.

- [ ] **Addım 7: Yoxlamaları işlət**

Run: `npm run smoke:sales:screen`
Gözlənilən: `NƏTİCƏ: keçdi.`

Run: `npm run lint && npx tsc --noEmit`
Gözlənilən: xəta yoxdur.

- [ ] **Addım 8: Commit**

```bash
git add src/app/admin/satis src/app/admin/page.tsx scripts/smoke-sales-screen.ts package.json
git commit -m "feat(satıcı): müqayisə cədvəli və gün növü paneli"
```

---

### Task 3: Gün × saat istilik xəritəsi

**Fayllar:**
- Yarat: `src/app/admin/satis/SalesHeatmap.tsx`
- Dəyiş: `src/app/admin/satis/page.tsx` (xəritəni və `?u=` süzgəcini əlavə et)
- Dəyiş: `src/app/admin/satis/satis.module.css`

**İnterfeyslər:**
- İşlədir: `SalesRow`, `HeatCell` (Task 1).
- Verir: `SalesHeatmap({ rows, userId, mode, days }: { rows: SalesRow[];
  userId?: number; mode: "speed" | "volume"; days: number })`.

- [ ] **Addım 1: Xəritəni yaz**

7 sətir (B.e…Bazar) × 24 sütun `<table>`. İki rejim:
- `speed` (standart): xananın dəyəri `responseMedianSeconds`;
- `volume`: xananın dəyəri `outCount`.

Qaydalar:
- **`opportunities < 5` olan xana rənglənmir**, «az data» kimi göstərilir —
  iki sətirdən çıxan median rənglə yalan danışır.
- Rəng tək daşıyıcı deyil: hər xananın `title`-ı «Çərşənbə 14:00 — median
  8 dəq, 23 imkan» yazır; xəritənin altında rəng şkalası **rəqəmlə** birlikdə
  verilir.
- Rəqəmlər `--font-numeric` + `tabular-nums`; rənglər `tokens.css`-dən.
- Cədvəl öz qabında sürüşür (`overflow-x: auto`), gövdə yox.
- Boş xana (`opportunities = 0` və `outCount = 0`) fon rəngi ilə qalır.

- [ ] **Addım 2: Satıcı süzgəcini `page.tsx`-ə bağla**

`?u=<userId>` — `FilterChip` sırası: «Hamısı» + hər satıcı. `?d=` ilə birlikdə
saxlanır (`docs/rules.md` §8: bir süzgəc dəyişəndə digəri itmir). Rejim
seçicisi də URL-də: `?m=speed|volume`.

- [ ] **Addım 3: Yoxlamaları işlət**

Run: `npm run smoke:sales:screen && npm run lint && npx tsc --noEmit`
Gözlənilən: hamısı təmiz.

- [ ] **Addım 4: Gözlə yoxla**

- `/admin/satis` işıqlı və tünd temada (`?theme=light` / `?theme=dark`).
- Brauzeri 860px-ə daralt: cədvəl və xəritə öz qablarında sürüşür, səhifə
  gövdəsi üfüqi sürüşmür.
- Klaviatura ilə: süzgəc çipləri fokus üzüyü alır, tab sırası vizual sıra ilə
  üst-üstə düşür.

- [ ] **Addım 5: Build və commit**

```bash
npx next build
git add src/app/admin/satis
git commit -m "feat(satıcı): gün × saat istilik xəritəsi"
```

- [ ] **Addım 6: Deploy**

```bash
systemctl restart katibe-dashboard.service
```

---

## Plan özünə baxış

- **Spesifikasiya əhatəsi:** §5 sorğu → Task 1; §6.1 cədvəl və §6.3 gün növü
  paneli → Task 2; §6.2 xəritə → Task 3; §6.4 boş vəziyyətlər → Task 2
  (nömrəsiz satıcı) və Task 3 (az data xanası); §6 icazə → Task 1 Addım 5 +
  Task 2 Addım 1.
- **Yer tutucu yoxdur:** hər addımda ya real kod, ya da işə salınacaq əmr var.
- **Tip uyğunluğu:** `SalesMetrics`, `HeatCell`, `SalesRow`, `SalesStats`,
  `DayType` bütün tasklarda eyni adla işlədilir; `getSalesStats(days)` yeganə
  ekran girişidir, `computeSalesStatsWithoutAccessCheck(days)` yalnız
  skriptdən çağırılır.
