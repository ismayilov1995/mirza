"use client";

import { useState } from "react";
import styles from "@/app/dashboard.module.css";

interface Props {
  messageId: string;
  messageType: string;
  /** Already in our S3 bucket, so showing it costs WhatsApp nothing. */
  archived: boolean;
  mimetype: string | null;
  fileName: string | null;
  label: string;
}

type State = "idle" | "loading" | "shown" | "gone" | "failed";

/**
 * One file inside the transcript.
 *
 * Archived files render straight away — they come from our own bucket. Anything
 * else waits for a click, because serving it means asking WhatsApp to decrypt
 * it, and a page full of automatic requests is exactly the traffic pattern that
 * has rate-limited this number before.
 */
export default function MediaAttachment({
  messageId,
  messageType,
  archived,
  mimetype,
  fileName,
  label,
}: Props) {
  const [state, setState] = useState<State>(archived ? "shown" : "idle");
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  const src = `/api/media/${encodeURIComponent(messageId)}`;

  async function load() {
    setState("loading");
    try {
      const res = await fetch(src);
      if (res.status === 410) {
        setState("gone");
        return;
      }
      if (!res.ok) {
        setState("failed");
        return;
      }
      setObjectUrl(URL.createObjectURL(await res.blob()));
      setState("shown");
    } catch {
      setState("failed");
    }
  }

  if (state === "idle") {
    return (
      <button type="button" className={styles.rowButton} onClick={load}>
        {label} — yüklə
      </button>
    );
  }
  if (state === "loading") {
    return (
      <div className={styles.bubbleMedia}>
        <span className={styles.spinner} aria-hidden /> {label} yüklənir…
      </div>
    );
  }
  if (state === "gone") {
    return (
      <div className={styles.bubbleMedia} title="WhatsApp təxminən 3 həftədən sonra faylı silir">
        {label} · artıq mövcud deyil
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className={styles.bubbleMedia}>
        {label} · yüklənmədi{" "}
        <button type="button" className={styles.rowButton} onClick={load}>
          Təkrar
        </button>
      </div>
    );
  }

  // Archived media has no blob yet — point straight at the route.
  const url = objectUrl ?? src;
  const kind = mimetype ?? "";
  const onError = () => setState("failed");

  if (messageType === "audioMessage" || kind.startsWith("audio/")) {
    return <audio className={styles.mediaAudio} controls preload="none" src={url} onError={onError} />;
  }
  if (messageType === "videoMessage" || kind.startsWith("video/")) {
    return <video className={styles.mediaVisual} controls preload="metadata" src={url} onError={onError} />;
  }
  if (messageType === "documentMessage" && !kind.startsWith("image/")) {
    return (
      <a className={styles.chatLink} href={url} target="_blank" rel="noreferrer" download={fileName ?? undefined}>
        📄 {fileName ?? "sənədi aç"}
      </a>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element -- blob: and a dynamic
       proxy route; next/image cannot optimise either and would just proxy again. */
    <img className={styles.mediaVisual} src={url} alt={fileName ?? label} loading="lazy" onError={onError} />
  );
}
