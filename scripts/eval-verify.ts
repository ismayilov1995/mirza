/**
 * Bayraq doğrulamasının (verify.ts) sonradan yoxlanması.
 *
 * NİYƏ ƏL İLƏ ETİKETLƏNMİŞ DƏST YOX. eval-intent.ts-də suala insan cavab
 * verməlidir ("bu cümlə şikayətdirmi"). Burada isə cavabı HƏYAT verir:
 * doğrulama "bu müştəri cavab gözləmir" dediyi halda müştəri bir azdan
 * yenidən yazıbsa — deməli gözləyirmiş. Bu, uydurulmuş etiket deyil, baş
 * vermiş hadisədir; ona görə dəst öz-özünə böyüyür və heç nəyə mal olmur.
 *
 * ÖLÇÜLƏN ƏSAS RƏQƏM — YANLIŞ SUSDURMA. Doğrulamanın yeganə təhlükəli səhvi
 * budur: HIGH əminliklə "gözləmir" deyib balı 5-ə endirmək, halbuki müştəri
 * gözləyirmiş. Səhvin o biri istiqaməti (artıq qalan bayraq) bir kliklə
 * bağlanır — bu isə gözə görünmür. Ona görə hesabatın başlığı odur.
 *
 * SÜBUTUN SIRASI VACİBDİR: müştərinin yenidən yazması yalnız BİZİM növbəti
 * cavabımızdan ƏVVƏL olduqda "gözləyirmiş" sayılır. Biz cavab verdikdən sonra
 * yazması adi söhbətin davamıdır və heç nəyi təkzib etmir.
 *
 * VƏ PƏNCƏRƏ LAZIMDIR. İlk versiyada vaxt həddi yox idi və rəqəm 38% çıxdı;
 * bölgüyə baxanda məlum oldu ki, o 9 halın 5-i qərardan sonra 45 dəqiqə
 * ərzində, 4-ü isə 13-120 saat sonra baş verib. İki gün sonra gələn mesaj
 * qərarı təkzib etmir — o, sadəcə yeni söhbətdir. Ona görə sübut EVAL_NUDGE
 * saatı ilə məhdudlanır; həddən kənar hallar ayrıca sətirdə göstərilir ki,
 * pəncərənin özü də gözlə yoxlana bilsin.
 *
 * İKİNCİ ÖLÇÜ — ÖZ-ÖZÜNÜ TƏKZİB. Model "top bizim tərəfdədir" yazıb sonra
 * "cavab gözləmir" deyirsə, bu, nəticəsini gözləməyə ehtiyac olmayan səhvdir:
 * cavabın öz içində görünür. Ölçmə ilk dəfə işlədiləndə 51 qərarın 4-ü belə
 * idi və verify.ts promptuna bunu qadağan edən bənd əlavə olundu.
 *
 * MODEL ÇAĞIRILMIR — sıfır xərc. "Eyni söhbətləri indi yenidən soruşaq"
 * variantı qəsdən yoxdur: söhbətlər o vaxtdan dəyişib, yəni cavab köhnə
 * qərarla müqayisə oluna bilməz — ölçdüyünü ölçmədiyi halda ölçmək olardı.
 *
 * İşə salmaq:  npm run eval:verify
 *   EVAL_DAYS=30      neçə günlük doğrulamaya baxılsın (default 30)
 *   EVAL_SETTLE=24    doğrulamadan sonra nəticənin yetişməsi üçün saat (default 24)
 *   EVAL_NUDGE=6      müştərinin yenidən yazması bu qədər saat içində sübutdur (default 6)
 */
import { loadEnvLocal } from "../mcp/env";

loadEnvLocal();

interface Row {
  id: string;
  state: string;
  confidence: string;
  severity: number;
  contact: string | null;
  reason: string | null;
  we_replied: boolean;
  nudged_first: boolean;
  /** Sübut pəncərəsindən KƏNARDA yazıb — yəni yeni söhbət, təkzib deyil. */
  nudged_late: boolean;
  /** Model öz səbəbində işin bizdə olduğunu yazıb, amma «gözləmir» deyib. */
  self_contradiction: boolean;
  closed_reason: string | null;
}

