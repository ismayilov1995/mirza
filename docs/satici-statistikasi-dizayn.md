# Satıcı statistikası ekranı — dizayn

Tarix: 2026-09-05 · Status: təsdiqlənib, icra planı gözləyir

## 1. Nə üçün

Sahibin sualı iki hissəlidir: **«hansı gün, hansı sıxlıqla müştəriyə cavab
verilir»** və **«həftə sonu cavabsızlıq artırmı»**. Bu gün paneldə hər ikisinin
cavabı var, amma yalnız **bir instans üçün** və **bir rəqəm** kimi
(`getWorkloadStats()`, instans səhifəsində). Satıcıları yan-yana qoymaq, ya da
həftənin gününə görə kəsmək mümkün deyil.

Ekran yazılmazdan əvvəl sual real data üzərində ölçüldü, çünki cavabın özü
dizaynı dəyişdi. 90 günün nəticəsi (müştəri dairəsi, cavab imkanı başına):

| Satıcı | Gün | İmkan | Median cavab | Cavabsız |
|---|---|---:|---:|---:|
| Rouz | İş günü | 2733 | 8.6 dəq | 4.2% |
| Rouz | Şənbə | 374 | 44.4 dəq | 5.1% |
| Rouz | Bazar | 333 | 90.4 dəq | 4.8% |
| Rouz 2 | İş günü | 2506 | 10.4 dəq | 4.1% |
| Rouz 2 | Şənbə | 306 | 57.0 dəq | 3.6% |
| Rouz 2 | Bazar | 304 | 100.8 dəq | 4.3% |
| Zemfira | İş günü | 4874 | 8.3 dəq | 7.5% |
| Zemfira | Şənbə | 649 | 55.0 dəq | **18.8%** |
| Zemfira | Bazar | 555 | 50.0 dəq | 6.1% |

İki nəticə dizaynı formalaşdırdı:

1. **Sürət həftə sonu hamıda pozulur** — iş günü 8–10 dəqiqə, şənbə ~5 dəfə,
   bazar ~10 dəfə uzanır. Bu, adamın deyil, iş qrafikinin xüsusiyyətidir və
   fərdi göstərici kimi oxunmamalıdır.
2. **Cavabsızlıq isə adama görədir** — Rouz və Rouz 2-də gün növünün demək olar
   heç bir təsiri yoxdur (4–5%), Zemfirada şənbə 18.8%-ə qalxır. Yəni «həftə
   sonu pisdir» ümumi cümləsi yanlışdır; doğru cümlə «Zemfiranın şənbəsi
   pisdir»dir.

Ekranın vəzifəsi məhz bu fərqi görünən etməkdir: **hansı rəqəm qrafikdən gəlir,
hansı adamdan.**

## 2. Qərarlar (sahib təsdiqləyib)

| Sual | Qərar | Səbəb |
|---|---|---|
| Bayraq mənbəyi | Mesajlardan **yenidən hesablanır**, `agent_posts`-dan yox | `agent_posts` cəmi 2026-08-25-dən var (11 gün) və dedupe səbəbindən açıq bayraq hər gün yeni sətir yaratmır: bazar günü 37 gedişat və 277 tapıntı olub, amma **bazar tarixli bir dənə də post yoxdur**. Gün üzrə saymaq üçün yararsızdır. |
| Şənbənin statusu | SLA qaydasına **toxunulmur**; ekran özü üç sütuna bölür: **iş günləri / şənbə / bazar** | `Online` qaydası şənbəni həftə sonu sayır (180 dəq hədəf), data isə şənbəni iş günü göstərir. Qaydaya yeni versiya əlavə etmək keçmiş ölçmələri toxunmadan qoyurdu, amma ekranı yenə iki cür oxuya bilən edirdi. Üç sütun heç nə gizlətmir. |
| Söhbət dairəsi | Nəzarətçi ilə **eyni dairə** — `clientScopeSql()` | Ekrandakı rəqəmlə lentdəki bayraq eyni çoxluğu ölçür. Fərqli olsaydı, «panel 12 deyir, lentdə 4 var» sualı izahsız qalardı. |

Ayrıca soruşulmayan, mövcud modelin özü cavablandırdığı qərarlar:

- **Kim cədvəldədir:** `getSalesInstances()` — kateqoriyası `Sales` olan
  userlər (Zemfira, Rouz, Rouz 2, Murad). İsmayıl `Production`
  kateqoriyasındadır, ona görə siyahıda yoxdur. Nəzarətçi də eyni funksiyanı
  işlədir, yəni «kim satıcıdır» sualının bir cavabı olur.
