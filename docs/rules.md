# Katibe — dizayn dili

Bu sənəd yeni ekran və komponent yazanlar üçündür. Məqsəd "gözəl görünmək"
deyil: panel gündə saatlarla açıq qalır və eyni sualın cavabı hər ekranda eyni
yerdə, eyni formada olmalıdır. Aşağıdakı qaydalar bunu təmin edir.

Mənbə: Claude Design layihəsi `katibe-design-system-b2d016`
(`.design-import/ui-redesign-for-yaz-malar-and-bayraqlar/`). Tokenlər
`src/app/tokens.css`-dədir, primitivlər `src/components/ui/`-dadır.

---

## 1. Əvvəlcə komponentə bax, sonra CSS yaz

Yeni ekran yazarkən sıfırdan div düzmə. Aşağıdakılar hazırdır və hamısı
`@/components/ui`-dən gəlir:

| Nə lazımdır | Komponent |
|---|---|
| Ekranın çərçivəsi (başlıq + sidebar + sürüşən məzmun) | `AppShell` |
| Qlobal başlıq (brend, axtarış, «N yeni», hesab, tema) | `AppHeader` |
| Sol naviqasiya | `Sidebar` |
| İş ekranlarının hazır naviqasiyası | `WorkSidebar` |
| Ekran başlığı | `TopBar` |
| Bölmə qabı | `Panel` |
| Bir rəqəm + izah | `StatCard`, `StatGrid` |
| Düymə və ya düymə görünüşlü link | `Button` |
| Mətn sahəsi | `Input` |
| Süzgəc çipi | `FilterChip` |
| Vəziyyət nişanı | `Badge` |
| Bal reyi olan lent sırası | `FlagRow`, `SeverityScore` |
| Sıra içindəki sübut qutusu | `EvidenceBox` |
| Bağlanmış işin təsdiqi | `ResolvedStrip` |
| Boş vəziyyət | `EmptyState` |
| Canlı yenilənmə göstəricisi | `LiveDot` |
| Sidebar-dakı nömrə siyahısı | `chat/InstanceNav` |
| «Yalnız oxu» nişanı | `ReadOnlyLock` |
| Söhbət baloncuğu | `chat/Bubble` |

Lazım olan yoxdursa: əvvəlcə mövcud birinin variantı olub-olmadığını yoxla
(`tone`, `variant`, `size`, `shape` atributları), yalnız sonra yenisini yaz —
və yenisini də `src/components/ui/`-ə qoy, ekranın içində saxlama.

**Panellər arasındakı boşluq da komponentin işi deyil.** `AppShell`-in məzmun
qabı sütun flex-dir və panelləri özü aralayır — ekran nə `margin-bottom`
yazır, nə də ara qabı düzəldir. 2026-09-06-ya qədər belə deyildi: `.runBar`
özünə margin verirdi, ana səhifə inline flex qabı qurmuşdu, dörd panelli
üçüncü ekran isə heç nə almadı və panellər bir-birinə yapışdı. Qayda bir
yerdədir deyə növbəti ekran onu yenidən kəşf etməyəcək.

## 2. Rəqəm və rəng token-dən gəlir, əldən yazılmır

Komponent faylında xam `#rrggbb`, xam `12px` və ya xam `16px` boşluq OLMAMALIDIR.
Hamısı `tokens.css`-dədir:

- **Səth dərinliyi dörd pillədir:** `--canvas` (səhifə) → `--panel` (qab) →
  `--panel-raised` (qalxmış: seçili sıra, sahə fonu) → `--panel-sunken`
  (çökmüş: sübut qutusu, seçici qrupu).
- **Mətn dörd pillədir:** `--text-strong` (başlıq) → `--text-body` (gövdə) →
  `--text-muted` (ikinci dərəcəli) → `--text-faint` (etiket, vaxt).
- **Boşluq 2px addımlıdır** (`--space-1`…`--space-13`) — 8px-lik "havalı"
  sistem deyil, çünki panel yüzlərlə sıra göstərir.
- **Rəqəmlər həmişə `--font-numeric` + `tabular-nums`**. Vaxt, bal, sayğac,
  cədvəl sütunu — hamısı. Səbəb: dəyər dəyişəndə sətir sürüşməməlidir.

Köhnə adlar (`--surface-2`, `--fg-dim`, …) hələ `tokens.css`-in altındakı alias
blokunda yaşayır və `dashboard.module.css` ilə `monitor.module.css` onları
işlədir. **Yeni kodda köhnə adları işlətmə**, amma alias blokunu da silmə.

## 3. Rəng heç vaxt tək daşıyıcı deyil

