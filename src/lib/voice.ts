import OpenAI from "openai";
import { pool } from "./db";

/*
 * Voice-note transcription, shared by the webhook (near-live) and the hourly
 * cron (backstop). It used to live only in scripts/transcribe-voice.ts, which
 * meant text appeared up to an hour after the message — one arrived at 10:59
 * and was still silent at 11:34.
 */

export const VOICE_MODEL = "gpt-4o-transcribe";

/**
 * Past this age WhatsApp's CDN has dropped the file. Probed at 2/7/21 days
 * (all fine) and 45/75/120 (all gone). Skipping older messages avoids a
 * pointless media-retry request to the sender's device.
 */
export const FETCHABLE_DAYS = 21;

/** How long to leave a failed attempt alone before trying it again. */
export const RETRY_AFTER_HOURS = 6;

export interface PendingVoice {
  id: string;
  instanceId: string;
  jid: string;
  waId: string;
  seconds: number | null;
  storedUrl: string | null;
}

/**
 * Voice notes still needing text.
 *
 * `windowHours` bounds how far back to look — the cron passes a rolling window
 * so it never walks the backlog, and the webhook passes a single message id
 * instead. Anything already transcribed is skipped outright; anything that
 * failed is retried once the cooling-off period has passed, because a download
 * can fail from a network blip or because Evolution had not finished archiving
 * yet, and writing that off permanently would lose the message.
 */
export async function findPendingVoice(opts: {
  windowHours?: number;
  /** Our row id (a cuid). */
  messageId?: string;
  /** WhatsApp's own id, which is what a webhook payload carries. */
  waMessageId?: string;
  limit?: number;
}): Promise<PendingVoice[]> {
  const { rows } = await pool.query(
    `SELECT m.id, m."instanceId", m.key->>'remoteJid' AS jid, (m.key->>'id')::text AS wa_id,
            (m.message->'audioMessage'->>'seconds')::int AS seconds,
            m.message->>'mediaUrl' AS stored_url
     FROM evolution_api."Message" m
     LEFT JOIN katibe.voice_transcript v ON v.message_id = m.id
     WHERE m."messageType" = 'audioMessage'
       AND (v.message_id IS NULL
            OR (v.status <> 'ok' AND v.created_at < now() - make_interval(hours => $1::int)))
       AND m."messageTimestamp" > EXTRACT(epoch FROM now() - make_interval(days => $2::int))::int
       AND ($3::text IS NULL OR m.id = $3::text)
       AND ($4::text IS NULL OR m.key->>'id' = $4::text)
       AND ($5::int IS NULL
            OR m."messageTimestamp" > EXTRACT(epoch FROM now() - make_interval(hours => $5::int))::int)
     ORDER BY m."messageTimestamp" DESC
     LIMIT $6`,
    [RETRY_AFTER_HOURS, FETCHABLE_DAYS, opts.messageId ?? null, opts.waMessageId ?? null,
     opts.windowHours ?? null, opts.limit ?? 100],
  );
  return rows.map((r) => ({
    id: r.id, instanceId: r.instanceId, jid: r.jid, waId: r.wa_id,
    seconds: r.seconds, storedUrl: r.stored_url,
  }));
}

/** Our S3 copy first; WhatsApp only as a fallback. Null when neither has it. */
async function fetchAudio(p: PendingVoice): Promise<Buffer | null> {
  if (p.storedUrl) {
    try {
      // Evolution's stored URL is presigned and expires after seven days, so a
      // 403 here is ordinary rather than a fault — fall through to WhatsApp.
      const res = await fetch(p.storedUrl, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch {
      /* fall through */
    }
  }
  const base = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE_NAME;
  if (!base || !key || !instance) return null;
  const res = await fetch(`${base}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { key: { id: p.waId } } }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { base64?: string };
  return body?.base64 ? Buffer.from(body.base64, "base64") : null;
}

async function record(
  p: PendingVoice, status: "ok" | "unavailable" | "failed",
  text: string | null, error: string | null,
) {
  await pool.query(
    `INSERT INTO katibe.voice_transcript
       (message_id, instance_id, remote_jid, text, language, model, duration_sec, status, error)
     VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,$8)
     ON CONFLICT (message_id) DO UPDATE
       SET text=EXCLUDED.text, status=EXCLUDED.status,
           error=EXCLUDED.error, created_at=now()`,
    [p.id, p.instanceId, p.jid, text, VOICE_MODEL, p.seconds, status, error?.slice(0, 500) ?? null],
  );
}

export type VoiceResult = "ok" | "unavailable" | "failed";

/** Transcribes one voice note and stores the outcome. Never throws. */
export async function transcribeVoice(p: PendingVoice): Promise<VoiceResult> {
  try {
    const audio = await fetchAudio(p);
    if (!audio) {
      await record(p, "unavailable", null, "media WhatsApp-da və S3-də yoxdur");
      return "unavailable";
    }
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    // WhatsApp voice notes are Opus in an Ogg container; the extension is what
    // the API uses to pick a decoder, so it has to be right.
    const file = new File([new Uint8Array(audio)], `${p.waId}.ogg`, { type: "audio/ogg" });
    const res = await openai.audio.transcriptions.create({
      file,
      model: VOICE_MODEL,
      // No `language` hint on purpose: these chats mix Azerbaijani, Russian,
      // English and Arabic, sometimes inside one message, and pinning a
      // language makes the model force the wrong one onto the others.
      prompt: "Bu səsli mesaj Azərbaycan, rus, ingilis və ya ərəb dilində ola bilər.",
    });
    const text = (res.text ?? "").trim();
    await record(p, "ok", text || null, null);
    return "ok";
  } catch (err) {
    await record(p, "failed", null, err instanceof Error ? err.message : String(err));
    return "failed";
  }
}