- **Muradın nömrəsi yoxdur** → cədvəldə sətri qalır, rəqəmlərin yerində
  «nömrə təyin olunmayıb» yazılır. Sətri gizlətmək «Murad statistikada
  yaxşıdır» kimi oxunardı.

## 3. Ölçmə tərifləri

Təriflər **`getWorkloadStats()` ilə eynidir** və qəsdən yenidən icad edilmir —
instans səhifəsindəki rəqəmlə bu ekrandakı rəqəm fərqlənsə, heç kim hansına
inanacağını bilməyəcək.

- **Epizod:** 14 gündən uzun sükutdan sonrası yeni epizoddur
  (`EPISODE_GAP_SECONDS`).
- **Cavab imkanı:** ardıcıl müştəri mesajları seriyasının **sonuncusu** (növbəti
  mesaj bizimdir), ya da ümumiyyətlə cavablanmamış sonuncu mesaj. Seriyanın
  ortasındakılar sayılmır — 5 mesajlıq bir seriya 5 pozuntu kimi görünərdi.
- **FRT:** epizodun ilk cavabına qədərki vaxt. Median.
- **ART:** müştəri mesajından sonrakı hər cavabın gecikməsi. Median və p90.
- **Cavabsız:** cavab imkanına 24 saat ərzində cavab gəlməyib
  (`UNANSWERED_AFTER_SECONDS`). Hələ cavabsızdırsa, gözləmə **indiyə** qədər
  sayılır.
- **SLA pozuntusu:** gözləmə > `katibe.sla_target_seconds(instance_id, arrived_at)`.
  Funksiya NULL qaytaranda (qayda yoxdur) sətir «ölçülməyən» sayılır və faizin
  məxrəcinə girmir.
- **Gün növü** müştəri mesajının **GƏLDİYİ** anın `Asia/Baku` ISO gününə görə
  seçilir — SLA hədəfinin seçildiyi anla eyni. Cavabın yazıldığı ana görə
  bölmək «şənbə gələn, bazar cavablanan» mesajı bazara yazardı.

## 4. Data mənbəyi və mənsubiyyət

Mənbə **kanonik anbardır** (`katibe.message` + `katibe.message_source`), köhnə
`evolution_api."Message"` yox. Səbəb: istiqamət kanonik sətirdə deyil, mənbə
başına dəqiqdir (`message_source.direction`) — qrup mesajı bir instansda `out`,
digərində `in`-dir.

İki mənsubiyyət qaydası:

- **Yalnız `kind='evolution'` mənbələr sayılır.** `archive:business` arxivi
  Evolution ilə 93 589 mesajda üst-üstə düşür; sayılsaydı, İsmayılın (onsuz da
  cədvəldə olmayan) datası ikiqat olar, üstəlik satıcılarda aylıq, arxivdə
  illik dərinlik yan-yana düşərdi.
- **Fərdi söhbətlər** (`chat.kind IN ('individual','lid')`). Qrup söhbətində
  «cavab kimdən gözlənilir» sualının cavabı yoxdur.

## 5. Sorğu

Bir SQL, bir keçid. `msgs → seq → opp` CTE zənciri bir dəfə qurulur, aqreqasiya
isə `GROUPING SETS` ilə üç dənədir:

- `(user_id)` — cədvəlin əsas sətri
- `(user_id, gün_növü)` — iş günü / şənbə / bazar paneli
- `(user_id, isodow, saat)` — istilik xəritəsi

Median bucketlərdən toplanmır, ona görə hər qrup öz `percentile_cont`-unu
alır — `GROUPING SETS`-in seçilmə səbəbi budur.

FRT (epizod grainində) və ART (cavab grainində) `opp`-dan fərqli sətir
çoxluqlarıdır; onlar da eyni `seq`-dən çıxır və nəticələr açara görə
birləşdirilir. Tələb: **`katibe.message` üzərində bir dəfə gəzilsin.**

**Ölçülüb:** dörd hissəsi ilə birlikdə tam sorğu 30 gün üçün **2.3 s**
(3 satıcı, müştəri dairəsi, canlı bazada); yalnız imkan hissəsi 1.85 s,
90 günlük pəncərə 3.6 s. Standart pəncərə 30 gün, seçim 7 / 30 / 90.

**Yeni cədvəl və ya gecəlik rollup YOXDUR.** 2.3 saniyə admin ekranı üçün
`Suspense` skeleti ilə dözüləndir. `docs/rules.md` §8-in qaydası burada da
işləyir: əvvəlcə ölç, sonra denormalizasiya haqqında düşün. Lazım olsa,
sonra ölçüb əlavə edilə bilər — və o zaman onu **yazan** yeniləməlidir.

## 6. Ekran

