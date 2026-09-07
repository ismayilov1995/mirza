import { Panel, EmptyState } from "@/components/ui";
import type { Insight } from "@/lib/sales-insight";
import type { dict } from "./dictionary";
import RefreshInsights from "./RefreshInsights";
import styles from "./satis.module.css";

type Dict = ReturnType<typeof dict>;

/**
 * Faktlar lenti — cədvəlin üstündə, çünki sual «rəqəm nədir» yox, «nə
 * görünür»dür.
 *
 * HƏR FAKTIN ALTINDA ÖZ RƏQƏMİ DURUR (`basis`). Bu, bəzək deyil: cümləni
 * model yazır, rəqəmi kod verir və ikisi yan-yana olmasa, modelin uydurduğu
 * rəqəmi heç kim tuta bilməz. Nəzarətçidə base_severity-nin severity ilə
 * yanaşı saxlanması ilə eyni səbəb.
 */

/**
 * Başlıqdan adın təkrarını atır.
 *
 * Ad onsuz da nişan kimi başlığın yanındadır; model yenə də «Zemfira: …»
 * yazanda ekranda «ZemfiraZemfira: …» görünürdü. Promptda da qadağa var, amma
 * artıq yazılmış faktlar üçün bu təmizləmə lazımdır — və prompt qaydası
 * pozulanda ekran yenə düz görünür.
 */
function stripName(headline: string, name: string | null): string {
  if (!name) return headline;
  const trimmed = headline.replace(new RegExp(`^${name}\\s*[:—-]\\s*`, "i"), "");
  return trimmed.length > 0 ? trimmed : headline;
}

const MARK: Record<string, string> = {
  better: "▼",
  worse: "▲",
  flat: "=",
  new: "•",
  none: "·",
};

export default function InsightPanel({
  data, t,
}: {
  data: { periodStart: string | null; periodEnd: string | null; items: Insight[] };
  t: Dict;
}) {
  if (data.items.length === 0) {
    return (
      <Panel title={t.insights} actions={<RefreshInsights label={t.refresh} />}>
        <EmptyState title={t.insightsEmpty}>{t.insightsEmptyBody}</EmptyState>
      </Panel>
    );
  }

  return (
    <Panel
      title={t.insights}
      hint={t.insightsHint(data.periodStart ?? "", data.periodEnd ?? "")}
      pad={false}
      actions={<RefreshInsights label={t.refresh} />}
    >
      <ul className={styles.insights}>
        {data.items.map((item) => {
          const word =
            item.direction === "better" ? t.better
              : item.direction === "worse" ? t.worse
                : item.direction === "new" ? t.fresh
                  : item.direction === "flat" ? t.flat
                    : null;
          return (
            <li key={item.id} className={styles.insight}>
              <div className={styles.insightMark} data-tone={item.direction ?? "flat"}>
                <span aria-hidden>{MARK[item.direction ?? "none"]}</span>
                {/* Rəng tək daşıyıcı deyil: istiqamət sözlə də yazılır. */}
                {word && <span className={styles.insightWord}>{word}</span>}
              </div>
              <div className={styles.insightBody}>
                <div className={styles.insightHead}>
                  {item.userName && <span className={styles.chip}>{item.userName}</span>}
                  {stripName(item.headline, item.userName)}
                </div>
                <p className={styles.insightText}>{item.body}</p>
                {item.basis && (
                  <p className={styles.insightBasis}>
                    <span className={styles.insightBasisLabel}>{t.basis}:</span> {item.basis}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
