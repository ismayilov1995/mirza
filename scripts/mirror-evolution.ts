/**
 * Mirrors Evolution's messages into Katibe's own store.
 *
 * Stage one of the move away from reading evolution_api directly. This writes
 * katibe.message and never reads it back — every existing query still goes to
 * Evolution, so a mistake here cannot show a user anything wrong. The
 * comparison that proves the two agree comes next, and the cut-over after
 * that.
 *
 * IDEMPOTENT BY CONSTRUCTION, which is the whole requirement: running it twice
 * changes nothing, an interrupted run resumes where it stopped, and a message
 * already carried by another source gains a link rather than a duplicate. It
 * finds its work by anti-joining katibe.message_source, so "what is left to do"
 * is a fact about the data rather than a checkpoint someone has to keep.
 *
 * Read-only with respect to WhatsApp: it copies rows Baileys already stored.
 *
 * Run:  npm run mirror:evolution
 *   MIRROR_INSTANCE=<id>     only this instance (default: every instance)
 *   MIRROR_BATCH=5000        rows per pass (default 5000)
 *   MIRROR_MAX=0             ceiling per run, 0 = no ceiling (default 0)
 *   MIRROR_DRY_RUN=1         report what is pending, write nothing
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

async function main() {
  /* Dinamik idxal, statik yox: db.ts yüklənəndə DATABASE_URL artıq mühitdə
     olmalıdır, yəni loadEnvLocal()-dan SONRA. Sorğunun özü
     src/lib/mirror.ts-dədir — eyni köçürməni vebhuk da çağırır. */
  const { pool } = await import("../src/lib/db");
  const { ALREADY_MIRRORED_SQL, COPYABLE_SQL, mirrorBatch, mirrorBucket, refreshChatStats } =
    await import("../src/lib/mirror");

  const only = process.env.MIRROR_INSTANCE;
  const batchSize = Number(process.env.MIRROR_BATCH ?? 5000);
  const maxRows = Number(process.env.MIRROR_MAX ?? 0);
  const dryRun = process.env.MIRROR_DRY_RUN === "1";
  /* Obyekt açarından kəsilən bucket adı — media ünvanı yol üslubundadır. */
  const bucket = mirrorBucket();
  if (!bucket) throw new Error("S3_BUCKET yoxdur — media açarı düzgün yazıla bilməz.");

  const { rows: instances } = await pool.query(
    `SELECT DISTINCT "instanceId" AS id FROM evolution_api."Message"
      WHERE ($1::text IS NULL OR "instanceId" = $1) ORDER BY 1`,
    [only ?? null],
  );
  if (instances.length === 0) {
    console.log("İnstans tapılmadı.");
    await pool.end();
    return;
  }

  // Every Evolution instance is a source. Ownership stays in
  // katibe.user_instances, which already records it — duplicating it here
  // would give us two answers to one question.
  if (!dryRun) {
    for (const { id } of instances as { id: string }[]) {
      await pool.query(
        `INSERT INTO katibe.source (id, kind, label)
         VALUES ($1, 'evolution', $1)
         ON CONFLICT (id) DO NOTHING`,
        [id],
      );
    }
  }

  let grandTotal = 0;
  /* Bütün instanslar üzrə toxunulan söhbətlər. Set, çünki eyni söhbət bir
     neçə dəstədə və bir neçə instansda görünə bilər. */
  const touchedChats = new Set<number>();
  for (const { id } of instances as { id: string }[]) {
    const { rows: pend } = await pool.query(
      /* Süzgəc aşağıdakı köçürmə sorğusu ilə EYNİ olmalıdır, yoxsa sayğac
         heç vaxt köçürülməyəcək sətirləri «gözləyir» kimi göstərir: reaksiya
         və protokol mesajları silinəndən sonra say 1 059-da ilişib qalmışdı. */
      `SELECT count(*)::int AS n FROM evolution_api."Message" m
        WHERE m."instanceId" = $1
          AND m.key->>'id' IS NOT NULL
          AND ${COPYABLE_SQL}
          AND NOT ${ALREADY_MIRRORED_SQL}`,
      [id],
    );
    const pending = pend[0].n as number;
    console.log(`${id}: ${pending} mesaj gözləyir${dryRun ? " · QURU İŞLƏMƏ" : ""}`);
    if (dryRun || pending === 0) continue;

    const { rows: runRow } = await pool.query(
      `INSERT INTO katibe.import_run (source_id, input) VALUES ($1, $2) RETURNING id`,
      [id, `evolution_api.Message (${pending} gözləyir)`],
    );
    const runId = runRow[0].id as string;
    let done = 0;

    try {
      for (;;) {
        if (maxRows > 0 && grandTotal >= maxRows) break;
        const want = maxRows > 0 ? Math.min(batchSize, maxRows - grandTotal) : batchSize;

        // Bir ifadə, bir dəstə: ya bütöv düşür, ya heç
        // (src/lib/mirror.ts).
        const res = await mirrorBatch(id, want, bucket);

        const read = res.read;
        if (read === 0) break;
        /*
         * İRƏLİLƏYİŞ YOXDURSA DAYAN.
         *
         * `read > 0` amma bir dənə də YENİ mənbə əlaqəsi yazılmayıbsa, növbəti
         * gediş eyni sətirləri tapacaq — yəni bu döngə sonsuzdur. Səbəbi
         * ALREADY_MIRRORED_SQL-də düzəldildi, bu isə ikinci müdafiə xəttidir:
         * bir daha eyni tələyə düşsək, skript 4 saat işləyib serveri
         * boğmaqdansa dərhal dayanıb səbəbi yazacaq.
         *
         * `res.linked`-ə baxmaq İŞLƏMİR: ON CONFLICT qolu da sətir qaytarır,
         * ona görə ilişmiş halda belə sıfırdan böyük olur.
         */
        if (res.linkedNew === 0) {
          console.warn(
            `\n  ${id} — DAYANDIRILDI: ${read} sətir oxundu, yeni əlaqə yazılmadı.` +
              ` Bu sətirlər köçürülə bilmir; gediş sonsuz döngəyə düşməsin deyə kəsildi.`,
          );
          break;
        }
        done += read;
        grandTotal += read;
        /* Statistika yalnız bunlar üçün yenilənəcək — aşağıda, gedişin
           sonunda. Dəstə-dəstə çağırmaq eyni söhbəti dəfələrlə saydırardı. */
        for (const c of res.chatIds) touchedChats.add(c);
        await pool.query(
          `UPDATE katibe.import_run
              SET read_count = read_count + $2, inserted = inserted + $3
            WHERE id = $1`,
          [runId, read, res.linked],
        );
        process.stdout.write(`\r  ${done}/${pending}        `);
      }
      await pool.query(
        `UPDATE katibe.import_run SET status='ok', finished_at=now() WHERE id=$1`,
        [runId],
      );
      console.log(`\r  ${id} — ${done} mesaj köçürüldü.${" ".repeat(12)}`);
    } catch (e) {
      await pool.query(
        `UPDATE katibe.import_run
            SET status='failed', finished_at=now(), error=$2 WHERE id=$1`,
        [runId, (e as Error).message.slice(0, 500)],
      );
      throw e;
    }
  }

  /*
   * Statistikanı YAZAN yeniləyir.
   *
   * katibe.chat.message_count / first_ts / last_ts sütunları siyahının
   * sıralamasını və "N mesaj" saylarını verir, amma onları bu skript
   * pozur — mesaj yazılır, sütun köhnə qalır. Əvvəl refresh_chat_stats()
   * heç yerdən çağırılmırdı: 2026-08-31-də səhər əl ilə işlədilib, sonra
   * gün boyu 3 060 mesaj köçürülməmiş qalıb və 207 söhbətin sayları
   * sürüşmüşdü. İndi köçürmə ilə yeniləmə bir yerdədir, yəni ayrılmaları
   * mümkün deyil.
   *
   * YALNIZ TOXUNULAN SÖHBƏTLƏR. Əvvəl arqumentsiz çağırılırdı, yəni hər
   * gedişdə bütün anbar yenidən sayılırdı — ölçüldü: 8 947 ms, halbuki
   * toxunulan 5 söhbət üçün eyni iş 236 ms çəkir (38 dəfə). Beş dəqiqədə bir
   * doqquz saniyəlik tam sayım 2 nüvəli maşında ödənilməz idi; `mirrorBatch`
   * onsuz da hansı söhbətlərə toxunduğunu qaytarırdı, sadəcə burada atılırdı.
   * Vebhuk yolu (mirrorNow) elə əvvəldən alt çoxluğu işlədirdi — indi iki yol
   * eyni davranır.
   *
   * Alt çoxluq variantı `chat_source`-dan SİLMİR (sql/2026-09-05_…): «bu
   * cütün mesajı qalmayıb» sualına yalnız tam sorğu cavab verə bilər. Bu,
   * itki deyil — mesaj silinməsi yeganə real yolda, instans silinməsində baş
   * verir və orada `chat_source`-un hər iki xarici açarı ON DELETE CASCADE-dir
   * (chat_id → chat, source_id → source), yəni sətirlər onsuz da gedir. Tam
   * variantın öz şərhi də bunu deyir: silmə «gözlədiyimiz hal üçün deyil».
   *
   * Yalnız nəsə yazılıbsa işə düşür: boş gedişdə ödəniləsi bir şey yoxdur.
   */
  if (!dryRun && touchedChats.size > 0) {
    const t = Date.now();
    await refreshChatStats([...touchedChats]);
    console.log(
      `Söhbət statistikası yeniləndi — ${touchedChats.size} söhbət (${Date.now() - t} ms).`,
    );
  }

  if (!dryRun) {
    const { rows: tot } = await pool.query(
      `SELECT (SELECT count(*) FROM katibe.message) AS msg,
              (SELECT count(*) FROM katibe.chat) AS chat,
              (SELECT count(*) FROM katibe.message_source) AS link`,
    );
    console.log(
      `Bitdi — anbarda ${tot[0].msg} mesaj, ${tot[0].chat} söhbət, ${tot[0].link} mənbə əlaqəsi.`,
    );
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
