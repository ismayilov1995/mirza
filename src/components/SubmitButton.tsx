"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import styles from "../app/dashboard.module.css";

const VARIANTS = {
  accent: "acceptButton",
  inline: "inlineButton",
  plain: "rowButton",
  quiet: "logoutButton",
  // Geri qaytarılması ayrıca səhifə tələb edən əməliyyatlar üçün (məs.
  // «Bir daha göstərmə») — rəng təsdiq pəncərəsindəki mətnin davamıdır.
  danger: "dangerButton",
} as const;

/**
 * Submit button that shows what is actually working.
 *
 * Every server action on the admin pages costs a round trip plus a full
 * re-render of the page it sits on. With no feedback at all that gap read as
 * "the click did nothing", and the second click it invited either duplicated
 * a create or was silently dropped into the submit already in flight.
 *
 * `useFormStatus().pending` is per-form, not per-button, which is the whole
 * story for the single-button forms here. Where one form holds many buttons —
 * the review queue puts hundreds in one — the button remembers its own click
 * instead. It cannot read the submitter out of `data`: React drops a
 * submitter's name/value from the FormData whenever that button carries its
 * own `formAction`, which is exactly the case that needs telling apart.
 */
export default function SubmitButton({
  action,
  shared = false,
  variant = "plain",
  label,
  pendingLabel,
}: {
  /** Server action for this button; omit to use the form's own action. */
  action?: (formData: FormData) => void | Promise<void>;
  /** Set when the button shares its form with other buttons. */
  shared?: boolean;
  variant?: keyof typeof VARIANTS;
  label: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  const [clicked, setClicked] = useState(false);
  // Cleared on the pending → idle edge, during render rather than from an
  // effect: the click only speaks for the submit it started, and a stale one
  // would make this button claim the next row's work too.
  const [wasPending, setWasPending] = useState(pending);
  if (wasPending !== pending) {
    setWasPending(pending);
    if (!pending) setClicked(false);
  }

  // Alone in its form, this button is the submit by definition — which also
  // covers the Enter key, where there is no click to remember.
  const mine = pending && (clicked || !shared);
  return (
    <button
      type="submit"
      formAction={action}
      className={styles[VARIANTS[variant]]}
      onClick={() => setClicked(true)}
      disabled={pending}
      aria-busy={mine ? "true" : undefined}
    >
      {mine ? (
        <>
          <span className={styles.btnSpinner} aria-hidden /> {pendingLabel}
        </>
      ) : (
        label
      )}
    </button>
  );
}
