import { pool } from "../db";
import type { ScopedInstanceId } from "../access";
import { SNOOZE_DAY_OPTIONS, type SnoozeDays } from "./snooze-options";
import type { Finding } from "./types";

// Müddət siyahısı brauzerə də lazımdır, ona görə ayrı fayldadır (bax orada).
export { SNOOZE_DAY_OPTIONS };
export type { SnoozeDays };

/*
 * Menecerin bayrağa verdiyi 1-5 qiymət, ondan doğan susdurma və susdurmanın
 * audit jurnalı.
 *
 * Niyə "Həll edildi" kifayət etmirdi: o düymə bayrağı bağlayır, amma problem
 * davam edirsə detektor onu növbəti gedişatda TƏZƏ post kimi açır — bu, qəsdən
 * belədir (persist.ts dedupe qaydası), çünki bağlamaq "gördüm" deməkdir,
 * "bir daha yazma" yox. Nəticədə heç vaxt bayraq olmamalı olan hal hər saat
 * qayıdırdı və düymə çarəsiz görünürdü.
 *
 * Reytinq həmin boşluğu doldurur və İKİ ayrı iş görür:
 *   1 = "bu ümumiyyətlə bayraq olmamalıydı" → post bağlanır VƏ həmin
 *       söhbət+detektor üçün susdurma açılır;
 *   2-5 = yalnız qiymətdir. Bayrağa TOXUNMUR: bağlanmır, sancağı düşmür,
 *       növbəti gedişatda yenə lazımdırsa yenə görünür. 5 xüsusi hal deyil,
 *       sadəcə datasetin "bu doğru bayraq idi" tərəfidir.
 *
 * XÜLASƏ ÜÇÜN MODEL ÇAĞIRILMIR. Postun başlığı və mətni onsuz da modelin
 * yazdığı xülasədir; onu ikinci dəfə xülasə etmək pul verib məlumat itirmək
 * olardı. Menecerin qeydi varsa əvvələ qoyulur — susdurmanın SƏBƏBİ odur.
 */

export const RATING_LABELS: Record<number, string> = {
  1: "Lazımsız",
  2: "Zəif",
  3: "Orta",
  4: "Faydalı",
  5: "Vacib",
};

/** Susdurmanın standart ömrü. Söhbət aylar sonra tamam başqa vəziyyətə düşür. */
const SUPPRESSION_DAYS = 30;

/**
 * Susdurmanı yandan keçən eskalasiya həddi: yeni tapıntının balı rədd
 * anındakından bu qədər yüksəkdirsə, susdurma işləmir.
 */
const ESCALATION_MARGIN = 2;

/**
 * Möhlət SON GÜNÜN SƏHƏRİ, saat 09:00-da bitir (Bakı vaxtı) — klikdən N×24
 * saat sonra yox.
 *
 * Səbəb praktikdir: 15:00-da verilən 3 günlük möhlət dəqiq saatla hesablansa,
 * nəticə üçüncü gün 15:00-da çıxardı — iş gününün ortasında, artıq başlanmış
 * planın üstünə. 09:00 isə həmin günün ilk gedişatıdır: nəticə səhər masaya
 * gəlir və gün ona görə qurulur. Gecə 23:00-da qayıdıb səhərə qədər lentin
 * başında oturan bayraq isə heç kimə heç nə demir.
 *
 * Hesablama Postgres-də və Bakı təqvimi ilə aparılır, JS-də yox: server UTC-də
 * işləyir və «günün əvvəli» sualının cavabı istifadəçinin təqvimindədir.
 */
function snoozeExpirySql(param: string): string {
  return `(date_trunc('day', now() AT TIME ZONE 'Asia/Baku')
             + make_interval(days => ${param}::int, hours => 9)) AT TIME ZONE 'Asia/Baku'`;
}

/**
 * Möhlət bitəndən sonra nəticəni nə qədər gözləyirik.
 *
 * Müddət bitir, susdurma ləğv olunur — amma «problem davam edir» hökmünü
 * verən ləğv deyil, növbəti gedişatda bayrağın HƏQİQƏTƏN qayıtmasıdır. Bu
 * pəncərə həmin gözləmənin sərhədidir: içində qayıdan bayraq pozulmuş möhlət
 * sayılır, sonra qayıdan isə təzə hadisə.
 *
 * 48 saat təsadüfi deyil: gedişat yalnız nəzarət saatlarında post açır, ona
 * görə cümə axşamı bitən möhlətin nəticəsi bəzən şənbəyə, bəzən bazar ertəsinə
 * düşür. Daha qısa pəncərə həmin halları «möhlət tutdu» kimi yazardı — düymə
 * isə əslində işləməmişdi.
 */
const SNOOZE_OUTCOME_GRACE_HOURS = 48;

export interface Suppression {
  id: number;
  instanceId: string;
  remoteJid: string;
  detector: string;
  summary: string;
  baseSeverity: number;
  createdAt: string;
  /** Daimi susdurmada müddət yoxdur — bax `permanent`. */
  expiresAt: string | null;
  /**
   * «Bir daha göstərmə». Müddəti bitmir, eskalasiya klapanı işləmir və model
   * rəyi soruşulmur; yalnız insan ləğv edə bilər (gate.ts).
   */
  permanent: boolean;
  /**
   * Möhlət: neçə günlük söz verilib. NULL = adi susdurma.
   *
   * Susdurmadan fərqi müddətdə deyil, BİTİŞDƏDİR: adi susdurma səssizcə
   * bitir, möhlət isə nəticə hesabatı ilə (SNOOZE_BROKEN / SNOOZE_KEPT).
   */
  snoozeDays: number | null;
}

