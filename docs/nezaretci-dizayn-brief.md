# Nəzarətçi lenti — dizayn brifi

Bu sənəd Claude Design (və ya istənilən dizayner) üçün girişdir: səhifə nədir, kimin
üçündür, hansı məlumat mövcuddur və dizaynın hansı texniki çərçivədə işləməli
olduğu. Yanındakı `nezaretci-movcud-ui.html` faylı isə **indiki** UI-ın real
məlumatla surətidir — brauzerdə açıb görmək və üstündə işləmək üçün.

---

## 1. Səhifə nədir

Katibe — Dubay/Azərbaycan əsaslı parça-tekstil topdansatış şirkətinin WhatsApp
yazışmalarını izləyən dashboard-dur. **Nəzarətçi** onun içindəki avtonom agentdir:
hər saat (Bakı vaxtı 09:00–21:00, B.e–Şənbə) satıcıların yazışmalarını yoxlayır,
problem tapanda lentə söhbət kimi "yazır".

**Oxucu bir nəfərdir** — satış komandasına nəzarət edən sahibkar. Gündə bir neçə
dəfə baxır, hər dəfə eyni üç sualla:

1. **İndi nəyə baxım?** — hansı müştəri gözləyir, nə qədərdir.
2. **Nəyi gözdən qaçırıram?** — təklif verilib cavab yoxdur; satıcı susub.
3. **Nə oldu?** — hansı problem həll olundu, kim həll etdi.

Bütün mətn **Azərbaycan dilindədir**. Səhifəyə həm masaüstündən, həm telefondan
baxılır.

**Səhifə iki yerdə görünür:**
- `/agent` — öz səhifəsi, tam en (hazırda yalnız burada).
- `/` — ana səhifədə, user siyahısının yanında iki sütunlu şəbəkədə
  (`SUPERVISOR_FEED=main` açılanda). Bu halda lentin sütunu **minimum 320px**
  olur.

Dizayn hər iki halda işləməlidir.

---

## 2. Səhifənin üç zonası

Sıra məna daşıyır: yuxarıdakı təcilidir, aşağıdakı arxivdir.

| Mövqe | Zona | Nədir | Say |
|---|---|---|---|
| Yuxarı | **Sancaqlı bayraqlar** | 6–10 bal, açıq. Müdaxilə tələb edir. Bağlanana qədər qalır. | ~14 |
| Orta | **İzləmədə** | 1–5 bal, açıq. Bayraq deyil, iş siyahısı. | ~2 |
| Aşağı | **Bağlananlar** | Cədvəl. Kim bağlayıb: insan, yoxsa agent. | ~11 |

Say göstəricidir, sabit deyil — sancaqlı 0 da ola bilər, 30 da.

---

## 3. Post (qabarcıq) anatomiyası

Hazırda post WhatsApp qabarcığı kimi görünür. **Bu forma məcburi deyil** — dizayn
kartı, sətri, başqa formanı seçə bilər. Məcburi olan aşağıdakı məlumatın
görünməsidir.

Real nümunə (bu gün agentin yazdığı post):

```
🕵️ Nəzarətçi · Rouz 2 / Rouz-2          ← agent + satıcı + nömrə
[9/10]  🚩 Müdaxilə lazımdır             ← bal + verdikt
Təsdiqlənmiş müştəri 43 saatdan çoxdur    ← əsas mətn (model yazır)
cavab gözləyir, hədəf isə cəmi 3 saat
idi — bu real gecikmə və müştəri
narazılığı riski daşıyır.
[Söhbətə bax]  [Həll edildi]             ← iki əməliyyat
18:06 · 2-ci dəfə görülür                ← vaxt + təkrar
```

Diqqət:
- **Əsas mətn uzunluğu dəyişkəndir** — 1 cümlədən 4 sətrə qədər. Dizayn kəsməməli,
  genişlənməlidir.
- **"Həll edildi" düyməsi HƏR açıq postda var**, təkcə sancaqlıda yox.
- **"2-ci dəfə görülür"** yalnız 1-dən çox olanda görünür — problem davam edir
  deməkdir.
- Kontakt adı bəzən nömrədir (`150276610773131`) — WhatsApp adı gizlədə bilər.
  Uzun rəqəm sətri dizaynı pozmamalıdır.

---

## 4. Mövcud sahələr (data müqaviləsi)

Dizayn yalnız bunlardan istifadə edə bilər; başqa məlumat yoxdur.

