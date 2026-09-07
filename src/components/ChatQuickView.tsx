"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { getChatPreview, type ChatPreview } from "@/app/agent-actions";
import styles from "@/app/dashboard.module.css";

// Nəzarətçi lentindən çıxmadan sürətli baxış. Əvvəl "Söhbətə bax" tam
// söhbət səhifəsinə aparırdı — bir bayrağı yoxlamaq üçün lentdən çıxıb geri
// qayıtmaq lazım gəlirdi. İndi son 20 mesaj modal pəncərədə açılır, bağlayıb
// dərhal növbəti bayrağa keçmək olur. Media faylı yüklənmir (bu, sürətli
// baxışdır) — lazım olsa "Tam söhbətə keç" tam səhifəyə aparır.

const MEDIA_LABEL: Record<string, string> = {
  imageMessage: "🖼️ şəkil",
  videoMessage: "🎬 video",
  audioMessage: "🎙️ səsli mesaj",
  documentMessage: "📄 sənəd",
  stickerMessage: "🏷️ stiker",
  locationMessage: "📍 məkan",
  contactMessage: "👤 kontakt",
  albumMessage: "🖼️ albom",
  ptvMessage: "🎬 video mesaj",
};

const msgTimeFmt = new Intl.DateTimeFormat("az-AZ", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Baku",
});

export default function ChatQuickView({
  instanceId,
  jid,
  fullHref,
  label = "Söhbətə bax",
}: {
  instanceId: string;
  jid: string;
  fullHref: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ChatPreview | null | "notfound">(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function openQuickView() {
    setOpen(true);
    setData(null);
    startTransition(async () => {
      const result = await getChatPreview(instanceId, jid);
      setData(result ?? "notfound");
    });
  }

  return (
    <>
      <button type="button" onClick={openQuickView} className={styles.sfLink}>
        {label}
      </button>

      {open ? (
        <div className={styles.qvOverlay} onClick={() => setOpen(false)}>
          <div className={styles.qvModal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className={styles.qvHeader}>
              <div style={{ minWidth: 0 }}>
                <div className={styles.qvTitle}>
                  {data && data !== "notfound" ? data.contactName : "Yüklənir…"}
                </div>
                {data && data !== "notfound" && (data.phoneNumber || data.identityHint) ? (
                  <div className={styles.qvMeta}>{data.phoneNumber ?? data.identityHint}</div>
                ) : null}
              </div>
              <button type="button" className={styles.qvClose} onClick={() => setOpen(false)} aria-label="Bağla">
                ✕
              </button>
            </div>

            <div className={styles.qvBody}>
              {pending || data === null ? (
                <div className={styles.summaryLoading}>
                  <div className={styles.spinner} />
                  Yüklənir…
                </div>
              ) : data === "notfound" ? (
                <div className={styles.empty}>Bu söhbət tapılmadı.</div>
              ) : data.messages.length === 0 ? (
                <div className={styles.empty}>Bu söhbətdə mesaj tapılmadı.</div>
              ) : (
                <div className={styles.transcript}>
                  {data.hasMore ? (
                    <div className={styles.qvMore}>… daha köhnə mesajlar var, tam səhifədə görünür</div>
                  ) : null}
                  {data.messages.map((m) => (
                    <div key={m.id} className={m.fromMe ? styles.bubbleOutRow : styles.bubbleInRow}>
                      <div className={m.fromMe ? styles.bubbleOut : styles.bubbleIn}>
                        {!m.fromMe && m.senderName ? (
                          <div className={styles.bubbleSender}>{m.senderName}</div>
                        ) : null}
                        {m.isMedia ? (
                          <div className={styles.bubbleMedia}>{MEDIA_LABEL[m.messageType] ?? m.messageType}</div>
                        ) : null}
                        {m.text ? <div className={styles.bubbleText}>{m.text}</div> : null}
                        {m.voiceText ? (
                          <div className={styles.bubbleText}>
                            <span className={styles.voiceBadge}>🎙️ mətn</span> {m.voiceText}
                          </div>
                        ) : null}
                        <div className={styles.bubbleTime}>
                          {m.fromMe ? "Biz" : "Onlar"} · {msgTimeFmt.format(new Date(m.timestamp * 1000))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={styles.qvFooter}>
              <Link href={fullHref} className={styles.sfLink}>
                Tam söhbətə keç →
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
