# Fakt qatı — icra planı

**Spesifikasiya:** `docs/satici-fakt-qati-dizayn.md`

**Qlobal məhdudiyyətlər:** `docs/rules.md` məcburidir · rəqəm həmişə SQL-dən,
model yalnız cümlə yazır · ekran admin-onlydır · yeni AI çağırışı olan hər
skriptin quru işləmə (`DRY_RUN`) rejimi olmalı və o rejim **API çağırmamalıdır**
(identify-clients-də bir dəfə bu səhv edilib) · dil açarları üç dildə
(az/ru/en) · bütün yeni cədvəllər `ALTER TABLE ... OWNER TO evolution`.

---

### Task 1 — Diapazon sorğusu və həftəlik şəkil

- Fayllar: `src/lib/sales-stats.ts` (dəyiş), `sql/2026-09-05_sales_snapshot.sql`,
  `scripts/sales-snapshot.ts`, `scripts/smoke-sales-stats.ts` (genişlət).
- `computeSalesStatsWithoutAccessCheck({ fromTs, toTs })`; `days` örtük olur.
- `katibe.sales_snapshot` (spec §7), `UNIQUE (user_id, period_start)`.
- `npm run snapshot:sales` — keçən ISO həftəni yazır; `SNAPSHOT_WEEKS=12`
  ilə geriyə doldurur.
- Yoxlama: eyni həftəni iki dəfə yazmaq sətir sayını dəyişmir; doldurulmuş
  həftənin `opportunities`-i həmin diapazonun canlı hesablaması ilə eynidir.

### Task 2 — Anlaşıqlı sütunlar və izah bölməsi

- Fayllar: `src/app/admin/satis/SalesTable.tsx`, `DayTypePanel.tsx`,
  `satis.module.css`.
- Spec §4-dəki adlar; jarqon alt sətirdə qalır.
- `<details>` «Bu rəqəmlər nə deməkdir?» — hər metrik bir izah + bir nümunə.
- Yoxlama: `smoke:sales:screen`-ə «Cavab borcu» və «Bu rəqəmlər nə deməkdir»
  yoxlaması əlavə olunur.

### Task 3 — Dil seçimi

- Fayllar: `src/app/admin/satis/dictionary.ts`, `page.tsx`, komponentlər.
- `?lang=az|ru|en`, `FilterChip` sırası; digər süzgəclər itmir.
- Açar tapılmasa AZ-yə düşür.
- Yoxlama: üç dildə səhifə 200 verir və hər dildə özünə məxsus söz görünür.

### Task 4 — Mövzu qatı

- Fayllar: `sql/2026-09-05_message_topic.sql` (köhnəni `_legacy` adına keçir,
  yenisini kanonik anbara bağla), `src/lib/topics.ts`, `scripts/classify-topics.ts`.
- Haiku, 40-lıq paket, yalnız gələn müştəri mesajları, boş/qısa mesaj modelə
  getmir.
- `TOPIC_DRY_RUN=1` qiyməti çağırışsız hesablayır.
- Cron: `30 6 * * *`, `TOPIC_MAX=1500`.
- Yoxlama: quru işləmə sıfır çağırışla qiymət verir; 200 mesajlıq real
  işləmədən sonra bütün sətirlərin `topic`-i icazəli dəstdədir.

### Task 5 — Faktlar

- Fayllar: `sql/2026-09-05_sales_insight.sql`, `src/lib/sales-insight.ts`,
  `scripts/sales-insight.ts`, `src/app/admin/satis/InsightPanel.tsx`,
  `src/app/admin/satis/actions.ts` (əl ilə yeniləmə).
- Rəqəmlər deterministik toplanır (spec §9 cədvəli), Sonnet yalnız cümlə yazır.
- `direction` kodda hesablanır; bir dövrdə ən çoxu 8 fakt.
- Tərcümə `sales_insight_translation`-a keşlənir, uğursuzluqda orijinal qayıdır.
- Cron: `50 6 * * 1`.
- Yoxlama: quru işləmə çağırışsız; faktın `evidence`-indəki hər rəqəm mətndə
  görünən rəqəmlə üst-üstə düşür.
