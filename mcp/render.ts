import type { Tier } from "./config";
import type { ChatRow } from "./data";

/*
 * How a chat and a timestamp are written down.
 *
 * Shared by the tools in server.ts and by the brief in brief.ts — and, through
 * the brief, by the dashboard's /settings/mcp preview. One copy so the preview
 * cannot drift away from what Claude is actually handed.
 */

/** ISO timestamps are exact but unreadable; the brief wants both. */
export function when(iso: string): string {
  const d = new Date(iso);
  const local = d.toLocaleString("az-AZ", { timeZone: "Asia/Baku", hour12: false });
  return local;
}

export function ago(hours: number | null): string {
  if (hours === null) return "";
  if (hours < 1) return `${Math.round(hours * 60)} dəq gözləyir`;
  if (hours < 48) return `${hours.toFixed(1)} saat gözləyir`;
  return `${Math.round(hours / 24)} gün gözləyir`;
}

export function trim(s: string | null, n = 240): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  if (!one) return "—";
  return one.length > n ? one.slice(0, n) + "…" : one;
}

/**
 * @param stale the row was fetched over the wider catch-up horizon rather than
 *   the brief's own window, so its message counts describe a different span —
 *   printing them beside window-scoped rows would invite reading "794 mesaj" as
 *   traffic since yesterday.
 */
export function chatLine(c: ChatRow, tier?: Tier, stale = false): string {
  const bits = [
    `${c.name} [${c.jid}]`,
    c.chatType === "group" ? "qrup" : c.chatType === "lid" ? "gizli nömrə" : "fərdi",
    tier && tier !== "untiered" ? tier : null,
    c.category,
    stale ? null : `${c.messages} mesaj (${c.inbound}↓/${c.outbound}↑)`,
    c.waitingHours !== null ? ago(c.waitingHours) : "cavab bizdən gedib",
    `son: ${when(c.lastMessageAt)}`,
  ].filter(Boolean);
  return `- ${bits.join(" · ")}\n    ${c.lastFromThem ? "" : "biz: "}${trim(c.lastText, 180)}`;
}
