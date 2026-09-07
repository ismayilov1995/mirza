import { pool } from "../db";
import { phoneSql, contactDisplaySql, groupSubjectJoin } from "../queries";
import { clientScopeSql } from "./scope";
import { formatDuration } from "../format";
import { scoreUnanswered, scoreSilence, scoreCustomerDeciding } from "./severity";
import { HANDOFF_STATES_SQL, STATE_LABELS, type ChatState } from "./chat-state";
import type { Detector, DetectorContext, Finding, WindowDigest } from "./types";
import { intentDetector } from "./intent";

// Detektorlar YALNIZ evolution_api."Message"-dən SELECT edir — Evolution HTTP
// API-yə heç vaxt toxunmur, deməli heç nəyi oxunmuş kimi işarələyə bilməz.
//
// Yalnız fərdi söhbətlər (@s.whatsapp.net və @lid): qrupda "kim kimə cavab
// verdi" anlayışı yoxdur (bax getWorkloadStats-dakı eyni qərar), newsletter
// və broadcast isə heç söhbət deyil.
//
// Və yalnız MÜŞTƏRİ dairəsi — Client kateqoriyalılar + hələ kateqoriyasızlar
// (clientScopeSql, scope.ts). Süzgəc msgs CTE-sindədir, ona görə üç detektor
// da, digest də eyni dairəni görür: lentdəki bayraqlar bir dairədən, "N mesaj"
// sətri başqa dairədən gəlsə, rəqəmlər bir-birini təkzib edərdi.
//
// Epoch sütunu ilə XAM müqayisə aparılır, to_timestamp(col) YOX — queries.ts
// başındakı indeks qeydinə bax.

/** SLA qaydası olmayan söhbət üçün ehtiyat cavab hədəfi — 2 saat. */
const FALLBACK_TARGET_SECONDS = 2 * 3600;

/*
 * MÖHLƏT: hədəfi bu qədər keçməmiş bayraq açılmır.
 *
 * Səbəb lentdə göründü — «Sofia 3 saatlıq hədəfi bir az keçib, təxminən
 * 3 saat 3 dəqiqədir cavab gözləyir — hələ kritik deyil». Modelin özü də
 * «hələ kritik deyil» yazır, çünki hadisə həqiqətən yoxdur: hədəfi üç dəqiqə
 * keçmək satıcının qaçırdığı müştəri deyil, saatın yuvarlaqlaşdırmasıdır.
 *
 * Ölçmə (30 gün, 477 cavabsız bayraq): son vəziyyəti hədəfin 1.25 qatından
 * aşağı olan 29 bayraq var idi və HAMISI öz-özünə bağlandı — yəni heç biri
 * menecerin əlini tələb etmədi. Bu, lentin ~6%-idir.
 *
 * İki hədd birlikdə: nisbət qısa SLA-larda (30 dəqiqəlik hədəf) az şey
 * dəyişir, mütləq rəqəm isə uzun hədəflərdə (3 saat) az. GREATEST ikisinin
 * də qorumasını saxlayır. Gecikmə itmir — sadəcə bir neçə dəqiqə sonra,
 * artıq mübahisəsiz ikən açılır.
 */
const UNANSWERED_GRACE_MIN_SECONDS = 10 * 60;
const UNANSWERED_GRACE_RATIO = 0.1;

/**
 * Fərdi söhbət üçün ad zənciri: admin etiketi → Contact.pushName → Chat.name →
 * gələn mesajların pushName-i → çılpaq JID. queries.ts-dəki nameSql()-dən
 * fərqi son mənbədir: qrup halı yoxdur (detektorlar onsuz da qrup görmür),
 * əvəzində mesaj pushName-i var — bax push_names CTE-dəki ölçmə.
 * Tələb: sorğuda ch/ct/cl/pn alias-ları ilə join olsun.
 */