Bal zolağı sistemi (`kritik` / `ciddi` / `diqqet` / `info`) rəngdən əlavə
HƏMİŞƏ rəqəm və söz daşıyır: `SeverityScore` "9" rəqəmini və altında
"müdaxilə" sözünü yazır, zolaq çipi rəng nümunəsinin yanında "9–10 kritik"
yazır. Rəngi ayırd etməyən adam üçün sistem yenə də işləməlidir.

Eyni qayda status nişanlarına da aiddir: qırmızı haşiyə tək başına "səhv"
demir — yanında söz və ya ikon olmalıdır.

Zolaq bölgüsü bir yerdədir: `src/lib/supervisor/types.ts:severityBand()`.
Rəng isə `--band` dəyişəni ilə paylanır (`BAND_VAR`, `ui/index.tsx`) — sıranın
reyi, rəqəmi, verdikti və gözləmə çipi eyni tonu oxuyur, ton bir yerdə seçilir.
Zolağı yeni yerdə göstərəndə rəngi əl ilə seçmə, `FlagRow`/`SeverityScore`
işlət.

## 4. Rəqəm izahsız qalmır

`StatCard`-ın `hint`-i boş buraxılmır. "16:20" özü sual doğurur, "hədəf 2 saat"
cavab verir. Gözləmə çipi də hədəfi yanında daşıyır (`43 saat / hədəf 2 saat`)
— pozuntunun miqyası ancaq belə oxunur.

Kart sırası dörddən uzun olmasın: beşinci kart hamısını az oxunan edir.

## 5. Dərinlik səth və haşiyə ilə verilir, kölgə ilə yox

`--shadow-modal` və `--shadow-popover` YALNIZ üzən səthlər üçündür (modal,
popover). Panel, kart və sıra kölgəsizdir. Seçili sıra kölgə yox, sol rey alır
(`--shadow-active-row`, `--shadow-nav-active`).

Fon işığı da qənaətlə: lentdə yalnız **kritik** sıralar fon qradiyenti alır.
Hamısı alsaydı, fərq itərdi.

## 5b. Haşiyə: `<button>` üçün əvvəlcə `border: 0`

Klikləyən sıra çox vaxt `<button>`-dur, brauzer isə düyməyə öz haşiyəsini
verir (`2px outset`). Blokda yalnız `border-bottom` yazmaq qalan üç tərəfi
brauzerin ixtiyarında qoyur — siyahı düz sətirlər yerinə qutu-qutu görünür.
Bu, `.row`-da real olaraq baş verib.

Qayda: klikləyən elementə əvvəlcə `border: 0`, sonra lazım olan tərəf.

**Seçili sıranın reyi haşiyə deyil, kölgədir** (`--shadow-active-row`,
`--shadow-nav-active`). Haşiyə yer tutur: seçim dəyişəndə mətn 2-3px sürüşür.
`inset` kölgə yer tutmur.

Sıra ayırıcısı `--line-soft`, qab haşiyəsi `--line` — ikisi ayrı tokendir və
yerləri dəyişdirilmir.

## 6. Animasiya vəziyyət dəyişikliyini izah etməlidir

Panel iş alətidir. Giriş animasiyası, slayd, sıçrayış YOXDUR. İcazə verilən:

- rəng/haşiyə keçidi — `--duration-fast` + `--ease-standard`
- spinner — `katibe-spin`
- canlı nöqtənin nəbzi — `katibe-pulse`, və yalnız bağlantı diridirsə

`prefers-reduced-motion` altında hamısı onsuz da dayanır (`tokens.css`).
Yeni animasiya əlavə edəndə bu qaydanı yox, səbəbi yaz: animasiya nəyi izah
edir?

## 7. Naviqasiya bir dənədir

Ekranın öz başlıq zolağı, öz "geri" düyməsi, öz çıxış düyməsi olmasın.
Çərçivə `AppHeader` + `AppShell` + `Sidebar` + `TopBar`-dır; ekran yalnız
məzmunu verir.

**Kimlik yuxarıdadır, naviqasiya solda, ekranın adı ortada.** `AppHeader`
bütün ekranların ən üstündədir — sidebar-ı olmayan köhnə ekranların da
(`align="page"`). Orada BİR dəfə deyilir: hansı məhsul, hansı bölmə, kimin
hesabı, hansı tema, «yalnız oxu»dur və neçə cavabsız yazışma var. Əvvəl bunlar
üç yerə səpələnmişdi (brend sidebar-ın başında, tema altında, kilid səhifə
başlığında, çıxış isə naviqasiya linkləri ilə eyni sinifdə) və köhnə ekranlarda
heç biri yox idi.

