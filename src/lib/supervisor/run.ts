import { getSalesInstances, getBusinessCalendar, businessOverlapMinutes, coverageOverlapMinutes, coverageLabel } from "./scope";
import { syncConnectivity, readyForRevalidation, clearRevalidation, formatOutage } from "./connectivity";
import { findStaleChats, classifyChats } from "./chat-state";
import { DETECTORS, buildDigest } from "./detectors";
import { applyAdjustment, verdictFor } from "./severity";
import { gateFindings } from "./gate";
import { applyVerification } from "./verify";
import { getRatingHints, markSnoozeBroken } from "./ratings";
import { renderFindingBody, renderAllClear } from "./templates";
import { buildInput, generateCommentary, pickModel } from "./llm";
import {
  acquireRunLock,
  autoCloseMissing,
  cleanupOld,
  closeHandedOff,
  closeOutOfScope,
  createRun,
  dedupeKeyFor,
  finishRun,
  getLastWindowEnd,
  refreshOpenPost,
  upsertPost,
} from "./persist";
import type { DetectorContext, Finding } from "./types";

// Bir gedişat: Sales instanslarını gəz, detektorları işlət, lazımsa modelə
// şərh yazdır, postları yaz, dashboard-a "yenilən" siqnalı göndər.
//
// Söhbət dairəsi: yalnız Client kateqoriyalı və hələ kateqoriyasız nömrələr
// (clientScopeSql, scope.ts) — həm detektorlarda, həm hal təsnifatında.
//
// Nəzarət saatlarından kənarda (coverageOverlapMinutes = 0) yalnız açıq
// postlar təzələnir — nə yeni post, nə model çağırışı. Gecə yaranan pozuntu
// səhərki ilk gedişatda üzə çıxır. Bu pəncərə SLA təqvimindən genişdir və
// ondan asılı deyil (scope.ts).
//
// QOPUQ İNSTANS TAMAMİLƏ ATLANIR. Sessiya ölü ikən Message cədvəli donur:
// müştərinin yazdığı gəlmir, satıcının telefondan verdiyi cavab düşmür. O
// məlumatla işləmək bayraqları yalanlaşdırır — "cavabsız" saatı öz-özünə
// böyüyür. Ona görə qopuq instansda nə yeni post açılır, nə mövcud bayraq
// təzələnir; lentdə də gizlədilir (feed.ts). Qayıdandan sonra ilk gedişat
// pəncərəni qopma anına qədər geri açıb hamısını yenidən yoxlayır.

export const AGENT_KEY = "nazaratchi";

/** Saatlıq kadansda normal pəncərə 1 saatdır; buraxılmış gedişatlar üçün 12 saata qədər uzanır. */
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 12;

/** Qopmadan qayıdan instansın yenidən yoxlanma pəncərəsi bundan geriyə açılmır. */
const REVALIDATE_MAX_HOURS = 24;

/**
 * Yenidən yoxlama pəncərəsi qopma anından bir saat DAHA geriyə açılır.
 *
 * Qopmanın başlanğıcı təxminidir: öz tarixçəmiz boş olanda Evolution-un sətir
 * yenilənmə anı götürülür (connectivity.ts), o isə həqiqi qopmadan sonraya
 * düşə bilər — 2026-08-25-də sessiya 18:18-də getdi, sətir 23:32-də yeniləndi.
 * Pəncərəni geniş tutmaq ucuzdur, dar tutmaq isə bayrağı qırmızı qoyur.
 */
const REVALIDATE_MARGIN_MINUTES = 60;

