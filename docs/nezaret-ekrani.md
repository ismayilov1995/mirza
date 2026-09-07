# Nəzarət ekranı (internal control) — model və API

Daxili nəzarətçi indiyə qədər satıcıların WhatsApp-larını ayrı brauzerlərdə
**açıq sessiya** ilə yoxlayırdı: yaza bilirdi, hər şeyi görürdü — zakaz
qrupları, orada duran müştəri nömrələri, daxili yazışmalar. Bu sənəd onun
əvəzini təsvir edir: ayrıca rol, yalnız-oxu ekran və söhbət səviyyəsində
görünmə qaydaları.

Kod: `src/lib/access.ts` (icazə), `src/lib/monitor*.ts`, `src/app/monitor/`,
`src/app/api/monitor/`, `src/app/admin/monitor/`, `sql/2026-08-29_monitor_role.sql`.

## Qərarlar

| Sual | Qərar | Səbəb |
|---|---|---|
| Qruplar | **Default gizli**, əl ilə açılır | Son 90 gündə 475 aktiv qrup var; zakaz qrupları məhz onlardır. Sabah yaranan qrup da avtomatik gizli qalır. |
| Fərdi söhbətlər | Default açıq | Nəzarətin işi elə odur. Kateqoriya və ya konkret söhbət üzrə bağlana bilir. |
| Telefon nömrələri | **Maskalanır** (`+99450 *** ** 02`) | Nəzarətçi kimin yazdığını ayırd edir, müştəri bazasını köçürə bilmir. |
| Tarixçə | **90 gün** (hesab üzrə dəyişir) | Cavab keyfiyyətini yoxlamaq üçün bəsdir; illərlə arxiv birdəfəlik açılmır. |
| Media | Tam giriş | Qızlar çox vaxt şəkil göndərir; şəkilsiz cavabı qiymətləndirmək olmur. |
| Yazmaq | Yoxdur | Ekranda göndərmə yolu yoxdur, backend-də də mesaj göndərən heç bir çağırış yoxdur. |

**"Oxundu" riski yoxdur.** Bütün mesajlar `evolution_api`-nin öz Postgres-indən
oxunur; nəzarət ekranı WhatsApp-a heç bir sorğu atmır (yeganə istisna media
faylının endirilməsidir — o da oxu qəbzi göndərmir).

## Görünmə qaydası

Hər söhbət üçün ilk uyğun gələn qərar qalib gəlir:

1. `katibe.monitor_chat_rule` — həmin söhbət üçün açıq qərar (`allow`/`deny`)
2. `katibe.monitor_category_rule` — söhbətin kateqoriyası üçün qərar
3. `katibe.monitor_profile` — tipə görə default (`group_default`, `direct_default`)

SQL ifadəsi: `monitorVisibleSql()` + `monitorVisibilityJoins()` (`src/lib/access.ts`).
Nəzarətçiyə məlumat qaytaran **hər** sorğu bunları işlətməlidir.

Tip sistemi bunu məcbur edir: nəzarətçi sorğuları `MonitorScope` / `VisibleChat`
markalı tiplərini qəbul edir və o dəyərləri yalnız `requireMonitorScope()` və
`requireVisibleChat()` yarada bilir. Adi (süzgəcsiz) `ScopedInstanceId` sorğuları
ilə qarışdırmaq kompilyasiya xətasıdır.

## Xam JID qaytarılmır

`994500000002@s.whatsapp.net` JID-inin özü telefon nömrəsidir. Ona görə API
söhbətin açarı kimi **opaq token** qaytarır (`src/lib/monitor-token.ts`):
deterministik AES-256-GCM, instansa AAD ilə bağlı. Deterministikdir ki, canlı
hadisə ilə açıq söhbəti müqayisə etmək mümkün olsun.

Bu, `npm run verify:access`-in tapdığı real sızma idi: ad, mətn və nömrə sahəsi
maskalanmışdı, JID isə açıq gedirdi.

## API müqaviləsi

