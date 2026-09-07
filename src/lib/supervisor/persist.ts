import type { PoolClient } from "pg";
import { pool } from "../db";
import { clientScopeSql } from "./scope";
import { HANDOFF_STATES_SQL } from "./chat-state";
import type { VerifyVerdict } from "./verify";
import type { Finding } from "./types";

// Yazı yolu: agent_runs + agent_posts. Evolution cədvəllərinə heç nə yazılmır.

export interface PostInput {
  runId: number;
  agent: string;
  instanceId: string;
  userId: number;
  finding: Finding;
  kind: "finding" | "all_clear";
  severity: number;
  severityReason: string | null;
  verdict: "INTERVENE" | "OK";
  body: string;
  llmModel: string | null;
  dedupeKey: string;
  /** Söhbəti oxumuş doğrulama (verify.ts) — yoxdursa null. */
  verify: VerifyVerdict | null;
  /**
   * Bu post bitmiş möhlətdən sonra geri qayıdırsa — möhlət neçə gün idi.
   *
   * Lentdə «N gün möhlət verilmişdi — problem davam edir» nişanına çevrilir.
   * Postun öz sahəsidir, susdurmanınkı deyil: susdurma sətri ləğv olunub və
   * audit üçün saxlanır, lentdəki sıra isə aylar sonra da öz hekayəsini
   * özü danışmalıdır.
   */
  afterSnoozeDays: number | null;
}

export function dedupeKeyFor(agent: string, detector: string, instanceId: string, jid: string | null): string {
  return `${agent}:${detector}:${instanceId}:${jid ?? "-"}`;
}

export async function createRun(
  agent: string,
  trigger: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO katibe.agent_runs (agent, trigger, window_start, window_end)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [agent, trigger, windowStart, windowEnd],
  );
  return Number(rows[0].id);
}

export async function finishRun(
  runId: number,
  fields: {
    status: "ok" | "error";
    error?: string | null;
    instanceCount: number;
    findingCount: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    /** Gedişatın öz hesabı — tokendən geri hesablamaq olmur, bir gedişatda
     *  bir neçə model çağırılır. */
    costUsd: number;
  },
): Promise<void> {
  await pool.query(
    `UPDATE katibe.agent_runs
     SET finished_at = now(), status = $2, error = $3,
         instance_count = $4, finding_count = $5,
         llm_calls = $6, input_tokens = $7, output_tokens = $8, cost_usd = $9
     WHERE id = $1`,
    [
      runId,
      fields.status,
      fields.error ?? null,
      fields.instanceCount,
      fields.findingCount,
      fields.llmCalls,
      fields.inputTokens,
      fields.outputTokens,
      fields.costUsd.toFixed(4),
    ],
  );
}

/** Son uğurlu gedişatın pəncərə sonu — növbəti pəncərənin başlanğıcı. */
export async function getLastWindowEnd(agent: string): Promise<Date | null> {
  const { rows } = await pool.query(
    `SELECT window_end FROM katibe.agent_runs
     WHERE agent = $1 AND status = 'ok' ORDER BY id DESC LIMIT 1`,
    [agent],
  );
  return rows.length ? new Date(rows[0].window_end) : null;
}

/**
 * Tapıntını yazır. Eyni problem artıq AÇIQ postdursa (dedupe_key + partial
 * unikal indeks), yenisi yaranmır — mövcud post yerində təzələnir: times_seen
 * artır, sübut rəqəmləri yenilənir, severity YUXARI hərəkət edir — yeganə
 * istisna söhbəti oxumuş doğrulamadır (verify.ts), o, balı geri endirə bilir.
 * Mətn yalnız severity dəyişəndə yenilənir — lent öz tarixini yenidən yazmasın.
 * "Həll edildi" olunmuş post isə toxunulmaz qalır: problem qayıdıbsa, TƏZƏ
 * post açılır.
 */