**Yer:** `/admin/satis`, ad «Satıcılar». `requireAdmin()` ilə qorunur.
Naviqasiyada `/admin` altında görünür — `WorkSidebar`-ın «İş» bölməsinə
qoyulmur, çünki satıcının özü həmkarının rəqəmini görməməlidir. (Nəzarətçi
lentinin `SUPERVISOR_FEED` kölgə rejimi ilə eyni ehtiyat.)

**Çərçivə:** `AppShell` + `AppHeader` + `TopBar`, `docs/rules.md` §7-yə uyğun.
Süzgəclər URL-dədir: `?d=30` (pəncərə), `?u=<userId>` (istilik xəritəsi üçün
satıcı seçimi) — §8.

Üç qat, yuxarıdan aşağı:

### 6.1 Müqayisə cədvəli

Sətir = satıcı. Sütunlar: cavab imkanı · median FRT · median ART · p90 ART ·
**cavabsız %** · **SLA-ya düşmə %** · ölçülməyən (SLA qaydası olmayan) sayı.

- **Faiz əsasdır, mütləq say ikinci dərəcəlidir.** Zemfiranın həcmi Rouz 2-dən
  ~2 dəfə çoxdur; «cavabsız 364» ilə «cavabsız 102» yan-yana həcmi ölçər,
  davranışı yox. Mütləq say faizin altında kiçik yazılır ki, «3 imkandan 1-i»
  kimi kövrək faizlər görünsün.
- Hər rəqəmin altında **komanda medianından fərq** (`+2.1 s.p.` / `−1.4 dəq`).
  Sıralama nömrəsi YOXDUR — sıralama insanı rəqəmə qulluq etməyə vadar edir.
- Rəng tək daşıyıcı deyil (§3): pisləşmə həm işarə, həm söz daşıyır.
- Rəqəmlər `--font-numeric` + `tabular-nums`.

### 6.2 Gün × saat istilik xəritəsi

7 sətir (B.e…Bazar) × 24 sütun. İki rejim:

- **həcm** — həmin saatda yazılan cavabların sayı;
- **sürət** — həmin saatda **gələn** müştəri mesajlarının median cavab vaxtı.

Sürət rejimi daha dəyərlidir: «axşam saat neçədən sonra qapı bağlanır» sualına
cavab verir. Standart olaraq sürət seçilidir.

Az sətirli xanalar (< 5 imkan) rəngləndirilmir, «az data» kimi göstərilir —
median 2 sətirdən çıxanda rəng yalan danışır.

Telefonda xəritə **öz qabında** sürüşür, səhifənin gövdəsi yox (§14).

### 6.3 İş günü / Şənbə / Bazar paneli

6.1-dəki metriklərin üç sütuna bölünmüş variantı, satıcı başına. Ekranın əsas
mesajı buradan oxunur: sürət sütunları hamıda birlikdə pisləşir, cavabsızlıq
sütunu isə yalnız bəzi adamlarda.

Panelin başlığı altında bir cümlə izah: şənbə SLA qaydasında həftə sonu sayılır
(180 dəq hədəf), ona görə şənbənin SLA faizi daha yumşaq hədəfə görə
hesablanır. Rəqəm izahsız qalmır (§4).

### 6.4 Boş vəziyyətlər

İki cür (§9): pəncərədə heç bir imkan yoxdursa «bu 7 gündə ölçüləcək yazışma
olmayıb» + pəncərəni genişləndirən link; satıcının nömrəsi yoxdursa «nömrə
təyin olunmayıb» + `/admin`-ə link.

## 7. Bu ekranın etmədikləri (YAGNI)

- **Satış/sifariş rəqəmi yoxdur.** Panelin belə datası yoxdur; uydurulmur.
- **Reytinq, bal, sıralama yoxdur.** Ekran ölçü göstərir, qiymət vermir.
- **Nəzarətçinin bayraqları bu ekranda sayılmır** — onların öz lenti var.
- **Yeni SQL cədvəli yoxdur**, migration yoxdur.
- **Real-time yeniləmə yoxdur** — 30 günlük median bir dəqiqədə dəyişmir.

## 8. Risklər

- **Rouz və Rouz 2 arasında paylaşılan söhbətlər.** Eyni müştəri iki nömrə ilə
  yazışırsa, hər iki satıcının imkanlarında görünür. Bu, mövcud
  `getWorkloadStats()` davranışıdır və dəyişdirilmir; ekranda bir sətirlə
  deyilir.
- **`clientScopeSql()` etiketsizləri içəri buraxır** (identify-clients gündə bir
  işləyir). Yeni nömrə bir gün ərzində statistikaya təchizatçı kimi düşə bilər.
  Nəzarətçi ilə eyni davranışdır, qəsdən.
- **90 günlük pəncərə ~4 s** — istifadəçi seçə bilər, standart deyil.
