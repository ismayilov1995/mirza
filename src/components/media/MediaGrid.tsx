"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, EmptyState, Icon, Modal } from "@/components/ui";
import { stamp } from "@/components/chat/stamp";
import { humanSize } from "@/lib/format";
import { TIP_ICON, tipOf, tipWord } from "@/lib/media-tips";
import type { MediaCursor, MediaItem } from "@/lib/media-library";
import s from "./media.module.css";

/**
 * Faylların şəbəkəsi.
 *
 * BİRİNCİ SƏHİFƏ SERVERDƏN GƏLİR. Bu komponent yalnız "daha çox" düyməsini və
 * böyük baxışı daşıyır — yəni süzgəc dəyişəndə brauzer adi keçid edir, ekran
 * isə server tərəfdə yığılır. Süzgəcin URL-də yaşaması (docs/rules.md §8) məhz
 * bunu mümkün edir: sonsuz sürüşdürmə ilə süzgəci client state-ə köçürmək
 * "linki göndər" xassəsini itirərdi.
 *
 * SÜZGƏC DƏYİŞƏNDƏ BU KOMPONENT YENİDƏN QURULUR: səhifə ona `key={query}`
 * verir, yəni yığılmış siyahı, kursor və açıq şəkil özləri sıfırlanır.
 * Effekt ilə state-i "izləmək" eyni işi bir render gec görərdi və React
 * bunu ayrıca xəbərdarlıq kimi qeyd edir.
 *
 * Kiçik şəkillər `?thumb=1` ilə gəlir: altmış orijinal təxminən 14 MB-dır,
 * altmış kiçik şəkil isə yarım meqabayt. `loading="lazy"` qalanını edir —
 * ekrandan kənardakı kart heç istənmir.
 */
