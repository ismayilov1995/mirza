import Link from "next/link";
import { archiveAnchors, searchExact } from "@/lib/search";
import type { ScopedInstanceId } from "@/lib/access";
import styles from "../../../dashboard.module.css";

/** Highlights every occurrence of the query inside a message. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (;;) {
    const found = lower.indexOf(needle, at);
    if (found === -1) break;
    if (found > at) parts.push(text.slice(at, found));
    parts.push(<mark key={found}>{text.slice(found, found + needle.length)}</mark>);
    at = found + needle.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("az-AZ", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * The literal half of search: messages containing the query as a substring.
 *
 * Milliseconds, so it renders with the page rather than streaming in. Its
 * results are individual messages, not conversation windows — when someone
 * types an order number this is the half that answers, and the message itself
 * is the answer.
 */
export default async function ExactResults({
  instanceId, rawInstanceId, query, days,
}: {
  instanceId: ScopedInstanceId;
  rawInstanceId: string;
  query: string;
  days: number;
}) {
  const hits = await searchExact(instanceId, { query, hours: days * 24, limit: 40 });
  /* Nəticədən MESAJA keçmək üçün id tərcüməsi (search.ts:archiveAnchors).
     Tapılmayan mesaj üçün link köhnə hədəfə — söhbətin öz səhifəsinə — gedir:
     tərcümə yoxdursa da nəticə klik oluna bilməlidir. */
  const anchors = await archiveAnchors(instanceId, hits.map((h) => h.id));

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Eynən keçir</h2>
        <span className={styles.subtitle}>{hits.length} mesaj</span>
      </div>
      {hits.length === 0 ? (
        <div className={styles.empty}>Bu sözlə birə-bir uyğunluq yoxdur.</div>
      ) : (
        <table className={styles.table}>
          <tbody>
            {hits.map((h, i) => {
              const a = anchors.get(h.id);
              return (
                <tr key={`${h.jid}-${h.at}-${i}`}>
                  <td className={styles.previewCell}>
                    {/* Bütün sıra bir linkdir: adam tapdığı MƏTNƏ basır, adın
                        üstünü nişan almağa məcbur deyil. */}
                    <Link
                      className={styles.hitLink}
                      href={a
                        ? `/arxiv?chat=${a.chatId}&msg=${a.messageId}`
                        : `/i/${rawInstanceId}/chat/${encodeURIComponent(h.jid)}`}
                    >
                      <span className={styles.hitName}>{h.chatName}</span>
                      <span className={styles.sfTime}>
                        {when(h.at)} · {h.fromMe ? "biz" : (h.sender ?? "onlar")}
                        {h.fromVoice && <span className={styles.voiceBadge}>səsli</span>}
                      </span>
                      <span className={styles.sfText}>
                        <Highlighted text={h.text} query={query} />
                      </span>
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
