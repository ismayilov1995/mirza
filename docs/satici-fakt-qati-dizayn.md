# Satıcı statistikası — anlaşıqlılıq, dil və fakt qatı

Tarix: 2026-09-05 · Status: təsdiqlənib, icra planı gözləyir
Əvvəlki mərhələ: `docs/satici-statistikasi-dizayn.md`

## 1. Nə üçün

`/admin/satis` işləyir, amma sahibin şikayəti dəqiqdir: **«statistikalar
maraqlıdır, amma tam aydın olmur»**. Üç ayrı problem var və hər birinin öz
həlli var:

1. **Sütun adları jarqondur.** «İmkan», «Median FRT», «p90 ART», «SLA-ya
   düşmə», «Ölçülməyən» — bunların heç biri özünü izah etmir. Ekran doğru
   ölçür və oxunmur.
2. **Dil seçimi yoxdur.** Panelə baxan hər kəs Azərbaycan dilini oxumur;
   AZ / RU / EN lazımdır.
3. **Rəqəm var, nəticə yoxdur.** Cədvəl «kim nə edir»i göstərir, «kim
   digərindən nə ilə seçilir», «bayraq nə qədər sonra bağlanır», «əvvəl belə
   idi, indi düzəlib» suallarına isə insan özü baxıb nəticə çıxarmalıdır.

## 2. Ölçülmüş data reallıqları

Dizayn yazılmazdan əvvəl üç şey yoxlanıldı, çünki ikisi planı dəyişdi.

**Mövzu təsnifatı satıcılar üçün YOXDUR.** `katibe.message_topic`-də 8 289
sətir var, hamısı **principal** hesabınındır və sonuncusu **2026-08-24**
tarixlidir. `classify-topics.ts` skripti nə repoda, nə də crontab-dadır — yəni
qat bir dəfə qurulub və tərk edilib. Zemfira / Rouz / Rouz 2 üçün bir dənə də
sətir yoxdur. Mövcud etiketlər: GENERAL 3 597, PRODUCT_INFO 1 420, ORDER 951,
LOGISTICS 908, PAYMENT 666, PRICE_INQUIRY 437, COMPLAINT 310.

**Bayraq tarixçəsi gəncdir, amma işlək.** 530 tapıntının 476-sı bağlanıb,
**median bağlanma müddəti 2.9 saat**. Səbəblər: AUTO 396 (cavab getdi),
MANUAL 52 (insan bağladı), HANDOFF 11, SCOPE 8, RATED_NOISE 5, MUTED 4.
Tarixçə 2026-08-25-dən başlayır — 12 gün. Bu, «nə qədər sonra bağlanır»
sualına indi cavab verir, «aylarla trend» üçün isə hələ gəncdir.

**Həcm (30 gün, gələn müştəri mesajları):** Zemfira 9 373 / 1 404 söhbət,
Rouz 4 942 / 593, Rouz 2 2 298 / 246. Gündəlik axın ~550 mesaj — mövzu
təsnifatının qiyməti bu rəqəmdən çıxır.

## 3. Qərarlar

| Sual | Qərar | Səbəb |
|---|---|---|
| Mövzu qatı | **Tam**: 30 gün geriyə + gündəlik artım, Haiku | Sahib təsdiqlədi. Nümunə variantı mövzu qarışığını verir, amma «həmin mövzuya nə qədər tez cavab verildi» sualını zəiflədir. |
| İnterfeys dili | **Statik lüğət**, model yox | Sütun adı hər səhifə açılışında modeldən keçməməlidir: pul, gecikmə və qeyri-sabitlik — üçü də lazımsız. |
| AI mətninin dili | AZ-də yaranır, **Haiku ilə tərcümə**, `katibe`-də keş | `summary_translation`-un artıq işləyən modeli; sınanmış qəlibi təkrar icad etmirik. |
| Rəqəmlərin mənbəyi | **Həmişə SQL**, model yalnız cümlə yazır | Nəzarətçinin qaydası (`severity.ts` presedenti): model inandırıcı yazsa da, rəqəm auditə açıq qalmalıdır. |
| Trend | **Həftəlik şəkil cədvəli** + 12 həftə geriyə doldurma | Bu gün 90 gün geri hesablaya bilərik; altı ay sonra «avqustda necə idi» sualına yalnız saxlanmış şəkil cavab verə bilər. |

## 4. Anlaşıqlılıq — AI-siz, birinci növbədə

Sütun adları dəyişir. Jarqon itmir, ikinci sətrə keçir: FRT/ART beynəlxalq
addır və nə vaxtsa başqa hesabatla tutuşdurulacaq.

