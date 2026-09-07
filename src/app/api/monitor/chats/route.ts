import { NextResponse } from "next/server";
import { logMonitorView } from "@/lib/access";
import { getMonitorChats, MONITOR_CHAT_PAGE } from "@/lib/monitor-queries";
import { intParam, scopeFromRequest, NO_STORE } from "@/lib/monitor-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bir satıcının söhbət siyahısı — sol sütun.
 *
 * `before` son mesaj vaxtıdır (kursor), `q` isə ad üzrə axtarışdır. Gizli
 * söhbətlər burada YOX-dur: sayı da, adı da, izi də görünmür.
 */
export async function GET(request: Request) {
  const scope = await scopeFromRequest(request);
  const url = new URL(request.url);
  const instanceId = url.searchParams.get("instanceId") ?? "";

  // İnstans icazəsi: siyahı sorğusunun öz qapısı budur (söhbət səviyyəsindəki
  // qapı requireVisibleChat-dədır və o, mesaj route-unda çağırılır).
  if (!scope.instances.includes(instanceId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }

  const limit = intParam(url, "limit");

  const result = await getMonitorChats(scope, instanceId, {
    search: url.searchParams.get("q") ?? "",
    before: intParam(url, "before"),
    limit: limit === null ? MONITOR_CHAT_PAGE : Math.min(100, Math.max(10, limit)),
  });

  await logMonitorView(scope, instanceId, null, "list");
  return NextResponse.json(result, { headers: NO_STORE });
}