export async function upsertPost(p: PostInput): Promise<{ id: number; inserted: boolean }> {
  const { rows } = await pool.query(
    `INSERT INTO katibe.agent_posts
       (run_id, agent, instance_id, user_id, remote_jid, detector, kind,
        severity, base_severity, severity_reason, verdict, title, body,
        evidence, llm_model, dedupe_key, last_seen_run_id,
        verify_state, verify_confidence, verify_reason, verify_model,
        verify_inbound_ts, verified_at, after_snooze_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $1,
             $17, $18, $19, $20, $21, CASE WHEN $17::text IS NULL THEN NULL ELSE now() END,
             $22)
     ON CONFLICT (dedupe_key) WHERE acknowledged_at IS NULL
     DO UPDATE SET
       times_seen = agent_posts.times_seen + 1,
       last_seen_at = now(),
       last_seen_run_id = EXCLUDED.run_id,
       evidence = EXCLUDED.evidence,
       title = EXCLUDED.title,
       -- Mətn balla birlikdə hərəkət edir, hər iki istiqamətdə: doğrulama balı
       -- endirəndə köhnə "43 saatdır gözləyir" cümləsi qalsa, sətir öz balını
       -- təkzib edərdi. Bal dəyişmirsə mətn də toxunulmur.
       body = CASE WHEN EXCLUDED.severity <> agent_posts.severity
                   THEN EXCLUDED.body ELSE agent_posts.body END,
       severity_reason = CASE WHEN EXCLUDED.severity > agent_posts.severity
                              THEN EXCLUDED.severity_reason ELSE agent_posts.severity_reason END,
       llm_model = CASE WHEN EXCLUDED.severity > agent_posts.severity
                        THEN EXCLUDED.llm_model ELSE agent_posts.llm_model END,
       verdict = CASE WHEN EXCLUDED.severity <> agent_posts.severity
                      THEN EXCLUDED.verdict ELSE agent_posts.verdict END,
       -- SEVERITY ARTIQ GERİ DƏ ENƏ BİLİR — yalnız doğrulama sayəsində.
       -- Əvvəl qayda sadə idi: bal yalnız yuxarı hərəkət edir (rəqəm
       -- böyüdükcə vəziyyət pisləşir). Söhbəti OXUYAN doğrulama isə balı
       -- 5-ə endirəndə, GREATEST onu dərhal geri qaldırırdı və nəticə heç
       -- vaxt lentə düşmürdü. Ona görə: doğrulanmış post öz balını olduğu
       -- kimi yazır, doğrulanmamışda köhnə qayda qalır.
       severity = CASE WHEN EXCLUDED.verify_state IS NOT NULL
                       THEN EXCLUDED.severity
                       ELSE GREATEST(agent_posts.severity, EXCLUDED.severity) END,
       base_severity = GREATEST(agent_posts.base_severity, EXCLUDED.base_severity),
       -- Doğrulama YALNIZ təzəsi gələndə yazılır: nəticə keşdən qayıdanda
       -- (verify_state NULL) köhnə sətir olduğu kimi qalmalıdır.
       verify_state      = COALESCE(EXCLUDED.verify_state, agent_posts.verify_state),
       verify_confidence = COALESCE(EXCLUDED.verify_confidence, agent_posts.verify_confidence),
       verify_reason     = COALESCE(EXCLUDED.verify_reason, agent_posts.verify_reason),
       verify_model      = COALESCE(EXCLUDED.verify_model, agent_posts.verify_model),
       verify_inbound_ts = COALESCE(EXCLUDED.verify_inbound_ts, agent_posts.verify_inbound_ts),
       verified_at       = CASE WHEN EXCLUDED.verify_state IS NOT NULL
                                THEN now() ELSE agent_posts.verified_at END,
       -- Nişan bir dəfə qoyulur və düşmür: möhlət pozulubsa, sıra sonrakı
       -- gedişatlarda da bunu daşımalıdır. COALESCE olmasa növbəti gedişat
       -- (afterSnoozeDays artıq null) onu səssizcə silərdi.
       after_snooze_days = COALESCE(EXCLUDED.after_snooze_days, agent_posts.after_snooze_days)
     RETURNING id, (xmax = 0) AS inserted`,
    [
      p.runId,
      p.agent,
      p.instanceId,
      p.userId,
      p.finding.jid,
      p.finding.detector,
      p.kind,
      p.severity,
      p.finding.baseSeverity,
      p.severityReason,
      p.verdict,
      p.finding.title,
      p.body,
      JSON.stringify(p.finding.evidence),
      p.llmModel,
      p.dedupeKey,
      p.verify?.state ?? null,
      p.verify?.confidence ?? null,
      p.verify?.reason ?? null,
      p.verify?.model ?? null,
      p.verify?.inboundTs ?? null,
      p.afterSnoozeDays,
    ],
  );
  return { id: Number(rows[0].id), inserted: Boolean(rows[0].inserted) };
}

/**
 * İş saatından kənar rejim: yalnız MÖVCUD açıq postu təzələyir, yenisini
 * açmır. Gecə yaranan pozuntu səhərki ilk iş-saatı gedişatında post olacaq.
 */
