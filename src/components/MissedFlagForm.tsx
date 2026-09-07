"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { reportMissedFlag } from "@/app/agent-actions";
import styles from "@/app/monitor/monitor.module.css";

const MIN_NOTE = 10;

/** The four the reading detector looks for, plus a way to say "none of these". */
const KINDS: { key: string; label: string }[] = [
  { key: "anger", label: "Narazılıq" },
  { key: "broken_promise", label: "Verilən söz pozulub" },
  { key: "leaving", label: "Getməkdən danışır" },
  { key: "price_dispute", label: "Qiymətə etiraz" },
  { key: "other", label: "Başqa" },
];

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button className={styles.missedSubmit} type="submit" disabled={disabled || pending}>
      {pending ? "Göndərilir…" : "Bildir"}
    </button>
  );
}

/**
 * "This should have been flagged."
 *
 * The other direction from closing, and no less important for measuring the
 * agent: a detector's misses are invisible to everyone except the person
 * reading the conversations, and nothing in the system records them today.
 *
 * The chat is identified by the same opaque token the rest of /monitor uses —
 * the raw JID is a phone number and never reaches the browser, so it cannot be
 * put in a form field either.
 */
export default function MissedFlagForm({
  instanceId,
  chatId,
}: {
  instanceId: string;
  chatId: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [kind, setKind] = useState("anger");
  const ok = note.trim().length >= MIN_NOTE;

  if (!open) {
    // Sakit qalır. Bu düymə nadir hallarda lazım olur, amma söhbətin
    // başlığında oturur — parlaq olsaydı, hər söhbətdə diqqət oğurlayardı.
    // Üstünə gələndə görünür, lazım olanda tapılır.
    return (
      <button
        className={styles.missedButton}
        onClick={() => setOpen(true)}
        title="Bu söhbət bayraqlanmalıydı"
      >
        🚩
      </button>
    );
  }

  return (
    <form action={reportMissedFlag} className={styles.missedForm}>
      <input type="hidden" name="instanceId" value={instanceId} />
      <input type="hidden" name="chatId" value={chatId} />
      <div className={styles.missedKinds}>
        {KINDS.map((k) => (
          <label key={k.key} className={kind === k.key ? styles.missedKindOn : styles.missedKind}>
            <input
              type="radio"
              name="kind"
              value={k.key}
              checked={kind === k.key}
              onChange={() => setKind(k.key)}
              style={{ marginRight: 6 }}
            />
            {k.label}
          </label>
        ))}
      </div>
      <textarea
        className={styles.missedInput}
        name="note"
        required
        minLength={MIN_NOTE}
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Nə üçün bu bayraq olmalıydı? — konkret yazın, bu qeyd detektorun ölçülməsində işlənir"
      />
      <div className={styles.missedActions}>
        <button className={styles.missedCancel} type="button" onClick={() => setOpen(false)}>
          İmtina
        </button>
        <Submit disabled={!ok} />
      </div>
    </form>
  );
}
