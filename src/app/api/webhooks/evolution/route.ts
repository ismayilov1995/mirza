import { NextResponse } from "next/server";
import { requireWebhookSecret, verifyWebhookSecret, WEBHOOK_SECRET_HEADER } from "@/lib/webhook-auth";
import { publish, hasSubscribers } from "@/lib/live-bus";
import { pool } from "@/lib/db";
import { mirrorNow } from "@/lib/mirror";
import { findPendingVoice, transcribeVoice } from "@/lib/voice";
import { scheduleReactiveClose } from "@/lib/supervisor/reactive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Evolution API buraya loopback ilə göndərir (127.0.0.1:8080 -> 127.0.0.1:3000).
// Bu yol nginx-ə AÇILMAMALIDIR — katibe.online vhost-u yalnız səhifələr üçündür.
//
// src/proxy.ts-də bu yol sessiya yoxlamasından çıxarılıb: əks halda hər POST
// /login-ə 307 ilə yönləndirilər və heç bir hadisə gəlib çatmazdı, özü də heç
// bir xəta görünmədən. Buna görə də öz paylaşılan açarı ilə qorunur.

const INGEST_EVENTS = new Set(["messages.upsert", "send.message"]);

// Eyni anda çoxlu mesaj gələndə hər biri üçün səhifəni yeniləmək mənasızdır.
// SÖHBƏT başına ən çox 3 saniyədə bir siqnal buraxılır.
//
// Əvvəl açar yalnız instans idi. Statistika səhifəsi üçün bu kifayət idi (o,
// sadəcə "nəsə dəyişdi" eşidir), amma nəzarətçi görünüşü açıq söhbətə mesaj
// əlavə edir: qonşu söhbətə gələn mesaj açarı "yandırıb" bizimkini üç saniyə
// susdururdu — yəni ekranda görünməyən mesaj.
const PUBLISH_THROTTLE_MS = 3000;
const lastPublish = new Map<string, number>();

// Açar söhbət başına olduğu üçün map böyüyür. Yarım saatdan köhnə yazılar
// onsuz da qərara təsir etmir.
const THROTTLE_TTL_MS = 30 * 60 * 1000;

function throttled(key: string, now: number): boolean {
  const last = lastPublish.get(key) ?? 0;
  if (now - last < PUBLISH_THROTTLE_MS) return true;
  lastPublish.set(key, now);
  if (lastPublish.size > 5000) {
    for (const [k, at] of lastPublish) if (now - at > THROTTLE_TTL_MS) lastPublish.delete(k);
  }
  return false;
}

// Evolution uploads media to S3 just AFTER it writes the Message row and fires
// this webhook, so transcribing the instant we're called would always miss our
// own copy and pull the file from WhatsApp instead. Waiting a few seconds lets
// the upload land and keeps the free path free.
const VOICE_UPLOAD_GRACE_MS = 10_000;

/**
 * Turns a voice note into text without making Evolution wait for it.
 *
 * Deliberately not awaited: Evolution treats this webhook as fire-and-forget
 * and a slow response would back up its event loop. The work still completes —
 * `next start` is a long-lived process — and every path records an outcome, so
 * nothing is silently dropped. The hourly cron re-checks anything this misses.
 */
function scheduleVoiceTranscription(waMessageId: string) {
  void (async () => {
    try {
      await new Promise((r) => setTimeout(r, VOICE_UPLOAD_GRACE_MS));
      const [pending] = await findPendingVoice({ waMessageId, limit: 1 });
      // Already transcribed — the cron got there first, or this is a re-delivery.
      if (!pending) return;
      const result = await transcribeVoice(pending);
      console.log(`[webhook] səs → mətn (${waMessageId}): ${result}`);
    } catch (err) {
      console.error("[webhook] səs transkripsiyası alınmadı:", err);
    }
  })();
}

