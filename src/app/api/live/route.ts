import { subscribe } from "@/lib/live-bus";
import type { LiveEvent } from "@/lib/live-bus";
import { myInstances } from "@/lib/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-Sent Events, WebSocket yox: bu app adi `next start` prosesi kimi
// işləyir və route handler HTTP upgrade sahibi ola bilmir. Dashboard yalnız
// QƏBUL edir, ona görə geri kanal onsuz da lazım deyil.
//
// src/proxy.ts bu yolu QORUYUR (matcher-dən çıxarılmayıb) — axın söhbət
// məlumatı daşıyır, deməli sessiya tələb edir.

const HEARTBEAT_MS = 20_000;

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  const url = new URL(request.url);
  // Bir instansın səhifəsindəysən, yalnız o nömrənin hadisələri gəlsin.
  const wantInstance = url.searchParams.get("instanceId");

  // İCAZƏ. Əvvəl bu parametr yalnız DARALDICI süzgəc idi: onu verməyən çağıran
  // bütün nömrələrin hadisə axınını alırdı — açıq saxlanılan bir curl bütün
  // hesabların canlı aktivlik göstəricisi olurdu. İndi axın həmişə çağıranın
  // görə bildiyi nömrələrlə məhdudlanır; parametr onun içindən seçir.
  const allowed = new Set<string>(await myInstances());
  if (wantInstance && !allowed.has(wantInstance)) {
    return new Response("forbidden", { status: 403 });
  }

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        try {
          controller.close();
        } catch {
          // Müştəri qopanda runtime onsuz da bağlayıb — ötürüləcək bir şey yoxdur.
        }
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      // Dərhal bir kadr: müştəri "qoşuldu, sakitdir" ilə "heç qoşulmadı"
      // arasında fərq qoya bilsin.
      write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

      unsubscribe = subscribe((event: LiveEvent) => {
        if (!allowed.has(event.instanceId)) return;
        if (wantInstance && event.instanceId !== wantInstance) return;
        write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // Şərh kadrları: EventSource onlara məhəl qoymur, amma nginx-in sakit
      // bağlantını kəsməsinin qarşısını alır.
      heartbeat = setInterval(() => write(`: heartbeat\n\n`), HEARTBEAT_MS);

      if (request.signal.aborted) cleanup();
      else request.signal.addEventListener("abort", cleanup);
    },

    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // katibe.online nginx arxasındadır və nginx proxy cavablarını
      // bufferləyir — bu başlıq olmasa SSE kadrları yığılıb gec çatar.
      "X-Accel-Buffering": "no",
    },
  });
}
