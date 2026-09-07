/**
 * Backstop pass over voice notes that still have no text.
 *
 * The live path is the Evolution webhook, which transcribes a voice note
 * seconds after it arrives (src/app/api/webhooks/evolution/route.ts). This
 * hourly cron exists for what that path misses: a webhook that never landed,
 * a restart mid-flight, a download that failed and is now past its retry
 * cooling-off.
 *
 * Forward-only. The window is a rolling 24 hours and never walks the backlog:
 * of ~2,900 voice messages here only ~530 were still fetchable at all, the
 * rest having aged out of WhatsApp's CDN.
 *
 * Read-only with respect to the conversation — it downloads and decrypts media
 * that is already stored and never calls a WhatsApp write endpoint.
 *
 * Run manually:  npm run transcribe:voice
 *   VOICE_WINDOW_HOURS=24   how far back to look (default 24)
 *   VOICE_MAX_PER_RUN=100   spend ceiling per run (default 100 messages)
 *   VOICE_DRY_RUN=1         list what would be sent, call nothing, spend nothing
 */
import fs from "node:fs";
import path from "node:path";

// Standalone script (run via tsx, outside the Next.js runtime), so Next's
// automatic .env.local loading doesn't apply here — load it by hand, and
// before importing anything that builds a connection pool at module scope.
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

async function main() {
  loadEnvLocal();
  const { findPendingVoice, transcribeVoice, VOICE_MODEL } = await import("../src/lib/voice");
  const { pool } = await import("../src/lib/db");

  const windowHours = Number(process.env.VOICE_WINDOW_HOURS ?? 24);
  const limit = Number(process.env.VOICE_MAX_PER_RUN ?? 100);
  const dryRun = process.env.VOICE_DRY_RUN === "1";

  const pending = await findPendingVoice({ windowHours, limit });
  const totalSec = pending.reduce((s, p) => s + (p.seconds ?? 0), 0);
  console.log(
    `${pending.length} səsli mesaj gözləyir (~${Math.round(totalSec / 60)} dəq, model ${VOICE_MODEL})`,
  );
  if (dryRun) {
    console.log("VOICE_DRY_RUN=1 — heç nə göndərilmədi, xərc yoxdur.");
    for (const p of pending) console.log(`  ${p.id}  ${p.jid}  ${p.seconds ?? "?"}s`);
    await pool.end();
    return;
  }

  const tally = { ok: 0, unavailable: 0, failed: 0 };
  for (const p of pending) tally[await transcribeVoice(p)]++;
  console.log(
    `bitdi — ${tally.ok} çevrildi, ${tally.unavailable} media yoxdur, ${tally.failed} xəta`,
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
