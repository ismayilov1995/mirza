"use client";

import { useFormStatus } from "react-dom";
import styles from "../app/dashboard.module.css";

/**
 * Submit button for the analysis form. Analysis is a 10-30s API call, so the
 * pending state has to be visible — useFormStatus reports it without any
 * state wiring in the parent server component.
 */
export default function AnalyzeButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button className={styles.inlineButton} type="submit" disabled={pending}>
      {pending ? "Təhlil edilir…" : label}
    </button>
  );
}
