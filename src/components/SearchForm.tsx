"use client";

import { useFormStatus } from "react-dom";
import styles from "../app/dashboard.module.css";

/**
 * Submit button for the chat search. The search re-queries server-side, so
 * useFormStatus surfaces that the request is in flight.
 */
export default function SearchSubmit() {
  const { pending } = useFormStatus();
  return (
    <button className={styles.inlineButton} type="submit" disabled={pending}>
      {pending ? "Axtarılır…" : "Axtar"}
    </button>
  );
}