| Sahə | Tip | Nə deyir |
|---|---|---|
| `agent` | mətn | Persona açarı. Hazırda tək: `nazaratchi` → "🕵️ Nəzarətçi". Gələcəkdə başqa agentciklər ola bilər. |
| `userName` | mətn | Satıcının adı — "Rouz", "Rouz 2". |
| `instanceName` | mətn | WhatsApp nömrəsinin adı. |
| `detector` | mətn | `unanswered` · `customer_deciding` · `silence` · `all_clear` |
| `severity` | 1–10 | Son bal. |
| `baseSeverity` | 1–10 | Düsturun ilkin balı (model dəyişə bilməz). Auditə açıqdır, hazırda göstərilmir. |
| `severityReason` | mətn? | Model balı azaldıbsa səbəbi. Adətən boş. |
| `verdict` | enum | `INTERVENE` → "🚩 Müdaxilə lazımdır" · `OK` → "✅ Yaxşı gedir" |
| `title` | mətn | Qısa başlıq: "Nümunə Müştəri 2 gün cavab gözləyir". Qabarcıqda göstərilmir, cədvəldə işlənir. |
| `body` | mətn | Əsas mətn, 1–3 cümlə. |
| `evidence` | json | Rəqəmlər: `contact`, `waitedSeconds`, `targetSeconds`, `msgsWaiting`, `isClient`, `chatState`. Siyahı postunda `total`, `clients`, `top[]`. |
| `remoteJid` | mətn? | Söhbətin ünvanı. `null` = post bütün nömrəyə aiddir (siyahı, susqunluq). |
| `timesSeen` | tam | Neçə gedişatda görünüb. |
| `lastSeenAt` | vaxt | Sonuncu təsdiq vaxtı. |
| `createdAt` | vaxt | İlk yaranma vaxtı. |
| `llmModel` | mətn? | `null` = mətni şablon yazıb (model çağırılmayıb/alınmayıb). |
| `acknowledgedAt` | vaxt? | Bağlanma vaxtı. `null` = açıq. |
| `closedReason` | enum? | `MANUAL` = insan bağladı · `AUTO` = problem öz-özünə həll olundu. |

---

## 5. Bal zolaqları

Sərhədlər koddadır (`severity.ts`) — dizayn **rəngləri** dəyişə bilər, **sərhədləri**
yox.

| Bal | Ad | Nə deməkdir |
|---|---|---|
| 9–10 | Kritik | Nadir. Yalnız model əsaslandırılmış qaldırma edəndə. |
| 6–8 | Ciddi | **Bayraq həddi.** Sancaqlanır, "Müdaxilə lazımdır". |
| 4–5 | Diqqət | İzləmədə. Follow-up siyahıları. |
| 1–3 | Məlumat | "Hər şey qaydasındadır" hesabatları. |

---

## 6. Üç detektor, üç fərqli post forması

| Detektor | Nə tapır | Post forması |
|---|---|---|
| `unanswered` | Müştəri gözləyir, SLA hədəfi keçib. | **Söhbət başına bir post**, 6–9 bal. Sancaqlıların hamısı budur. |
| `customer_deciding` | Təklif verilib, müştəri qərar vermir. | **Satıcı başına BİR post**, içində ən köhnə 5-i sadalanır. 4–5 bal. |
| `silence` | Satıcı iş saatında heç nə yazmayıb. | Satıcı başına bir post, 4–7 bal. Söhbətə bağlı deyil. |
| `all_clear` | Problem yoxdur. | Gündə bir dəfə, 2 bal. Bal nişanı və verdikt göstərilmir. |

Siyahı postunun real mətni:

> 62 söhbətdə (42-si mövcud müştəri) müştərilər hələ qərar vermək mərhələsindədir,
> ən köhnəsi 13 gün 22 saatdır gözləyir. Bu böyük siyahı satış boru xəttinin
> donduğunu göstərir və vaxtında təkrar əlaqə tələb edir.

Bu postun `evidence.top[]` sahəsində ilk 5 söhbətin adı, gözləmə müddəti və
müştəri olub-olmadığı var — dizayn onları siyahı, çip, mini-cədvəl kimi göstərə
bilər. **Hazırda mətnin içindədir, ayrıca göstərilmir — yaxşılaşdırmağa açıq
yerdir.**

---

## 7. Bağlananlar cədvəli

Beş sütun, ən son bağlanan üstdə:

| Söhbət | Kim | Bal | Necə bağlandı | Vaxt |
|---|---|---|---|---|
| Nümunə Müştəri | Rouz 2 | 9 | ✅ Öz-özünə həll olundu | 13:54 |
| Nümunə Mağaza | Rouz 2 | 6 | 👤 Əl ilə bağlandı | 12:57 |

**Vacib:** bağlanmaq son söz deyil. Problem davam edərsə agent onu *təzə* post kimi
yenidən açır. Ona görə bu "arxiv" deyil, "nə oldu" jurnalıdır.

### Bağlanma DƏRHAL olur, saatlıq gedişatı gözləmədən

