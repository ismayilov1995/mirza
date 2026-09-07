import Link from "next/link";
import { Panel } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import {
  slaBreachPct,
  unansweredPct,
  type SalesMetrics,
  type SalesRow,
  type SalesStats,
} from "@/lib/sales-stats";
import type { dict } from "./dictionary";
import styles from "./satis.module.css";

type Dict = ReturnType<typeof dict>;

/**
 * Satıcıların yan-yana müqayisəsi.
 *
 * FAİZ ƏSASDIR, MÜTLƏQ SAY İKİNCİ DƏRƏCƏLİDİR. Ən yüklü satıcının həcmi ən
 * yüngülünkündən iki dəfə çoxdur; «cavabsız 416» ilə «cavabsız 44» yan-yana
 * duranda cədvəl həcmi ölçər, davranışı yox. Xam say faizin altında qalır ki,
 * «3 gözləmədən 1-i» kimi kövrək faizlər də görünsün.
 *
 * SÜTUN ADLARI JARQON DEYİL. Əvvəl «İmkan / Median FRT / p90 ART / SLA-ya
 * düşmə» yazırdı və sahib düz dedi ki, heç biri özünü izah etmir. İndi ad
 * insan dilindədir, jarqon isə alt sətirdə mötərizədə qalır — nə vaxtsa
 * başqa hesabatla tutuşdurulacaq.
 *
 * SIRALAMA NÖMRƏSİ YOXDUR, qəsdən: sıralama insanı rəqəmə qulluq etməyə vadar
 * edir. Sıra ad üzrədir, müqayisə isə komanda medianından fərqlə verilir.
 */

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

function dur(seconds: number | null): string {
  return seconds === null ? "—" : formatDuration(seconds);
}

/**
 * Komanda medianından fərq.
 *
 * Rəng tək daşıyıcı deyil (docs/rules.md §3): işarə ▲/▼ və title mətni eyni
 * şeyi deyir, ona görə rəngi ayırd etməyən adam üçün də oxunur.
 */
function Delta({
  value, kind, label, t,
}: {
  /** Sətrin dəyəri ilə komanda medianının fərqi. Müsbət = daha pis. */
  value: number | null;
  kind: "points" | "duration";
  label: string;
  t: Dict;
}) {
  if (value === null) return null;
  const flat = kind === "points" ? Math.abs(value) < 0.1 : Math.abs(value) < 30;
  if (flat) {
    return (
      <div className={styles.delta} title={t.teamSameTitle(label)}>
        {t.teamSame}
      </div>
    );
  }
  const worse = value > 0;
  const size =
    kind === "points"
      ? t.points(Math.abs(value).toFixed(1))
      : formatDuration(Math.abs(value));
  return (
    <div
      className={styles.delta}
      data-tone={worse ? "worse" : "better"}
      title={t.teamDiffTitle(label, size, worse)}
    >
      {worse ? "▲" : "▼"} {size}
    </div>
  );
}

function diff(value: number | null, team: number | null): number | null {
  return value === null || team === null ? null : value - team;
}

function MetricCell({
  value, raw, delta,
}: {
  value: string;
  raw?: string;
  delta?: React.ReactNode;
}) {
  return (
    <td className={styles.num}>
      <div className={styles.value}>{value}</div>
      {raw && <div className={styles.raw}>{raw}</div>}
      {delta}
    </td>
  );
}

function Row({ row, team, t }: { row: SalesRow; team: SalesStats["team"]; t: Dict }) {
  if (row.instanceId === null) {
    return (
      <tr>
        <td>
          <div className={styles.name}>{row.userName}</div>
        </td>
        <td colSpan={7} className={styles.missing}>
          {t.noInstance} — <Link href="/admin">{t.noInstanceHelp}</Link>
        </td>
      </tr>
    );
  }

  const m: SalesMetrics = row.total;
  const unans = unansweredPct(m);
  const sla = slaBreachPct(m);

  return (
    <tr>
      <td>
        <div className={styles.name}>{row.userName}</div>
        <div className={styles.nameSub}>{row.instanceName}</div>
      </td>
      <MetricCell value={m.opportunities.toLocaleString("az-AZ")} raw={t.subOpportunities} />
      <MetricCell
        value={dur(m.frtMedianSeconds)}
        raw={t.subFrt}
        delta={
          <Delta value={diff(m.frtMedianSeconds, team.frtMedianSeconds)} kind="duration"
            label={t.colFrt} t={t} />
        }
      />
      <MetricCell
        value={dur(m.artMedianSeconds)}
        raw={t.subArt}
        delta={
          <Delta value={diff(m.artMedianSeconds, team.artMedianSeconds)} kind="duration"
            label={t.colArt} t={t} />
        }
      />
      <MetricCell value={dur(m.artP90Seconds)} raw={t.subP90} />
      <MetricCell
        value={pct(unans)}
        raw={`${m.unanswered} / ${m.opportunities}`}
        delta={<Delta value={diff(unans, team.unansweredPct)} kind="points"
          label={t.colUnanswered} t={t} />}
      />
      <MetricCell
        value={pct(sla)}
        raw={`${m.slaBreach} / ${m.slaMeasured}`}
        delta={<Delta value={diff(sla, team.slaBreachPct)} kind="points" label={t.colSla} t={t} />}
      />
      <td className={styles.num}>
        {m.slaUncovered > 0 ? (
          <span className={styles.chip} title={t.uncoveredTitle}>
            {m.slaUncovered.toLocaleString("az-AZ")}
          </span>
        ) : (
          <span className={styles.missing}>{t.none}</span>
        )}
      </td>
    </tr>
  );
}

export default function SalesTable({
  stats, days, t,
}: {
  stats: SalesStats;
  days: number;
  t: Dict;
}) {
  return (
    <Panel title={t.compare} hint={t.compareHint(days)} pad={false}>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t.colSales}</th>
              <th className={styles.num}>{t.colOpportunities}</th>
              <th className={styles.num}>{t.colFrt}</th>
              <th className={styles.num}>{t.colArt}</th>
              <th className={styles.num}>{t.colP90}</th>
              <th className={styles.num}>{t.colUnanswered}</th>
              <th className={styles.num}>{t.colSla}</th>
              <th className={styles.num}>{t.colUncovered}</th>
            </tr>
          </thead>
          <tbody>
            {stats.rows.map((row) => (
              <Row key={row.userId} row={row} team={stats.team} t={t} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Açılıb-yığılan izah: JS tələb etmir, çap olunanda da görünür. */}
      <details className={styles.glossary}>
        <summary>{t.glossary}</summary>
        <dl>
          {t.glossaryItems.map(([term, explanation]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{explanation}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Panel>
  );
}
