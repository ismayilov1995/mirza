/**
 * Sessiya kredensialını nüsxədən geri yazır.
 *
 * Nə vaxt lazımdır: instans qoşulmayıb, evolution_api."Session".creds isə
 * qoşulmamış (me/account yoxdur) — yəni Evolution işləyən sessiyanı təzə
 * açarla əvəz edib (bax scripts/backup-sessions.ts).
 *
 * BU SEHR DEYİL. WhatsApp açarları vaxtaşırı yeniləyir, ona görə köhnə nüsxə
 * WhatsApp tərəfindən rədd edilə bilər — o halda QR-dan başqa yol yoxdur.
 * Amma nüsxə olmayanda cəhd etmək imkanı da yoxdur, olanda isə var.
 *
 * Geri yazandan SONRA instans yenidən qoşulmalıdır, yoxsa Evolution yaddaşdakı
 * köhnə (zibil) vəziyyətlə işləməyə davam edər və ilk creds.update nüsxəni
 * yenidən üstündən yazar. Skript bunu özü etmir — nə vaxt olacağını siz
 * seçirsiniz, çünki qoşulma anı canlı instansları da tərpədir.
 *
 * İşlətmə:  npm run restore:session -- <instans adı> [--index N]
 *   --index N   N-ci ən təzə nüsxə (default 0 = ən təzə)
 *   --dry-run   nə edəcəyini yaz, yazma
 */
import { loadEnvLocal } from "../mcp/env";
import { isPaired } from "../src/lib/session-creds";

loadEnvLocal();

async function main() {
  const { pool } = await import("../src/lib/db");

  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith("--"));
  const dryRun = args.includes("--dry-run");
  const idxArg = args.indexOf("--index");
  const index = idxArg >= 0 ? Number(args[idxArg + 1]) : 0;
  if (!name) throw new Error("İnstans adı verilməyib: npm run restore:session -- <ad>");

  const { rows: inst } = await pool.query(
    `SELECT i.id, i.name, i."connectionStatus" AS status, s.creds
     FROM evolution_api."Instance" i
     LEFT JOIN evolution_api."Session" s ON s."sessionId" = i.id
     WHERE i.name = $1`,
    [name],
  );
  if (inst.length === 0) throw new Error(`"${name}" adlı instans yoxdur.`);
  const target = inst[0];

  const { rows: backups } = await pool.query(
    `SELECT id, creds, creds_bytes, taken_at FROM katibe.session_backup
     WHERE instance_id = $1 ORDER BY taken_at DESC LIMIT 20`,
    [target.id],
  );
  if (backups.length === 0) {
    console.log(`${name}: nüsxə yoxdur — bərpa mümkün deyil, QR lazımdır.`);
    await pool.end();
    return;
  }

  console.log(`${name} üçün ${backups.length} nüsxə var:`);
  backups.forEach((b, i) =>
    console.log(`  [${i}] ${new Date(b.taken_at).toISOString()}  ${b.creds_bytes} bayt${i === index ? "  <- seçilən" : ""}`),
  );

  const chosen = backups[index];
  if (!chosen) throw new Error(`--index ${index} yoxdur.`);
  if (!isPaired(String(chosen.creds))) throw new Error("Seçilən nüsxə qoşulmuş kimlik daşımır — bərpa mənasızdır.");

  const currentPaired = target.creds ? isPaired(String(target.creds)) : false;
  console.log(
    `Hazırkı vəziyyət: status=${target.status}, kredensial=${currentPaired ? "QOŞULMUŞ" : "qoşulmamış/boş"}.`,
  );
  // Hazırkı kredensial qoşulmuşdursa, üstünə yazmaq İTKİ olardı — bu, düzəltməyə
  // çalışdığımız səhvin eynisidir, sadəcə bizim əlimizlə.
  if (currentPaired) {
    console.log("Hazırkı kredensial ETİBARLIDIR — üstünə yazılmır. Bərpa dayandırıldı.");
    await pool.end();
    return;
  }

  if (dryRun) {
    console.log(`DRY RUN — [${index}] nüsxə yazılacaqdı, yazılmadı.`);
    await pool.end();
    return;
  }

  await pool.query(`UPDATE evolution_api."Session" SET creds = $2 WHERE "sessionId" = $1`, [
    target.id,
    chosen.creds,
  ]);
  console.log(`${name}: [${index}] nüsxə geri yazıldı.`);
  console.log(`İNDİ instans yenidən qoşulmalıdır, yoxsa Evolution yaddaşdakı köhnə vəziyyəti saxlayır:`);
  console.log(`  curl -X GET "$EVOLUTION_API_URL/instance/restart/${encodeURIComponent(name)}" -H "apikey: ..."`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
