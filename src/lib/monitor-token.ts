import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";

/*
 * Söhbət açarının opaq forması.
 *
 * NİYƏ. `994500000002@s.whatsapp.net` JID-inin özü telefon nömrəsidir. Adı,
 * mətni və nömrə sahəsini maskalayıb JID-i olduğu kimi qaytarmaq maskalamanı
 * teatra çevirərdi: brauzerin şəbəkə panelində bütün müştəri nömrələri açıq
 * dayanardı. (Bu, faraz deyil — npm run verify:access məhz bunu tapdı.)
 *
 * Ona görə nəzarətçi API-sində söhbətin açarı JID yox, ondan alınan tokendir.
 *
 * DETERMİNİSTİK ŞİFRƏLƏMƏ. IV təsadüfi deyil, açardan və mətndən çıxarılır:
 * eyni söhbət həmişə eyni tokeni verir. Bu qəsdəndir — canlı hadisə ilə açıq
 * söhbəti müqayisə etmək lazımdır, təsadüfi IV ilə hər kadr fərqli token
 * olardı. Determinizmin sızdırdığı yeganə şey "eynilik"dir, elə lazım olan da
 * odur. Token instansa AAD ilə bağlanır, yəni bir nömrənin tokeni başqasında
 * açılmır.
 *
 * Token İCAZƏ DEYİL. Açıla bilməsi yalnız "hansı söhbət" sualına cavabdır;
 * icazə həmişə requireVisibleChat()-dən keçir.
 */

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET təyin olunmayıb");
  return createHash("sha256").update(`${secret}|monitor-chat-id`).digest();
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Buffer {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

export function encodeChatId(instanceId: string, jid: string): string {
  const k = key();
  const iv = createHmac("sha256", k).update(`iv|${instanceId}|${jid}`).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  cipher.setAAD(Buffer.from(instanceId, "utf8"));
  const ct = Buffer.concat([cipher.update(jid, "utf8"), cipher.final()]);
  return b64url(Buffer.concat([iv, cipher.getAuthTag(), ct]));
}

/** Tokendən JID — saxta və ya başqa instansın tokeni üçün null. */
export function decodeChatId(instanceId: string, token: string): string | null {
  try {
    const raw = fromB64url(token);
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAAD(Buffer.from(instanceId, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
