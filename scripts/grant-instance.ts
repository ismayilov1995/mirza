/**
 * Bir hesaba bir nömrəyə giriş verir, istəyə görə həmin nömrəni privat edir.
 *
 * Admin panel açılana qədər (yəni ilk girişdən əvvəl) lazımdır — sonra
 * /admin/accounts səhifəsi eyni işi görür.
 *
 *   npx tsx scripts/grant-instance.ts <istifadəçi-adı> <instans-adı> [--private]
 *
 * --private həmin nömrəni privat edir: bundan sonra onu YALNIZ açıq icazəsi
 * olanlar görür, admin olsa belə. Şəxsi nömrə üçün nəzərdə tutulub.
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const [username, instanceName] = positional;
  const makePrivate = args.includes("--private");
  if (!username || !instanceName) {
    console.error("İstifadə: npx tsx scripts/grant-instance.ts <istifadəçi-adı> <instans-adı> [--private]");
    process.exit(1);
  }

  const { pool } = await import("../src/lib/db");

  const { rows: users } = await pool.query<{ id: number }>(
    `SELECT id FROM katibe.dashboard_users WHERE lower(username) = lower($1)`,
    [username],
  );
  if (users.length === 0) {
    console.error(`"${username}" adlı hesab yoxdur.`);
    await pool.end();
    process.exit(1);
  }

  const { rows: instances } = await pool.query<{ id: string }>(
    `SELECT id FROM evolution_api."Instance" WHERE name = $1`,
    [instanceName],
  );
  if (instances.length === 0) {
    console.error(`"${instanceName}" adlı instans yoxdur.`);
    await pool.end();
    process.exit(1);
  }

  await pool.query(
    `INSERT INTO katibe.dashboard_user_instances (user_id, instance_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [users[0].id, instances[0].id],
  );
  console.log(`${username} → ${instanceName}: icazə verildi.`);

  if (makePrivate) {
    await pool.query(
      `INSERT INTO katibe.instance_access (instance_id, private, note, updated_at)
       VALUES ($1, true, $2, now())
       ON CONFLICT (instance_id) DO UPDATE SET private = true, updated_at = now()`,
      [instances[0].id, "şəxsi nömrə"],
    );
    console.log(`${instanceName} PRİVAT edildi — yalnız açıq icazəsi olanlar görür.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
