/**
 * Copies LID → phone-number pairings out of Evolution's Redis signal state
 * into katibe.lid_number, where they survive.
 *
 * WhatsApp's @lid addressing hides the phone number, and it cannot be reversed
 * on demand — Baileys' getPNForLID() reads a local store and returns null on a
 * miss, with no network lookup behind it. The only pairings that will ever
 * exist are the ones WhatsApp volunteered while messages flowed, and Evolution
 * keeps them in Redis under:
 *
 *   evolution:instance:<instanceId>   (hash)
 *     lid-mapping-<lidUser>_reverse  => "<phoneNumber>"
 *
 * Those fields carry no TTL, but Redis is still a cache: a FLUSHDB, a
 * reinstall, or a maintenance wipe erases them and nothing can rebuild them.
 * Hence this script, and hence the hourly cron — coverage only ever grows.
 *
 * Read-only in both directions that matter: it SCANs Redis without writing,
 * and never calls the Evolution API, so it cannot mark anything as read.
 *
 * Run manually:  npm run harvest:lids
 *   HARVEST_VERBOSE=1   list every newly recovered number
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { createClient } from "redis";

// Standalone script (run via tsx, outside the Next.js runtime), so Next's
// automatic .env.local loading doesn't apply here — load it by hand.
function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
loadEnvLocal();

const VERBOSE = process.env.HARVEST_VERBOSE === "1";
const REVERSE_SUFFIX = "_reverse";
const FIELD_PREFIX = "lid-mapping-";

/**
 * Unwraps the stored value into a bare phone number.
 *
 * Evolution's cache layer JSON-encodes what Baileys already JSON-encoded, so
 * the field arrives double-wrapped — `"\"971500000006\""` — and a single
 * parse still leaves quotes around the digits. Peel until it stops changing
 * rather than assuming a fixed depth, since the wrapping is an implementation
 * detail of two layers, not a contract either one promises.
 */
function readPhoneNumber(raw: string): string | null {
  let value = raw;
  for (let i = 0; i < 4; i++) {
    let next: unknown;
    try {
      next = JSON.parse(value);
    } catch {
      break; // not JSON any more — what's left is the value itself
    }
    // Stop at the last STRING. One more parse would read the bare digits as a
    // JSON number and throw away the leading zeros of any number that has them.
    if (typeof next !== "string" || next === value) break;
    value = next;
  }
  const digits = value.trim().replace(/^\+/, "");
  // A real MSISDN, not a device suffix or a stray marker like the literal
  // "lid" that Evolution writes into IsOnWhatsapp.lid.
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

async function main() {
  const redisUrl = process.env.EVOLUTION_REDIS_URI;
  if (!redisUrl) throw new Error("EVOLUTION_REDIS_URI missing in env");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  const redis = createClient({ url: redisUrl });
  redis.on("error", (err) => console.error("redis:", err.message));
  await redis.connect();

  const { rows: before } = await pool.query(`SELECT COUNT(*)::int AS n FROM katibe.lid_number`);
  const startCount = before[0].n as number;

  let scanned = 0;
  let stored = 0;
  let skipped = 0;

  // node-redis v6 yields a BATCH of keys per iteration, not one key. Older
  // majors yielded a single string; normalising here keeps the loop correct
  // either way — getting this wrong silently harvests nothing.
  for await (const batch of redis.scanIterator({ MATCH: "evolution:instance:*", COUNT: 100 })) {
    const keys: string[] = Array.isArray(batch) ? batch.map(String) : [String(batch)];

    for (const key of keys) {
    const instanceId = key.replace(/^evolution:instance:/, "");
    const fields = await redis.hGetAll(key);

    for (const [field, raw] of Object.entries(fields)) {
      if (!field.startsWith(FIELD_PREFIX) || !field.endsWith(REVERSE_SUFFIX)) continue;
      scanned++;

      const lidUser = field.slice(FIELD_PREFIX.length, -REVERSE_SUFFIX.length);
      const phone = readPhoneNumber(String(raw));
      if (!lidUser || !phone) {
        skipped++;
        continue;
      }

      // Stored as the full JID so it joins straight against chats and labels.
      const lidJid = `${lidUser}@lid`;

      // last_seen_at always moves; first_seen_at never does, so the table
      // shows when a client first became identifiable. A pairing is a fact
      // about a person, so a differing number means the newer one wins.
      const { rowCount } = await pool.query(
        `INSERT INTO katibe.lid_number (lid_jid, phone_number, instance_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (lid_jid) DO UPDATE SET
           phone_number = EXCLUDED.phone_number,
           instance_id = COALESCE(EXCLUDED.instance_id, katibe.lid_number.instance_id),
           last_seen_at = now()
         WHERE katibe.lid_number.phone_number IS DISTINCT FROM EXCLUDED.phone_number
            OR katibe.lid_number.last_seen_at < now() - interval '1 hour'`,
        [lidJid, phone, instanceId],
      );
      if (rowCount) stored++;
    }
    }
  }

  const { rows: after } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM katibe.lid_number) AS total,
       (SELECT COUNT(*)::int FROM katibe.lid_number l
         JOIN katibe.contact_labels cl ON cl.remote_jid = l.lid_jid
         JOIN katibe.categories c ON c.id = cl.category_id
        WHERE c.name = 'Client') AS clients_with_number`,
  );

  console.log(
    `Redis-də ${scanned} eşlənmə tapıldı (${skipped} yararsız), ${stored} yazıldı/yeniləndi.`,
  );
  console.log(
    `Cəmi saxlanılan nömrə: ${after[0].total} (əvvəl ${startCount}), bunlardan Client olan: ${after[0].clients_with_number}.`,
  );

  if (VERBOSE) {
    const { rows } = await pool.query(
      `SELECT l.lid_jid, l.phone_number, cl.display_name, c.name AS category
       FROM katibe.lid_number l
       LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = l.lid_jid
       LEFT JOIN katibe.categories c ON c.id = cl.category_id
       ORDER BY (c.name = 'Client') DESC NULLS LAST, l.last_seen_at DESC`,
    );
    for (const r of rows) {
      console.log(`  ${r.phone_number.padEnd(15)} ${(r.category ?? "—").padEnd(11)} ${r.display_name ?? r.lid_jid}`);
    }
  }

  await redis.quit();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