| İndi | Olacaq | Alt sətir |
|---|---|---|
| İmkan | **Cavab borcu** | müştəri yazıb, cavab bizdən gözlənilir |
| Median FRT | **İlk cavab** | müştəri yazandan ilk cavabımıza qədər (FRT) |
| Median ART | **Cavab arası** | söhbətin içində hər cavabın gecikməsi (ART) |
| p90 ART | **Ən yavaş 10%** | hər 10 cavabdan biri bundan da gec gedir |
| Cavabsız | **Cavabsız qalan** | 24 saat ərzində heç bir cavab getməyib |
| SLA-ya düşmə | **Hədəfi keçən** | SLA qaydasının verdiyi vaxta çatmayanlar |
| Ölçülməyən | **Hədəfsiz** | həmin an qüvvədə SLA qaydası olmayanlar |

Üstəlik açılıb-yığılan **«Bu rəqəmlər nə deməkdir?»** bölməsi: hər metrik bir
cümlə izah + bir konkret nümunə («müştəri 14:00-da yazdı, cavab 14:08-də getdi
→ ilk cavab 8 dəqiqə»). Bölmə `<details>`-dir, JS tələb etmir.

## 5. Dil seçimi

`?lang=az|ru|en` — URL-də, `docs/rules.md` §8-ə uyğun, digər süzgəcləri itirmir.
`Lang` tipi `src/lib/chat-ai.ts`-dən gəlir (orada az/en/ru/tr/ar var); bu ekran
üçün seçici **yalnız üçünü** göstərir, çünki lüğət üç dildə yazılır — mövcud
olmayan dili seçimə qoymaq boş vəd olardı.

- **İnterfeys mətni:** `src/app/admin/satis/dictionary.ts` — açar → üç dil.
  `Dict` tipi AZ variantından çıxarılır, ona görə RU/EN-də unudulan açar
  runtime fallback deyil, **kompilyasiya xətası** verir. (Dizayn ilk yazılanda
  fallback nəzərdə tutulmuşdu; tip yoxlaması ondan güclüdür — yarımçıq tərcümə
  ilə yaşayan ekran nə işləyir, nə də pozulduğu görünür.) Tanınmayan `?lang=`
  dəyəri isə AZ-yə düşür.
- **AI mətni:** `katibe.sales_insight_translation`-da keşlənir, açar
  `(insight_id, lang)`. Tərcümə uğursuz olsa orijinal qaytarılır — model
  nasazlığı səhifəni uçurmamalıdır (`chat-ai.ts` presedenti).

## 6. Ölçmə pəncərəsi diapazona çevrilir

`computeSalesStats(days)` indi **son N gün** deməkdir; şəkil cədvəli üçün
«2026-08-24 ilə 2026-08-30 arası» lazımdır. Ona görə funksiya
`{ fromTs, toTs }` qəbul edir, `days` variantı isə onun üstündə nazik
örtükdür. Bu, iki şeyi eyni anda açır: keçmiş həftələri doldurmaq və ekranda
«əvvəlki dövrlə müqayisə» göstərmək.

## 7. Şəkil (snapshot) cədvəli

`katibe.sales_snapshot` — hər ISO həftə, hər satıcı üçün bir sətir:

```sql
CREATE TABLE katibe.sales_snapshot (
  id            bigserial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES katibe.users(id) ON DELETE CASCADE,
  period_start  date NOT NULL,              -- həftənin bazar ertəsi (Asia/Baku)
  period_end    date NOT NULL,              -- daxil deyil
  -- Metriklərin hamısı: ümumi, gün növü, saat profili, bayraq, mövzu.
  -- JSONB, çünki dəst zamanla böyüyəcək və hər əlavə sütun üçün migration
  -- yazmaq şəkil cədvəlini dondurardı.
  payload       jsonb NOT NULL,
  -- Sorğuda ən çox işlənən üç rəqəm sütun kimi də durur: trend qrafiki
  -- JSONB açmadan çəkilsin.
  opportunities integer NOT NULL,
  unanswered    integer NOT NULL,
  frt_median    integer,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period_start)
);
```

**Yenidən hesablanır, artırılmır.** Eyni həftə üçün ikinci dəfə işləmək sətri
əvəz edir — `refresh_chat_stats()` presedenti: artıran məntiq sürüşür,
yenidən sayan sürüşmür.

**12 həftə geriyə doldurulur** (qurulanda bir dəfə). Mesajlar onsuz da
anbardadır; doldurmasaq, trend üç ay gözləyərdi.

## 8. Mövzu qatı

Köhnə `katibe.message_topic` **`message_topic_legacy` adına keçir** (kodda heç
bir istinadı yoxdur, yalnız bir şərhdə adı çəkilir) və yeni cədvəl kanonik
anbara bağlanır:

```sql
CREATE TABLE katibe.message_topic (
  message_id    bigint PRIMARY KEY REFERENCES katibe.message(id) ON DELETE CASCADE,
  topic         text NOT NULL,
  model         text NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now()
);
```

