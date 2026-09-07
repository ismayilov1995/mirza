import { subscribe, type LiveEvent } from "@/lib/live-bus";
import { visibleJids } from "@/lib/access";
import { scopeFromRequest } from "@/lib/monitor-api";
import { encodeChatId } from "@/lib/monitor-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Nəzarətçi üçün canlı axın.
 *
 * /api/live-dən niyə ayrıdır: o, "bu instansda nəsə oldu" deyir və səhifəni
 * bütöv yeniləməyə çağırır. Nəzarətçi görünüşü isə açıq söhbətə mesaj ƏLAVƏ
 * edir, yəni hadisənin İÇİNDƏ söhbətin JID-i olmalıdır — və məhz ona görə
 * burada əlavə bir süzgəc var: gizli söhbətin hərəkəti heç vaxt kadr kimi
 * çıxmamalıdır. Əks halda nəzarətçi gizlətdiyimiz qrupun canlı fəallığını
 * görərdi: nə vaxt yazıldı, nə qədər yazıldı.
 */

const HEARTBEAT_MS = 20_000;

/** Görünmə qərarının nə qədər saxlanılması. Qaydalar nadir dəyişir, hadisə isə tez-tez gəlir. */
const VISIBILITY_TTL_MS = 60_000;

export async function GET(request: Request) {
  const scope = await scopeFromRequest(request);
  const url = new URL(request.url);
  const wantInstance = url.searchParams.get("instanceId");
  if (wantInstance && !scope.instances.includes(wantInstance)) {
    return new Response("forbidden", { status: 403 });
  }
  const allowed = new Set(scope.instances);

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      // JID → (görünür?, nə vaxt qərar verildi)
      const decisions = new Map<string, { visible: boolean; at: number }>();
      const pending: LiveEvent[] = [];
      let draining = false;

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
          // Müştəri qopub — runtime onsuz da bağlayıb.
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

      const emit = (event: Extract<LiveEvent, { type: "message" }>) => {
        write(
          // Kadrda da xam JID YOXDUR — səhifə açıq söhbətlə müqayisə üçün
          // eyni opaq açarı alır (deterministik token, bax monitor-token.ts).
          `event: message\ndata: ${JSON.stringify({
            instanceId: event.instanceId,
            chat: encodeChatId(event.instanceId, event.remoteJid),
            isGroup: event.isGroup,
            at: event.at,
          })}\n\n`,
        );
      };

      /*
       * Abunə funksiyası sinxrondur, görünmə yoxlaması isə bir SQL sorğusudur.
       * Ona görə qərarı olmayan hadisələr növbəyə düşür və toplu yoxlanılır —
       * eyni anda 20 söhbətə mesaj gələndə bu, 20 sorğu yox, bir sorğudur.
       */
      const drain = async () => {
        if (draining || closed) return;
        draining = true;
        try {
          while (pending.length > 0 && !closed) {
            const batch = pending.splice(0, pending.length);
            const jids = [...new Set(batch.map((e) => (e.type === "message" ? e.remoteJid : "")))].filter(
              Boolean,
            );
            const now = Date.now();
            const unknown = jids.filter((j) => {
              const d = decisions.get(j);
              return !d || now - d.at > VISIBILITY_TTL_MS;
            });
            if (unknown.length > 0) {
              const visible = await visibleJids(scope, unknown);
              for (const j of unknown) decisions.set(j, { visible: visible.has(j), at: now });
            }
            for (const event of batch) {
              if (event.type !== "message") continue;
              if (decisions.get(event.remoteJid)?.visible) emit(event);
            }
          }
        } catch (err) {
          // Bir uğursuz yoxlama axını öldürməməlidir, amma HADİSƏ DƏ
          // BURAXILMAMALIDIR: şübhə halında susmaq düzgün tərəfdir.
          console.error("[monitor/live] görünmə yoxlanıla bilmədi:", err);
        } finally {
          draining = false;
        }
      };

      write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

      unsubscribe = subscribe((event: LiveEvent) => {
        if (event.type !== "message") return;
        if (!allowed.has(event.instanceId)) return;
        if (wantInstance && event.instanceId !== wantInstance) return;

        const cached = decisions.get(event.remoteJid);
        if (cached && Date.now() - cached.at <= VISIBILITY_TTL_MS) {
          if (cached.visible) emit(event);
          return;
        }
        pending.push(event);
        void drain();
      });

      // nginx sakit bağlantını kəsməsin.
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
      "X-Accel-Buffering": "no",
    },
  });
}
