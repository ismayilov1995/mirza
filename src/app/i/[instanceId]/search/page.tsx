import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireInstance } from "@/lib/access";
import { getInstanceInfo } from "@/lib/queries";
import SearchSubmit from "@/components/SearchForm";
import styles from "../../../dashboard.module.css";
import ExactResults from "./ExactResults";
import MeaningResults, { MeaningSkeleton } from "./MeaningResults";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/** Windows offered on the page. The last one is "everything we hold". */
const RANGES = [
  { days: 30, label: "30 gün" },
  { days: 90, label: "3 ay" },
  { days: 365, label: "1 il" },
  { days: 3650, label: "Hamısı" },
];

/**
 * Message search.
 *
 * The two halves answer different questions and are shown separately rather
 * than merged into one ranking. Exact matching is the only thing that can be
 * trusted for an order number or an amount; meaning-based search is the only
 * thing that finds the right conversation when the words differ. Blending them
 * into a single list would hide which of the two produced a result, and they
 * are not comparable enough to interleave honestly.
 *
 * They also differ by an order of magnitude in latency — ILIKE returns in
 * milliseconds, the semantic half embeds the query and then has a model grade
 * fifty candidates, about four seconds. So the second half streams in through
 * its own Suspense boundary instead of holding the first hostage.
 */
export default async function SearchPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ q?: string; days?: string }>;
}) {
  const { instanceId: rawInstanceId } = await params;
  // İcazə yoxlaması BURADA, hər hansı sorğudan əvvəl.
  const instanceId = await requireInstance(rawInstanceId);
  const sp = await searchParams;
  const query = (sp.q ?? "").trim();
  const days = RANGES.some((r) => r.days === Number(sp.days)) ? Number(sp.days) : 365;

  const info = await getInstanceInfo(instanceId);
  if (!info) notFound();

  const rangeUrl = (d: number) =>
    `/i/${rawInstanceId}/search?${new URLSearchParams({ q: query, days: String(d) })}`;

  return (
    <>
      <AppHeader section="Statistika" align="page" searchInstanceId={rawInstanceId} />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Axtarış</div>
          <div className={styles.subtitle}>
            <Link href={`/i/${rawInstanceId}`}>← {info.ownerUserName ?? info.name}</Link> · yalnız
            oxu, heç nə &quot;oxundu&quot; olaraq işarələnmir
          </div>
        </div>
      </header>

      <section className={styles.section}>
        <form className={styles.inlineForm} action={`/i/${rawInstanceId}/search`}>
          <input type="hidden" name="days" value={days} />
          <input
            className={styles.inlineInput}
            type="search"
            name="q"
            defaultValue={query}
            autoFocus
            placeholder="Nə axtarırsınız? Məs: gömrükdə problem, 1008882, kuryer qiyməti…"
          />
          <SearchSubmit />
        </form>
        <div className={styles.rangeGroup}>
          {RANGES.map((r) => (
            <Link
              key={r.days}
              href={rangeUrl(r.days)}
              className={r.days === days ? styles.rangeLinkActive : styles.rangeLink}
            >
              {r.label}
            </Link>
          ))}
        </div>
      </section>

      {query.length < 2 ? (
        <section className={styles.section}>
          <div className={styles.empty}>
            Ən azı iki hərf yazın. İki cür nəticə alacaqsınız: sözün <b>eynən keçdiyi</b> mesajlar
            (sifariş nömrəsi, məbləğ üçün) və <b>mənaca yaxın</b> söhbətlər — &quot;gömrükdə
            problem&quot; yazanda &quot;yükü saxlayıblar&quot; da tapılır.
          </div>
        </section>
      ) : (
        <>
          <ExactResults instanceId={instanceId} rawInstanceId={rawInstanceId} query={query} days={days} />
          <Suspense key={`${query}:${days}`} fallback={<MeaningSkeleton />}>
            <MeaningResults
              instanceId={instanceId}
              rawInstanceId={rawInstanceId}
              query={query}
              days={days}
            />
          </Suspense>
        </>
      )}
    </div>
    </>
  );
}
