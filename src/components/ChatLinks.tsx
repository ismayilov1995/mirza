import Link from "next/link";
import type { InstanceRef } from "@/lib/queries";
import styles from "@/app/dashboard.module.css";

/**
 * Opens a conversation from a cross-account list.
 *
 * One link per account rather than a single "open chat", because the chat
 * screen is per-account: the same JID seen by two of our numbers is two
 * different conversations, with different history and different analyses.
 * Collapsing them would silently pick one.
 *
 * prefetch={false} throughout — these lists run to hundreds of rows, and each
 * chat page aggregates the Message table on render.
 */
export default function ChatLinks({
  jid,
  instances,
}: {
  jid: string;
  instances: InstanceRef[];
}) {
  if (instances.length === 0) {
    return <span className={styles.jid}>—</span>;
  }
  return (
    <div className={styles.pillList}>
      {instances.map((i) => (
        <Link
          key={i.id}
          href={`/i/${i.id}/chat/${encodeURIComponent(jid)}`}
          className={styles.pillLink}
          prefetch={false}
          title={`${i.name} hesabında bu yazışmanı aç`}
        >
          💬 {i.name}
        </Link>
      ))}
    </div>
  );
}

/** The row's title as a link into the first account that has the chat. */
export function ChatTitleLink({
  jid,
  instances,
  children,
}: {
  jid: string;
  instances: InstanceRef[];
  children: React.ReactNode;
}) {
  if (instances.length === 0) return <>{children}</>;
  return (
    <Link
      href={`/i/${instances[0].id}/chat/${encodeURIComponent(jid)}`}
      className={styles.chatLink}
      prefetch={false}
    >
      {children}
    </Link>
  );
}
