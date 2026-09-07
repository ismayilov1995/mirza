export type ChatType = "group" | "individual" | "lid" | "broadcast" | "unknown";

/**
 * WhatsApp JIDs carry their type in the suffix — no lookup needed:
 *   @g.us            a real group
 *   @s.whatsapp.net   an individual contact, real number visible
 *   @lid              an individual contact whose real number WhatsApp has
 *                     masked behind a "Linked ID" (a privacy feature, NOT a
 *                     group — easy to mistake for one since the id is just
 *                     as unreadable as a group's)
 *   @broadcast        a broadcast list
 */
export function classifyJid(jid: string): ChatType {
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@s.whatsapp.net")) return "individual";
  if (jid.endsWith("@lid")) return "lid";
  if (jid.endsWith("@broadcast")) return "broadcast";
  return "unknown";
}

export const CHAT_TYPE_LABELS: Record<ChatType, string> = {
  group: "👥 Qrup",
  individual: "👤 Fərdi",
  lid: "🔒 Gizli nömrə",
  broadcast: "📢 Yayım siyahısı",
  unknown: "❓ Naməlum",
};
