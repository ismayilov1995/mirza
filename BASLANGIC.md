# Katibe — sıfırdan başlamaq üçün bələdçi

Bu sənəd layihəni ilk dəfə görən adam üçündür. Məqsəd: bir maşında sistemi
tam qaldırmaq və Claude Code ilə təhlükəsiz işləməyə başlamaq.

Layihənin **niyəsi** və hər qərarın səbəbi [README.md](README.md)-dədir — burada
yalnız «necə başlamalı» var. Bir şey qəribə gəlirsə, cavab çox güman README-də
yazılıb; oradakı izahlar qəsdən uzundur, çünki əksəriyyəti bir dəfə səhv edilib
sonra düzəldilib.

---

## 1. Bu nədir

WhatsApp söhbətlərinin **statistika və nəzarət paneli**. Şirkətdə bir neçə satıcı
öz nömrəsindən müştəri ilə yazışır; panel bu yazışmaları oxuyub göstərir: kim nə
qədər gec cavab verir, hansı müştəri cavabsız qalıb, hansı söhbətdə sifariş var.

İki ayrı proqramdır və ikisi də lazımdır:

```
  WhatsApp (telefonlar)
        │  Baileys (WhatsApp Web protokolu)
        ▼
  ┌─────────────────────┐        ┌──────────────────────────────┐
  │  Evolution API      │ yazır  │  Postgres                    │
  │  (Node, açıq mənbə) ├───────►│   ├─ evolution_api  (sxema)  │
  │  + Redis + S3/MinIO │        │   └─ katibe         (sxema)  │
  └─────────────────────┘        └──────────────┬───────────────┘
                                                │ YALNIZ OXUYUR
                                                ▼
                                     ┌──────────────────────┐
                                     │  Katibe (Next.js)    │
                                     │  bu repo             │
                                     └──────────────────────┘
```

**Ən vacib memarlıq qərarı:** Katibe WhatsApp-a heç nə göndərmir. O, Evolution-un
Postgres bazasını oxuyur. Səbəb aşağıdakı 2-ci bölmədədir.

---

## 2. Pozulmayan qaydalar

Bunlar zövq məsələsi deyil — hər biri real problemdən sonra yazılıb.

### 2.1. Heç bir söhbət «oxunmuş» işarələnmir

Panel işçinin şəxsi telefonundakı WhatsApp-a bağlıdır. Əgər panel söhbəti oxunmuş
işarələsə, işçinin telefonunda mesaj oxunmuş görünəcək və o, müştərini gözdən
qaçıracaq. Ona görə:

- Katibe **Evolution API-ni çağırmır**, bazanı oxuyur — texniki olaraq oxunmuş
  işarələyə bilməz.
- İstisna: instans yaratmaq, QR almaq, qrup adlarını çəkmək. Bunlar `src/lib/evolution.ts`-dədir.

### 2.2. Yeni WhatsApp nömrəsi yalnız `SAFE_INSTANCE_SETTINGS` ilə qoşulur

`src/lib/evolution.ts`-dəki bu obyekt dörd bayrağı məcburi olaraq `false` edir:
`readMessages`, `readStatus`, `alwaysOnline`, `syncFullHistory`.

`alwaysOnline: true` olsa, WhatsApp linklənmiş sessiyanı «aktiv cihaz» sayır və
**işçinin telefonuna push bildiriş göndərməyi dayandırır**. Heç bir yerdə log
olunmur — səhv aylarla sezilməyə bilər. Ətraflı: README, «Why `alwaysOnline` must
stay false».

Bunu yan keçib əl ilə instans yaratmayın.

### 2.3. Pullu AI çağırışından əvvəl xəbərdarlıq

`scripts/` içindəki bir çox skript LLM API-sinə pul xərcləyir. Kütləvi süpürgə
işlətməzdən əvvəl sahibinə deyin. Hər belə skriptdə `*_DRY_RUN=1` var — əvvəlcə
onunla işlədin, nə edəcəyini çap edir, heç nə yazmır.

Real hadisə: ilk tam süpürgə `claude-opus-5` ilə başladı və 52 partiyanın
25-cisində Anthropic balansını bitirdi. İndi default mini-səviyyə modeldir.

### 2.4. Repoda real müştəri məlumatı yoxdur

Baza real adlar və telefon nömrələri saxlayır. Repoya **düşmür**:
`.env*`, `mcp/priorities.json`, `kataloq/`, `logs/`. Ekran şəkli paylaşarkən
nömrələri örtün. Nəzarətçi API-si söhbət açarı kimi JID yox, şifrələnmiş token
qaytarır (`src/lib/monitor-token.ts`) — çünki JID-in özü telefon nömrəsidir.

---

## 3. Nə lazımdır

