/**
 * Thin server-side client for the Evolution API.
 *
 * Everything goes through here so the API key never reaches the browser, and
 * so instance creation always applies the same safe settings.
 */

const BASE = process.env.EVOLUTION_API_URL;
const KEY = process.env.EVOLUTION_API_KEY;

function requireConfig(): { base: string; key: string } {
  if (!BASE || !KEY) {
    throw new Error("EVOLUTION_API_URL / EVOLUTION_API_KEY .env.local faylında yoxdur.");
  }
  return { base: BASE, key: KEY };
}

/**
 * A non-2xx answer from Evolution, with the status kept.
 *
 * Callers that only log the failure read `message` as before; the ones that
 * have to tell "no such instance" apart from "the call broke" — deletion does
 * — need the number, and digging it out of a formatted string is how that
 * check silently stops working.
 */
export class EvolutionApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Evolution API ${status}: ${body.slice(0, 300)}`);
    this.name = "EvolutionApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const { base, key } = requireConfig();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { apikey: key, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new EvolutionApiError(res.status, body);
  }
  return (body ? JSON.parse(body) : null) as T;
}

/**
 * Settings every instance this dashboard creates must have.
 *
 * readMessages / readStatus false is the hard requirement: Katibe observes
 * conversations and must never mark anything as read on the owner's phone.
 * alwaysOnline false keeps the account's presence untouched, and
 * syncFullHistory false avoids pulling years of backlog on first connect.
 */
export const SAFE_INSTANCE_SETTINGS = {
  readMessages: false,
  readStatus: false,
  alwaysOnline: false,
  rejectCall: false,
  groupsIgnore: false,
  syncFullHistory: false,
} as const;

export interface CreatedInstance {
  instanceName: string;
  qrBase64: string | null;
}

/** Creates a Baileys instance and returns the first QR code to scan. */
export async function createInstance(name: string): Promise<CreatedInstance> {
  const res = await call<{
    instance?: { instanceName?: string };
    qrcode?: { base64?: string };
  }>("/instance/create", {
    method: "POST",
    body: JSON.stringify({
      instanceName: name,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
      ...SAFE_INSTANCE_SETTINGS,
    }),
  });
  return {
    instanceName: res.instance?.instanceName ?? name,
    qrBase64: res.qrcode?.base64 ?? null,
  };
}

export type ConnectionState = "open" | "connecting" | "close" | "unknown";

export interface InstanceStatus {
  state: ConnectionState;
  /** A fresh QR when the instance is still waiting to be paired. */
  qrBase64: string | null;
}

/**
 * Current pairing state plus a fresh QR if one is needed.
 *
 * QR codes expire after about a minute, so the pairing page re-reads this
 * rather than holding on to the code from creation.
 */
export async function getInstanceStatus(name: string): Promise<InstanceStatus> {
  const stateRes = await call<{ instance?: { state?: string } }>(
    `/instance/connectionState/${encodeURIComponent(name)}`,
  ).catch(() => null);
  const state = (stateRes?.instance?.state ?? "unknown") as ConnectionState;

  if (state === "open") return { state, qrBase64: null };

  // /instance/connect returns the current QR for an unpaired instance.
  const connectRes = await call<{ base64?: string; qrcode?: { base64?: string } }>(
    `/instance/connect/${encodeURIComponent(name)}`,
  ).catch(() => null);
  return {
    state,
    qrBase64: connectRes?.base64 ?? connectRes?.qrcode?.base64 ?? null,
  };
}

/**
 * Removes an instance from Evolution: the WhatsApp session is logged out and
 * every row Evolution owns for it is dropped.
 *
 * That deletion is wide. `Message`, `Chat`, `Contact` and the rest cascade off
 * `Instance`, so calling this on a working number throws away the recorded
 * conversations too — the deletion screen is where that is spelled out and
 * confirmed, never here.
 *
 * Two properties matter to callers:
 *
 *  - It is asynchronous. Evolution answers SUCCESS as soon as it has accepted
 *    the request and does the row deletion in a `remove.instance` listener, so
 *    "deleted" means accepted, not gone. `waitForInstanceRowGone` is what turns
 *    it into gone.
 *  - A 404 is not a failure. Evolution's guard looks in both its memory and its
 *    own table, so 404 means it has nothing to delete — which happens when a
 *    row outlives the process that owned it. Then the caller is the one holding
 *    an orphan, so this reports the case instead of throwing.
 */
export async function deleteInstance(name: string): Promise<"deleted" | "missing"> {
  try {
    await call(`/instance/delete/${encodeURIComponent(name)}`, { method: "DELETE" });
    return "deleted";
  } catch (error) {
    if (error instanceof EvolutionApiError && error.status === 404) return "missing";
    throw error;
  }
}

/**
 * Re-downloads one message's file from WhatsApp and returns the raw bytes.
 *
 * Read-only with respect to the conversation: the endpoint decrypts the media
 * with the key already stored on the message and never marks anything as read
 * (verified against chat.controller.ts and the Baileys download path). It is
 * still not free — when WhatsApp's CDN has dropped the file, Baileys asks the
 * sender's device to re-upload it, which is outbound traffic on a number that
 * has hit rate limits before. So this is only ever called for a file a person
 * clicked on, never to fill a page.
 *
 * Media older than roughly three weeks is gone from the CDN and this throws.
 */
export async function fetchMediaBytes(
  instanceName: string,
  messageId: string,
): Promise<{ bytes: Buffer; mimetype: string | null }> {
  const res = await call<{ base64?: string; mimetype?: string }>(
    `/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`,
    { method: "POST", body: JSON.stringify({ message: { key: { id: messageId } } }) },
  );
  if (!res?.base64) throw new Error("Evolution bu mesaj üçün media qaytarmadı.");
  return { bytes: Buffer.from(res.base64, "base64"), mimetype: res.mimetype ?? null };
}

/**
 * Sahibin ÖZ nömrəsinə sənəd göndərir (gündəlik hesabat üçün).
 *
 * NİYƏ BU FUNKSİYA MCP-DƏ YOXDUR VƏ OLMAYACAQ. Katibe oxu-yalnız məhsuldur:
 * MCP-də `sendText` bilərəkdən mövcud deyil (mcp/README.md), çünki agentin
 * müştəriyə mesaj yazması bu məhsulun vədini pozur. Buradakı istisna dardır və
 * qəsdəndir: cron sahibin öz nömrəsinə öz hesabatını göndərir — kənar adama
 * yazmır, heç bir söhbəti açmır və HEÇ NƏYİ OXUNMUŞ ETMİR (eyni model
 * /var/www/katibe/daily_report.sh-də 05:00 hesabatı üçün artıq işləyir).
 *
 * Ona görə funksiyanın adı `sendMessage` yox, `sendOwnerDocument`-dir: çağıran
 * yerdə «bu, sahibə gedir» sözü görünsün, ümumi mesaj göndərmə aləti kimi
 * götürülməsin.
 */
export async function sendOwnerDocument(opts: {
  instanceName: string;
  ownerNumber: string;
  fileName: string;
  mimetype: string;
  base64: string;
  caption: string;
}): Promise<void> {
  await call(`/message/sendMedia/${encodeURIComponent(opts.instanceName)}`, {
    method: "POST",
    body: JSON.stringify({
      number: opts.ownerNumber,
      mediatype: "document",
      mimetype: opts.mimetype,
      fileName: opts.fileName,
      media: opts.base64,
      caption: opts.caption,
    }),
  });
}