Əvvəl bayrağı bağlayan yeganə şey saatda bir işləyən gedişat idi. Nəticə
ölçüldü (30 gün, 368 öz-özünə bağlanmış cavabsızlıq bayrağı): satıcının cavabı
ilə bayrağın bağlanması arasında **median 32 dəqiqə**, 199-unda (54%) yarım
saatdan çox. Yəni menecerin lentdə gördüyü hər ikinci qırmızı sətir artıq həll
olunmuş problem idi.

İndi mesaj vebhuku bunu dərhal edir (`src/lib/supervisor/reactive.ts`):

- satıcı həmin söhbətə cavab yazan kimi — istər API-dən, istər öz telefonundan —
  **yalnız o söhbətin** bayraqları yenidən yoxlanılır;
- qərar qaydası dəyişmir, saatlıq gedişatdakı ilə eynidir: bayrağı doğuran
  mesajdan sonra bizdən mesaj getdiyi görünməlidir;
- bir yerdə daha ehtiyatlıdır — cavabımızdan sonra müştəri yenidən yazıbsa,
  bayraq **açıq qalır** (o, artıq təzədən gözləyir);
- bu yolda **model çağırılmır**, deməli əlavə xərc yoxdur;
- bayraq **açılmır**, yalnız bağlanır: açmaq üçün SLA təqvimi, nəzarət saatları
  və doğrulama lazımdır, onlar gedişatın işidir.

Vebhuk çatmasa heç nə itmir — saatlıq gedişat onsuz da eyni bayrağı bağlayır,
yəni ən pis hal köhnə davranışdır.

---

## 8. Səhifənin halları

- **Boş** — açıq post yoxdur: *"Açıq bayraq yoxdur — hər şey qaydasındadır.
  Yoxlama 09:00–21:00 arası (B.e–Şənbə) saatda bir gəlir."*
- **Qopuq nömrə** — lentin ƏN BAŞINDA xəbərdarlıq zolağı: *"N nömrə WhatsApp-dan
  qopub"*, altında hər nömrə üçün bir sətir (kim, neçə bayraq gizlədilib, nə
  vaxtdan bəri). Həmin nömrənin bayraqları lentdə **görünmür** — bax §13.
- **Yüklənir** — `<Suspense>` içində; hazırda fırlanan dairə + "Lent yüklənir…".
- **Canlı** — başlıqda yaşıl nöqtə + "Canlı · 18:06". Yeni post yazılanda səhifə
  özü yenilənir (SSE).
- **Şablon mətn** — model alınmayanda post quru şablonla yazılır; vaxt sətrində
  "· şablon" görünür.
- **Son yoxlama** — başlıqda "son yoxlama 18:06".

---

## 8a. İki fərqli təqvim

**SLA təqvimi** (satıcının öhdəliyi, `katibe.sla_rule_versions`): B.e–Cümə
10:00–19:00. Cavab hədəfi bundan çıxır — iş saatında 1 saat, kənarda 2 saat,
həftəsonu 3 saat. **Nəzarətçi ona toxunmur.**

**Nəzarət pəncərəsi** (agent nə vaxt baxır, `scope.ts`): Bakı 09:00–21:00,
B.e–Şənbə. Bundan kənarda gedişat yalnız açıq bayraqları təzələyir və həll
olunanları bağlayır — yeni post açılmır, model çağırılmır. `.env.local`-dan
dəyişir: `SUP_COVERAGE_START`, `SUP_COVERAGE_END`, `SUP_COVERAGE_DAYS`.

Baxış saatını uzatmaq heç kimin hədəfini sərtləşdirmir: axşam 19:30-da gələn
mesajın hədəfi onsuz da "iş saatından kənar" tarifidir, sadəcə həmin pozuntu
indi səhərə qədər gözləmir.

---

## 9. İndiki rəng tokenləri

`src/app/globals.css`. Dizayn bunları saxlaya, genişləndirə və ya əvəz edə bilər —
amma **bütün digər səhifələr bunlarla işləyir**, ona görə tam dəyişiklik bütün
dashboard-a toxunur.

```css
--bg:        #0b0d0f   /* səhifə fonu */
--surface:   #14171a   /* kart/bölmə fonu */
--surface-2: #1b1f23   /* qabarcıq fonu */
--border:    #262b30
--fg:        #eef1f3   /* əsas mətn */
--muted:     #8b949c   /* ikinci dərəcəli mətn */
--accent:    #35d07f   /* yaşıl — müsbət, canlı */
--accent-2:  #5b8def   /* mavi — göndərən adı, orta səviyyə */
--danger:    #f2555a   /* qırmızı — bayraq */
```

---

## 10. Texniki çərçivə (dəyişmir)

