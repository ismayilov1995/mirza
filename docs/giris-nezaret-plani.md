# Hesablar və instans səviyyəsində giriş nəzarəti — plan

## Qərarlar (təsdiqlənib)

1. **Admin hər şeyi görür**, amma instans *privat* işarələnə bilər — privat instansı
   yalnız açıq icazəsi olan görür, rolundan asılı olmayaraq. Bu, "sonradan yaranan
   admin principal-ı görməsin" tələbini yaddaşa yox, quruluşa bağlayır (default-deny).
2. **Parol hashi: Node-un daxili `scrypt`-i.** Əlavə asılılıq yoxdur.
3. **JID-ə bağlı cədvəllər qlobal qalır** — sxem dəyişmir. Yalnız *giriş nöqtələri*
   süzülür (kataloqdakı "hansı instanslar" sütunu daxil) və qlobal yazmalar
   `requireJid` ilə qorunur.
4. **MCP tokeni və login sürət limiti** — sonraya saxlanılıb, bu işə daxil deyil.

Aşağısı orijinal plandır (Q1–Q4 bölməsi yuxarıdakı qərarlarla əvəzlənib).

---

## 1. Hazırkı vəziyyət (audit nəticəsi)

Üç istiqamətdə tam inventar çıxarıldı: hər sorğu funksiyası, hər HTTP giriş nöqtəsi,
hər autentifikasiya yolu.

**Kök səbəb:** sessiya cookie-si `expires.imza`-dan ibarətdir — **içində heç bir
şəxsiyyət yoxdur** (`src/lib/auth.ts:26`). `verifySessionToken` `boolean` qaytarır.
Ona görə hazırda heç bir səhifə, route və ya server action sessiyanı oxumur;
yeganə yoxlama `src/proxy.ts`-dədir və o yalnız "cookie düzgündürmü" deyir.

Nəticə: **paroldan xəbəri olan hər kəs 4 instansın hamısını tam oxuyur** (~201 800
mesaj), admin panelini idarə edir, media fayllarını endirir.

### Ən ciddi konkret dəliklər

| # | Yer | Nə edir |
|---|---|---|
| 1 | `getTranslatedSummary` (`chat-ai.ts:222`) | `summary_id` bigint-i ilə **istənilən söhbətin AI analizini** qaytarır. Nə instans, nə JID yoxlaması. Sadə IDOR. |
| 2 | `GET /api/media/[messageId]` | `?instanceId` **çağıranın verdiyi açardır, icazə deyil**. Cavab xam fayl baytıdır — birbaşa exfiltrasiya. |
| 3 | `GET /api/live` | Parametrsiz çağırılanda **bütün instansların hadisə axını**. `curl` ilə açıq saxlamaq kifayətdir. |
| 4 | `getAgentFeed` (`supervisor/feed.ts:76`) | Üç sorğunun heç birində instans şərti yoxdur — bütün Nəzarətçi tapıntıları, kontakt adları, telefonlar. |
| 5 | `findPendingVoice` (`voice.ts:42`) | Süzgəcsiz `Message` skanı; **presigned S3 URL** qaytarır. |
| 6 | `acknowledgeAgentPost` | `WHERE id = $1` — ardıcıl tam ədəd, sayıla bilir. Hər bayrağı susdurmaq olar. |
| 7 | `runAnalysis` / `askQuestion` | İstənilən instans+JID üçün **pullu LLM çağırışı**. `askQuestion` hədəflənmiş axtarışdır: "bu söhbətdə qiymətlər nədir?" |
| 8 | `GET /api/instance/status` | İstənilən instans adı üçün **QR kod** qaytarır — hesab ələ keçirmə vasitəsi. |
| 9 | `getDirectory` və `getPendingSuggestions` | JID başına **hansı instansların o nömrə ilə danışdığını** göstərir. |
| 10 | `/admin/**` | Rol anlayışı yoxdur — sessiyası olan hər kəs instans təyinatını dəyişə bilər. |
| 11 | `POST /api/login` | Sürət limiti yoxdur, `!==` müqayisəsi (sabit vaxtlı deyil), uğursuz cəhd loglanmır. |