export interface RateResult {
  /** Reytinq 1 idisə və susdurma açıldısa, onun ID-si. */
  suppressionId: number | null;
  /** Post bağlandı (yalnız reytinq 1). */
  closed: boolean;
}

/**
 * Postu qiymətləndirir. Reytinq 1-də əlavə olaraq postu bağlayır və susdurma
 * açır.
 *
 * İcazə çağıran tərəfdə (agent-actions.ts) yoxlanılır: reytinq YALNIZ
 * admin-dədir — susdurma bayrağı gözdən gizlədə bilən yeganə mexanizmdir,
 * ona görə viewer/Sales onu işə sala bilməz.
 */
export async function ratePost(
  postId: number,
  rating: number,
  note: string | null,
  ratedBy: number,
): Promise<RateResult> {
  const { rows } = await pool.query(
    `SELECT id, agent, instance_id, remote_jid, detector, base_severity, title, body, acknowledged_at
     FROM katibe.agent_posts WHERE id = $1`,
    [postId],
  );
  if (rows.length === 0) return { suppressionId: null, closed: false };
  const post = rows[0];

  const summary =
    rating === 1
      ? [
          note?.trim() ? `Menecerin qeydi: ${note.trim()}` : null,
          String(post.title),
          String(post.body),
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4000)
      : null;

  await pool.query(
    `INSERT INTO katibe.agent_post_ratings (agent_post_id, rating, summary, note, rated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (agent_post_id) DO UPDATE SET
       previous_rating = katibe.agent_post_ratings.rating,
       rating = EXCLUDED.rating,
       summary = EXCLUDED.summary,
       note = EXCLUDED.note,
       rated_by = EXCLUDED.rated_by,
       updated_at = now()`,
    [postId, rating, summary, note?.trim() || null, ratedBy],
  );

  if (rating !== 1) return { suppressionId: null, closed: false };

  // Bağlama səbəbi 'MANUAL' DEYİL: "həll etdim" ilə "bu bayraq olmamalıydı"
  // fərqli hadisələrdir və dataset onları qarışdırmamalıdır.
  const { rowCount: closed } = await pool.query(
    `UPDATE katibe.agent_posts
     SET acknowledged_at = now(), closed_reason = 'RATED_NOISE'
     WHERE id = $1 AND acknowledged_at IS NULL`,
    [postId],
  );

  // Söhbətə bağlı olmayan post (instans səviyyəli susqunluq, "qərar mərhələsi"
  // siyahısı) susdurula bilmir: susdurmanın açarı söhbətdir. Reytinq yenə də
  // yazılır və dataset-ə düşür, sadəcə gələcək bayraq süzülmür.
  if (!post.remote_jid) return { suppressionId: null, closed: (closed ?? 0) > 0 };

  const { rows: sup } = await pool.query(
    `INSERT INTO katibe.agent_suppressions
       (agent, instance_id, remote_jid, detector, summary, base_severity, source_post_id, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9::int))
     ON CONFLICT (agent, instance_id, remote_jid, detector) WHERE revoked_at IS NULL
     DO UPDATE SET
       summary = EXCLUDED.summary,
       base_severity = EXCLUDED.base_severity,
       source_post_id = EXCLUDED.source_post_id,
       created_by = EXCLUDED.created_by,
       created_at = now(),
       -- Daimi susdurma buradan GERİ ADDIM ATMIR: eyni söhbətdə «bir daha
       -- göstərmə» basılıbsa, sonrakı 1 qiyməti onu 30 günlük sətrə çevirməməli
       -- idi — menecer eyni istiqamətdə ikinci dəfə basır, əksinə yox.
       permanent = katibe.agent_suppressions.permanent,
       expires_at = CASE WHEN katibe.agent_suppressions.permanent
                         THEN NULL ELSE EXCLUDED.expires_at END,
       -- Sətir möhlət idisə, artıq deyil. «Lazımsız» qiyməti başqa hökmdür
       -- («bu bayraq olmamalıydı»), möhlət isə vaxt xahişi idi; sahələri
       -- yerində qoysaq, heç vaxt verilməmiş bir möhlətin nəticəsi
       -- gözlənilərdi və bayraq geri qayıdanda «möhlət pozuldu» yazılardı.
       snooze_days = NULL,
       snooze_reported_at = NULL
     RETURNING id`,
    [
      post.agent,
      post.instance_id,
      post.remote_jid,
      post.detector,
      summary,
      post.base_severity,
      postId,
      ratedBy,
      SUPPRESSION_DAYS,
    ],
  );

  return { suppressionId: Number(sup[0].id), closed: (closed ?? 0) > 0 };
}

/**
 * «Bir daha göstərmə» — həmin söhbətdə həmin növ bayrağı DAİMİ susdurur.
 *
 * Reytinq 1-dən fərqi klapanlardadır, gücündə deyil: 30 günlük susdurmanın
 * üstündən model «vəziyyət dəyişib» deyib keçə bilir (gate.ts, DIFFERENT), və
 * telefonda bağlanmış işlərdə məhz bu baş verirdi — söhbətin son mesajı
 * həmişəlik «cavab bizdən gözlənilir» kimi oxunur, ona görə model hər gedişatda
 * bayrağı geri buraxırdı. Bu düymə həmin qapını bağlayır: müddət yoxdur,
 * eskalasiya keçmir, model soruşulmur.
 *
 * DATASETƏ DÜŞMÜR — qəsdən. Reytinq 1 «bu bayraq olmamalıydı» deməkdir və
 * modelə nümunə kimi göstərilir (getRatingHints); burada isə bayraq çox vaxt
 * DÜZ olur, sadəcə iş WhatsApp-dan kənarda bitib. Onu «lazımsız» nümunəsi kimi
 * öyrətmək modeli əsl cavabsız söhbətlərdə də susdurardı. Menecer həm də
 * lazımsız sayırsa, 1 düyməsi yerindədir və ikisi bir-birinə mane olmur.
 *
 * Söhbətin tarixçəsi toxunulmur: mesajlar, statistika, təhlil — hamısı qalır.
 *
 * İcazə çağıran tərəfdə (agent-actions.ts): YALNIZ admin.
 */