- **CSS Modules**, bir paylaşılan fayl: `src/app/dashboard.module.css`.
  Tailwind **yoxdur**, CSS-in-JS **yoxdur**.
- **Server komponent** — lent serverdə render olunur. `useState`/`useEffect`
  yoxdur. İnteraktivlik (açılıb-bağlanan bölmə, filtr) lazımdırsa ayrıca client
  komponent yazılır — mümkündür, sadəcə qeyd edin.
- **Düymələr form-dur** — "Həll edildi" server action çağıran `<form>`-dur.
  JavaScript sönsə də işləyir.
- **Kənar kitabxana yoxdur** — ikon dəsti yoxdur, hazırda emoji işlənir. İkon
  istəsəniz **inline SVG** olmalıdır.
- **Yalnız qaranlıq tema** — `globals.css`-də `color-scheme: dark`. İşıqlı tema
  istəsəniz bu ayrıca işdir.
- **Mobil** — cədvəllər öz konteynerində üfüqi sürüşməlidir; səhifə gövdəsi
  sürüşməməlidir.
- **Şrift** — hazırda sistem şrifti (`ui-sans-serif, system-ui…`). Google Fonts
  əlavə etmək mümkündür.

---

## 11. Dizaynda həll edilməli məsələlər

Bunlar indiki UI-ın zəif yerləridir — dizayn bunlara cavab versə çox faydalı olar:

1. **Sancaqlı bayraqlar 14 ədəddir və hamısı eyni görünür.** Hansına birinci
   baxmaq lazım olduğu bal rəqəmindən başqa heç nə ilə seçilmir.
2. **Siyahı postunun içindəki 5 söhbət mətnin içində itir** — ayrıca sıralanmalı,
   hər biri linklə.
3. **İki satıcı bir lentdə qarışır** — Rouz və Rouz 2-nin postları bir-birinin
   ardınca gəlir. Satıcıya görə qruplaşdırma və ya filtr faydalı olardı.
4. **Bağlananlar cədvəli lentin altında uzanır** — yığcam, açılıb-bağlanan
   olması daha yaxşıdır.
5. **Kontakt adı bəzən uzun rəqəmdir** — dizayn buna dözməlidir.
6. **Boş hal** hazırda quru bir sətirdir — "hər şey qaydasındadır" halı da
   məlumatlı görünə bilər (bu gün neçə söhbət, median cavab sürəti).

---

## 12. Nə geri lazımdır

Dizaynı **HTML + CSS** kimi verin (bir fayl kifayətdir, real mətnlə). Mən onu
`src/components/SupervisorFeed.tsx` + `src/app/dashboard.module.css` faylına
köçürüb tətbiq edərəm.

- Sinif adlarını dəyişmək **sərbəstdir**.
- Struktur, sahə adları və üç zona **saxlanılmalıdır**.
- Emoji əvəzinə SVG ikon istəyirsinizsə, SVG-ni birbaşa HTML-ə qoyun.

---

## 13. Qopuq nömrə: bayraqlar dondurulur

Sessiya qopanda `evolution_api."Message"` cədvəli donur — müştərinin yazdığı
gəlmir, satıcının telefondan verdiyi cavab düşmür. Bu halda köhnə bayraqlar
ölçü olmaqdan çıxıb **yalan danışmağa** başlayır: "cavabsız" saatı öz-özünə
böyüyür, halbuki cavab çoxdan verilib. (2026-08-25: Rouz və Rouz-2 dörd saat
belə qaldı.)

Qayda:

1. **Gedişat qopuq instansı tamamilə atlayır** — nə yeni post, nə təzələmə, nə
   avtomatik bağlama (`run.ts`).
2. **Lent onun bayraqlarını gizlədir** (`feed.ts`). Silinmir, bağlanmır —
   gizlənir. Görünən yeganə post `instance_health`-dir: qopmanı elan edən odur.
3. **Nömrə qayıdanda** bayraqlar qopma anından (bir saat marja ilə) yenidən
   yoxlanılır: həll olunanlar bağlanır, hələ keçərli olanlar lentə qayıdır.
   Qayıdışdan sonra 10 dəqiqə gözlənilir ki, WhatsApp-ın oflayn növbəsi bazaya
   düşsün — yoxsa hələ çatmamış cavabı "yoxdur" sayıb təzə yalan bayraq
   açardıq.

Tarixçə `katibe.instance_connectivity` cədvəlindədir (`connectivity.ts`); onu
həm saatlıq gedişat (:05), həm sağlamlıq yoxlaması (:25) yeniləyir. Qayıdışı
gözləməmək üçün ayrıca cron hər 15 dəqiqədən bir yalnız nişanlı instansları
yoxlayır (`SUP_REVALIDATE_ONLY=1`).
