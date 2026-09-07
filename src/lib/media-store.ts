import { Client } from "minio";
import { pool } from "./db";
import type { ScopedSourceId } from "./access";

/*
 * Serving files that belong to canonical messages.
 *
 * TWO PREFIXES, ONE RESOLVER. The bytes live in Spaces under two layouts —
 * Evolution's own archiving, and the phone export under archive/<source>/ —
 * and katibe.media records which, so nothing above this file has to know the
 * difference. 249,499 objects and 75.57 GB is why they were never copied onto
 * a host with 43 GB free.
 *
 * BYTES, NOT A PRESIGNED URL, following the decision already made in
 * src/app/api/media/[messageId]/route.ts: a presigned link handed to the
 * browser is a bucket credential with a timer on it, and it outlives the page
 * that produced it. The route streams instead, so what leaves the server is a
 * file and nothing else.
 *
 * THE ENDPOINT TAKES A MESSAGE ID, NEVER A PATH. That rule is load-bearing: a
 * path parameter would make this an open proxy into the bucket, and no amount
 * of validation on it is as good as not accepting one.
 */

/*
 * Bir vaxtlar burada 12 MB-lıq hədd vardı: fayl bütövlükdə Buffer-ə yığılırdı
 * və həddi keçən heç oxunmurdu. Nəticə istifadəçi üçün belə görünürdü —
 * söhbətdə 15,6 MB-lıq hesabat var, adına klikləyirsən, heç nə açılmır və
 * səbəb heç yerdə yazılmır.
 *
 * İndi bütün fayllar axınla verilir (openObject), yəni hədd də lazım deyil:
 * nə ölçü məhdudiyyəti qalır, nə də eyni faylı on nəfər açanda yaddaş riski.
 */

let client: Client | null = null;

function spaces(): Client {
  if (client) return client;
  const endPoint = process.env.S3_ENDPOINT;
  const accessKey = process.env.S3_ACCESS_KEY;
  const secretKey = process.env.S3_SECRET_KEY;
  if (!endPoint || !accessKey || !secretKey) {
    throw new Error("S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY yoxdur — media oxunmur.");
  }
  client = new Client({
    endPoint,
    useSSL: process.env.S3_USE_SSL !== "false",
    accessKey,
    secretKey,
    ...(process.env.S3_REGION ? { region: process.env.S3_REGION } : {}),
  });
  return client;
}

export interface CanonicalMedia {
  messageId: number;
  storage: "evolution" | "archive" | "absent";
  objectKey: string | null;
  mime: string | null;
  sizeBytes: number | null;
  kind: string;
}

/**
 * The file behind one canonical message, if the caller may see it.
 *
 * The source check is the permission check: the message must belong to a
 * conversation one of the caller's sources contributes to. Returning null for
 * "not yours" and for "no such message" alike is deliberate — the two are the
 * same answer from outside.
 */
export async function canonicalMedia(
  sources: ScopedSourceId[],
  messageId: number,
): Promise<CanonicalMedia | null> {
  if (sources.length === 0) return null;
  const { rows } = await pool.query(
    `SELECT m.id, m.kind, md.storage, md.object_key, md.mime, md.size_bytes
       FROM katibe.message m
       LEFT JOIN katibe.media md ON md.message_id = m.id
      WHERE m.id = $2
        AND EXISTS (SELECT 1 FROM katibe.message_source ms
                     WHERE ms.message_id = m.id AND ms.source_id = ANY($1::text[]))`,
    [sources, messageId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    messageId: Number(r.id),
    storage: (r.storage as CanonicalMedia["storage"]) ?? "absent",
    objectKey: (r.object_key as string | null) ?? null,
    mime: (r.mime as string | null) ?? null,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    kind: r.kind as string,
  };
}

/**
 * Reads one object out of the bucket.
 *
 * Returns null rather than throwing when the object is gone: 16,684 files in
 * the export were never downloadable in the first place, and a transcript that
 * breaks on one missing photo is worse than one that shows a placeholder.
 */

/**
 * Faylı axınla açır — ölçüsü ilə birlikdə.
 *
 * Böyük fayllar üçün yeganə düzgün yol budur: 15 MB-lıq sənədi Buffer-ə yığmaq
 * bir istifadəçi üçün keçər, on nəfər eyni anda açanda isə prosesi yıxar.
 * Marşrut axını olduğu kimi brauzerə ötürür.
 *
 * Obyekt yoxdursa null — «tapılmadı» ilə «oxuna bilmədi» arasındakı fərq
 * çağıranın işi deyil, ikisi də 404-dür.
 */
export async function openObject(
  objectKey: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number } | null> {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET yoxdur.");
  try {
    const stat = await spaces().statObject(bucket, objectKey);
    const stream = await spaces().getObject(bucket, objectKey);
    return { stream, size: stat.size };
  } catch {
    return null;
  }
}

/** Best-guess content type, since the export does not always record one. */
export function mimeFor(media: CanonicalMedia): string {
  if (media.mime) return media.mime.split(";")[0].trim();
  const ext = media.objectKey?.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime",
    opus: "audio/ogg", ogg: "audio/ogg", m4a: "audio/mp4", mp3: "audio/mpeg",
    pdf: "application/pdf",
  };
  return byExt[ext] ?? "application/octet-stream";
}

/**
 * Which conversation, and which instance, a message belongs to.
 *
 * Only used for the monitor's view log, which records "who looked at what"
 * per instance and JID. Kept next to canonicalMedia() so the two reads that a
 * file request needs sit together, and returns null rather than throwing when
 * the message has no Evolution source — an archive-only message has no
 * instance to name, and that is not an error.
 */
export async function messageOrigin(
  messageId: number,
): Promise<{ instanceId: string; remoteJid: string } | null> {
  const { rows } = await pool.query(
    `SELECT m.remote_jid, ms.source_id
       FROM katibe.message m
       JOIN katibe.message_source ms ON ms.message_id = m.id
       JOIN katibe.source s ON s.id = ms.source_id AND s.kind = 'evolution'
      WHERE m.id = $1
      LIMIT 1`,
    [messageId],
  );
  if (rows.length === 0) return null;
  return { instanceId: rows[0].source_id as string, remoteJid: rows[0].remote_jid as string };
}