### Plandan kənar, amma təcili (ayrıca qərar tələb edir)

- **MCP tokeni nginx logunda açıq mətndədir.** `mcp/http.ts` tokeni yol seqmentində
  qəbul edir, ona görə `POST /mcp/<token>` `access.log`-a düşür — hazırda **30 dəfə**.
  Fayl `www-data:adm` qrupundadır. Bu, bütün arxivə müddətsiz açardır.
  → Token dəyişdirilməli, log təmizlənməli, yol-seqment rejimi ya söndürülməli,
  ya da nginx-də loga düşməzdən əvvəl başlığa çevrilməlidir.
- **`mcp/priorities.json` git-ə commit olunub** — real müştəri adları, telefon
  nömrələri, JID-lər. Repo **private-dir** (anonim `404` yoxlandı), yəni açıq sızma
  yoxdur, amma fayl `0640` rejimi ilə qorunub sonra versiya nəzarətinə qoyulub.
  → `git rm --cached` + `KATIBE_MCP_PRIORITIES` ilə repo xaricinə çıxarmaq.
- **`/api/login` sürət limiti** — nginx-də `limit_req`, beş sətirlik dəyişiklik.

---

## 2. Sizdən dörd qərar lazımdır

### Q1. Admin hər şeyi görsün, yoxsa yalnız idarə etsin?

Tapşırıqda iki tələb bir-birinə ziddir:
- *"admins see everything and manage users"*
- *"principal must be invisible to everyone except me"*

İkinci admin yaransa, birinci qayda principal-ı ona açır.

**Təklifim:** **məlumat girişi hər kəs üçün yalnız açıq təyinat siyahısıdır** —
admin də daxil. `admin` rolu *idarəetmə* səlahiyyətidir (hesab yaratmaq, təyinat
vermək), avtomatik oxu icazəsi deyil. Siz principal-ı yalnız özünüzə təyin
edirsiniz; başqa admin onu görmür.

Qalıq risk: admin özünə təyinat verə bilər (təyinat idarəsi onun səlahiyyətidir).
İstəsəniz `locked_to_user_id` sütunu əlavə edərəm — o instansın təyinatını yalnız
sahibi dəyişə bilər.

### Q2. Parol hashi

Siz bcrypt/argon2 dediniz. **Təklifim: Node-un daxili `scrypt`-i** —
- əlavə asılılıq yoxdur (bcrypt/argon2 native modul tələb edir),
- layihənin üslubuna uyğundur (sessiyalar da Web Crypto ilə əl ilə yazılıb),
- bu serverdə ölçdüm: `N=32768, r=8, p=1` → **287 ms**, yaxşı qiymətdir,
- format: `scrypt$N$r$p$<salt>$<hash>`, gələcəkdə argon2-yə keçid üçün açıqdır.

argon2id istəsəniz onu qururam — sadəcə native modul build tələbi gəlir.

### Q3. JID-ə bağlı qlobal cədvəllər

`contact_labels`, `group_subject`, `lid_number`, `chat_suggestion` cədvəllərində
**instans sütunu yoxdur** — bir kontaktı adlandıranda ad bütün instanslarda görünür.
Bu, qəsdən belədir (kodda yazılıb).

İki yol:
- **(a) Paylaşılan qalsın** — ad/kateqoriya ümumi lüğətdir. Sızma yalnız *giriş
  nöqtəsindən* olur (kataloq səhifəsi, qlobal yazma), ona görə **hər giriş nöqtəsi
  scope-lanır**, cədvəl toxunulmaz qalır. Kiçik dəyişiklik. ← **təklifim**
