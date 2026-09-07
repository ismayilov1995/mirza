"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/access";
import { passwordProblem } from "@/lib/password";
import {
  createAccount,
  setActive,
  setInstanceGrants,
  setInstancePrivate,
  setPassword,
  setRole,
} from "@/lib/accounts";
import type { Role } from "@/lib/access";

// Hər action requireAdmin() ilə başlayır. Server action-lar HTTP endpoint-dir:
// sessiyası olan hər kəs onları ixtiyari arqumentlə çağıra bilir, ona görə
// "səhifə admin panelindədir" heç nə qorumur.

function asRole(value: FormDataEntryValue | null): Role {
  // Bilinməyən dəyər ən az səlahiyyətliyə düşür — form-dan nə gəlsə də,
  // "admin" yalnız açıq seçimlə alınır.
  if (value === "admin") return "admin";
  if (value === "monitor") return "monitor";
  return "viewer";
}

function back(notice: string): never {
  redirect(`/admin/accounts?notice=${encodeURIComponent(notice)}`);
}

export async function createAccountAction(formData: FormData) {
  const admin = await requireAdmin();
  const username = String(formData.get("username") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = asRole(formData.get("role"));

  if (!username) back("İstifadəçi adı boş ola bilməz");
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
    back("İstifadəçi adı 3-40 simvol: hərf, rəqəm, nöqtə, alt xətt, defis");
  }
  const problem = passwordProblem(password);
  if (problem) back(problem);

  try {
    await createAccount({
      username,
      email: email || null,
      password,
      role,
      // Admin parolu özü qoyduğuna görə istifadəçi onu bilir — ilk girişdə
      // dəyişməyə məcburdur.
      mustChangePassword: true,
      createdBy: admin.userId,
    });
  } catch {
    back("Bu istifadəçi adı və ya e-poçt artıq mövcuddur");
  }
  revalidatePath("/admin/accounts");
  back("Hesab yaradıldı");
}

export async function setPasswordAction(formData: FormData) {
  await requireAdmin();
  const userId = Number(formData.get("userId"));
  const password = String(formData.get("password") ?? "");
  if (!Number.isInteger(userId)) return;
  const problem = passwordProblem(password);
  if (problem) back(problem);

  await setPassword(userId, password, true);
  revalidatePath("/admin/accounts");
  back("Parol dəyişdirildi, bütün açıq sessiyalar bağlandı");
}

export async function setActiveAction(formData: FormData) {
  await requireAdmin();
  const userId = Number(formData.get("userId"));
  const active = formData.get("active") === "1";
  if (!Number.isInteger(userId)) return;

  const error = await setActive(userId, active);
  revalidatePath("/admin/accounts");
  back(error ?? (active ? "Hesab aktivləşdirildi" : "Hesab söndürüldü"));
}

export async function setRoleAction(formData: FormData) {
  await requireAdmin();
  const userId = Number(formData.get("userId"));
  if (!Number.isInteger(userId)) return;

  const error = await setRole(userId, asRole(formData.get("role")));
  revalidatePath("/admin/accounts");
  back(error ?? "Rol dəyişdirildi");
}

export async function setGrantsAction(formData: FormData) {
  const admin = await requireAdmin();
  const userId = Number(formData.get("userId"));
  if (!Number.isInteger(userId)) return;

  const instanceIds = formData.getAll("instanceId").map((v) => String(v));
  await setInstanceGrants(userId, instanceIds, admin.userId);
  revalidatePath("/admin/accounts");
  back("Nömrə icazələri yeniləndi");
}

export async function setInstancePrivateAction(formData: FormData) {
  await requireAdmin();
  const instanceId = String(formData.get("instanceId") ?? "").trim();
  const isPrivate = formData.get("private") === "1";
  if (!instanceId) return;

  await setInstancePrivate(instanceId, isPrivate);
  revalidatePath("/admin/accounts");
  back(isPrivate ? "Nömrə privat edildi" : "Nömrə privatlıqdan çıxarıldı");
}

/** Öz parolunu dəyişmək — məcburi dəyişmə axını da bunu işlədir. */
export async function changeOwnPasswordAction(formData: FormData) {
  const { requireSession } = await import("@/lib/access");
  const session = await requireSession();
  const password = String(formData.get("password") ?? "");
  const problem = passwordProblem(password);
  if (problem) redirect(`/parol?notice=${encodeURIComponent(problem)}`);

  // Öz parolunu dəyişmək də bütün sessiyaları öldürür — istifadəçi yenidən
  // giriş edir, digər cihazlardakı açıq sessiyalar bağlanır.
  await setPassword(session.userId, password, false);
  redirect("/login");
}
