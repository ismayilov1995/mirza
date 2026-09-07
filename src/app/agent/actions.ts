"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/access";
import { getRunState } from "@/lib/supervisor/feed";
import { runSupervisor } from "@/lib/supervisor/run";

/**
 * Nəzarətçini əl ilə işə salır — cron-un növbəti saatını gözləmədən.
 *
 * Gedişat FON rejimindədir, qəsdən: bir yoxlama 1–2 dəqiqə çəkir, nginx isə
 * cavabı 60 saniyədən sonra kəsir. Ona görə action gedişatı başladıb geri
 * qayıdır, səhifə isə vəziyyəti agent_runs-dan oxuyur.
 *
 * Eyni anda iki gedişatın qarşısını bura yox, baza alır: runSupervisor pg
 * advisory lock götürür və tutulmasa dərhal çıxır. Kilid klaster səviyyəsində
 * olduğu üçün cron gedişatı ilə də toqquşmur.
 *
 * Bu düymə Anthropic API-yə pul xərcləyir (keçən gedişatların qiyməti
 * düymənin yanında yazılır), ona görə yalnız admin.
 */
export async function runSupervisorNow() {
  await requireAdmin();

  const run = runSupervisor({ trigger: "manual", dryRun: false, maxLlmCalls: 6, maxVerifyCalls: 6 }).catch((err) => {
    console.error("[supervisor] əl ilə gedişat uğursuz:", err);
    return null;
  });

  // Sətir bazada görünənə qədər gözlə: gedişat işə düşməmiş səhifə yenilənsə,
  // düymə yenidən "boş" görünər və adam ikinci dəfə basar.
  await Promise.race([
    run,
    (async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 150));
        if ((await getRunState()).running) return;
      }
    })(),
  ]);

  revalidatePath("/agent");
  revalidatePath("/");
}
