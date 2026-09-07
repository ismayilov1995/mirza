import fs from "node:fs";
import sharp from "sharp";
import { pool } from "./db";
import type { ScopedInstanceId } from "./access";

/*
 * Matching a photo against the dress collection.
 *
 * Same shape as the text search this codebase already proved out: an embedding
 * index decides what is *retrievable*, and a second stage decides what is
 * *right*. There the second stage was a reranker reading question and passage
 * together; here it is a vision model looking at the query photo beside the
 * shortlist. The index alone will not do — 406 couture gowns are mostly ivory
 * and beaded, and a 512-dimension CLIP vector is not a fine-grained enough
 * description to separate them on its own.
 *
 * Read-only with respect to WhatsApp: images come from the copy Evolution
 * already archived to S3, never from a WhatsApp fetch.
 */

/** CLIP ViT-B/32 — images and text land in one 512-dimension space. */
export const IMAGE_MODEL = "sentence-transformers/clip-ViT-B-32";
export const IMAGE_DIMS = 512;

const ENDPOINT = `https://api.deepinfra.com/v1/inference/${IMAGE_MODEL}`;

/**
 * Longest edge sent to the model.
 *
 * CLIP resizes to 224×224 internally, so anything above this is bandwidth and
 * latency spent on pixels the model discards. 336 leaves a little headroom for
 * the aspect-ratio crop without paying for a full 800px upload — the API
 * refuses payloads past 131,072 characters and a full-size gown photo
 * base64-encodes to roughly three times that.
 */
const MAX_EDGE = 336;

/** Prepares a photo for the model: shrink, flatten, re-encode, base64. */
export async function prepareImage(input: Buffer | string): Promise<string> {
  const buf = typeof input === "string" ? fs.readFileSync(input) : input;
  const out = await sharp(buf)
    .rotate() // honour EXIF orientation — phone photos arrive sideways otherwise
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" }) // PNG screenshots may carry alpha
    .jpeg({ quality: 85 })
    .toBuffer();
  return out.toString("base64");
}

/**
 * Embeds one image.
 *
 * One request per image: this endpoint takes a single `image`, not a batch.
 * At roughly 300 tokens an image and $0.005 per million, the whole collection
 * costs a fraction of a cent, so the round trips are the only real cost.
 */
export async function embedImage(base64: string): Promise<number[]> {
  const key = process.env.DEEPINFRA_API_KEY;
  if (!key) throw new Error("DEEPINFRA_API_KEY yoxdur — şəkil embeddingi onsuz işləmir.");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64 }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    throw new Error(`DeepInfra HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { embeddings?: number[][] };
  const vec = body.embeddings?.[0];
  if (!vec || vec.length !== IMAGE_DIMS) {
    throw new Error(`gözlənilməyən cavab: ölçü ${vec?.length ?? "yox"}`);
  }
  return vec;
}

/** pgvector's text input format. */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export interface CatalogHit {
  code: string;
  series: string;
  filePath: string;
  /** 0..1, higher is closer. Cosine distance subtracted from one. */
  score: number;
}

/**
 * The collection items closest to a photo.
 *
 * Returns a shortlist, not an answer. Nothing here decides that a photo IS a
 * given dress — that judgement needs a model that can see both, and it needs
 * to be able to say "none of these", which a nearest-neighbour query never
 * can: it always returns its closest row, however wrong.
 */
export async function nearestCatalog(vector: number[], limit = 10): Promise<CatalogHit[]> {
  const { rows } = await pool.query(
    `SELECT code, series, file_path, 1 - (embedding <=> $1::vector) AS score
       FROM katibe.catalog_item
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [toVectorLiteral(vector), limit],
  );
  return rows.map((r) => ({
    code: r.code as string,
    series: r.series as string,
    filePath: r.file_path as string,
    score: Number(r.score),
  }));
}

export interface ScopedImage {
  messageId: string;
  instanceId: string;
  jid: string;
  url: string;
  chatName: string | null;
}

/**
 * Incoming images worth matching: `Client` chats, plus individual chats not yet
 * categorised.
 *
 * Everything else is a group whose images are logistics, shipping barcodes,
 * fabric close-ups or store chatter — 2,539 of them against 237 in scope when
 * this was measured. Widening it is a config change, not a rewrite, but it
 * should follow evidence that the wider set contains dresses.
 */
export async function scopedImages(
  instanceId: ScopedInstanceId,
  limit = 200,
): Promise<ScopedImage[]> {
  const { rows } = await pool.query(
    `SELECT m.id, m."instanceId", m.key->>'remoteJid' AS jid,
            m.message->>'mediaUrl' AS url,
            COALESCE(g.subject, c."pushName") AS chat_name
       FROM evolution_api."Message" m
       LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = m.key->>'remoteJid'
       LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
       LEFT JOIN katibe.group_subject g ON g.remote_jid = m.key->>'remoteJid'
       LEFT JOIN evolution_api."Contact" c
              ON c."remoteJid" = m.key->>'remoteJid' AND c."instanceId" = m."instanceId"
       LEFT JOIN katibe.message_image mi ON mi.message_id = m.id
      WHERE m."instanceId" = $1
        AND m."messageType" = 'imageMessage'
        AND (m.key->>'fromMe')::boolean = false
        AND m.message->>'mediaUrl' IS NOT NULL
        AND mi.message_id IS NULL
        AND (cat.name = 'Client'
             OR (m.key->>'remoteJid' NOT LIKE '%@g.us' AND cl.category_id IS NULL))
      ORDER BY m."messageTimestamp" DESC
      LIMIT $2`,
    [instanceId, limit],
  );
  return rows.map((r) => ({
    messageId: r.id as string,
    instanceId: r.instanceId as string,
    jid: r.jid as string,
    url: r.url as string,
    chatName: (r.chat_name as string | null) ?? null,
  }));
}
