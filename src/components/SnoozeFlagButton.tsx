"use client";

import { useEffect, useState } from "react";
import { snoozeAgentPost } from "@/app/agent-actions";
import SubmitButton from "@/components/SubmitButton";
import { SNOOZE_DAY_OPTIONS } from "@/lib/supervisor/snooze-options";
import styles from "@/app/dashboard.module.css";

// «Möhlət ver» — lentdəki dördüncü düymə və yeganə olan ki, öz-özünə qayıdır.
//
// Digər üçü menecerin real cavabını tuta bilmirdi:
//   «Həll edildi»        bayrağı bağlayır, problem davam edirsə bir saat sonra
//                        geri gətirir — halbuki cavab «çatdırılmanı
//                        gözləyirik» idi və o saat ərzində ediləsi iş yoxdur;
//   «Lazımsız» (1 bal)   30 gün susdurur, amma modelə «bu bayraq səhv idi»
//                        nümunəsi kimi düşür — bayraq isə düz idi;
//   «Bir daha göstərmə»  həmişəlik, və heç kim bitişindən xəbər vermir.
//
// Möhlət tarixə söz verməkdir: müddət bitəndə problem qalıbsa bayraq «N gün
// möhlət verilmişdi — problem davam edir» nişanı və +1 balla geri çıxır, həll
// olubsa heç nə görünmür.
//
// TƏSDİQ PƏNCƏRƏSİ YOX, SEÇİM PƏNCƏRƏSİ. MuteFlagButton-da modal nəticəni
// oxutmaq üçündür (o düymənin geri yolu yalnız /admin/suppressions-dədir);
// burada isə modal sualı soruşur — neçə gün. Ona görə mətn qısa, fokus isə
// müddət düymələrindədir.

const DAY_LABELS: Record<number, { label: string; hint: string }> = {
  1: { label: "1 gün", hint: "sabah səhər" },
  2: { label: "2 gün", hint: "həftəsonu keçsin" },
  3: { label: "3 gün", hint: "bu həftə" },
  7: { label: "7 gün", hint: "gələn həftə" },
};

/** Möhlətin bitəcəyi gün — düymənin altındakı «nə vaxt» cavabı. */
function endsOn(days: number): string {
  const now = new Date();
  // Bakı təqvimində bu günün tarixi, üstünə N gün. Server 09:00-ı özü
  // hesablayır (ratings.ts); burada yalnız hansı GÜN olduğu göstərilir, çünki
  // menecerin sualı «hansı gün geri görəcəyəm» sualıdır.
  const baku = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Baku" }));
  baku.setDate(baku.getDate() + days);
  return new Intl.DateTimeFormat("az-AZ", { day: "numeric", month: "long" }).format(baku);
}

export default function SnoozeFlagButton({
  postId,
  contact,
  detectorLabel,
}: {
  postId: number;
  /** Söhbətin adı — modal mətnində "hansı söhbət" sualına cavab. */
  contact: string;
  /** Bayrağın lentdəki adı ("cavabsız", "susqunluq" …). */
  detectorLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(3);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={styles.sfSnooze}>
        Möhlət ver
      </button>

      {open ? (
        <div className={styles.qvOverlay} onClick={() => setOpen(false)}>
          <div
            className={styles.qvModal}
            style={{ maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`snooze-title-${postId}`}
          >
            <div className={styles.qvHeader}>
              <div style={{ minWidth: 0 }}>
                <div className={styles.qvTitle} id={`snooze-title-${postId}`}>
                  Neçə gün möhlət?
                </div>
                <div className={styles.qvMeta}>
                  {contact} · «{detectorLabel}» bayrağı
                </div>
              </div>
              <button
                type="button"
                className={styles.qvClose}
                onClick={() => setOpen(false)}
                aria-label="Bağla"
              >
                ✕
              </button>
            </div>

            {/* Modal bağlananda forma sökülür — yarımçıq seçim saxlanmır. */}
            <form action={snoozeAgentPost}>
              <input type="hidden" name="postId" value={postId} />
              <input type="hidden" name="days" value={days} />

              <div className={styles.qvBody}>
                {/* Müddət seçicisi. Radio-dur, düymə yığını deyil: klaviatura
                    ilə ox düymələri işləsin və ekran oxuyucu «4 variantdan
                    biri» desin. Görünüşü CSS verir. */}
                <div className={styles.snoozePicker} role="radiogroup" aria-label="Möhlət müddəti">
                  {SNOOZE_DAY_OPTIONS.map((d) => (
                    <label
                      key={d}
                      className={styles.snoozeOption}
                      data-active={d === days ? "true" : undefined}
                    >
                      <input
                        type="radio"
                        name="daysPick"
                        value={d}
                        checked={d === days}
                        onChange={() => setDays(d)}
                        className={styles.snoozeRadio}
                      />
                      <span className={styles.snoozeDay}>{DAY_LABELS[d]?.label ?? `${d} gün`}</span>
                      <span className={styles.snoozeHint}>{DAY_LABELS[d]?.hint ?? ""}</span>
                    </label>
                  ))}
                </div>

                <ul className={styles.muteList}>
                  <li>
                    Bayraq <b>{endsOn(days)}</b> səhər saat 09:00-a qədər lentdə görünməyəcək.
                  </li>
                  <li>
                    Həmin gün <b>nəticə gəlir</b>: problem davam edirsə bayraq «{days} gün möhlət
                    verilmişdi» nişanı və bir bal artıqla geri qayıdır. Həll olubsa heç nə
                    görünməyəcək.
                  </li>
                  <li>
                    Vəziyyət möhlət müddətində <b>ciddiləşsə</b> (bal 2 vahid qalxsa) bayraq
                    müddəti gözləmədən çıxır.
                  </li>
                  <li>
                    Eyni söhbətdə <b>başqa növ</b> bayraq yenə görünə bilər; söhbətin özünə
                    toxunulmur.
                  </li>
                </ul>

                <label className={styles.muteLabel} htmlFor={`snooze-note-${postId}`}>
                  Nəyi gözləyirik? (istəyə görə)
                </label>
                <input
                  id={`snooze-note-${postId}`}
                  type="text"
                  name="note"
                  maxLength={1000}
                  placeholder="məs. çatdırılma cümə axşamı, müştəri təsdiq gözləyir"
                  className={styles.sfRatingNote}
                />
              </div>

              <div className={styles.qvFooter} style={{ justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className={styles.sfResolveQuiet} onClick={() => setOpen(false)}>
                  İmtina
                </button>
                <SubmitButton
                  variant="accent"
                  label={`${days} gün möhlət ver`}
                  pendingLabel="Yazılır…"
                />
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
