import { pool } from "./db";
import type { ScopedSourceId } from "./access";
import { TIP_KINDS, tipOf, MEDIA_TIPS, type MediaTip } from "./media-tips";

export * from "./media-tips";

/*
 * Fayl kitabxanası — söhbətdən çıxarılmış media.
 *
 * Arxiv ekranı faylı yazışmanın içində göstərir və bu, "bu söhbətdə nə
 * danışıldı" sualının cavabıdır. Burada başqa sual var: "o şəkil hardadır" —
 * yəni fayl əsas obyektdir, söhbət isə onun atributu. İki sual bir ekranda
 * cavablanmır, ona görə ayrı ekrandır.
 *
 * İCAZƏ SÖHBƏT SƏVİYYƏSİNDƏDİR (chat_source), mesaj səviyyəsində yox
 * (message_source) — searchArchiveMeaning ilə eyni qayda. Ölçülüb: eyni
 * yığcamlaşdırma mesaj səviyyəsində 3.7 saniyə, söhbət səviyyəsində 1.9
 * saniyədir, çünki chat_source 6,659 sətirdir və message_source 1.9 milyon.
 * Səhifənin öz sorğusu (aşağıdakı listMedia) hər iki halda 20 ms-dir, çünki
 * o, indeks sırası ilə gedib erkən dayanır.
 */

export interface MediaItem {
  messageId: number;
  chatId: number;
  chatTitle: string;
  ts: number;
  direction: "in" | "out";
  kind: string;
  mime: string | null;
  sizeBytes: number | null;
  /** 'absent' = fayl heç vaxt endirilməyib; ekran bunu boş yer kimi yox, səbəblə göstərir. */
  storage: "evolution" | "archive" | "absent";
  caption: string | null;
  senderName: string | null;
}

export interface MediaFilters {
  tip?: MediaTip;
  chatId?: number | null;
  year?: number | null;
  q?: string;
}

/** Növbəti səhifənin açarı: (ts, id) cütü, OFFSET yox. */
export interface MediaCursor {
  ts: number;
  id: number;
}

/**
 * Bir səhifə fayl, yenidən köhnəyə doğru.
 *
 * SƏHİFƏLƏNMƏ AÇARLADIR, OFFSET DEYİL. 291 min sətirdə OFFSET 5000 demək
 * planlaşdırıcının beş min sətri oxuyub ataraq getməsi deməkdir; (ts, id)
 * cütü isə indeksin ortasından başlayır. Yeni fayl gələndə sürüşmə də olmur —
 * "daha çox" düyməsi eyni faylı iki dəfə göstərmir.
 */
export async function listMedia(
  sources: ScopedSourceId[],
  { tip = "hamisi", chatId = null, year = null, q = "" }: MediaFilters = {},
  { after, limit = 60 }: { after?: MediaCursor | null; limit?: number } = {},
): Promise<{ items: MediaItem[]; next: MediaCursor | null }> {
  if (sources.length === 0) return { items: [], next: null };

  const kinds = tip === "hamisi" ? null : TIP_KINDS[tip];
  const like = q.trim() ? `%${q.trim()}%` : null;

  const { rows } = await pool.query(
    `SELECT m.id, m.chat_id, m.ts, m.direction, m.kind, m.body, m.sender_name,
            md.storage, md.mime, md.size_bytes,
            COALESCE(c.title, c.person_key) AS chat_title
       FROM katibe.message m
       JOIN katibe.media md ON md.message_id = m.id
       JOIN katibe.chat c ON c.id = m.chat_id
      WHERE EXISTS (SELECT 1 FROM katibe.chat_source cs
                     WHERE cs.chat_id = m.chat_id AND cs.source_id = ANY($1::text[]))
        AND ($2::text[] IS NULL OR m.kind = ANY($2::text[]))
        AND ($3::bigint IS NULL OR m.chat_id = $3)
        AND ($4::int IS NULL OR m.ts >= $4)
        AND ($5::int IS NULL OR m.ts < $5)
        AND ($6::text IS NULL
             OR m.body ILIKE $6
             OR m.sender_name ILIKE $6
             OR COALESCE(c.title, c.person_key) ILIKE $6)
        AND ($7::int IS NULL OR (m.ts, m.id) < ($7::int, $8::bigint))
      ORDER BY m.ts DESC, m.id DESC
      LIMIT $9`,
    [
      sources,
      kinds,
      chatId,
      year === null ? null : yearStart(year),
      year === null ? null : yearStart(year + 1),
      like,
      after?.ts ?? null,
      after?.id ?? null,
      limit,
    ],
  );

  const items: MediaItem[] = rows.map((r) => ({
    messageId: Number(r.id),
    chatId: Number(r.chat_id),
    chatTitle: r.chat_title as string,
    ts: Number(r.ts),
    direction: r.direction as "in" | "out",
    kind: r.kind as string,
    mime: (r.mime as string | null) ?? null,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    storage: (r.storage as MediaItem["storage"]) ?? "absent",
    caption: (r.body as string | null) ?? null,
    senderName: (r.sender_name as string | null) ?? null,
  }));

  /* Səhifə dolu gəldisə növbəti səhifə OLA BİLƏR — "var" demir. Sonuncu
     səhifədə boş cavab qayıdır və düymə orada itir; alternativ (limit+1
     oxumaq) bir sətir qazandırıb kodu iki yerdə kəsərdi. */
  const next = items.length === limit
    ? { ts: items[items.length - 1].ts, id: items[items.length - 1].messageId }
    : null;
  return { items, next };
}

