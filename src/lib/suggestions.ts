/**
 * Turning an AI proposal into a real label.
 *
 * Shared on purpose: the admin's "accept" button and the client sweep script
 * (scripts/identify-clients.ts, which runs outside Next.js with its own pool)
 * must agree on exactly what accepting means — above all on not overwriting a
 * name WhatsApp already knows. Keeping one implementation is why this takes a
 * `Queryable` instead of importing the shared pool.
 */

/** The bit of `pg` both callers have — the app's pool, or the script's own. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export type Resolution = "ACCEPTED" | "REJECTED" | "AUTO";

/**
 * The name WhatsApp itself has for a JID, looked up across every account:
 * the live group subject, then any account's Chat.name, then any account's
 * Contact.pushName. Any of them counts, since one account knowing the real
 * name is reason enough not to replace it with the model's description.
 */
const EXISTING_NAME_SQL = `
  COALESCE(
    gs.subject,
    (SELECT c.name FROM evolution_api."Chat" c
      WHERE c."remoteJid" = s.remote_jid AND c.name IS NOT NULL LIMIT 1),
    (SELECT ct."pushName" FROM evolution_api."Contact" ct
      WHERE ct."remoteJid" = s.remote_jid AND ct."pushName" IS NOT NULL LIMIT 1)
  )`;

/**
 * Copies one pending suggestion into katibe.contact_labels and resolves it.
 *
 * `resolution` records who decided: ACCEPTED for a human click, AUTO for a
 * HIGH-confidence proposal the sweep applied on its own. An AUTO apply backs
 * off if the JID already carries a category, so it can never talk over a
 * human decision that landed in between.
 *
 * @returns true if a label was written, false if there was nothing pending
 *          (or an AUTO apply stepped aside).
 */
export async function applySuggestion(
  db: Queryable,
  jid: string,
  resolution: "ACCEPTED" | "AUTO" = "ACCEPTED",
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT s.suggested_name, s.suggested_category_id,
            ${EXISTING_NAME_SQL} AS existing_name,
            (SELECT cl.category_id FROM katibe.contact_labels cl
              WHERE cl.remote_jid = s.remote_jid) AS current_category_id
     FROM katibe.chat_suggestion s
     LEFT JOIN katibe.group_subject gs ON gs.remote_jid = s.remote_jid
     WHERE s.remote_jid = $1 AND s.resolved_at IS NULL`,
    [jid],
  );
  if (rows.length === 0) return false;

  const row = rows[0];
  if (resolution === "AUTO" && row.current_category_id !== null) {
    // A human got here first. Leave their label alone and drop the proposal.
    await resolveSuggestion(db, jid, "REJECTED");
    return false;
  }

  // Only name a chat that has no name of its own — losing a real group
  // subject or contact name in favour of the model's description of the
  // conversation is a downgrade, not a fix.
  const name = row.existing_name ? null : row.suggested_name;

  // One upsert either way: a null name leaves display_name alone, so a
  // category-only accept never blanks an existing label.
  await db.query(
    `INSERT INTO katibe.contact_labels (remote_jid, display_name, category_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (remote_jid) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, katibe.contact_labels.display_name),
       category_id = EXCLUDED.category_id,
       updated_at = now()`,
    [jid, name, row.suggested_category_id],
  );

  await resolveSuggestion(db, jid, resolution);
  return true;
}

/** Marks a proposal decided so the next sweep doesn't offer it again. */
export async function resolveSuggestion(db: Queryable, jid: string, resolution: Resolution) {
  await db.query(
    `UPDATE katibe.chat_suggestion SET resolved_at = now(), resolution = $2
     WHERE remote_jid = $1`,
    [jid, resolution],
  );
}

/**
 * Undoes an auto-applied label: removes the label the sweep wrote and marks
 * the proposal REJECTED so it isn't proposed again.
 *
 * Only ever touches rows resolved as AUTO — a label a human accepted or typed
 * is not the sweep's to take back.
 */
export async function revertAutoLabel(db: Queryable, jid: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM katibe.chat_suggestion WHERE remote_jid = $1 AND resolution = 'AUTO'`,
    [jid],
  );
  if (rows.length === 0) return false;

  await db.query(`DELETE FROM katibe.contact_labels WHERE remote_jid = $1`, [jid]);
  await db.query(
    `UPDATE katibe.chat_suggestion SET resolution = 'REJECTED', resolved_at = now()
     WHERE remote_jid = $1`,
    [jid],
  );
  return true;
}