export default function MediaGrid({
  initial,
  initialNext,
  query,
  filtered,
}: {
  initial: MediaItem[];
  initialNext: MediaCursor | null;
  /** Süzgəclərin sorğu sətri — "daha çox" eyni süzgəci daşıyır. */
  query: string;
  /** Ən azı bir süzgəc qoyulubmu — boş vəziyyətin hansı olduğunu bu ayırır. */
  filtered: boolean;
}) {
  const [items, setItems] = useState<MediaItem[]>(initial);
  const [next, setNext] = useState<MediaCursor | null>(initialNext);
  const [loading, setLoading] = useState(false);
  const [openAt, setOpenAt] = useState<number | null>(null);

  const loadMore = useCallback(async () => {
    if (!next || loading) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/fayllar?${query}&ts=${next.ts}&id=${next.id}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { items: MediaItem[]; next: MediaCursor | null };
        setItems((prev) => [...prev, ...data.items]);
        setNext(data.next);
      } else {
        setNext(null);
      }
    } catch {
      setNext(null);
    } finally {
      setLoading(false);
    }
  }, [next, loading, query]);

  /* Qalereyada ox düymələri işləməlidir: açıq şəkildən o birinə keçmək üçün
     bağlayıb yenidən açmaq lazım deyil. */
  useEffect(() => {
    if (openAt === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setOpenAt((i) => (i === null ? null : Math.min(i + 1, items.length - 1)));
      if (e.key === "ArrowLeft") setOpenAt((i) => (i === null ? null : Math.max(i - 1, 0)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openAt, items.length]);

  if (items.length === 0) {
    return filtered ? (
      <EmptyState title="Bu süzgəclə fayl yoxdur" actions={<Button href="/fayllar" size="sm">Süzgəci sıfırla</Button>}>
        Seçilmiş tip, söhbət və ya il üzrə heç nə tapılmadı.
      </EmptyState>
    ) : (
      <EmptyState title="Fayl yoxdur">
        Bu hesabın görə biləcəyi söhbətlərdə şəkil, səs və ya sənəd yoxdur.
      </EmptyState>
    );
  }

  const open = openAt === null ? null : items[openAt];

  return (
    <>
      <div className={s.grid}>
        {items.map((it, i) => (
          <figure className={s.card} key={it.messageId}>
            <button
              className={s.thumb}
              type="button"
              onClick={() => setOpenAt(i)}
              title={it.caption ?? undefined}
              aria-label={`${tipWord(it.kind)} · ${it.chatTitle} · ${stamp(it.ts, true)}`}
            >
              <Tile item={it} />
            </button>
            <figcaption className={s.caption}>
              {/* Söhbətin adı süzgəcdir: seçicidə olmayan söhbətə buradan keçilir. */}
              <a className={s.chatLink} href={`/fayllar?chat=${it.chatId}`} title={it.chatTitle}>
                {it.chatTitle}
              </a>
              <span className={s.meta}>
                {stamp(it.ts, true)}
                {it.sizeBytes ? ` · ${humanSize(it.sizeBytes)}` : ""}
              </span>
            </figcaption>
          </figure>
        ))}
      </div>

      {next && (
        <div className={s.more}>
          <Button size="sm" onClick={loadMore} loading={loading} iconRight="chevron-down">
            Daha çox
          </Button>
        </div>
      )}

      {open && (
        <Modal
          width={860}
          title={open.chatTitle}
          meta={`${stamp(open.ts, true)} · ${tipWord(open.kind)}${open.sizeBytes ? ` · ${humanSize(open.sizeBytes)}` : ""}${open.senderName ? ` · ${open.senderName}` : ""}`}
          onClose={() => setOpenAt(null)}
          footer={
            <>
              <span className={s.viewerNav}>
                {openAt !== null ? `${openAt + 1} / ${items.length}` : ""} · ← → ilə keçid
              </span>
              <Button size="sm" href={`/arxiv?chat=${open.chatId}&msg=${open.messageId}`} icon="message-square-text">
                Söhbətdə göstər
              </Button>
              {open.storage !== "absent" && (
                <Button size="sm" variant="primary" href={`/api/arxiv/media/${open.messageId}?endir=1`} icon="download">
                  Yüklə
                </Button>
              )}
            </>
          }
        >
          <div className={s.viewer}>
            <Viewer item={open} />
            {open.caption && <div className={s.viewerCaption}>{open.caption}</div>}
          </div>
        </Modal>
      )}
    </>
  );
}

/** Kartın içi: şəkil kiçildilmiş halda, qalanı ikon və söz. */
function Tile({ item }: { item: MediaItem }) {
  const tip = tipOf(item.kind);
  if (item.storage === "absent") {
    return (
      <span className={s.gone}>
        <Icon name="circle-alert" size={16} />
        <span className={s.glyphWord}>fayl yoxdur</span>
      </span>
    );
  }
  if (tip === "sekil" || tip === "stiker") {
    return (
      /* eslint-disable-next-line @next/next/no-img-element -- şəkil öz
         marşrutumuzdan gəlir və artıq kiçildilib; next/image onu ikinci dəfə
         emal edərdi. */
      <img src={`/api/arxiv/media/${item.messageId}?thumb=1`} alt="" loading="lazy" decoding="async" />
    );
  }
  return (
    <span className={s.glyph}>
      <Icon name={tip ? TIP_ICON[tip] : "file-text"} size={20} />
      <span className={s.glyphWord}>
        {tip === "video" ? "video" : tip === "ses" ? "səs" : tip === "sened" ? "sənəd" : "fayl"}
      </span>
      {item.mime && <span className={s.glyphWord}>{shortMime(item.mime)}</span>}
    </span>
  );
}

/** Böyük baxış: şəkil, video, səs — hərəsi öz elementində. */
function Viewer({ item }: { item: MediaItem }) {
  const src = `/api/arxiv/media/${item.messageId}`;
  if (item.storage === "absent") {
    return (
      <EmptyState tone="warning" title="Fayl yoxdur">
        Bu mesajın faylı heç vaxt endirilməyib — köçürmə zamanı WhatsApp onu artıq
        silmişdi. Mesajın özü və vaxtı arxivdədir, bayt-ları yoxdur.
      </EmptyState>
    );
  }
  const tip = tipOf(item.kind);
  if (tip === "sekil" || tip === "stiker") {
    /* eslint-disable-next-line @next/next/no-img-element -- öz marşrutumuz. */
    return <img src={src} alt={item.caption ?? "şəkil"} />;
  }
  if (tip === "video") return <video src={src} controls preload="metadata" />;
  if (tip === "ses") return <audio src={src} controls preload="metadata" />;
  return (
    <EmptyState icon="file-text" title="Sənəd">
      <span>
        Bu fayl brauzerdə göstərilmir. <a href={src} target="_blank" rel="noreferrer">Yeni pəncərədə aç</a>
        {item.mime ? ` · ${item.mime}` : ""}
      </span>
    </EmptyState>
  );
}

/** "application/vnd.openxmlformats-…-sheet" kimi adlar kartda yer tapmır. */
function shortMime(mime: string): string {
  const bare = mime.split(";")[0].trim();
  const sub = bare.split("/")[1] ?? bare;
  const known: Record<string, string> = {
    "vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "vnd.ms-excel": "xls",
    msword: "doc",
    pdf: "pdf",
    zip: "zip",
    "ogg; codecs=opus": "opus",
  };
  return known[sub] ?? sub.slice(0, 12);
}
