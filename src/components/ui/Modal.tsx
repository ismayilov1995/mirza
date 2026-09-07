"use client";

import { useEffect, type ReactNode } from "react";
import Icon from "./Icon";
import s from "./ui.module.css";

/**
 * A dialog over the page.
 *
 * Escape closes it and the scrim closes it, because a dialog that can only be
 * dismissed by finding its × is a trap on a screen somebody is scanning
 * quickly. Clicks inside stop there — otherwise selecting text in the body
 * would close the thing under the cursor.
 */
export default function Modal({
  title, meta, onClose, footer, width = 560, children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: number;
  children?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={s.scrim} onClick={onClose}>
      <div className={s.dialog} role="dialog" aria-modal="true" style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}>
        <div className={s.dialogHead}>
          <div style={{ minWidth: 0 }}>
            <div className={s.dialogTitle}>{title}</div>
            {meta && <div className={s.dialogMeta}>{meta}</div>}
          </div>
          <button className={s.dialogClose} type="button" onClick={onClose} aria-label="Bağla">
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className={s.dialogBody}>{children}</div>
        {footer && (
          <div style={{
            flex: "none", padding: "var(--space-5) var(--space-8)",
            borderTop: "1px solid var(--line)", display: "flex",
            justifyContent: "flex-end", gap: "var(--space-3)",
          }}>{footer}</div>
        )}
      </div>
    </div>
  );
}