export async function mutePostForever(
  postId: number,
  note: string | null,
  mutedBy: number,
): Promise<RateResult> {
  const { rows } = await pool.query(
    `SELECT id, agent, instance_id, remote_jid, detector, base_severity, title, body
     FROM katibe.agent_posts WHERE id = $1`,
    [postId],
  );
  if (rows.length === 0) return { suppressionId: null, closed: false };
  const post = rows[0];

  // Söhbətə bağlı olmayan post (instans səviyyəli siyahı) susdurula bilmir —
  // susdurmanın açarı söhbətdir. Burada postu bağlamırıq da: bağlamaq
  // «bir daha görünməyəcək» təəssüratı yaradardı, halbuki növbəti gedişat onu
  // yenidən açacaq. Belə postda düymə onsuz da göstərilmir (SupervisorFeed).
  if (!post.remote_jid) return { suppressionId: null, closed: false };

  // Susdurmanın SƏBƏBİ audit səhifəsində oxunan yeganə mətndir, ona görə
  // menecerin qeydi başa qoyulur (ratePost-dakı eyni qayda).
  const summary = [
    note?.trim() ? `Menecerin qeydi: ${note.trim()}` : null,
    "«Bir daha göstərmə» — daimi susdurma.",
    String(post.title),
    String(post.body),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);

  const { rowCount: closed } = await pool.query(
    `UPDATE katibe.agent_posts
     SET acknowledged_at = now(), closed_reason = 'MUTED'
     WHERE id = $1 AND acknowledged_at IS NULL`,
    [postId],
  );

  const { rows: sup } = await pool.query(
    `INSERT INTO katibe.agent_suppressions
       (agent, instance_id, remote_jid, detector, summary, base_severity, source_post_id,
        created_by, permanent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NULL)
     ON CONFLICT (agent, instance_id, remote_jid, detector) WHERE revoked_at IS NULL
     DO UPDATE SET
       summary = EXCLUDED.summary,
       base_severity = EXCLUDED.base_severity,
       source_post_id = EXCLUDED.source_post_id,
       created_by = EXCLUDED.created_by,
       created_at = now(),
       permanent = true,
       expires_at = NULL,
       -- Möhlətin üstündən «bir daha göstərmə» basılıbsa, möhlət bitib: nəticə
       -- hesabatı gözləyən sətir qalmamalıdır, yoxsa bayraq bir daha
       -- çıxmayacağı halda audit onu «nəticəsi gözlənilir» kimi saxlayardı.
       snooze_days = NULL,
       snooze_reported_at = NULL
     RETURNING id`,
    [
      post.agent,
      post.instance_id,
      post.remote_jid,
      post.detector,
      summary,
      post.base_severity,
      postId,
      mutedBy,
    ],
  );

  return { suppressionId: Number(sup[0].id), closed: (closed ?? 0) > 0 };
}

/**
 * MÖHLƏT — «bilirəm, mənə N gün ver», sonra nəticə.
 *
 * Lentdəki digər üç düymənin heç biri bunu edə bilmirdi:
 *   «Həll edildi»        problem davam edirsə bir saat sonra bayrağı geri
 *                        gətirir — halbuki menecer çatdırılmanı gözləyir və
 *                        həmin saat ərzində edə biləcəyi heç nə yoxdur;
 *   reytinq 1 «Lazımsız» 30 gün susdurur, amma datasetə «bu bayraq səhv idi»
 *                        nümunəsi kimi düşür — bayraq isə DÜZ idi, səhv olan
 *                        yalnız vaxt idi;
 *   «Bir daha göstərmə»  həmişəlik, və bitəndə xəbər verən yoxdur.
 *
 * Möhlətin yeganə fərqləndirici cəhəti ÖZÜ QAYITMASIDIR. Müddət bitəndə
 * problem davam edirsə bayraq «N gün möhlət verilmişdi — problem davam edir»
 * nişanı və +1 balla lentə çıxır (gate.ts → run.ts); həll olubsa heç nə
 * görünmür və jurnala SNOOZE_KEPT yazılır. Yəni möhlət unutmaq deyil, tarixə
 * söz verməkdir.
 *
 * DATASETƏ DÜŞMÜR — «Bir daha göstərmə» ilə eyni səbəbdən: möhlət bayrağın
 * səhv olduğunu demir. Onu modelə «lazımsız» nümunəsi kimi göstərmək,
 * detektoru öz düz işinə görə cəzalandırmaq olardı.
 *
 * İcazə çağıran tərəfdə (agent-actions.ts): YALNIZ admin — ekrandan bir şey
 * gizlədən hər düymə orada qalır.
 */
