"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/access";
import { redirect } from "next/navigation";
import {
  createSlaRule,
  deleteOrRetireSlaRule,
  renameSlaRule,
  setUserSlaRule,
  updateSlaRule,
  type SlaRuleConfig,
} from "@/lib/queries";

// Admin mutations for SLA qaydaları.
//
// Redaktə heç vaxt yerində olmur: updateSlaRule() cari versiyanı bağlayıb
// yenisini açır, ona görə keçmiş ölçmələr dəyişmir. Ad isə ölçmə girişi
// deyil — onu birbaşa dəyişmək təhlükəsizdir və versiya yaratmır.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Xəta mətni qaytarır, ya da hazır konfiq. */
function parseConfig(formData: FormData): SlaRuleConfig | string {
  const timezone = String(formData.get("timezone") ?? "").trim();
  if (!timezone) return "Timezone seçilməyib.";

  const businessStart = String(formData.get("businessStart") ?? "").trim();
  const businessEnd = String(formData.get("businessEnd") ?? "").trim();
  if (!TIME_RE.test(businessStart) || !TIME_RE.test(businessEnd)) return "İş saatı HH:MM formatında olmalıdır.";
  // Gecəni aşan pəncərə "iş saatı içindədir?" sualını gün sərhədində
  // qeyri-müəyyən edərdi; bazada da CHECK var, burada isə səbəbi izah edirik.
  if (businessEnd <= businessStart) return "İş saatının sonu başlanğıcdan sonra olmalıdır.";

  const businessDays = formData
    .getAll("businessDays")
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  if (businessDays.length === 0) return "Ən azı bir iş günü seçilməlidir.";

  const targets = (["targetBusiness", "targetOffhours", "targetWeekend"] as const).map((k) =>
    Number(formData.get(`${k}Minutes`)),
  );
  if (targets.some((t) => !Number.isInteger(t) || t <= 0)) return "Hədəflər müsbət tam rəqəm olmalıdır (dəqiqə).";

  return {
    timezone,
    businessStart,
    businessEnd,
    businessDays,
    targetBusinessMinutes: targets[0],
    targetOffhoursMinutes: targets[1],
    targetWeekendMinutes: targets[2],
  };
}

function fail(message: string): never {
  redirect(`/admin/sla?notice=${encodeURIComponent(message)}`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function createSlaRuleAction(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) fail("Qaydanın adı boş ola bilməz.");
  const config = parseConfig(formData);
  if (typeof config === "string") fail(config);

  let error: string | null = null;
  try {
    await createSlaRule(name, config);
  } catch (e) {
    error = errorText(e);
  }
  if (error) fail(error);

  revalidatePath("/admin/sla");
  revalidatePath("/admin");
}

export async function updateSlaRuleAction(formData: FormData) {
  await requireAdmin();
  const ruleId = Number(formData.get("ruleId"));
  if (!Number.isInteger(ruleId)) fail("Qayda tapılmadı.");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) fail("Qaydanın adı boş ola bilməz.");
  const config = parseConfig(formData);
  if (typeof config === "string") fail(config);

  let error: string | null = null;
  let versioned = false;
  try {
    await renameSlaRule(ruleId, name);
    versioned = await updateSlaRule(ruleId, config);
  } catch (e) {
    error = errorText(e);
  }
  if (error) fail(error);

  revalidatePath("/admin/sla");
  revalidatePath("/admin");
  // Yeni versiya yarandısa bunu açıq deyirik: dəyişiklik yalnız BUNDAN SONRAKI
  // ölçmələrə təsir edir, keçmiş rəqəmlər köhnə versiya ilə qalır.
  redirect(
    `/admin/sla?notice=${encodeURIComponent(
      versioned
        ? "Yeni versiya yaradıldı — dəyişiklik yalnız bundan sonrakı mesajlara tətbiq olunur, keçmiş ölçmələr köhnə versiya ilə qalır."
        : "Konfiqurasiya eynidir, yeni versiya yaradılmadı.",
    )}`,
  );
}

export async function deleteSlaRuleAction(formData: FormData) {
  await requireAdmin();
  const ruleId = Number(formData.get("ruleId"));
  if (!Number.isInteger(ruleId)) fail("Qayda tapılmadı.");

  let error: string | null = null;
  let result: Awaited<ReturnType<typeof deleteOrRetireSlaRule>> | null = null;
  try {
    result = await deleteOrRetireSlaRule(ruleId);
  } catch (e) {
    error = errorText(e);
  }
  if (error) fail(error);

  revalidatePath("/admin/sla");
  revalidatePath("/admin");
  const notice =
    result === "blocked"
      ? "Silinmədi: qayda hazırda kiməsə təyin olunub. Əvvəlcə həmin adamlardan çıxarın."
      : result === "retired"
        ? "Qayda arxivləndi. Tam silinmədi, çünki keçmiş ölçmələr onun versiyalarını tapmalıdır."
        : "Qayda silindi (heç vaxt heç kimə təyin olunmamışdı).";
  redirect(`/admin/sla?notice=${encodeURIComponent(notice)}`);
}

export async function setUserSlaRuleAction(formData: FormData) {
  await requireAdmin();
  const userId = Number(formData.get("userId"));
  if (!Number.isInteger(userId)) return;
  const raw = String(formData.get("ruleId") ?? "");
  const ruleId = raw === "" ? null : Number(raw);
  if (ruleId !== null && !Number.isInteger(ruleId)) return;

  let error: string | null = null;
  try {
    await setUserSlaRule(userId, ruleId);
  } catch (e) {
    error = errorText(e);
  }
  if (error) fail(error);

  revalidatePath("/admin");
  revalidatePath("/admin/sla");
}
