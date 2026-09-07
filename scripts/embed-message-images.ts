/**
 * Embeds the incoming photos that are worth matching against the collection.
 *
 * SCOPE. `Client` chats plus individual chats with no category yet — see
 * scopedImages() in src/lib/image-match.ts for why the groups are excluded.
 *
 * FORWARD-ONLY, and not by choice. Evolution only began archiving media to S3
 * on 2026-08-24; of 50,234 image messages in the database, 2,949 still have a
 * file. Everything older is gone from WhatsApp's servers and cannot be
 * recovered, so this walks what exists and keeps up with what arrives.
 *
 * Failures are recorded rather than retried forever — the same lesson
 * scripts/transcribe-voice.ts paid for with a cron that re-fetched dead media
 * every hour.
 *
 * Run:  npm run embed:images
 *   IMG_MAX_PER_RUN=200   ceiling per run (default 200)
 *   IMG_INSTANCE=<id>     only this instance (default: every instance)
 *   IMG_DRY_RUN=1         list what would be fetched, call nothing
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

async function main() {
  const { prepareImage, embedImage, toVectorLiteral, scopedImages, IMAGE_MODEL } =
    await import("../src/lib/image-match");
  const { systemScope } = await import("../src/lib/access");
  const { pool } = await import("../src/lib/db");

  const only = process.env.IMG_INSTANCE;
  const limit = Number(process.env.IMG_MAX_PER_RUN ?? 200);
  const dryRun = process.env.IMG_DRY_RUN === "1";

  const { rows: instances } = await pool.query(
    `SELECT DISTINCT "instanceId" AS id FROM evolution_api."Message"
      WHERE ($1::text IS NULL OR "instanceId" = $1) ORDER BY 1`,
    [only ?? null],
  );

  const tally = { ok: 0, unavailable: 0, failed: 0 };
  for (const { id } of instances as { id: string }[]) {
    const pending = await scopedImages(systemScope(id), limit - tally.ok - tally.failed);
    if (pending.length === 0) continue;
    console.log(`${id}: ${pending.length} şəkil`);
    if (dryRun) {
      for (const p of pending.slice(0, 10)) console.log(`  ${p.chatName ?? p.jid}`);
      continue;
    }

    for (const p of pending) {
      let status: "ok" | "unavailable" | "failed" = "failed";
      let vector: number[] | null = null;
      let error: string | null = null;
      try {
        // The S3 copy is presigned and expires; a 403 here is ordinary rather
        // than a fault, and there is no second source — WhatsApp dropped it.
        const res = await fetch(p.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) {
          status = "unavailable";
          error = `HTTP ${res.status}`;
        } else {
          vector = await embedImage(await prepareImage(Buffer.from(await res.arrayBuffer())));
          status = "ok";
        }
      } catch (e) {
        error = (e as Error).message.slice(0, 300);
      }
      await pool.query(
        `INSERT INTO katibe.message_image
           (message_id, instance_id, remote_jid, embedding, model, status, error)
         VALUES ($1,$2,$3,$4::vector,$5,$6,$7)
         ON CONFLICT (message_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, model = EXCLUDED.model,
               status = EXCLUDED.status, error = EXCLUDED.error, created_at = now()`,
        [p.messageId, p.instanceId, p.jid, vector ? toVectorLiteral(vector) : null,
         vector ? IMAGE_MODEL : null, status, error],
      );
      tally[status]++;
      process.stdout.write(`\r  ${tally.ok} ok · ${tally.unavailable} media yox · ${tally.failed} xəta   `);
    }
    console.log();
  }

  console.log(
    dryRun
      ? "QURU İŞLƏMƏ — heç nə göndərilmədi."
      : `Bitdi — ${tally.ok} embed, ${tally.unavailable} media yoxdur, ${tally.failed} xəta.`,
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
