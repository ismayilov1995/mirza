import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Pool } from "pg";
import {
  loadPriorities,
  savePriorities,
  resolveOwner,
  tierOf,
  PRIORITIES_PATH,
  type Owner,
  type Priorities,
  type PriorityEntry,
} from "./config";
import { listChats, resolveChat, searchMessages, searchSemantic, dailyCounts } from "./data";
import { buildBrief } from "./brief";
import { chatLine, trim, when } from "./render";

/*
 * Ismayil MCP — read-only access to one WhatsApp account.
 *
 * Two rules hold everywhere in this file:
 *  1. Every tool reads Postgres and only Postgres. There is no write path, no
 *     send tool and no Evolution API client, so nothing here can mark a chat
 *     as read or say anything to a customer.
 *  2. The instance is resolved once, from the owner's katibe user, and is
 *     never a tool argument — otherwise the first model that guessed a
 *     different id would be reading a colleague's chats.
 */

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/**
 * Resolves a user-supplied chat reference to a single JID.
 *
 * Returns candidates instead of guessing when a name matches more than one
 * chat: two suppliers share a first name here, and silently picking one would
 * have the model reading the wrong conversation with nothing to notice it by.
 */
async function pickChat(
  owner: Owner,
  chat: string,
): Promise<{ jid: string; name: string } | { ambiguous: string }> {
  if (chat.includes("@")) {
    const hits = await resolveChat(owner.instanceId, chat, 1);
    return { jid: chat, name: hits[0]?.name ?? chat };
  }
  const hits = await resolveChat(owner.instanceId, chat, 8);
  if (hits.length === 0) return { ambiguous: `"${chat}" üçün heç bir söhbət tapılmadı.` };
  if (hits.length === 1) return { jid: hits[0].jid, name: hits[0].name };
  return {
    ambiguous:
      `"${chat}" bir neçə söhbətə uyğun gəlir — jid ilə təkrar çağır:\n` +
      hits.map((h) => `- ${h.name} [${h.jid}] · ${h.messages} mesaj`).join("\n"),
  };
}

