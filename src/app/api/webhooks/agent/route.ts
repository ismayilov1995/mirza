import { NextResponse } from "next/server";
import { requireWebhookSecret, verifyWebhookSecret, WEBHOOK_SECRET_HEADER } from "@/lib/webhook-auth";
import { publish, hasSubscribers } from "@/lib/live-bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Nəzarətçi agent (scripts/supervisor-run.ts) ayrıca prosesdir və yaddaşdakı
// live-bus-a birbaşa yaza bilməz — post yazandan sonra buraya loopback ilə
// bildirir, bura da açıq SSE axınlarına ötürür (bax /api/live).
//
// Evolution vebhuku ilə eyni qaydalar: /api/webhooks/ altındadır, deməli
// src/proxy.ts sessiya yoxlamasından kənardır və öz paylaşılan açarı ilə
// qorunur; nginx-ə AÇILMAMALIDIR.

export async function POST(request: Request) {
  let secret: string;
  try {
    secret = requireWebhookSecret();
  } catch (err) {
    console.error("[agent-webhook] refusing requests:", err);
    return NextResponse.json({ error: "webhook secret not configured" }, { status: 500 });
  }

  if (!verifyWebhookSecret(secret, request.headers.get(WEBHOOK_SECRET_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { instanceId?: unknown; count?: unknown; maxSeverity?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const instanceId = typeof body?.instanceId === "string" ? body.instanceId : null;
  if (!instanceId) return NextResponse.json({ ignored: "missing instanceId" });

  if (!hasSubscribers()) return NextResponse.json({ ok: true, listeners: 0 });

  publish({
    type: "agent_post",
    instanceId,
    count: typeof body.count === "number" ? body.count : 0,
    maxSeverity: typeof body.maxSeverity === "number" ? body.maxSeverity : 0,
    at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
