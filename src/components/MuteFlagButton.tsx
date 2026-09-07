"use client";

import { useEffect, useState } from "react";
import { muteAgentPostForever } from "@/app/agent-actions";
import SubmitButton from "@/components/SubmitButton";
import styles from "@/app/dashboard.module.css";

// «Bir daha göstərmə» + təsdiq pəncərəsi.
//
// Təsdiq burada bəzək deyil. Lentdəki bütün digər düymələr geri alına bilir:
// "Həll edildi" problem davam edərsə bayrağı təzə post kimi geri gətirir,
// reytinq 30 gündən sonra öz-özünə bitir. Bu düymə isə söhbətin həmin növ
// bayrağını HƏMİŞƏLİK gizlədir və geri yolu yalnız /admin/suppressions-dədir —
// yəni səhv klik özü-özünü heç vaxt üzə çıxarmır. Ona görə nəticəsi basmazdan
// ƏVVƏL yazılır.
//
// Qeyd sahəsi məcburi deyil, amma boş buraxılanda auditdə yalnız bayrağın öz
// mətni qalır. Səbəb adətən WhatsApp-dan kənardadır ("telefonda danışdıq") —
// onu yazmayan adam bir ay sonra öz qərarını izah edə bilmir.

export default function MuteFlagButton({
  postId,
  contact,
  detectorLabel,
}: {
  postId: number;
  /** Söhbətin adı — təsdiq mətnində "hansı söhbət" sualına cavab. */
  contact: string;
  /** Bayrağın lentdəki adı ("cavabsız", "susqunluq" …). */
  detectorLabel: string;
}) {
  const [open, setOpen] = useState(false);

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
      <button type="button" onClick={() => setOpen(true)} className={styles.sfMute}>
        Bir daha göstərmə
      </button>

      {open ? (
        <div className={styles.qvOverlay} onClick={() => setOpen(false)}>
          <div
            className={styles.qvModal}
            style={{ maxWidth: 460 }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`mute-title-${postId}`}
          >
            <div className={styles.qvHeader}>
              <div style={{ minWidth: 0 }}>
                <div className={styles.qvTitle} id={`mute-title-${postId}`}>
                  Bu bayraq bir daha göstərilməsin?
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

            {/* Modal bağlananda forma da sökülür, ona görə yarımçıq qalmış qeyd
                saxlanmır — düymə iki kliklik iş deyil, hər dəfə yenidən oxunur. */}
            <form action={muteAgentPostForever}>
              <input type="hidden" name="postId" value={postId} />

              <div className={styles.qvBody}>
                <ul className={styles.muteList}>
                  <li>
                    Bu söhbətdə <b>«{detectorLabel}»</b> bayrağı bir daha lentə çıxmayacaq —
                    müddəti yoxdur, Nəzarətçi onu yenidən aça bilməyəcək.
                  </li>
                  <li>
                    Söhbətin özünə toxunulmur: mesajlar, statistika və təhlil olduğu kimi qalır.
                  </li>
                  <li>
                    Eyni söhbətdə <b>başqa növ</b> bayraq (məsələn «susqunluq») yenə görünə bilər.
                  </li>
                  <li>
                    Geri qaytarmaq yalnız <b>Admin → Susdurulmuş bayraqlar</b> səhifəsindən mümkündür.
                  </li>
                </ul>

                <label className={styles.muteLabel} htmlFor={`mute-note-${postId}`}>
                  Səbəb (istəyə görə, amma bir ay sonra yalnız bu qalır)
                </label>
                <input
                  id={`mute-note-${postId}`}
                  type="text"
                  name="note"
                  maxLength={1000}
                  placeholder="məs. telefonda danışdıq, sifariş bağlandı"
                  className={styles.sfRatingNote}
                  autoFocus
                />
              </div>

              <div className={styles.qvFooter} style={{ justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className={styles.sfResolveQuiet} onClick={() => setOpen(false)}>
                  İmtina
                </button>
                <SubmitButton
                  variant="danger"
                  label="Bəli, bir daha göstərmə"
                  pendingLabel="Susdurulur…"
                />
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