export async function createServer(pool: Pool): Promise<McpServer> {
  const owner = await resolveOwner(pool);

  const server = new McpServer(
    { name: "ismayil", version: "1.0.0" },
    {
      instructions:
        `${owner.userName} adlı istifadəçinin WhatsApp hesabına (${owner.instanceName}, ` +
        `${owner.ownerJid ?? "?"}) YALNIZ OXUMA girişi. Bütün alətlər Evolution API-nin ` +
        `Postgres bazasından SELECT edir — heç bir chat oxunmuş kimi işarələnmir, heç bir ` +
        `mesaj göndərilmir. Səhər brifinqi üçün əvvəlcə morning_brief-i çağır; konkret ` +
        `söhbətə baxmaq üçün read_chat, adı jid-ə çevirmək üçün resolve_chat.`,
    },
  );

  server.registerTool(
    "list_chats",
    {
      title: "Söhbətləri sadala",
      description:
        "Verilmiş saat pəncərəsində hərəkət olan söhbətlər, ən yenisi əvvəldə. Hər sətirdə jid, " +
        "növ (fərdi/qrup), prioritet səviyyəsi, mesaj sayı, gözləmə müddəti və son mesajın mətni. " +
        "Prioritet siyahısını doldurmaq üçün jid-ləri buradan götür.",
      inputSchema: {
        hours: z.number().int().min(1).max(24 * 365).default(48).describe("Neçə saat geriyə baxsın"),
        type: z.enum(["all", "group", "individual"]).default("all"),
        waitingOnly: z.boolean().default(false).describe("Yalnız son mesajı qarşı tərəfdən olanlar"),
        search: z.string().default("").describe("Ad və ya jid içində axtarış"),
        limit: z.number().int().min(1).max(200).default(40),
        includeMuted: z.boolean().default(false).describe("mute siyahısındakıları da göstər"),
      },
    },
    async ({ hours, type, waitingOnly, search, limit, includeMuted }) => {
      const priorities = loadPriorities();
      const rows = await listChats(owner.instanceId, { hours, type, waitingOnly, search, limit });
      const lines: string[] = [];
      let muted = 0;
      for (const c of rows) {
        const tier = tierOf(priorities, c.jid, c.name);
        if (tier === "mute" && !includeMuted) {
          muted++;
          continue;
        }
        lines.push(chatLine(c, tier));
      }
      if (lines.length === 0) return text(`Son ${hours} saatda uyğun söhbət yoxdur.`);
      return text(
        `Son ${hours} saat — ${lines.length} söhbət` +
          (muted ? ` (${muted} susdurulmuş gizlədildi)` : "") +
          `:\n${lines.join("\n")}`,
      );
    },
  );

  server.registerTool(
    "waiting_on_me",
    {
      title: "Məni gözləyənlər",
      description:
        "Son mesajı qarşı tərəfdən gələn, yəni cavabı bizdən gözləyən söhbətlər — ən çox " +
        "gözləyən əvvəldə. Susdurulmuş (mute) söhbətlər çıxarılır.",
      inputSchema: {
        hours: z.number().int().min(1).max(24 * 90).default(48).describe("Pəncərə: neçə saatlıq hərəkət"),
        minHours: z.number().min(0).default(0).describe("Ən azı bu qədər saatdır gözləyənlər"),
        includeGroups: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(30),
      },
    },
    async ({ hours, minHours, includeGroups, limit }) => {
      const priorities = loadPriorities();
      const rows = await listChats(owner.instanceId, {
        hours,
        waitingOnly: true,
        type: includeGroups ? "all" : "individual",
        limit: 200,
      });
      const kept = rows
        .map((c) => ({ c, tier: tierOf(priorities, c.jid, c.name) }))
        .filter(({ c, tier }) => tier !== "mute" && (c.waitingHours ?? 0) >= minHours)
        .sort((a, b) => (b.c.waitingHours ?? 0) - (a.c.waitingHours ?? 0))
        .slice(0, limit);
      if (kept.length === 0) return text(`Son ${hours} saatda cavabsız qalan söhbət yoxdur.`);
      return text(
        `Cavab gözləyən ${kept.length} söhbət:\n` +
          kept.map(({ c, tier }) => chatLine(c, tier)).join("\n"),
      );
    },
  );

  server.registerTool(
    "read_chat",
    {
      title: "Söhbəti oxu",
      description:
        "Bir söhbətin son mesajları, köhnədən yeniyə. Səsli mesajların mətni (varsa) mesajın " +
        "yerində göstərilir. chat sahəsinə jid, ad və ya nömrə yazmaq olar.",
      inputSchema: {
        chat: z.string().describe("jid, ad və ya telefon nömrəsi"),
        limit: z.number().int().min(1).max(300).default(40),
      },
    },
    async ({ chat, limit }) => {
      const picked = await pickChat(owner, chat);
      if ("ambiguous" in picked) return text(picked.ambiguous);
      const { getRecentMessages } = await import("../src/lib/queries");
      const { systemScope } = await import("../src/lib/access");
      const { messages, hasMore } = await getRecentMessages(systemScope(owner.instanceId), picked.jid, limit);
      if (messages.length === 0) return text(`${picked.name} [${picked.jid}] — mesaj yoxdur.`);
      const body = messages
        .map((m) => {
          const who = m.fromMe ? "BİZ" : m.senderName ? `${m.senderName}` : "QARŞI TƏRƏF";
          const at = when(new Date(m.timestamp * 1000).toISOString());
          const what =
            m.text ??
            (m.voiceText ? `[səsli mesaj] ${m.voiceText}` : `[${m.messageType}${m.fileName ? ` ${m.fileName}` : ""}]`);
          return `${at}  ${who}: ${trim(what, 1000)}`;
        })
        .join("\n");
      return text(
        `${picked.name} [${picked.jid}] — son ${messages.length} mesaj` +
          (hasMore ? " (daha köhnəsi də var)" : "") +
          `:\n${body}`,
      );
    },
  );

  server.registerTool(
    "search_messages",
    {
      title: "Mesajlarda axtar",
      description:
        "Bütün söhbətlərdə (və ya biri daxilində) axtarış. İki cür nəticə qaytarır: sözün eynən " +
        "keçdiyi mesajlar (sifariş nömrəsi, məbləğ kimi dəqiq şeylər üçün) və mənaca yaxın " +
        "söhbət parçaları (\"gömrükdə problem\" yazanda \"yükü saxlayıblar\" da tapılır). " +
        "Səsli mesajların transkripti hər ikisinə daxildir.",
      inputSchema: {
        query: z.string().min(2).describe("Axtarılan söz və ya ifadə"),
        days: z.number().int().min(1).max(1000).default(30),
        chat: z.string().optional().describe("Yalnız bu söhbətdə (jid/ad/nömrə)"),
        limit: z.number().int().min(1).max(200).default(40),
      },
    },
    async ({ query, days, chat, limit }) => {
      let jid: string | undefined;
      if (chat) {
        const picked = await pickChat(owner, chat);
        if ("ambiguous" in picked) return text(picked.ambiguous);
        jid = picked.jid;
      }
      const hours = days * 24;
      // Both halves run regardless of how the other did: the exact pass is the
      // only one that can be trusted for an order number, and the semantic
      // pass is the only one that finds a paraphrase. Which one the caller
      // needed is not knowable from the query string.
      const [hits, similar] = await Promise.all([
        searchMessages(owner.instanceId, { query, hours, jid, limit }),
        // Degrade to exact-only rather than failing the tool: a missing
        // OPENAI_API_KEY or an embeddings outage should cost recall, not the
        // whole search. stderr, not stdout — stdout is the MCP transport.
        searchSemantic(owner.instanceId, { query, hours, jid }).catch((e) => {
          console.error("[search_messages] semantik axtarış alınmadı:", e);
          return [];
        }),
      ]);
      // A chunk that literally contains the query is the exact hit again with
      // its neighbours attached — already shown above, so drop it.
      const needle = query.toLowerCase();
      const extra = similar.filter((s) => !s.text.toLowerCase().includes(needle));
      if (hits.length === 0 && extra.length === 0) {
        return text(`"${query}" son ${days} gündə tapılmadı.`);
      }

      const parts: string[] = [];
      if (hits.length > 0) {
        parts.push(
          `"${query}" eynən keçir — ${hits.length} mesaj:\n` +
            hits
              .map(
                (h) =>
                  `- ${when(h.at)} · ${h.chatName} [${h.jid}] · ${h.fromMe ? "biz" : (h.sender ?? "onlar")}` +
                  `${h.fromVoice ? " (səsli)" : ""}\n    ${trim(h.text, 300)}`,
              )
              .join("\n"),
        );
      }
      if (extra.length > 0) {
        parts.push(
          `Mənaca yaxın — ${extra.length} söhbət parçası:\n` +
            extra
              .map(
                (s) =>
                  `- ${when(s.at)} · ${s.chatName} [${s.jid}]` +
                  `${s.grade >= 3 ? " · cavab burada" : ""}\n` +
                  `    ${trim(s.text.replace(/\n/g, " / "), 400)}`,
              )
              .join("\n"),
        );
      }
      return text(parts.join("\n\n"));
    },
  );

  server.registerTool(
    "morning_brief",
    {
      title: "Səhər brifinqi üçün material",
      description:
        "Prioritet konfiquruna görə süzülmüş material: 1-ci səviyyə (həmişə), 2-ci səviyyə " +
        "(yalnız gözləyirsə), açar sözlə tutulanlar, səviyyəsiz gözləyənlər. Susdurulmuşlar " +
        "heç vaxt daxil deyil. Bazar ertəsi avtomatik olaraq həftəsonunu da tutur.",
      inputSchema: {
        hours: z.number().int().min(1).max(24 * 30).optional().describe("Konfiqurdakı pəncərəni əvəz edir"),
        maxMessagesPerChat: z.number().int().min(1).max(50).default(6),
        maxChatsPerSection: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(12)
          .describe("Hər bölmədə ən çox neçə söhbət — qalanının sayı sonda deyilir"),
        includeUntiered: z.boolean().optional(),
        groupsMentionOnly: z.boolean().optional(),
      },
    },
    async (args) => text(await buildBrief(owner, loadPriorities(), args)),
  );

  server.registerTool(
    "chat_analysis",
    {
      title: "Saxlanmış təhlil",
      description:
        "Katibe panelində əvvəlcədən hazırlanmış AI təhlili (varsa) — yenidən model çağırmır, " +
        "pul xərcləmir. Təhlil yoxdursa, bunu deyir.",
      inputSchema: { chat: z.string().describe("jid, ad və ya nömrə") },
    },
    async ({ chat }) => {
      const picked = await pickChat(owner, chat);
      if ("ambiguous" in picked) return text(picked.ambiguous);
      const { getStoredSummary } = await import("../src/lib/summary");
      const { systemScope } = await import("../src/lib/access");
      const stored = await getStoredSummary(systemScope(owner.instanceId), picked.jid);
      if (!stored) {
        return text(
          `${picked.name} [${picked.jid}] üçün saxlanmış təhlil yoxdur. ` +
            `Katibe panelində "Təhlil et" düyməsi ilə yaradılır (model çağırışı = xərc).`,
        );
      }
      return text(
        `${picked.name} [${picked.jid}] — təhlil (${stored.model}, ${when(new Date(stored.createdAt).toISOString())}, ` +
          `${stored.messageCount} mesaj əsasında):\n` +
          JSON.stringify(stored.summary, null, 2),
      );
    },
  );

  server.registerTool(
    "chat_stats",
    {
      title: "Statistika",
      description: "Günlük gələn/gedən mesaj sayı və ən aktiv söhbətlər.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(14),
        topChats: z.number().int().min(0).max(50).default(10),
      },
    },
    async ({ days, topChats }) => {
      const [daily, top] = await Promise.all([
        dailyCounts(owner.instanceId, days),
        topChats ? listChats(owner.instanceId, { hours: days * 24, limit: topChats }) : Promise.resolve([]),
      ]);
      const busiest = [...top].sort((a, b) => b.messages - a.messages).slice(0, topChats);
      return text(
        `Son ${days} gün — gündəlik (gələn↓/gedən↑):\n` +
          daily.map((d) => `- ${d.day}: ${d.inbound}↓ / ${d.outbound}↑`).join("\n") +
          (busiest.length
            ? `\n\nƏn aktiv söhbətlər:\n` +
              busiest.map((c) => `- ${c.name} [${c.jid}] · ${c.messages} mesaj (${c.inbound}↓/${c.outbound}↑)`).join("\n")
            : ""),
      );
    },
  );

  server.registerTool(
    "resolve_chat",
    {
      title: "Adı jid-ə çevir",
      description:
        "Ad, nömrə və ya jid parçasına uyğun söhbətləri tapır — prioritet siyahısını jid ilə " +
        "doldurmaq üçün. Adlar dəyişir, jid dəyişmir.",
      inputSchema: {
        query: z.string().min(2),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, limit }) => {
      const hits = await resolveChat(owner.instanceId, query, limit);
      if (hits.length === 0) return text(`"${query}" üçün heç nə tapılmadı.`);
      const p = loadPriorities();
      return text(
        hits
          .map((h) => {
            const tier = tierOf(p, h.jid, h.name);
            return (
              `- ${h.name} [${h.jid}] · ${h.chatType}${h.phone ? ` · ${h.phone}` : ""} · ` +
              `${h.messages} mesaj · son: ${h.lastMessageAt ? when(h.lastMessageAt) : "—"}` +
              (tier !== "untiered" ? ` · ${tier}` : "")
            );
          })
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "get_priorities",
    {
      title: "Prioritet konfiqurunu göstər",
      description: "Səviyyələr, açar sözlər, e-poçt siyahıları və pəncərə ayarları.",
      inputSchema: {},
    },
    async () => text(`${PRIORITIES_PATH}:\n${JSON.stringify(loadPriorities(), null, 2)}`),
  );

  const entrySchema = z.object({
    jid: z.string().optional().describe("Sabit ünvan — mümkünsə həmişə bunu ver"),
    name: z.string().optional().describe("jid bilinmirsə: adın içində axtarılacaq söz"),
    note: z.string().optional().describe("İzah — yalnız insan üçün"),
  });

  server.registerTool(
    "update_priorities",
    {
      title: "Prioritet konfiqurunu dəyiş",
      description:
        "Söhbətləri səviyyələrə əlavə et/çıxar, açar sözləri və pəncərə ayarlarını dəyiş. " +
        "Yalnız verilən sahələr dəyişir, qalanı toxunulmur. Bu, yeganə yazma əməliyyatıdır və " +
        "yalnız yerli konfiqurasiya faylına yazır — WhatsApp-a heç nə getmir.",
      inputSchema: {
        addTier1: z.array(entrySchema).optional(),
        addTier2: z.array(entrySchema).optional(),
        addMute: z.array(entrySchema).optional(),
        remove: z.array(z.string()).optional().describe("Bu jid/adları bütün səviyyələrdən çıxar"),
        alwaysKeywords: z.array(z.string()).optional().describe("Siyahını tam əvəz edir"),
        neverKeywords: z.array(z.string()).optional().describe("Siyahını tam əvəz edir"),
        mentionAliases: z.array(z.string()).optional(),
        emailAlwaysFrom: z.array(z.string()).optional(),
        emailNeverFrom: z.array(z.string()).optional(),
        lookbackHours: z.number().int().min(1).max(24 * 30).optional(),
        mondayLookbackHours: z.number().int().min(1).max(24 * 30).nullable().optional(),
        groupsMentionOnly: z.boolean().optional(),
        includeUntiered: z.boolean().optional(),
      },
    },
    async (args) => {
      const p = loadPriorities();
      const changes: string[] = [];

      if (args.remove?.length) {
        const gone = new Set(args.remove.map((s) => s.trim().toLowerCase()));
        const strip = (list: PriorityEntry[]) =>
          list.filter(
            (e) => !gone.has((e.jid ?? "").toLowerCase()) && !gone.has((e.name ?? "").toLowerCase()),
          );
        const before = p.tier1.length + p.tier2.length + p.mute.length;
        p.tier1 = strip(p.tier1);
        p.tier2 = strip(p.tier2);
        p.mute = strip(p.mute);
        changes.push(`${before - (p.tier1.length + p.tier2.length + p.mute.length)} sətir silindi`);
      }
      const add = (list: PriorityEntry[], entries: PriorityEntry[] | undefined, label: string) => {
        if (!entries?.length) return list;
        const valid = entries.filter((e) => (e.jid ?? "").trim() || (e.name ?? "").trim());
        // A JID can only sit in one tier; re-adding it moves it rather than duplicating it.
        const keys = new Set(valid.map((e) => (e.jid ?? e.name ?? "").toLowerCase()));
        const kept = list.filter((e) => !keys.has((e.jid ?? e.name ?? "").toLowerCase()));
        changes.push(`${label}: +${valid.length}`);
        return [...kept, ...valid];
      };
      // Adding to one tier must remove from the others, or tierOf() would
      // silently keep the older, higher-priority entry.
      const addedKeys = new Set(
        [...(args.addTier1 ?? []), ...(args.addTier2 ?? []), ...(args.addMute ?? [])].map((e) =>
          (e.jid ?? e.name ?? "").toLowerCase(),
        ),
      );
      const dropAdded = (list: PriorityEntry[]) =>
        list.filter((e) => !addedKeys.has((e.jid ?? e.name ?? "").toLowerCase()));
      if (addedKeys.size) {
        p.tier1 = dropAdded(p.tier1);
        p.tier2 = dropAdded(p.tier2);
        p.mute = dropAdded(p.mute);
      }
      p.tier1 = add(p.tier1, args.addTier1, "tier1");
      p.tier2 = add(p.tier2, args.addTier2, "tier2");
      p.mute = add(p.mute, args.addMute, "mute");

      const setList = (key: "alwaysKeywords" | "neverKeywords" | "mentionAliases", v?: string[]) => {
        if (!v) return;
        p[key] = v.map((s) => s.trim()).filter(Boolean);
        changes.push(`${key}: ${p[key].length} söz`);
      };
      setList("alwaysKeywords", args.alwaysKeywords);
      setList("neverKeywords", args.neverKeywords);
      setList("mentionAliases", args.mentionAliases);
      if (args.emailAlwaysFrom) p.email.alwaysFrom = args.emailAlwaysFrom;
      if (args.emailNeverFrom) p.email.neverFrom = args.emailNeverFrom;
      if (args.lookbackHours !== undefined) p.lookbackHours = args.lookbackHours;
      if (args.mondayLookbackHours !== undefined) p.mondayLookbackHours = args.mondayLookbackHours;
      if (args.groupsMentionOnly !== undefined) p.groupsMentionOnly = args.groupsMentionOnly;
      if (args.includeUntiered !== undefined) p.includeUntiered = args.includeUntiered;

      savePriorities(p);
      return text(
        `Yazıldı: ${PRIORITIES_PATH}` +
          (changes.length ? `\n${changes.join(", ")}` : "") +
          `\n\n${JSON.stringify(p, null, 2)}`,
      );
    },
  );

  return server;
}

export type { Priorities };