export interface RunOptions {
  trigger: "cron" | "manual" | "revalidate";
  /**
   * Yalnız qopmadan qayıdıb hələ yenidən yoxlanılmamış instanslar.
   *
   * Saatlıq gedişat onsuz da bunu edir, amma nömrə saat 10:10-da qayıdanda
   * 11:05-ə qədər bayraqları gizli qalır. Bu rejim 15 dəqiqədən bir işləyib
   * yalnız nişanlı instansı yoxlayır — qalanlarına toxunmur, deməli boş
   * gedişat heç nəyə baha oturmur.
   */
  onlyRevalidating?: boolean;
  /** Pəncərəni məcburi bu qədər saat geriyə aç — test üçün. */
  windowHours?: number;
  /** Yalnız bu instansı yoxla. */
  instanceId?: string;
  dryRun: boolean;
  /** Gedişat başına şərh çağırışlarının tavanı — xərc qapağı. */
  maxLlmCalls: number;
  /**
   * Gedişat başına doğrulama çağırışlarının tavanı — AYRI qapaq.
   *
   * Şərh büdcəsinə salsaq, çoxlu bayraqlı bir instans bütün tavanı yeyib
   * qalan satıcıların postlarını şablona salardı (hal təsnifatı ilə eyni
   * səhv bir dəfə edilib). Doğrulama Sonnet-dədir, ona görə tavanı da öz
   * qiymətinə görə ayrıca seçilir.
   */
  maxVerifyCalls: number;
}

export interface RunSummary {
  windowStart: Date;
  windowEnd: Date;
  instanceCount: number;
  /** Qopuq olduğu üçün atlanan instanslar. */
  frozenCount: number;
  findingCount: number;
  postCount: number;
  autoClosedCount: number;
  llmCalls: number;
  stateCalls: number;
  /** Söhbəti oxuyub bayrağı doğrulayan çağırışlar (verify.ts). */
  verifyCalls: number;
  /** Doğrulama nəticəsində sancaqdan çıxan bayraqlar. */
  downgradedCount: number;
  /** Menecerin reytinq 1-i ilə susdurulub lentə çıxmayan tapıntılar. */
  suppressedCount: number;
  inputTokens: number;
  outputTokens: number;
  notified: boolean;
}

// $/MTok — scripts/identify-clients.ts-dəki cədvəllə eyni.
const PRICE: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5": [2, 10],
  "claude-opus-5": [5, 25],
};

function bakuDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baku" }).format(d);
}

