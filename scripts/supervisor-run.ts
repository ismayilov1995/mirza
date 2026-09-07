/**
 * Nəzarətçi agentin bir gedişatı. Cron saatda bir çağırır (iş saatlarına
 * Bakı vaxtı ilə 09-21 düşən pəncərə); koddakı iş-təqvimi qoruması qeyri-iş
 * vaxtlarında onsuz da yalnız açıq bayraqları təzələyir.
 *
 * Əl ilə:  npm run supervisor
 *   SUP_DRY_RUN=1        nə tapdığını və nəyə xərc çıxacağını yaz, HEÇ NƏ yazma
 *   SUP_WINDOW_HOURS=72  pəncərəni məcburi bu qədər geriyə aç (test üçün)
 *   SUP_INSTANCE=<id>    yalnız bu instansı yoxla
 *   SUP_REVALIDATE_ONLY=1  yalnız qopmadan qayıdan instansları yenidən yoxla
 *   SUP_MAX_LLM_CALLS=6  gedişat başına şərh çağırışı tavanı (xərc qapağı)
 *   SUP_MAX_VERIFY_CALLS=6  gedişat başına doğrulama çağırışı tavanı (Sonnet)
 *   SUP_VERIFY_MODEL=    doğrulama modeli (default claude-sonnet-5)
 *   SUP_VERIFY_TTL_HOURS=12  doğrulama nəticəsinin ömrü
 *   SUP_MODEL=           standart modeli əvəz et (default claude-haiku-4-5)
 *   SUP_MODEL_HIGH=      8+ bal üçün modeli əvəz et (default claude-sonnet-5)
 *
 * WhatsApp-a qarşı ancaq oxuyur: evolution_api cədvəllərindən SELECT,
 * yazı yalnız katibe.agent_* cədvəllərinə.
 */
import { loadEnvLocal } from "../mcp/env";

// .env.local MÜTLƏQ db.ts-dən əvvəl yüklənməlidir — src/lib/db.ts modul
// səviyyəsində DATABASE_URL oxuyur, ona görə dinamik import.
loadEnvLocal();

async function main() {
  const { runSupervisor } = await import("../src/lib/supervisor/run");
  const { pool } = await import("../src/lib/db");

  const dryRun = process.env.SUP_DRY_RUN === "1";
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    // Açar yoxdursa da gedişat işləyir — sadəcə hər şey şablon mətnlə yazılır.
    console.warn("[supervisor] ANTHROPIC_API_KEY yoxdur — bütün postlar şablon mətnlə yazılacaq.");
  }

  const windowHours = process.env.SUP_WINDOW_HOURS ? Number(process.env.SUP_WINDOW_HOURS) : undefined;
  if (windowHours !== undefined && (!Number.isFinite(windowHours) || windowHours <= 0)) {
    throw new Error(`SUP_WINDOW_HOURS düzgün deyil: ${process.env.SUP_WINDOW_HOURS}`);
  }

  const onlyRevalidating = process.env.SUP_REVALIDATE_ONLY === "1";

  await runSupervisor({
    trigger: onlyRevalidating
      ? "revalidate"
      : process.env.SUP_WINDOW_HOURS || process.env.SUP_INSTANCE
        ? "manual"
        : "cron",
    onlyRevalidating,
    windowHours,
    instanceId: process.env.SUP_INSTANCE || undefined,
    dryRun,
    maxLlmCalls: Number(process.env.SUP_MAX_LLM_CALLS ?? 6),
    maxVerifyCalls: Number(process.env.SUP_MAX_VERIFY_CALLS ?? 6),
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
