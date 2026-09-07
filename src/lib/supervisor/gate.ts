import { dedupeKeyFor } from "./persist";
import {
  escalatesPast,
  loadActiveSuppressions,
  loadLastSuppressionDecisions,
  loadPendingSnoozeOutcomes,
  logSuppressionEvent,
  suppressionFor,
  type PendingSnooze,
  type Suppression,
} from "./ratings";
import {
  emptyVerifyStats,
  loadCachedVerdicts,
  needsVerification,
  verifyCandidates,
  VERIFY_MODEL,
  type VerifyCandidate,
  type VerifyStats,
  type VerifyVerdict,
} from "./verify";
import type { ScopedInstanceId } from "../access";
import type { Finding } from "./types";

/*
 * Süzgəc qatı: detektorların tapdığı ilə lentə yazılan arasındakı yeganə yol.
 *
 * İki müstəqil sual, bir çağırışda:
 *   1. DOĞRULAMA — 6+ ballı Client söhbətində müştəri həqiqətən cavab
 *      gözləyir? (verify.ts)
 *   2. SUSDURMA — menecer bu söhbətdə eyni bayrağa artıq 1 verib; vəziyyət
 *      hələ də mahiyyətcə eynidirmi? (ratings.ts)
 *
 * Hər ikisi eyni transkripti oxuyur, ona görə eyni partiyada gedirlər.
 *
 * SÜZGƏC HEÇ VAXT SƏSSİZ İŞLƏMİR. Doğrulama balı endirəndə səbəb posta
 * yazılır və post lentdə qalır; susdurma bayrağı gizlədəndə hadisə
 * agent_suppression_log-a düşür. "Bir şey itdi və heç yerdə izi yoxdur"
 * vəziyyəti mümkün deyil.
 */

export interface GatedFinding {
  finding: Finding;
  dedupeKey: string;
  /** Doğrulama nəticəsi — yoxdursa null (dairədən kənar və ya çağırış alınmayıb). */
  verdict: VerifyVerdict | null;
  /**
   * Bu tapıntı bitmiş möhlətdən sonra geri qayıdırsa — həmin möhlət.
   *
   * Yəni: menecer N gün istəmişdi, müddət bitdi, problem hələ də buradadır.
   * run.ts bunu +1 bala və lentdəki nişana çevirir, sonra jurnala
   * SNOOZE_BROKEN yazır (ratings.ts).
   */
  afterSnooze: PendingSnooze | null;
}

export interface GateResult {
  kept: GatedFinding[];
  /** Susdurulduğu üçün lentə çıxmayan tapıntılar. */
  suppressed: number;
  /** Susdurma qüvvədə idi, amma klapanlardan biri işə düşdü. */
  released: number;
  stats: VerifyStats;
}

/**
 * `sameAsDismissed` cavabı gəlmədikdə nə etməli.
 *
 * SUSDURMA YOX. Model cavab verməyibsə (çağırış uğursuz, JID cavabda yoxdur,
 * sahə null gəlib) bayraq lentə çıxır. Səhvlərin qiyməti bərabər deyil:
 * artıq bayraq bir kliklə bağlanır, itmiş bayraq isə heç vaxt görünmür.
 */
const SUPPRESS_WHEN_UNKNOWN = false;