- **Etiket dəsti köhnə ilə eynidir** — GENERAL, PRODUCT_INFO, ORDER,
  LOGISTICS, PAYMENT, PRICE_INQUIRY, COMPLAINT — ki, köhnə data ilə
  müqayisə mümkün qalsın.
- **Yalnız GƏLƏN müştəri mesajları** təsnif olunur. Bizim cavabımızın mövzusu
  müştərinin sualının mövzusu ilə eynidir; ikisini də saymaq qiyməti ikiqat
  edərdi.
- Dairə statistika ilə eynidir: fərdi/lid söhbətlər, Nəzarətçinin müştəri
  süzgəci.
- **Paket 40 mesaj, model `claude-haiku-4-5`.** Boş və çox qısa mesajlar
  (`ok`, emoji) modelə heç getmir — birbaşa GENERAL yazılır.
- Cron gündə bir dəfə (06:30, identify-clients-dən əvvəl), `TOPIC_MAX=1500`
  tavanı ilə. İlk doldurma əl ilə, `TOPIC_BACKFILL_DAYS=30`.
- **Ölçülmüş qiymət:** ilk doldurma ~$1, sonra ayda ~$0.5.

## 9. Fakt qatı

**Rəqəm koddan, cümlə modeldən.** Skript əvvəlcə beş dəst rəqəm hazırlayır,
sonra onları modelə verir və modeldən yalnız **müqayisə cümləsi** istəyir.

| Fakt növü | Rəqəmi hardan gəlir |
|---|---|
| `difference` — kim nə ilə seçilir | Cari həftə şəkli, satıcılar arası fərq |
| `flag` — bayraq nə qədər sonra **həll olunur** | `agent_posts`: açılan say; həll / möhlət / gündəmdən çıxan bölgüsü; həll medianı, səbəb bölgüsü |
| `hours` — hansı saatlarda aktivdirlər | Saat profili (şəkildən), pik saat və «qapının bağlandığı» saat |
| `topic` — hansı mövzularda necədirlər | Mövzu qarışığı + mövzu üzrə median cavab |
| `weekend` — həftə sonu daha gecmi | Gün növü bölgüsü, cari və əvvəlki dövr |

```sql
CREATE TABLE katibe.sales_insight (
  id           bigserial PRIMARY KEY,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  -- NULL = komanda haqqında ümumi fakt.
  user_id      integer REFERENCES katibe.users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('difference','flag','hours','topic','weekend')),
  headline     text NOT NULL,
  body         text NOT NULL,
  -- Cümlədəki HƏR rəqəm burada da durur: model uydursa, fərq görünür.
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Trend istiqaməti kodda hesablanır, modeldə yox.
  direction    text CHECK (direction IN ('better','worse','flat','new')),
  model        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_start, user_id, kind)
);

CREATE TABLE katibe.sales_insight_translation (
  insight_id bigint NOT NULL REFERENCES katibe.sales_insight(id) ON DELETE CASCADE,
  lang       text NOT NULL,
  headline   text NOT NULL,
  body       text NOT NULL,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (insight_id, lang)
);
```

### 9.1 «Bağlandı» ilə «həll olundu» ayrıldı (2026-09-06)

İlk versiyada `flag` faktı bir say və bir median işlədirdi: `acknowledged_at`
dolmuş HƏR bayraq «bağlanan» sayılırdı. Bu, iki fərqli hadisəni bir rəqəmə
yığırdı — cavab getdiyi üçün öz-özünə qapananı (AUTO) və menecerin «lazımsız»
deyib susdurduğunu (RATED_NOISE, MUTED), müştəri dairəsindən çıxanı (SCOPE),
işin filiala keçdiyini (HANDOFF). Model isə ona verilən rəqəmi olduğu kimi
oxuyur: «97 bağlandı» sətrini nailiyyət kimi yazırdı.

**Ölçmə (2026-08-24 həftəsi).** Həll olmayan bağlanmaları medianın kənarına
çıxarmaq rəqəmi cəmi ~5% dəyişdi (Zemfira 7 575 s → 7 193 s) — və qısaltdı,
uzatmadı: susdurulan bayraqlar orta hesabla daha gec (15 113 s) bağlanmışdı,
çünki onlara insan əli saatlarla sonra çatır. Deməli o vaxtkı əsas təhrif
medianda deyil, SAYDA idi: 97 «bağlanan»ın 11-i heç nə həll etməmişdi.