- **(b) Hər cədvələ `instance_id` əlavə olunsun** — böyük miqrasiya, mövcud 500+
  etiket hansı instansa aid olduğu bilinmədən köçürülməlidir, və bir kontaktı hər
  instansda ayrıca adlandırmaq lazım gələcək.

(a)-da qalıq: A instansına girişi olan istifadəçi, öz söhbətindəki bir nömrənin
sizin qoyduğunuz adını görür. Məncə bu qəbuledilməzdir deyilsə (b)-yə keçək.

### Q4. Təcili düzəlişlər nə vaxt?

MCP token rotasiyası + login sürət limiti bu işin içində edilsin, yoxsa ayrıca və
indi? (Məncə **indi, ayrıca** — onlar bu plandan asılı deyil.)

---

## 3. Sxem

`katibe.users` **satıcılardır** (ölçülən adamlar), giriş hesabı deyil. Yeni cədvəllər
ayrıdır və qarışdırılmır.

```sql
CREATE TABLE katibe.dashboard_users (
  id                   serial PRIMARY KEY,
  username             text NOT NULL,
  email                text,
  password_hash        text NOT NULL,        -- scrypt$N$r$p$salt$hash
  role                 text NOT NULL CHECK (role IN ('admin','viewer')),
  active               boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  password_changed_at  timestamptz,
  -- Sessiyaları ləğv etmək üçün: cookie bu rəqəmi daşıyır, uyğun gəlmirsə
  -- sessiya ölür. Hesab söndürüləndə/parol dəyişəndə/əl ilə artırılır.
  session_epoch        integer NOT NULL DEFAULT 0,
  -- İsteğe bağlı: bu hesab hansı satıcıya aiddir (audit üçün, giriş üçün yox).
  katibe_user_id       integer REFERENCES katibe.users(id) ON DELETE SET NULL,
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           integer REFERENCES katibe.dashboard_users(id)
);

-- Böyük/kiçik hərf fərqi olmadan unikal
CREATE UNIQUE INDEX dashboard_users_username_key ON katibe.dashboard_users (lower(username));
CREATE UNIQUE INDEX dashboard_users_email_key ON katibe.dashboard_users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE katibe.dashboard_user_instances (
  user_id     integer NOT NULL REFERENCES katibe.dashboard_users(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  integer REFERENCES katibe.dashboard_users(id),
  PRIMARY KEY (user_id, instance_id)
);

CREATE INDEX dashboard_user_instances_instance_idx
  ON katibe.dashboard_user_instances (instance_id);
```

**Sessiya cookie-si.** Hazırkı format `expires.imza`-dır və üçüncü hissə əlavə etmək
onu səssizcə sındırır (`split(".")` iki elementə açılır). Ona görə **versiyalı
format**:

```
v2.<base64url({uid, epoch, exp})>.<imza>
```

- Köhnə iki hissəli tokenlər **açıq şəkildə rədd edilir** (yoxsa şəxsiyyətsiz sessiya
  yeni kodda `userId === undefined` kimi oxunar — bu, yeni bypass olardı).
- İmza müqayisəsi `timingSafeEqual`-a keçir.
- Hər sorğuda DB-dən `active` və `session_epoch` yoxlanılır → hesab söndürüləndə
  sessiya dərhal ölür.

**Şəxsiyyət necə ötürülür.** `proxy.ts` **başlıq yazmayacaq** — çağıran özü
`x-katibe-user: 1` göndərə bilər və səhifə ona inanardı. Bunun əvəzinə hər səhifə/
route `cookies()`-dan oxuyub özü doğrulayır (`getSession()`). Next-in öz sənədi də
bunu deyir: *"Proxy ... should not be used as a full session management or
authorization solution"* (`node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md:29`).
Proxy yalnız istifadəçi rahatlığı üçün `/login`-ə yönləndirir; **təhlükəsizlik sərhədi
məlumat qatındadır.**

---

## 4. Tətbiq mexanizmi: kompilyator sübutu