`TopBar`-a yalnız «hansı ekrandayam» qalır: bir sətir, başlıq və alt başlıq eyni
xətdə. Ekran adı kəsilmir, alt başlıq kəsilir.

`Sidebar` rolun nə görməli olduğunu `sections` propundan alır — "bu
nəzarətçidirmi?" sualı komponentin içində olmamalıdır. İş ekranları (`/`,
`/arxiv`, `/agent`) bölmələri özləri sıralamır, `WorkSidebar` işlədir: rola
görə qərar bir yerdə verilir, yoxsa üç səhifədən birində unudulur.

Nişan rəqəmi (`badge`) ekran oxuyucusuna çılpaq say kimi getmir: link
`aria-label`-ində "Bayraqlar, 4 açıq" olur.

## 8. Süzgəc URL-də yaşayır

Satıcı və bal süzgəcləri `?u=` və `?b=` parametrləridir. Üç faydası var: səhifə
server komponenti qalır, süzülmüş görünüş linklə göndərilə bilir, geri düyməsi
gözlənilən işi görür.

`FilterChip`-ə `href` verəndə `<a>` olur, `onClick` verəndə `<button>`. Naviqasiya
linkdir, əməliyyat düymədir — görünüşlərinin eyni olması vizual qərardır,
element seçimi isə deyil.

Süzgəc dəyişəndə DİGƏR süzgəc itməməlidir (`filterHref` ikisini də saxlayır).

**Səhifələnən siyahının süzgəci SERVERDƏ olmalıdır.** Söhbət siyahısı 60 sıra
ilə gəlir; onu brauzerdə süzmək «5 nəticə» göstərər, halbuki növbəti səhifədə
daha qırxı var. Tablar (`ChatTab`) məhz buna görə sorğu parametridir.

Yeni süzgəc əlavə edəndə əvvəlcə ÖLÇ, sonra denormalizasiya haqqında düşün.
«Cavabsız» tabı üçün `chat.last_direction` sütunu planlaşdırılmışdı və rədd
edildi: ölçmə göstərdi ki, indeks sırası ilə gedən lateral onsuz da 28 ms-dir.
Yavaş, amma doğru cavab — sürətli, amma yalan cavabdan yaxşıdır.

**Denormalizasiya edirsənsə, onu YAZAN yeniləməlidir.** `katibe.chat`-ın
sayğacları buna misaldır: `refresh_chat_stats()` uzun müddət heç yerdən
çağırılmırdı və 2026-08-31-də bir gün ərzində 3 060 mesaj köçürülməmiş, 207
söhbətin sayları sürüşmüş qaldı. İndi `mirror-evolution.ts` özü — pozan
skript — yenilənməni də çağırır. Ayrı skript, ayrı cron və ya "sonra əl ilə"
variantı seçmə: ayrılan iki addım nə vaxtsa ayrılmış qalır.

## 9. Boş vəziyyət iki cürdür

- **Süzgəc boşluğu:** "Bu süzgəclə açıq bayraq yoxdur" + süzgəci sıfırlayan link.
- **Həqiqi boşluq:** "Açıq bayraq yoxdur" + niyə sakit olduğunu izah edən rəqəmlər.

İkisini eyni mətnlə keçişdirmək oxucunu yanıldır.

## 10. Bir ekranın vədi hər ekranda görünməlidir

"Yalnız oxu" nişanı (`ReadOnlyLock`) sidebar-ın altında və başlıqda `inline`
variantı ilə durur — həmişə eyni yerdə. Bu, dekorasiya deyil: adam gündə bir
dəfə "bu ekranı açmaq telefonda nəsə etdimi?" sualını verir və cavabı
axtarmalı olmamalıdır.

Söhbət ekranında bağlı cavab qutusu da qəsdən görünür (sönük, `disabled`) —
gizlətmək "yaza bilərsən, sadəcə tapa bilmirsən" təəssüratı yaradardı.

**Üç fərqli sual, üç fərqli nişan.** Söhbət sırasında oxunma ilə bağlı üç ayrı
şey var və onlar bir sözlə ifadə oluna bilməz:

| Nişan | Sual | Mənbə |
|---|---|---|
| `gözləyir` | Cavab bizdədirmi? (son mesaj müştəridən) | `chat.awaiting` — son mesajın istiqaməti |
| `satıcı açmayıb · N` | Satıcı telefonda mesajı açıbmı? | `evolution_api."Chat".unreadMessages` — WhatsApp-ın öz nişanı |
| `siz baxmadınız` | NƏZARƏTÇİ bu paneldə söhbəti açıbmı? | `katibe.read_marker` — panelin öz izi |

