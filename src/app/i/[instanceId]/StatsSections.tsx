import { getRangeStats } from "@/lib/queries";
import Link from "next/link";
import { formatDuration } from "@/lib/format";
import styles from "../../dashboard.module.css";
import type { ScopedInstanceId } from "@/lib/access";

const RANGES = [7, 14, 30];

/** Placeholder while the day-range queries run. */
export function StatsSkeleton() {
  return (
    <section className={styles.section}>
      <div className={styles.summaryLoading}>
        <span className={styles.spinner} aria-hidden />
        <div>Statistika hesablanır…</div>
      </div>
    </section>
  );
}

/**
 * Everything driven by the selected day range, in one Suspense boundary of
 * its own so changing a chat filter does not re-block on these queries (they
 * each scan the Message table and together dominate page time).
 *
 * The daily-volume chart, the hour-of-day chart and the rising/falling trend
 * table used to live here. They were dropped as noise, which also let the
 * underlying window shrink from 2x the range to 1x — nothing left needs the
 * previous period. The day-range switcher moved onto the first surviving
 * section, since it used to hang off the daily chart's header.
 */
export default async function StatsSections({
  instanceId,
  days,
  rangeExtra,
}: {
  instanceId: ScopedInstanceId;
  days: number;
  /** Extra query string carried through the range links, e.g. the chat filters. */
  rangeExtra: string;
}) {
  const { topContacts, responseTimes, categoryStats } = await getRangeStats(instanceId, days);

  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Ən aktiv yazışmalar (son {days} gün)</div>
          <RangeSwitcher instanceId={instanceId} days={days} extra={rangeExtra} />
        </div>
        {topContacts.length === 0 ? (
          <div className={styles.empty}>Bu aralıqda yazışma tapılmadı.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Kontakt</th>
                <th className={styles.numCell}>Alındı</th>
                <th className={styles.numCell}>Göndərildi</th>
                <th className={styles.numCell}>Toplam</th>
                <th className={styles.numCell}>Gündəlik orta</th>
              </tr>
            </thead>
            <tbody>
              {topContacts.map((c) => (
                <tr key={c.jid}>
                  <td>
                    <Link
                      href={`/i/${instanceId}/chat/${encodeURIComponent(c.jid)}`}
                      className={styles.chatLink}
                      title="AI xülasəsini gör"
                    >
                      {c.contact}
                    </Link>
                    <div className={styles.jid}>{c.jid}</div>
                  </td>
                  <td className={styles.numCell}>{c.received}</td>
                  <td className={styles.numCell}>{c.sent}</td>
                  <td className={styles.numCell}>{c.total}</td>
                  <td className={styles.numCell}>{c.avgPerDay}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Ən sürətli cavab verdiyin kontaktlar</div>
        </div>
        {responseTimes.length === 0 ? (
          <div className={styles.empty}>Kifayət qədər qarşılıqlı yazışma tapılmadı.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Kontakt</th>
                <th className={styles.numCell}>Orta cavab vaxtı</th>
                <th className={styles.numCell}>Say</th>
              </tr>
            </thead>
            <tbody>
              {responseTimes.map((r) => (
                <tr key={r.jid}>
                  <td>
                    <Link
                      href={`/i/${instanceId}/chat/${encodeURIComponent(r.jid)}`}
                      className={styles.chatLink}
                      prefetch={false}
                    >
                      {r.contact}
                    </Link>
                    <div className={styles.jid}>{r.jid}</div>
                  </td>
                  <td className={styles.numCell}>{formatDuration(r.avgReplySeconds)}</td>
                  <td className={styles.numCell}>{r.replyCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Kateqoriyaya görə davranış (son {days} gün)</div>
          <div className={styles.legend}>&quot;Bizi gözləyir&quot; = son mesaj qarşı tərəfdəndir</div>
        </div>
        {categoryStats.length === 0 ? (
          <div className={styles.empty}>Bu aralıqda mesaj tapılmadı.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Kateqoriya</th>
                <th className={styles.numCell}>Chat</th>
                <th className={styles.numCell}>Alındı</th>
                <th className={styles.numCell}>Göndərildi</th>
                <th className={styles.numCell}>Toplam</th>
                <th className={styles.numCell}>Pay</th>
                <th className={styles.numCell}>Orta cavab</th>
                <th className={styles.numCell}>Bizi gözləyir</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const grandTotal = categoryStats.reduce((sum, c) => sum + c.total, 0);
                return categoryStats.map((c) => {
                  const pct = grandTotal > 0 ? Math.round((c.total / grandTotal) * 1000) / 10 : 0;
                  return (
                    <tr key={c.categoryId ?? "none"}>
                      <td>
                        {c.categoryId === null ? (
                          <span className={styles.jid}>{c.categoryName}</span>
                        ) : (
                          c.categoryName
                        )}
                      </td>
                      <td className={styles.numCell}>{c.chatCount}</td>
                      <td className={styles.numCell}>{c.received.toLocaleString("az-AZ")}</td>
                      <td className={styles.numCell}>{c.sent.toLocaleString("az-AZ")}</td>
                      <td className={styles.numCell}>{c.total.toLocaleString("az-AZ")}</td>
                      <td className={styles.numCell}>{pct}%</td>
                      <td className={styles.numCell}>
                        {c.avgReplySeconds === null ? (
                          <span className={styles.jid}>—</span>
                        ) : (
                          formatDuration(c.avgReplySeconds)
                        )}
                      </td>
                      <td className={styles.numCell}>
                        {c.awaitingUs > 0 ? (
                          <span className={styles.awaitingBadge}>{c.awaitingUs}</span>
                        ) : (
                          <span className={styles.jid}>0</span>
                        )}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function RangeSwitcher({ instanceId, days, extra }: { instanceId: string; days: number; extra: string }) {
  return (
    <div className={styles.rangeGroup}>
      {RANGES.map((r) => (
        <Link
          key={r}
          href={`/i/${instanceId}?days=${r}${extra}`}
          className={`${styles.rangeLink} ${r === days ? styles.rangeLinkActive : ""}`}
        >
          {r} gün
        </Link>
      ))}
    </div>
  );
}
