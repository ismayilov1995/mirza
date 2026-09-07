"use client";

import Link from "next/link";
import { useLinkStatus } from "next/link";
import styles from "../app/dashboard.module.css";

/**
 * A filter/pager link that shows it is working.
 *
 * These navigations re-run dashboard queries server-side and take a moment,
 * so without feedback a click looks ignored. prefetch={false} because there
 * are a dozen of these and prefetching every filter combination would run
 * the queries for combinations nobody opens.
 */
function Pending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <span className={styles.linkSpinner} aria-hidden />;
}

export default function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={`${styles.rangeLink} ${active ? styles.rangeLinkActive : ""}`}
    >
      {children}
      <Pending />
    </Link>
  );
}