| Ehtiyac | Versiya / qeyd |
| --- | --- |
| Node.js | 24.x (layihə `v24.19.0` ilə işləyir) |
| PostgreSQL | 16+ |
| Redis | 7+ (Evolution-un sessiya və keş yaddaşı) |
| S3 və ya MinIO | media (şəkil/səs) üçün; olmasa yalnız mətn görünür |
| WhatsApp nömrəsi | sınaq üçün ayrıca nömrə tövsiyə olunur, şəxsi nömrə yox |
| AI açarları | istəyə bağlı — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPINFRA_API_KEY` |

AI açarları olmasa panel tam işləyir, sadəcə təhlil düymələri işləmir.

---

## 4. Quraşdırma

### Addım 1 — Postgres və Redis

```bash
sudo -u postgres createdb evolution
sudo -u postgres psql -c "create user katibe with password 'DEYIS';"
sudo -u postgres psql -d evolution -c "grant all on database evolution to katibe;"
```

Redis-i default ayarlarla qaldırmaq kifayətdir.

### Addım 2 — Evolution API

```bash
git clone <evolution-repo-ünvanı> evolution-api
cd evolution-api
npm install
cp .env.example .env
```

`.env`-də mütləq dəyişilməli sətirlər:

```
SERVER_URL=http://127.0.0.1:8080
DATABASE_PROVIDER=postgresql
DATABASE_CONNECTION_URI=postgresql://katibe:DEYIS@127.0.0.1:5432/evolution?schema=evolution_api
AUTHENTICATION_API_KEY=<uzun təsadüfi açar>
CACHE_REDIS_ENABLED=true
CACHE_REDIS_URI=redis://127.0.0.1:6379/6
DATABASE_SAVE_DATA_NEW_MESSAGE=true
DATABASE_SAVE_DATA_CONTACTS=true
DATABASE_SAVE_DATA_CHATS=true
```

> **Tələ: `CORS_ORIGIN`.** `*` dəyərini daraltmayın. Origin başlığı olmayan
> sorğular (server tərəfdən gələnlər, cron-lar) 500 alır və səbəbi loglardan
> görünmür.

Sonra:

```bash
export DATABASE_PROVIDER=postgresql
npm run db:deploy
npm run build
npm run start:prod
```

`http://127.0.0.1:8080` cavab verirsə, hazırdır.

### Addım 3 — Katibe

```bash
git clone <katibe-repo-ünvanı> katibe-dashboard
cd katibe-dashboard
npm install
cp .env.example .env.local
```

`.env.local`-ı doldurun — hər açarın nə etdiyi `.env.example`-də yazılıb.
Minimum: `DATABASE_URL`, `SESSION_SECRET`, `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`.

```bash
openssl rand -hex 32   # SESSION_SECRET üçün
```

### Addım 4 — `katibe` sxeması

Miqrasiya aləti yoxdur; `sql/` qovluğundakı fayllar **ad sırası ilə** (tarix
prefiksi var) tətbiq olunur:

```bash
for f in sql/*.sql; do
  echo "→ $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

65 fayldan 10-u `IF NOT EXISTS` işlətmir — təmiz bazada problem çıxarmır, amma
təkrar işlədilsə xəta verir. Bu normaldır, o faylı ötürün.

### Addım 5 — İlk hesab və işə salma

```bash
npm run accounts:create <istifadəçi-adı>     # parol terminaldan gizli oxunur
npm run dev
```

`http://localhost:3000` → giriş.

### Addım 6 — WhatsApp nömrəsini qoşmaq

Panel → **Admin → Yeni WhatsApp qoş**. QR açılır, telefondan
*Ayarlar → Qoşulmuş cihazlar* ilə oxudun. QR təxminən bir dəqiqəyə köhnəlir,
səhifə özü yenisini çəkir.

Qoşduqdan sonra yoxlayın — üç sütun da `f` olmalıdır:

```bash
psql "$DATABASE_URL" -c 'select i.name, s."alwaysOnline", s."readMessages", s."readStatus"
  from evolution_api."Instance" i
  join evolution_api."Setting" s on s."instanceId" = i.id;'
```

### Addım 7 — Fon işləri (bunsuz panel donur)

Ən vacibi **mirror**: Evolution-un mesajlarını `katibe.message` cədvəlinə köçürür.
Ekranların demək olar hamısı o cədvəldən oxuyur.

```bash
npm run mirror:evolution     # hər 5 dəqiqədən bir işləməlidir
```

Bir dəfə planlaşdırılmadığı üçün panel 8.5 saat köhnə məlumat göstərdi və heç bir
xəta çıxmadı — çünki bütün sorğular böyüməyi dayanmış cədvəl haqqında düzgün
cavab verirdi. **Siyahı donubsa, ilk baxılacaq yer `logs/mirror.log`-dur.**

Cron nümunəsi:

```
*/5 * * * * cd /yol/katibe-dashboard && npx tsx scripts/mirror-evolution.ts >> logs/mirror.log 2>&1
15  * * * * cd /yol/katibe-dashboard && npx tsx scripts/harvest-lid-numbers.ts >> logs/lids.log 2>&1
```

Serverdə bunlar `flock` altında işlədilir ki, gecikən bir iş özü ilə üst-üstə düşməsin.

---

## 5. Repo xəritəsi

| Yer | Nə var |
| --- | --- |
| `src/app/` | Next.js marşrutları. `i/[instanceId]` — bir hesabın ekranları, `admin/` — idarəetmə, `monitor/` və `agent/` — nəzarətçi, `api/` — server marşrutları |
| `src/lib/` | Bütün məntiq. `queries.ts` (SQL), `access.ts` (icazələr), `evolution.ts` (Evolution çağırışları), `summary.ts` (AI təhlil), `monitor-token.ts` (JID şifrələməsi) |
| `src/components/ui/` | Hazır primitivlər — yeni ekran bunlarla qurulur |
| `scripts/` | 40+ birdəfəlik və cron skripti (mirror, süpürgələr, smoke testlər) |
| `sql/` | Sxema tarixçəsi, tarix sırası ilə |
| `mcp/` | Claude üçün oxu-yalnız MCP serveri |
| `docs/` | Dizayn dili (`rules.md`) və planlar |

---

## 6. Claude Code ilə işləmək

Repo Claude Code ilə yazılıb və onunla davam etmək üçün hazırdır.

**Avtomatik oxunanlar:** `CLAUDE.md` → `AGENTS.md`-i çağırır, o da UI yazmazdan
əvvəl `docs/rules.md`-i oxumağı tələb edir. Yeni ekranı sıfırdan `div` ilə
qurmayın — `AppShell` + `src/components/ui/` primitivləri var.

Yaxşı nəticə verən qaydalar:

1. **Əvvəlcə ölç, sonra mübahisə et.** İki dizayn variantı varsa, əvvəlcə kiçik
   eval dəsti qurun. Bu repoda `eval:search`, `eval:intent`, `eval:verify`
   məhz bunun üçündür — bir dəfə «aydındır ki, belə daha yaxşıdır» deyilib və
   ölçmə əksini göstərib.
2. **Sxema dəyişikliyi = yeni fayl.** `sql/`-dakı köhnə faylı redaktə etməyin;
   `sql/YYYY-AA-GG_ad.sql` adı ilə yenisini əlavə edin.
3. **İcazələri dəyişəndə yoxlayın:**
   ```bash
   npm run verify:access     # real sorğularla sızma axtarır
   npm run check:access      # statik sərhəd yoxlaması
   ```
   Sistem `ScopedInstanceId` adlı brend tipdən istifadə edir: yoxlanılmamış
   instans ID-si ilə sorğu yazmaq **kompilyasiya xətası** verir. Tipi `as` ilə
   məcbur çevirməklə keçməyin — o xəta məhz sizi qorumaq üçündür.
4. **Smoke skriptləri var:** `npm run smoke:chat`, `smoke:sales`, `smoke:snooze`
   — ekranı real baza ilə açıb yoxlayır.
5. **Commit dili azərbaycancadır**, Conventional Commits formatında:
   `feat(statistika): ...`, `fix(nəzarətçi): ...`.
6. **Şərhlər «nə»ni yox, «niyə»ni izah edir.** Repodakı üslub budur: kod nə
   etdiyini onsuz da göstərir, şərh isə hansı səhvin qarşısını aldığını yazır.

---

## 7. Tez-tez rast gəlinən problemlər

| Əlamət | Səbəb |
| --- | --- |
| Söhbət siyahısı donub, xəta yoxdur | `mirror:evolution` işləmir → `logs/mirror.log` |
| Evolution-a hər sorğu 500 verir | `.env`-də `CORS_ORIGIN` daraldılıb |
| Girişdən sonra dərhal çıxır | `SESSION_SECRET` dəyişib və ya boşdur |
| Söhbətlərin çoxunun adı yoxdur | `@lid` ünvanlaşdırması — WhatsApp nömrəni gizlədir. `npm run harvest:lids`, sonra AI təklifləri |
| Şəkil/səs açılmır | `S3_*` açarları doldurulmayıb |
| İşçi telefonunda bildiriş gəlmir | həmin instansda `alwaysOnline=true` qalıb — 2.2 bölməsi |

---

## 8. Bu repoda olmayanlar

Dostunuz özü qurmalıdır: real `.env.local` dəyərləri, `mcp/priorities.json`
(real adlar var), `kataloq/` şəkilləri (~51 MB), verilənlər bazasının məzmunu və
sınaq üçün WhatsApp nömrəsi.
