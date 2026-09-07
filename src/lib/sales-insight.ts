import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { pool } from "./db";
import { requireAdmin } from "./access";
import { formatDuration } from "./format";
import { slaBreachPct, unansweredPct } from "./sales-stats";
import { closedTotal, readSnapshots, type Snapshot } from "./sales-history";

/*
 * Faktlar: «kim nə ilə seçilir», «bayraq nə qədər sonra bağlanır», «hansı
 * saatlarda aktivdirlər», «hansı mövzularda necədirlər», «həftə sonu daha
 * gecmi».
 *
 * QAYDA, BİR CÜMLƏDƏ: rəqəm koddan, cümlə modeldən. Model heç bir hesablama
 * aparmır — ona hazır rəqəmlər verilir və yalnız hansının deməyə dəyər
 * olduğunu seçib insan dilinə çevirir. `direction` («düzəlib» / «pisləşib»)
 * də kodda hesablanır: bu, ölçülə bilən iddiadır və modelin əhval-ruhiyyəsindən
 * asılı olmamalıdır. Nəzarətçidəki severity.ts ilə eyni bölgü.
 *
 * Dizayn: docs/satici-fakt-qati-dizayn.md §9
 */

export const INSIGHT_MODEL = "claude-sonnet-5";
export const TRANSLATE_MODEL = "claude-haiku-4-5";
/** Bir dövr üçün tavan. Doqquzuncu fakt onuncunu doğurur və lent oxunmaz olur. */
export const MAX_INSIGHTS = 8;

export type InsightKind = "difference" | "flag" | "hours" | "topic" | "weekend";
export type Direction = "better" | "worse" | "flat" | "new";

export interface Candidate {
  kind: InsightKind;
  userId: number | null;
  userName: string | null;
  /** null = müqayisə olunmayıb (mövzu qarışığının əvvəlki dövrü yoxdur). */
  direction: Direction | null;
  evidence: Record<string, unknown>;
  /** Modelə verilən quru təsvir: yalnız rəqəmlər və adlar. */
  facts: string;
}

export interface Insight {
  id: number;
  periodStart: string;
  periodEnd: string;
  userId: number | null;
  userName: string | null;
  kind: InsightKind;
  headline: string;
  body: string;
  evidence: Record<string, unknown>;
  /** Faktın altındakı quru rəqəm cümləsi — modelə verildiyi mətnin eynisi. */
  basis: string;
  direction: Direction | null;
}

/**
 * Bağlanma səbəbinin insan adı.
 *
 * Modelə xam kod («RATED_NOISE 5») verilirdi və o, kodu izah etməyə çalışıb
 * uydururdu. İzah cümləsi əlavə etmək kömək edirdi, amma faktın altındakı
 * `basis` sətri ekranda göründüyü üçün oxucu da həmin kodları görürdü —
 * halbuki lentdə eyni şeyin adı «Bir daha göstərilməyəcək»dir. Ad bir yerdə
 * yazılır, izaha ehtiyac qalmır.
 */
const REASON_NAMES: Record<string, string> = {
  AUTO: "öz-özünə həll olundu",
  MANUAL: "insan bağladı",
  SNOOZED: "möhlət verildi",
  MUTED: "bir daha göstərilməyəcək",
  RATED_NOISE: "«lazımsız» qiyməti",
  SCOPE: "müştəri dairəsindən çıxdı",
  HANDOFF: "iş filiala/PR-a keçdi",
  BİLİNMİR: "səbəbi yazılmayıb",
};

const TOPIC_NAMES: Record<string, string> = {
  GENERAL: "ümumi",
  PRODUCT_INFO: "məhsul sualı",
  ORDER: "sifariş",
  LOGISTICS: "çatdırılma",
  PAYMENT: "ödəniş",
  PRICE_INQUIRY: "qiymət sualı",
  COMPLAINT: "şikayət",
};

/** Faizdə 1 bənd, müddətdə 10% — bundan kiçik dəyişiklik səs-küydür. */
function directionOf(current: number | null, previous: number | null, kind: "pct" | "dur"): Direction {
  if (current === null) return "flat";
  if (previous === null) return "new";
  const delta = current - previous;
  const threshold = kind === "pct" ? 1 : Math.max(60, previous * 0.1);
  if (Math.abs(delta) < threshold) return "flat";
  return delta > 0 ? "worse" : "better";
}

