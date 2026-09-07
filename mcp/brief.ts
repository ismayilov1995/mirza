import { tierOf, PRIORITIES_PATH, type Owner, type Priorities, type Tier } from "./config";
import { listChats, windowMessages, type ChatRow } from "./data";
import { chatLine, trim, when } from "./render";

/*
 * The morning brief.
 *
 * Lives apart from server.ts because two callers want it: the `morning_brief`
 * MCP tool, and the preview on the dashboard's /settings/mcp screen. The
 * preview is only worth having if it is the same text Claude gets, which means
 * the same function and not a second rendering of the same idea.
 *
 * Priorities are passed in rather than read here: the settings screen previews
 * the config being edited, which may not be the one on disk yet.
 */

export interface BriefArgs {
  /** Overrides the configured window. */
  hours?: number;
  maxMessagesPerChat?: number;
  /** Cap per section; whatever is cut is still counted out loud. */
  maxChatsPerSection?: number;
  includeUntiered?: boolean;
  groupsMentionOnly?: boolean;
}

/** Tier-1/2 chats are pulled from this much history even when the window is shorter. */
const STALE_HORIZON_DAYS = 14;

export async function buildBrief(
  owner: Owner,
  p: Priorities,
  args: BriefArgs = {},
): Promise<string> {
  const maxMessagesPerChat = args.maxMessagesPerChat ?? 6;
  const cap = args.maxChatsPerSection ?? 12;
  const isMonday =
    new Date().toLocaleDateString("en-US", { timeZone: "Asia/Baku", weekday: "short" }) === "Mon";
  const hours = args.hours ?? (isMonday && p.mondayLookbackHours ? p.mondayLookbackHours : p.lookbackHours);
  const includeUntiered = args.includeUntiered ?? p.includeUntiered;
  const groupsMentionOnly = args.groupsMentionOnly ?? p.groupsMentionOnly;

  const [chats, msgs] = await Promise.all([
    listChats(owner.instanceId, { hours, limit: 500 }),
    windowMessages(owner.instanceId, hours, owner.ownerKeys),
  ]);
  const byJid = new Map(chats.map((c) => [c.jid, c]));
  const lower = (s: string) => s.toLowerCase();
  const always = p.alwaysKeywords.map(lower);
  const never = p.neverKeywords.map(lower);
  const aliases = p.mentionAliases.map(lower);

  interface Bucket {
    chat: ChatRow;
    tier: Tier;
    messages: { at: string; sender: string; text: string; keyword: string | null }[];
    keywordHit: boolean;
    /** Came from the catch-up horizon, not from this window — see chatLine(). */
    stale?: boolean;
  }
  const buckets = new Map<string, Bucket>();
  let mutedChats = 0;
  let noiseDropped = 0;

  for (const m of msgs) {
    if (m.fromMe) continue;
    const chat = byJid.get(m.jid);
    if (!chat) continue;
    const tier = tierOf(p, m.jid, chat.name);
    if (tier === "mute") continue;
    const body = m.text ?? `[${m.messageType}]`;
    const lc = lower(body);
    if (never.some((k) => k && lc.includes(k))) {
      noiseDropped++;
      continue;
    }
    const keyword = always.find((k) => k && lc.includes(k)) ?? null;
    // In a group, "everything" is usually noise; a mention, a reply to us,
    // or our name spelled out is what actually needs the owner.
    if (chat.chatType === "group" && groupsMentionOnly && !keyword) {
      const addressed = m.addressesUs || aliases.some((a) => a && lc.includes(a));
      if (!addressed) continue;
    }
    const b = buckets.get(m.jid) ?? { chat, tier, messages: [], keywordHit: false };
    b.messages.push({
      at: m.at,
      sender: m.sender ?? chat.name,
      text: body + (m.fromVoice ? " (səsli mesajdan)" : ""),
      keyword,
    });
    if (keyword) b.keywordHit = true;
    buckets.set(m.jid, b);
  }
  for (const c of chats) if (tierOf(p, c.jid, c.name) === "mute") mutedChats++;

  // A tier-1 or tier-2 chat that went quiet is exactly the one that must not
  // fall off the brief: their last message can predate the window and still
  // be unanswered. Those are pulled from a wider horizon and carried in with
  // no message body — the chat line already says how long it has waited.
  if (hours < STALE_HORIZON_DAYS * 24) {
    const stale = await listChats(owner.instanceId, {
      hours: STALE_HORIZON_DAYS * 24,
      waitingOnly: true,
      limit: 300,
    });
    for (const c of stale) {
      if (buckets.has(c.jid)) continue;
      const tier = tierOf(p, c.jid, c.name);
      if (tier !== "tier1" && tier !== "tier2") continue;
      buckets.set(c.jid, { chat: c, tier, messages: [], keywordHit: false, stale: true });
    }
  }

  const render = (b: Bucket) => {
    const head = chatLine(b.chat, b.tier, b.stale);
    if (b.messages.length === 0) {
      const why =
        groupsMentionOnly && b.chat.chatType === "group"
          ? "bu pəncərədə sənə birbaşa müraciət yoxdur — söhbət hələ cavabsızdır"
          : "bu pəncərədə yeni mesaj yoxdur — hələ cavabsız qalıb";
      return `${head}\n    (${why})`;
    }
    const tail = b.messages
      .slice(-maxMessagesPerChat)
      .map((m) => `    ${when(m.at)} ${m.sender}: ${trim(m.text, 300)}${m.keyword ? `  ⟵ "${m.keyword}"` : ""}`)
      .join("\n");
    return `${head}\n${tail}`;
  };

  const all = [...buckets.values()];
  // Longest-waiting first inside every section: on an unconfigured account
  // this list is the whole inbox, and the top of it must still be the part
  // that actually needs the owner.
  const byWait = (a: Bucket, b: Bucket) =>
    (b.chat.waitingHours ?? -1) - (a.chat.waitingHours ?? -1) || b.messages.length - a.messages.length;
  const tier1 = all.filter((b) => b.tier === "tier1").sort(byWait);
  const tier2 = all.filter((b) => b.tier === "tier2" && b.chat.waitingHours !== null).sort(byWait);
  const keyword = all
    .filter((b) => b.keywordHit && b.tier !== "tier1" && b.tier !== "tier2")
    .sort(byWait);
  const untiered = includeUntiered
    ? all.filter((b) => b.tier === "untiered" && b.chat.waitingHours !== null && !b.keywordHit).sort(byWait)
    : [];
  // Sections are capped so an unconfigured brief stays readable; the count
  // of what was cut is always printed, never silently dropped.
  const section = (title: string, list: Bucket[]) => {
    if (list.length === 0) return null;
    const shown = list.slice(0, cap);
    const rest = list.length - shown.length;
    return (
      `\n## ${title} (${list.length})\n${shown.map(render).join("\n")}` +
      (rest ? `\n  … və ${rest} söhbət daha (maxChatsPerSection: ${cap})` : "")
    );
  };

  const quiet = {
    tier2Quiet: all.filter((b) => b.tier === "tier2" && b.chat.waitingHours === null).length,
    untieredSkipped: all.filter((b) => b.tier === "untiered").length - untiered.length - keyword.length,
  };

  const configured = p.tier1.length + p.tier2.length + p.mute.length > 0;
  const sections = [
    `Pəncərə: son ${hours} saat${isMonday && !args.hours ? " (bazar ertəsi — həftəsonu daxil)" : ""}. ` +
      `Hesab: ${owner.userName} / ${owner.instanceName}.`,
    configured
      ? null
      : `⚠️ Prioritet siyahısı hələ boşdur (${PRIORITIES_PATH}) — hər şey "səviyyəsiz" sayılır, ` +
        `yəni yalnız cavab gözləyənlər görünür. update_priorities ilə doldur.`,
    section("1-ci səviyyə", tier1),
    section("2-ci səviyyə — səni gözləyir", tier2),
    section("Açar sözlə tutulanlar", keyword),
    section("Səviyyəsiz, cavab gözləyir", untiered),
    `\nKənarda qalanlar: ${mutedChats} susdurulmuş söhbət, ${noiseDropped} səs-küy mesajı, ` +
      `${quiet.tier2Quiet} sakit 2-ci səviyyə, ${Math.max(0, quiet.untieredSkipped)} digər söhbət.`,
  ].filter(Boolean);
  return sections.join("\n");
}