export async function refreshOpenPost(
  dedupeKey: string,
  runId: number,
  evidence: Record<string, unknown>,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE katibe.agent_posts
     SET times_seen = times_seen + 1, last_seen_at = now(), last_seen_run_id = $2, evidence = $3
     WHERE dedupe_key = $1 AND acknowledged_at IS NULL`,
    [dedupeKey, runId, JSON.stringify(evidence)],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Bu gedişatda artıq görünməyən tapıntıları avtomatik bağlayır.
 *
 * Bayraqların çoxu insan toxunmadan həll olunur — satıcı cavab verir və
 * tapıntı sadəcə yox olur. Onsuz lent həll olunmuş problemi qırmızı saxlayırdı.
 *
 * SÜBUT TƏLƏB OLUNUR. Tapıntı iki səbəbdən yox ola bilər: problem həll olundu,
 * ya da söhbət axtarış pəncərəsinin yaşından kənara düşdü. İkincisini "həll
 * olundu" saymaq cavabsız müştərini səssizcə itirmək deməkdir. Ona görə
 * söhbətə bağlı post yalnız evidence-dəki lastInboundTs-dən SONRA bizdən
 * mesaj getdiyi görünəndə bağlanır. Sübut yoxdursa (o cümlədən evidence-də
 * belə sahə yoxdursa) bayraq qırmızı qalır — onu yalnız insan bağlaya bilər.
 *
 * Yalnız `finding` postlarına toxunur: all_clear postunun açarı günlükdür,
 * onu bağlasaq hər gedişat eyni gün üçün təzəsini açardı. `acknowledged_at`
 * dolduğu üçün dedupe açarı azad olur — problem qayıdarsa TƏZƏ post açılır,
 * bağlanmışın altında gizlənmir.
 */
export async function autoCloseMissing(
  agent: string,
  instanceId: string,
  seenKeys: string[],
): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE katibe.agent_posts p
     SET acknowledged_at = now(), closed_reason = 'AUTO'
     WHERE p.agent = $1 AND p.instance_id = $2
       AND p.acknowledged_at IS NULL
       AND p.kind = 'finding'
       AND NOT (p.dedupe_key = ANY($3::text[]))
       -- Sağlamlıq postları BURADAN KƏNARDIR. Onları ayrı cədvəl (cron)
       -- yazır və özü də bağlayır; bu funksiya isə hər gedişatda "bu qaçışda
       -- görmədim" deyib remote_jid-siz hər postu AUTO ilə bağlayır. İstisna
       -- olmasa, instans hələ ölü ikən bayrağı "öz-özünə həll olundu" kimi
       -- söndürərdi — düz SCOPE səhvinin eynisi.
       AND p.detector <> 'instance_health'
       AND (
         -- Söhbətə bağlı olmayan tapıntı (məs. ümumi susqunluq): pəncərədən
         -- çıxması onsuz da "artıq belə deyil" deməkdir.
         p.remote_jid IS NULL
         OR EXISTS (
           SELECT 1 FROM evolution_api."Message" m
           WHERE m."instanceId" = p.instance_id
             AND m.key->>'remoteJid' = p.remote_jid
             AND (m.key->>'fromMe')::boolean
             -- Reaksiya cavab deyil. Satıcı müştərinin mesajına 👍 basanda
             -- Message cədvəlinə adi sətir düşür və bu sübut onu «cavab
             -- verildi» kimi oxuyurdu. Detektorların hamısı bu iki tipi
             -- kənarda saxlayır; bağlanma sübutu da eyni dairədən olmalıdır,
             -- yoxsa bayraq açan qayda ilə bağlayan qayda fərqli dünyalara
             -- baxır. reactive.ts-dəki eyni şərt.
             AND m."messageType" NOT IN ('protocolMessage', 'reactionMessage')
             AND m."messageTimestamp" > (p.evidence->>'lastInboundTs')::bigint
         )
       )`,
    [agent, instanceId, seenKeys],
  );
  return rowCount ?? 0;
}

/**
 * Müştəri dairəsindən çıxmış açıq bayraqları bağlayır.
 *
 * autoCloseMissing bunu edə bilməz və qəsdən edə bilmir: o, bağlamaq üçün
 * bizdən cavab getdiyinə dair SÜBUT tələb edir, dairədən kənar söhbətdə isə
 * belə sübut heç vaxt gəlməyəcək — bayraq əbədi qırmızı qalardı. Ona görə
 * ayrıca yol və ayrıca səbəb: 'SCOPE' = "artıq nəzarətçinin mövzusu deyil",
 * 'AUTO' = "həll olundu". Lentdə də fərqli yazılır.
 *
 * Hər gedişatda işləyir, ona görə admin bir söhbəti Supplier kimi
 * işarələyəndə onun bayrağı öz-özünə lentdən çıxır — əl ilə təmizləmə lazım
 * deyil.
 */
