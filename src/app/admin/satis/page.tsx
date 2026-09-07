import { Suspense } from "react";
import { AppShell, EmptyState, FilterChip, TopBar } from "@/components/ui";
import AppHeader from "@/components/AppHeader";
import { requireAdmin } from "@/lib/access";
import { getSalesStats, lastDays, normaliseDays, SALES_WINDOWS } from "@/lib/sales-stats";
import { dict, isSalesLang, SALES_LANGS, type SalesLang } from "./dictionary";
import SalesTable from "./SalesTable";
import DayTypePanel from "./DayTypePanel";
import SalesHeatmap, { type HeatMode } from "./SalesHeatmap";
import InsightPanel from "./InsightPanel";
import { ensureTranslations, readInsights } from "@/lib/sales-insight";

type Dict = ReturnType<typeof dict>;

export const dynamic = "force-dynamic";

/**
 * Satıcılar — cavab sürəti və cavabsızlıq müqayisəsi.
 *
 * ADMIN-ONLY, qəsdən: ekran satıcıları yan-yana qoyur və satıcının özü
 * həmkarının rəqəmini görməməlidir. İcazə iki yerdədir — burada requireAdmin(),
 * bir də getSalesStats()-in içində; ikincisi ona görə ki, sabah kimsə bu
 * sorğunu başqa səhifədən çağırsa, yoxlama onunla birlikdə gedir.
 *
 * Süzgəclər URL-də yaşayır (docs/rules.md §8): ?d= pəncərə, ?u= satıcı,
 * ?m= xəritə rejimi. Biri dəyişəndə digərləri itmir.
 *
 * Dizayn: docs/satici-statistikasi-dizayn.md
 */
export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ d?: string; u?: string; m?: string; lang?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const days = normaliseDays(sp.d);
  const rawUser = Number(sp.u);
  const userId = Number.isInteger(rawUser) && rawUser > 0 ? rawUser : null;
  const mode: HeatMode = sp.m === "volume" ? "volume" : "speed";
  const lang: SalesLang = isSalesLang(sp.lang) ? sp.lang : "az";
  const t = dict(lang);

  /* Hər link BÜTÜN süzgəcləri daşıyır — biri dəyişəndə digəri itməməlidir
     (docs/rules.md §8). Dil də süzgəcdir: rejim dəyişəndə rus dili qalmalıdır. */
  const href = (patch: {
    d?: number; u?: number | null; m?: HeatMode; lang?: SalesLang;
  }): string => {
    const next = new URLSearchParams();
    next.set("d", String(patch.d ?? days));
    const u = patch.u === undefined ? userId : patch.u;
    if (u !== null) next.set("u", String(u));
    next.set("m", patch.m ?? mode);
    next.set("lang", patch.lang ?? lang);
    return `/admin/satis?${next.toString()}`;
  };

  return (
    <AppShell
      top={<AppHeader section="Admin" />}
      header={
        <TopBar
          back={{ href: "/admin", label: t.section }}
          title={t.title}
          subtitle={t.subtitle(days)}
          actions={
            <>
              {SALES_WINDOWS.map((w) => (
                <FilterChip key={w} href={href({ d: w })} active={w === days}>
                  {t.window(w)}
                </FilterChip>
              ))}
              {(Object.keys(SALES_LANGS) as SalesLang[]).map((l) => (
                <FilterChip key={l} href={href({ lang: l })} active={l === lang} shape="md">
                  {SALES_LANGS[l]}
                </FilterChip>
              ))}
            </>
          }
        />
      }
    >
      <Suspense
        key={`${days}-${userId ?? "all"}-${mode}-${lang}`}
        fallback={<Loading days={days} t={t} />}
      >
        <Sections days={days} userId={userId} mode={mode} hrefFor={href} t={t} lang={lang} />
      </Suspense>
    </AppShell>
  );
}

function Loading({ days, t }: { days: number; t: Dict }) {
  return (
    <EmptyState title={t.loadingTitle} icon="hourglass">
      {t.loadingBody(days)}
    </EmptyState>
  );
}

async function Sections({
  days, userId, mode, hrefFor, t, lang,
}: {
  days: number;
  userId: number | null;
  mode: HeatMode;
  hrefFor: (patch: { d?: number; u?: number | null; m?: HeatMode }) => string;
  t: Dict;
  lang: SalesLang;
}) {
  const stats = await getSalesStats(lastDays(days));
  /* Tərcümə lazım olanda yaranır və keşlənir; uğursuzluqda orijinal mətn
     qalır, ona görə burada try/catch lazım deyil (ensureTranslations udur). */
  if (lang !== "az") await ensureTranslations(lang);
  const insights = await readInsights(lang);
  const measured = stats.rows.filter((r) => r.instanceId !== null && r.total.opportunities > 0);

  if (measured.length === 0) {
    return (
      <EmptyState
        tone="warning"
        title={t.emptyTitle}
        actions={
          <FilterChip href={hrefFor({ d: 90 })} shape="md">
            {t.emptyAction}
          </FilterChip>
        }
      >
        {t.emptyBody(days)}
      </EmptyState>
    );
  }

  return (
    <>
      <InsightPanel data={insights} t={t} />
      <SalesTable stats={stats} days={days} t={t} />
      <SalesHeatmap
        rows={stats.rows}
        mode={mode}
        days={days}
        selectedUserId={userId}
        hrefFor={hrefFor}
        t={t}
      />
      <DayTypePanel stats={stats} t={t} />
    </>
  );
}
