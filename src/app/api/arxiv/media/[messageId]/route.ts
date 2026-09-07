import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { mySources } from "@/lib/access";
import { canonicalMedia, mimeFor, openObject } from "@/lib/media-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves one canonical message's file.
 *
 * It takes a message id and nothing else. The object key is looked up here,
 * never accepted from the caller — a path parameter would turn this into an
 * open proxy into the bucket, and validating one is strictly worse than not
 * having one. That rule is inherited from /api/media/[messageId], along with
 * the decision to stream bytes rather than hand out a presigned URL, which is
 * a bucket credential with a timer on it.
 *
 * Permission comes from the message: it must belong to a conversation one of
 * the caller's sources contributes to. The archive belongs to a person, so a
 * viewer with one Evolution instance gets 404 here for somebody else's nine
 * years — the same answer they get for a message that does not exist, because
 * from outside those are the same thing.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const { messageId } = await params;
  const id = Number(messageId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Yanlış mesaj ID-si" }, { status: 400 });
  }

  const sources = await mySources();
  const media = await canonicalMedia(sources, id);
  if (!media) {
    return NextResponse.json({ error: "Tapılmadı" }, { status: 404 });
  }
  if (media.storage === "absent" || !media.objectKey) {
    // Not an error: 16,684 files in the export were never downloadable, and
    // the transcript renders a placeholder for exactly this answer.
    return NextResponse.json({ error: "Fayl yoxdur", reason: "absent" }, { status: 404 });
  }

  /*
   * AXIN, bufer yox.
   *
   * Əvvəl fayl bütövlükdə yaddaşa yığılırdı və 12 MB-dan böyüyü ümumiyyətlə
   * verilmirdi — 15,6 MB-lıq bir hesabat söhbətdə görünür, amma açılmırdı və
   * ekranda bunun səbəbi yazılmırdı. Axın həm həddi aradan qaldırır, həm də
   * eyni faylı on nəfər açanda prosesi ayaqda saxlayır.
   */
  const file = await openObject(media.objectKey);
  if (!file) {
    return NextResponse.json({ error: "Fayl oxunmadı" }, { status: 404 });
  }

  const mime = mimeFor(media);

  /*
   * KİÇİK ŞƏKİL — fayl kitabxanası üçün.
   *
   * Qalereya bir ekranda altmış şəkil göstərir. Orijinallarla bu, təxminən
   * 14 MB-dır (orta şəkil 226 KB) və hər sürüşdürmədə yenidən ödənilir.
   * 480px webp isə 20-30 KB-dır: eyni ekran yarım meqabayt. Ona görə kiçik
   * şəkil ayrıca parametrdir, avtomatik deyil — yazışma ekranı faylı olduğu
   * kimi istəyir və onu almağa davam edir.
   *
   * Yalnız ŞƏKİL kiçildilir. Video üçün kadr çıxarmaq ffmpeg istəyir və
   * qalereya onun yerinə ikon göstərir; SVG isə sharp-a verilmir, çünki içi
   * skript ola bilər və onu render etmək faylı icra etmək deməkdir.
   */
  const thumb = req.nextUrl.searchParams.get("thumb") === "1";
  if (thumb && mime.startsWith("image/") && mime !== "image/svg+xml") {
    try {
      const bytes = await streamToBuffer(file.stream);
      const small = await sharp(bytes)
        .rotate() // telefon şəkilləri EXIF ilə yan gəlir
        .resize(THUMB_EDGE, THUMB_EDGE, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      return new NextResponse(new Uint8Array(small), {
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(small.byteLength),
          "Cache-Control": "private, max-age=86400",
        },
      });
    } catch {
      /* Zədəli və ya sharp tanımayan şəkil: kiçildilməmiş halda getsin —
         qalereyada bir sətir ağır olar, amma boş qutu qalmaz. */
      const again = await openObject(media.objectKey);
      if (!again) return NextResponse.json({ error: "Fayl oxunmadı" }, { status: 404 });
      return streamed(again, mime, null);
    }
  }

  /* ?endir=1 — brauzer faylı açmaq yerinə saxlasın. Ad burada qurulur, çünki
     obyekt açarı istifadəçiyə göstərilməli deyil: içində JID var. */
  const name = req.nextUrl.searchParams.get("endir") === "1"
    ? fileName(id, media.objectKey, mime)
    : null;
  return streamed(file, mime, name);
}

/** Qalereya kartının eni 240px-ə qədərdir; 480 Retina üçün ikiqatdır. */
const THUMB_EDGE = 480;

function streamed(
  file: { stream: NodeJS.ReadableStream; size: number },
  mime: string,
  downloadName: string | null,
) {
  return new NextResponse(Readable.toWeb(Readable.from(file.stream)) as ReadableStream, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(file.size),
      // Private: a customer's file behind a session, never a shared cache.
      "Cache-Control": "private, max-age=3600",
      ...(downloadName
        ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` }
        : {}),
    },
  });
}

function fileName(id: number, objectKey: string | null, mime: string): string {
  const ext = objectKey?.split(".").pop()?.toLowerCase();
  const safe = ext && /^[a-z0-9]{1,5}$/.test(ext) ? ext : (mime.split("/")[1] ?? "bin");
  return `katibe-${id}.${safe}`;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) {
    parts.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(parts);
}