Problem: 30 sorğu funksiyası, 120 çağırış yeri. "Hər yerdə yoxlama yazmağı unutma"
qaydası uzunmüddətli işləmir. Ona görə **tip sistemi məcbur edir**.

```ts
// src/lib/access.ts
declare const scoped: unique symbol;
export type ScopedInstanceId = string & { readonly [scoped]: true };
export type ScopedJid        = string & { readonly [scoped]: "jid" };

export async function getSession(): Promise<Session | null>;
export async function requireSession(): Promise<Session>;          // yoxdursa /login
export async function requireAdmin(): Promise<Session>;            // admin deyilsə 403
export async function requireInstance(id: string): Promise<ScopedInstanceId>;  // icazə yoxdursa 403
export async function requireJid(jid: string): Promise<ScopedJid>; // JID mənim instanslarımda yoxdursa 403
export async function myInstances(): Promise<ScopedInstanceId[]>;

// Yeganə qaçış yolu — sessiyası olmayan cron/MCP üçün. Ad qəsdən uzundur ki,
// grep ilə tapılsın; CI onun yalnız scripts/ və mcp/ altında görünməsini yoxlayır.
export function systemScope(id: string): ScopedInstanceId;
```

Sonra `src/lib/queries.ts` və qonşularında hər imza dəyişir:

```ts
- export async function getOverview(instanceId: string)
+ export async function getOverview(instanceId: ScopedInstanceId)
```

Bundan sonra `getOverview(params.instanceId)` **kompilyasiya olunmur** — çünki
`string` markalı tipə uyğun gəlmir. Yeganə yol `await requireInstance(...)`-dən
keçməkdir. Eyni şey JID alan funksiyalar üçün `ScopedJid` ilə.

Instansdan asılı olmayan funksiyalar (`getDirectory`, `getPendingSuggestions`,
`getAgentFeed`, `getAutoAppliedLabels`, `findPendingVoice`) imzaya
`scope: ScopedInstanceId[]` alır və SQL-ə `AND instance_id = ANY($n)` əlavə olunur.

**Bu, "unutmaq" ehtimalını sıfıra endirir:** yeni funksiya yazan adam ya markalı
tip alır (deməli yoxlamadan keçir), ya da `systemScope` yazır (deməli CI-da görünür).

---

## 5. Tətbiq xəritəsi — hər giriş nöqtəsi

### Səhifələr

| Yol | İndi | Sonra |
|---|---|---|
| `/i/[instanceId]` (+ `/base`, `/labels`, `/chat/[jid]`) | yalnız "instans mövcuddurmu" | ilk sətir `await requireInstance(instanceId)` → **403** |
| `/i/[instanceId]/chat/[jid]` | JID yoxlanmır | üstəlik `requireJid(jid)` |
| `/` (user seçimi) | bütün instanslar | yalnız `myInstances()` |
| `/agent` | bütün tapıntılar | `getAgentFeed(await myInstances())` |
| `/admin`, `/admin/sla`, `/admin/suggestions`, `/admin/contacts`, `/admin/instance/[name]` | sessiya kifayətdir | `await requireAdmin()` |
| `/admin/contacts` (kataloq) | bütün JID-lər + hansı instanslar | `scope` ilə süzülür: yalnız mənim instanslarımda görünən JID-lər, instans siyahısı da kəsilir |
| `/settings/mcp` | sessiya kifayətdir | `requireAdmin()` — bu, sahibin brifinq konfiqidir |

### API route-ları

| Yol | İndi | Sonra |
|---|---|---|
| `GET /api/media/[messageId]` | `?instanceId` çağırandan gəlir → IDOR | `messageId`-dən instans **DB-dən həll olunur**, sonra `requireInstance`. `?instanceId` parametri **silinir**. Həmçinin WhatsApp fallback-ı `EVOLUTION_INSTANCE_NAME` qlobalını işlədir — düzgün instansa bağlanır. |
| `GET /api/live` | parametrsiz = hər şey | hadisələr `myInstances()`-ə görə süzülür; parametr **daraldıcıdır, genişləndirici deyil** |
| `GET /api/instance/status` | istənilən ad, QR qaytarır | ad → instans həll olunur, `requireInstance`; QR yalnız `requireAdmin` |
| `POST /api/login` | paylaşılan parol | istifadəçi adı + parol, `scrypt` yoxlaması, `timingSafeEqual`, uğursuz cəhdlər loglanır |
| `POST /api/webhooks/*` | paylaşılan sirr | dəyişmir (öz sirri var) |

