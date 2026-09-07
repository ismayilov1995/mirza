/**
 * İlk admin hesabını yaradır — DASHBOARD_PASSWORD-dan keçidin birinci addımı.
 *
 * Bu skript deploy-dan ƏVVƏL işlədilir. Ardıcıllıq belədir ki, heç vaxt iki
 * giriş yolu eyni anda açıq qalmasın:
 *   1. miqrasiya (cədvəllər yaranır, heç nə işlətmir)
 *   2. BU SKRİPT (hesab yaranır, hələ heç nə ondan istifadə etmir)
 *   3. deploy (login yalnız yeni yola baxır, köhnəsi koddan silinib)
 *   4. giriş yoxlanılır
 *   5. DASHBOARD_PASSWORD .env.local-dan silinir
 *
 * Parol TERMİNALDAN gizli oxunur və heç yerə çap olunmur — nə stdout-a, nə
 * loga. Arqument kimi vermək olmaz (ps-də görünərdi).
 *
 *   npx tsx scripts/create-dashboard-user.ts <istifadəçi-adı> [--viewer]
 *
 * Yazdıqdan sonra özünü yoxlayır: hash geri oxunub parolla doğrulanır. Beləcə
 * "hesab yarandı, amma giriş alınmır" vəziyyəti buradaca üzə çıxır, deploy-dan
 * sonra yox.
 */
import { createInterface } from "node:readline";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const stdout = process.stdout as NodeJS.WriteStream & { _writeToOutput?: (s: string) => void };
    // readline-in öz əks-sədasını söndürürük: parol ekranda görünməməlidir.
    stdout._writeToOutput = function (chunk: string) {
      if (chunk.includes(prompt)) stdout.write(chunk);
    };
    rl.question(prompt, (answer) => {
      delete stdout._writeToOutput;
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const username = args.find((a) => !a.startsWith("--"));
  const role = args.includes("--viewer") ? "viewer" : "admin";
  if (!username) {
    console.error("İstifadə: npx tsx scripts/create-dashboard-user.ts <istifadəçi-adı> [--viewer]");
    process.exit(1);
  }

  const { pool } = await import("../src/lib/db");
  const { createAccount } = await import("../src/lib/accounts");
  const { verifyPassword } = await import("../src/lib/password");
  const { passwordProblem } = await import("../src/lib/password");

  const { rows: existing } = await pool.query(
    `SELECT id FROM katibe.dashboard_users WHERE lower(username) = lower($1)`,
    [username],
  );
  if (existing.length > 0) {
    console.error(`"${username}" adlı hesab artıq var.`);
    await pool.end();
    process.exit(1);
  }

  const password = await askHidden(`"${username}" üçün parol: `);
  const again = await askHidden("Parolu təkrarlayın: ");
  if (password !== again) {
    console.error("Parollar uyğun gəlmədi.");
    await pool.end();
    process.exit(1);
  }
  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    await pool.end();
    process.exit(1);
  }

  const id = await createAccount({
    username,
    email: null,
    password,
    role: role as "admin" | "viewer",
    // İlk admin parolu özü seçir, ona görə dəyişməyə məcbur deyil.
    mustChangePassword: false,
    createdBy: null,
  });

  // Öz-özünü yoxlama: yazılan hash həqiqətən bu parolu qəbul edirmi.
  const { rows } = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM katibe.dashboard_users WHERE id = $1`,
    [id],
  );
  const ok = await verifyPassword(password, rows[0].password_hash);
  if (!ok) {
    console.error("XƏTA: hash yazıldı, amma parolu qəbul etmir. Hesab silinir.");
    await pool.query(`DELETE FROM katibe.dashboard_users WHERE id = $1`, [id]);
    await pool.end();
    process.exit(1);
  }

  console.log(`Hesab yaradıldı: ${username} (${role}), id=${id}. Parol yoxlanışı: OK.`);
  console.log("Növbəti addım: instans icazələrini verin —");
  console.log(`  npx tsx scripts/grant-instance.ts ${username} <instans-adı>`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