function pctText(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function durText(value: number | null): string {
  return value === null ? "—" : formatDuration(value);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** «Qapının bağlandığı saat» — cavab axınının pikin 10%-inə düşdüyü son saat. */
function closingHour(hours: Snapshot["payload"]["hours"]): number | null {
  const peak = Math.max(0, ...hours.map((h) => h.outCount));
  if (peak === 0) return null;
  const active = hours.filter((h) => h.outCount >= peak * 0.1).map((h) => h.hour);
  return active.length === 0 ? null : Math.max(...active);
}

function peakHour(hours: Snapshot["payload"]["hours"]): number | null {
  let best: { hour: number; n: number } | null = null;
  for (const h of hours) if (!best || h.outCount > best.n) best = { hour: h.hour, n: h.outCount };
  return best && best.n > 0 ? best.hour : null;
}

export function buildCandidates(current: Snapshot[], previous: Snapshot[]): Candidate[] {
  const prevByUser = new Map(previous.map((s) => [s.userId, s]));
  const out: Candidate[] = [];

  // Komanda medianları — «seçilir» sözünün ölçüsü budur.
  const teamUnanswered = median(
    current.map((s) => unansweredPct(s.payload.total)).filter((v): v is number => v !== null),
  );
  const teamFrt = median(
    current.map((s) => s.frtMedianSeconds).filter((v): v is number => v !== null),
  );

  for (const snap of current) {
    const prev = prevByUser.get(snap.userId) ?? null;
    const m = snap.payload.total;
    const unans = unansweredPct(m);
    const prevUnans = prev ? unansweredPct(prev.payload.total) : null;

    // 1. Kim nə ilə seçilir
    out.push({
      kind: "difference",
      userId: snap.userId,
      userName: snap.userName,
      direction: directionOf(unans, prevUnans, "pct"),
      evidence: {
        gözləmə: m.opportunities,
        cavabsızFaiz: unans,
        komandaCavabsızFaiz: teamUnanswered,
        ilkCavabSaniyə: snap.frtMedianSeconds,
        komandaİlkCavabSaniyə: teamFrt,
        hədəfiKeçənFaiz: slaBreachPct(m),
        keçənHəftəCavabsızFaiz: prevUnans,
      },
      facts:
        `${snap.userName}: ${m.opportunities} gözləmə, cavabsız ${pctText(unans)} ` +
        `(komanda medianı ${pctText(teamUnanswered)}), ilk cavab ${durText(snap.frtMedianSeconds)} ` +
        `(komanda ${durText(teamFrt)}), hədəfi keçən ${pctText(slaBreachPct(m))}. ` +
        `Keçən həftə cavabsız ${pctText(prevUnans)}.`,
    });

    // 2. Bayraqlar nə qədər sonra HƏLL OLUNUR
    //
    // «Bağlanır» deyil, və fərq ölçünün özündədir: bağlanmaların bir hissəsi
    // heç nə həll etmir (bax sales-history.ts: FlagStats). Model isə ona
    // verilən rəqəmi olduğu kimi oxuyur — «bağlanan 97» sətrini görəndə onu
    // nailiyyət kimi yazır, çünki başqa məlumatı yoxdur.
    //
    // Ona görə üç rəqəm ayrı-ayrı verilir və heç biri gizlədilmir: modelin
    // səhv yazmaması üçün lazım olan şey susdurulmuş bayraqları GÖRÜNƏN
    // etməkdir. «Möhlətə salınan 5» sətri faktın özündə duranda, model
    // «bayraqları tez bağlayır» cümləsini yaza bilmir.
    const flags = snap.payload.flags;
    const prevFlags = prev?.payload.flags ?? null;
    const gone = closedTotal(flags);
    if (flags.opened > 0 || gone > 0) {
      const reasons = Object.entries(flags.byReason)
        .map(([r, n]) => `${REASON_NAMES[r] ?? r} ${n}`)
        .join(", ");
      out.push({
        kind: "flag",
        userId: snap.userId,
        userName: snap.userName,
        direction: directionOf(
          flags.medianResolveSeconds,
          prevFlags?.medianResolveSeconds ?? null,
          "dur",
        ),
        evidence: {
          açılan: flags.opened,
          həllOlunan: flags.resolved,
          möhlətəSalınan: flags.deferred,
          gündəmdənÇıxan: flags.dismissed,
          həllMedianSaniyə: flags.medianResolveSeconds,
          keçənHəftəHəllMedianSaniyə: prevFlags?.medianResolveSeconds ?? null,
          səbəblər: flags.byReason,
        },
        facts:
          `${snap.userName}: ${flags.opened} bayraq açıldı; ${flags.resolved} həll olundu ` +
          `(median ${durText(flags.medianResolveSeconds)}, keçən həftə ` +
          `${durText(prevFlags?.medianResolveSeconds ?? null)})` +
          // Sıfır qrup yazılmır. `basis` sətri ekranda göründüyü üçün hər
          // həftə təkrarlanan «0 möhlətə salındı» oxucunu da yorurdu, modelə
          // də heç nə demirdi — olmayan hadisə fakt deyil.
          (flags.deferred > 0 ? `, ${flags.deferred} möhlətə salındı` : "") +
          (flags.dismissed > 0 ? `, ${flags.dismissed} gündəmdən çıxdı` : "") +
          `. Səbəblər: ${reasons || "yoxdur"}. ` +
          // Metodika cümləsi qısadır, amma çıxarıla bilməz: onsuz model
          // «gündəmdən çıxan»ı da həll sayır və «hamısını bağladı» yazır.
          `Median yalnız həll olunanlara aiddir.` +
          (flags.deferred > 0
            ? ` Möhlətə salınan bayraq müddət bitəndə geri qayıda bilər.`
            : ""),
      });
    }

    // 3. Hansı saatlarda aktivdirlər
    const peak = peakHour(snap.payload.hours);
    const close = closingHour(snap.payload.hours);
    const prevClose = prev ? closingHour(prev.payload.hours) : null;
    if (peak !== null) {
      out.push({
        kind: "hours",
        userId: snap.userId,
        userName: snap.userName,
        direction: close !== null && prevClose !== null && close !== prevClose
          ? (close > prevClose ? "better" : "worse")
          : prevClose === null ? "new" : "flat",
        evidence: {
          pikSaat: peak,
          sonAktivSaat: close,
          keçənHəftəSonAktivSaat: prevClose,
          saatlar: snap.payload.hours.map((h) => ({ saat: h.hour, cavab: h.outCount })),
        },
        facts:
          `${snap.userName}: ən çox cavab saat ${peak}:00-da yazılır, axın saat ${close}:00-a qədər ` +
          `davam edir (keçən həftə ${prevClose === null ? "bilinmir" : `${prevClose}:00`}).`,
      });
    }

    // 4. Hansı mövzularda necədirlər
    const topics = snap.payload.topics ?? {};
    const ranked = Object.entries(topics)
      .filter(([, v]) => v.messages >= 10)
      .sort((a, b) => b[1].messages - a[1].messages)
      .slice(0, 4);
    if (ranked.length >= 2) {
      const slowest = [...ranked]
        .filter(([, v]) => v.responseMedianSeconds !== null)
        .sort((a, b) => (b[1].responseMedianSeconds ?? 0) - (a[1].responseMedianSeconds ?? 0))[0];
      out.push({
        kind: "topic",
        userId: snap.userId,
        userName: snap.userName,
        // Mövzu qarışığı əvvəlki dövrlə müqayisə olunmur, ona görə istiqamət
        // YOXDUR. «dəyişməyib» yazmaq müqayisə edildiyini iddia edərdi.
        direction: null,
        evidence: {
          mövzular: Object.fromEntries(
            ranked.map(([k, v]) => [k, { mesaj: v.messages, cavabSaniyə: v.responseMedianSeconds }]),
          ),
        },
        facts:
          `${snap.userName} mövzu qarışığı: ` +
          ranked
            .map(([k, v]) =>
              `${TOPIC_NAMES[k] ?? k} ${v.messages} mesaj (cavab ${durText(v.responseMedianSeconds)})`)
            .join(", ") +
          (slowest ? `. Ən yavaş cavab verdiyi mövzu: ${TOPIC_NAMES[slowest[0]] ?? slowest[0]}.` : ""),
      });
    }

    // 5. Həftə sonu daha gecmi
    const wk = snap.payload.byDayType;
    const weekUnans = unansweredPct(wk.week);
    const satUnans = unansweredPct(wk.sat);
    const sunUnans = unansweredPct(wk.sun);
    const prevSat = prev ? unansweredPct(prev.payload.byDayType.sat) : null;
    out.push({
      kind: "weekend",
      userId: snap.userId,
      userName: snap.userName,
      direction: directionOf(satUnans, prevSat, "pct"),
      evidence: {
        işGünüCavabsızFaiz: weekUnans,
        şənbəCavabsızFaiz: satUnans,
        bazarCavabsızFaiz: sunUnans,
        keçənHəftəŞənbəCavabsızFaiz: prevSat,
        işGünüCavabSaniyə: wk.week.responseMedianSeconds,
        şənbəCavabSaniyə: wk.sat.responseMedianSeconds,
        bazarCavabSaniyə: wk.sun.responseMedianSeconds,
      },
      facts:
        `${snap.userName}: iş günü cavabsız ${pctText(weekUnans)} / cavab ${durText(wk.week.responseMedianSeconds)}, ` +
        `şənbə ${pctText(satUnans)} / ${durText(wk.sat.responseMedianSeconds)}, ` +
        `bazar ${pctText(sunUnans)} / ${durText(wk.sun.responseMedianSeconds)}. ` +
        `Keçən həftə şənbə cavabsız ${pctText(prevSat)}.`,
    });
  }

  return out;
}

const SelectionSchema = z.object({
  selected: z.array(
    z.object({
      index: z.number().describe("Namizədin nömrəsi, verildiyi kimi"),
      headline: z.string().describe("Bir sətirlik başlıq, 60 simvoldan qısa"),
      body: z.string().describe("İki-üç cümlə: nə görünür və niyə əhəmiyyətlidir"),
    }),
  ),
});

const SYSTEM = `Sən satış komandasına baxan analitiksən. Sənə HAZIR RƏQƏMLƏR verilir.

QAYDALAR:
1. Heç bir rəqəm uydurma və heç bir rəqəmi yenidən hesablama. Yalnız verilən
   rəqəmləri işlət, verildiyi kimi.
2. Ən çox ${MAX_INSIGHTS} namizəd seç. Az seçmək olar; hamısını seçmək məcburi deyil.
3. Səs-küyü seçmə: komanda medianından demək olar fərqlənməyən sətir fakt deyil.
4. Müqayisə et: «X-in şənbəsi digərlərindən pisdir», «keçən həftə 19% idi, indi 11%».
5. Adam haqqında hökm vermə, ölçünü de. «Pis işləyir» yox, «şənbə cavabsızlığı
   komandanın iki misli».
6. Azərbaycan dilində yaz, sadə və qısa. Başlıq bir sətir, mətn iki-üç cümlə.
7. Başlığa satıcının adını YAZMA — ad onsuz da başlığın yanında nişan kimi
   görünür və iki dəfə təkrarlanır.`;

export async function generateInsights(
  candidates: Candidate[],
): Promise<{ chosen: { candidate: Candidate; headline: string; body: string }[]; inputTokens: number; outputTokens: number }> {
  if (candidates.length === 0) return { chosen: [], inputTokens: 0, outputTokens: 0 };

  const client = new Anthropic();
  const listing = candidates.map((c, i) => `${i}. [${c.kind}] ${c.facts}`).join("\n");
  const res = await client.messages.parse({
    model: INSIGHT_MODEL,
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(SelectionSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: listing }],
  });

  const parsed = res.parsed_output;
  const chosen: { candidate: Candidate; headline: string; body: string }[] = [];
  for (const s of parsed?.selected.slice(0, MAX_INSIGHTS) ?? []) {
    const candidate = candidates[s.index];
    if (!candidate) continue; // uydurma nömrə fakt yaratmır
    chosen.push({ candidate, headline: s.headline, body: s.body });
  }
  return {
    chosen,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
  };
}

export async function storeInsights(
  periodStart: string,
  periodEnd: string,
  chosen: { candidate: Candidate; headline: string; body: string }[],
): Promise<number> {
  // Dövr yenidən yazılırsa köhnə faktlar qalmamalıdır: seçim dəyişəndə
  // seçilməyən fakt ekranda ilişib qalardı.
  await pool.query(`DELETE FROM katibe.sales_insight WHERE period_start = $1`, [periodStart]);
  for (const c of chosen) {
    await pool.query(
      `INSERT INTO katibe.sales_insight
         (period_start, period_end, user_id, kind, headline, body, evidence, basis, direction, model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        periodStart, periodEnd, c.candidate.userId, c.candidate.kind,
        c.headline, c.body, JSON.stringify(c.candidate.evidence), c.candidate.facts,
        c.candidate.direction, INSIGHT_MODEL,
      ],
    );
  }
  return chosen.length;
}

/** Ən son dövrün faktları. İcazə funksiyanın içindədir (sales-stats.ts qəlibi). */
export async function readInsights(lang: "az" | "ru" | "en" = "az"): Promise<{
  periodStart: string | null;
  periodEnd: string | null;
  items: Insight[];
}> {
  await requireAdmin();
  const { rows } = await pool.query(
    `SELECT i.id, i.period_start, i.period_end, i.user_id, u.name, i.kind,
            COALESCE(tr.headline, i.headline) AS headline,
            COALESCE(tr.body, i.body) AS body,
            COALESCE(NULLIF(tr.basis, ''), i.basis) AS basis,
            i.evidence, i.direction
       FROM katibe.sales_insight i
       LEFT JOIN katibe.users u ON u.id = i.user_id
       LEFT JOIN katibe.sales_insight_translation tr
              ON tr.insight_id = i.id AND tr.lang = $1
      WHERE i.period_start = (SELECT max(period_start) FROM katibe.sales_insight)
      ORDER BY i.user_id NULLS FIRST, i.kind`,
    [lang],
  );
  if (rows.length === 0) return { periodStart: null, periodEnd: null, items: [] };
  return {
    periodStart: String(rows[0].period_start instanceof Date
      ? rows[0].period_start.toISOString().slice(0, 10) : rows[0].period_start),
    periodEnd: String(rows[0].period_end instanceof Date
      ? rows[0].period_end.toISOString().slice(0, 10) : rows[0].period_end),
    items: rows.map((r) => ({
      id: Number(r.id),
      periodStart: "",
      periodEnd: "",
      userId: r.user_id === null ? null : Number(r.user_id),
      userName: (r.name as string) ?? null,
      kind: r.kind as InsightKind,
      headline: r.headline as string,
      body: r.body as string,
      evidence: r.evidence as Record<string, unknown>,
      basis: (r.basis as string) ?? "",
      direction: r.direction as Direction | null,
    })),
  };
}

/**
 * Tərcümə — yalnız çatmayanlar üçün, nəticə keşlənir.
 *
 * Uğursuzluq mətni orijinalda saxlayır, səhifəni uçurmur (chat-ai.ts
 * presedenti): tərcümə rahatlıqdır, məzmun isə faktın özüdür.
 */
export async function ensureTranslations(lang: "ru" | "en"): Promise<number> {
  await requireAdmin();
  const { rows } = await pool.query<{ id: string; headline: string; body: string; basis: string }>(
    `SELECT i.id, i.headline, i.body, i.basis
       FROM katibe.sales_insight i
      WHERE i.period_start = (SELECT max(period_start) FROM katibe.sales_insight)
        AND NOT EXISTS (SELECT 1 FROM katibe.sales_insight_translation tr
                         WHERE tr.insight_id = i.id AND tr.lang = $1)`,
    [lang],
  );
  if (rows.length === 0) return 0;

  const target = lang === "ru" ? "Русский" : "English";
  const client = new Anthropic();
  const Schema = z.object({
    items: z.array(z.object({
      id: z.number(), headline: z.string(), body: z.string(), basis: z.string(),
    })),
  });
  try {
    const res = await client.messages.parse({
      model: TRANSLATE_MODEL,
      max_tokens: 8000,
      output_config: { format: zodOutputFormat(Schema) },
      system:
        `Sən tərcüməçisən. Verilən mətnləri ${target} dilinə tərcümə et. ` +
        `Rəqəmlər, faizlər, adlar və saatlar olduğu kimi qalsın. Heç nə əlavə etmə.`,
      messages: [
        {
          role: "user",
          // Dil göstərişi məzmunun YANINDA da təkrarlanır: uzun JSON verəndə
          // model sistem promptunu unudub mətni olduğu kimi qaytara bilir
          // (summary_translation-da məhz belə olmuşdu).
          content:
            `Aşağıdakı sətirlərin headline, body və basis sahələrini ${target} dilinə ` +
            `tərcümə et. id-ni və bütün rəqəmləri dəyişmə.\n\n` +
            JSON.stringify(rows.map((r) => ({
              id: Number(r.id), headline: r.headline, body: r.body, basis: r.basis,
            }))),
        },
      ],
    });
    let n = 0;
    for (const item of res.parsed_output?.items ?? []) {
      await pool.query(
        `INSERT INTO katibe.sales_insight_translation
           (insight_id, lang, headline, body, basis, model)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (insight_id, lang) DO UPDATE
           SET headline = EXCLUDED.headline, body = EXCLUDED.body,
               basis = EXCLUDED.basis, model = EXCLUDED.model`,
        [item.id, lang, item.headline, item.body, item.basis, TRANSLATE_MODEL],
      );
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}

export { readSnapshots };