// Göstərmə sırası queries.ts-dəki contactDisplaySql-dadır (etiket -> pushName
// -> tanınmış nömrə -> söhbətdən oxunan ipucu -> nişanlanmış xam LID). Post
// başlığı YAZILAN ANDA dondurulur, ona görə süzgəc burada olmalıdır: lent
// sorğusu Message cədvəlinə heç toxunmur. Açıq postun başlığı hər gedişatda
// yenilənir (persist.ts ON CONFLICT), yəni köhnə postlar da öz-özünə düzəlir.
//
// ci (chat_identity) join-u tələb olunur — NAME_SQL işlədən hər sorğuya
// əlavə edilib.
const NAME_SQL = (jidExpr: string) => contactDisplaySql(jidExpr);

/** Cavabsızları neçə saat geriyə axtarmalı: açıq qalan söhbət pəncərədən
 * qabaq başlasa da görünməlidir, yoxsa 2 saatlıq pəncərə dünənki cavabsızı
 * "görməzdi". 72 saatdan köhnə cavabsızlıq isə artıq gündəlik hesabatın
 * mövzusudur, lentinki yox. */
const UNANSWERED_LOOKBACK_HOURS = 72;

const INDIVIDUAL_MSGS_CTE = `
  msgs AS (
    SELECT
      m.key->>'remoteJid' AS jid,
      (m.key->>'fromMe')::boolean AS from_me,
      m."pushName" AS push_name,
      m."messageTimestamp" AS ts
    FROM evolution_api."Message" m
    WHERE m."instanceId" = $1
      AND (m.key->>'remoteJid' LIKE '%@s.whatsapp.net' OR m.key->>'remoteJid' LIKE '%@lid')
      AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
      AND m."messageTimestamp" > EXTRACT(epoch FROM now() - make_interval(hours => $2::int))::int
      AND ${clientScopeSql("m.key->>'remoteJid'")}
  ),
  last_out AS (
    SELECT jid, MAX(ts) FILTER (WHERE from_me) AS last_out_ts
    FROM msgs GROUP BY jid
  ),
  -- Gələn mesajların öz pushName-i. Bu instansda @lid söhbətlərin böyük
  -- əksəriyyəti Contact/Chat cədvəllərində adsızdır (307 aktiv söhbətdən
  -- yalnız 68-i), amma mesajın üstündəki pushName 304-ünü tanıdır — lentdə
  -- opaq JID görünməsin deyə ad zəncirinə bura da daxildir.
  push_names AS (
    SELECT jid, MAX(push_name) FILTER (WHERE NOT from_me AND push_name <> '') AS push_name
    FROM msgs GROUP BY jid
  ),
  -- Söhbətin ən yeni mesajı qarşı tərəfindirsə, onlar gözləyir. Gözləmə son
  -- mesajdan ölçülür (getChatBase.waiting_seconds ilə eyni semantika), seriya
  -- uzunluğu isə ayrıca sübutdur: 3+ dalbadal mesaj səbirsizlik deməkdir.
  open_chats AS (
    SELECT m.jid,
           MAX(m.ts) AS last_in_ts,
           MIN(m.ts) AS run_start_ts,
           COUNT(*) AS msgs_waiting
    FROM msgs m
    JOIN last_out lo ON lo.jid = m.jid
    WHERE NOT m.from_me AND m.ts > COALESCE(lo.last_out_ts, 0)
    GROUP BY m.jid
  )`;

/*
 * Tapıntının "həll olundu" sayılması üçün SÜBUT.
 *
 * Bayraq detektorun nəticəsindən çıxa bilər ona görə ki (a) satıcı cavab
 * verdi — həqiqətən həll olundu, ya da (b) söhbət sadəcə axtarış pəncərəsinin
 * yaşından kənara düşdü. İkincisini "həll olundu" saymaq cavabsız qalmış
 * müştərini səssizcə itirmək deməkdir, ona görə cavabsızlıq bayraqları
 * evidence-ə son gələn mesajın vaxtını yazır və avtomatik bağlanma yalnız
 * ondan SONRA bizdən mesaj getdiyini görəndə baş verir (persist.ts).
 */

