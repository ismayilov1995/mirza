"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/access";
import { setCategoryRule, setChatRule, setMonitorProfile, type Visibility } from "@/lib/monitor";

/*
 * Nəzarətçi qaydalarını yazan yeganə yer.
 *
 * Hər action requireAdmin() ilə başlayır: server action HTTP giriş nöqtəsidir,
 * "səhifə admin panelindədir" heç nə qorumur (bax admin/accounts/actions.ts).
 */

function back(userId: number, notice: string): never {
  redirect(`/admin/monitor?user=${userId}&notice=${encodeURIComponent(notice)}`);
}

function userIdOf(formData: FormData): number {
  const id = Number(formData.get("userId"));
  if (!Number.isInteger(id) || id <= 0) redirect("/admin/monitor?notice=Yanlış+hesab");
  return id;
}

/** `default` qaydanı silir — söhbət/kateqoriya tipə görə default-a qayıdır. */
function asVisibility(value: FormDataEntryValue | null): Visibility | null {
  if (value === "allow") return "allow";
  if (value === "deny") return "deny";
  return null;
}

export async function saveProfileAction(formData: FormData) {
  const admin = await requireAdmin();
  const userId = userIdOf(formData);

  const days = Number(formData.get("historyDays"));
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    back(userId, "Tarixçə 1-3650 gün aralığında olmalıdır");
  }

  await setMonitorProfile(
    userId,
    {
      historyDays: days,
      maskPhones: formData.get("maskPhones") === "on",
      groupDefault: formData.get("groupDefault") === "visible" ? "visible" : "hidden",
      directDefault: formData.get("directDefault") === "visible" ? "visible" : "hidden",
    },
    admin.userId,
  );

  revalidatePath("/admin/monitor");
  back(userId, "Profil yadda saxlanıldı");
}

export async function setCategoryRuleAction(formData: FormData) {
  const admin = await requireAdmin();
  const userId = userIdOf(formData);
  const categoryId = Number(formData.get("categoryId"));
  if (!Number.isInteger(categoryId)) back(userId, "Yanlış kateqoriya");

  await setCategoryRule(userId, categoryId, asVisibility(formData.get("visibility")), admin.userId);
  revalidatePath("/admin/monitor");
  back(userId, "Kateqoriya qaydası yeniləndi");
}

export async function setChatRuleAction(formData: FormData) {
  const admin = await requireAdmin();
  const userId = userIdOf(formData);
  const jid = String(formData.get("jid") ?? "").trim();
  if (!jid) back(userId, "Söhbət seçilməyib");

  await setChatRule(
    userId,
    jid,
    asVisibility(formData.get("visibility")),
    String(formData.get("note") ?? ""),
    admin.userId,
  );
  revalidatePath("/admin/monitor");
  back(userId, "Söhbət qaydası yeniləndi");
}
