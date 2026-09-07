import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import {
  logMonitorView, monitorSources, mySources, requireMonitorScope,
  type ScopedSourceId,
} from "@/lib/access";
import { canonicalMedia, messageOrigin, mimeFor, openObject } from "@/lib/media-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves one canonical message's file, on either surface.
 *
 * IT TAKES A MESSAGE ID AND NOTHING ELSE. The object key is looked up here,
 * never accepted from the caller — a path parameter would turn this into an
 * open proxy into the bucket, and validating one is strictly worse than not
 * having one. Bytes are streamed rather than a presigned URL handed out, since
 * a presigned link is a bucket credential with a timer on it that outlives the
 * page which produced it.
 *
 * ON THE SUPERVISOR'S SIDE, OPENING A FILE IS RECORDED. Their screen masks
 * phone numbers and shows attachments as a button rather than a picture, so
 * reaching one is a deliberate act — and a deliberate act on somebody else's
 * conversation is the kind that should leave a trace. The log is the same one
 * that already records which chats a monitor opened.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ surface: string; messageId: string }> },
) {
  const { surface, messageId } = await params;
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Yanlış mesaj ID-si" }, { status: 400 });
  }

  let sources: ScopedSourceId[];
  let logView: (() => Promise<void>) | null = null;

  if (surface === "arxiv") {
    sources = await mySources();
  } else if (surface === "nezaret") {
    const scope = await requireMonitorScope();
    sources = await monitorSources(scope);
    logView = async () => {
      const origin = await messageOrigin(id);
      if (origin) await logMonitorView(scope, origin.instanceId, origin.remoteJid, "media");
    };
  } else {
    return NextResponse.json({ error: "Tapılmadı" }, { status: 404 });
  }

  const media = await canonicalMedia(sources, id);
  if (!media) return NextResponse.json({ error: "Tapılmadı" }, { status: 404 });
  if (media.storage === "absent" || !media.objectKey) {
    // Not an error: 16,684 files in the export were never downloadable, and
    // the transcript renders a placeholder for exactly this answer.
    return NextResponse.json({ error: "Fayl yoxdur", reason: "absent" }, { status: 404 });
  }

  /* AXIN, bufer yox — böyük fayl da açılmalıdır (bax media-store.ts). */
  const file = await openObject(media.objectKey);
  if (!file) return NextResponse.json({ error: "Fayl oxunmadı" }, { status: 404 });

  // Logged only once the file is actually being served: a 404 is not a view.
  if (logView) await logView().catch(() => { /* the log must not block the file */ });

  return new NextResponse(Readable.toWeb(Readable.from(file.stream)) as ReadableStream, {
    headers: {
      "Content-Type": mimeFor(media),
      "Content-Length": String(file.size),
      // Private: a customer's file behind a session, never a shared cache.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
