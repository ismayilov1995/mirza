/**
 * Söhbət hallarının təsnifatı — backfill və əl ilə işə salma.
 *
 * Sabit rejimdə bunu Nəzarətçi gedişatı özü edir (yalnız təzə mesajı olan
 * söhbətlər); bu skript ilkin doldurma və yoxlama üçündür.
 *
 *   npm run classify:states
 *     STATE_DRY_RUN=1      neçə söhbət, neçə çağırış, təxmini token — yazmadan
 *     STATE_SINCE_DAYS=90  pəncərə (default 90)
 *     STATE_MAX_CHATS=1500 bir işə salmada tavan (default 1500)
 *     STATE_INSTANCE=<id>  yalnız bu instans
 *     STATE_IDENTITY_BACKFILL=1  artıq təsnif olunmuş, amma kimlik ipucusu
 *                                oxunmamış söhbətləri bir dəfə gəz
 *     STATE_FLAGGED_ONLY=1       açıq bayrağı olan söhbətləri halı təzə olsa
 *                                da yenidən oxu (yeni hal əlavə ediləndən
 *                                sonra köhnə bayraqları düzəltmək üçün)
 *
 * WhatsApp-a qarşı ancaq oxuyur; yazı yalnız katibe.chat_state-ə.
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

async function main() {
  const { getSalesInstances } = await import("../src/lib/supervisor/scope");
  const { findStaleChats, classifyChats } = await import("../src/lib/supervisor/chat-state");
  const { systemScope } = await import("../src/lib/access");
  const { pool } = await import("../src/lib/db");

  const dryRun = process.env.STATE_DRY_RUN === "1";
  const sinceDays = Number(process.env.STATE_SINCE_DAYS ?? 90);
  const maxChats = Number(process.env.STATE_MAX_CHATS ?? 1500);
  // Kimlik backfill-i: halı onsuz da təzə olan, amma chat_identity sətri
  // olmayan söhbətləri bir dəfə gəzir (bax findStaleChats).
  const missingIdentity = process.env.STATE_IDENTITY_BACKFILL === "1";
  const flaggedOnly = process.env.STATE_FLAGGED_ONLY === "1";
  if (!dryRun && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing in env");

  let instances = await getSalesInstances();
  if (process.env.STATE_INSTANCE) instances = instances.filter((i) => i.instanceId === process.env.STATE_INSTANCE);

  const totals = { classified: 0, escalated: 0, llmCalls: 0, inTok: 0, outTok: 0 };
  for (const inst of instances) {
    const stale = await findStaleChats(systemScope(inst.instanceId), {
      sinceDays,
      limit: maxChats,
      missingIdentity,
      flaggedOnly,
    });
    console.log(`${inst.userName}/${inst.instanceName}: ${stale.length} söhbət təsnifat gözləyir${dryRun ? " (DRY RUN)" : ""}`);
    if (stale.length === 0) continue;
    const s = await classifyChats(systemScope(inst.instanceId), stale, { dryRun });
    totals.classified += s.classified;
    totals.escalated += s.escalated;
    totals.llmCalls += s.llmCalls;
    totals.inTok += s.inputTokens;
    totals.outTok += s.outputTokens;
    if (!dryRun) {
      console.log(
        `  yazıldı: ${s.classified} hal (${s.escalated} Sonnet eskalasiyası, ${s.failedBatches} uğursuz partiya)`,
      );
    }
  }

  if (!dryRun && totals.llmCalls > 0) {
    // Qarışıq Haiku/Sonnet olduğundan dəqiq bölgü çağırış içindədir; yuxarı
    // sərhəd kimi Sonnet qiyməti ilə də göstəririk.
    const haiku = (totals.inTok / 1e6) * 1 + (totals.outTok / 1e6) * 5;
    const sonnet = (totals.inTok / 1e6) * 3 + (totals.outTok / 1e6) * 15;
    console.log(
      `Bitdi: ${totals.classified} hal, ${totals.llmCalls} çağırış, giriş ${totals.inTok.toLocaleString("az-AZ")} / çıxış ${totals.outTok.toLocaleString("az-AZ")} token — $${haiku.toFixed(3)}–$${sonnet.toFixed(3)} arası (qarışıq model)`,
    );
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
