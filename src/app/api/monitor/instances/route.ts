import { NextResponse } from "next/server";
import { getMonitorInstances } from "@/lib/monitor-queries";
import { scopeFromRequest, NO_STORE } from "@/lib/monitor-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Nəzarətçinin baxa bildiyi satıcılar (WhatsApp nömrələri).
 *
 * Siyahı açıq təyinatlardan gəlir — nəzarətçiyə "hamısı" deyə bir şey yoxdur:
 * ona hansı nömrələr verilibsə, yalnız onlar.
 */
export async function GET(request: Request) {
  const scope = await scopeFromRequest(request);
  const instances = await getMonitorInstances(scope);
  return NextResponse.json(
    {
      viewer: {
        username: scope.monitorUsername,
        preview: scope.preview,
        historyDays: scope.profile.historyDays,
        maskPhones: scope.profile.maskPhones,
      },
      instances,
    },
    { headers: NO_STORE },
  );
}