interface OpenChatRow {
  jid: string;
  contact: string;
  phone: string | null;
  category_name: string | null;
  waited: string;
  target: string | null;
  msgs_waiting: string;
  since_first: string;
  last_in_ts: string;
  chat_state: string | null;
  chat_summary: string | null;
}

/**
 * D1 — cavabsız söhbətlər. Hər biri üçün: nə qədər gözləyib, hədəf nə idi,
 * neçə mesaj yazıb. Hədəf katibe.sla_target_seconds()-dən gəlir (iş saatına
 * görə fərqli), qayda yoxdursa 2 saatlıq ehtiyat hədəf — heç nə səssizcə
 * "vaxtında" sayılmır.
 */
async function runUnanswered(ctx: DetectorContext): Promise<Finding[]> {
  const { rows } = await pool.query<OpenChatRow>(
    `WITH ${INDIVIDUAL_MSGS_CTE},
     sla AS (
       SELECT o.*,
              EXTRACT(epoch FROM now())::bigint - o.last_in_ts AS waited,
              EXTRACT(epoch FROM now())::bigint - o.run_start_ts AS since_first,
              katibe.sla_target_seconds($1, to_timestamp(o.last_in_ts)) AS target
       FROM open_chats o
     )
     SELECT s.jid, s.waited, s.target, s.msgs_waiting, s.since_first, s.last_in_ts,
            ${NAME_SQL("s.jid")} AS contact,
            ${phoneSql("s.jid", "ln")} AS phone,
            cat.name AS category_name,
            cs.state AS chat_state,
            -- Söhbətin bir cümləlik izahı — hal təsnifatı onu onsuz da yazıb
            -- (chat-state.ts) və pulu ödənilib. Yalnız təsnifat bayrağı
            -- doğuran mesajı GÖRÜBSƏ götürülür: köhnə hala aid izah «nə
            -- gözləyir» sualına yanlış cavab verərdi.
            CASE WHEN cs.last_message_ts >= s.last_in_ts THEN cs.reason END AS chat_summary
     FROM sla s
     LEFT JOIN evolution_api."Chat" ch ON ch."instanceId" = $1 AND ch."remoteJid" = s.jid
     LEFT JOIN evolution_api."Contact" ct ON ct."instanceId" = $1 AND ct."remoteJid" = s.jid
     LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = s.jid
     ${groupSubjectJoin("s.jid", "gs")}
     LEFT JOIN push_names pn ON pn.jid = s.jid
     LEFT JOIN katibe.lid_number ln ON ln.lid_jid = s.jid
     LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = s.jid
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     LEFT JOIN katibe.chat_state cs ON cs.instance_id = $1 AND cs.remote_jid = s.jid
     WHERE s.waited > COALESCE(s.target, $3)
                      + GREATEST($4::int, COALESCE(s.target, $3) * $5::numeric)
       -- LLM təsnifatı SON mesajı görübsə və deyirsə ki, o mesaj cavab tələb
       -- etmir ("ok", "təşəkkür"...) və ya mövzu bağlanıb — bayraq qaldırmırıq.
       --
       -- SÜZGƏC QƏSDƏN DARDIR: yalnız FILLER/RESOLVED və yalnız HIGH əminlik.
       -- Səhvlərin qiyməti simmetrik deyil — yanlış göstərilən bayraq gözə
       -- görünür və bir kliklə bağlanır, yanlış susdurulan bayraq isə heç vaxt
       -- görünmür. STALE əvvəl bura daxil idi və 3 saatlıq təzə söhbəti
       -- söndürdü; çıxarıldı.
       AND NOT (cs.last_message_ts >= s.last_in_ts
                AND cs.state IN ('FILLER', 'RESOLVED')
                AND cs.confidence = 'HIGH')
       -- İş bizim tərəfdə deyil: başqa filiala yönləndirilmiş və PR üçün yazan
       -- söhbətlərdə cavab verəcək adam burada yoxdur, ona görə "N saatdır
       -- cavabsız" ölçüsü mənasızdır. Yuxarıdakı süzgəcdən fərqli olaraq
       -- MEDIUM da keçir — bunlar gizlənmir, /agent/handoff-da siyahıdadır
       -- (bax chat-state.ts HANDOFF_STATES).
       AND NOT (cs.last_message_ts >= s.last_in_ts
                AND cs.state IN (${HANDOFF_STATES_SQL})
                AND cs.confidence IN ('HIGH', 'MEDIUM'))
     ORDER BY s.waited / COALESCE(s.target, $3)::numeric DESC`,
    [
      ctx.instanceId,
      UNANSWERED_LOOKBACK_HOURS,
      FALLBACK_TARGET_SECONDS,
      UNANSWERED_GRACE_MIN_SECONDS,
      UNANSWERED_GRACE_RATIO,
    ],
  );

  const breachingChatsInRun = rows.length;
  return rows.map((r) => {
    const waited = Number(r.waited);
    const target = r.target === null ? FALLBACK_TARGET_SECONDS : Number(r.target);
    const fallbackTarget = r.target === null;
    const isClient = r.category_name === "Client";
    const msgsWaiting = Number(r.msgs_waiting);
    const baseSeverity = scoreUnanswered({
      waitedSeconds: waited,
      targetSeconds: target,
      fallbackTarget,
      isClient,
      msgsWaiting,
      breachingChatsInRun,
    });
    return {
      detector: "unanswered",
      jid: r.jid,
      contact: r.contact,
      baseSeverity,
      title: `${r.contact} ${formatDuration(waited)} cavab gözləyir`,
      evidence: {
        contact: r.contact,
        phone: r.phone,
        waitedSeconds: waited,
        targetSeconds: target,
        targetSource: fallbackTarget ? "fallback" : "rule",
        msgsWaiting,
        sinceFirstSeconds: Number(r.since_first),
        isClient,
        breachingChatsInRun,
        // Daxili kod yox, azərbaycanca etiket: model sübutda gördüyünü olduğu
        // kimi köçürür və "söhbət 'STALE' vəziyyətindədir" kimi cümlələr yazırdı.
        chatState: r.chat_state ? (STATE_LABELS[r.chat_state as ChatState] ?? null) : null,
        // Lentin mətni bunsuz saatı sözlə təkrarlamaqdan başqa heç nə edə
        // bilmirdi: sübutda bir dənə də mesaj mətni yox idi, ona görə model
        // «N saatdır cavab gözləyir» cümləsini yenidən yazırdı. Bu sahə
        // MÜŞTƏRİNİN NƏ İSTƏDİYİNİ gətirir — modelin uydurmasına ehtiyac
        // qalmadan, çünki cümləni söhbəti oxumuş təsnifat yazıb.
        chatSummary: r.chat_summary,
        // Avtomatik bağlanmanın sübutu — bax persist.ts autoCloseMissing().
        lastInboundTs: Number(r.last_in_ts),
      },
    } satisfies Finding;
  });
}