Hamısı sessiya çərəzi ilə işləyir. Admin `?as=<monitorUserId>` əlavə edərək
"bu nəzarətçi nə görür" önizləməsi ala bilir — eyni süzgəclərlə.

### `GET /api/monitor/instances`
```jsonc
{
  "viewer": { "username": "kontrol", "preview": false, "historyDays": 90, "maskPhones": true },
  "instances": [{
    "instanceId": "9f4f…", "instanceName": "Zemfira", "ownerName": "Zemfira",
    "connectionStatus": "open", "visibleChats": 792, "awaiting": 177,
    "lastActivityAt": 1787848963
  }]
}
```

### `GET /api/monitor/chats?instanceId=…&q=…&before=<ts>&limit=40`
```jsonc
{
  "chats": [{
    "chat": "y8Cnafr1A9…",            // opaq açar — bütün digər sorğularda bu işlənir
    "name": "Mounati ✨ · +97477 *** ** 97",
    "chatType": "group | individual | lid | broadcast | unknown",
    "categoryName": "Client",
    "lastMessageText": null,           // media üçün null
    "lastMessageType": "audioMessage",
    "lastMessageFromMe": false,
    "lastMessageAt": 1787848963,       // epoch saniyə
    "awaiting": true                   // son söz qarşı tərəfindir
  }],
  "nextCursor": 1787840000             // `before` üçün; son səhifədə null
}
```

### `GET /api/monitor/messages?instanceId=…&chat=<token>`
`&before=<ts>` daha köhnə səhifə, `&after=<ts>` yalnız yenilər (başlıq gəlmir).
```jsonc
{
  "chat": { "chat": "y8C…", "name": "…", "chatType": "lid", "categoryName": "Client",
            "phone": "+97477 *** ** 97", "messageCount": 32,
            "firstMessageAt": 1786581874, "lastMessageAt": 1787848963 },
  "messages": [{
    "id": "cmt8r371k1qs7iis5d3ge3ecn",  // media URL-i üçün: /api/media/<id>
    "fromMe": true, "senderName": "…", "text": "…",
    "messageType": "conversation", "timestamp": 1787652821,
    "isMedia": false, "mimetype": null, "fileName": null,
    "voiceText": null                   // səs mesajının transkripti, varsa
  }],
  "hasOlder": true,
  "historyDays": 90
}
```

### `GET /api/monitor/live?instanceId=…` (SSE)
`event: ready` bir dəfə, sonra hər görünən mesaj üçün:
```jsonc
{ "instanceId": "9f4f…", "chat": "y8C…", "isGroup": false, "at": "2026-08-29T…" }
```
Gizli söhbətlərin hadisələri **axına düşmür** — nəzarətçi onların canlı
fəallığını da görməməlidir.

### `GET /api/media/<messageId>`
Şəkil/səs/sənədin baytları. Nəzarətçi üçün icazə söhbət səviyyəsindədir.

## İdarəetmə

- **Hesab və nömrələr:** `/admin/accounts` — rol `nəzarətçi`, sonra hansı
  satıcıların nömrələrini görəcəyi.
- **Görünmə qaydaları:** `/admin/monitor` — profil (tarixçə, maskalama, tip
  default-ları), kateqoriya qaydaları, söhbət-söhbət açıb-bağlama, baxış
  jurnalı və "nə gördüyünə bax" önizləməsi.

## Audit

`katibe.monitor_view_log` — kim, hansı nömrədə, hansı söhbətə, nə vaxt baxdı
(söhbət başına 5 dəqiqədə bir sətir). Önizləmə `chat:preview` kimi ayrıca
yazılır.

## Yoxlama

`npm run verify:access` — müvəqqəti nəzarətçi hesabı yaradır və real ID-lərlə
sınayır: app-in qalan hissəsi bağlıdırmı, qrup default gizlidirmi, gizlədilən
söhbət dərhal bağlanırmı, cavabda xam nömrə/JID varmı, başqa nömrənin tokeni
açılırmı.