async function notifyDashboard(instanceId: string, count: number, maxSeverity: number): Promise<boolean> {
  const secret = process.env.KATIBE_WEBHOOK_SECRET;
  if (!secret) {
    console.warn("[supervisor] KATIBE_WEBHOOK_SECRET yoxdur — canlı siqnal göndərilmir");
    return false;
  }
  const base = process.env.KATIBE_BASE_URL || "http://127.0.0.1:3000";
  try {
    const res = await fetch(`${base}/api/webhooks/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-katibe-webhook-secret": secret },
      body: JSON.stringify({ instanceId, count, maxSeverity }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    // Siqnal çatmasa da postlar bazadadır — növbəti səhifə açılışı göstərəcək.
    console.warn("[supervisor] canlı siqnal alınmadı:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function runSupervisor(opts: RunOptions): Promise<RunSummary | null> {
  const lock = await acquireRunLock();
  if (!lock) {
    console.log("[supervisor] başqa gedişat işləyir — çıxıram.");
    return null;
  }

  try {
    const now = new Date();
    let windowStart: Date;
    if (opts.windowHours) {
      windowStart = new Date(now.getTime() - opts.windowHours * 3600_000);
    } else {
      const lastEnd = await getLastWindowEnd(AGENT_KEY);
      const min = new Date(now.getTime() - MIN_WINDOW_HOURS * 3600_000);
      const max = new Date(now.getTime() - MAX_WINDOW_HOURS * 3600_000);
      windowStart = lastEnd ? new Date(Math.max(max.getTime(), Math.min(lastEnd.getTime(), min.getTime()))) : min;
    }
    const windowEnd = now;
    const windowHours = (windowEnd.getTime() - windowStart.getTime()) / 3600_000;

    let instances = await getSalesInstances();
    if (opts.instanceId) instances = instances.filter((i) => i.instanceId === opts.instanceId);
    console.log(
      `[supervisor] pəncərə ${windowStart.toISOString()} → ${windowEnd.toISOString()} ` +
        `(${windowHours.toFixed(1)} saat), nəzarət saatları ${coverageLabel()}, ` +
        `${instances.length} Sales instansı${opts.dryRun ? " — DRY RUN" : ""}`,
    );
    if (instances.length === 0) {
      console.log("[supervisor] izlənəcək instans yoxdur (Sales kateqoriyalı user-ə bağlı aktiv instans tapılmadı).");
      return null;
    }

    // Bağlantı vəziyyəti gedişatın ƏVVƏLİNDƏ bir dəfə oxunur və tarixçəsi
    // yenilənir: kim qopub, kim təzəcə qayıdıb (connectivity.ts).
    const links = await syncConnectivity(opts.dryRun);

    if (opts.onlyRevalidating) {
      instances = instances.filter((i) => {
        const link = links.get(i.instanceId);
        return link ? readyForRevalidation(link, now) : false;
      });
      if (instances.length === 0) {
        console.log("[supervisor] yenidən yoxlanmalı instans yoxdur — çıxıram.");
        return null;
      }
      console.log(
        `[supervisor] yenidən yoxlama rejimi: ${instances.map((i) => i.instanceName).join(", ")}`,
      );
    }

    const runId = opts.dryRun ? 0 : await createRun(AGENT_KEY, opts.trigger, windowStart, windowEnd);

    const totals = {
      findings: 0, posts: 0, autoClosed: 0, llmCalls: 0, stateCalls: 0,
      verifyCalls: 0, verifyCached: 0, downgraded: 0, suppressed: 0,
      inTok: 0, outTok: 0, costUsd: 0, frozen: 0,
    };
    let anyNotified = false;
    let firstError: string | null = null;

    for (const inst of instances) {
      try {
        const link = links.get(inst.instanceId);

        // Qopuq instans: heç nəyə toxunulmur. Bayraqlar olduğu kimi donur —
        // nə təzələnir (yaşı böyüməsin), nə bağlanır (sübut gələ bilməz),
        // nə də yenisi açılır. Lentdə onları feed.ts gizlədir; nə baş
        // verdiyini isə sağlamlıq bayrağı danışır (check-instance-health.ts).
        if (link && !link.online) {
          totals.frozen += 1;
          const since = link.downSince ?? link.changedAt;
          console.log(
            `[supervisor] ${inst.userName}/${inst.instanceName}: WhatsApp qopub ` +
              `(${link.status}, ${formatOutage(since, now)}) — atlanır, bayraqları dondurulub.`,
          );
          continue;
        }

        // Qopmadan qayıdıb: pəncərə qopmanın başlanğıcına qədər geri açılır.
        // Dar pəncərə ilə baxsaq, oflayn növbədən gələn köhnə tarixli cavab
        // pəncərəyə düşməz və həll olunmuş bayraq qırmızı qalardı.
        const revalidating = link ? readyForRevalidation(link, now) : false;
        const instWindowStart =
          revalidating && link?.revalidateFrom
            ? new Date(
                Math.max(
                  now.getTime() - REVALIDATE_MAX_HOURS * 3600_000,
                  Math.min(
                    windowStart.getTime(),
                    link.revalidateFrom.getTime() - REVALIDATE_MARGIN_MINUTES * 60_000,
                  ),
                ),
              )
            : windowStart;
        if (revalidating && link?.revalidateFrom) {
          console.log(
            `[supervisor] ${inst.userName}/${inst.instanceName}: ` +
              `${formatOutage(link.revalidateFrom, link.changedAt)} qopmadan sonra qayıdıb — ` +
              `bayraqlar ${instWindowStart.toISOString()}-dən yenidən yoxlanılır.`,
          );
        }
        const instWindowHours = (windowEnd.getTime() - instWindowStart.getTime()) / 3600_000;

        const cal = await getBusinessCalendar(inst.userId);
        // İki fərqli sual, iki fərqli təqvim (scope.ts): overlap detektorların
        // SLA riyaziyyatı üçündür, coverage isə "indi post açmaq vaxtıdırmı".
        const overlap = businessOverlapMinutes(instWindowStart, windowEnd, cal);
        const coverage = coverageOverlapMinutes(instWindowStart, windowEnd);
        const ctx: DetectorContext = {
          instanceId: inst.instanceId,
          instanceName: inst.instanceName,
          userId: inst.userId,
          userName: inst.userName,
          windowStart: instWindowStart,
          windowEnd,
          businessOverlapMinutes: overlap,
        };

        // Dairədən çıxmış bayraqlar (söhbət Client olmayan kateqoriyaya
        // salınıb) burada bağlanır — detektorlar onları onsuz da qaytarmır,
        // autoCloseMissing isə sübut tapmadığı üçün heç vaxt bağlaya bilməzdi.
        if (!opts.dryRun) {
          const scoped = await closeOutOfScope(AGENT_KEY, inst.instanceId);
          if (scoped > 0) {
            console.log(`[supervisor] ${inst.userName}: ${scoped} bayraq dairədən çıxdığı üçün bağlandı.`);
            totals.autoClosed += scoped;
          }
          // İşi başqa filiala keçmiş və PR üçün yazan söhbətlər — eyni səbəb, ayrı
          // yol: autoCloseMissing "bizdən cavab getdi" sübutu istəyir, burada
          // isə cavab verəcək adam bizim tərəfdə yoxdur (persist.ts).
          const handed = await closeHandedOff(AGENT_KEY, inst.instanceId);
          if (handed > 0) {
            console.log(
              `[supervisor] ${inst.userName}: ${handed} bayraq bağlandı — iş filiala/PR-a keçib.`,
            );
            totals.autoClosed += handed;
          }
        }

        // Detektorlardan ƏVVƏL: təzə mesajı olan söhbətlərin halı yenilənir
        // (katibe.chat_state) — unanswered süzgəci və customer_deciding
        // detektoru saxlanmış hala baxır. Dəyişməyən söhbət heç nə xərcləmir;
        // sabit rejimdə bu, saatda bir ovuc söhbətdir. İş saatından kənarda
        // və dry-run-da keçilir.
        if (coverage > 0 && !opts.dryRun && process.env.SUP_STATE !== "0") {
          try {
            const stale = await findStaleChats(inst.instanceId, {
              sinceDays: 90,
              limit: Number(process.env.SUP_STATE_MAX_CHATS ?? 40),
            });
            if (stale.length > 0) {
              const s = await classifyChats(inst.instanceId, stale);
              // Hal təsnifatının çağırışları AYRI sayılır: onları şərh
              // büdcəsinə salmaq bir dəfə bütün tavanı yeyib hər postu
              // şablona salmışdı.
              totals.stateCalls += s.llmCalls;
              totals.inTok += s.inputTokens;
              totals.outTok += s.outputTokens;
              totals.costUsd += s.costUsd;
              console.log(
                `[supervisor] ${inst.userName}: ${s.classified} söhbət halı yeniləndi` +
                  (s.escalated ? ` (${s.escalated} Sonnet eskalasiyası)` : ""),
              );
            }
          } catch (err) {
            // Hal yenilənməsə köhnə hal işlədilir — gedişat dayanmır.
            console.error(`[supervisor] ${inst.userName}: hal təsnifatı alınmadı —`, err instanceof Error ? err.message : err);
          }
        }

        const findings: Finding[] = [];
        for (const d of DETECTORS) findings.push(...(await d.run(ctx)));
        totals.findings += findings.length;

        // Nəzarət saatlarından kənar: yeni post açılmır, amma açıq bayraqlar təzələnir
        // və artıq keçərli olmayanlar bağlanır — gecə cavab verilən söhbət
        // səhərə qədər qırmızı qalmasın.
        if (coverage === 0) {
          let refreshed = 0;
          let closed = 0;
          if (!opts.dryRun) {
            for (const f of findings) {
              const key = dedupeKeyFor(AGENT_KEY, f.detector, inst.instanceId, f.jid);
              if (await refreshOpenPost(key, runId, f.evidence)) refreshed++;
            }
            closed = await autoCloseMissing(
              AGENT_KEY,
              inst.instanceId,
              findings.map((f) => dedupeKeyFor(AGENT_KEY, f.detector, inst.instanceId, f.jid)),
            );
          }
          // Yenidən yoxlama bu budaqda da tamdır: bayraqlar təzələnir və
          // həll olunanlar bağlanır. Nişanı burada silmək olar.
          if (revalidating && !opts.dryRun) await clearRevalidation(inst.instanceId);
          totals.autoClosed += closed;
          console.log(
            `[supervisor] ${inst.userName}/${inst.instanceName}: nəzarət saatlarından kənar — ` +
              `${findings.length} tapıntıdan ${refreshed} açıq bayraq yeniləndi, ${closed} avtomatik bağlandı.`,
          );
          continue;
        }

        const digest = await buildDigest(ctx);

        // Menecerin əvvəlki 1/5 qiymətləri — həm doğrulayıcıya, həm şərh
        // modelinə nümunə kimi verilir (ratings.ts). Datasetin ilk praktik işi.
        const hints = await getRatingHints(AGENT_KEY, inst.instanceId);

        // SÜZGƏC. Detektorun tapdığı ilə lentə yazılan arasındakı yeganə yol:
        // 6+ ballı Client söhbətləri söhbətin son 15 mesajı ilə doğrulanır,
        // menecerin 1 verdiyi bayraqlar isə vəziyyət dəyişməyibsə susdurulur
        // (gate.ts). Hər iki qərar iz buraxır — bax həmin faylın başlığına.
        const gate = await gateFindings({
          agent: AGENT_KEY,
          instanceId: inst.instanceId,
          runId,
          findings,
          dryRun: opts.dryRun,
          hints,
          maxCalls: Math.max(0, opts.maxVerifyCalls - totals.verifyCalls),
        });
        totals.verifyCalls += gate.stats.llmCalls;
        totals.verifyCached += gate.stats.cached;
        totals.suppressed += gate.suppressed;
        totals.inTok += gate.stats.inputTokens;
        totals.outTok += gate.stats.outputTokens;
        totals.costUsd += gate.stats.costUsd;
        if (gate.stats.llmCalls || gate.suppressed || gate.released) {
          console.log(
            `[supervisor] ${inst.userName}: doğrulama ${gate.stats.llmCalls} çağırış` +
              (gate.stats.cached ? ` (+${gate.stats.cached} keşdən)` : "") +
              (gate.suppressed ? `, ${gate.suppressed} tapıntı susduruldu` : "") +
              (gate.released ? `, ${gate.released} susdurma keçildi` : ""),
          );
        }
        const keyed = gate.kept;

        // Model yalnız tapıntı olanda çağırılır; sakit pəncərə şablonla keçir.
        let llm: Awaited<ReturnType<typeof generateCommentary>> | null = null;
        if (keyed.length > 0) {
          const model = pickModel(findings);
          const input = buildInput(inst.userName, instWindowHours, digest, keyed, hints);
          if (opts.dryRun) {
            const estIn = Math.round(input.length / 3.5) + 1200;
            const estOut = 150 * keyed.length + 100;
            console.log(
              `[supervisor] ${inst.userName}: ${keyed.length} tapıntı — ${model} çağırılardı, ` +
                `giriş ~${estIn} / çıxış ~${estOut} token (göndərilmədi)`,
            );
          } else if (totals.llmCalls >= opts.maxLlmCalls) {
            console.warn(
              `[supervisor] ${inst.userName}: model çağırış tavanı (${opts.maxLlmCalls}) doldu — şablon mətnlər işlədilir.`,
            );
          } else {
            try {
              llm = await generateCommentary(model, input);
              totals.llmCalls += 1;
              totals.inTok += llm.inputTokens;
              totals.outTok += llm.outputTokens;
              const [pin, pout] = PRICE[model] ?? [0, 0];
              totals.costUsd += (llm.inputTokens / 1e6) * pin + (llm.outputTokens / 1e6) * pout;
            } catch (err) {
              // Tapıntı itmir — şablon mətnə düşür.
              console.error(
                `[supervisor] ${inst.userName}: model çağırışı alınmadı, şablona keçildi —`,
                err instanceof Error ? err.message : err,
              );
            }
          }
        }

        let instPosts = 0;
        let maxSeverity = 0;
        for (const { dedupeKey, finding, verdict, afterSnooze } of keyed) {
          const c = llm?.bodies.get(dedupeKey);
          const adjusted = c ? applyAdjustment(finding.baseSeverity, c.severityAdjust) : finding.baseSeverity;
          // İki fərqli düzəliş, ardıcıl: şərh modeli rəqəmlərə baxıb ±2 edir
          // (applyAdjustment 6+-ı sındıra bilmir), doğrulayıcı isə söhbəti
          // oxuyub yalnız HIGH əminliklə balı 5-ə endirə bilir.
          const verified = applyVerification(adjusted, verdict);
          if (verified < adjusted) totals.downgraded += 1;
          // ÜÇÜNCÜ DÜZƏLİŞ, və yeganə insan mənşəli olanı: pozulmuş möhlət.
          // Menecer N gün istəmişdi, müddət bitdi, problem yerindədir — bu,
          // eyni balla qayıdan adi bayraq deyil, verilmiş sözün pozulmasıdır
          // və lentdə birincilərin arasında durmalıdır. Tavan 10-dur.
          const severity = afterSnooze ? Math.min(10, verified + 1) : verified;
          const body = c?.body || renderFindingBody(finding);
          const severityReason =
            [
              afterSnooze
                ? `${afterSnooze.days} gün möhlət verilmişdi, problem davam edir — +1 bal.`
                : null,
              c && c.severityAdjust !== 0 && c.adjustReason ? c.adjustReason : null,
            ]
              .filter(Boolean)
              .join(" ") || null;
          maxSeverity = Math.max(maxSeverity, severity);

          if (opts.dryRun) {
            console.log(
              `  [${severity}/${finding.baseSeverity}] ${finding.detector} ${finding.contact ?? "-"}` +
                (verdict ? ` (doğrulama: ${verdict.state}/${verdict.confidence})` : "") +
                ` :: ${body}`,
            );
            continue;
          }
          await upsertPost({
            runId,
            agent: AGENT_KEY,
            instanceId: inst.instanceId,
            userId: inst.userId,
            finding,
            kind: "finding",
            severity,
            severityReason,
            verdict: verdictFor(severity),
            body,
            llmModel: c ? (llm?.model ?? null) : null,
            dedupeKey,
            verify: verdict,
            afterSnoozeDays: afterSnooze?.days ?? null,
          });
          // Nəticə YALNIZ post yazıldıqdan sonra jurnala düşür: «möhlət
          // pozuldu» hökmünün mənası bayrağın həqiqətən lentə qayıtmasıdır.
          // Bir dəfə yazılır (markSnoozeBroken özü qoruyur), ona görə növbəti
          // gedişat eyni sətri təkrarlamır.
          if (afterSnooze) {
            await markSnoozeBroken(afterSnooze, runId, severity, {
              lastInboundTs: finding.evidence.lastInboundTs ?? null,
              contact: finding.contact,
              title: finding.title,
            });
          }
          instPosts++;
        }

        // Sakit, amma canlı pəncərə → gündə bir dənə "hər şey qaydasındadır".
        if (keyed.length === 0 && digest.inbound + digest.outbound > 0) {
          const allClearFinding: Finding = {
            detector: "all_clear",
            jid: null,
            contact: null,
            baseSeverity: 2,
            title: `${inst.userName}: hər şey qaydasındadır`,
            evidence: { ...digest },
          };
          const body = renderAllClear(inst.userName, digest, instWindowHours);
          if (opts.dryRun) {
            console.log(`  [2] all_clear ${inst.userName} :: ${body}`);
          } else {
            await upsertPost({
              runId,
              agent: AGENT_KEY,
              instanceId: inst.instanceId,
              userId: inst.userId,
              finding: allClearFinding,
              kind: "all_clear",
              severity: 2,
              severityReason: null,
              verdict: "OK",
              body,
              llmModel: null,
              dedupeKey: `${AGENT_KEY}:all_clear:${inst.instanceId}:${bakuDate(now)}`,
              verify: null,
              afterSnoozeDays: null,
            });
            instPosts++;
          }
        }

        // Bu gedişatda görünməyən köhnə bayraqlar həll olunub — bağlanır.
        // Dry-run-da yazı yoxdur, ona görə keçilir.
        const autoClosed = opts.dryRun
          ? 0
          : await autoCloseMissing(
              AGENT_KEY,
              inst.instanceId,
              keyed.map((k) => k.dedupeKey),
            );

        // Tam gedişat bitdi — qayıdış nişanı silinir: bayraqlar təzə
        // məlumatla yoxlanıldı.
        if (revalidating && !opts.dryRun) await clearRevalidation(inst.instanceId);

        totals.posts += instPosts;
        totals.autoClosed += autoClosed;
        console.log(
          `[supervisor] ${inst.userName}/${inst.instanceName}: ${findings.length} tapıntı, ` +
            `${instPosts} post${llm ? ` (${llm.model})` : " (şablon)"}` +
            (autoClosed ? `, ${autoClosed} avtomatik bağlandı` : ""),
        );

        if (!opts.dryRun && instPosts > 0) {
          anyNotified = (await notifyDashboard(inst.instanceId, instPosts, maxSeverity)) || anyNotified;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        firstError = firstError ?? `${inst.instanceName}: ${message}`;
        console.error(`[supervisor] ${inst.userName}/${inst.instanceName}: gedişat xətası —`, message);
      }
    }

    if (!opts.dryRun) {
      await finishRun(runId, {
        status: firstError ? "error" : "ok",
        error: firstError,
        instanceCount: instances.length,
        findingCount: totals.findings,
        llmCalls: totals.llmCalls + totals.stateCalls + totals.verifyCalls,
        inputTokens: totals.inTok,
        outputTokens: totals.outTok,
        costUsd: totals.costUsd,
      });
      await cleanupOld();
    }

    console.log(
      `[supervisor] bitdi: ${totals.findings} tapıntı, ${totals.posts} post, ` +
        (totals.frozen ? `${totals.frozen} qopuq instans atlandı, ` : "") +
        `${totals.autoClosed} avtomatik bağlanma, ` +
        (totals.suppressed ? `${totals.suppressed} susdurulmuş tapıntı, ` : "") +
        (totals.downgraded ? `${totals.downgraded} bayraq doğrulama ilə sancaqdan çıxdı, ` : "") +
        `${totals.llmCalls} şərh + ${totals.stateCalls} hal + ${totals.verifyCalls} doğrulama çağırışı ` +
        `(giriş ${totals.inTok} / çıxış ${totals.outTok} token` +
        (totals.llmCalls + totals.stateCalls + totals.verifyCalls ? ` ≈ $${totals.costUsd.toFixed(4)}` : "") +
        `)`,
    );

    return {
      windowStart,
      windowEnd,
      instanceCount: instances.length,
      frozenCount: totals.frozen,
      findingCount: totals.findings,
      postCount: totals.posts,
      autoClosedCount: totals.autoClosed,
      llmCalls: totals.llmCalls,
      stateCalls: totals.stateCalls,
      verifyCalls: totals.verifyCalls,
      downgradedCount: totals.downgraded,
      suppressedCount: totals.suppressed,
      inputTokens: totals.inTok,
      outputTokens: totals.outTok,
      notified: anyNotified,
    };
  } finally {
    await lock.release();
  }
}
