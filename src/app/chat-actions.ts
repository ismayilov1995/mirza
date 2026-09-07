"use server";

import { revalidatePath } from "next/cache";
import { pool } from "@/lib/db";
import { requireJid } from "@/lib/access";
import { applySuggestion, resolveSuggestion } from "@/lib/suggestions";

// Sets a JID's global label/category — keyed by remote_jid alone, not by
// instance, since the same phone number or group means the same real-world
// contact everywhere it appears. Purely a katibe.contact_labels write —
// never touches evolution_api.Chat, so it can never mark anything as read.
export async function setChatLabel(formData: FormData) {
  const jid = String(formData.get("jid") ?? "").trim();
  if (!jid) return;
  // contact_labels QƏSDƏN qlobaldır (ad hər nömrədə eynidir) — amma yazmaq
  // başqa məsələdir: heç vaxt görmədiyi söhbəti adlandırmaq icazəsi kimsəyə
  // lazım deyil, və o ad sahibin ekranında görünərdi.
  await requireJid(jid);
  // Either half is optional: a chat that already has a good WhatsApp name
  // often needs only a category.
  const displayName = String(formData.get("displayName") ?? "").trim() || null;
  const categoryIdRaw = formData.get("categoryId");
  const categoryId =
    typeof categoryIdRaw === "string" && categoryIdRaw !== "" && Number.isInteger(Number(categoryIdRaw))
      ? Number(categoryIdRaw)
      : null;

  if (displayName === null && categoryId === null) return;

  await pool.query(
    `INSERT INTO katibe.contact_labels (remote_jid, display_name, category_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (remote_jid)
     DO UPDATE SET display_name = EXCLUDED.display_name, category_id = EXCLUDED.category_id, updated_at = now()`,
    [jid, displayName, categoryId],
  );

  // The form that submits this also carries which instance page it lives
  // on, so only that page's cache gets busted.
  const instanceId = String(formData.get("instanceId") ?? "").trim();

  // A manual edit settles the question, so any pending AI proposal for this
  // chat is resolved too and won't be offered again. Edits from the shared
  // directory carry no instance, so that clears proposals from every one.
  await pool.query(
    `UPDATE katibe.chat_suggestion SET resolved_at = now(), resolution = 'ACCEPTED'
     WHERE remote_jid = $1 AND resolved_at IS NULL`,
    [jid],
  );

  if (instanceId) {
    // The naming forms live on /labels; the dashboard's stats tables show the
    // resolved names too, so both routes are stale after a write.
    revalidatePath(`/i/${instanceId}/labels`);
    revalidatePath(`/i/${instanceId}`);
  }
  // The name is global, so the directory always needs refreshing too.
  revalidatePath("/admin/contacts");
}

/** Copies the AI proposal into the real label table and marks it resolved. */
export async function acceptSuggestion(formData: FormData) {
  const instanceId = String(formData.get("instanceId") ?? "").trim();
  const jid = String(formData.get("jid") ?? "").trim();
  if (!jid) return;
  await requireJid(jid);

  // Shared with the client sweep script, so a human accept and an automatic
  // one write exactly the same label — including never replacing a name
  // WhatsApp already knows. See src/lib/suggestions.ts.
  await applySuggestion(pool, jid, "ACCEPTED");

  if (instanceId) {
    // The naming forms live on /labels; the dashboard's stats tables show the
    // resolved names too, so both routes are stale after a write.
    revalidatePath(`/i/${instanceId}/labels`);
    revalidatePath(`/i/${instanceId}`);
  }
  revalidatePath("/admin/contacts");
  revalidatePath("/admin/suggestions");
}

export async function rejectSuggestion(formData: FormData) {
  const instanceId = String(formData.get("instanceId") ?? "").trim();
  const jid = String(formData.get("jid") ?? "").trim();
  if (!jid) return;
  await requireJid(jid);
  await resolveSuggestion(pool, jid, "REJECTED");
  if (instanceId) {
    // The naming forms live on /labels; the dashboard's stats tables show the
    // resolved names too, so both routes are stale after a write.
    revalidatePath(`/i/${instanceId}/labels`);
    revalidatePath(`/i/${instanceId}`);
  }
  revalidatePath("/admin/suggestions");
}
