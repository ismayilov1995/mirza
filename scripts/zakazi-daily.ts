/**
 * «Zakazi Dubai Showroom» — dünənki sifarişləri cədvəl sətrinə çevirib sahibə göndərir.
 *
 * NİYƏ VAR: sahib hər səhər həmin qrupun mesajlarını əl ilə Google Sheets-ə
 * köçürürdü. Mesajların formatı sabitdir, ona görə köçürmə maşının işidir;
 * insana qalan yalnız üstdən baxıb təsdiqləməkdir.
 *
 * NİYƏ EVOLUTION-DAN YOX, KATIBE-DƏN OXUYUR: Evolution-un `Message` cədvəli
 * canlı işin cədvəlidir və köhnə sətirlər orada qalmır — həmin qrup üçün orada
 * 243, `katibe.message`-də isə 5933 mesaj var. Mirror onsuz da hər 5 dəqiqədən
 * bir işləyir; ondan oxumaq həm daha dolğundur, həm də Evolution-un yükünü
 * artırmır.
 *
 * PƏNCƏRƏ NİYƏ UTC GÜNÜDÜR: sətrin «Date of order» sütunu mesajın UTC tarixidir
 * (bax: src/lib/zakazi-parser.ts). Pəncərəni də eyni saatla götürmək lazımdır,
 * yoxsa gecə gələn sifariş ya iki dəfə düşər, ya heç düşməz.
 *
 * Run: npm run zakazi:daily
 *      ZAKAZI_DAYS=7 npm run zakazi:daily     (7 gün geriyə)
 *      ZAKAZI_DRY=1 npm run zakazi:daily      (göndərmədən, faylı yalnız yazır)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

/*
 * Qrupun JID-i env-dən gəlir, kodda default YOXDUR. Default olsaydı, açar
 * təyin edilməmiş hər maşın — başqasının forku da daxil — sükutla bir konkret
 * qrupu oxumağa çalışardı. Yanlış qrupu oxumaqdansa dayanmaq yaxşıdır.
 */
const GROUP_JID = process.env.ZAKAZI_GROUP_JID;
if (!GROUP_JID) {
  throw new Error(
    "ZAKAZI_GROUP_JID .env.local-da yoxdur — sifarişlərin oxunacağı qrupun JID-i " +
      '("<nömrə>-<timestamp>@g.us") təyin olunmalıdır.',
  );
}
const OUT_DIR = "/var/www/katibe-dashboard/logs/zakazi";
const STATE_FILE = join(OUT_DIR, "state.json");

/**
 * Sifariş nömrəsinin sayğacı.
 *
 * Cədvəl həqiqətin mənbəyidir, amma onu oxuya bilmirik — ona görə sayğac burada
 * saxlanılır. Sahib cədvəldə nömrəni əl ilə dəyişsə (silinmiş sətir, atlanmış
 * nömrə) bu fayldakı `seq` düzəldilməlidir; əks halda bir neçə gün sonra
 * nömrələr sürüşür. Buna görə hər gedişdə istifadə olunan aralıq loga və
 * WhatsApp qeydinə yazılır — sürüşmə gözə dəysin deyə.
 */
type State = { month: string; seq: number };