### Server action-ları (hamısı HTTP endpoint-dir)

| Action | Sonra |
|---|---|
| `runAnalysis`, `askQuestion` | `requireInstance` + `requireJid`; üstəlik sadə sürət limiti (pul xərcləyirlər) |
| `setChatLabel`, `acceptSuggestion`, `rejectSuggestion` | `requireJid(jid)` — JID mənim instanslarımın birində görünməlidir |
| `acknowledgeAgentPost` | `postId` → `instance_id` DB-dən həll olunur → `requireInstance` |
| `admin/actions.ts` hamısı (`assignInstance`, `createInstanceAction`, …) | `requireAdmin()` |
| `admin/sla/actions.ts` hamısı | `requireAdmin()` |
| `admin/suggestions/actions.ts` hamısı | `requireAdmin()` |
| `settings/mcp/actions.ts` hamısı | `requireAdmin()` |

### Kitabxana funksiyaları — xüsusi düzəlişlər

| Funksiya | Düzəliş |
|---|---|
| `getTranslatedSummary(summaryId)` | imza `(instanceId: ScopedInstanceId, summaryId)` olur, `WHERE instance_id = $1` əlavə edilir |
| `findPendingVoice` | `scope` alır; cron `systemScope` ilə çağırır |
| `getAgentFeed`, `getLastRunAt` | `scope` alır |
| `OWN_NAME_SQL`, `EXISTING_NAME_SQL` | süzgəcsiz `Chat`/`Contact` alt-sorğuları `scope`-a bağlanır |
| `getDirectory`, `getPendingSuggestions`, `getAutoAppliedLabels` | `scope` alır; instans siyahısı aqreqasiyası da süzülür |
| `refreshOpenPost(dedupeKey)` | `instance_id` şərti əlavə olunur (açar çağırandan gəlirdi) |
| `applySuggestion`, `resolveSuggestion`, `revertAutoLabel`, `labelAsClient` | `ScopedJid` alır |
| `getInstanceInfo` | qalır, amma çağıranlar əvvəlcə `requireInstance` edir |

### Admin ekranları (yeni)

- `/admin/accounts` — siyahı: istifadəçi adı, rol, aktivlik, təyin olunmuş instanslar,
  son giriş.
- Yaratmaq / redaktə / **söndürmək** (silmək yox — audit izi qalsın).
- İnstans təyinatı: hər hesab üçün checkbox siyahısı.
- **Parol sıfırlama**: admin müvəqqəti parol qoyur → `must_change_password = true`
  → istifadəçi növbəti girişdə dəyişməyə məcburdur. Sıfırlama `session_epoch`-u
  artırır, yəni köhnə sessiyalar dərhal ölür.
- Öz-özünü qorumaq: admin öz hesabını söndürə/rolunu aşağı sala bilməz; son aktiv
  admin silinə bilməz.

---

## 6. Sızma olmadığını necə sübut edirəm

Üç qat, üçü də avtomatik:

**Qat 1 — kompilyator.** `npx tsc --noEmit` markalı tipə görə hər yoxlanmamış çağırışda
xəta verir. Bu, "hansısa səhifədə unutdum" ssenarisini strukturca aradan qaldırır.

**Qat 2 — CI qrep.** `systemScope` yalnız `scripts/` və `src/lib/supervisor/`
altında görünə bilər. `src/app/` altında bir dənə görünsə, yoxlama uğursuz olur.

