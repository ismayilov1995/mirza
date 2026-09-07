// Minimal signed-cookie session, no external deps. Uses the Web Crypto API
// so it works the same in the Node and Edge runtimes (middleware may run
// on either depending on config).

export const SESSION_COOKIE = "katibe_session";

const encoder = new TextEncoder();

/*
 * FORMAT VERSİYASI.
 *
 * v1 `${expires}.${imza}` idi — içində şəxsiyyət yox idi, çünki giriş bir
 * paylaşılan parol idi. v2 istifadəçi ID-si və session_epoch daşıyır.
 *
 * v1 tokenləri AÇIQ ŞƏKİLDƏ RƏDD EDİLİR. Onlar hələ də düzgün imzalıdır (açar
 * dəyişməyib), ona görə "sadəcə yeni sahələri oxu" yanaşması `userId ===
 * undefined` olan etibarlı bir sessiya yaradardı — və o sessiyanın nəyi görməli
 * olduğunu yeni kod bilməzdi. Bu, yeniləmə anında açılan bir bypass olardı.
 * Ona görə prefiks yoxlanılır və uyğun gəlməyən hər şey atılır: hamı bir dəfə
 * yenidən giriş edir.
 */
const VERSION = "v2";

export interface SessionPayload {
  /** katibe.dashboard_users.id */
  userId: number;
  /** katibe.dashboard_users.session_epoch — uyğunsuzluq sessiyanı öldürür. */
  epoch: number;
  /** Bitmə vaxtı, epoch ms. */
  exp: number;
}

async function getKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function toBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

/**
 * Sabit vaxtlı sətir müqayisəsi.
 *
 * node:crypto.timingSafeEqual burada işlənmir, çünki bu modul Edge runtime-da
 * da yüklənə bilir. Uzunluq fərqi onsuz da sızır (imza sabit uzunluqludur),
 * ona görə əhəmiyyətli olan bayt-bayt erkən çıxışın olmamasıdır.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(
  secret: string,
  payload: Omit<SessionPayload, "exp">,
  maxAgeSeconds: number,
): Promise<string> {
  const body = toBase64Url(
    encoder.encode(JSON.stringify({ ...payload, exp: Date.now() + maxAgeSeconds * 1000 })),
  );
  const signed = `${VERSION}.${body}`;
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(signed));
  return `${signed}.${toBase64Url(sig)}`;
}

/**
 * Tokeni doğrulayır və içindəki iddiaları qaytarır — yoxsa null.
 *
 * `boolean` yox `payload` qaytarır: çağıran "kim" sualına cavab almalıdır,
 * yoxsa icazə yoxlaması qurulası deyil. Aktivlik və epoch uyğunluğu burada
 * YOXLANMIR — bunlar bazadan gəlir, bax src/lib/access.ts getSession().
 */
export async function verifySessionToken(
  secret: string,
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;

  const parts = token.split(".");
  // v1 (iki hissəli) və digər formalar — bilərəkdən rədd.
  if (parts.length !== 3) return null;
  const [version, body, sig] = parts;
  if (version !== VERSION || !body || !sig) return null;

  const key = await getKey(secret);
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(`${version}.${body}`));
  if (!safeEqual(toBase64Url(expected), sig)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(fromBase64Url(body)) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload?.userId !== "number" ||
    typeof payload?.epoch !== "number" ||
    typeof payload?.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    Date.now() > payload.exp
  ) {
    return null;
  }
  return payload;
}
