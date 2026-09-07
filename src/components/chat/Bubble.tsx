"use client";

import { useState } from "react";
import Icon from "@/components/ui/Icon";
import { Badge } from "@/components/ui";
import { stamp } from "./stamp";
import type { ViewCapabilities, ViewMessage } from "@/lib/chat-view";
import s from "./chat.module.css";

const MEDIA_ICON: Record<string, string> = {
  image: "image", video: "video", audio: "mic", document: "file-text",
  sticker: "tags", location: "map-pin", contact: "user",
};

const MEDIA_WORD: Record<string, string> = {
  image: "Şəkil", video: "Video", audio: "Səsli mesaj", document: "Sənəd",
  sticker: "Stiker", location: "Məkan", contact: "Kontakt",
};

/*
 * Tanınmayan tip üçün söz.
 *
 * Əvvəl xam ad ekrana çıxırdı — söhbətdə «templateMessage — fayl yoxdur»
 * sətri görünürdü. WhatsApp vaxtaşırı yeni tip əlavə edir, yəni bu siyahı
 * həmişə yarımçıq olacaq; ekranda isə oxuyan adam üçün texniki ad heç nə
 * demir. «Mesaj» dürüstdür: nəsə gəlib, panel onu açmağı bacarmır.
 */
const KIND_WORD = (kind: string): string => MEDIA_WORD[kind] ?? "Mesaj";

/**
 * One message.
 *
 * The attachment sits above the caption, the way it does in WhatsApp — a photo
 * with "bu?" underneath reads wrong the other way round.
 *
 * HOW MUCH OF AN ATTACHMENT IS SHOWN IS NOT THIS COMPONENT'S DECISION. It
 * renders what `caps.media` says: "inline" paints the picture, "click" shows a
 * button that fetches it on purpose, "label" says only that a file exists.
 * The supervisor's screen runs on "click" — masking someone's phone number
 * while showing every photo they sent would be a strange sort of privacy, and
 * an opened file is then an act rather than a consequence of scrolling.
 */
export default function Bubble({
  m, caps, mediaBase, onStar, jumped,
}: {
  m: ViewMessage;
  caps: ViewCapabilities;
  mediaBase: string;
  onStar?: (id: number, on: boolean) => void;
  jumped?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const out = m.direction === "out";
  const src = `${mediaBase}/${m.id}`;
  const word = KIND_WORD(m.kind);
  const hasFile = m.media === "evolution" || m.media === "archive";
  // "click" turns into "inline" for this one bubble once the reader asks.
  const show = caps.media === "inline" || (caps.media === "click" && opened);

  /* Sitatın bir sətirlik xülasəsi: mətn varsa mətn, yoxsa nəyin göndərildiyi
     («Şəkil», «Səsli mesaj»). Boş sitat sətri «cavabdır, amma nəyə?» sualını
     cavabsız qoyardı. */
  const quoted = m.reply
    ? (m.reply.body?.trim() || KIND_WORD(m.reply.kind))
    : null;

  return (
    <div className={s.bubbleRow} data-out={out ? "true" : undefined} id={`m-${m.id}`}>
      <div className={jumped ? `${s.bubble} ${s.jumped}` : s.bubble}>
        {!out && m.senderName && <div className={s.sender}>{m.senderName}</div>}

        {/* Cavab konteksti mesajın ÜSTÜNDƏ, WhatsApp-dakı kimi: əvvəl nəyə
            cavab verildiyi, sonra cavabın özü. Əks sıra oxunmur — adam artıq
            oxuduğu cümlənin nəyə aid olduğunu geriyə qayıdıb axtarır. */}
        {m.reply && quoted && (
          <div className={s.quote} data-out={m.reply.direction === "out" ? "true" : undefined}>
            <span className={s.quoteWho}>
              {m.reply.direction === "out" ? "Biz" : (m.reply.sender ?? "Müştəri")}
            </span>
            <span className={s.quoteText}>{quoted}</span>
          </div>
        )}

        {hasFile && caps.media !== "hidden" && (
          show ? (
            m.kind === "image" || m.kind === "sticker" ? (
              // next/image is declined deliberately: these are nine years of
              // arbitrary phone photos served through our own endpoint, so
              // there are no dimensions to give and nothing to optimise.
              // eslint-disable-next-line @next/next/no-img-element
              <img className={s.mediaVisual} src={src} alt={m.mediaLabel ?? word} loading="lazy" />
            ) : m.kind === "audio" ? (
              <audio className={s.mediaAudio} controls preload="none" src={src} />
            ) : (
              <a className={s.attach} href={src} target="_blank" rel="noreferrer" data-openable="true">
                <Icon name={MEDIA_ICON[m.kind] ?? "file-text"} size={13} />
                <span className={s.attachName}>{m.mediaLabel ?? word}</span>
              </a>
            )
          ) : (
            <button
              type="button"
              className={s.attach}
              data-openable={caps.media === "click" ? "true" : undefined}
              disabled={caps.media !== "click"}
              onClick={() => setOpened(true)}
              title={caps.media === "click" ? `${word} — açmaq üçün klikləyin` : undefined}
            >
              <Icon name={MEDIA_ICON[m.kind] ?? "file-text"} size={13} />
              <span className={s.attachName}>{m.mediaLabel ?? word}</span>
            </button>
          )
        )}

        {m.media === "absent" && (
          <span className={s.attach}>
            <Icon name={MEDIA_ICON[m.kind] ?? "file-text"} size={13} />
            <span className={s.attachName}>{word} — fayl yoxdur</span>
          </span>
        )}

        {m.body && <div className={s.text}>{m.body}</div>}

        {m.kind === "audio" && (m.voiceText || m.voiceStatus) && (
          <div className={s.voice} data-missing={m.voiceText ? undefined : "true"}>
            <Icon name="mic" size={12} style={{ marginTop: 2, color: "var(--text-faint)" }} />
            <span>{m.voiceText ?? m.voiceStatus}</span>
          </div>
        )}

        {m.kind === "system" && !m.body && <Badge tone="faint" size="xs">sistem</Badge>}

        <div className={s.time}>{stamp(m.ts, true)}</div>

        {caps.canStar && onStar && (
          <button
            type="button"
            className={s.star}
            data-on={m.starred ? "true" : undefined}
            title={m.starred ? "Ulduzu götür" : "Sonra bax"}
            aria-pressed={m.starred}
            onClick={() => onStar(m.id, !m.starred)}
          >
            <Icon name="star" size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