export async function gateFindings(opts: {
  agent: string;
  instanceId: ScopedInstanceId;
  runId: number;
  findings: Finding[];
  dryRun: boolean;
  /** Menecerin əvvəlki 1/5 qiymətləri — modelə nümunə (ratings.ts). */
  hints: string | null;
  /** Bu gedişatda qalan doğrulama çağırışı büdcəsi. */
  maxCalls: number;
}): Promise<GateResult> {
  const { agent, instanceId, runId, findings, dryRun, hints, maxCalls } = opts;
  const stats = emptyVerifyStats();
  const keyed: GatedFinding[] = findings.map((finding) => ({
    finding,
    dedupeKey: dedupeKeyFor(agent, finding.detector, instanceId, finding.jid),
    verdict: null,
    afterSnooze: null,
  }));
  if (keyed.length === 0) return { kept: keyed, suppressed: 0, released: 0, stats };

  const suppressions = await loadActiveSuppressions(agent, instanceId, { dryRun });
  // Möhlətlərin nəticə siyahısı. Bu çağırış həm də pəncərəsi keçmiş möhlətləri
  // «tutdu» kimi bağlayır, ona görə tapıntı olmasa da işləməlidir — burada,
  // susdurmaların yanında durur ki, hər ikisi eyni gedişatda bir dəfə oxunsun.
  const pendingSnoozes = await loadPendingSnoozeOutcomes(agent, instanceId, { dryRun });
  const lastDecisions = await loadLastSuppressionDecisions(
    [...suppressions.values()].map((s) => s.id),
  );

  // Hər tapıntı üçün: susdurma varmı, klapan işə düşürmü, doğrulanmalıdırmı.
  interface Plan {
    item: GatedFinding;
    sup: Suppression | null;
    escalated: boolean;
    inboundTs: number;
  }
  const plans: Plan[] = keyed.map((item) => {
    const sup = suppressionFor(suppressions, item.finding);
    const inboundTs =
      typeof item.finding.evidence.lastInboundTs === "number"
        ? (item.finding.evidence.lastInboundTs as number)
        : 0;
    return {
      item,
      sup,
      escalated: sup !== null && escalatesPast(item.finding, sup),
      inboundTs,
    };
  });

  // Doğrulama keşi: açıq postdakı nəticə, əgər söhbətə ondan sonra təzə mesaj
  // gəlməyibsə.
  const verifiable = plans.filter((p) => needsVerification(p.item.finding));
  const cached = await loadCachedVerdicts(
    agent,
    instanceId,
    verifiable.map((p) => p.item.dedupeKey),
  );

  const candidates: VerifyCandidate[] = [];
  for (const p of plans) {
    // Daimi susdurma modelə heç bir sual qoymur: nə «hələ də gözləyir?», nə
    // «vəziyyət dəyişib?» — cavabın ikisi də qərarı dəyişmir, çünki bayraq
    // onsuz da lentə çıxmayacaq. Ona görə bu söhbətlər partiyaya ümumiyyətlə
    // düşmür; həm də doğrulama büdcəsini yeməsinlər deyə (tavan 6 çağırışdır).
    if (p.sup?.permanent) continue;

    // MÖHLƏT də modelə sual vermir, eyni iki səbəbdən: bayraq onsuz da lentə
    // çıxmayacaq (deməli cavab qərarı dəyişmir), və «vəziyyət dəyişib?» sualı
    // menecerin öz verdiyi möhləti ləğv etməyin qapısıdır — 2026-08-27-də
    // daimi susdurmanı doğuran problem məhz bu idi. Fərq eskalasiyadadır:
    // klapan işə düşübsə tapıntı lentə çıxacaq, deməli doğrulama yenə lazımdır.
    if (p.sup?.snoozeDays != null && !p.escalated) continue;

    const needsVerify =
      needsVerification(p.item.finding) &&
      cached.get(p.item.dedupeKey)?.inboundTs !== p.inboundTs;
    // Susdurulmuş söhbətdə sual başqadır ("dəyişibmi"), ona görə bal şərti
    // yoxdur. Jurnaldakı son qərar eyni mesaj vəziyyəti üçün verilibsə,
    // təkrar soruşmuruq.
    const needsSimilarity =
      p.sup !== null &&
      !p.escalated &&
      lastDecisions.get(p.sup.id)?.inboundTs !== p.inboundTs;

    if (!needsVerify && !needsSimilarity) {
      const c = cached.get(p.item.dedupeKey);
      if (c) {
        p.item.verdict = c;
        stats.cached++;
      }
      continue;
    }
    if (p.item.finding.jid === null) continue;
    candidates.push({
      jid: p.item.finding.jid,
      contact: p.item.finding.contact,
      detector: p.item.finding.detector,
      dedupeKey: p.item.dedupeKey,
      baseSeverity: p.item.finding.baseSeverity,
      lastInboundTs: p.inboundTs,
      evidence: p.item.finding.evidence,
      ...(p.sup && !p.escalated ? { dismissedSummary: p.sup.summary } : {}),
    });
  }

  const fresh = await verifyCandidates(instanceId, candidates, stats, { dryRun, hints, maxCalls });
  for (const p of plans) {
    const v = fresh.get(p.item.dedupeKey);
    if (v) p.item.verdict = v;
  }

  // Susdurma qərarları — və hər birinin jurnal sətri.
  const kept: GatedFinding[] = [];
  let suppressed = 0;
  let released = 0;
  for (const p of plans) {
    if (!p.sup) {
      kept.push(p.item);
      continue;
    }
    const evidence = {
      lastInboundTs: p.inboundTs,
      contact: p.item.finding.contact,
      title: p.item.finding.title,
      suppressedBaseSeverity: p.sup.baseSeverity,
    };

    // «Bir daha göstərmə» — klapansız. Jurnala isə yazılır: susdurulmuş bayraq
    // heç yerdə görünmür, deməli səhv basılmış düymənin yeganə izi budur.
    // Hər gedişatda yox, söhbətə təzə mesaj gələndə bir dəfə — əks halda
    // jurnal eyni sətirlə saatda bir dolar və auditi oxunmaz edərdi.
    if (p.sup.permanent) {
      suppressed++;
      if (!dryRun && lastDecisions.get(p.sup.id)?.inboundTs !== p.inboundTs) {
        await logSuppressionEvent(
          p.sup.id,
          runId,
          "SUPPRESSED",
          p.item.finding.baseSeverity,
          "Menecer bu bayrağı birdəfəlik bağlayıb — model rəyi soruşulmur.",
          null,
          evidence,
        );
      }
      continue;
    }

    if (p.escalated) {
      released++;
      kept.push(p.item);
      if (!dryRun) {
        await logSuppressionEvent(
          p.sup.id,
          runId,
          "ESCALATED",
          p.item.finding.baseSeverity,
          `Bal ${p.sup.baseSeverity} → ${p.item.finding.baseSeverity} qalxdı — susdurma keçilir.`,
          null,
          evidence,
        );
      }
      continue;
    }

    // MÖHLƏT. Eskalasiyadan sonra yoxlanılır — söz verilmiş müddət ciddiləşən
    // problemi örtmür. Model rəyi soruşulmur, ona görə burada sadəcə susdurulur
    // və jurnala bir sətir düşür. Sətir hər gedişatda yox, söhbətə TƏZƏ mesaj
    // gələndə bir dəfə yazılır (daimi susdurmadakı eyni qayda): əks halda
    // üç günlük möhlət jurnala yetmiş sətir yazıb auditi oxunmaz edərdi.
    if (p.sup.snoozeDays != null) {
      suppressed++;
      if (!dryRun && lastDecisions.get(p.sup.id)?.inboundTs !== p.inboundTs) {
        const until = p.sup.expiresAt
          ? new Intl.DateTimeFormat("az-AZ", {
              timeZone: "Asia/Baku", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
            }).format(new Date(p.sup.expiresAt))
          : null;
        await logSuppressionEvent(
          p.sup.id,
          runId,
          "SUPPRESSED",
          p.item.finding.baseSeverity,
          `${p.sup.snoozeDays} günlük möhlət qüvvədədir${until ? ` — ${until}-dək` : ""}.`,
          null,
          evidence,
        );
      }
      continue;
    }

    const answer = p.item.verdict?.sameAsDismissed;
    const cachedDecision = lastDecisions.get(p.sup.id);
    const same =
      answer !== undefined && answer !== null
        ? answer
        : cachedDecision?.inboundTs === p.inboundTs
          ? cachedDecision.outcome === "SUPPRESSED"
          : SUPPRESS_WHEN_UNKNOWN;

    if (same) {
      suppressed++;
      if (!dryRun && answer !== undefined && answer !== null) {
        await logSuppressionEvent(
          p.sup.id,
          runId,
          "SUPPRESSED",
          p.item.finding.baseSeverity,
          p.item.verdict?.reason ?? null,
          p.item.verdict?.model ?? VERIFY_MODEL,
          evidence,
        );
      }
      continue;
    }

    released++;
    kept.push(p.item);
    // Buraxılma HƏMİŞƏ yazılır, model rəy verməyəndə də. Susdurma qüvvədədir,
    // amma bayraq yenə çıxıbsa, menecer bunu "susdurma işləmir" kimi görəcək —
    // səbəbin jurnalda olmaması ən pis haldır. Keşdən gələn qərarda isə
    // yazılmır: onun öz sətri artıq var.
    const fromCache = answer === undefined || answer === null;
    if (!dryRun && !(fromCache && cachedDecision?.inboundTs === p.inboundTs)) {
      await logSuppressionEvent(
        p.sup.id,
        runId,
        "DIFFERENT",
        p.item.finding.baseSeverity,
        fromCache
          ? "Model rəyi alınmadı (çağırış uğursuz və ya tavan doldu) — bayraq susdurulmadı."
          : (p.item.verdict?.reason ?? null),
        fromCache ? null : (p.item.verdict?.model ?? VERIFY_MODEL),
        evidence,
      );
    }
  }

  // Bitmiş möhlətin nəticəsi. Yalnız SÜZGƏCDƏN KEÇƏNLƏRƏ baxılır: susdurulmuş
  // tapıntı lentə çıxmır, deməli «problem davam edir» hökmü də verilə bilməz.
  for (const item of kept) {
    if (item.finding.jid === null) continue;
    const snooze = pendingSnoozes.get(`${item.finding.detector}:${item.finding.jid}`);
    if (snooze) item.afterSnooze = snooze;
  }

  return { kept, suppressed, released, stats };
}
