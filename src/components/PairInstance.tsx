"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "../app/dashboard.module.css";

type State = "open" | "connecting" | "close" | "unknown";

/**
 * Live pairing panel: polls the instance's state and shows a fresh QR while
 * it is unpaired.
 *
 * Polling (rather than showing the QR handed back at creation) is necessary
 * because WhatsApp expires a QR after about a minute — a static image would
 * silently stop working while the admin is still reaching for their phone.
 */
export default function PairInstance({ name }: { name: string }) {
  const router = useRouter();
  const [qr, setQr] = useState<string | null>(null);
  const [state, setState] = useState<State>("unknown");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/instance/status?name=${encodeURIComponent(name)}`);
        const data = await res.json();
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
          return;
        }
        setError(null);
        setState(data.state);
        setQr(data.qrBase64);
        // Once paired there is nothing left to poll; refresh so the server
        // component picks up the now-connected instance.
        if (data.state === "open") router.refresh();
      } catch {
        if (!cancelled) setError("Statusu oxumaq alınmadı.");
      }
    }

    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [name, router]);

  if (state === "open") {
    return (
      <div className={styles.pairDone}>
        <div className={styles.pairDoneTitle}>✅ Qoşuldu</div>
        <div className={styles.jid}>
          &quot;{name}&quot; instance-ı aktivdir. İndi admin panelindən onu bir user-ə təyin edə bilərsən.
        </div>
      </div>
    );
  }

  return (
    <div>
      {error && <div className={styles.empty}>⚠️ {error}</div>}
      {qr ? (
        <div className={styles.qrWrap}>
          {/* Data URI from Evolution; next/image would need a loader for no gain here. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="WhatsApp QR kodu" className={styles.qrImage} />
          <div className={styles.qrSteps}>
            <div className={styles.summaryLabel}>Necə qoşulmalı</div>
            <ol className={styles.summaryList}>
              <li>Telefonda WhatsApp-ı aç</li>
              <li>
                <strong>Ayarlar → Qoşulmuş cihazlar → Cihaz əlavə et</strong>
              </li>
              <li>Bu QR kodu skan et</li>
            </ol>
            <div className={styles.jid}>
              QR təxminən 1 dəqiqədən bir yenilənir — bu səhifə avtomatik təzələyir, gözləmək kifayətdir.
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.summaryLoading}>
          <span className={styles.spinner} aria-hidden />
          <div>QR kodu hazırlanır…</div>
        </div>
      )}
    </div>
  );
}