export async function closeOutOfScope(agent: string, instanceId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE katibe.agent_posts p
     SET acknowledged_at = now(), closed_reason = 'SCOPE'
     WHERE p.agent = $1 AND p.instance_id = $2
       AND p.acknowledged_at IS NULL
       AND p.kind = 'finding'
       AND p.remote_jid IS NOT NULL
       AND NOT ${clientScopeSql("p.remote_jid")}`,
    [agent, instanceId],
  );
  return rowCount ?? 0;
}

/**
 * Retensiya: 90 gündən köhnə, bağlanmış və ya aşağı ballı postlar silinir.
 * Cavabsız qalmış ciddi bayraq (6+) heç vaxt öz-özünə silinmir — "görmədim"
 * mümkün olmasın. Postu qalmayan 180 günlük gedişatlar da təmizlənir.
 */
export async function cleanupOld(): Promise<void> {
  await pool.query(
    `DELETE FROM katibe.agent_posts
     WHERE created_at < now() - interval '90 days'
       AND (acknowledged_at IS NOT NULL OR severity < 6)`,
  );
  await pool.query(
    `DELETE FROM katibe.agent_runs r
     WHERE r.started_at < now() - interval '180 days'
       AND NOT EXISTS (SELECT 1 FROM katibe.agent_posts p
                       WHERE p.run_id = r.id OR p.last_seen_run_id = r.id)`,
  );
}

const LOCK_KEY_TEXT = "katibe-supervisor";

/**
 * Eyni anda iki gedişat işləməsin. Kilid bu client bağlantısına bağlıdır —
 * caller onu gedişat boyu əlində saxlamalı və sonda release() çağırmalıdır.
 */
export async function acquireRunLock(): Promise<{ client: PoolClient; release: () => Promise<void> } | null> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [LOCK_KEY_TEXT]);
    if (!rows[0].ok) {
      client.release();
      return null;
    }
  } catch (err) {
    client.release();
    throw err;
  }
  return {
    client,
    release: async () => {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY_TEXT]);
      } finally {
        client.release();
      }
    },
  };
}

/**
 * İşi başqa yerə keçmiş söhbətlərin açıq bayraqlarını bağlayır.
 *
 * Filiala yönləndirilmiş müştəri və PR üçün yazan adam — hər ikisində bizim
 * tərəfdə cavab verəcək kimsə yoxdur, ona görə bayraq saatlarla böyüyür və
 * heç vaxt öz-özünə bağlanmır: autoCloseMissing bağlamaq üçün "bizdən cavab
 * getdi" sübutu tələb edir, o sübut isə heç vaxt gəlməyəcək. closeOutOfScope
 * ilə eyni səbəb, ayrı yol (orada kateqoriya dəyişir, burada söhbətin halı).
 *
 * Bağlanmış bayraq İTMİR: söhbət /agent/handoff siyahısında görünür. Sonra
 * qarşı tərəf yeni sual verərsə hal yenidən hesablanır (təzə mesaj →
 * findStaleChats), söhbət WAITING_ON_US-a qayıdır və dedupe açarı azad
 * olduğu üçün TƏZƏ bayraq açılır.
 */
export async function closeHandedOff(agent: string, instanceId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE katibe.agent_posts p
     SET acknowledged_at = now(), closed_reason = 'HANDOFF'
     WHERE p.agent = $1 AND p.instance_id = $2
       AND p.acknowledged_at IS NULL
       AND p.kind = 'finding'
       AND p.remote_jid IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM katibe.chat_state cs
         WHERE cs.instance_id = p.instance_id
           AND cs.remote_jid = p.remote_jid
           AND cs.state IN (${HANDOFF_STATES_SQL})
           AND cs.confidence IN ('HIGH', 'MEDIUM')
           -- Hal bayrağı doğuran mesajı GÖRMÜŞ olmalıdır. Köhnə hala görə
           -- bağlamaq, yönləndirmədən sonra gələn yeni sualı susdurmaq olardı.
           AND cs.last_message_ts >= COALESCE((p.evidence->>'lastInboundTs')::bigint, 0)
       )`,
    [agent, instanceId],
  );
  return rowCount ?? 0;
}
