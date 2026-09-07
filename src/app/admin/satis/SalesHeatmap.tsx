import { Panel, FilterChip } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import type { HeatCell, SalesRow } from "@/lib/sales-stats";
import type { dict } from "./dictionary";
import styles from "./satis.module.css";

type Dict = ReturnType<typeof dict>;

/**
 * Gün × saat istilik xəritəsi.
 *
 * İki rejim var və standart olan SÜRƏTdir, həcm deyil: «hansı saatda çox
 * yazılır» sualının cavabı onsuz da gözlənilən (iş saatı), «hansı saatdan sonra
 * qapı bağlanır» sualının cavabı isə deyil. Ölçmə göstərdi ki, gecə yarısı
 * gələn mesajın medianı 10 saata qalxır — bu, ekranın göstərməli olduğu şeydir.
 *
 * AZ SƏTİRLİ XANA RƏNGLƏNMİR. İki imkandan çıxan median rəngə çevriləndə
 * ekran əmin görünür, halbuki heç nə bilmir; ona görə 5-dən az imkanı olan xana
 * zolaqlı fonla «az data» kimi göstərilir.
 */

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const THIN = 5;

export type HeatMode = "speed" | "volume";

/** Sürət rejimində şkala: nə qədər yavaş, o qədər tünd. */
const SPEED_STEPS = [5 * 60, 15 * 60, 60 * 60, 3 * 60 * 60, 12 * 60 * 60];

function speedLevel(seconds: number): number {
  const idx = SPEED_STEPS.findIndex((s) => seconds <= s);
  return idx === -1 ? 100 : (idx + 1) * 16;
}

function volumeLevel(count: number, max: number): number {
  if (max <= 0) return 0;
  return Math.round((count / max) * 80) + 8;
}

function cellOf(cells: Map<string, HeatCell>, dow: number, hour: number): HeatCell {
  return (
    cells.get(`${dow}:${hour}`) ?? {
      isoDow: dow,
      hour,
      outCount: 0,
      opportunities: 0,
      responseMedianSeconds: null,
    }
  );
}

