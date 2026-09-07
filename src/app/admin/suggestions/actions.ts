"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/access";
import { pool } from "@/lib/db";
import { applySuggestion, resolveSuggestion, revertAutoLabel } from "@/lib/suggestions";
import { getClientCategoryId, getPendingSuggestions, type SuggestionFilter } from "@/lib/queries";

// Bulk review of the client sweep's leftovers. There are hundreds of numbers
// to get through, so every action here works on a set: the rows ticked on the
// page, or — with `all` — everything the current filter matches, including the
// rows further down than the page shows.

function readFilter(formData: FormData): SuggestionFilter {
  const raw = String(formData.get("filter") ?? "all");
  return raw === "client" || raw === "other" ? raw : "all";
}

/**
 * The JIDs an action applies to: the ticked checkboxes, or the whole filtered
 * queue when the "all" button was used.
 */
async function targetJids(formData: FormData): Promise<string[]> {
  if (String(formData.get("all") ?? "") === "1") {
    const pending = await getPendingSuggestions(readFilter(formData), 5000);
    return pending.map((p) => p.jid);
  }
  return formData
    .getAll("jid")
    .map((v) => String(v).trim())
    .filter(Boolean);
}

export async function acceptSelectedSuggestions(formData: FormData) {
  await requireAdmin();
  for (const jid of await targetJids(formData)) {
    await applySuggestion(pool, jid, "ACCEPTED");
  }
  revalidateReview();
}

export async function rejectSelectedSuggestions(formData: FormData) {
  await requireAdmin();
  for (const jid of await targetJids(formData)) {
    await resolveSuggestion(pool, jid, "REJECTED");
  }
  revalidateReview();
}

/** Takes back one label the sweep applied without asking. */
export async function revertAutoLabelAction(formData: FormData) {
  await requireAdmin();
  const jid = String(formData.get("jid") ?? "").trim();
  if (!jid) return;
  await revertAutoLabel(pool, jid);
  revalidateReview();
}

function revalidateReview() {
  revalidatePath("/admin/suggestions");
  // Labels are global, so the directory and the admin overview both move.
  revalidatePath("/admin/contacts");
  revalidatePath("/admin");
}

/**
 * Marks one number a client outright, whatever the model proposed.
 *
 * The sweep is right about "is this a client?" more often than about which
 * non-client bucket someone belongs in, so the fastest correction on this
 * page is promoting a row to Client in one click rather than accepting a
 * wrong category and fixing it in the directory afterwards.
 *
 * The jid is bound into the action rather than read out of the form. It used
 * to ride on the button as a name/value pair and never arrived: the button
 * sits in the bulk form and carries its own formAction, and React leaves a
 * submitter's name/value out of the FormData exactly then. Every click did
 * nothing but pay for a re-render.
 */
export async function labelAsClient(jid: string) {
  await requireAdmin();
  if (!jid) return;
  const clientId = await getClientCategoryId();
  if (clientId === null) return;

  // The proposed name is still worth keeping — only the category was wrong —
  // but never over a name WhatsApp itself knows.
  await pool.query(
    `INSERT INTO katibe.contact_labels (remote_jid, display_name, category_id)
     SELECT s.remote_jid,
            CASE WHEN EXISTS (SELECT 1 FROM evolution_api."Contact" ct
                               WHERE ct."remoteJid" = s.remote_jid AND ct."pushName" IS NOT NULL)
                 THEN NULL ELSE s.suggested_name END,
            $2
     FROM katibe.chat_suggestion s
     WHERE s.remote_jid = $1
     ON CONFLICT (remote_jid) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, katibe.contact_labels.display_name),
       category_id = EXCLUDED.category_id,
       updated_at = now()`,
    [jid, clientId],
  );
  await resolveSuggestion(pool, jid, "ACCEPTED");
  revalidateReview();
}