export async function POST(request: Request) {
  let secret: string;
  try {
    secret = requireWebhookSecret();
  } catch (err) {
    console.error("[webhook] refusing requests:", err);
    return NextResponse.json({ error: "webhook secret not configured" }, { status: 500 });
  }

  if (!verifyWebhookSecret(secret, request.headers.get(WEBHOOK_SECRET_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { event?: unknown; instance?: unknown; data?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const event = typeof body?.event === "string" ? body.event : null;
  // Qalan hər şeyə 200 qaytarılır. 4xx olsa Evolution öz jurnalında xəta yazar
  // (və ya vebhuku söndürər) — halbuki bu app-in maraqlanmadığı hadisələr
  // (presence, qrup yeniləmələri) tamamilə normaldır.
  if (!event || !INGEST_EVENTS.has(event)) {
    return NextResponse.json({ ignored: `unhandled event: ${event ?? "missing"}` });
  }

  const instanceName = typeof body?.instance === "string" ? body.instance : null;
  if (!instanceName) return NextResponse.json({ ignored: "missing instance" });

  const data = (body?.data && typeof body.data === "object" ? body.data : null) as
    | { key?: { remoteJid?: unknown; id?: unknown; fromMe?: unknown }; messageType?: unknown }
    | null;
  const remoteJid = typeof data?.key?.remoteJid === "string" ? data.key.remoteJid : null;
  if (!remoteJid) return NextResponse.json({ ignored: "missing data.key.remoteJid" });
  if (remoteJid === "status@broadcast") return NextResponse.json({ ignored: "status broadcast" });

  // Before the listener check below: a voice note needs its text whether or not
  // anyone happens to have the page open. Waiting for the hourly cron instead
  // left one message silent for 35 minutes.
  const waMessageId = typeof data?.key?.id === "string" ? data.key.id : null;
  if (data?.messageType === "audioMessage" && waMessageId) {
    scheduleVoiceTranscription(waMessageId);
  }

  // Səhifələr instans ID-si ilə işləyir, vebhuk isə adı göndərir.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM evolution_api."Instance" WHERE name = $1`,
    [instanceName],
  );
  if (rows.length === 0) return NextResponse.json({ ignored: "unknown instance" });

  /*
   * Mesajı DƏRHAL anbara köçür.
   *
   * Söhbət ekranı katibe.message-i oxuyur, ora yazan isə beş dəqiqəlik cron
   * idi: müştəri cavab yazırdı, telefonda görünürdü, paneldə beş dəqiqəyə
   * qədər YOX. «Cavab yazıb amma katibe-də görünmür» məhz bu idi.
   *
   * Kimsə baxır-baxmır sualından ƏVVƏLdir və qəsdən belədir: mesajın anbarda
   * olması ekranın açıq olmasından asılı ola bilməz. Gözlənilmir — vebhuk
   * «göndər və unut»dur; alınmasa beş dəqiqəlik cron onsuz da eyni işi görür.
   */
  void mirrorNow(rows[0].id).catch((err) => {
    console.error("[webhook] köçürmə alınmadı:", err);
  });

  /*
   * SATICI CAVAB YAZDI → həmin söhbətin açıq bayraqları dərhal yoxlanılır.
   *
   * Hər iki hadisə lazımdır: `send.message` API-dən göndəriləni, `messages.upsert`
   * isə satıcının ÖZ telefonundan yazdığını gətirir — praktikada cavabların
   * çoxu ikincidir. Ayırd edən sahə key.fromMe-dir.
   *
   * Ekranın açıq olub-olmamasından ƏVVƏLdir və qəsdən belədir: bayrağın
   * bağlanması kiminsə səhifəyə baxmasından asılı ola bilməz. Model
   * çağırılmır — qərar sırf SQL sübutudur (bax reactive.ts).
   */
  if (data?.key?.fromMe === true) {
    scheduleReactiveClose(rows[0].id, remoteJid);
  }

  // Buradan aşağısı yalnız ekranı yeniləmək üçündür.
  if (!hasSubscribers()) return NextResponse.json({ ok: true, listeners: 0 });

  if (throttled(`${instanceName}|${remoteJid}`, Date.now())) {
    return NextResponse.json({ ok: true, throttled: true });
  }

  publish({
    type: "message",
    instanceId: rows[0].id,
    instanceName,
    isGroup: remoteJid.endsWith("@g.us"),
    remoteJid,
    at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