export default function SalesHeatmap({
  rows, mode, days, selectedUserId, hrefFor, t,
}: {
  rows: SalesRow[];
  mode: HeatMode;
  days: number;
  t: Dict;
  /** null = bütün satıcılar üst-üstə. */
  selectedUserId: number | null;
  /** Süzgəc linkləri — hər ikisi eyni anda saxlanır (docs/rules.md §8). */
  hrefFor: (patch: { u?: number | null; m?: HeatMode }) => string;
}) {
  const DAYS = t.days;
  const shown = selectedUserId === null
    ? rows.filter((r) => r.instanceId !== null)
    : rows.filter((r) => r.userId === selectedUserId);

  // Seçilən satıcılar üst-üstə toplanır. Median toplana bilmədiyi üçün burada
  // imkanla ÇƏKİLMİŞ ORTA götürülür və adı da elə yazılır — «median» deyilsəydi,
  // rəqəm başqa yerdəki medianla müqayisə olunardı və uyğun gəlməzdi.
  const merged = new Map<string, HeatCell & { weighted: number }>();
  for (const row of shown) {
    for (const c of row.heat) {
      const key = `${c.isoDow}:${c.hour}`;
      const acc = merged.get(key) ?? {
        isoDow: c.isoDow, hour: c.hour, outCount: 0, opportunities: 0,
        responseMedianSeconds: null, weighted: 0,
      };
      acc.outCount += c.outCount;
      acc.opportunities += c.opportunities;
      if (c.responseMedianSeconds !== null) acc.weighted += c.responseMedianSeconds * c.opportunities;
      merged.set(key, acc);
    }
  }
  const cells = new Map<string, HeatCell>();
  for (const [key, acc] of merged) {
    cells.set(key, {
      isoDow: acc.isoDow,
      hour: acc.hour,
      outCount: acc.outCount,
      opportunities: acc.opportunities,
      responseMedianSeconds:
        acc.opportunities > 0 && acc.weighted > 0 ? Math.round(acc.weighted / acc.opportunities) : null,
    });
  }

  const maxOut = Math.max(1, ...[...cells.values()].map((c) => c.outCount));
  const single = shown.length === 1;

  return (
    <Panel
      title={t.hourly}
      hint={mode === "speed" ? t.hourlySpeed(days) : t.hourlyVolume(days)}
      pad={false}
      /* Şkalanın rəngi rejimə görə dəyişir və HƏM xanalar, həm də şkala
         nümunələri onu buradan miras alır — iki yerdə ayrı yazılsaydı, biri
         dəyişəndə digəri sükutla köhnə tonda qalardı. */
      style={{ "--heat-ink": mode === "speed" ? "var(--critical)" : "var(--brand)" } as React.CSSProperties}
      actions={
        <>
          <FilterChip href={hrefFor({ m: "speed" })} active={mode === "speed"}>
            {t.modeSpeed}
          </FilterChip>
          <FilterChip href={hrefFor({ m: "volume" })} active={mode === "volume"}>
            {t.modeVolume}
          </FilterChip>
        </>
      }
    >
      <div className={styles.legend}>
        <FilterChip href={hrefFor({ u: null })} active={selectedUserId === null}>
          {t.everyone}
        </FilterChip>
        {rows
          .filter((r) => r.instanceId !== null)
          .map((r) => (
            <FilterChip key={r.userId} href={hrefFor({ u: r.userId })} active={selectedUserId === r.userId}>
              {r.userName}
            </FilterChip>
          ))}
      </div>

      <div className={styles.tableScroll} style={{ padding: "var(--space-6) var(--space-8)" }}>
        <table className={styles.heat}>
          <thead>
            <tr>
              <th />
              {HOURS.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((label, i) => {
              const dow = i + 1;
              return (
                <tr key={dow}>
                  <th scope="row">{label}</th>
                  {HOURS.map((h) => {
                    const c = cellOf(cells, dow, h);
                    const thin = c.opportunities < THIN;
                    const value =
                      mode === "speed"
                        ? c.responseMedianSeconds === null
                          ? "—"
                          : shortDuration(c.responseMedianSeconds)
                        : c.outCount === 0
                          ? "—"
                          : String(c.outCount);
                    const level =
                      thin && mode === "speed"
                        ? 0
                        : mode === "speed"
                          ? c.responseMedianSeconds === null ? 0 : speedLevel(c.responseMedianSeconds)
                          : volumeLevel(c.outCount, maxOut);
                    const title =
                      `${label} ${String(h).padStart(2, "0")}:00 — ` +
                      (c.responseMedianSeconds === null
                        ? "—"
                        : formatDuration(c.responseMedianSeconds)) +
                      `, ${c.opportunities} · ${c.outCount}` +
                      (thin ? ` (${t.thinCell(THIN)})` : "");
                    return (
                      <td
                        key={h}
                        className={styles.cell}
                        data-thin={thin && mode === "speed" ? "true" : undefined}
                        style={{ "--level": level } as React.CSSProperties}
                        title={title}
                      >
                        {value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.legend}>
        <span>{t.scale}</span>
        {mode === "speed" ? (
          <>
            {SPEED_STEPS.map((s, i) => (
              <span key={s}>
                <span
                  className={styles.legendSwatch}
                  style={{ "--level": (i + 1) * 16 } as React.CSSProperties}
                />{" "}
                ≤ {formatDuration(s)}
              </span>
            ))}
            <span>
              <span className={styles.legendSwatch} style={{ "--level": 100 } as React.CSSProperties} />{" "}
              {t.slower}
            </span>
            <span>{t.thinCell(THIN)}</span>
          </>
        ) : (
          <span>{t.darkest(maxOut)}</span>
        )}
      </div>

      <p className={styles.note}>
        {t.hourlyNote}
        {!single && t.hourlyAvgNote}
      </p>
    </Panel>
  );
}

/** Xanaya sığan qısa forma: 8d, 2s, 14s. */
function shortDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}san`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}d`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}s`;
  return `${Math.round(hours / 24)}g`;
}