/**
 * D2 — satıcı susub. Pəncərədə bir dənə də giden mesaj yoxdur, halbuki
 * (a) pəncərənin ən azı 1 saatı iş vaxtına düşüb və (b) ya mesaj gəlib, ya
 * kimsə cavab gözləyir. Müqayisə üçün əvvəlki 4 həftənin eyni pəncərəsi
 * götürülür — onsuz da sakit keçən çərşənbə axşamı bayraqlanmasın.
 */
async function runSilence(ctx: DetectorContext): Promise<Finding[]> {
  if (ctx.businessOverlapMinutes < 60) return [];

  const startEpoch = Math.floor(ctx.windowStart.getTime() / 1000);
  const endEpoch = Math.floor(ctx.windowEnd.getTime() / 1000);

  const { rows } = await pool.query(
    `WITH ${INDIVIDUAL_MSGS_CTE}
     SELECT
       (SELECT COUNT(*) FROM msgs WHERE from_me AND ts >= $3 AND ts < $4) AS outbound,
       (SELECT COUNT(*) FROM msgs WHERE NOT from_me AND ts >= $3 AND ts < $4) AS inbound,
       (SELECT COUNT(*) FROM open_chats) AS waiting_chats`,
    [ctx.instanceId, UNANSWERED_LOOKBACK_HOURS, startEpoch, endEpoch],
  );
  const outbound = Number(rows[0].outbound);
  const inbound = Number(rows[0].inbound);
  const waitingChats = Number(rows[0].waiting_chats);
  if (outbound > 0) return [];
  if (inbound === 0 && waitingChats === 0) return [];

  // Eyni pəncərə, k həftə əvvəl (k=1..4) — median giden mesaj sayı.
  const { rows: baseRows } = await pool.query(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cnt) AS median FROM (
       SELECT k, COUNT(m.id) AS cnt
       FROM generate_series(1, 4) k
       LEFT JOIN evolution_api."Message" m
         ON m."instanceId" = $1
        AND (m.key->>'fromMe')::boolean
        AND (m.key->>'remoteJid' LIKE '%@s.whatsapp.net' OR m.key->>'remoteJid' LIKE '%@lid')
        AND m."messageTimestamp" >= $2::bigint - k * 604800
        AND m."messageTimestamp" <  $3::bigint - k * 604800
        -- Baza da eyni dairədən: müştəri söhbətlərini tədarükçü yazışması ilə
        -- müqayisə etsək, susqunluq heç vaxt görünməzdi.
        AND ${clientScopeSql("m.key->>'remoteJid'")}
       GROUP BY k
     ) weekly`,
    [ctx.instanceId, startEpoch, endEpoch],
  );
  const baselineMedian = Number(baseRows[0].median ?? 0);
  if (baselineMedian < 5) return [];

  return [
    {
      detector: "silence",
      jid: null,
      contact: null,
      baseSeverity: scoreSilence({ waitingChats, baselineMedian }),
      title: `${ctx.userName} pəncərə boyu heç nə yazmayıb`,
      evidence: { outbound, inbound, waitingChats, baselineMedian },
    },
  ];
}

/** Qiymət veriləndən sonra minimum gözləmə — bundan tez follow-up deməyə dəyməz. */
const DECIDING_MIN_WAIT_SECONDS = 24 * 3600;
/** Bundan köhnə söhbət artıq "sallanan satış" yox, sönmüş liddir. */
const DECIDING_LOOKBACK_HOURS = 14 * 24;

/**
 * D3 — müştəri qərar verir. Qaydaların görə bilmədiyi hal: son mesaj BİZİMDİR
 * (qiymət/təklif), deməli "cavabsız" sayılmır, amma satış havada sallanır.
 * Halı LLM təsnifatı verir (katibe.chat_state, chat-state.ts); bu detektor
 * yalnız SAXLANMIŞ halı oxuyur — burada model çağırışı yoxdur.
 *
 * BİR TAPINTI, SİYAHI İLƏ. Belə söhbətlər burada yüzlərlədir (ilk ölçmədə
 * 149) — hər birinə ayrıca post yazmaq lenti yararsız edirdi: 11 həqiqi
 * bayraq 149 xatırlatmanın altında itirdi. Ona görə instans başına bir post
 * yaranır, içində ən köhnə təkliflər sadalanır. Bu, bayraq deyil iş
 * siyahısıdır, ona görə "diqqət" zolağında (4-5) qalır.
 */
const DECIDING_LIST_SIZE = 5;

async function runCustomerDeciding(ctx: DetectorContext): Promise<Finding[]> {
  const { rows } = await pool.query(
    `WITH ${INDIVIDUAL_MSGS_CTE},
     last_ts AS (SELECT jid, MAX(ts) AS last_ts FROM msgs GROUP BY jid)
     SELECT cs.remote_jid AS jid, cs.reason,
            EXTRACT(epoch FROM now())::bigint - lt.last_ts AS since_quote,
            ${NAME_SQL("cs.remote_jid")} AS contact,
            cat.name AS category_name
     FROM katibe.chat_state cs
     -- Bu JOIN həm də dairə süzgəcidir: last_ts msgs CTE-sindən gəlir, orada
     -- artıq yalnız müştəri söhbətləri var. Köhnə (kateqoriyası sonradan
     -- dəyişmiş) chat_state sətri buradan keçə bilmir.
     JOIN last_ts lt ON lt.jid = cs.remote_jid
     LEFT JOIN evolution_api."Chat" ch ON ch."instanceId" = $1 AND ch."remoteJid" = cs.remote_jid
     LEFT JOIN evolution_api."Contact" ct ON ct."instanceId" = $1 AND ct."remoteJid" = cs.remote_jid
     LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = cs.remote_jid
     ${groupSubjectJoin("cs.remote_jid", "gs")}
     LEFT JOIN push_names pn ON pn.jid = cs.remote_jid
     LEFT JOIN katibe.lid_number ln ON ln.lid_jid = cs.remote_jid
     LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = cs.remote_jid
     LEFT JOIN katibe.categories cat ON cat.id = cl.category_id
     WHERE cs.instance_id = $1
       AND cs.state = 'CUSTOMER_DECIDING'
       AND cs.confidence = 'HIGH'
       -- Təsnifat söhbətin son mesajını görüb — köhnə hala görə xəbər vermirik.
       AND cs.last_message_ts >= lt.last_ts
       AND EXTRACT(epoch FROM now())::bigint - lt.last_ts >= $3
     ORDER BY since_quote DESC`,
    [ctx.instanceId, DECIDING_LOOKBACK_HOURS, DECIDING_MIN_WAIT_SECONDS],
  );
  if (rows.length === 0) return [];

  const items = rows.map((r) => ({
    jid: r.jid as string,
    contact: r.contact as string,
    sinceQuoteSeconds: Number(r.since_quote),
    isClient: r.category_name === "Client",
    stateReason: r.reason as string,
  }));
  const clients = items.filter((i) => i.isClient).length;

  return [
    {
      detector: "customer_deciding",
      jid: null,
      contact: null,
      baseSeverity: scoreCustomerDeciding({ isClient: clients > 0 }),
      title: `${items.length} təklif qərar gözləyir (ən köhnəsi ${formatDuration(items[0].sinceQuoteSeconds)})`,
      evidence: {
        total: items.length,
        clients,
        oldestSeconds: items[0].sinceQuoteSeconds,
        top: items.slice(0, DECIDING_LIST_SIZE).map((i) => ({
          contact: i.contact,
          jid: i.jid,
          waited: formatDuration(i.sinceQuoteSeconds),
          isClient: i.isClient,
          // Hal təsnifatının öz cümləsi — sorğu onu onsuz da çəkirdi və
          // burada atırdı. Onsuz siyahı beş addan və beş rəqəmdən ibarət idi;
          // «kimə follow-up etməli» sualına cavab verirdi, «nə barədə»
          // sualına yox.
          why: i.stateReason,
        })),
      },
    },
  ];
}

export const DETECTORS: Detector[] = [
  { name: "unanswered", run: runUnanswered },
  { name: "silence", run: runSilence },
  { name: "customer_deciding", run: runCustomerDeciding },
  // Üçü də saata baxır; bu, mətni oxuyur — bax intent.ts. Ölçüsü
  // scripts/eval-intent.ts-dədir: dəqiqlik 75-100%, yalan-müsbət 0-2%.
  intentDetector,
];

/**
 * Pəncərənin ümumi mənzərəsi — tapıntı deyil. All-clear şablonu "N mesaj,
 * ən çox danışılan filənkəs" deyə bilsin, LLM isə tapıntıları kontekstdə
 * görsün deyə hesablanır.
 */
export async function buildDigest(ctx: DetectorContext): Promise<WindowDigest> {
  const startEpoch = Math.floor(ctx.windowStart.getTime() / 1000);
  const endEpoch = Math.floor(ctx.windowEnd.getTime() / 1000);

  const { rows } = await pool.query(
    `WITH ${INDIVIDUAL_MSGS_CTE},
     win AS (SELECT * FROM msgs WHERE ts >= $3 AND ts < $4),
     seq AS (
       SELECT jid, from_me, ts,
              LAG(ts) OVER w AS prev_ts,
              LAG(from_me) OVER w AS prev_from_me
       FROM win WINDOW w AS (PARTITION BY jid ORDER BY ts)
     ),
     top3 AS (
       SELECT jid, COUNT(*) AS cnt FROM win GROUP BY jid ORDER BY cnt DESC LIMIT 3
     ),
     longest AS (
       SELECT o.jid, EXTRACT(epoch FROM now())::bigint - o.last_in_ts AS waited
       FROM open_chats o ORDER BY waited DESC LIMIT 1
     )
     SELECT
       (SELECT COUNT(*) FROM win WHERE NOT from_me) AS inbound,
       (SELECT COUNT(*) FROM win WHERE from_me) AS outbound,
       (SELECT COUNT(DISTINCT jid) FROM win) AS active_chats,
       (SELECT ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY ts - prev_ts))
          FROM seq WHERE from_me AND prev_from_me = false
           AND ts - prev_ts BETWEEN 1 AND 43200) AS median_reply,
       (SELECT waited FROM longest) AS longest_wait,
       (SELECT jid FROM longest) AS longest_wait_jid,
       (SELECT COALESCE(json_agg(json_build_object(
            'jid', t.jid,
            'messages', t.cnt,
            'contact', ${NAME_SQL("t.jid")}
          ) ORDER BY t.cnt DESC), '[]'::json)
          FROM top3 t
          LEFT JOIN evolution_api."Chat" ch ON ch."instanceId" = $1 AND ch."remoteJid" = t.jid
          LEFT JOIN evolution_api."Contact" ct ON ct."instanceId" = $1 AND ct."remoteJid" = t.jid
          LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = t.jid
          ${groupSubjectJoin("t.jid", "gs")}
          LEFT JOIN push_names pn ON pn.jid = t.jid
          LEFT JOIN katibe.lid_number ln ON ln.lid_jid = t.jid
          LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = t.jid) AS top_contacts,
       (SELECT ${NAME_SQL("l.jid")}
          FROM longest l
          LEFT JOIN evolution_api."Chat" ch ON ch."instanceId" = $1 AND ch."remoteJid" = l.jid
          LEFT JOIN evolution_api."Contact" ct ON ct."instanceId" = $1 AND ct."remoteJid" = l.jid
          LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = l.jid
          ${groupSubjectJoin("l.jid", "gs")}
          LEFT JOIN push_names pn ON pn.jid = l.jid
          LEFT JOIN katibe.lid_number ln ON ln.lid_jid = l.jid
          LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = l.jid) AS longest_wait_contact`,
    [ctx.instanceId, UNANSWERED_LOOKBACK_HOURS, startEpoch, endEpoch],
  );
  const r = rows[0];
  return {
    inbound: Number(r.inbound),
    outbound: Number(r.outbound),
    activeChats: Number(r.active_chats),
    topContacts: (r.top_contacts as { jid: string; messages: number; contact: string }[]).map((t) => ({
      jid: t.jid,
      contact: t.contact,
      messages: Number(t.messages),
    })),
    longestWaitSeconds: r.longest_wait === null ? null : Number(r.longest_wait),
    longestWaitContact: r.longest_wait_contact ?? null,
    medianReplySeconds: r.median_reply === null ? null : Number(r.median_reply),
  };
}
