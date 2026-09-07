import Link from "next/link";
import { getRecentChats, RECENT_CHATS_LIMIT } from "@/lib/queries";
import { mediaLabel } from "@/lib/format";
import { CHAT_TYPE_LABELS } from "@/lib/jid";
import type { ScopedInstanceId } from "@/lib/access";
import styles from "../../dashboard.module.css";

/** Placeholder while the recency query runs. */
export function RecentChatsSkeleton() {
  return (
    <section className={styles.section}>
      <div className={styles.sectionTitle}>Son söhbətlər</div>
      <div className={styles.summaryLoading}>
        <span className={styles.spinner} aria-hidden />
        <div>Son söhbətlər yüklənir…</div>
      </div>
    </section>
  );
}

const timeFmt = new Intl.DateTimeFormat("az-AZ", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Baku",
});
const dateFmt = new Intl.DateTimeFormat("az-AZ", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Baku",
});
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Baku" });

/** Today shows the clock alone; anything older needs its date. */
function stamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  return dayKey.format(d) === dayKey.format(new Date()) ? timeFmt.format(d) : dateFmt.format(d);
}

/**
 * The list the panel opens on: the most recent conversations, newest first.
 *
 * It answers "what came in while I was away", which is the question the
 * statistics below cannot answer — they rank by volume, so a chat that has
 * been busy for months outranks the customer who wrote ten minutes ago.
 */
export default async function RecentChats({ instanceId }: { instanceId: ScopedInstanceId }) {
  const chats = await getRecentChats(instanceId, RECENT_CHATS_LIMIT);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionTitle}>Son {RECENT_CHATS_LIMIT} söhbət</div>
        <Link href={`/i/${instanceId}/labels`} className={styles.rangeLink}>
          Bütün söhbətlər →
        </Link>
      </div>
      {chats.length === 0 ? (
        <div className={styles.empty}>Bu nömrədə hələ yazışma yoxdur.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Söhbət</th>
              <th>Son mesaj</th>
              <th className={styles.numCell}>Vaxt</th>
            </tr>
          </thead>
          <tbody>
            {chats.map((c) => (
              <tr key={c.jid}>
                <td>
                  <Link
                    href={`/i/${instanceId}/chat/${encodeURIComponent(c.jid)}`}
                    className={styles.chatLink}
                    /* prefetch={false}: hovering a row of 30 links would render
                       30 chat pages, and each one aggregates the Message table. */
                    prefetch={false}
                  >
                    {c.chatType === "group" ? "👥 " : ""}
                    {c.contact}
                  </Link>
                  {c.awaiting && (
                    <span className={styles.awaitingBadge} style={{ marginLeft: 6 }}>
                      gözləyir
                    </span>
                  )}
                  <div className={styles.jid}>
                    {CHAT_TYPE_LABELS[c.chatType]}
                    {c.categoryName ? ` · ${c.categoryName}` : ""}
                  </div>
                </td>
                <td className={styles.previewCell}>
                  {c.lastFromMe && <span className={styles.jid}>↩ </span>}
                  {c.lastText ?? mediaLabel(c.lastType)}
                </td>
                <td className={styles.numCell}>{stamp(c.lastTs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
