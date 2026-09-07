"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { reportMissedFlagForChat } from "@/app/agent-actions";
import { Button, FilterChip, Modal } from "@/components/ui";
import s from "./chat.module.css";

const MIN_NOTE = 10;

/** The four the reading detector looks for, plus a way to say "none of these". */
const KINDS = [
  { key: "anger", label: "Narazılıq" },
  { key: "broken_promise", label: "Verilən söz pozulub" },
  { key: "leaving", label: "Getməkdən danışır" },
  { key: "price_dispute", label: "Qiymətə etiraz" },
  { key: "other", label: "Başqa" },
];

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button variant="primary" size="sm" type="submit" loading={pending} disabled={disabled}>
      Bildir
    </Button>
  );
}

/**
 * "This should have been flagged."
 *
 * The other direction from closing a flag, and no less important for measuring
 * the detector: its misses are invisible to everyone except the person reading
 * the conversations, and nothing else in the system records them.
 *
 * A note of real length is required for the same reason it is required on a
 * close — "this was a complaint about the delivery date" is a labelled example
 * the next detector run can be measured against, and "yes" is not.
 */
export default function ReportFlag({ chatId }: { chatId: number }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("anger");
  const [note, setNote] = useState("");
  const short = note.trim().length < MIN_NOTE;

  if (!open) {
    return (
      <Button variant="quiet" size="sm" icon="triangle-alert" onClick={() => setOpen(true)}>
        Bayraq olmalıydı
      </Button>
    );
  }

  return (
    <Modal
      title="Bu söhbət bayraqlanmalıydı"
      meta="Qeyd növbəti dəfə detektoru ölçmək üçün saxlanılır"
      width={520}
      onClose={() => setOpen(false)}
    >
      <form action={reportMissedFlagForChat} onSubmit={() => setOpen(false)}
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-7)" }}>
        <input type="hidden" name="chatId" value={chatId} />
        <input type="hidden" name="kind" value={kind} />
        <div className={s.wrapRow}>
          {KINDS.map((k) => (
            <FilterChip key={k.key} active={kind === k.key} onClick={() => setKind(k.key)}>
              {k.label}
            </FilterChip>
          ))}
        </div>
        <textarea
          name="note"
          className={s.composerBox}
          style={{ minHeight: 96, opacity: 1 }}
          rows={4}
          required
          minLength={MIN_NOTE}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Nə üçün bu bayraq olmalıydı? Bir-iki cümlə kifayətdir."
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-4)" }}>
          <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>İmtina</Button>
          <Submit disabled={short} />
        </div>
      </form>
    </Modal>
  );
}