export async function snoozePost(
  postId: number,
  days: number,
  note: string | null,
  snoozedBy: number,
): Promise<{ suppressionId: number | null; closed: boolean; until: string | null }> {
  if (!SNOOZE_DAY_OPTIONS.includes(days as SnoozeDays)) {
    return { suppressionId: null, closed: false, until: null };
  }

  const { rows } = await pool.query(
    `SELECT id, agent, instance_id, remote_jid, detector, base_severity, title, body
     FROM katibe.agent_posts WHERE id = $1`,
    [postId],
  );
  if (rows.length === 0) return { suppressionId: null, closed: false, until: null };
  const post = rows[0];

  // Söhbətə bağlı olmayan post (instans səviyyəli siyahı) susdurula bilmir —
  // susdurmanın açarı söhbətdir. mutePostForever-dəki eyni qayda və eyni
  // səbəb: postu bağlamaq «getdi» təəssüratı yaradar, növbəti gedişat isə onu
  // geri gətirərdi. Belə postda düymə onsuz da göstərilmir (SupervisorFeed).
  if (!post.remote_jid) return { suppressionId: null, closed: false, until: null };

  // Bitmə anı ƏVVƏLCƏ hesablanır və hər iki cədvələ eyni dəyər yazılır. İki
  // ayrı sorğuda iki dəfə hesablamaq gecə yarısını keçən klikdə bir günlük
  // fərq yaradardı: post «8 sen-dək» yazar, susdurma 9 sen-də bitərdi.
  const { rows: when } = await pool.query(
    `SELECT ${snoozeExpirySql("$1")} AS until`,
    [days],
  );
  const until: Date = when[0].until;

  // Susdurmanın SƏBƏBİ audit səhifəsində oxunan yeganə mətndir (ratePost-dakı
  // eyni qayda) — menecerin qeydi başa qoyulur.
  const summary = [
    note?.trim() ? `Menecerin qeydi: ${note.trim()}` : null,
    `${days} günlük möhlət verildi.`,
    String(post.title),
    String(post.body),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);

  const { rowCount: closed } = await pool.query(
    `UPDATE katibe.agent_posts
     SET acknowledged_at = now(), acknowledged_by = $4, closed_reason = 'SNOOZED',
         closed_note = $5, snooze_days = $2, snoozed_until = $3
     WHERE id = $1 AND acknowledged_at IS NULL`,
    [postId, days, until, `${days} günlük möhlət`, note?.trim()?.slice(0, 2000) || null],
  );

  const { rows: sup } = await pool.query(
    `INSERT INTO katibe.agent_suppressions
       (agent, instance_id, remote_jid, detector, summary, base_severity, source_post_id,
        created_by, permanent, expires_at, snooze_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10)
     ON CONFLICT (agent, instance_id, remote_jid, detector) WHERE revoked_at IS NULL
     DO UPDATE SET
       summary = EXCLUDED.summary,
       base_severity = EXCLUDED.base_severity,
       source_post_id = EXCLUDED.source_post_id,
       created_by = EXCLUDED.created_by,
       created_at = now(),
       -- Daimi susdurmadan GERİ ADDIM ATMIR (ratePost-dakı eyni qayda): eyni
       -- söhbətdə «bir daha göstərmə» basılıbsa, sonrakı möhlət onu üç günlük
       -- sətrə çevirməməlidir — menecer eyni istiqamətdə ikinci dəfə basır.
       permanent = katibe.agent_suppressions.permanent,
       expires_at = CASE WHEN katibe.agent_suppressions.permanent
                         THEN NULL ELSE EXCLUDED.expires_at END,
       snooze_days = CASE WHEN katibe.agent_suppressions.permanent
                          THEN NULL ELSE EXCLUDED.snooze_days END,
       -- Möhlət təzələndi: köhnəsinin nəticəsi artıq gözlənilmir.
       snooze_reported_at = NULL
     RETURNING id, expires_at`,
    [
      post.agent,
      post.instance_id,
      post.remote_jid,
      post.detector,
      summary,
      post.base_severity,
      postId,
      snoozedBy,
      until,
      days,
    ],
  );

  return {
    suppressionId: Number(sup[0].id),
    closed: (closed ?? 0) > 0,
    until: sup[0].expires_at ? new Date(sup[0].expires_at).toISOString() : null,
  };
}

/**
 * Nəticəsi hələ yazılmamış möhlət — «müddət bitdi, bəs problem qalıbmı?»
 *
 * Susdurma sətri müddəti bitəndə ləğv olunur (loadActiveSuppressions), amma
 * ləğv özü cavab deyil: cavabı yalnız növbəti gedişat verir — bayraq qayıdırsa
 * möhlət pozulub, qayıtmırsa tutub. Bu funksiya həmin gözləmə siyahısını
 * qaytarır və eyni zamanda pəncərəsi keçmişləri «tutdu» kimi bağlayır.
 *
 * TUTAN MÖHLƏT DƏ YAZILIR (SNOOZE_KEPT). «Heç nə olmadı» sətri lazımsız
 * görünür, amma onsuz jurnalda yalnız pozulmuş möhlətlər qalar və düymə
 * olduğundan pis görünərdi — halbuki əsas sual «bu düymə işləyirmi» sualıdır.
 */
export interface PendingSnooze {
  suppressionId: number;
  detector: string;
  remoteJid: string;
  days: number;
  /** Möhlətin bitdiyi an — ISO. */
  endedAt: string;
}