async function main() {
  const { pool } = await import("../src/lib/db");
  const days = Number(process.env.EVAL_DAYS ?? 30);
  const settleHours = Number(process.env.EVAL_SETTLE ?? 24);
  const nudgeHours = Number(process.env.EVAL_NUDGE ?? 6);

  const { rows } = await pool.query<Row>(
    `WITH v AS (
       SELECT p.id, p.instance_id, p.remote_jid, p.verified_at, p.verify_state AS state,
              p.verify_confidence AS confidence, p.severity, p.closed_reason,
              p.evidence->>'contact' AS contact, p.verify_reason AS reason,
              EXTRACT(epoch FROM p.verified_at)::bigint AS verdict_ts
         FROM katibe.agent_posts p
        WHERE p.verify_state IS NOT NULL
          AND p.remote_jid IS NOT NULL
          AND p.verified_at > now() - make_interval(days => $1::int)
          AND p.verified_at < now() - make_interval(hours => $2::int)
     ),
     after AS (
       SELECT v.*,
              (SELECT MIN(m."messageTimestamp") FROM evolution_api."Message" m
                WHERE m."instanceId" = v.instance_id AND m.key->>'remoteJid' = v.remote_jid
                  AND (m.key->>'fromMe')::boolean
                  AND m."messageTimestamp" > v.verdict_ts) AS our_next_ts,
              (SELECT MIN(m."messageTimestamp") FROM evolution_api."Message" m
                WHERE m."instanceId" = v.instance_id AND m.key->>'remoteJid' = v.remote_jid
                  AND NOT (m.key->>'fromMe')::boolean
                  AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
                  AND m."messageTimestamp" > v.verdict_ts) AS their_next_ts
         FROM v
     )
     SELECT id, state, confidence, severity, contact, reason, closed_reason,
            our_next_ts IS NOT NULL AS we_replied,
            -- «Gözləyirmiş»in sübutu: bizim cavabımızdan ƏVVƏL VƏ pəncərə
            -- daxilində yenidən yazıb.
            (their_next_ts IS NOT NULL
             AND (our_next_ts IS NULL OR their_next_ts < our_next_ts)
             AND their_next_ts - verdict_ts <= $3::int * 3600) AS nudged_first,
            (their_next_ts IS NOT NULL
             AND (our_next_ts IS NULL OR their_next_ts < our_next_ts)
             AND their_next_ts - verdict_ts > $3::int * 3600) AS nudged_late,
            (state = 'NOT_WAITING'
             AND reason ~* 'top bizim tərəf|növbəsi bizdə|növbəti addım bizim|bizim tərəfimizdədir|biz verəcək|biz göndərəcək'
             -- «top bizim tərəfdə DEYİL» tam əks məna daşıyır və düzgün
             -- NOT_WAITING-dir; inkarı çıxarmasaq ölçü öz-özünü şişirdərdi.
             AND reason !~* 'bizim tərəfdə deyil|bizdə deyil') AS self_contradiction
       FROM after
      ORDER BY id`,
    [days, settleHours, nudgeHours],
  );

  if (rows.length === 0) {
    console.log(`Son ${days} gündə yetişmiş doğrulama tapılmadı.`);
    await pool.end();
    return;
  }

  const bucket = (s: string, c?: string) =>
    rows.filter((r) => r.state === s && (c === undefined || r.confidence === c));

  const notWaitingHigh = bucket("NOT_WAITING", "HIGH");
  const falseSilence = notWaitingHigh.filter((r) => r.nudged_first);
  const notWaitingAll = bucket("NOT_WAITING");
  const waiting = bucket("WAITING");
  const waitingActed = waiting.filter((r) => r.we_replied || r.nudged_first);
  const unclear = bucket("UNCLEAR");

  const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(0)}%`);

  console.log(`\nDoğrulama hesabatı — son ${days} gün, ${settleHours} saat yetişmə payı ilə`);
  console.log(`Yetişmiş doğrulama: ${rows.length}\n`);

  console.log("YANLIŞ SUSDURMA (əsas rəqəm)");
  console.log(
    `  HIGH əminlikli «cavab gözləmir»: ${notWaitingHigh.length}` +
      `, bunlardan ${falseSilence.length}-ində müştəri ${nudgeHours} saat içində, biz cavab vermədən ` +
      `yenidən yazıb = ${pct(falseSilence.length, notWaitingHigh.length)}`,
  );
  console.log(
    `  (yalnız bu qrup bala təsir edir — bal 5-ə enir, bayraq sancaqdan çıxır)`,
  );
  console.log(
    `  Pəncərədən kənar (${nudgeHours} saatdan sonra yazanlar, təkzib SAYILMIR): ` +
      `${notWaitingHigh.filter((r) => r.nudged_late).length}\n`,
  );

  const contradictions = rows.filter((r) => r.self_contradiction);
  console.log("ÖZ-ÖZÜNÜ TƏKZİB");
  console.log(
    `  Səbəbdə «iş bizim tərəfdədir» yazıb, amma «gözləmir» deyib: ` +
      `${contradictions.length}/${notWaitingAll.length}` +
      ` = ${pct(contradictions.length, notWaitingAll.length)}\n`,
  );

  console.log("BÖLGÜ");
  for (const state of ["WAITING", "NOT_WAITING", "UNCLEAR"]) {
    for (const conf of ["HIGH", "MEDIUM", "LOW"]) {
      const b = bucket(state, conf);
      if (b.length === 0) continue;
      const nudged = b.filter((r) => r.nudged_first).length;
      const replied = b.filter((r) => r.we_replied).length;
      console.log(
        `  ${state.padEnd(12)} ${conf.padEnd(7)} ${String(b.length).padStart(4)} ` +
          `· sonra müştəri yazıb ${String(nudged).padStart(3)} · biz cavab vermişik ${String(replied).padStart(3)}`,
      );
    }
  }

  console.log("\nİKİNCİ RƏQƏMLƏR");
  console.log(
    `  «gözləyir» deyilib və sonra doğrudan iş olub (biz yazmışıq və ya o yazıb): ` +
      `${waitingActed.length}/${waiting.length} = ${pct(waitingActed.length, waiting.length)}`,
  );
  console.log(
    `  «gözləmir» deyilib və heç nə olmayıb (nə biz, nə o): ` +
      `${notWaitingAll.filter((r) => !r.we_replied && !r.nudged_first).length}/${notWaitingAll.length}`,
  );
  console.log(`  «aydın deyil»: ${unclear.length}`);

  if (falseSilence.length > 0) {
    console.log("\nYANLIŞ SUSDURULMUŞ SÖHBƏTLƏR");
    for (const r of falseSilence.slice(0, 15)) {
      console.log(`  [${r.id}] ${r.contact ?? "-"} — model: "${r.reason ?? ""}"`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
