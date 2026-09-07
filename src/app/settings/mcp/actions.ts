"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/access";
import { redirect } from "next/navigation";
import { loadPriorities, savePriorities, type PriorityEntry, type Priorities } from "@mcp/config";

/*
 * Every mutation here is read-modify-write on mcp/priorities.json — the same
 * file the MCP's own update_priorities tool writes and every tool call re-reads.
 * Nothing is cached in this process: the model and this screen must never end
 * up looking at two different configs.
 */

type ListField = "tier1" | "tier2" | "mute";

const LIST_LABEL: Record<ListField, string> = {
  tier1: "1-ci səviyyə",
  tier2: "2-ci səviyyə",
  mute: "susdurulmuşlar",
};

function isList(v: string): v is ListField {
  return v === "tier1" || v === "tier2" || v === "mute";
}

/** A textarea of one-per-line values → a clean, de-duplicated list. */
function lines(formData: FormData, field: string): string[] {
  const seen = new Set<string>();
  return String(formData.get(field) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => {
      if (!l || seen.has(l.toLowerCase())) return false;
      seen.add(l.toLowerCase());
      return true;
    });
}

function str(formData: FormData, field: string): string {
  return String(formData.get(field) ?? "").trim();
}

/**
 * Where to go back to. The chat search lives in the URL, so an action that
 * dropped it would clear the results the user was working through.
 */
function back(formData: FormData, notice: string): never {
  const params = new URLSearchParams();
  const q = str(formData, "q");
  if (q) params.set("q", q);
  params.set("notice", notice);
  redirect(`/settings/mcp?${params.toString()}`);
}

function done(formData: FormData, notice: string): never {
  revalidatePath("/settings/mcp");
  back(formData, notice);
}

/** Identity of an entry: its JID, or its name when it has none. */
function keyOf(e: PriorityEntry): string {
  return e.jid?.trim() ? e.jid.trim() : `ad:${(e.name ?? "").trim().toLowerCase()}`;
}

/** Removes an entry from every list and says which ones it came out of. */
function pull(p: Priorities, key: string): ListField[] {
  const from: ListField[] = [];
  for (const list of ["tier1", "tier2", "mute"] as const) {
    const before = p[list].length;
    p[list] = p[list].filter((e) => keyOf(e) !== key);
    if (p[list].length !== before) from.push(list);
  }
  return from;
}

export async function saveBriefSettingsAction(formData: FormData) {
  await requireAdmin();
  const p = loadPriorities();
  const lookback = Number(formData.get("lookbackHours"));
  if (!Number.isInteger(lookback) || lookback < 1 || lookback > 24 * 30)
    back(formData, "Pəncərə 1–720 saat aralığında tam rəqəm olmalıdır.");
  const mondayRaw = str(formData, "mondayLookbackHours");
  const monday = mondayRaw === "" ? null : Number(mondayRaw);
  if (monday !== null && (!Number.isInteger(monday) || monday < 1 || monday > 24 * 30))
    back(formData, "Bazar ertəsi pəncərəsi 1–720 saat olmalıdır (və ya boş).");

  p.lookbackHours = lookback;
  p.mondayLookbackHours = monday;
  p.groupsMentionOnly = formData.get("groupsMentionOnly") === "on";
  p.includeUntiered = formData.get("includeUntiered") === "on";
  p.mentionAliases = lines(formData, "mentionAliases");
  savePriorities(p);
  done(formData, "Brifinq ayarları yadda saxlanıldı.");
}

export async function saveKeywordsAction(formData: FormData) {
  await requireAdmin();
  const p = loadPriorities();
  p.alwaysKeywords = lines(formData, "alwaysKeywords");
  p.neverKeywords = lines(formData, "neverKeywords");
  p.email = {
    alwaysFrom: lines(formData, "emailAlwaysFrom"),
    neverFrom: lines(formData, "emailNeverFrom"),
  };
  savePriorities(p);
  done(formData, "Açar sözlər və e-poçt siyahıları yadda saxlanıldı.");
}

/**
 * Adds a chat to a list — or moves it, when it is already in another one.
 *
 * A JID in two tiers is not a real state: tierOf() checks mute, then tier1,
 * then tier2 and takes the first hit, so the second copy would be a line the
 * user can see and edit that changes nothing.
 */
export async function addEntryAction(formData: FormData) {
  await requireAdmin();
  const list = str(formData, "list");
  if (!isList(list)) back(formData, "Səviyyə tanınmadı.");
  const jid = str(formData, "jid");
  const name = str(formData, "name");
  const note = str(formData, "note");
  if (!jid && !name) back(formData, "Ən azı jid və ya ad lazımdır.");
  if (jid && !jid.includes("@")) back(formData, `"${jid}" jid deyil — @s.whatsapp.net, @lid və ya @g.us olmalıdır.`);

  const p = loadPriorities();
  const entry: PriorityEntry = { ...(jid ? { jid } : {}), ...(name ? { name } : {}), ...(note ? { note } : {}) };
  const moved = pull(p, keyOf(entry));
  p[list].push(entry);
  savePriorities(p);
  const label = name || jid;
  done(
    formData,
    moved.length
      ? `${label} → ${LIST_LABEL[list]} (əvvəl ${moved.map((m) => LIST_LABEL[m]).join(", ")} idi).`
      : `${label} ${LIST_LABEL[list]} siyahısına əlavə olundu.`,
  );
}

export async function removeEntryAction(formData: FormData) {
  await requireAdmin();
  const list = str(formData, "list");
  if (!isList(list)) back(formData, "Səviyyə tanınmadı.");
  const key = str(formData, "key");
  const p = loadPriorities();
  const before = p[list].length;
  p[list] = p[list].filter((e) => keyOf(e) !== key);
  if (p[list].length === before) back(formData, "Sətir tapılmadı — siyahı bu arada dəyişib.");
  savePriorities(p);
  done(formData, "Sətir silindi.");
}

export async function moveEntryAction(formData: FormData) {
  await requireAdmin();
  const to = str(formData, "to");
  if (!isList(to)) back(formData, "Səviyyə tanınmadı.");
  const key = str(formData, "key");
  const p = loadPriorities();
  const entry = (["tier1", "tier2", "mute"] as const).flatMap((l) => p[l]).find((e) => keyOf(e) === key);
  if (!entry) back(formData, "Sətir tapılmadı — siyahı bu arada dəyişib.");
  pull(p, key);
  p[to].push(entry);
  savePriorities(p);
  done(formData, `${entry.name || entry.jid} → ${LIST_LABEL[to]}.`);
}

/** Name and note only. The JID is the identity — changing it is add + remove. */
export async function updateEntryAction(formData: FormData) {
  await requireAdmin();
  const list = str(formData, "list");
  if (!isList(list)) back(formData, "Səviyyə tanınmadı.");
  const key = str(formData, "key");
  const p = loadPriorities();
  const entry = p[list].find((e) => keyOf(e) === key);
  if (!entry) back(formData, "Sətir tapılmadı — siyahı bu arada dəyişib.");
  const name = str(formData, "name");
  const note = str(formData, "note");
  // A JID-less entry matches by name, so an empty name there would match every
  // chat. Refuse instead of silently writing a wildcard into the config.
  if (!entry.jid?.trim() && !name) back(formData, "Bu sətirdə jid yoxdur — ad boş qala bilməz.");
  entry.name = name || undefined;
  entry.note = note || undefined;
  savePriorities(p);
  done(formData, "Yeniləndi.");
}
