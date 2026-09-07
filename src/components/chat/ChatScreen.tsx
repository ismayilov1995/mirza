"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge, Button, EmptyState, FilterChip, Icon, Input, LiveDot, Modal, TopBar,
} from "@/components/ui";
import Bubble from "./Bubble";
import ReportFlag from "./ReportFlag";
import { dayKey, stamp } from "./stamp";
import { LaneContext } from "./lane-context";
import type {
  ChatTab, ViewCapabilities, ViewChat, ViewFilters, ViewHit, ViewMessage,
} from "@/lib/chat-view";
import s from "./chat.module.css";

/*
 * Söhbət ekranı — arxiv və nəzarət üçün EYNİ komponent.
 *
 * Fərq yalnız iki propdadır: hansı ünvanlardan oxuyur (endpoints) və nəyə
 * icazəsi var (caps). Komponentin içində "bu nəzarətçidirmi?" sualı yoxdur və
 * olmamalıdır — icazə serverdə, marşrutun içində yoxlanılır, burada isə
 * sadəcə gələn cavab göstərilir. İki ekran arasındakı fərqin kodda bir yerdə
 * yaşaması onu unudulmaz edir.
 *
 * Nömrələr də burada maskalanmır: maskalama bazadan çıxarkən baş verir
 * (chat-view.ts). Brauzerə çatmış nömrə artıq sızıb, komponentin ondan sonra
 * nə etməsinin əhəmiyyəti yoxdur.
 */

export interface ChatEndpoints {
  /** GET ?q=&p= → { chats, total } */
  chats: string;
  /** GET ?chat=&n= → { chat, messages, more } */
  messages: string;
  /** GET ?q=&… → { hits, chats } */
  search: string;
  /** GET /<messageId> → bytes */
  media: string;
  /** POST { messageId, on } */
  star?: string;
  /** POST { chatId, ts } */
  read?: string;
}

const MEDIA_KINDS = [
  { key: "image", label: "Şəkil" },
  { key: "video", label: "Video" },
  { key: "audio", label: "Səs" },
  { key: "document", label: "Sənəd" },
  { key: "sticker", label: "Stiker" },
];

const SYNTAX = [
  { code: '"dəqiq ifadə"', what: "Sözlər məhz bu sıra ilə keçsin." },
  { code: "sifariş ödəniş", what: "Hər iki söz eyni mesajda olsun." },
  { code: "sifariş OR order", what: "Biri kifayətdir." },
  { code: "-ləğv", what: "Bu sözü daşıyan mesajları çıxarır." },
];

const EMPTY: ViewFilters = {};

/** Yığcam söhbət adı → iki hərf. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words.slice(0, 2).map((w) => [...w][0]?.toUpperCase() ?? "").join("");
}

/**
 * Splits a snippet around the query terms so the matches can be marked.
 *
 * Client-side rather than in SQL: the database already found the row, and
 * ts_headline would make it decide presentation as well as retrieval. The
 * terms are the ones the parser produced, so quoted phrases highlight whole
 * and an excluded term highlights nothing.
 */
function highlight(text: string, terms: string[]): { t: string; hit: boolean }[] {
  if (terms.length === 0) return [{ t: text, hit: false }];
  const low = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const term of terms) {
    const t = term.toLowerCase();
    if (!t) continue;
    let i = low.indexOf(t);
    while (i !== -1) {
      marks.push([i, i + t.length]);
      i = low.indexOf(t, i + t.length);
    }
  }
  if (marks.length === 0) return [{ t: text, hit: false }];
  marks.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of marks) {
    const last = merged[merged.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else merged.push([...m] as [number, number]);
  }
  const out: { t: string; hit: boolean }[] = [];
  let cur = 0;
  for (const [a, b] of merged) {
    if (a > cur) out.push({ t: text.slice(cur, a), hit: false });
    out.push({ t: text.slice(a, b), hit: true });
    cur = b;
  }
  if (cur < text.length) out.push({ t: text.slice(cur), hit: false });
  return out;
}

/** The include-terms of the query, for highlighting. Mirrors parseQuery(). */
function incTerms(q: string): string[] {
  const re = /"([^"]*)"|(\S+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const phrase = m[1];
    const word = m[2];
    if (word !== undefined && (word.toUpperCase() === "OR" || word.startsWith("-"))) continue;
    const t = phrase !== undefined ? phrase : word;
    if (t) out.push(t);
  }
  return out;
}

