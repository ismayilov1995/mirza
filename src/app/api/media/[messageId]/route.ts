import { NextRequest, NextResponse } from "next/server";
import { getMediaRef } from "@/lib/queries";
import { fetchMediaBytes } from "@/lib/evolution";
import { getSession, logMonitorView, requireMessage, requireMonitorMessage, requireMonitorScope } from "@/lib/access";
import { getMonitorMediaRef } from "@/lib/monitor-queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves one message's file.
 *
 * Order matters, and it is the whole point of this route:
 *
 *  1. If Evolution archived the file to our S3 bucket, fetch it from there.
 *     That costs WhatsApp nothing. The presigned URL Evolution stored expires
 *     after seven days, so it is treated as "might work" — never trusted, and
 *     never handed to the browser, which would leak a bucket credential.
 *  2. Otherwise ask Evolution to decrypt it from WhatsApp. That is the
 *     expensive path — see fetchMediaBytes — so nothing calls this route
 *     automatically; the transcript renders a button and waits for a click.
 *
 * İCAZƏ. Əvvəl instans `?instanceId` sorğu parametrindən gəlirdi — yəni çağıranın
 * özünün verdiyi dəyər idi. O, icazə deyil, sadəcə axtarış açarı idi: başqasının
 * mesaj ID-si ilə həmin nömrənin faylı xam bayt kimi qaytarılırdı. İndi instans
 * MESAJIN ÖZÜNDƏN oxunur və çağıranın ona girişi yoxlanılır; parametr silinib ki,
 * bir daha icazə ilə səhv salınmasın.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params;

  /*
   * İKİ QAPI, BİR YOL.
   *
   * Adi istifadəçi üçün icazə "bu nömrəyə baxa bilirsənmi" sualıdır. Nəzarətçi
   * üçün bu kifayət etmir: gizlədilmiş qrupun şəkli də həmin nömrənin
   * instansındadır, yəni instans icazəsi ilə açılsaydı, süzgəc yalnız mətndə
   * işləyər, faylda işləməzdi — və şəkil söhbətin ən çox şey deyən hissəsidir.
   */
  const session = await getSession();
  const ref = session?.role === "monitor" ? await monitorRef(messageId) : await viewerRef(messageId);
  if (!ref) {
    return NextResponse.json({ error: "Media tapılmadı" }, { status: 404 });
  }

  const send = (bytes: Buffer, mimetype: string | null, source: string) =>
    new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": mimetype ?? "application/octet-stream",
        "Content-Length": String(bytes.byteLength),
        // Private: this is a customer's file behind a session, never a shared cache.
        "Cache-Control": "private, max-age=3600",
        "X-Media-Source": source,
        ...(ref.fileName
          ? { "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(ref.fileName)}` }
          : {}),
      },
    });

  // 1. Our own bucket.
  if (ref.storedUrl) {
    try {
      const s3 = await fetch(ref.storedUrl, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (s3.ok) {
        const bytes = Buffer.from(await s3.arrayBuffer());
        return send(bytes, s3.headers.get("content-type") ?? ref.mimetype, "s3");
      }
      // A 403 here is the expected shape of an expired signature, not a bug.
    } catch {
      // Network trouble reaching Spaces — fall through to WhatsApp.
    }
  }

  // 2. WhatsApp, on demand.
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME;
  if (!instanceName) {
    return NextResponse.json(
      { error: "EVOLUTION_INSTANCE_NAME təyin olunmayıb" },
      { status: 500 },
    );
  }
  try {
    // ref.waMessageId, not messageId: Evolution keys off WhatsApp's id.
    const { bytes, mimetype } = await fetchMediaBytes(instanceName, ref.waMessageId);
    return send(bytes, mimetype ?? ref.mimetype, "whatsapp");
  } catch {
    // Overwhelmingly the ordinary case for old media: WhatsApp's CDN drops
    // files after about three weeks and no key can bring them back. Say so
    // plainly rather than reporting a server error.
    return NextResponse.json(
      { error: "Bu fayl artıq WhatsApp-da yoxdur (təxminən 3 həftədən köhnə media silinir)." },
      { status: 410 },
    );
  }
}

interface ResolvedMedia {
  waMessageId: string;
  mimetype: string | null;
  fileName: string | null;
  storedUrl: string | null;
}

/** Adi yol: mesajın instansı tapılır və çağıranın ona icazəsi yoxlanılır. */
async function viewerRef(messageId: string): Promise<ResolvedMedia | null> {
  const owner = await requireMessage(messageId);
  if (!owner) return null;
  return getMediaRef(owner.instanceId, messageId);
}

/** Nəzarətçi yolu: söhbətin özü görünməlidir, sonra fayl verilir. */
async function monitorRef(messageId: string): Promise<ResolvedMedia | null> {
  const scope = await requireMonitorScope();
  const chat = await requireMonitorMessage(scope, messageId);
  if (!chat) return null;
  const ref = await getMonitorMediaRef(chat, messageId);
  if (ref) await logMonitorView(scope, chat.instanceId, chat.jid, "media");
  return ref;
}