function yearStart(year: number): number {
  return Math.floor(Date.UTC(year, 0, 1) / 1000);
}

export interface MediaFacets {
  tips: { tip: MediaTip | "diger"; n: number; bytes: number; gone: number }[];
  years: { year: number; n: number }[];
  /** Ən çox fayl daşıyan söhbətlər — seçicinin siyahısı. */
  chats: { id: number; title: string; n: number }[];
  total: { n: number; bytes: number; gone: number };
  chatCount: number;
  computedAt: number;
}

/*
 * SAYĞACLAR KEŞLƏNİR, ÇÜNKİ ONLAR BİR TAM KEÇİŞDİR.
 *
 * Yığcamlaşdırma 291 min media sətrini gəzir: ölçülüb, 2.6 saniyə. Səhifə
 * hər açılışda bunu gözləyə bilməz, amma rəqəmlər də saatda bir neçə yüz fayl
 * dəyişir — yəni on dəqiqəlik keş həm sürətlidir, həm də yalan demir.
 *
 * Keş prosesin içindədir və sources açarına bağlıdır: iki fərqli hesab eyni
 * sayğacı görməməlidir. Prosess yenidən qalxanda keş sıfırlanır, bu da
 * doğrudur — sayğac heç yerdə saxlanmır.
 */
const FACET_TTL_MS = 10 * 60 * 1000;
const facetCache = new Map<string, { at: number; value: MediaFacets }>();

/** Seçicidə göstərilən söhbət sayı — qalanına fayl kartındakı ad ilə keçilir. */
const CHAT_CHOICES = 300;

export async function mediaFacets(sources: ScopedSourceId[]): Promise<MediaFacets> {
  const empty: MediaFacets = {
    tips: [], years: [], chats: [],
    total: { n: 0, bytes: 0, gone: 0 }, chatCount: 0, computedAt: Date.now(),
  };
  if (sources.length === 0) return empty;

  const key = [...sources].sort().join("|");
  const hit = facetCache.get(key);
  if (hit && Date.now() - hit.at < FACET_TTL_MS) return hit.value;

  const { rows } = await pool.query(
    `SELECT m.chat_id, m.kind,
            (extract(year from to_timestamp(m.ts)))::int AS year,
            count(*)::bigint AS n,
            COALESCE(sum(md.size_bytes), 0)::bigint AS bytes,
            count(*) FILTER (WHERE md.storage = 'absent')::bigint AS gone
       FROM katibe.message m
       JOIN katibe.media md ON md.message_id = m.id
      WHERE EXISTS (SELECT 1 FROM katibe.chat_source cs
                     WHERE cs.chat_id = m.chat_id AND cs.source_id = ANY($1::text[]))
      GROUP BY 1, 2, 3`,
    [sources],
  );

  const tips = new Map<MediaTip | "diger", { n: number; bytes: number; gone: number }>();
  const years = new Map<number, number>();
  const chats = new Map<number, number>();
  const total = { n: 0, bytes: 0, gone: 0 };

  for (const r of rows) {
    const n = Number(r.n);
    const bytes = Number(r.bytes);
    const gone = Number(r.gone);
    const tip = tipOf(r.kind as string) ?? "diger";
    const t = tips.get(tip) ?? { n: 0, bytes: 0, gone: 0 };
    tips.set(tip, { n: t.n + n, bytes: t.bytes + bytes, gone: t.gone + gone });
    years.set(Number(r.year), (years.get(Number(r.year)) ?? 0) + n);
    chats.set(Number(r.chat_id), (chats.get(Number(r.chat_id)) ?? 0) + n);
    total.n += n;
    total.bytes += bytes;
    total.gone += gone;
  }

  const top = [...chats.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, CHAT_CHOICES);
  const titles = await chatTitles(top.map(([id]) => id));

  const value: MediaFacets = {
    tips: MEDIA_TIPS.filter((t) => t !== "hamisi")
      .map((t) => ({ tip: t as MediaTip | "diger", ...(tips.get(t) ?? { n: 0, bytes: 0, gone: 0 }) }))
      .concat(tips.has("diger") ? [{ tip: "diger", ...tips.get("diger")! }] : [])
      .filter((t) => t.n > 0),
    years: [...years.entries()].map(([year, n]) => ({ year, n })).sort((a, b) => b.year - a.year),
    chats: top.map(([id, n]) => ({ id, title: titles.get(id) ?? `#${id}`, n })),
    total,
    chatCount: chats.size,
    computedAt: Date.now(),
  };
  facetCache.set(key, { at: Date.now(), value });
  return value;
}

async function chatTitles(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await pool.query(
    `SELECT id, COALESCE(title, person_key) AS title
       FROM katibe.chat WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return new Map(rows.map((r) => [Number(r.id), r.title as string]));
}

/** Söhbətin adı — seçicidə olmayan söhbət süzgəcə düşəndə başlıq üçün. */
export async function mediaChatTitle(
  sources: ScopedSourceId[],
  chatId: number,
): Promise<string | null> {
  if (sources.length === 0) return null;
  const { rows } = await pool.query(
    `SELECT COALESCE(c.title, c.person_key) AS title
       FROM katibe.chat c
      WHERE c.id = $2
        AND EXISTS (SELECT 1 FROM katibe.chat_source cs
                     WHERE cs.chat_id = c.id AND cs.source_id = ANY($1::text[]))`,
    [sources, chatId],
  );
  return rows.length > 0 ? (rows[0].title as string) : null;
}
