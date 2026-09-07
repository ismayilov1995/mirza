/**
 * Bir nəzarətçi hesabına başlanğıc görünmə qaydalarını qoyur.
 *
 * Hesabın ÖZÜ burada yaradılmır — o, /admin/accounts-da yaradılır, çünki parol
 * orada təyin olunmalıdır: skriptin yaratdığı parol ya terminala, ya da bir
 * fayla düşərdi, hər ikisi lazımsız risqdir.
 *
 * Bu skript yalnız qaydaları yazır və TƏKRAR İŞLƏDİLƏ BİLƏR: eyni əmri iki
 * dəfə çağırmaq nəticəni dəyişmir.
 *
 *   npx tsx scripts/monitor-defaults.ts <istifadəçi-adı>
 *     --show                       heç nə yazma, hazırkı vəziyyəti göstər
 *     --visible Client,Other       bu kateqoriyalar açıq qalsın (default: Client)
 *     --days 90                    tarixçə pəncərəsi
 *     --groups-visible             qrupları da aç (default: gizli)
 *     --no-mask                    telefon nömrələri maskalanmasın
 *
 * Qayda modeli: söhbət qaydası → kateqoriya qaydası → tipə görə default
 * (bax docs/nezaret-ekrani.md).
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const username = process.argv[2];
  if (!username || username.startsWith("--")) {
    console.error("İstifadə: npx tsx scripts/monitor-defaults.ts <istifadəçi-adı> [--show]");
    process.exit(1);
  }

  const { pool } = await import("../src/lib/db");
  const { setCategoryRule, setMonitorProfile, listMonitorAccounts } = await import("../src/lib/monitor");

  const { rows } = await pool.query<{ id: number; role: string; active: boolean }>(
    `SELECT id, role, active FROM katibe.dashboard_users WHERE lower(username) = lower($1)`,
    [username],
  );
  const user = rows[0];
  if (!user) {
    console.error(`"${username}" adlı hesab yoxdur. Əvvəlcə /admin/accounts-da yarat.`);
    await pool.end();
    process.exit(1);
  }
  if (user.role !== "monitor") {
    console.error(`"${username}" hesabının rolu "${user.role}"-dir, "monitor" deyil.`);
    await pool.end();
    process.exit(1);
  }

  const { rows: cats } = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM katibe.categories ORDER BY name`,
  );

  if (!flag("show")) {
    const visible = new Set(
      (option("visible") ?? "Client").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean),
    );
    const days = Number(option("days") ?? 90);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      console.error("--days 1-3650 aralığında tam ədəd olmalıdır.");
      await pool.end();
      process.exit(1);
    }

    await setMonitorProfile(
      user.id,
      {
        historyDays: days,
        maskPhones: !flag("no-mask"),
        groupDefault: flag("groups-visible") ? "visible" : "hidden",
        directDefault: "visible",
      },
      // Qaydanı kim yazdı: skriptin sahibi yoxdur, ona görə hesabın özü yazılır
      // (sütun yalnız audit üçündür, icazə ondan gəlmir).
      user.id,
    );

    for (const cat of cats) {
      // Açıq saxlanılanlarda QAYDA SİLİNİR — "allow" yazmaq da olardı, amma o
      // zaman gələcəkdə fərdi default dəyişsə, bu kateqoriya ondan qopardı.
      const keepVisible = visible.has(cat.name.toLowerCase());
      await setCategoryRule(user.id, cat.id, keepVisible ? null : "deny", user.id);
    }
  }

  const account = (await listMonitorAccounts()).find((a) => a.userId === user.id)!;
  console.log(`\nNəzarətçi: ${account.username}${account.active ? "" : " (SÖNDÜRÜLÜB)"}`);
  console.log(
    `Profil   : son ${account.profile.historyDays} gün · nömrələr ` +
      `${account.profile.maskPhones ? "maskalanır" : "AÇIQ"} · qruplar ` +
      `${account.profile.groupDefault === "hidden" ? "gizli" : "açıq"} · fərdi ` +
      `${account.profile.directDefault === "visible" ? "açıq" : "gizli"}`,
  );
  console.log(
    `Nömrələr : ${account.instances.length === 0 ? "TƏYİN OLUNMAYIB — heç nə görmür" : account.instances.map((i) => i.instanceName).join(", ")}`,
  );
  console.log("Kateqoriyalar:");
  for (const cat of cats) {
    const rule = account.categoryRules.find((r) => r.categoryId === cat.id);
    const state = rule ? (rule.visibility === "allow" ? "açıq (qayda)" : "GİZLİ") : "açıq (default)";
    console.log(`  ${cat.name.padEnd(12)} ${state}`);
  }
  if (account.chatRules.length > 0) {
    console.log(`Söhbət qaydaları: ${account.chatRules.length} ədəd (bax /admin/monitor)`);
  }
  console.log("");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
