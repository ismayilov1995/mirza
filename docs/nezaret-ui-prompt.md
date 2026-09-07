# Nəzarət ekranı üçün UI promptu (Claude Design)

Aşağıdakı mətn olduğu kimi Claude Design-a verilə bilər. Backend hazırdır və
API müqaviləsi sabitdir (`docs/nezaret-ekrani.md`) — dizayn yalnız görünüşü
dəyişməlidir, sorğuları yox.

---

## Prompt

Bir daxili alət üçün **yalnız-oxu WhatsApp nəzarət ekranı** dizayn et.

**Kim işlədir.** Şirkətin daxili nəzarətçisi. İşi: satış işçilərinin (qızların)
müştərilərlə yazışmasını oxumaq və cavab keyfiyyətini qiymətləndirmək. Texniki
adam deyil, gün ərzində saatlarla bu ekranda qalır. Dil: **Azərbaycan dili**.

**Ən vacib prinsip: bu ekran WhatsApp Web deyil, ona OXŞAYIR.** Mesaj yazmaq,
göndərmək, reaksiya vermək, "oxundu" etmək — heç biri yoxdur və olmamalıdır.
İstifadəçi bunu ilk baxışdan hiss etməlidir: mesaj yazma sahəsinin olmaması
təsadüf yox, qərar kimi görünsün.

### Quruluş

Üç sütun, masaüstü üçün:

1. **Satıcılar** (sol, ~220px) — nəzarətçiyə açılmış WhatsApp nömrələri.
   Hər sətir: satıcının adı, ona görünən söhbət sayı, cavab gözləyən söhbət
   sayı, qoşulma vəziyyəti (yaşıl/qırmızı nöqtə).
2. **Söhbətlər** (orta, ~320px) — seçilmiş satıcının söhbətləri, son mesaja
   görə sıralanmış. Yuxarıda axtarış sahəsi və canlı yayım göstəricisi.
   Hər sətir: ad, son mesajın vaxtı, son mesajın önbaxışı (öz mesajımızdırsa
   ↩ işarəsi), "gözləyir" nişanı, qrupdursa qrup ikonu.
3. **Yazışma** (sağ, qalan yer) — başlıq (ad, kateqoriya, maskalanmış nömrə,
   mesaj sayı), mesaj baloncukları, yuxarıda "Daha köhnə" düyməsi, altda
   yalnız-oxu xatırlatması.

Mobil/dar ekranda üç səviyyəli naviqasiya (satıcı → söhbət → yazışma) uyğundur.

### Vacib davranışlar

- **Canlı.** Yeni mesaj gələndə açıq yazışmanın SONUNA əlavə olunur, səhifə
  yenilənmir və sürüşmə yerindən tərpənmir. Söhbət siyahısı 4 saniyədən bir
  yenilənir. Yayımın vəziyyəti görünür: `canlı` / `qoşulur…` / `kəsilib`.
- **Maskalanmış nömrələr.** Adlar `Leyla · +99450 *** ** 02` formasında gəlir,
  mesaj mətnindəki nömrələr də maskalanmış olur. Dizayn bunu gizlətməməlidir —
  əksinə, nəzarətçi bilməlidir ki, nömrələr qəsdən bağlıdır.
- **Gizli söhbətlər sadəcə YOXDUR.** "3 gizli söhbət" kimi göstəricilər olmasın:
  gizlədilmiş qrupun varlığı da məlumatdır.
- **Cavab gözləyən** söhbətlər (son söz müştərinindir) siyahıda seçilsin —
  nəzarətçinin ilk baxdığı şey budur.
- **Boş hallar:** nömrə təyin olunmayıb; söhbət seçilməyib; görünən söhbət
  yoxdur; axtarış nəticəsizdir. Hər biri bir cümlə ilə izah olunsun.

### Mesaj baloncuqları

- Satıcının mesajı sağda, müştərininki solda.
- Qrup söhbətində göndərənin adı baloncuğun üstündə.
- Media (şəkil/video/səs/sənəd) açılan bağlantı kimi göstərilir; səs mesajının
  mətn transkripti varsa baloncuğun altında kursivlə əlavə olunur.
- Vaxt kiçik və sakit, mətnin altında sağda.
- Uzun mətn (bəzi mesajlar 1000+ simvol olur) və `\n` sətir keçidləri düzgün
  görünməlidir.

### Vizual dil

- Tünd tema. Mövcud dəyişənlər: `--bg #0b0d0f`, `--surface #14171a`,
  `--surface-2 #1b1f23`, `--border #262b30`, `--fg #eef1f3`, `--muted #8b949c`,
  `--accent #35d07f` (WhatsApp yaşılı ilə eyni ailə), `--accent-2 #5b8def`,
  `--warn #e8a13a`, `--danger #f2555a`.
- Sıx, informativ, "iş aləti" hissi — marketinq səhifəsi yox. Saatlarla
  baxılacaq, ona görə kontrast rahat, boşluqlar ölçülü olsun.
- Azərbaycan dilində etiketlər: `Söhbətlər`, `Gözləyir`, `Daha köhnə`,
  `Yalnız oxu`, `Canlı`.

### Məlumat mənbəyi (dəyişməməlidir)

```
GET /api/monitor/instances
  → { viewer: {username, historyDays, maskPhones}, instances: [
        {instanceId, instanceName, ownerName, connectionStatus, visibleChats, awaiting, lastActivityAt} ] }

GET /api/monitor/chats?instanceId=&q=&before=&limit=
  → { chats: [{chat, name, chatType, categoryName, lastMessageText,
               lastMessageType, lastMessageFromMe, lastMessageAt, awaiting}], nextCursor }

GET /api/monitor/messages?instanceId=&chat=<açar>[&before=<ts>|&after=<ts>]
  → { chat: {chat, name, chatType, categoryName, phone, messageCount,
             firstMessageAt, lastMessageAt},
      messages: [{id, fromMe, senderName, text, messageType, timestamp,
                  isMedia, mimetype, fileName, voiceText}],
      hasOlder, historyDays }

GET /api/monitor/live?instanceId=   (SSE)
  → event: message → {instanceId, chat, isGroup, at}

GET /api/media/<message.id>          media faylı
```

`chat` sahəsi söhbətin opaq açarıdır — həqiqi WhatsApp identifikatoru heç vaxt
brauzerə gəlmir. Vaxtlar epoch **saniyə**dir. Saat qurşağı: `Asia/Baku`.

### Verilməməli olanlar

Mesaj yazma sahəsi, göndər düyməsi, "sil/redaktə et", "oxundu" nişanları,
telefon nömrəsini kopyalama düyməsi, xam identifikator göstərən sahələr.
