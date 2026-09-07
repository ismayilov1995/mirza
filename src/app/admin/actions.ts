"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/access";
import { redirect } from "next/navigation";
import { pool } from "@/lib/db";
import { createInstance, deleteInstance } from "@/lib/evolution";
import {
  dropInstanceRow,
  getInstanceDeletionFacts,
  protectedInstanceName,
  purgeInstanceFromKatibe,
  waitForInstanceRowGone,
} from "@/lib/instance-delete";

// Admin-only mutations for the taxonomy the rest of the admin model hangs
// off of. Each is additive (INSERT ... ON CONFLICT DO NOTHING) so a
// double-submit or a duplicate name never throws — it just no-ops.

export async function createBranch(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await pool.query(`INSERT INTO katibe.branches (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
  revalidatePath("/admin");
}

export async function createCategory(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await pool.query(`INSERT INTO katibe.categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
  revalidatePath("/admin");
}

// Branch/category are optional at creation time — admin can map a user to
// them later, and a bare "name" is enough to reserve the record so it can
// then be assigned an instance.
export async function createUser(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  const branchId = parseOptionalId(formData.get("branchId"));
  const categoryId = parseOptionalId(formData.get("categoryId"));
  await pool.query(`INSERT INTO katibe.users (name, branch_id, category_id) VALUES ($1, $2, $3)`, [
    name,
    branchId,
    categoryId,
  ]);
  revalidatePath("/admin");
}

function parseOptionalId(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

// user_instances 2026-08-24-dən temporal cədvəldir (assignment_history
// miqrasiyası): hər təyinat başlanğıc/bitiş tarixli ayrıca sətirdir və
// instance_id artıq unikal deyil — köhnə `ON CONFLICT (instance_id)` burada
// 42P10 ilə partlayırdı. Yenidən təyin etmək = cari sahibi indi bağlayıb yeni
// sətir açmaq; keçmiş sətirlərə toxunulmur, statistika tarixi ilə qalır.
//
// İlk dəfə təyin olunan nömrə isə miqrasiyadakı qaydayla geriyə çəkilir:
// başlanğıc o nömrədəki ən köhnə mesajın vaxtıdır, yoxsa mövcud tarixçə heç
// kimə düşməzdi. Sonrakı dəyişikliklər yalnız bu andan qüvvəyə minir (eyni
// konvensiya user_sla_rules-dadır).
export async function assignInstance(formData: FormData) {
  await requireAdmin();
  const instanceId = String(formData.get("instanceId") ?? "").trim();
  const userId = parseOptionalId(formData.get("userId"));
  if (!instanceId || !userId) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: open } = await client.query(
      `SELECT user_id FROM katibe.user_instances
       WHERE instance_id = $1 AND ended_at IS NULL`,
      [instanceId],
    );
    // Eyni adam onsuz da sahibdir — ikiqat submit heç nə dəyişmir.
    if (open.length > 0 && open[0].user_id === userId) {
      await client.query("COMMIT");
      revalidatePath("/admin");
      return;
    }

    const { rows: prior } = await client.query(
      `SELECT 1 FROM katibe.user_instances WHERE instance_id = $1 LIMIT 1`,
      [instanceId],
    );
    await client.query(
      `UPDATE katibe.user_instances SET ended_at = now()
       WHERE instance_id = $1 AND ended_at IS NULL`,
      [instanceId],
    );
    await client.query(
      prior.length > 0
        ? `INSERT INTO katibe.user_instances (instance_id, user_id, assigned_at)
           VALUES ($1, $2, now())`
        : `INSERT INTO katibe.user_instances (instance_id, user_id, assigned_at)
           VALUES ($1, $2, COALESCE(
             (SELECT to_timestamp(MIN(m."messageTimestamp"))
              FROM evolution_api."Message" m WHERE m."instanceId" = $1),
             now()))`,
      [instanceId, userId],
    );

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  revalidatePath("/admin");
}

// Silmək yox, bağlamaq: DELETE bütün təyinat tarixçəsini aparardı və köhnə
// mesajlar sahibsiz qalardı. ended_at dolur, sətir tarix kimi qalır.
export async function unassignInstance(formData: FormData) {
  await requireAdmin();
  const instanceId = String(formData.get("instanceId") ?? "").trim();
  if (!instanceId) return;
  await pool.query(
    `UPDATE katibe.user_instances SET ended_at = now()
     WHERE instance_id = $1 AND ended_at IS NULL`,
    [instanceId],
  );
  revalidatePath("/admin");
}

/**
 * Creates a new Evolution instance and sends the admin to its pairing page.
 *
 * The instance is created with SAFE_INSTANCE_SETTINGS, so a newly connected
 * phone can never have its chats marked as read by Katibe.
 */
export async function createInstanceAction(formData: FormData) {
  await requireAdmin();
  const raw = String(formData.get("name") ?? "").trim();
  // Evolution uses the name in URLs and as a unique key; keep it simple.
  const name = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  if (!name) return;

  await createInstance(name);
  revalidatePath("/admin");
  redirect(`/admin/instance/${encodeURIComponent(name)}`);
}

/**
 * Nömrəni sistemdən çıxarır: Evolution instansı və `katibe.*`-dakı izləri.
 *
 * Bütün qərar burada verilir, təsdiq səhifəsində yox — səhifə yalnız rəqəmləri
 * göstərir. Səbəb adi qayda: brauzerdən gələn forma nə göstərildiyini yox, nə
 * göndərildiyini bildirir, ona görə şərtlər (ad üst-üstə düşürmü, tarixçə
 * varmı, qorunan instansdırmı) serverdə yenidən oxunur.
 *
 * Sıra da qəsdəndir: əvvəl Evolution, sonra `katibe.*`. Tərsi olsaydı və
 * Evolution çağırışı uğursuz olsaydı, işləyən nömrənin təyinat tarixçəsi
 * silinmiş, nömrənin özü isə yerində qalmış olardı — geri qaytarıla bilməyən
 * yarımçıq hal. Bu sıra ilə yarımçıq hal yalnız «Evolution getdi, qalıq
 * sətirlər qaldı» ola bilər və onu mesaj açıq deyir.
 */
export async function deleteInstanceAction(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const confirm = String(formData.get("confirm") ?? "").trim();
  const withHistory = formData.get("withHistory") === "on";
  if (!name) return;

  const back = (message: string) =>
    redirect(`/admin/instance/${encodeURIComponent(name)}/sil?xeta=${encodeURIComponent(message)}`);

  const facts = await getInstanceDeletionFacts(name);
  if (!facts) redirect(`/admin?xeta=${encodeURIComponent(`«${name}» adlı nömrə yoxdur.`)}`);

  if (facts.name === protectedInstanceName()) {
    back(
      `«${facts.name}» panelin öz nömrəsidir (EVOLUTION_INSTANCE_NAME) — media və səs ` +
        `endirmə onun üzərindən gedir. Silmək üçün əvvəlcə həmin ayar başqa nömrəyə keçirilməlidir.`,
    );
  }

  if (confirm !== facts.name) {
    back("Təsdiq üçün nömrənin adı eynilə yazılmalıdır.");
  }

  const history = facts.messages + facts.mirroredMessages;
  if (history > 0 && !withHistory) {
    back(`Bu nömrədə ${history.toLocaleString("az-AZ")} mesaj var — tarixçə qutusu işarələnməyib.`);
  }

  let outcome: "deleted" | "missing";
  try {
    outcome = await deleteInstance(facts.name);
  } catch (error) {
    back(`Evolution silə bilmədi: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  if (outcome === "missing") {
    await dropInstanceRow(facts.id);
  } else {
    await waitForInstanceRowGone(facts.id);
  }

  const purged = await purgeInstanceFromKatibe(facts.id);

  revalidatePath("/admin");
  revalidatePath("/");
  redirect(
    `/admin?silindi=${encodeURIComponent(facts.name)}` +
      `&mesaj=${purged.mirrorMessages}&sohbet=${purged.mirrorChats}&setir=${purged.katibeRows}`,
  );
}
