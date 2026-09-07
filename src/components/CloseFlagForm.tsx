"use client";

import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { acknowledgeAgentPost } from "@/app/agent-actions";
import { Button } from "@/components/ui";
import s from "@/components/ui/ui.module.css";

/** The note is required in the markup as well as on the server. */
const MIN_NOTE = 10;

function Submit({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" size="sm" icon="check"
      disabled={disabled} loading={pending}>
      {pending ? "Bağlanır…" : label}
    </Button>
  );
}

/**
 * Closing a flag, with the reason. Used by everyone who may close one —
 * admins on /agent and the supervisor on /monitor/bayraqlar alike.
 *
 * Not an admin-only courtesy: the reason a note is required does not depend on
 * who is writing it. A close is the only action that takes a flag off the
 * manager's screen, and six weeks later "why is this closed" has the same
 * answer either way.
 *
 * The note is enforced in three places and that is deliberate: the field is
 * `required` so the browser asks, the button stays disabled until it is long
 * enough so the intent is visible before the click, and the server action
 * refuses a short one because neither of the first two survives a crafted
 * request. Only the last is security; the first two are courtesy.
 *
 * Sayğac ("daha 4 hərf" → "hazırdır") dizaynın tələbidir və qapalı düymənin
 * səbəbini görünən edir: sönük düymə özü niyə sönük olduğunu demir.
 *
 * `before` söhbətə keçid düyməsi üçündür — dizaynda hər iki düymə sahənin
 * sağında bir qrupda durur, çünki ikisi də eyni sualın cavabıdır: "bunu
 * bağlamazdan əvvəl nə edim?"
 *
 * İKİ ADDIM. Səbəb qutusu əvvəlcə görünmür: «Həll edildi» onu açır və düymə
 * «Bağla»ya çevrilir. Səbəb budur ki, lentdəki hər açıq bayraq öz altında
 * boş bir mətn sahəsi saxlayırdı — on bayraq on qutu, hamısı doldurulmamış,
 * və sıra öz məzmunundan çox formaya oxşayırdı. İndi qutu yalnız bağlamağa
 * hazırlaşan adamın qarşısında açılır və dərhal fokus alır.
 *
 * Birinci klik heç nə göndərmir (`type="button"`), yəni səhv klik bayrağı
 * bağlamır — ikinci düymə isə səbəb yazılana qədər sönükdür.
 */
export default function CloseFlagForm({
  postId,
  label = "Həll edildi",
  before,
}: {
  postId: number;
  label?: string;
  before?: ReactNode;
}) {
  const [closing, setClosing] = useState(false);
  const [note, setNote] = useState("");
  const left = Math.max(0, MIN_NOTE - note.trim().length);
  const ok = left === 0;

  return (
    <form action={acknowledgeAgentPost} className={s.closeGrid}>
      <input type="hidden" name="postId" value={postId} />
      {closing && (
        <label className={s.closeField}>
          <span className={s.closeHead}>
            <span className={s.closeLabel}>Bağlama səbəbi</span>
            <span className={s.closeCounter} data-ok={ok ? "true" : undefined}>
              {ok ? "hazırdır" : `daha ${left} hərf`}
            </span>
          </span>
          <textarea
            className={s.closeArea}
            name="note"
            required
            minLength={MIN_NOTE}
            rows={2}
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Məsələn: müştəriyə zəng edildi, çatdırılma tarixi razılaşdırıldı."
          />
        </label>
      )}
      <div className={s.closeButtons}>
        {before}
        {closing ? (
          <Submit disabled={!ok} label="Bağla" />
        ) : (
          <Button type="button" variant="primary" size="sm" icon="check"
            onClick={() => setClosing(true)}>
            {label}
          </Button>
        )}
      </div>
    </form>
  );
}