**Möhlət bunu keyfiyyətcə dəyişir.** Nəzarətçidəki «Möhlət ver» düyməsi
(2026-09-06) bayrağı bağlamır, təxirə salır: müddət bitəndə problem qalıbsa
TƏZƏ post açılır, yəni gözləmə saatı sıfırdan başlayır. Üç günlük gözləmə iki
qısa parçaya bölünür və ölçmədən ümumiyyətlə yox olur — bu, medianı «bir az»
dəyişən şey deyil, ölçülməli olan müddəti görünməz edir.

Ona görə `FlagStats` indi üç ayrı say saxlayır — `resolved` (AUTO + MANUAL),
`deferred` (SNOOZED), `dismissed` (qalanı və səbəbi bilinməyən) — median isə
yalnız `resolved` üzərindədir. `closed` sahəsi silindi: cəm heç bir sualın
cavabı deyildi və saxlansaydı, növbəti oxucu onu yenidən «həll olundu» kimi
oxuyardı. Səbəb bölgüsü (`byReason`) olduğu kimi qalır — qruplar onun
xülasəsidir.

**Köhnə şəkillər.** `payload` bir dəfə yazılıb dəyişmir, ona görə köhnə
sətirlər oxunuş anında çevrilir (`normaliseFlags`): saylar `byReason`-dan
bərpa olunur, median isə **null** qalır. Köhnə median bütün səbəbləri
qarışdırmışdı, yəni yeni sualın cavabını verə bilməz; onu «təxminən eynidir»
deyib keçirmək düzəldilən səhvi tarixə köçürmək olardı. Postları hələ
silinməmiş həftələr sadəcə yenidən yazıla bilər:
`SNAPSHOT_WEEKS=n npm run snapshot:sales`.

**Trend istiqaməti (`direction`) modelə buraxılmır.** Cari şəkil ilə əvvəlki
şəkil müqayisə olunur, istiqamət kodda çıxır, model isə onu cümləyə çevirir.
Səbəb Nəzarətçidəkinin eynidir: «düzəlib» sözü ölçülə bilən iddiadır və
modelin əhval-ruhiyyəsindən asılı olmamalıdır.

**Model `claude-sonnet-5`** — giriş kiçikdir (bir neçə yüz rəqəm), iş isə
müqayisə və seçimdir: hansı fərq deməyə dəyər, hansı səs-küydür. Bir gedişat
= 1-2 çağırış, təxminən **$0.05**. Həftədə bir dəfə, bazar ertəsi 06:50 —
şəkil yazıldıqdan sonra. Ekranda «Yenilə» düyməsi də var (admin, əl ilə).

**Say məhdudiyyəti:** bir dövr üçün ən çoxu **8 fakt**. Doqquzuncu fakt onuncu
faktı doğurur və lent oxunmaz olur; Nəzarətçi lentində bu artıq bir dəfə
görülüb.

## 10. Ekranda görünüşü

Müqayisə cədvəlinin **üstündə** «Nə görünür» paneli: faktlar sırası, hər biri
bir başlıq + bir cümlə + yanında öz rəqəmi və istiqamət nişanı (▲ pisləşib /
▼ yaxşılaşıb / = dəyişməyib). Rəng tək daşıyıcı deyil (§3): istiqamət sözlə
də yazılır.

Faktın altında **«nədən çıxdı»** sətri — hansı dövr, neçə söhbət, neçə bayraq.
Rəqəm izahsız qalmır (`docs/rules.md` §4).

## 11. Bu iş nə etmir (YAGNI)

- **Satıcıya bal/reytinq vermir.** Faktlar müqayisə edir, qiymətləndirmir.
- **Real-time deyil.** Faktlar həftəlikdir; rəqəmlər onsuz da hər açılışda
  canlıdır.
- **Bildiriş göndərmir.** Nə WhatsApp, nə e-poçt — ekran ekrandır.
- **Köhnə mövzu datasını köçürmür.** `message_topic_legacy` olduğu yerdə
  qalır; principal onsuz da satıcı deyil.
- **Türk və ərəb dili seçiciyə düşmür** — lüğət üç dildədir.

## 12. Risklər

- **Bayraq faktları 12 günlük tarixçə üzərində qurulur.** İlk həftələrdə
  «trend» sözü zəifdir; `direction='new'` məhz bunun üçün var — əvvəlki şəkil
  yoxdursa, fakt müqayisə iddia etmir.
- **Mövzu təsnifatı Haiku-dur** və qısa, kontekstsiz mesajda yanıla bilər.
  Ona görə mövzu faktları yalnız **50-dən çox mesajı olan** dəstdə yazılır.
- **Şəkil cədvəli yenidən hesablanır** — SLA qaydası dəyişsə, köhnə həftələrin
  yenidən hesablanması KEÇMİŞ rəqəmi dəyişər. Ona görə şəkil bir dəfə
  yazılandan sonra yenidən hesablanmır; yalnız açıq-aşkar boş və ya cari
  həftə yenilənir.