**Qat 3 — canlı yoxlama: `scripts/verify-access-control.ts`.**
Bu, sizin istədiyiniz empirik sübutdur. Nə edir:

1. Müvəqqəti `viewer` hesabı yaradır, ona **yalnız Rouz** instansını verir.
2. `/api/login` ilə real cookie alır.
3. principal-ın **real** id-ləri ilə ~30 hədəfə sorğu atır:
   - `/i/<principal>` və üç alt səhifə
   - `/i/<principal>/chat/<principal-jid>`
   - `/api/media/<principal-message-id>`
   - `/api/live` (parametrsiz — hadisə axınında principal görünürmü)
   - `/api/instance/status?name=principal`
   - `/admin` və bütün admin alt səhifələri
   - `getTranslatedSummary` üçün principal-a aid `summary_id`
4. Hər biri üçün **403/404 və ya boş** gözləyir; `200` + məlumat gələrsə **uğursuz**.
5. Sonra **admin cookie-si ilə eyni sorğuları** atır və `200` gözləyir — beləcə
   yoxlamanın həqiqətən fərq qoyduğu təsdiqlənir (hər şeyin sadəcə sınıq olmadığı).
6. Cədvəl çap edir, bir dənə uğursuzluqda `exit 1`.
7. Sonda müvəqqəti hesabı silir.

Server action-ları HTTP-dən çağırmaq kövrəkdir (Next action id-si build hash-idir),
amma **onlar Qat 1 ilə örtülür**: instans məlumatına toxunan hər action markalı tip
almalıdır, deməli `requireInstance`-dən keçir — kompilyator başqa yol qoymur.

---

## 7. Miqrasiya ardıcıllığı (iki yol heç vaxt eyni anda işləmir)

1. **Miqrasiya** tətbiq olunur — cədvəllər yaranır, heç nə onlardan istifadə etmir.
2. **`scripts/create-dashboard-user.ts`** işə salınır → sizin admin hesabınız yaranır.
   Skript parolu terminaldan gizli oxuyur (stdout-a **heç nə yazmır**) və özü-özünü
   yoxlayır: hash yazılır, dərhal geri oxunub doğrulanır.
3. **Kod deploy olunur.** Bu deploy-da `/api/login` **yalnız** `dashboard_users`-a
   baxır — `DASHBOARD_PASSWORD` koddan **tamamilə silinir** (bir yerdədir:
   `src/app/api/login/route.ts:10`). İki yol heç vaxt birlikdə yaşamır.
4. **Siz giriş edib təsdiqləyirsiniz.**
5. `DASHBOARD_PASSWORD` `.env.local`-dan silinir, servis yenidən başladılır.
6. Qalan hesablar `/admin/accounts`-dan yaradılır.

**Geri dönüş:** 4-cü addım alınmasa, `git revert` + restart kifayətdir — `.env.local`
hələ köhnə dəyişəni saxlayır. 5-ci addımdan sonra geri dönüş yoxdur (qəsdən).

**Sessiyalar:** deploy anında bütün mövcud cookie-lər v1 formatındadır və rədd
ediləcək — hamı bir dəfə yenidən giriş edəcək. Bu, gözlənilən davranışdır.

---

## 8. İş həcmi

| Mərhələ | Nə |
|---|---|
| 1 | Sxem + `access.ts` + sessiya formatı + login/logout |
| 2 | Markalı tiplərin yayılması (30 imza, ~120 çağırış yeri) — mexaniki, kompilyator yol göstərir |
| 3 | Xüsusi düzəlişlər: media, live, instance/status, translated summary, voice, feed, kataloq |
| 4 | `/admin/accounts` ekranları + parol sıfırlama |
| 5 | `verify-access-control.ts` + CI qrep |
| 6 | Miqrasiya icrası (yuxarıdakı 6 addım) |

Mərhələ 2 ən böyüyüdür, amma ən az riskli olanıdır: `tsc` hər qalan yeri özü göstərir.
