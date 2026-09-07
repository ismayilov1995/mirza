import Link from "next/link";
import { archiveAnchorAt, searchMeaning } from "@/lib/search";
import type { ScopedInstanceId } from "@/lib/access";
import styles from "../../../dashboard.module.css";

export function MeaningSkeleton() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Mənaca yaxın</h2>
      </div>
      <div className={styles.summaryLoading}>
        <span className={styles.spinner} aria-hidden />
        <div>Söhbətlər oxunur və sualınıza görə sıralanır…</div>
      </div>
    </section>
  );
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString("az-AZ", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}

/**
 * The meaning half: stretches of conversation about what was asked, whether or
 * not they use the same words.
 *
 * Slow enough to stream — the query is embedded, fifty candidates are fetched
 * from the vector index, and a model grades each against the question. Only
 * grade 2 and 3 survive that; grade 1 means "same subject, answers nothing",
 * which is the failure this stage exists to remove and not worth showing.
 */
export default async function MeaningResults({
  instanceId, rawInstanceId, query, days,
}: {
  instanceId: ScopedInstanceId;
  rawInstanceId: string;
  query: string;
  days: number;
}) {
  const hits = await searchMeaning(instanceId, { query, hours: days * 24, limit: 6 });
  /* Hər parça üçün oxumağa BAŞLANACAQ mesaj. Altı sorğu, hamısı paralel və
     hər biri bir sətir oxuyur; nəticə ekranı onsuz da modelin cavabını
     gözləyib. */
  const anchors = await Promise.all(
    hits.map((h) => archiveAnchorAt(instanceId, h.jid, Math.floor(new Date(h.at).getTime() / 1000))),
  );

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Mənaca yaxın</h2>
        <span className={styles.subtitle}>{hits.length} söhbət parçası</span>
      </div>
      {hits.length === 0 ? (
        <div className={styles.empty}>
          Sualınıza cavab verən söhbət tapılmadı. Daha çox detal yazmaq kömək edir — məsələn
          &quot;kuryer qiyməti&quot; əvəzinə &quot;kuryer neçəyə başa gəlir, nağd ödəniş&quot;.
        </div>
      ) : (
        <div className={styles.summaryList}>
          {hits.map((h, i) => (
            <div key={`${h.jid}-${h.at}-${i}`} className={styles.qaItem}>
              <div className={styles.sfTitleRow}>
                {/* Parçanın hədəfi onun İLK mesajıdır — söhbətin sonu yox. */}
                <Link
                  className={styles.chatLink}
                  href={anchors[i]
                    ? `/arxiv?chat=${anchors[i]!.chatId}&msg=${anchors[i]!.messageId}`
                    : `/i/${rawInstanceId}/chat/${encodeURIComponent(h.jid)}`}
                >
                  {h.chatName}
                </Link>
                {h.grade >= 3 && <span className={styles.pill}>cavab burada</span>}
                <span className={styles.sfTime}>{when(h.at)}</span>
              </div>
              <div className={styles.qaEvidence}>
                {h.text.split("\n").map((line, n) => (
                  <div key={n} className={styles.sfEvidenceRow}>{line}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
