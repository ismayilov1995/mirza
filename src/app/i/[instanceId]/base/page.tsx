import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getChatBase, getInstanceInfo, type ChatBaseSort } from "@/lib/queries";
import { formatDuration } from "@/lib/format";
import { CHAT_TYPE_LABELS } from "@/lib/jid";
import FilterLink from "@/components/FilterLink";
import styles from "../../../dashboard.module.css";
import { requireInstance } from "@/lib/access";
import type { ScopedInstanceId } from "@/lib/access";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

const RANGES = [7, 14, 30, 90];

const SORTS: { key: ChatBaseSort; label: string }[] = [
  { key: "slowest", label: "Ən gec cavab verdiyimiz" },
  { key: "waiting", label: "Ən çox gözləyən" },
  { key: "fastest", label: "Ən tez cavab verdiyimiz" },
  { key: "volume", label: "Ən çox mesaj" },
];

export default async function ChatBasePage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ days?: string; sort?: string }>;
}) {
  const { instanceId: rawInstanceId } = await params;
  const instanceId = await requireInstance(rawInstanceId);
  const sp = await searchParams;
  const days = RANGES.includes(Number(sp.days)) ? Number(sp.days) : 30;
  const sort: ChatBaseSort = SORTS.some((s) => s.key === sp.sort)
    ? (sp.sort as ChatBaseSort)
    : "slowest";

  const info = await getInstanceInfo(instanceId);
  if (!info) notFound();

  return (
    <>
      <AppHeader section="Statistika" align="page" searchInstanceId={rawInstanceId} />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Chat Base</div>
          <div className={styles.subtitle}>
            <Link href={`/i/${instanceId}`}>← {info.ownerUserName ?? info.name}</Link> · cavab vaxtları,
            son {days} gün
          </div>
        </div>
      </header>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Hər chat üzrə cavab davranışı</div>
          <div className={styles.filterStack}>
            <div className={styles.rangeGroup}>
              {SORTS.map((s) => (
                <FilterLink
                  key={s.key}
                  href={`/i/${instanceId}/base?days=${days}&sort=${s.key}`}
                  active={s.key === sort}
                >
                  {s.label}
                </FilterLink>
              ))}
            </div>
            <div className={styles.rangeGroup}>
              {RANGES.map((r) => (
                <FilterLink
                  key={r}
                  href={`/i/${instanceId}/base?days=${r}&sort=${sort}`}
                  active={r === days}
                >
                  {r} gün
                </FilterLink>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.subtitle} style={{ marginBottom: 10 }}>
          <strong>Biz cavab veririk</strong> — qarşı tərəf bizi nə qədər gözləyir.{" "}
          <strong>Onlar cavab verir</strong> — biz onları nə qədər gözləyirik.{" "}
          <strong>İndi gözləyir</strong> — son mesaj onlardandır və hələ cavablanmayıb. 12 saatdan uzun
          fasilələr yeni söhbət sayılır, ona görə gecə fasilələri ortalamanı pozmur.
        </div>

        <Suspense key={`base:${days}:${sort}`} fallback={<BaseSkeleton />}>
          <BaseTable instanceId={instanceId} days={days} sort={sort} />
        </Suspense>
      </section>

      <div className={styles.footer}>Katibe · Evolution API üzərindən, yalnız oxu rejimində</div>
    </div>
    </>
  );
}

function BaseSkeleton() {
  return (
    <div className={styles.summaryLoading}>
      <span className={styles.spinner} aria-hidden />
      <div>Cavab vaxtları hesablanır…</div>
    </div>
  );
}

async function BaseTable({
  instanceId,
  days,
  sort,
}: {
  instanceId: ScopedInstanceId;
  days: number;
  sort: ChatBaseSort;
}) {
  const rows = await getChatBase(instanceId, days, sort);
  if (rows.length === 0) {
    return <div className={styles.empty}>Bu aralıqda yazışma tapılmadı.</div>;
  }

  // A single overall figure, weighted by how many replies each chat
  // contributed, so a chat with 200 replies counts more than one with 3.
  const weighted = (pick: (r: (typeof rows)[number]) => [number | null, number]) => {
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const [value, count] = pick(r);
      if (value === null || count === 0) continue;
      sum += value * count;
      n += count;
    }
    return n === 0 ? null : Math.round(sum / n);
  };
  const ourAvg = weighted((r) => [r.ourReplySeconds, r.ourReplyCount]);
  const theirAvg = weighted((r) => [r.theirReplySeconds, r.theirReplyCount]);
  const waitingNow = rows.filter((r) => r.waitingSeconds !== null).length;

  return (
    <>
      <section className={styles.cards} style={{ marginBottom: 18 }}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Biz orta cavab veririk</div>
          <div className={styles.cardValue} style={{ fontSize: 20 }}>
            {ourAvg === null ? "—" : formatDuration(ourAvg)}
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Onlar orta cavab verir</div>
          <div className={styles.cardValue} style={{ fontSize: 20 }}>
            {theirAvg === null ? "—" : formatDuration(theirAvg)}
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>İndi cavab gözləyir</div>
          <div className={styles.cardValue} style={{ fontSize: 20 }}>
            {waitingNow}
          </div>
        </div>
      </section>

      <table className={styles.table}>
        <thead>
          <tr>
            <th>Chat</th>
            <th>Növ</th>
            <th className={styles.numCell}>Biz cavab veririk</th>
            <th className={styles.numCell}>Onlar cavab verir</th>
            <th className={styles.numCell}>İndi gözləyir</th>
            <th className={styles.numCell}>Mesaj</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.jid}>
              <td>
                <Link
                  href={`/i/${instanceId}/chat/${encodeURIComponent(r.jid)}`}
                  className={styles.chatLink}
                >
                  {r.contact}
                </Link>
                <div className={styles.jid}>
                  {r.categoryName ?? <span>kateqoriyasız</span>}
                </div>
              </td>
              <td>
                <span className={styles.jid}>{CHAT_TYPE_LABELS[r.chatType]}</span>
              </td>
              <td className={styles.numCell}>
                {r.ourReplySeconds === null ? (
                  <span className={styles.jid}>—</span>
                ) : (
                  <>
                    {formatDuration(r.ourReplySeconds)}
                    <div className={styles.jid}>{r.ourReplyCount} dəfə</div>
                  </>
                )}
              </td>
              <td className={styles.numCell}>
                {r.theirReplySeconds === null ? (
                  <span className={styles.jid}>—</span>
                ) : (
                  <>
                    {formatDuration(r.theirReplySeconds)}
                    <div className={styles.jid}>{r.theirReplyCount} dəfə</div>
                  </>
                )}
              </td>
              <td className={styles.numCell}>
                {r.waitingSeconds === null ? (
                  <span className={styles.jid}>—</span>
                ) : (
                  <span className={styles.awaitingBadge}>{formatDuration(r.waitingSeconds)}</span>
                )}
              </td>
              <td className={styles.numCell}>{r.messageCount.toLocaleString("az-AZ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