export default function ChatScreen({
  endpoints, caps, title, subtitle, back, top, sidebar, initialChatId = null,
  initialMessageId = null, livePollMs = 0,
  lanes, laneChips = true, tabs,
}: {
  endpoints: ChatEndpoints;
  caps: ViewCapabilities;
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
  /**
   * Qlobal başlıq (AppHeader) — çərçivənin ən üstündə, sidebar-ın da.
   *
   * Səhifədə serverdə qurulur və buraya slot kimi gəlir: bu komponent
   * "use client"-dir, başlıq isə sessiyanı və sayğacları serverdə oxuyur.
   */
  top?: React.ReactNode;
  sidebar?: React.ReactNode;
  initialChatId?: number | null;
  /**
   * Açılışda tullanılacaq mesaj — /arxiv?chat=<id>&msg=<id> kimi linklər üçün.
   *
   * Ekrandan kənar bir yerdən (hesabat, MCP cavabı, e-poçt) konkret mesaja
   * link vermək mümkün olmalıdır; söhbəti açıb «indi bu min mesajın içindən
   * onu tap» demək link deyil.
   */
  initialMessageId?: number | null;
  /**
   * Açıq söhbəti bu qədər millisaniyədən bir yenidən oxu. 0 = heç vaxt.
   *
   * Nəzarət ekranı canlı yazışmalara baxır və orada "yeni mesaj gəldi" vacib
   * hadisədir; arxivdə isə doqquz il əvvəlki söhbət dəyişmir, ona görə orada
   * sorğu təkrarlamaq mənasız yükdür.
   */
  livePollMs?: number;
  /**
   * Ayrıca baxıla bilən "zolaqlar" — nəzarətdə bunlar satıcıların nömrələridir.
   *
   * Bir neçə nömrənin yazışmasını bir siyahıya tökmək onları bir-birindən
   * ayırmağı imkansız edir: nəzarətçinin sualı «indi kimə baxıram» deyil,
   * «Zemfira bu gün nə yazıb» olur. Arxivdə belə bölgü yoxdur, ona görə prop
   * verilməyəndə seçici də görünmür.
   */
  /**
   * Zolaqlar — nəzarətdə satıcı/nömrə süzgəci.
   *
   * `awaiting` istəyə görədir: arxivdə belə bir anlayış yoxdur, nəzarətdə isə
   * hansı nömrədə iş yığıldığını göstərən yeganə rəqəmdir.
   */
  lanes?: { id: string; label: string; awaiting?: number }[];
  /**
   * Zolaq çipləri siyahının başında görünsünmü.
   *
   * Nəzarətdə nömrə seçicisi sidebar-dadır (InstanceNav), ona görə çiplər
   * söndürülür: eyni seçim iki yerdə duranda hansının "əsl" olduğu bilinmir.
   */
  laneChips?: boolean;
  /**
   * Siyahının üst tabları. Verilmirsə zolaq ümumiyyətlə görünmür.
   *
   * Süzgəc serverdədir (chat-view.ts:ChatTab): siyahı səhifələnir, ona görə
   * brauzerdə süzmək "5 nəticə" göstərərdi, halbuki növbəti səhifədə daha
   * qırxı var.
   */
  tabs?: { key: ChatTab; label: string }[];
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [filters, setFilters] = useState<ViewFilters>(EMPTY);
  const [sort, setSort] = useState<"relevance" | "newest">("newest");
  const [lane, setLane] = useState<string | null>(null);
  const [tab, setTab] = useState<ChatTab>("all");

  const [chats, setChats] = useState<ViewChat[]>([]);
  const [total, setTotal] = useState(0);
  const [hits, setHits] = useState<ViewHit[]>([]);
  const [hitChats, setHitChats] = useState(0);

  const [activeId, setActiveId] = useState<number | null>(initialChatId);
  const [chat, setChat] = useState<ViewChat | null>(null);
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [more, setMore] = useState(false);
  const [moreNewer, setMoreNewer] = useState(false);
  const [limit, setLimit] = useState(80);
  /*
   * Pəncərənin lövbəri — yazışma HANSI mesajdan oxunsun.
   *
   * null olanda yazışma sondan gəlir, yəni həmişəki davranış. Axtarış
   * nəticəsinə basılanda isə lövbər həmin mesajdır: `jumpId` yalnız
   * EKRANDAKI mesaja sürüşdürür, sorğuya isə heç nə demirdi — mesaj son 80-in
   * içində deyilsə (2019-cu ilin tapıntısı üçün demək olar həmişə) DOM-da
   * ümumiyyətlə olmurdu və ekran sadəcə söhbətin sonunu göstərirdi. Lövbər
   * serverə ötürülməli olan hissədir.
   */
  const [anchor, setAnchor] = useState<number | null>(initialMessageId);
  /** Lövbərdən sonrakı neçə mesaj oxunsun. Lövbərsiz oxunuşda mənasızdır. */
  const [ahead, setAhead] = useState(initialMessageId === null ? 0 : 80);
  const [jumpId, setJumpId] = useState<number | null>(initialMessageId);
  /* Tullanışın nömrəsi: eyni mesaja ikinci dəfə basmaq da tullanışdır. */
  const [jumpTick, setJumpTick] = useState(0);
  const [tick, setTick] = useState(0);

  const [listBusy, setListBusy] = useState(false);
  const [threadBusy, setThreadBusy] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [saved, setSaved] = useState<{ label: string; query: string; filters: ViewFilters }[]>(
    /* Lazy initialiser rather than an effect: reading storage in an effect
       renders once with an empty list and again with the real one, and the
       chips visibly appear a frame late. */
    () => {
      if (typeof window === "undefined") return [];
      try {
        const raw = window.localStorage.getItem("katibe.savedSearches");
        return raw ? JSON.parse(raw) : [];
      } catch {
        return []; // private mode, blocked storage — the feature is optional
      }
    },
  );

  const threadRef = useRef<HTMLDivElement>(null);
  /* Hansı söhbətin sona sürüşdürüldüyü. Yenilənmə ilə YENİ AÇILIŞ-ı ayırmaq
     üçün lazımdır: yeni açılış həmişə sona getməlidir, yenilənmə isə yalnız
     oxucu onsuz da sondadırsa. */
  const pinnedFor = useRef<number | null>(null);
  /* Neçənci tullanış artıq icra olunub — yuxarıdakı effektin hesabı. */
  const jumpedAt = useRef<number | null>(null);
  /* Pəncərənin ən köhnə mesajı. Dəyişməsi «yuxarıya mesaj əlavə olundu»
     deməkdir və oxucunun gördüyü hər şey aşağı sürüşür. */
  const topId = useRef<number | null>(null);
  /* Sonuncu yazılmış oxunma izi — təkrar POST-ların qarşısını alır. */
  const markedRead = useRef<string | null>(null);
  /* Nömrə dəyişdikdən SONRA icra olunacaq "ən yeni cavabsıza keç" niyyəti.
     State yox, ref: dəyişməsi təkrar render doğurmamalıdır, və niyyət siyahı
     gələn kimi, effekt dövrünü gözləmədən icra olunur. */
  const pendingJump = useRef(false);

  /* Saved searches live in the browser: they belong to one person's habits,
     not to the account, and a table for them would be a table nobody ever
     cleans out. */
  const persistSaved = (next: typeof saved) => {
    setSaved(next);
    try { localStorage.setItem("katibe.savedSearches", JSON.stringify(next)); } catch { /* ignore */ }
  };

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  const anyFilter = useMemo(
    () => Object.values(filters).some((v) => v !== undefined && v !== false &&
      !(Array.isArray(v) && v.length === 0)),
    [filters],
  );
  const searching = debounced.length > 0 || anyFilter;
  const listTick = searching ? 0 : tick;

  /*
   * Marşruta sorğu parametri əlavə etmək.
   *
   * Ünvanın ÖZÜNDƏ artıq parametr ola bilər: nəzarətçi önizləməsində səhifə
   * `/api/sohbet/nezaret/chats?as=30` göndərir. Sadəcə `?` yapışdırmaq orada
   * ikinci sual işarəsi yaradırdı (`…chats?as=30?q=…`), server `as` dəyərini
   * oxuya bilmirdi və önizləmə HƏMİŞƏ boş siyahı göstərirdi — 403 alıb susurdu.
   */
  const apiUrl = (base: string, qs: string): string =>
    qs ? `${base}${base.includes("?") ? "&" : "?"}${qs}` : base;

  const filterParams = useCallback(() => {
    const p = new URLSearchParams();
    if (debounced) p.set("q", debounced);
    if (filters.direction) p.set("dir", filters.direction);
    if (filters.chatId !== undefined) p.set("chat", String(filters.chatId));
    if (filters.from) p.set("from", filters.from);
    if (filters.to) p.set("to", filters.to);
    if (filters.kinds?.length) p.set("kinds", filters.kinds.join(","));
    if (filters.chatType) p.set("type", filters.chatType);
    if (filters.starredOnly) p.set("starred", "1");
    if (filters.voiceOnly) p.set("voice", "1");
    if (filters.unreadOnly) p.set("unread", "1");
    if (lane) p.set("instance", lane);
    return p;
  }, [debounced, filters, lane]);

  /* Söhbət siyahısı və axtarış nəticələri — biri və ya digəri, ikisi birdən yox. */
  useEffect(() => {
    let alive = true;
    const url = searching
      ? apiUrl(endpoints.search, filterParams().toString())
      : apiUrl(endpoints.chats, new URLSearchParams({
          ...(debounced ? { q: debounced } : {}),
          ...(lane ? { instance: lane } : {}),
          ...(tab !== "all" ? { tab } : {}),
        }).toString());
    void (async () => {
      setListBusy(true);
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        const d = await r.json();
        if (!alive) return;
        if (searching) { setHits(d.hits ?? []); setHitChats(d.chats ?? 0); }
        else {
          const list: ViewChat[] = d.chats ?? [];
          setChats(list);
          setTotal(d.total ?? 0);
          /* Siyahı yeni zolaq üçün gəldi — gözləyən "keç" əmri varsa indi
             icra olunur. Siyahı son mesaja görə sıralıdır, ona görə birinci
             oxunmamış elə ən yenisidir. */
          if (pendingJump.current) {
            pendingJump.current = false;
            const target = list.find((c) => c.unread > 0);
            if (target) { setLimit(80); setActiveId(target.id); setJumpId(null); }
          }
        }
      } catch {
        if (alive) { setHits([]); setChats([]); }
      } finally {
        if (alive) setListBusy(false);
      }
    })();
    return () => { alive = false; };
    /* `listTick` axtarış zamanı donur: nəticələr sorğuya bağlıdır, taymerə
       yox, və hər 25 saniyədə eyni axtarışı yenidən aparmaq boş yükdür. */
  }, [endpoints.chats, endpoints.search, searching, debounced, filterParams, lane, tab, listTick]);

  /* Açıq söhbətin yazışması. */
  useEffect(() => {
    if (activeId === null) return;
    let alive = true;
    void (async () => {
      setThreadBusy(true);
      try {
        const r = await fetch(apiUrl(
          endpoints.messages,
          `chat=${activeId}&n=${limit}`
            + (anchor !== null ? `&at=${anchor}&f=${ahead}` : "")
            + (lane ? `&instance=${encodeURIComponent(lane)}` : ""),
        ));
        if (!r.ok) throw new Error(String(r.status));
        const d = await r.json();
        if (!alive) return;
        setChat(d.chat ?? null);
        setMessages(d.messages ?? []);
        setMore(Boolean(d.more));
        setMoreNewer(Boolean(d.moreNewer));
      } catch {
        if (alive) { setChat(null); setMessages([]); }
      } finally {
        if (alive) setThreadBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [endpoints.messages, activeId, limit, anchor, ahead, tick, lane]);

  /*
   * Canlı yenilənmə — yalnız açıq söhbət, yalnız arxa planda deyilkən.
   *
   * Bütöv səhifə yeniləməsi qəsdən EDİLMİR: adam yazışmanın ortasında sürüşmüş
   * ola bilər və tam yenilənmə onu yerindən atardı. Səhifə gizli olanda
   * (başqa tab) sorğu dayanır — açıq qalan panel gecə boyu boş yerə sorğu
   * göndərməməlidir.
   */
  useEffect(() => {
    /* Söhbət açıq olmasa da işləyir: siyahının özü də köhnəlir — yeni cavab
       gələndə sıra yuxarı qalxmalı, önizləmə dəyişməlidir. */
    if (livePollMs <= 0) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, livePollMs);
    return () => clearInterval(id);
  }, [livePollMs]);

  /*
   * Oxunma izi — yalnız bizim tərəfdə.
   *
   * Söhbət açılanda və mesajlar gələndə ən sonuncunun vaxtı yazılır. Bu, HEÇ
   * BİR halda WhatsApp-a getmir: müştəri mavi tik görmür. Sayğac "sonuncu
   * dəfə baxandan bəri nə gəlib" deməkdir, "çatdırılıb amma açılmayıb" yox.
   */
  useEffect(() => {
    if (!caps.readMarkers || !endpoints.read || messages.length === 0) return;
    /* Pəncərə sonuncu mesaja çatmayıbsa heç nə yazılmır: axtarış nəticəsindən
       2019-a tullanan adam ARADAKI mesajları görmür və onları «oxundu»
       saymaq sayğacı yalan göstərmək olardı. */
    if (moreNewer) return;
    const last = messages[messages.length - 1];
    /* Yenilənmə hər dəfə yeni massiv qaytarır, ona görə şərt VAXTA baxır:
       eyni son mesaj üçün 25 saniyədən bir POST göndərmək mənasızdır. */
    const mark = `${activeId}:${last.ts}`;
    if (markedRead.current === mark) return;
    markedRead.current = mark;
    fetch(endpoints.read, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: activeId, ts: last.ts }),
    }).then(() => {
      setChats((prev) => prev.map((c) => (c.id === activeId ? { ...c, unread: 0 } : c)));
    }).catch(() => { /* the marker is a convenience; a failure must not break the screen */ });
  }, [caps.readMarkers, endpoints.read, activeId, messages, moreNewer]);

  /* Yeni söhbət açılanda sona sürüş; nəticədən gələndə həmin mesaja. */
  useEffect(() => {
    const box = threadRef.current;
    if (!box || messages.length === 0) return;
    /* Sürüşmə yalnız oxucu onsuz da sonda olanda aparılır. Yenilənmə adamı
       oxuduğu yerdən qoparsa, canlı yenilənmə faydadan çox əngəl olar. */
    const fresh = pinnedFor.current !== activeId;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    pinnedFor.current = activeId;
    /* «Daha köhnə» mesajlar yuxarıya əlavə olunanda səhifə öz-özünə sürüşür,
       ona görə nişanlı mesaj yenidən mərkəzə alınır. Aşağıya əlavə olunma
       («daha yeni», canlı mesaj) yuxarıdakı heç nəyi tərpətmir. */
    const prepended = topId.current !== null && topId.current !== messages[0].id;
    topId.current = messages[0].id;
    if (jumpId !== null) {
      /* Bir tullanış — bir dəfə. Nişan (jumpId) mesaj işıqlı qalsın deyə
         yerində qalır, amma hər canlı yenilənmədə eyni yerə qayıtmaq oxucunu
         öz oxuduğu yerdən qoparardı. Ona görə hesab TULLANIŞA görə aparılır:
         eyni nəticəyə ikinci dəfə basmaq yeni tullanışdır. */
      if (jumpedAt.current === jumpTick && !prepended) return;
      const el = box.querySelector(`#m-${jumpId}`);
      if (el) {
        jumpedAt.current = jumpTick;
        box.scrollTop +=
          el.getBoundingClientRect().top - box.getBoundingClientRect().top -
          (box.clientHeight - el.clientHeight) / 2;
        return;
      }
    }
    if (fresh || atBottom) box.scrollTop = box.scrollHeight;
  }, [messages, jumpId, jumpTick, activeId]);

  /** Yüklənmiş pəncərədəki mesaja tullan — media siyahısından seçim də budur. */
  const jumpTo = (msgId: number) => {
    setJumpId(msgId);
    setJumpTick((n) => n + 1);
  };

  /*
   * Söhbəti aç — istəsən konkret mesajdan.
   *
   * `msgId` verilirsə pəncərə serverdə həmin mesajın ətrafında qurulur
   * (endpoints.messages?at=), yəni mesaj gələn cavabın İÇİNDƏ olur və
   * sürüşdürmə effekti onu tapa bilir.
   */
  const openChat = (id: number, msgId: number | null = null) => {
    if (id !== activeId || msgId !== null) {
      setLimit(80);
      setAhead(msgId === null ? 0 : 80);
      setAnchor(msgId);
    }
    setActiveId(id);
    if (msgId === null) setJumpId(null);
    else jumpTo(msgId);
  };

  /** Lövbəri buraxıb yazışmanın sonuna qayıt. */
  const backToLatest = () => {
    setLimit(80);
    setAhead(0);
    setAnchor(null);
    setJumpId(null);
  };


  /*
   * «Ən yeni cavabsıza keç» — nömrə dəyişimindən SONRA.
   *
   * Zolaq dəyişəndə siyahı yenidən yüklənir, yəni tullanmaq üçün hədəf hələ
   * yoxdur. Ona görə niyyət saxlanılır və siyahı gələndə icra olunur; bir
   * dəfəlikdir, yoxsa sonrakı hər yenilənmə söhbəti öz-özünə dəyişərdi.
   */
  const jumpToUnread = (id: string | null) => {
    if (id !== lane) { pendingJump.current = true; setLane(id); return; }
    const target = chats.find((c) => c.unread > 0);
    if (target) openChat(target.id);
  };

  const toggleStar = async (id: number, on: boolean) => {
    if (!endpoints.star) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, starred: on } : m)));
    setHits((prev) => prev.map((h) => (h.id === id ? { ...h, starred: on } : h)));
    try {
      await fetch(endpoints.star, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId: id, on }),
      });
    } catch {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, starred: !on } : m)));
    }
  };

  const setFilter = (patch: Partial<ViewFilters>) => setFilters((f) => ({ ...f, ...patch }));

  /* Aktiv filtrlərin çipləri — hər biri özünü silir. */
  const chips: { label: string; clear: () => void }[] = [];
  if (filters.direction) {
    chips.push({
      label: filters.direction === "out" ? "Biz yazmışıq" : "Bizə yazılıb",
      clear: () => setFilter({ direction: undefined }),
    });
  }
  if (filters.from) chips.push({ label: `${filters.from}-dən`, clear: () => setFilter({ from: undefined }) });
  if (filters.to) chips.push({ label: `${filters.to}-ə qədər`, clear: () => setFilter({ to: undefined }) });
  for (const k of filters.kinds ?? []) {
    chips.push({
      label: MEDIA_KINDS.find((x) => x.key === k)?.label ?? k,
      clear: () => setFilter({ kinds: (filters.kinds ?? []).filter((x) => x !== k) }),
    });
  }
  if (filters.chatType) {
    chips.push({
      label: filters.chatType === "group" ? "Qruplar" : "Fərdi",
      clear: () => setFilter({ chatType: undefined }),
    });
  }
  if (filters.voiceOnly) chips.push({ label: "Səsli", clear: () => setFilter({ voiceOnly: undefined }) });
  if (filters.starredOnly) chips.push({ label: "Ulduzlu", clear: () => setFilter({ starredOnly: undefined }) });
  if (filters.unreadOnly) chips.push({ label: "Oxunmamış", clear: () => setFilter({ unreadOnly: undefined }) });

  const terms = incTerms(debounced);
  const sortedHits = useMemo(() => {
    if (sort === "newest") return hits;
    // "Relevance" here means how many times the terms occur — a cheap ranking,
    // but an honest one: the database returned these in time order and there
    // is no score to sort by. Naming it what it does keeps the button truthful.
    const score = (h: ViewHit) => {
      const hay = `${h.body ?? ""} ${h.mediaLabel ?? ""} ${h.voiceText ?? ""}`.toLowerCase();
      return terms.reduce((n, t) => n + hay.split(t.toLowerCase()).length - 1, 0);
    };
    return [...hits].sort((a, b) => score(b) - score(a) || b.ts - a.ts);
  }, [hits, sort, terms]);

  const withMedia = messages.filter((m) => m.media === "evolution" || m.media === "archive");
  const dayMarked: { key: string; day?: string; msg?: ViewMessage }[] = [];
  let lastDay: string | null = null;
  for (const m of messages) {
    const d = dayKey(m.ts);
    if (d !== lastDay) { dayMarked.push({ key: `d-${d}-${m.id}`, day: d }); lastDay = d; }
    dayMarked.push({ key: `m-${m.id}`, msg: m });
  }

  /* Siyahıdakı ilk oxunmamış söhbət — "Yeni mesaja keç" düyməsi üçün.
     Siyahı onsuz da son mesaja görə sıralanıb, ona görə birincisi ən yenisidir
     və ayrıca sorğu lazım deyil. */
  const nextUnread = chats.find((c) => c.unread > 0)?.id ?? null;

  /*
   * Söhbətin nömrə etiketi.
   *
   * Bir söhbət birdən çox nömrədə görünə bilər (eyni müştəri iki satıcıya
   * yazıb, və ya qrupda hamı var), ona görə hamısı yazılır.
   *
   * Amma nömrə SEÇİLİBSƏ, hamısını eyni çəkidə sadalamaq yanıldırdı: sətirdə
   * «PRİNCİPAL» görən adam «mən Rouz seçmişdim, principal niyə çıxır?» deyə
   * haqlı olaraq soruşurdu. İndi seçilmiş nömrə önə keçir, qalanları isə
   * «həm də» ilə ayrılır — sətrin rəqəmləri onsuz da yalnız seçilmiş nömrəyə
   * aiddir.
   */
  const laneLabel = (c: ViewChat): { own: string; others: string } => {
    const names = (lanes ?? []).filter((l) => c.instanceIds.includes(l.id));
    if (!lane) return { own: names.map((l) => l.label).join(" · "), others: "" };
    return {
      own: names.filter((l) => l.id === lane).map((l) => l.label).join(" · "),
      others: names.filter((l) => l.id !== lane).map((l) => l.label).join(" · "),
    };
  };

  return (
    <div className={s.shellOuter}>
      {top}
      <div className={s.shell}>
        {/* Sidebar səhifədə serverdə qurulur, amma ağacda BURADA durur — ona
            görə içindəki nömrə siyahısı zolaq seçimini kontekstdən oxuya bilir
            (lane-context.tsx). */}
        <LaneContext.Provider value={{ lane, setLane, jumpToUnread }}>
          {sidebar}
        </LaneContext.Provider>

      <div className={s.shellMain}>
        {/* Ekranın adı siyahının DA, yazışmanın DA üstündədir: "hansı
            ekrandayam" sualı bir dəfə cavablanır. Əvvəl bu ad siyahının
            başlığı idi və yazışma açılanda gözdən itirdi. */}
        <TopBar
          title={title}
          subtitle={subtitle}
          back={back}
          /* Canlı yenilənmə EKRANIN xassəsidir, açıq söhbətin yox: söhbət
             seçilməyəndə də «yenilənir» sualının cavabı görünməlidir. Nöqtə
             yalnız yenilənmə AÇIQ olan ekranda var (livePollMs > 0) — arxivdə
             yanıb-sönən nöqtə olmayan bir şeyi vəd edərdi. */
          actions={livePollMs > 0 ? <LiveDot /> : undefined}
        />

        <div className={s.chatArea}>
      <div className={s.rail}>
        <div className={s.railHead}>
          <div className={s.searchRow}>
            <div className={s.searchWrap}>
              <Input
                icon="search"
                placeholder="Bütün yazışmalarda axtar…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query.length > 0 && (
                <button className={s.clearBtn} type="button" title="Təmizlə" onClick={() => setQuery("")}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            <Button
              variant={panelOpen || anyFilter ? "primary" : "secondary"}
              icon="sliders-horizontal"
              title="Ətraflı axtarış"
              onClick={() => setPanelOpen((v) => !v)}
            />
          </div>

          {((lanes && lanes.length > 1) || tabs) && (
            <div className={s.laneRow}>
              <div className={s.chipRow}>
                {laneChips && lanes && lanes.length > 1 && (
                  <>
                    <FilterChip active={lane === null} onClick={() => setLane(null)}>Hamısı</FilterChip>
                    {lanes.map((l) => (
                      <FilterChip key={l.id} active={lane === l.id} onClick={() => setLane(l.id)}>
                        {l.label}
                        {/* Cavabsız sayı çipin öz içindədir: hansı nömrədə iş
                            yığıldığını görmək üçün nömrəni seçmək lazım olmamalıdır. */}
                        {l.awaiting ? <span className={s.laneCount}>{l.awaiting}</span> : null}
                      </FilterChip>
                    ))}
                  </>
                )}
                {/* Tablar siyahının nə göstərdiyini dəyişir, süzgəc panelindən
                    fərqli olaraq həmişə görünür: "cavabsızlar hanı?" gündə
                    onlarla dəfə verilən sualdır və onu iki klik arxasında
                    saxlamaq olmaz. */}
                {tabs?.map((t) => (
                  <FilterChip key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
                    {t.label}
                  </FilterChip>
                ))}
              </div>
              {/* Nəzarətçinin ən çox verdiyi əmr: "yenisini göstər". Sönük
                  düymə "yeni yoxdur" deməkdir və bu, öz-özlüyündə cavabdır. */}
              {lanes && lanes.length > 1 && (
                <Button size="sm" iconRight="arrow-right"
                  disabled={nextUnread === null}
                  onClick={() => nextUnread !== null && openChat(nextUnread)}>
                  {nextUnread === null ? "Yeni yoxdur" : "Yeni mesaja keç"}
                </Button>
              )}
            </div>
          )}

          {chips.length > 0 && (
            <div className={s.chipRow}>
              {chips.map((c) => (
                <FilterChip key={c.label} active onClick={c.clear}>{c.label} ✕</FilterChip>
              ))}
              <button className={s.resetBtn} type="button" onClick={() => setFilters(EMPTY)}>
                Hamısını sıfırla
              </button>
            </div>
          )}
        </div>

        {panelOpen && (
          <div className={s.panel}>
            <div className={s.group}>
              <div className={s.label}>Kim yazıb</div>
              <select
                className={s.select}
                value={filters.direction ?? "any"}
                onChange={(e) => setFilter({
                  direction: e.target.value === "any" ? undefined : (e.target.value as "in" | "out"),
                })}
              >
                <option value="any">Fərqi yoxdur</option>
                <option value="out">Biz yazmışıq</option>
                <option value="in">Bizə yazılıb</option>
              </select>
            </div>

            <div className={s.group}>
              <div className={s.label}>Tarix aralığı</div>
              <div className={s.pair}>
                <Input size="sm" type="date" value={filters.from ?? ""}
                  onChange={(e) => setFilter({ from: e.target.value || undefined })} />
                <Input size="sm" type="date" value={filters.to ?? ""}
                  onChange={(e) => setFilter({ to: e.target.value || undefined })} />
              </div>
            </div>

            <div className={s.group}>
              <div className={s.label}>Media növü</div>
              <div className={s.wrapRow}>
                {MEDIA_KINDS.map((k) => {
                  const on = (filters.kinds ?? []).includes(k.key);
                  return (
                    <FilterChip key={k.key} active={on} onClick={() => setFilter({
                      kinds: on ? (filters.kinds ?? []).filter((x) => x !== k.key)
                               : [...(filters.kinds ?? []), k.key],
                    })}>{k.label}</FilterChip>
                  );
                })}
              </div>
            </div>

            <div className={s.group}>
              <div className={s.label}>Əhatə</div>
              <div className={s.wrapRow}>
                <FilterChip active={filters.chatType === "individual"}
                  onClick={() => setFilter({ chatType: filters.chatType === "individual" ? undefined : "individual" })}>
                  Fərdi
                </FilterChip>
                <FilterChip active={filters.chatType === "group"}
                  onClick={() => setFilter({ chatType: filters.chatType === "group" ? undefined : "group" })}>
                  Qruplar
                </FilterChip>
                <FilterChip active={filters.voiceOnly === true}
                  onClick={() => setFilter({ voiceOnly: filters.voiceOnly ? undefined : true })}>
                  Yalnız səsli
                </FilterChip>
                {caps.readMarkers && (
                  <FilterChip active={filters.unreadOnly === true}
                    onClick={() => setFilter({ unreadOnly: filters.unreadOnly ? undefined : true })}>
                    Oxunmamış
                  </FilterChip>
                )}
                {caps.canStar && (
                  <FilterChip active={filters.starredOnly === true}
                    onClick={() => setFilter({ starredOnly: filters.starredOnly ? undefined : true })}>
                    Ulduzlu
                  </FilterChip>
                )}
              </div>
            </div>

            <div className={s.group}>
              <div className={s.groupHead}>
                <div className={s.label}>Yadda saxlanmış axtarışlar</div>
                <Button variant="secondary" size="sm" icon="star"
                  disabled={!searching}
                  onClick={() => persistSaved([...saved, {
                    label: (debounced || "Yalnız filtrlər").slice(0, 32), query: debounced, filters,
                  }])}
                >Bunu saxla</Button>
              </div>
              {saved.length > 0 && (
                <div className={s.wrapRow}>
                  {saved.map((sv, i) => (
                    <FilterChip key={`${sv.label}-${i}`} shape="md"
                      onClick={() => { setQuery(sv.query); setFilters(sv.filters); }}
                      title="Sil: iki dəfə klikləyin"
                    >{sv.label}</FilterChip>
                  ))}
                  <button className={s.resetBtn} type="button" onClick={() => persistSaved([])}>
                    Siyahını təmizlə
                  </button>
                </div>
              )}
            </div>

            <div className={s.cheat}>
              <div className={s.label}>Axtarış sintaksisi</div>
              {SYNTAX.map((r) => (
                <div className={s.cheatRow} key={r.code}>
                  <code className={s.code}>{r.code}</code>
                  <span className={s.cheatWhat}>{r.what}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {searching && (
          <div className={s.countBar}>
            <div className={s.countText}>
              <span className={s.countNum}>{hits.length}</span> mesaj · {hitChats} söhbətdə
            </div>
            <div className={s.sortGroup}>
              <button className={s.sortBtn} data-active={sort === "newest" ? "true" : undefined}
                type="button" onClick={() => setSort("newest")}>Ən yeni</button>
              <button className={s.sortBtn} data-active={sort === "relevance" ? "true" : undefined}
                type="button" onClick={() => setSort("relevance")}>Uyğunluq</button>
            </div>
          </div>
        )}

        <div className={s.list}>
          {listBusy && (
            <div className={s.loading}>
              <Icon name="loader-circle" size={14} /> oxunur…
            </div>
          )}

          {!listBusy && searching && sortedHits.length === 0 && (
            <div className={s.pad}>
              <EmptyState title="Nəticə yoxdur">
                Bu sorğu və filtrlərə uyğun mesaj tapılmadı. Bir filtri götürün,
                və ya sözləri <code className={s.code}>OR</code> ilə genişləndirin.
              </EmptyState>
            </div>
          )}

          {!listBusy && searching && sortedHits.map((h) => {
            const snippet = h.body || h.voiceText || h.mediaLabel || "";
            return (
              <button key={h.id} type="button" className={s.row}
                data-active={jumpId === h.id ? "true" : undefined}
                onClick={() => openChat(h.chatId, h.id)}>
                <div className={s.rowTop}>
                  <div className={s.rowName}>
                    <span className={s.name}>{h.chatTitle}</span>
                    {h.isGroup && <Badge tone="faint" size="xs" icon="users">qrup</Badge>}
                  </div>
                  <span className={s.stamp}>{stamp(h.ts, true)}</span>
                </div>
                <div className={s.snippet}>
                  {highlight(snippet, terms).map((p, i) =>
                    p.hit ? <mark key={i} className={s.hitMark}>{p.t}</mark> : <span key={i}>{p.t}</span>)}
                </div>
                <div className={s.rowMeta}>
                  <span className={s.who}>{h.direction === "out" ? "Biz" : (h.senderName ?? h.chatTitle)}</span>
                  {h.media && h.media !== "absent" && (
                    <Badge tone="info" variant="soft" size="xs" icon="image">{h.kind}</Badge>
                  )}
                  {h.starred && <Badge tone="serious" variant="soft" size="xs" icon="star">ulduzlu</Badge>}
                </div>
              </button>
            );
          })}

          {!listBusy && !searching && chats.length === 0 && (
            <div className={s.pad}><EmptyState title="Söhbət yoxdur">Bu əhatədə söhbət tapılmadı.</EmptyState></div>
          )}

          {!listBusy && !searching && chats.map((c) => (
            <button key={c.id} type="button" className={s.row}
              data-active={c.id === activeId ? "true" : undefined}
              data-awaiting={c.awaiting ? "true" : undefined}
              onClick={() => openChat(c.id)}>
              <div className={s.rowTop}>
                <div className={s.rowName}>
                  <span className={s.avatar} data-group={c.isGroup ? "true" : undefined}>{initials(c.title)}</span>
                  <span className={s.name}>{c.title}</span>
                </div>
                <span className={s.stamp}>{stamp(c.lastTs, true)}</span>
              </div>
              <div className={s.rowBottom}>
                <span className={s.preview}>{c.preview}</span>
                {/* «Gözləyir» oxunmamış sayğacı ilə eyni şey deyil: nəzarətçi
                    söhbəti açıb oxuyandan sonra sayğac sıfırlanır, cavab isə
                    hələ də bizdədir. Siyahıda görünməli olan məhz odur. */}
                {/* Üç fərqli sual, üç fərqli nişan və qarışdırılmamalıdırlar:
                    «gözləyir» = cavab bizdədir; «satıcı açmayıb» = telefonda
                    hələ oxunmayıb; «siz baxmadınız» = nəzarətçi bu paneldə
                    söhbəti açmayıb. */}
                {c.awaiting && (
                  <Badge tone="info" variant="soft" size="xs">gözləyir</Badge>
                )}
                <SalesReadState chat={c} />
                {caps.readMarkers && <ReadState chat={c} />}
                {c.unread > 0 && (
                  <span className={s.unread}
                    title={`${c.unread} yeni mesaj — sonuncu dəfə burada baxandan bəri`}>
                    {c.unread}
                  </span>
                )}
              </div>
              {/* Hansı nömrənin söhbəti olduğu sətrin altında qalır: zolaq
                  süzgəci «Hamısı»dırsa, bu, sıraları bir-birindən ayıran
                  yeganə işarədir. */}
              {(() => {
                const { own, others } = laneLabel(c);
                if (!own && !others) return null;
                return (
                  <div className={s.rowLane}>
                    {own}
                    {others && (
                      <span className={s.rowLaneMore}>
                        {own ? " · həm də " : "həm də "}
                        {others}
                      </span>
                    )}
                  </div>
                );
              })()}
            </button>
          ))}

          {!listBusy && !searching && total > chats.length && (
            <div className={s.pad}>
              <span className={s.who}>{chats.length} / {total.toLocaleString("az-AZ")} söhbət — axtarışla daraldın</span>
            </div>
          )}
        </div>
      </div>

      <div className={s.main}>
        {/*
          Yazışmanın başlığı — YALNIZ söhbət açıq olanda.
          
          Əvvəl söhbət seçilməyəndə bura ekranın öz adı düşürdü (`chat?.title
          ?? title`) və nəticədə «Arxiv» eyni ekranda iki dəfə yazılırdı: bir
          dəfə səhifə zolağında, bir dəfə də boş panelin üstündə. Bu zolağın
          işi bir dənədir — HANSI yazışmaya baxıram; yazışma yoxdursa, cavab da
          yoxdur, ona görə zolaq da olmur. Boş panelin özü onsuz da nə etmək
          lazım olduğunu deyir.
        */}
        {chat && (
          <TopBar
            title={chat.title}
            subtitle={`${chat.isGroup ? "Qrup" : "Fərdi"} · ${chat.messages.toLocaleString("az-AZ")} mesaj · ${
              chat.firstTs ? new Date(chat.firstTs * 1000).getFullYear() : "—"}–${
              chat.lastTs ? new Date(chat.lastTs * 1000).getFullYear() : "—"}`}
            actions={
              <>
                {chat.sources.includes("archive") && <Badge tone="faint" size="sm" icon="inbox">arxiv</Badge>}
                {chat.sources.includes("evolution") && <Badge tone="brand" variant="soft" size="sm">canlı</Badge>}
                {caps.canReportFlag && <ReportFlag chatId={chat.id} />}
                {caps.media !== "hidden" && (
                  <Button variant="secondary" size="sm" icon="image"
                    disabled={withMedia.length === 0}
                    onClick={() => setMediaOpen(true)}>
                    Media ({withMedia.length})
                  </Button>
                )}
              </>
            }
          />
        )}

        <div className={s.thread} ref={threadRef}>
          {activeId === null && (
            <div className={s.pad}>
              <EmptyState title="Söhbət seçilməyib">
                Soldakı siyahıdan bir söhbət seçin, və ya axtarışla birbaşa mesaja keçin.
              </EmptyState>
            </div>
          )}

          {threadBusy && messages.length === 0 && (
            <div className={s.loading}><Icon name="loader-circle" size={14} /> yazışma oxunur…</div>
          )}

          {/* Seçilmiş nömrə yazışmanı da süzür, ona görə boş pəncərə mümkündür:
              söhbət var, amma HƏMİN nömrədə mesajı yoxdur. İzahsız boşluq
              «ekran sınıqdır» kimi oxunur — burada həm səbəb, həm də çıxış
              yolu yazılır. */}
          {activeId !== null && !threadBusy && messages.length === 0 && lane && (
            <div className={s.pad}>
              <EmptyState title="Bu nömrədə mesaj yoxdur">
                Söhbət başqa nömrələrdə davam edir; seçilmiş nömrədə bu adamla
                yazışma olmayıb.{" "}
                <button type="button" className={s.linkBtn} onClick={() => setLane(null)}>
                  Hamısını göstər
                </button>
              </EmptyState>
            </div>
          )}

          {more && (
            <div className={s.dayRow}>
              <Button variant="secondary" size="sm" icon="arrow-up"
                onClick={() => setLimit((n) => Math.min(3000, n + 200))}>
                Daha köhnə 200 mesaj
              </Button>
            </div>
          )}

          {dayMarked.map((it) =>
            it.day ? (
              <div className={s.dayRow} key={it.key}><span className={s.day}>{it.day}</span></div>
            ) : (
              <Bubble key={it.key} m={it.msg!} caps={caps} mediaBase={endpoints.media}
                onStar={caps.canStar ? toggleStar : undefined}
                jumped={jumpId === it.msg!.id} />
            ),
          )}

          {/* Lövbərli pəncərə yazışmanın ORTASINDA bitir: aşağıda mesaj var,
              amma oxunmayıb. Bunu deməmək «söhbət burada qurtarıb» kimi
              oxunur — ona görə həm davamı, həm də sona qayıtmaq buradadır. */}
          {moreNewer && (
            <div className={s.dayRow}>
              <Button variant="secondary" size="sm" icon="chevron-down"
                onClick={() => setAhead((n) => Math.min(3000, n + 200))}>
                Daha yeni 200 mesaj
              </Button>
              <Button variant="secondary" size="sm" onClick={backToLatest}>
                Ən sona
              </Button>
            </div>
          )}
        </div>

        <div className={s.foot}>
          <div className={s.footNote}>
            <Icon name="lock" size={12} />
            <span>
              Bu panel WhatsApp-a heç nə yazmır və heç bir mesajı «oxundu» etmir.
              Buradakı oxunma izi yalnız katibe.online-a aiddir — WhatsApp-da
              mesaj satıcı özü açana qədər oxunmamış qalır.
            </span>
          </div>
          <div className={s.composer} aria-hidden>
            <textarea className={s.composerBox} disabled rows={1} placeholder="Cavab yazmaq aktiv deyil" />
            <Button variant="primary" size="md" icon="arrow-right" disabled>Göndər</Button>
          </div>
        </div>
      </div>

      {mediaOpen && chat && (
        <MediaList items={withMedia} chatTitle={chat.title}
          onPick={(id) => { setMediaOpen(false); jumpTo(id); }}
          onClose={() => setMediaOpen(false)} />
      )}
        </div>
      </div>
      </div>
    </div>
  );
}

/**
 * "Bu söhbəti açıb oxumuşam" — və ya oxumamışam.
 *
 * Nəzarətçinin ekranda görməli olduğu ən sadə şey budur və əvvəl heç yerdə
 * yox idi: oxunmamış sayğacı hər söhbətdə sıfır göstərirdi (izlər toxumla
 * qoyulmuşdu), yəni ekran «hamısına baxılıb» kimi oxunurdu.
 *
 * Açılış vaxtı ilk açılışdır, sonuncu deyil — «nə vaxt gördün» sualının
 * cavabı odur. Sayğac isə bir dəfə göz gəzdirməyi hər gün qayıtmaqdan ayırır.
 */
/**
 * «SİZ bu söhbətə baxdınızmı» — nəzarətçinin öz izi.
 *
 * Adı qəsdən şəxsidir. Əvvəl sadəcə «baxılmayıb» yazırdı və bu, ekranda
 * yanlış oxunurdu: adam onu "satıcı mesajı görməyib" kimi başa düşürdü,
 * halbuki rəqəm nəzarətçinin özünün bu paneldə söhbəti açıb-açmadığıdır.
 * İki fərqli sual, iki fərqli nişan — bax SalesReadState.
 *
 * Yeni mesaj gələndə nişan susur və sözü qırmızı sayğaca verir: söhbət
 * açılanda oxundu sayılır, sonra gələn hər mesaj onu yenidən oxunmamış edir.
 *
 * WhatsApp-a dəxli yoxdur: orada mesaj satıcı özü açana qədər oxunmamış
 * qalır və bu panel ona toxunmur.
 */
function ReadState({ chat }: { chat: ViewChat }) {
  if (chat.unread > 0) return null;
  if (chat.openedAt === null) {
    return (
      <span className={s.readState} data-seen="false"
        title="Siz bu söhbəti bu paneldə hələ açmamısınız">
        siz baxmadınız
      </span>
    );
  }
  const when = stamp(Math.floor(new Date(chat.openedAt).getTime() / 1000), true);
  return (
    <span className={s.readState} data-seen="true"
      title={`Siz ilk dəfə ${when} baxmısınız · yalnız bu paneldə, WhatsApp-da deyil`}>
      <Icon name="eye" size={11} />
      {chat.openedCount > 1 ? `siz ${chat.openedCount}×` : "siz baxdınız"}
    </span>
  );
}

/**
 * «SATICI mesajı açıbmı» — telefonun öz nişanı.
 *
 * Mənbə panel deyil, WhatsApp-ın özüdür (evolution_api."Chat".unreadMessages,
 * Baileys sinxronizasiyası). Nəzarətçi üçün bu, «cavab verilməyib»dən daha
 * ağır siqnaldır: mesaj cavabsız qala bilər, çünki satıcı düşünür — amma
 * açılmayıbsa, heç kim ona baxmayıb.
 *
 * Rəqəm göstərilir, çünki 1 ilə 40 eyni şey deyil.
 */
function SalesReadState({ chat }: { chat: ViewChat }) {
  if (chat.salesUnread <= 0) return null;
  return (
    <Badge tone="serious" variant="soft" size="xs"
      style={{ flex: "none" }}>
      satıcı açmayıb · {chat.salesUnread}
    </Badge>
  );
}

/** Söhbətdəki bütün fayllar, bir siyahıda. */
function MediaList({
  items, chatTitle, onPick, onClose,
}: {
  items: ViewMessage[];
  chatTitle: string;
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("all");
  const kinds = [...new Set(items.map((m) => m.kind))];
  const shown = tab === "all" ? items : items.filter((m) => m.kind === tab);
  return (
    <Modal title={`${chatTitle} — fayllar`} meta={`${shown.length} / ${items.length}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-7)" }}>
        <div className={s.wrapRow}>
          <FilterChip active={tab === "all"} onClick={() => setTab("all")}>Hamısı</FilterChip>
          {kinds.map((k) => (
            <FilterChip key={k} active={tab === k} onClick={() => setTab(k)}>{k}</FilterChip>
          ))}
        </div>
        {shown.length === 0 ? (
          <EmptyState title="Fayl yoxdur">Bu söhbətdə bu növdən əlavə yoxdur.</EmptyState>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            {shown.map((m) => (
              <button key={m.id} type="button" className={s.mediaItem} onClick={() => onPick(m.id)}>
                <span className={s.mediaIcon}><Icon name="file-text" size={16} /></span>
                <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span className={s.mediaName}>{m.mediaLabel ?? m.kind}</span>
                  <span className={s.mediaMeta}>
                    {stamp(m.ts, true)} · {m.direction === "out" ? "Biz" : (m.senderName ?? "Onlar")}
                  </span>
                </span>
                <Icon name="arrow-right" size={14} />
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