export async function loadPendingSnoozeOutcomes(
  agent: string,
  instanceId: string,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<Map<string, PendingSnooze>> {
  // Quru gedişat heç nə yazmır — «möhlət tutdu» hökmü də yazıdır.
  if (!dryRun) {
    const { rows: kept } = await pool.query(
      `UPDATE katibe.agent_suppressions
       SET snooze_reported_at = now()
       WHERE agent = $1 AND instance_id = $2
         AND snooze_days IS NOT NULL AND snooze_reported_at IS NULL
         AND revoked_at IS NOT NULL AND revoked_by IS NULL
         AND revoked_at <= now() - make_interval(hours => $3::int)
       RETURNING id, base_severity, snooze_days`,
      [agent, instanceId, SNOOZE_OUTCOME_GRACE_HOURS],
    );
    for (const r of kept) {
      await pool.query(
        `INSERT INTO katibe.agent_suppression_log (suppression_id, outcome, would_be_severity, reason)
         VALUES ($1, 'SNOOZE_KEPT', $2, $3)`,
        [
          Number(r.id),
          Number(r.base_severity),
          `${r.snooze_days} günlük möhlət bitdi və bayraq geri qayıtmadı — problem həll olunub.`,
        ],
      );
    }
  }

  const { rows } = await pool.query(
    `SELECT id, detector, remote_jid, snooze_days, revoked_at
     FROM katibe.agent_suppressions
     WHERE agent = $1 AND instance_id = $2
       AND snooze_days IS NOT NULL AND snooze_reported_at IS NULL
       AND revoked_at IS NOT NULL AND revoked_by IS NULL
       AND revoked_at > now() - make_interval(hours => $3::int)`,
    [agent, instanceId, SNOOZE_OUTCOME_GRACE_HOURS],
  );
  const map = new Map<string, PendingSnooze>();
  for (const r of rows) {
    map.set(key(String(r.detector), String(r.remote_jid)), {
      suppressionId: Number(r.id),
      detector: String(r.detector),
      remoteJid: String(r.remote_jid),
      days: Number(r.snooze_days),
      endedAt: new Date(r.revoked_at).toISOString(),
    });
  }
  return map;
}

/**
 * «Möhlət pozuldu» — bayraq müddət bitəndən sonra həqiqətən geri qayıtdı.
 *
 * Bir dəfə yazılır: `snooze_reported_at` şərti ilə yenilənir, ona görə eyni
 * möhlət növbəti gedişatda ikinci sətir yaratmır. Bayraq isə lentdə öz nişanı
 * ilə qalır — o, postun sahəsindədir (after_snooze_days), jurnalın yox.
 */
export async function markSnoozeBroken(
  snooze: PendingSnooze,
  runId: number,
  wouldBeSeverity: number,
  evidence: Record<string, unknown>,
): Promise<void> {
  const { rowCount } = await pool.query(
    `UPDATE katibe.agent_suppressions
     SET snooze_reported_at = now()
     WHERE id = $1 AND snooze_reported_at IS NULL`,
    [snooze.suppressionId],
  );
  if ((rowCount ?? 0) === 0) return;
  await pool.query(
    `INSERT INTO katibe.agent_suppression_log
       (suppression_id, run_id, outcome, would_be_severity, reason, evidence)
     VALUES ($1, $2, 'SNOOZE_BROKEN', $3, $4, $5)`,
    [
      snooze.suppressionId,
      runId || null,
      wouldBeSeverity,
      `${snooze.days} günlük möhlət bitdi, problem davam edir — bayraq +1 balla lentə qaytarıldı.`,
      JSON.stringify(evidence),
    ],
  );
}

/**
 * Susdurmanı əl ilə ləğv edir — "yenidən göstər".
 *
 * Möhlət sətri olduqda nəticə də burada bağlanır. Səbəb: möhləti VAXTINDAN
 * ƏVVƏL insan dayandırıbsa, geri qayıdan bayraq «möhlət pozuldu» deyil —
 * menecer özü «indi bax» dedi. İki halı fərqləndirən yeganə iz budur.
 */
export async function revokeSuppression(id: number, userId: number): Promise<void> {
  await pool.query(
    `UPDATE katibe.agent_suppressions
     SET revoked_at = now(), revoked_by = $2,
         snooze_reported_at = COALESCE(snooze_reported_at, now())
     WHERE id = $1 AND revoked_at IS NULL`,
    [id, userId],
  );
}

function key(detector: string, jid: string): string {
  return `${detector}:${jid}`;
}

/**
 * Bu instansda qüvvədə olan susdurmalar, `detector:jid` açarı ilə.
 *
 * Vaxtı keçmişlər BURADA ləğv olunur və jurnala bir dəfə 'EXPIRED' yazılır.
 * Onları sadəcə sorğudan süzmək daha qısa olardı, amma o zaman "susdurma bitdi,
 * bayraq geri qayıtdı" hadisəsinin heç bir izi qalmazdı — halbuki auditin
 * bütün məqsədi məhz belə keçidləri görməkdir.
 */
export async function loadActiveSuppressions(
  agent: string,
  instanceId: string,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<Map<string, Suppression>> {
  // Quru gedişat heç nə yazmır — vaxtı keçmişlərin ləğvi də yazıdır.
  const expired = dryRun
    ? { rows: [] as { id: number; base_severity: number }[] }
    : await pool.query(
        `UPDATE katibe.agent_suppressions
         SET revoked_at = now()
         WHERE agent = $1 AND instance_id = $2 AND revoked_at IS NULL
           AND NOT permanent AND expires_at <= now()
         RETURNING id, base_severity, snooze_days`,
        [agent, instanceId],
      );
  for (const r of expired.rows) {
    // Möhlətin bitişi adi susdurmanın bitişi ilə eyni sətri yazmır: burada
    // hekayə davam edir — nəticə (SNOOZE_BROKEN / SNOOZE_KEPT) bir-iki
    // gedişat sonra gəlir və jurnalı oxuyan adam onu gözləməlidir.
    const days = r.snooze_days === null ? null : Number(r.snooze_days);
    await pool.query(
      `INSERT INTO katibe.agent_suppression_log (suppression_id, outcome, would_be_severity, reason)
       VALUES ($1, 'EXPIRED', $2, $3)`,
      [
        Number(r.id),
        Number(r.base_severity),
        days === null
          ? `Susdurmanın ${SUPPRESSION_DAYS} günlük müddəti bitdi — bayraq yenidən görünə bilər.`
          : `${days} günlük möhlət bitdi — nəticə gözlənilir: problem davam edirsə bayraq geri qayıdacaq.`,
      ],
    );
  }

  const { rows } = await pool.query(
    `SELECT id, instance_id, remote_jid, detector, summary, base_severity, created_at,
            expires_at, permanent, snooze_days
     FROM katibe.agent_suppressions
     WHERE agent = $1 AND instance_id = $2 AND revoked_at IS NULL
       AND (permanent OR expires_at > now())`,
    [agent, instanceId],
  );
  const map = new Map<string, Suppression>();
  for (const r of rows) {
    map.set(key(String(r.detector), String(r.remote_jid)), {
      id: Number(r.id),
      instanceId: String(r.instance_id),
      remoteJid: String(r.remote_jid),
      detector: String(r.detector),
      summary: String(r.summary),
      baseSeverity: Number(r.base_severity),
      createdAt: new Date(r.created_at).toISOString(),
      expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      permanent: r.permanent === true,
      snoozeDays: r.snooze_days === null ? null : Number(r.snooze_days),
    });
  }
  return map;
}

export function suppressionFor(
  suppressions: Map<string, Suppression>,
  finding: Finding,
): Suppression | null {
  if (!finding.jid) return null;
  return suppressions.get(key(finding.detector, finding.jid)) ?? null;
}

/**
 * Eskalasiya klapanı: ciddiləşən problem susdurulmuş qalmır.
 *
 * DİQQƏT — TAVANDA İŞLƏMİR. Deterministik düsturun maksimumu 9-dur
 * (severity.ts), ona görə 9 balda rədd edilmiş bayraq üçün bu şərt heç vaxt
 * doğru olmur. Bu, boşluq deyil: real eskalasiya müştərinin yenidən yazması
 * ilə gəlir, o da lastInboundTs-i dəyişir və oxşarlıq yoxlamasını işə salır —
 * yeni sual/narazılıq görünəndə model sameAsDismissed=false qaytarır və
 * bayraq geri çıxır. Bu klapan yalnız 6-7 balda rədd edilib sonra
 * ağırlaşanlar üçündür.
 */
export function escalatesPast(finding: Finding, sup: Suppression): boolean {
  // Daimi susdurmada klapan yoxdur: «bir daha göstərmə» balı da əhatə edir,
  // yoxsa 6-da bağlanmış bayraq bir gün sonra 8 olub qayıdardı və düymə yenə
  // sınmış görünərdi.
  //
  // MÖHLƏTDƏ İSƏ KLAPAN AÇIQ QALIR, və bu, qəsdən belədir: möhlət «heç vaxt
  // göstərmə» demir, «bu problem üçün mənə N gün ver» deyir. Problem həmin
  // günlərdə ciddiləşirsə — müştəri əsəbiləşir, gözləmə iki qat artır — verilən
  // söz artıq başqa bir vəziyyətə aiddir və bayraq müddəti gözləmədən qayıdır.
  if (sup.permanent) return false;
  return finding.baseSeverity >= sup.baseSeverity + ESCALATION_MARGIN;
}

export type SuppressionOutcome =
  | "SUPPRESSED"
  | "ESCALATED"
  | "DIFFERENT"
  | "EXPIRED"
  /** Möhlət bitdi, problem davam edir — bayraq geri qayıtdı. */
  | "SNOOZE_BROKEN"
  /** Möhlət bitdi, bayraq qayıtmadı — problem həll olunub. */
  | "SNOOZE_KEPT";

/**
 * Hər qarşılaşma jurnala yazılır — susdurulan da, buraxılan da.
 *
 * Susdurulmuş bayraq lentdə görünmür, deməli səhv susdurma öz-özünə heç vaxt
 * üzə çıxmayacaq. Bu sətirlər onun yeganə izidir (/admin/suppressions).
 */
export async function logSuppressionEvent(
  suppressionId: number,
  runId: number,
  outcome: SuppressionOutcome,
  wouldBeSeverity: number,
  reason: string | null,
  model: string | null,
  evidence: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `INSERT INTO katibe.agent_suppression_log
       (suppression_id, run_id, outcome, would_be_severity, reason, model, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [suppressionId, runId || null, outcome, wouldBeSeverity, reason, model, JSON.stringify(evidence)],
  );
}

/**
 * Modelə göstərilən "menecer nəyi bəyənir" nümunələri.
 *
 * Datasetin ilk praktik işi budur: fine-tuning yox, prompt-a bir neçə real
 * misal. 1 verilmiş bayraqlar "belələrini yazma", 5 verilmişlər "belələri
 * dəyərlidir" deməkdir. Sayı qəsdən kiçikdir — nümunələr promptun yarısını
 * tutsa, model onları vəziyyətə uyğunlaşdırmaq yerinə köçürməyə başlayır.
 *
 * NİYƏ TƏK QİYMƏTLƏR KİFAYƏT ETMİR. Ölçüldü (30 gün): 530 postdan yalnız 16-sı
 * qiymətləndirilib və hamısı «1»dir — bir dənə də «5» yoxdur. Yəni bu funksiya
 * praktikada modelə həmişə yalnız «belələrini yazma» yarısını göstərirdi.
 * Birtərəfli nümunə dəsti isə tərəfli öyrədir.
 *
 * Ona görə menecerin SÖZLƏ deyil, ƏLİ ilə verdiyi siqnallar da götürülür:
 * bağlayarkən qeyd yazdığı və şərh yazdığı bayraqlar. Onlar «vacib idi»
 * ETİKETİ DEYİL və elə təqdim də olunmur — menecerin nə etdiyi və nə yazdığı
 * modelə olduğu kimi verilir. Səbəb real nümunədə göründü: «otvet yest v chate
 * zdes ne pokazivayet» qeydi əl ilə bağlanmış bayraqdadır, amma mənası «bu
 * bayraq səhv idi»dir. Onu «VACİB» rəfinə qoymaq modelə düz tərsini öyrədərdi.
 */
const HINT_LIMIT = 4;

interface HintRow {
  detector: string;
  title: string;
  note: string | null;
}

const hintLine = (r: HintRow) =>
  `- [${r.detector}] ${r.title}` + (r.note ? ` — menecer: "${r.note}"` : "");

export async function getRatingHints(agent: string, instanceId: string): Promise<string | null> {
  const [rated, touched] = await Promise.all([
    pool.query<{ rating: number; detector: string; title: string; note: string | null }>(
      `SELECT r.rating, p.detector, p.title, r.note
       FROM katibe.agent_post_ratings r
       JOIN katibe.agent_posts p ON p.id = r.agent_post_id
       WHERE p.agent = $1 AND p.instance_id = $2 AND r.rating IN (1, 5)
       ORDER BY r.updated_at DESC
       LIMIT $3`,
      [agent, instanceId, HINT_LIMIT * 2],
    ),
    // Menecerin əli dəymiş bayraqlar: əl ilə bağlayıb qeyd yazdıqları və
    // şərh yazdıqları. Qiymət verilmişləri kənarda saxlayırıq — onlar
    // yuxarıdakı iki rəfdən birindədir və eyni sətri iki dəfə göstərmək
    // nümunə dəstini şişirdərdi.
    pool.query<{ detector: string; title: string; note: string | null }>(
      `SELECT p.detector, p.title,
              COALESCE(p.closed_note,
                       (SELECT c.comment FROM katibe.agent_post_comments c
                         WHERE c.agent_post_id = p.id
                         ORDER BY c.created_at DESC LIMIT 1)) AS note
       FROM katibe.agent_posts p
       WHERE p.agent = $1 AND p.instance_id = $2
         AND p.kind = 'finding'
         AND (p.closed_note IS NOT NULL
              OR EXISTS (SELECT 1 FROM katibe.agent_post_comments c WHERE c.agent_post_id = p.id))
         AND NOT EXISTS (SELECT 1 FROM katibe.agent_post_ratings r WHERE r.agent_post_id = p.id)
       ORDER BY COALESCE(p.acknowledged_at, p.last_seen_at) DESC
       LIMIT $3`,
      [agent, instanceId, HINT_LIMIT],
    ),
  ]);

  const pick = (rating: number) =>
    rated.rows.filter((r) => Number(r.rating) === rating).slice(0, HINT_LIMIT);
  const noise = pick(1);
  const good = pick(5);
  const engaged = touched.rows;
  if (noise.length === 0 && good.length === 0 && engaged.length === 0) return null;

  const parts: string[] = ["--- menecerin əvvəlki reaksiyaları ---"];
  if (noise.length) {
    parts.push("Menecer bu bayraqları LAZIMSIZ saydı (belələrini yazarkən daha ehtiyatlı ol):");
    parts.push(...noise.map(hintLine));
  }
  if (good.length) {
    parts.push("Menecer bu bayraqları VACİB saydı (belələri dəyərlidir):");
    parts.push(...good.map(hintLine));
  }
  if (engaged.length) {
    parts.push(
      "Bu bayraqlara menecer əli ilə toxunub — bağlayarkən və ya şərhdə belə yazıb. " +
        "Qeydin mənasını ÖZÜN oxu: bəziləri «işi gördüm» deməkdir, bəziləri isə " +
        "«bu bayraq səhv idi». Hansı olduğunu qeydin sözlərindən çıxar:",
    );
    parts.push(...engaged.map(hintLine));
  }
  parts.push("Bunlar nümunədir, qayda deyil — hazırkı sübutu onlara uyğunlaşdırma.");
  return parts.join("\n");
}

export interface LastDecision {
  outcome: SuppressionOutcome;
  /** Qərar verilən andakı son gələn mesaj — keş açarı. */
  inboundTs: number | null;
}

/**
 * Hər susdurma üçün SON qərar.
 *
 * Keş açarı burada da lastInboundTs-dir (verify.ts-dəki eyni məntiq): söhbətə
 * təzə mesaj gəlməyibsə "vəziyyət dəyişibmi" sualını modelə bir daha vermək
 * mənasızdır — cavab dəyişə bilməz. Susdurulmuş bayraq post yazmadığı üçün
 * nəticəni posta keşləmək mümkün deyil, ona görə jurnalın özü keş rolunu
 * oynayır.
 */
export async function loadLastSuppressionDecisions(ids: number[]): Promise<Map<number, LastDecision>> {
  const map = new Map<number, LastDecision>();
  if (ids.length === 0) return map;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (suppression_id)
            suppression_id, outcome, (evidence->>'lastInboundTs')::bigint AS inbound_ts
     FROM katibe.agent_suppression_log
     WHERE suppression_id = ANY($1::bigint[])
     ORDER BY suppression_id, created_at DESC`,
    [ids],
  );
  for (const r of rows) {
    map.set(Number(r.suppression_id), {
      outcome: r.outcome as SuppressionOutcome,
      inboundTs: r.inbound_ts === null ? null : Number(r.inbound_ts),
    });
  }
  return map;
}

export interface SuppressionRow extends Suppression {
  /** Möhlətdirsə: müddət bitib, amma nəticə («davam edir» / «həll olundu») hələ yazılmayıb. */
  snoozeOutcomePending: boolean;
  instanceName: string | null;
  userName: string | null;
  contact: string | null;
  createdBy: string | null;
  revokedAt: string | null;
  /** Bu susdurma neçə dəfə həqiqətən bayraq gizlədib. */
  suppressedCount: number;
  /** Klapanların neçə dəfə işə düşdüyü (ESCALATED + DIFFERENT). */
  releasedCount: number;
  lastEventAt: string | null;
}

/**
 * Audit səhifəsinin əsas siyahısı — qüvvədə olan və ləğv olunmuş susdurmalar,
 * hər birinin nə qədər iş gördüyü ilə.
 *
 * `scope` MƏCBURİDİR (feed.ts-dəki eyni qayda): susdurma sətri müştəri adını
 * və söhbət ID-sini daşıyır, ona görə başqasının nömrəsinə aid sətri
 * göstərmək sızma olardı.
 */
export async function listSuppressions(scope: ScopedInstanceId[], limit = 100): Promise<SuppressionRow[]> {
  if (scope.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT s.id, s.instance_id, s.remote_jid, s.detector, s.summary, s.base_severity,
            s.created_at, s.expires_at, s.permanent, s.revoked_at, s.snooze_days,
            s.snooze_reported_at,
            i.name AS instance_name, u.name AS user_name,
            du.username AS created_by,
            p.evidence->>'contact' AS contact,
            COUNT(l.id) FILTER (WHERE l.outcome = 'SUPPRESSED') AS suppressed_count,
            COUNT(l.id) FILTER (WHERE l.outcome IN ('ESCALATED', 'DIFFERENT')) AS released_count,
            MAX(l.created_at) AS last_event_at
     FROM katibe.agent_suppressions s
     LEFT JOIN evolution_api."Instance" i ON i.id = s.instance_id
     LEFT JOIN katibe.agent_posts p ON p.id = s.source_post_id
     LEFT JOIN katibe.users u ON u.id = p.user_id
     LEFT JOIN katibe.dashboard_users du ON du.id = s.created_by
     LEFT JOIN katibe.agent_suppression_log l ON l.suppression_id = s.id
     WHERE s.instance_id = ANY($1::text[])
     GROUP BY s.id, i.name, u.name, du.username, p.evidence
     ORDER BY s.revoked_at IS NOT NULL, s.created_at DESC
     LIMIT $2`,
    [scope, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    instanceId: String(r.instance_id),
    remoteJid: String(r.remote_jid),
    detector: String(r.detector),
    summary: String(r.summary),
    baseSeverity: Number(r.base_severity),
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    permanent: r.permanent === true,
    snoozeDays: r.snooze_days === null ? null : Number(r.snooze_days),
    snoozeOutcomePending: r.snooze_days !== null && r.snooze_reported_at === null,
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    instanceName: (r.instance_name as string) ?? null,
    userName: (r.user_name as string) ?? null,
    contact: (r.contact as string) ?? null,
    createdBy: (r.created_by as string) ?? null,
    suppressedCount: Number(r.suppressed_count ?? 0),
    releasedCount: Number(r.released_count ?? 0),
    lastEventAt: r.last_event_at ? new Date(r.last_event_at).toISOString() : null,
  }));
}

export interface SuppressionEvent {
  id: number;
  suppressionId: number;
  instanceId: string;
  remoteJid: string;
  detector: string;
  contact: string | null;
  outcome: SuppressionOutcome;
  wouldBeSeverity: number;
  reason: string | null;
  model: string | null;
  createdAt: string;
}

/**
 * Jurnalın özü: hansı bayraq nə vaxt, hansı balla susduruldu və ya buraxıldı.
 *
 * Bu siyahı "birdən vacib bir şey sırf bu süzgəcə görə itib?" sualının cavab
 * yeridir — susdurulmuş bayraq lentdə heç vaxt görünmür, deməli səhv yalnız
 * burada aşkarlana bilər.
 */
export async function listSuppressionEvents(scope: ScopedInstanceId[], limit = 200): Promise<SuppressionEvent[]> {
  if (scope.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT l.id, l.suppression_id, l.outcome, l.would_be_severity, l.reason, l.model, l.created_at,
            s.instance_id, s.remote_jid, s.detector,
            COALESCE(l.evidence->>'contact', p.evidence->>'contact') AS contact
     FROM katibe.agent_suppression_log l
     JOIN katibe.agent_suppressions s ON s.id = l.suppression_id
     LEFT JOIN katibe.agent_posts p ON p.id = s.source_post_id
     WHERE s.instance_id = ANY($1::text[])
     ORDER BY l.created_at DESC
     LIMIT $2`,
    [scope, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    suppressionId: Number(r.suppression_id),
    instanceId: String(r.instance_id),
    remoteJid: String(r.remote_jid),
    detector: String(r.detector),
    contact: (r.contact as string) ?? null,
    outcome: r.outcome as SuppressionOutcome,
    wouldBeSeverity: Number(r.would_be_severity),
    reason: (r.reason as string) ?? null,
    model: (r.model as string) ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export interface RatingSummary {
  rating: number;
  count: number;
}

/** Datasetin vəziyyəti — admin səhifəsinin başındakı rəqəmlər. */
export async function getRatingSummary(scope: ScopedInstanceId[]): Promise<RatingSummary[]> {
  if (scope.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT r.rating, COUNT(*) AS n
     FROM katibe.agent_post_ratings r
     JOIN katibe.agent_posts p ON p.id = r.agent_post_id
     WHERE p.instance_id = ANY($1::text[])
     GROUP BY r.rating ORDER BY r.rating`,
    [scope],
  );
  return rows.map((r) => ({ rating: Number(r.rating), count: Number(r.n) }));
}
