import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getInstanceInfo, getOverview, getWorkloadStats } from "@/lib/queries";
import { requireInstance } from "@/lib/access";
import { formatDuration } from "@/lib/format";
import StatsSections, { StatsSkeleton } from "./StatsSections";
import RecentChats, { RecentChatsSkeleton } from "./RecentChats";
import LiveUpdates from "@/components/LiveUpdates";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

const RANGES = [7, 14, 30];

/**
 * The dashboard shell. It runs only the queries needed to render a header and
 * the workload summary, then streams the range statistics in through their
 * own Suspense boundary.
 *
 * The naming table used to be the first section here. It moved to
 * /i/[instanceId]/labels: it is a data-entry task, not something you read,
 * and it pushed the statistics below the fold. What took its place is the
 * recency list, which IS something you read.
 */
export default async function InstanceDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ days?: string }>;
}) {
  const { instanceId: rawInstanceId } = await params;
  // İcazə yoxlaması BURADA — səhifə nə çəkirsə çəksin, ondan əvvəl.
  // Nəticə markalı tipdir, ona görə aşağıdakı sorğular yalnız bununla işləyir.
  const instanceId = await requireInstance(rawInstanceId);
  const sp = await searchParams;
  const days = RANGES.includes(Number(sp.days)) ? Number(sp.days) : 14;

  const [info, overview, workload] = await Promise.all([
    getInstanceInfo(instanceId),
    getOverview(instanceId),
    getWorkloadStats(instanceId, days),
  ]);
  if (!info) notFound();

  const onTimePct =
    workload.slaMeasuredCount > 0
      ? Math.round(((workload.slaMeasuredCount - workload.slaBreachCount) / workload.slaMeasuredCount) * 100)
      : null;

  return (
    <>
      <AppHeader section="Statistika" align="page" searchInstanceId={rawInstanceId} />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>{info.ownerUserName ?? info.name}</div>
          <div className={styles.subtitle}>
            <Link href="/">← Userlər</Link> · {info.name} · yalnız oxu, heç nə &quot;oxundu&quot; olaraq
            işarələnmir
          </div>
        </div>
        <div className={styles.headerActions}>
          <LiveUpdates instanceId={instanceId} />
          <Link href={`/i/${instanceId}/search`} className={styles.logoutButton}>
            🔎 Axtarış
          </Link>
          <Link href={`/i/${instanceId}/labels`} className={styles.logoutButton}>
            🏷️ Adlandırma
          </Link>
          <Link href={`/i/${instanceId}/base`} className={styles.logoutButton}>
            ⏱️ Chat Base
          </Link>
          <Link href="/admin" className={styles.logoutButton}>
            Admin
          </Link>
        </div>
      </header>

      <section className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Bu gün</div>
          <div className={styles.cardValue}>{overview.messagesToday}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Ümumi mesaj</div>
          <div className={styles.cardValue}>{overview.totalMessages.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Kontaktlar</div>
          <div className={styles.cardValue}>{overview.totalContacts.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Söhbətlər</div>
          <div className={styles.cardValue}>{overview.totalChats.toLocaleString("az-AZ")}</div>
        </div>
      </section>

      {/* First thing on the page, and deliberately above the statistics: the
          panel is opened to see what just came in, and the tables below rank
          by volume, which is a different question. */}
      <Suspense fallback={<RecentChatsSkeleton />}>
        <RecentChats instanceId={instanceId} />
      </Suspense>

      {/* Three questions in plain words, replacing the FRT / ART / p90 / SLA
          grid. The raw statistics are still computed by getWorkloadStats and
          shown per-chat on the Chat Base page; what belongs here is only the
          headline a manager can act on. */}
      <section className={styles.section}>
        <div className={styles.sectionTitle}>Müştərilər nə qədər gözləyir? (son {days} gün)</div>
        <div className={styles.cards}>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Adətən bu qədər sonra cavab veririk</div>
            <div className={styles.cardValue}>
              {workload.artMedianSeconds === null ? "—" : formatDuration(workload.artMedianSeconds)}
            </div>
            <div className={styles.subtitle}>Cavabların yarısı bundan tez gedir, yarısı gec</div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Cavabsız qalan müştəri mesajı</div>
            <div className={styles.cardValue}>{workload.unansweredCount.toLocaleString("az-AZ")}</div>
            <div className={styles.subtitle}>24 saat ərzində cavab almayıb</div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Vaxtında cavabladıq</div>
            <div className={styles.cardValue}>{onTimePct === null ? "—" : `${onTimePct}%`}</div>
            <div className={styles.subtitle}>
              {onTimePct === null ? (
                <>
                  Bu nömrənin sahibinə <Link href="/admin/sla">hədəf təyin olunmayıb</Link>
                </>
              ) : (
                `${workload.slaMeasuredCount.toLocaleString("az-AZ")} cavabdan hədəfə çatanların payı`
              )}
            </div>
          </div>
        </div>
        <p className={styles.subtitle} style={{ marginTop: 12 }}>
          Yalnız fərdi söhbətlər sayılır — qruplar daxil deyil. Hədəf müştəri mesajının gəldiyi ana
          görə seçilir (iş saatı / iş saatından kənar / qeyri-iş günü).
        </p>
      </section>

      <Suspense key={`stats:${days}`} fallback={<StatsSkeleton />}>
        <StatsSections instanceId={instanceId} days={days} rangeExtra="" />
      </Suspense>

      <div className={styles.footer}>Katibe · Evolution API üzərindən, yalnız oxu rejimində</div>
    </div>
    </>
  );
}
