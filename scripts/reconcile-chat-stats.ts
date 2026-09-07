/**
 * Söhbət statistikasının DÖVRİ BARIŞDIRILMASI.
 *
 * katibe.chat.message_count / first_ts / last_ts və katibe.chat_source.messages /
 * last_ts denormalizasiya olunmuş sütunlardır: siyahının sıralamasını, «N mesaj»
 * sayını və yan paneldə nömrə seçiləndə sətrin içindəki son mesaj vaxtını onlar
 * verir. Yazan onları hər köçürmədə yeniləyir (mirror.ts → refreshChatStats),
 * amma ölçüldü ki, yenə də sürüşürlər.
 *
 * NİYƏ SÜRÜŞÜRLƏR. Yeniləmə TOXUNULAN söhbətlər üçün işləyir və bir SQL
 * ifadəsidir; eyni söhbət üçün iki yeniləmə üst-üstə düşəndə biri digərinin
 * nəticəsini itirə bilir (klassik lost update): A 976 sayır, B 977 sayır, B
 * yazır, sonra A 976 yazır. Vebhuk yolu mesaj gələn kimi işlədiyi üçün belə
 * üst-üstə düşmələr adi haldır.
 *
 * 2026-09-06 axşamı ölçüldü: təxminən 80 dəqiqədə 3 cüt sürüşmüşdü — hər biri
 * bir mesaj geri, birinin son mesaj vaxtı isə DOQQUZ SAAT köhnə idi. Ekranda bu,
 * söhbətin siyahıda səhv yerdə durması və «N mesaj» sayının azaldılmış
 * görünməsi deməkdir.
 *
 * NİYƏ AYRI SKRİPT. Köçürmənin özündə tam yenidən hesablama etmək olmaz: o, hər
 * 5 dəqiqədən bir işləyir və tam sayım ~5-9 saniyədir (alt çoxluq isə ~40 ms).
 * Bu skript isə saatda bir dəfə işləyir və YALNIZ təmir edir — mesaj yazmır,
 * heç nəyi köçürmür. Yəni docs/rules.md §8-in qadağan etdiyi «ayrılmış iki
 * addım» deyil: əsas yol yerindədir və dəyişmir, bu, onun üstündən keçən
 * barışdırmadır.
 *
 * WhatsApp-a qarşı heç nə etmir — yalnız öz anbarının sütunlarını yenidən sayır.
 *
 * Əl ilə:  npx tsx scripts/reconcile-chat-stats.ts
 *   RECONCILE_DRY_RUN=1   neçə sətir sürüşüb, göstər — düzəltmə
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

async function main() {
  const { pool } = await import("../src/lib/db");
  const dryRun = process.env.RECONCILE_DRY_RUN === "1";

  /* Sürüşənləri ƏVVƏL sayırıq — yoxsa «düzəldim» deyib heç nə etmədiyimizi
     bilməzdik. Rəqəm loga düşür, yəni sürüşmənin sürəti izlənə bilir. */
  const { rows: before } = await pool.query<{ chats: string; pairs: string }>(
    `WITH chat_truth AS (
       SELECT chat_id, count(*)::int AS n, min(ts) AS first_ts, max(ts) AS last_ts
         FROM katibe.message GROUP BY chat_id
     ), pair_truth AS (
       SELECT m.chat_id, ms.source_id, count(*)::int AS messages, max(m.ts) AS last_ts
         FROM katibe.message m JOIN katibe.message_source ms ON ms.message_id = m.id
        GROUP BY 1, 2
     )
     SELECT
       (SELECT count(*) FROM katibe.chat c JOIN chat_truth t ON t.chat_id = c.id
         WHERE (c.message_count, c.first_ts, c.last_ts)
               IS DISTINCT FROM (t.n, t.first_ts, t.last_ts)) AS chats,
       (SELECT count(*) FROM katibe.chat_source cs JOIN pair_truth t
               ON t.chat_id = cs.chat_id AND t.source_id = cs.source_id
         WHERE (cs.messages, cs.last_ts) IS DISTINCT FROM (t.messages, t.last_ts)) AS pairs`,
  );
  const drifted = Number(before[0].chats) + Number(before[0].pairs);

  if (dryRun) {
    console.log(
      `${before[0].chats} söhbət, ${before[0].pairs} mənbə cütü sürüşüb — QURU İŞLƏMƏ, düzəldilmədi.`,
    );
    await pool.end();
    return;
  }

  if (drifted === 0) {
    console.log("Sürüşmə yoxdur.");
    await pool.end();
    return;
  }

  const t = Date.now();
  await pool.query(`SELECT katibe.refresh_chat_stats()`);
  console.log(
    `${before[0].chats} söhbət, ${before[0].pairs} mənbə cütü düzəldildi (${Date.now() - t} ms).`,
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
