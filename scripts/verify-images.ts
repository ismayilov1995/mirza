/**
 * Decides what each embedded photo shows: a collection piece, or not.
 *
 * The vector index has already narrowed 406 dresses to a handful; this asks a
 * model that can see them whether the photo is actually one of those, and
 * records the answer beside the message.
 *
 * WHY NOT JUST TRUST THE SCORE. Measured on this archive, a correct match
 * scored 0.92 while confident wrong ones scored 0.89 and 0.84 — three
 * hundredths apart, because two different ivory lace gowns really are alike to
 * CLIP. A threshold there would stamp catalogue codes onto bespoke work.
 *
 * Spends money: one vision call per image, roughly $0.0005 at gpt-5-mini
 * rates. At the ~34 images a day this scope produces, that is under a dollar a
 * month.
 *
 * Run:  npm run verify:images
 *   VERIFY_MAX_PER_RUN=100  ceiling per run (default 100)
 *   VERIFY_REDO=1           re-judge images that already have a verdict
 *   VERIFY_DRY_RUN=1        show what would be judged, call nothing
 */
import { loadEnvLocal } from "../mcp/env";
// Type-only, so it is erased and does not pull the module before env loads.
import type { ImageVerdict } from "../src/lib/image-verify";

loadEnvLocal();

async function main() {
  const { nearestCatalog } = await import("../src/lib/image-match");
  const { verifyImage, VERIFY_CANDIDATES } = await import("../src/lib/image-verify");
  const { pool } = await import("../src/lib/db");

  const limit = Number(process.env.VERIFY_MAX_PER_RUN ?? 100);
  const redo = process.env.VERIFY_REDO === "1";
  const dryRun = process.env.VERIFY_DRY_RUN === "1";

  const { rows: pending } = await pool.query(
    `SELECT mi.message_id, mi.embedding::text AS vec, m.message->>'mediaUrl' AS url,
            COALESCE(g.subject, c."pushName", mi.remote_jid) AS chat_name
       FROM katibe.message_image mi
       JOIN evolution_api."Message" m ON m.id = mi.message_id
       LEFT JOIN katibe.group_subject g ON g.remote_jid = mi.remote_jid
       LEFT JOIN evolution_api."Contact" c
              ON c."remoteJid" = mi.remote_jid AND c."instanceId" = mi.instance_id
      WHERE mi.embedding IS NOT NULL
        AND ($1::boolean OR mi.verdict IS NULL)
      ORDER BY m."messageTimestamp" DESC
      LIMIT $2`,
    [redo, limit],
  );

  console.log(`${pending.length} şəkil qiymətləndiriləcək${dryRun ? " · QURU İŞLƏMƏ" : ""}`);
  if (dryRun || pending.length === 0) {
    await pool.end();
    return;
  }

  const tally: Record<string, number> = { catalog: 0, customized: 0, not_dress: 0, unsure: 0 };
  for (const [i, p] of pending.entries()) {
    const vector = JSON.parse(p.vec as string) as number[];
    const candidates = await nearestCatalog(vector, VERIFY_CANDIDATES);

    // Typed as the library's return so the union stays open — a literal
    // initialiser here narrows it to "unsure" and the assignment below fails.
    let verdict: ImageVerdict & { model: string } = {
      verdict: "unsure", code: "", reason: "media əlçatmazdır", model: "",
    };
    try {
      const res = await fetch(p.url as string, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        verdict = await verifyImage(Buffer.from(await res.arrayBuffer()), candidates);
      }
    } catch {
      /* verdict stays unsure with the reason above */
    }

    await pool.query(
      `UPDATE katibe.message_image
          SET matched_code = $2, verdict = $3, reason = $4,
              verdict_model = $5, verdict_at = now()
        WHERE message_id = $1`,
      [p.message_id, verdict.verdict === "catalog" ? verdict.code : null,
       verdict.verdict, verdict.reason, verdict.model || null],
    );
    tally[verdict.verdict]++;
    process.stdout.write(
      `\r  ${i + 1}/${pending.length} · kataloq ${tally.catalog} · sifariş ${tally.customized}` +
        ` · paltar deyil ${tally.not_dress} · qərarsız ${tally.unsure}   `,
    );
  }
  console.log(`\nBitdi.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
