import { Fragment } from "react";
import { Panel } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import { unansweredPct, type DayType, type SalesStats } from "@/lib/sales-stats";
import type { dict } from "./dictionary";
import styles from "./satis.module.css";

type Dict = ReturnType<typeof dict>;

/**
 * İş günləri / Şənbə / Bazar.
 *
 * NİYƏ ÜÇ SÜTUN, İKİ YOX. SLA qaydası şənbəni həftə sonu sayır, real yazışma
 * həcmi isə onu iş günü göstərir (şənbə adi günün ~60%-i, bazar ~45%-i).
 * İkisini «həftə sonu» adı altında birləşdirmək fərqi itirərdi, qaydanı
 * dəyişmək isə keçmiş ölçmələri yerindən oynadardı — ona görə ekran bölür,
 * qayda toxunulmaz qalır.
 *
 * Ekranın əsas mesajı buradan oxunur: cavab SÜRƏTİ həftə sonu hamıda pozulur
 * (qrafik), CAVABSIZLIQ isə yalnız bəzi adamlarda (davranış).
 */

function columns(t: Dict): { key: DayType; label: string; hint: string }[] {
  return [
    { key: "week", label: t.week, hint: t.weekHint },
    { key: "sat", label: t.sat, hint: t.slaWeekend },
    { key: "sun", label: t.sun, hint: t.slaWeekend },
  ];
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

export default function DayTypePanel({ stats, t }: { stats: SalesStats; t: Dict }) {
  const rows = stats.rows.filter((r) => r.instanceId !== null);
  const COLUMNS = columns(t);

  return (
    <Panel
      title={t.dayType}
      hint={t.dayTypeHint}
      pad={false}
    >
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th rowSpan={2}>{t.colSales}</th>
              {COLUMNS.map((c) => (
                <th key={c.key} colSpan={3} className={styles.groupHead}>
                  {c.label}
                  <div className={styles.nameSub}>{c.hint}</div>
                </th>
              ))}
            </tr>
            <tr>
              {COLUMNS.map((c) => (
                <Fragment key={c.key}>
                  <th className={`${styles.num} ${styles.groupStart}`}>{t.colOpportunities}</th>
                  <th className={styles.num}>{t.colMedianReply}</th>
                  <th className={styles.num}>{t.colUnanswered}</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.userId}>
                <td>
                  <div className={styles.name}>{row.userName}</div>
                </td>
                {COLUMNS.map((c) => {
                  const m = row.byDayType[c.key];
                  return (
                    <Fragment key={c.key}>
                      <td className={`${styles.num} ${styles.groupStart}`}>
                        <div className={styles.value}>
                          {m.opportunities.toLocaleString("az-AZ")}
                        </div>
                      </td>
                      <td className={styles.num}>
                        <div className={styles.value}>
                          {m.responseMedianSeconds === null
                            ? "—"
                            : formatDuration(m.responseMedianSeconds)}
                        </div>
                      </td>
                      <td className={styles.num}>
                        <div className={styles.value}>{pct(unansweredPct(m))}</div>
                        <div className={styles.raw}>
                          {m.unanswered} / {m.opportunities}
                        </div>
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>{t.dayTypeNote}</p>
    </Panel>
  );
}
