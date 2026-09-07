/**
 * Qoşulmuş WhatsApp sessiyalarının nüsxəsini götürür (katibe.session_backup).
 *
 * Nə üçün: Evolution sessiyanı oxuya bilməyəndə onu yenidən yaradıb işləyən
 * sətrin üstünə yazır — `readData`/`getAuthKey`/`keyExists` üçü də
 * `catch { return null }` edir, yəni "yoxdur" ilə "oxuya bilmədim" eyni
 * sayılır (use-multi-file-auth-state-prisma.ts). 2026-08-25-də Rouz və
 * Rouz-2 məhz belə itdi. Nüsxə həmin bir sətri geri qaytarmağa imkan verir.
 *
 * ƏSAS QAYDA: yalnız ETİBARLI kredensial saxlanılır — içində me + account +
 * signalIdentities olan, yəni qoşulmuş kimlik. Qoşulmamış (initAuthCreds)
 * kredensial nüsxəyə HEÇ VAXT düşmür. Bu olmasa, hadisədən sonra işə düşən
 * ilk gedişat zibili yaxşı nüsxənin üstünə yazar və skript məhz qarşısını
 * almalı olduğu şeyi edərdi.
 *
 * Bərpa: npm run restore:session -- <instans adı>
 *
 * WhatsApp-a qarşı ancaq oxuyur.
 *
 * Əl ilə:  npm run backup:sessions
 *   SESSION_KEEP=10   instans başına neçə nüsxə saxlanılsın (default 10)
 */
import { loadEnvLocal } from "../mcp/env";
import { isPaired } from "../src/lib/session-creds";

loadEnvLocal();

const KEEP = Number(process.env.SESSION_KEEP ?? 10);

async function main() {
  const { pool } = await import("../src/lib/db");

  const { rows } = await pool.query(
    `SELECT i.id, i.name, s.creds
     FROM evolution_api."Instance" i
     JOIN evolution_api."Session" s ON s."sessionId" = i.id
     WHERE s.creds IS NOT NULL
     ORDER BY i.name`,
  );

  let saved = 0;
  const skipped: string[] = [];

  for (const r of rows) {
    const creds = String(r.creds);
    if (!isPaired(creds)) {
      skipped.push(`${r.name} (qoşulmayıb — nüsxə götürülmür)`);
      continue;
    }

    // Dəyişməyibsə təkrar sətir yazılmır: Baileys açarları tez-tez yeniləyir,
    // amma eyni dəyəri saatda 4 dəfə saxlamaq mənasızdır.
    const { rows: last } = await pool.query(
      `SELECT creds FROM katibe.session_backup
       WHERE instance_id = $1 ORDER BY taken_at DESC LIMIT 1`,
      [r.id],
    );
    if (last.length > 0 && last[0].creds === creds) {
      skipped.push(`${r.name} (dəyişməyib)`);
      continue;
    }

    await pool.query(
      `INSERT INTO katibe.session_backup (instance_id, instance_name, creds, creds_bytes)
       VALUES ($1, $2, $3, $4)`,
      [r.id, r.name, creds, creds.length],
    );
    saved++;
    console.log(`  ${r.name}: nüsxə götürüldü (${creds.length} bayt).`);

    // Köhnələri kəs, amma yalnız bu instans üçün və yalnız KEEP-dən artığını.
    await pool.query(
      `DELETE FROM katibe.session_backup
       WHERE instance_id = $1 AND id NOT IN (
         SELECT id FROM katibe.session_backup
         WHERE instance_id = $1 ORDER BY taken_at DESC LIMIT $2
       )`,
      [r.id, KEEP],
    );
  }

  if (skipped.length > 0) console.log(`  keçildi: ${skipped.join(", ")}`);
  console.log(`${rows.length} sessiya yoxlanıldı, ${saved} nüsxə yazıldı.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
