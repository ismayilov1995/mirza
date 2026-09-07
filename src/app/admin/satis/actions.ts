"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/access";
import { isoWeekRange, writeSnapshot } from "@/lib/sales-history";
import { buildCandidates, generateInsights, storeInsights } from "@/lib/sales-insight";
import { readSnapshots } from "@/lib/sales-history";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Faktları əl ilə yenilə.
 *
 * Cron həftədə bir işləyir; bu düymə eyni işi indi görür. İcazə burada da
 * yoxlanılır — server action ayrı giriş nöqtəsidir və səhifənin
 * requireAdmin()-i onu qorumur (src/lib/access.ts-in başındakı qeyd).
 */
export async function refreshInsightsAction(): Promise<void> {
  await requireAdmin();

  const cur = isoWeekRange(1);
  const prev = isoWeekRange(2);
  await writeSnapshot(prev.start, prev.end);
  await writeSnapshot(cur.start, cur.end);

  const snapshots = await readSnapshots(12);
  const current = snapshots.filter((s) => s.periodStart === ymd(cur.start));
  const previous = snapshots.filter((s) => s.periodStart === ymd(prev.start));
  if (current.length === 0) return;

  const { chosen } = await generateInsights(buildCandidates(current, previous));
  await storeInsights(ymd(cur.start), ymd(cur.end), chosen);
  revalidatePath("/admin/satis");
}
