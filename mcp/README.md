# Ismayil MCP

İsmayılın WhatsApp hesabına (`principal` instansı) **yalnız oxuma** girişi verən MCP
serveri. Claude — istər bu serverdəki Claude Code sessiyası, istər claude.ai —
söhbətləri oxuya, axtara və səhər brifinqi üçün material yığa bilər.

## Sərt qaydalar

1. **Yalnız SELECT.** Bütün alətlər Evolution API-nin öz Postgres bazasından oxuyur
   (Baileys onsuz da ora yazır). Evolution API-yə heç bir HTTP çağırışı yoxdur, yəni
   heç bir chat "oxundu" kimi işarələnmir. Bu, bütün Katibe layihəsinin qurulduğu
   şərtdir.
2. **Mesaj göndərmək yoxdur.** `sendText` və bənzəri alət ümumiyyətlə mövcud deyil.
3. **Yeganə yazma:** `update_priorities` — o da yalnız `mcp/priorities.json`
   faylına yazır, WhatsApp-a yox.
4. **İnstans arqument deyil.** Hansı hesabı oxuduğu `katibe.users` → `Ismayl` →
   aktiv `user_instances` sətri ilə bir dəfə həll olunur (`KATIBE_MCP_USER` ilə
   dəyişdirilə bilər). Model başqa bir instans id-si "təxmin edib" iş yoldaşının
   söhbətlərini oxuya bilməz.

## Alətlər

| Alət | Nə edir |
|---|---|
| `list_chats` | Verilmiş saat pəncərəsində hərəkət olan söhbətlər (jid, növ, gözləmə, son mesaj) |
| `waiting_on_me` | Cavabı bizdən gözləyənlər, ən çox gözləyən əvvəldə |
| `read_chat` | Bir söhbətin son mesajları (səsli mesajların mətni daxil) |
| `search_messages` | Bütün yazışmalarda mətn axtarışı (transkriptlər də daxil) |
| `morning_brief` | Prioritetlərə görə süzülmüş səhər materialı |
| `chat_analysis` | Katibe panelində əvvəlcədən saxlanmış AI təhlili (yeni xərc yoxdur) |
| `chat_stats` | Günlük gələn/gedən sayı, ən aktiv söhbətlər |
| `resolve_chat` | Ad/nömrə → jid (prioritet siyahısını doldurmaq üçün) |
| `get_priorities` / `update_priorities` | Konfiquru oxu / dəyiş |

Heç bir alət model çağırmır, yəni **heç bir alət pul xərcləmir**.

## Qoşulma

### Bu serverdəki Claude Code (stdio)

```bash
claude mcp add ismayil -s user -- /usr/local/bin/node /var/www/katibe-dashboard/node_modules/tsx/dist/cli.mjs /var/www/katibe-dashboard/mcp/stdio.ts
```

Bu qovluqdakı sessiyalar üçün `.mcp.json` onsuz da var — əlavə heç nə lazım deyil.

### Uzaqdan (claude.ai konnektoru, telefon, buludda işləyən tapşırıq)

- URL: `https://katibe.online/mcp`
- Başlıq: `Authorization: Bearer <token>`

Başlıq qoymağa imkan verməyən klientlər üçün token yolun içində də qəbul olunur:
`https://katibe.online/mcp/<token>`.

Token `.env.local` faylında `KATIBE_MCP_TOKEN` kimi saxlanılır; açıq nüsxəsi
`/root/.katibe-mcp-token` (yalnız root oxuya bilər). Token dəyişdirmək:
hər iki faylı yenilə, sonra `systemctl restart katibe-mcp`.

## Servis

`mcp/http.ts` systemd altında işləyir (unit `katibe-mcp`, `katibedash`
istifadəçisi, 127.0.0.1:3010, nginx `location /mcp` ilə proxy).

```bash
systemctl status katibe-mcp
journalctl -u katibe-mcp -f
```

`ProtectSystem=strict` səbəbindən yeganə yazıla bilən yol `ReadWritePaths` ilə
verilən `mcp/` qovluğudur — `priorities.json` ora düşdüyü üçün belədir.

## priorities.json

```jsonc
{
  "lookbackHours": 48,          // brief neçə saat geriyə baxsın
  "mondayLookbackHours": 72,    // bazar ertəsi həftəsonunu da tutsun
  "groupsMentionOnly": false,   // qruplarda yalnız sənə müraciət olunanlar
  "includeUntiered": true,      // siyahıda olmayanlar da cavab gözləyirsə görünsün
  "mentionAliases": ["ismayil"],// qrupda adının yazılış formaları
  "tier1": [{ "jid": "...", "note": "..." }],  // həmişə yoxlanır
  "tier2": [],                  // yalnız səni gözləyirsə
  "mute": [],                   // heç vaxt göstərilmir
  "alwaysKeywords": [],         // kim yazmasından asılı olmayaraq tutulsun
  "neverKeywords": [],          // səs-küy sayılsın
  "email": { "alwaysFrom": [], "neverFrom": [] }  // Gmail MCP üçün, eyni konfiqurda
}
```

`jid` əsasdır — adam öz WhatsApp adını dəyişə bilər, jid dəyişmir. `jid`
bilinmirsə `name` yazmaq olar: həll olunmuş adın içində axtarılır. `mute` hər
şeydən güclüdür. Siyahılar boşdursa brief işləyir, sadəcə hər kəs "səviyyəsiz"
sayılır və yalnız cavab gözləyənlər görünür.

Səviyyələri söhbətin içindən də doldurmaq olar: `resolve_chat` ilə jid tapıb
`update_priorities` çağırmaq kifayətdir.