Əvvəl yalnız üçüncüsü vardı və sadəcə «baxılmayıb» yazırdı — ekranda "satıcı
görməyib" kimi oxunurdu. Ona görə nəzarətçinin öz izi indi şəxsi dildədir
(«siz baxdınız / siz baxmadınız»): kimin baxdığı sualın yarısıdır.

**Oxunma vəziyyəti YALNIZ katibe.online-a aiddir.** Söhbət bu paneldə açılanda
oxundu sayılır, sonra gələn hər mesaj onu yenidən oxunmamış edir. WhatsApp bu
prosesdən kənardadır: orada mesaj satıcı özü açana qədər oxunmamış qalır və
panel ona heç vaxt toxunmur. Hər nişanın `title`-ı bu fərqi deməlidir.

«Siz baxdınız» nişanı oxunmamış mesaj varkən GÖRÜNMƏMƏLİDİR: «baxılıb 8×»
yazısı üç yeni mesajın üstündə texniki olaraq doğru, praktikada yalandır.

## 11. Kompakt etiket bir sətirdə qalır

Çip, nişan, bal etiketi ikinci sətrə keçməməlidir: `white-space: nowrap` +
sıxıla bilən mətn + `text-overflow: ellipsis`. Kəsilən mətnin tam variantı
`title` ilə açılmalıdır — yalnız hover ilə görünən məlumat toxunma ekranında
yoxdur.

## 12. Klaviatura ilə hər şey işləməlidir

`:focus-visible` üzüyü `tokens.css`-dədir və silinmir. Tab sırası vizual sıra
ilə üst-üstə düşməlidir. Modal daxilindəki düymələr də fokus üzüyü almalıdır.

## 13. Maskalama render qərarı deyil, məlumat qərarıdır

Nömrələr bazadan çıxarkən maskalanır (`chat-view.ts`), lentdə isə render
anında (`maskPhones`). Brauzerə çatmış nömrə artıq sızıb — komponentin ondan
sonra nə etməsinin əhəmiyyəti yoxdur.

Praktik nəticə: maskalanmış ekranda xam JID daşıyan link və ya sürətli baxış
göstərmə. Nəzarətçinin linki opaq token daşıyır (`monitor-token.ts`) və yalnız
həqiqətən görə biləcəyi söhbətlər üçün qurulur.

## 14. Telefon sərhədi bir dənədir: 860px

Panel masaüstü alətidir, amma sahibi onu telefondan da açır. Ona görə hər
ekranın telefon düzülüşü var və sərhəd HƏMİŞƏ `max-width: 860px`-dir
(`ui.module.css`, `chat.module.css`, `dashboard.module.css`). İki fərqli sərhəd
eyni telefonda bir ekranı dar, o birini geniş göstərər — və fərqi ancaq
istifadəçi görər.

Telefonda düzülüş dəyişir, məzmun yox: sətir sütuna keçir, yan panel yuxarı
zolağa çevrilir, cədvəl isə ÖZ QABINDA sürüşür. **Səhifənin gövdəsi heç vaxt
üfüqi sürüşmür** — sürüşən gövdə bütün ekranı yerindən oynadır və oxucu mətnin
sol kənarını itirir.

Köhnə ekranlarda (`dashboard.module.css`) cədvəl çoxdur, ona görə sürüşmə
qabı panelin özünə verilib: bir qayda 27 cədvəli tutur. Əl ilə qablaşdırılan
cədvəl (`.tableScroll`) daha yaxşıdır — orada bölmə başlığı yerində qalır —
amma unudulan ekran olmasın deyə ümumi qayda da var.

---

## Yeni ekran yazarkən yoxlama siyahısı

- [ ] Çərçivə `AppShell` + `Sidebar` + `TopBar`-dır, öz başlıq zolağı yoxdur
- [ ] Xam rəng, xam ölçü, xam boşluq yoxdur — hamısı token
- [ ] Rəqəmlər `--font-numeric` + `tabular-nums`
- [ ] Hər rəqəmin yanında onu izah edən söz var
- [ ] Rəng heç yerdə tək daşıyıcı deyil
- [ ] Süzgəclər URL-də, bir-birini itirmir
- [ ] Boş vəziyyət süzgəc boşluğu ilə həqiqi boşluğu ayırır
- [ ] `ReadOnlyLock` görünür
- [ ] Klaviatura ilə hər əməliyyat mümkündür, fokus üzüyü yerində
- [ ] Kompakt etiketlər bir sətirdə qalır
- [ ] İşıqlı və tünd temada da yoxlanılıb (`[data-theme="light"]`)
- [ ] Telefonda yoxlanılıb (860px) — gövdə üfüqi sürüşmür