function readState(month: string): State {
  if (!existsSync(STATE_FILE)) {
    const seed = Number(process.env.ZAKAZI_SEQ_SEED ?? 0);
    return { month, seq: seed };
  }
  const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  return s.month === month ? s : { month, seq: 0 };
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const { parseOrderMessage, dedupeReposts, assignOrderNumbers, reviewNotes, toCsv } =
    await import("../src/lib/zakazi-parser");

  const days = Math.max(1, Math.min(120, Number(process.env.ZAKAZI_DAYS ?? 1)));
  const now = new Date();
  const endUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  const startUtc = endUtc - days * 86_400;

  const { rows: msgs } = await pool.query<{ ts: number; body: string }>(
    `SELECT ts, body
       FROM katibe.message
      WHERE remote_jid = $1
        AND body IS NOT NULL
        AND ts >= $2 AND ts < $3
      ORDER BY ts`,
    [GROUP_JID, startUtc, endUtc],
  );

  const label = new Date(startUtc * 1000).toISOString().slice(0, 10) +
    (days > 1 ? ` … ${new Date((endUtc - 1) * 1000).toISOString().slice(0, 10)}` : "");
  console.log(`${label} — ${msgs.length} mətn mesajı`);

  const month = new Date(startUtc * 1000).toISOString().slice(2, 7).replace("-", "");
  const state = readState(month);
  let seq = state.seq;

  const parsed = [];
  for (const m of msgs) {
    const row = parseOrderMessage(m.body, m.ts, "");
    if (row) parsed.push(row);
  }
  // Nömrə DEDUPE-dan sonra verilir: səhv göndərilib düzəldilmiş sifariş bir
  // nömrə tutmalıdır, yoxsa hər düzəliş cədvəldə nömrə boşluğu yaradır.
  const merged = dedupeReposts(parsed);
  const rows = assignOrderNumbers(merged, seq);
  seq += rows.length;
  if (merged.length < parsed.length) {
    console.log(`${parsed.length - merged.length} təkrar göndəriş birləşdirildi`);
  }

  if (rows.length === 0) {
    console.log("Sifariş mesajı yoxdur — heç nə göndərilmir.");
    await pool.end();
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date(startUtc * 1000).toISOString().slice(0, 10);
  const file = join(OUT_DIR, `zakazi-${stamp}.csv`);
  writeFileSync(file, toCsv(rows, true), "utf8");
  console.log(`${rows.length} sətir → ${file}`);

  const orders = rows.filter((r) => r.kind === "sifariş");
  const services = rows.length - orders.length;
  const totalAed = orders.reduce((a, r) => a + (Number(r.Amount) || 0), 0);
  const flagged = rows
    .map((r) => ({ r, notes: reviewNotes(r) }))
    .filter((x) => x.notes.length > 0);

  const caption = [
    `📥 Zakazi Dubai Showroom — ${label}`,
    ``,
    `${orders.length} sifariş${services ? ` + ${services} xidmət/doplata` : ""}`,
    `Cəmi: ${totalAed.toLocaleString("en-US")} AED`,
    `Nömrələr: ${rows[0].Order} … ${rows[rows.length - 1].Order}`,
    ``,
    flagged.length
      ? `⚠️ ${flagged.length} sətrə bax:\n` +
        flagged.slice(0, 8).map((x) => `• ${x.r.Name} — ${x.notes.join(", ")}`).join("\n") +
        (flagged.length > 8 ? `\n• … və ${flagged.length - 8} sətir daha` : "")
      : `✅ Bütün sətirlərin sahələri doludur.`,
    ``,
    `Paid / Debt / Shipped / Deadline sütunları həmişəki kimi səndə qalır.`,
  ].join("\n");

  if (process.env.ZAKAZI_DRY === "1") {
    console.log("\n--- DRY RUN, göndərilmir ---\n" + caption);
    await pool.end();
    return;
  }

  const { sendOwnerDocument } = await import("../src/lib/evolution");
  const instanceName = process.env.EVOLUTION_INSTANCE_NAME;
  const ownerNumber = process.env.ZAKAZI_OWNER_NUMBER;
  if (!instanceName || !ownerNumber) {
    throw new Error("EVOLUTION_INSTANCE_NAME / ZAKAZI_OWNER_NUMBER .env.local faylında yoxdur.");
  }

  await sendOwnerDocument({
    instanceName,
    ownerNumber,
    fileName: `zakazi-${stamp}.csv`,
    mimetype: "text/csv",
    base64: readFileSync(file).toString("base64"),
    caption,
  });
  console.log("WhatsApp-a göndərildi.");

  // Sayğac YALNIZ uğurlu göndərişdən sonra yazılır: göndəriş alınmayıbsa
  // sabahkı gediş eyni nömrələrdən başlamalıdır, yoxsa cədvəldə boşluq qalır.
  writeFileSync(STATE_FILE, JSON.stringify({ month, seq }, null, 2), "utf8");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
