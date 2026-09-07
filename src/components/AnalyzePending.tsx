"use client";

import { useFormStatus } from "react-dom";
import styles from "../app/dashboard.module.css";

/** Spinner shown inside the analysis form while the server action runs. */
export default function AnalyzePending() {
  const { pending } = useFormStatus();
  if (!pending) return null;
  return (
    <div className={styles.summaryLoading}>
      <span className={styles.spinner} aria-hidden />
      <div>
        <div>Söhbət AI ilə təhlil edilir…</div>
        <div className={styles.jid}>Bu, seçilmiş modeldən asılı olaraq 10–30 saniyə çəkə bilər.</div>
      </div>
    </div>
  );
}
