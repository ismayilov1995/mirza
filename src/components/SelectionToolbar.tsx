"use client";

import { useCallback, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import styles from "@/app/dashboard.module.css";

/**
 * Bulk selection for a server-rendered checkbox list.
 *
 * The rows stay server-rendered inside their form — this only wraps them and
 * drives the checkboxes through the DOM, so nothing about the list has to
 * become client state. Selection is read back at submit time by the form
 * itself, exactly as before.
 *
 * Shift-click extends from the last box clicked to this one and applies the
 * state you just set, which is the behaviour every file manager has trained
 * people to expect. Reviewing hundreds of rows one tick at a time was the
 * thing that made this page tiring.
 */
export default function SelectionToolbar({
  name,
  total,
  initialChecked,
  children,
}: {
  /** The checkbox field name to operate on. */
  name: string;
  /** Row count, from the server that rendered them. */
  total: number;
  /** How many arrive ticked. */
  initialChecked: number;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Anchor for the next shift-click. Reset whenever the set changes wholesale,
  // because a range from a stale anchor is never what anyone means.
  const anchor = useRef<number | null>(null);
  // Seeded from the server rather than counted out of the DOM on mount: the
  // page that rendered the rows already knows both numbers, and reading them
  // back in an effect would set state during the first commit for nothing.
  const [count, setCount] = useState({ checked: initialChecked, total });
  // The bar is the one part of this page that is always on screen, so it is
  // where a submit has to become visible: the buttons that started it may be
  // hundreds of rows above or below by the time the server answers.
  const { pending } = useFormStatus();

  const boxes = useCallback(
    () =>
      Array.from(
        ref.current?.querySelectorAll<HTMLInputElement>(
          `input[type="checkbox"][name="${name}"]`,
        ) ?? [],
      ),
    [name],
  );

  const sync = useCallback(() => {
    const all = boxes();
    setCount({ checked: all.filter((b) => b.checked).length, total: all.length });
  }, [boxes]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (
      !(target instanceof HTMLInputElement) ||
      target.type !== "checkbox" ||
      target.name !== name
    ) {
      return;
    }
    const all = boxes();
    const index = all.indexOf(target);
    if (e.shiftKey && anchor.current !== null && anchor.current !== index) {
      const from = Math.min(anchor.current, index);
      const to = Math.max(anchor.current, index);
      for (let i = from; i <= to; i++) all[i].checked = target.checked;
    }
    anchor.current = index;
    sync();
  };

  const setAll = (value: boolean) => {
    boxes().forEach((b) => {
      b.checked = value;
    });
    anchor.current = null;
    sync();
  };

  const invert = () => {
    boxes().forEach((b) => {
      b.checked = !b.checked;
    });
    anchor.current = null;
    sync();
  };

  return (
    <div ref={ref} onClick={onClick}>
      <div className={styles.selectBar} aria-busy={pending ? "true" : undefined}>
        <button
          type="button"
          className={styles.rowButton}
          onClick={() => setAll(true)}
          disabled={pending}
        >
          Hamısını seç
        </button>
        <button
          type="button"
          className={styles.rowButton}
          onClick={() => setAll(false)}
          disabled={pending}
        >
          Seçimi ləğv et
        </button>
        <button type="button" className={styles.rowButton} onClick={invert} disabled={pending}>
          Əksinə çevir
        </button>
        <span className={styles.selectCount}>
          <strong>{count.checked}</strong> / {count.total} seçilib
        </span>
        {pending ? (
          <span className={styles.selectBusy}>
            <span className={styles.btnSpinner} aria-hidden /> Yadda saxlanılır — siyahı bitəndə
            yenilənəcək
          </span>
        ) : (
          <span className={styles.jid}>Shift + klik — iki klik arasındakı bütün sətirlər</span>
        )}
      </div>
      {children}
    </div>
  );
}
