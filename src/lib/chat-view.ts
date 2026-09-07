import { pool } from "./db";
import { maskDisplayName, maskPhonesInText } from "./monitor";
import {
  monitorVisibleSql,
  monitorVisibilityJoins,
  type MonitorScope,
  type ScopedSourceId,
} from "./access";

/*
 * The one conversation reader, behind both screens.
 *
 * /arxiv and /monitor used to be two implementations of the same picture: two
 * message shapes, two date formats, two ideas of what a media attachment is.
 * They are one here, and the difference between them is a SCOPE and a set of
 * CAPABILITIES — not a second copy of the code.
 *
 * WHY THAT IS SAFE. The scope is resolved by the caller (a page or a route
 * that has already checked a session) and every query below is filtered by it
 * without exception. Nothing in this file decides who may see what; it decides
 * how to ask, once somebody else has decided who is asking. The monitor scope
 * additionally carries the per-chat visibility rules, which are applied as SQL
 * rather than filtered afterwards — a hidden conversation must not be fetched
 * and then dropped, because "fetched" is where the leak would be.
 *
 * MASKING HAPPENS HERE, NOT IN THE COMPONENT. A phone number that reaches the
 * browser has already leaked, whatever the component then does with it. So the
 * monitor scope masks on the way out of the database and the client is never
 * given the raw value to be careful with.
 */

/** Who is asking, and what they may see. */
export type ViewScope =
  | { kind: "archive"; userId: number; sources: ScopedSourceId[] }
  | { kind: "monitor"; userId: number; sources: ScopedSourceId[]; monitor: MonitorScope };

/**
 * What the screen may do — decided by the surface, never by the component.
 *
 * `media` is the interesting one and it came out of a real decision: the
 * supervisor sees that an attachment exists and may open it deliberately, but
 * photos do not simply appear in the transcript. Masking the phone number
 * while showing every picture the person sent would be a strange kind of
 * privacy, and "click" makes opening one an act rather than a side effect of
 * scrolling.
 */
export interface ViewCapabilities {
  media: "hidden" | "label" | "click" | "inline";
  masked: boolean;
  canStar: boolean;
  readMarkers: boolean;
  /** "Bu bayraq olmalıydı" — yalnız bayraqları nəzərdən keçirənlər üçün. */
  canReportFlag?: boolean;
}

export interface ViewChat {
  id: number;
  title: string;
  isGroup: boolean;
  firstTs: number;
  lastTs: number;
  messages: number;
  preview: string;
  /**
   * Son mesaj müştəridən gəlib — yəni cavab bizdədir.
   *
   * Ayrıca sorğu deyil: siyahı onsuz da son mesajın istiqamətini oxuyur
   * (preview "Biz: " ön şəkilçisi elə oradan gəlir). Oxunmamış sayğacından
   * fərqlidir — nəzarətçi hamısını oxuyandan sonra da cavab hələ bizdə qala
   * bilər, və siyahıda görünməli olan məhz odur.
   */
  awaiting: boolean;
  /**
   * SATICININ öz WhatsApp-ında oxunmamış qalan mesajların sayı.
   *
   * Bu, panelin öz oxunma izi DEYİL — telefonun özündəki nişandır
   * (evolution_api."Chat".unreadMessages, Baileys sinxronizasiyasından).
   * Nəzarətçi üçün ən vacib rəqəm budur: "cavab verilməyib" ilə "heç
   * açılmayıb da" arasındakı fərq müdaxilənin növünü dəyişir.
   */
  salesUnread: number;
  /**
   * BU İSTİFADƏÇİ (nəzarətçi) üçün oxunmamış mesajlar — panelin öz izi.
   *
   * Söhbət bu paneldə açılanda sıfırlanır, yeni mesaj gələndə yenidən artır.
   * WhatsApp-a heç bir təsiri yoxdur.
   */
  unread: number;
  sources: string[];
  /** Hansı instansların (satıcıların) söhbətidir — nəzarətdə süzgəc üçün. */
  instanceIds: string[];
  /** Bu istifadəçi söhbəti nə vaxt AÇIB oxuyub. null = heç vaxt. */
  openedAt: string | null;
  /** Neçə dəfə açıb. */
  openedCount: number;
}

export interface ViewMessage {
  id: number;
  ts: number;
  direction: "in" | "out";
  senderName: string | null;
  body: string | null;
  kind: string;
  /** null when there is no attachment; "absent" when the file did not survive. */
  media: "evolution" | "archive" | "absent" | null;
  mediaLabel: string | null;
  /**
   * Cavab verilən mesajın qısa təsviri — «kimə cavab» sualının cavabı.
   *
   * null olması iki şey deməkdir: ya bu mesaj cavab deyil, ya da sitat
   * gətirilən mesaj anbarda yoxdur (pəncərədən köhnədir).
   */
  reply: {
    sender: string | null;
    body: string | null;
    kind: string;
    direction: "in" | "out";
  } | null;
  voiceText: string | null;
  voiceStatus: string | null;
  starred: boolean;
}

export interface ViewFilters {
  direction?: "in" | "out";
  chatId?: number;
  from?: string;
  to?: string;
  kinds?: string[];
  chatType?: "individual" | "group";
  /** Yalnız bu instansın (satıcının) söhbətləri. */
  instanceId?: string;
  starredOnly?: boolean;
  voiceOnly?: boolean;
  unreadOnly?: boolean;
}

/* ─────────────────────────── query language ─────────────────────────── */

export interface QueryGroup {
  inc: string[];
  exc: string[];
}

/**
 * Parses the little search language: "exact phrase", OR, -excluded.
 *
 * Deliberately tiny, and deliberately not a parser for anything larger. The
 * people using this are looking for an order number or a customer's word, and
 * every operator beyond these three is one more thing to explain in a tooltip
 * nobody reads. OR splits into groups; everything else accumulates into the
 * group being built.
 */
export function parseQuery(q: string): QueryGroup[] {
  const re = /"([^"]*)"|(\S+)/g;
  const groups: QueryGroup[] = [{ inc: [], exc: [] }];
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const phrase = m[1];
    const word = m[2];
    if (word !== undefined && word.toUpperCase() === "OR") {
      groups.push({ inc: [], exc: [] });
      continue;
    }
    const s = phrase !== undefined ? phrase : word;
    if (!s) continue;
    // A minus only excludes when it is not inside quotes: "-5%" is a discount,
    // not an exclusion, and people write it constantly.
    if (phrase === undefined && s.startsWith("-")) {
      if (s.length > 1) groups[groups.length - 1].exc.push(s.slice(1));
      continue;
    }
    groups[groups.length - 1].inc.push(s);
  }
  return groups.filter((g) => g.inc.length > 0 || g.exc.length > 0);
}

/**
 * Turns parsed groups into one SQL predicate over a text column.
 *
 * ILIKE '%term%' rather than full-text search, for the same reason the exact
 * search on the live side settled there: an order number, a price and a
 * half-typed name are not words, and a stemmer does not help find them. The
 * trigram GIN index on katibe.message.body is what makes it fast.
 */
function queryPredicate(groups: QueryGroup[], col: string, params: unknown[]): string {
  const ors = groups.map((g) => {
    const parts: string[] = [];
    for (const t of g.inc) {
      params.push(`%${t}%`);
      parts.push(`${col} ILIKE $${params.length}`);
    }
    for (const t of g.exc) {
      params.push(`%${t}%`);
      parts.push(`${col} NOT ILIKE $${params.length}`);
    }
    return parts.length > 0 ? `(${parts.join(" AND ")})` : "TRUE";
  });
  return ors.length > 0 ? `(${ors.join(" OR ")})` : "TRUE";
}

/* ─────────────────────────── scope plumbing ─────────────────────────── */

interface Scoped {
  /** Predicate restricting to chats the caller may see. */
  where: string;
  params: unknown[];
}

/**
 * The scope, as SQL.
 *
 * Both kinds filter by source, which is what makes one archive invisible to
 * another person. The monitor kind adds the per-chat rules on top — hidden
 * groups, category rules, the profile — expressed against the chat's JIDs.
 * A chat is visible if ANY of its JIDs is, because a conversation that moved
 * from a phone number to a LID is still one conversation.
 */
function scopeSql(scope: ViewScope, chatExpr: string, params: unknown[]): Scoped {
  params.push(scope.sources);
  const src = `EXISTS (SELECT 1 FROM katibe.chat_source cs
                        WHERE cs.chat_id = ${chatExpr} AND cs.source_id = ANY($${params.length}::text[]))`;
  if (scope.kind === "archive") return { where: src, params };
  return { where: `${src} AND ${monitorChatSql(scope, chatExpr, params)}`, params };
}

/**
 * The monitor's per-chat rules, as SQL.
 *
 * A conversation is visible when ANY of its JIDs is: one that moved from a
 * phone number to a LID is still one conversation, and hiding it because the
 * newer identifier has no rule attached would lose it silently.
 */
function monitorChatSql(
  scope: Extract<ViewScope, { kind: "monitor" }>,
  chatExpr: string,
  params: unknown[],
): string {
  params.push(scope.monitor.monitorUserId);
  const userParam = `$${params.length}`;
  return `EXISTS (
      SELECT 1 FROM katibe.chat_jid cj
        LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = cj.remote_jid
        ${monitorVisibilityJoins("cj.remote_jid", userParam)}
       WHERE cj.chat_id = ${chatExpr}
         AND ${monitorVisibleSql("cj.remote_jid", scope.monitor.profile)})`;
}

/** Attachment kinds in words, for a preview line with no text in it. */
const KIND_WORD: Record<string, string> = {
  image: "🖼 Şəkil", video: "🎬 Video", audio: "🎧 Səsli mesaj",
  document: "📄 Sənəd", sticker: "🌟 Stiker", contact: "👤 Kontakt",
  location: "📍 Məkan",
};

/**
 * How far back this scope may read, as a unix timestamp.
 *
 * A monitor profile carries historyDays and it is a PERMISSION, not a display
 * preference: a supervisor granted thirty days must not be able to read 2017
 * by asking a different endpoint. The archive scope has no such bound, because
 * reading nine years is the entire point of it.
 */
function floorTs(scope: ViewScope): number | null {
  // The scope already carries it — recomputing from historyDays here would be
  // a second definition of the same rule, and the two would drift.
  return scope.kind === "archive" ? null : scope.monitor.windowStart;
}

/** Adds the window bound to a WHERE list, when the scope has one. */
function windowClause(scope: ViewScope, tsExpr: string, params: unknown[]): string {
  const floor = floorTs(scope);
  if (floor === null) return "TRUE";
  params.push(floor);
  return `${tsExpr} >= $${params.length}`;
}

/**
 * Masks anything that leaves the database for a masked surface.
 *
 * Uses the monitor's own format — "+994 50 *** ** 02" — rather than the
 * flag feed's "•••75". The difference matters in use: a reviewer has to tell
 * two customers apart and has to be able to say "the one ending 75" out loud
 * to a salesperson, and three dots and two digits do neither. Neither form is
 * dialable, so the harsher one bought nothing.
 *
 * AND IT IS A SETTING, NOT A CONSTANT. maskPhones lives on the monitor's
 * profile; an admin who turns it off means it off.
 */
function out(scope: ViewScope, text: string | null): string | null {
  if (text === null) return null;
  if (scope.kind !== "monitor" || !scope.monitor.profile.maskPhones) return text;
  return maskPhonesInText(text);
}

/** The same, for a title that may carry a name and a number together. */
function outName(scope: ViewScope, text: string | null): string | null {
  if (text === null) return null;
  if (scope.kind !== "monitor" || !scope.monitor.profile.maskPhones) return text;
  return maskDisplayName(text);
}

/**
 * The name to show for a conversation.
 *
 * katibe.chat.title is empty or a bare number for 2,350 of 5,615
 * conversations, which on screen reads as a wall of digits — and once masked,
 * as a wall of dots. So the label falls through the places a real name is
 * actually recorded: the contact list a human curated, then the group's own
 * subject, then what the person called themselves to the model, and only then
 * the raw key.
 */
const DISPLAY_NAME = `COALESCE(
  NULLIF(c.title, ''),
  (SELECT cl.display_name FROM katibe.chat_jid cj
     JOIN katibe.contact_labels cl ON cl.remote_jid = cj.remote_jid
    WHERE cj.chat_id = c.id AND COALESCE(cl.display_name, '') <> '' LIMIT 1),
  (SELECT gs.subject FROM katibe.chat_jid cj
     JOIN katibe.group_subject gs ON gs.remote_jid = cj.remote_jid
    WHERE cj.chat_id = c.id AND COALESCE(gs.subject, '') <> '' LIMIT 1),
  (SELECT ci.stated_name FROM katibe.chat_jid cj
     JOIN katibe.chat_identity ci ON ci.remote_jid = cj.remote_jid
    WHERE cj.chat_id = c.id AND COALESCE(ci.stated_name, '') <> '' LIMIT 1),
  c.person_key
)`;

/**
 * Mesaj mətnindəki «@12345…» teqlərini adla əvəz edir.
 *
 * WhatsApp teqi mətndə ID kimi saxlayır — qrupda «@92681652932789 i got all
 * confirmation» yazılır və ekranda da elə görünürdü, yəni oxuyan adam kimə
 * müraciət edildiyini bilmirdi. Halbuki həmin adam çox vaxt elə həmin qrupda
 * danışıb və adı anbardadır.
 *
 * Ad üç yerdən axtarılır: əl ilə verilmiş ad (contact_labels), söhbətdən
 * çıxarılmış ad (chat_identity), və nəhayət qrupda göndərən kimi görünən adı
 * (message.sender_name). Tapılmasa teq olduğu kimi qalır — uydurulmuş ad
 * ünvanı yazmaqdan pisdir.
 *
 * ƏVƏZLƏMƏ MASKALAMADAN ƏVVƏLDİR: nəzarətçinin ekranında ID onsuz da
 * maskalanacaqdı («@•••89»), ad isə həm oxunur, həm nömrə vermir.
 */
/**
 * Kim danışıb — söhbətin adı ilə EYNİ mənbədən.
 *
 * BİR AD, HƏR YERDƏ. Söhbətin başlığı əl ilə verilmiş adı oxuyurdu
 * (contact_labels → chat_identity), mesajın üstündəki ad isə WhatsApp-ın
 * pushName-ini — yəni eyni adam siyahıda «hae Leman Head Of HR», mesajın
 * üstündə «hae», bəzən də «994500000003» olurdu. Ekranda bu, iki fərqli adam
 * kimi oxunur.
 *
 * pushName tamamilə atılmır: qrupda yalnız orada danışmış, kontakt siyahısında
 * olmayan adam üçün başqa ad yoxdur. Amma o, SON çarədir, birinci deyil.
 */
interface SenderIdentity {
  /** Əl ilə verilmiş və ya yazışmadan çıxarılmış ad. */
  name: string | null;
  /** Ad heç yerdə yoxdursa qalan yeganə fakt. */
  phone: string | null;
}

async function resolveSenders(jids: (string | null)[]): Promise<Map<string, SenderIdentity>> {
  const want = [...new Set(jids.filter((j): j is string => Boolean(j)))];
  if (want.length === 0) return new Map();
  const { rows } = await pool.query<{ jid: string; name: string | null; phone: string | null }>(
    `SELECT w.jid,
            COALESCE(cl.display_name, ci.stated_name) AS name,
            COALESCE(ln.phone_number,
                     CASE WHEN w.jid LIKE '%@s.whatsapp.net'
                          THEN split_part(w.jid, '@', 1) END) AS phone
       FROM unnest($1::text[]) AS w(jid)
       LEFT JOIN katibe.contact_labels cl
              ON cl.remote_jid = w.jid AND COALESCE(cl.display_name, '') <> ''
       LEFT JOIN katibe.chat_identity ci
              ON ci.remote_jid = w.jid AND COALESCE(ci.stated_name, '') <> ''
       LEFT JOIN katibe.lid_number ln ON ln.lid_jid = w.jid`,
    [want],
  );
  return new Map(rows.map((r) => [r.jid, { name: r.name, phone: r.phone }]));
}

/**
 * Mesajın üstündəki ad — və nə vaxt ümumiyyətlə olmamalıdır.
 *
 * FƏRDİ SÖHBƏTDƏ AD YAZILMIR. Başlıq onsuz da kimin yazışması olduğunu deyir;
 * hər buludun üstündə onu təkrar etmək ən yaxşı halda səs-küydür, ən pis
 * halda — pushName başqa cür yazılıbsa — ekranda ikinci bir adam yaradır.
 * Qrupda isə əksinə: kimin danışdığı mənanın özüdür.
 */
function senderLabel(
  scope: ViewScope,
  isGroup: boolean,
  senderJid: string | null,
  pushName: string | null,
  names: Map<string, SenderIdentity>,
): string | null {
  if (!isGroup) return null;
  const id = senderJid ? names.get(senderJid) : undefined;
  /* Söhbətin başlığı ilə eyni pillələr: tanınan ad → özünü necə çağırdığı →
     nömrə. Heç biri yoxdursa sətir yazılmır — «@lid 39767…» kimsəni
     tanıtmır, sadəcə buludun üstünü doldurardı. */
  return out(scope, id?.name ?? pushName ?? id?.phone ?? null);
}

const MENTION_RE = /@(\d{6,})/g;

async function resolveMentions(
  texts: (string | null)[],
  chatId?: number,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(MENTION_RE)) ids.add(m[1]);
  }
  if (ids.size === 0) return new Map();

  /*
   * SÜRƏT BURADA ÖLÇÜLƏRƏ BAĞLIDIR.
   *
   * İlk variant hər teq üçün `katibe.message`-i sender_jid ilə axtarırdı və
   * indeks olmadığı üçün 1,6 milyon sətir taranırdı: 7 570 teqli bir söhbətdə
   * bir səhifə 13,7 SANİYƏ çəkirdi. İki dəyişiklik onu düzəltdi —
   * `message_sender_idx` (sender_jid, ts DESC) və axtarışın HƏMİN SÖHBƏTLƏ
   * məhdudlaşdırılması: qrupda teq edilən adam demək olar həmişə həmin qrupun
   * iştirakçısıdır.
   */
  /* Yuxarı hədd: bir səhifədə 20-dən çox fərqli teq varsa, ad axtarışı
     səhifənin özündən baha başa gəlir. Belə hal yalnız siyahıda mümkündür
     (60 fərqli söhbət) və orada teq onsuz da kəsilmiş önizləmədədir. */
  if (ids.size > 20) return new Map();

  const list = [...ids];
  const { rows } = await pool.query<{ id: string; name: string }>(
    `WITH want AS (SELECT unnest($1::text[]) AS id),
     jids AS (
       SELECT w.id, j.jid FROM want w
       CROSS JOIN LATERAL (VALUES (w.id || '@s.whatsapp.net'), (w.id || '@lid')) AS j(jid)
     )
     SELECT j.id,
            COALESCE(max(cl.display_name), max(ci.stated_name), max(sn.sender_name)) AS name
       FROM jids j
       LEFT JOIN katibe.contact_labels cl
              ON cl.remote_jid = j.jid AND COALESCE(cl.display_name, '') <> ''
       LEFT JOIN katibe.chat_identity ci
              ON ci.remote_jid = j.jid AND COALESCE(ci.stated_name, '') <> ''
       LEFT JOIN LATERAL (
         SELECT m.sender_name FROM katibe.message m
          WHERE m.sender_jid = j.jid
            AND m.sender_name IS NOT NULL
            AND ($2::bigint IS NULL OR m.chat_id = $2)
          ORDER BY m.ts DESC LIMIT 1
       ) sn ON TRUE
      GROUP BY j.id`,
    [list, chatId ?? null],
  );

  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.name && !out.has(r.id)) out.set(r.id, r.name);
  }
  return out;
}

/** Teqləri adla yazır; adı tapılmayan teq toxunulmadan qalır. */
function applyMentions(text: string | null, names: Map<string, string>): string | null {
  if (!text || names.size === 0) return text;
  return text.replace(MENTION_RE, (whole, id: string) => {
    const name = names.get(id);
    return name ? `@${name}` : whole;
  });
}

/**
 * Which eras a conversation spans, as far as this scope is concerned.
 *
 * A monitor reads Evolution only, so telling them a conversation also has nine
 * years behind it would put an "arxiv" badge on a thread whose history they
 * cannot open — a promise the screen does not keep.
 */
function eras(scope: ViewScope, kinds: string[] | null): string[] {
  const all = kinds ?? [];
  return scope.kind === "monitor" ? all.filter((k) => k !== "archive") : all;
}

/* ─────────────────────────── the three reads ─────────────────────────── */

/**
 * The conversation list.
 *
 * The unread count is ours and only ours: it counts incoming messages newer
 * than this user's own read marker. It never asks WhatsApp anything and never
 * tells WhatsApp anything — see sql/2026-08-31_read_and_star.sql.
 */
/**
 * Siyahının üst zolağındakı tab.
 *
 * Süzgəc SERVERDƏDİR, çünki siyahı səhifələnir: 60 sıra gətirib brauzerdə
 * süzmək "5 nəticə" göstərərdi, halbuki növbəti səhifədə daha 40-ı var.
 */
export type ChatTab = "all" | "awaiting" | "flagged";

/**
 * Bayraqlı söhbətlərin ID-ləri.
 *
 * Ayrıca sorğudur və bu qəsdəndir: açıq bayraq onlarladır, söhbət minlərlə.
 * Kiçik tərəfi əvvəlcə oxuyub ID siyahısı kimi ötürmək, hər sıra üçün
 * EXISTS yoxlamaqdan ölçülə bilən dərəcədə ucuzdur (33 ms).
 */
async function flaggedChatIds(scope: ViewScope): Promise<number[]> {
  const { rows } = await pool.query<{ chat_id: string }>(
    `SELECT DISTINCT j.chat_id
       FROM katibe.agent_posts p
       JOIN katibe.chat_jid j ON j.remote_jid = p.remote_jid
      WHERE p.acknowledged_at IS NULL AND p.severity >= 6
        AND p.instance_id = ANY($1::text[])`,
    [scope.sources],
  );
  return rows.map((r) => Number(r.chat_id));
}

export async function viewChats(
  scope: ViewScope,
  { search = "", limit = 40, offset = 0, instanceId, tab = "all" }:
    { search?: string; limit?: number; offset?: number; instanceId?: string; tab?: ChatTab } = {},
): Promise<{ chats: ViewChat[]; total: number }> {
  if (scope.sources.length === 0) return { chats: [], total: 0 };
  // $1 is the source list, consumed by the scoped CTE below.
  const params: unknown[] = [scope.sources];
  const extra =
    scope.kind === "monitor"
      ? `${monitorChatSql(scope, "c.id", params)} AND ${windowClause(scope, "c.last_ts", params)}`
      : "TRUE";

  /* Satıcıya görə süzgəc. Nəzarətçi bir neçə nömrəyə baxır və "indi kimin
     yazışmalarına baxıram" sualının cavabı ekranda olmalıdır — hamısını bir
     siyahıya tökmək onları bir-birindən ayırmağı imkansız edir. */
  /*
   * Nömrə seçimi sətrin İÇİNƏ də işləyir.
   *
   * Əvvəl seçim yalnız «hansı söhbətlər görünsün» sualına cavab verirdi;
   * sətirdəki önizləmə, son mesaj vaxtı, sıralama və oxunmamış sayğacı isə
   * söhbətin BÜTÜN mənbələri üzrə hesablanırdı. Nəticədə «Rouz-219» seçən adam
   * sətirdə principal-ın son mesajını oxuyurdu və seçim mənasız görünürdü.
   *
   * Vaxt və say `chat_source`-dan gəlir (denormalizasiya, refresh_chat_stats
   * saxlayır) — çünki sıralama səhifələmədən ƏVVƏL lazımdır və 982 söhbət üçün
   * 982 alt sorğu qiymətli olardı.
   */
  let laneFilter = "";
  let laneParam = "";
  if (instanceId) {
    params.push(instanceId);
    laneParam = `$${params.length}`;
    laneFilter = `AND EXISTS (SELECT 1 FROM katibe.chat_source cs2
                               WHERE cs2.chat_id = c.id AND cs2.source_id = ${laneParam})`;
  }

  /*
   * Tab süzgəci.
   *
   * «Cavabsız» son mesajın istiqamətinə baxır. Ölçüldü: sıralama indeksdən
   * gəldiyi üçün lateral yalnız lazım olan sıralarda işə düşür — səhifə 28 ms,
   * dəqiq say 33 ms. Denormalizasiya (chat.last_direction) da düşünüldü və
   * rədd edildi: onu təzə saxlayan yeganə funksiya heç yerdən çağırılmır, yəni
   * sütun səssizcə köhnələ bilərdi. Yavaş, amma doğru cavab — sürətli, amma
   * yalan cavabdan yaxşıdır.
   */
  let tabFilter = "";
  if (tab === "awaiting") {
    tabFilter = `AND (SELECT m.direction FROM katibe.message m
                       WHERE m.chat_id = c.id
                       ORDER BY m.ts DESC, m.id DESC LIMIT 1) = 'in'`;
  } else if (tab === "flagged") {
    params.push(await flaggedChatIds(scope));
    tabFilter = `AND c.id = ANY($${params.length}::bigint[])`;
  }

  let nameFilter = "";
  if (search.trim().length > 0) {
    params.push(`%${search.trim()}%`);
    nameFilter = `AND (${DISPLAY_NAME} ILIKE $${params.length}
                       OR EXISTS (SELECT 1 FROM katibe.chat_jid j
                                   WHERE j.chat_id = c.id AND j.remote_jid ILIKE $${params.length}))`;
  }

  params.push(scope.userId);
  const userParam = `$${params.length}`;
  params.push(limit);
  const limitParam = `$${params.length}`;
  params.push(offset);
  const offsetParam = `$${params.length}`;

  const { rows } = await pool.query(
    `WITH scoped AS (
       /* The visible set comes from chat_source first, not from a scan of
          katibe.chat. There are 5,298 conversations and the scope predicate
          had to be evaluated for every one of them to produce a total; going
          through chat_source_source_idx turns that into an index read. */
       SELECT DISTINCT cs.chat_id AS id FROM katibe.chat_source cs
        WHERE cs.source_id = ANY($1::text[])
     ), visible AS (
       SELECT c.id, ${DISPLAY_NAME} AS display, c.kind, c.first_ts,
              ${laneParam
                ? `COALESCE(lane.last_ts, c.last_ts) AS last_ts,
                   COALESCE(lane.messages, c.message_count) AS message_count`
                : `c.last_ts, c.message_count`}
         FROM scoped sd JOIN katibe.chat c ON c.id = sd.id
        ${laneParam
          ? `LEFT JOIN katibe.chat_source lane
                   ON lane.chat_id = c.id AND lane.source_id = ${laneParam}`
          : ""}
        WHERE ${extra} ${nameFilter} ${laneFilter} ${tabFilter}
     ), counted AS (SELECT count(*)::int AS total FROM visible),
     page AS (
       /* Narrow to the page BEFORE attaching anything per-row. The previous
          shape ran the last-message lateral for all 5,298 conversations and
          then threw away 5,258 of them, which was most of the query's time.
          Ordering first turns per-row work from 5,298 into 40. */
       SELECT * FROM visible ORDER BY last_ts DESC NULLS LAST
        LIMIT ${limitParam} OFFSET ${offsetParam}
     )
     SELECT v.*, (SELECT total FROM counted) AS total,
            (SELECT array_agg(DISTINCT s.kind) FROM katibe.chat_source cs
               JOIN katibe.source s ON s.id = cs.source_id
              WHERE cs.chat_id = v.id) AS source_kinds,
            (SELECT array_agg(cs.source_id) FROM katibe.chat_source cs
               JOIN katibe.source s ON s.id = cs.source_id AND s.kind = 'evolution'
              WHERE cs.chat_id = v.id) AS instance_ids,
            rm.opened_at, COALESCE(rm.opened_count, 0)::int AS opened_count,
            last.body AS preview, last.direction AS preview_dir, last.kind AS preview_kind,
            /* Unread = incoming messages newer than this user's own marker.
               A missing marker therefore counts everything, which is right for
               a conversation that started after the markers were seeded and
               would be very wrong for one that started in 2017 — which is
               exactly why the seed exists (sql/2026-08-31_read_and_star.sql).
               Without it this column read "6,871 unread" on a chat somebody
               reads every day. */
            (SELECT count(*) FROM katibe.message m
              WHERE m.chat_id = v.id AND m.direction = 'in'
                AND m.ts > COALESCE(rm.last_read_ts, 0)
                ${laneParam
                  ? `AND EXISTS (SELECT 1 FROM katibe.message_source msu
                                  WHERE msu.message_id = m.id
                                    AND msu.source_id = ${laneParam})`
                  : ""})::int AS unread,
            /* Satıcının telefonundakı oxunmamış nişanı. Səhifədən SONRA
               hesablanır (40-60 sıra), və yalnız bu istifadəçinin gördüyü
               nömrələr üzrə: başqa satıcının nişanı onun işidir. */
            (SELECT COALESCE(sum(ec."unreadMessages"), 0)::int
               FROM katibe.chat_jid j
               JOIN evolution_api."Chat" ec ON ec."remoteJid" = j.remote_jid
              WHERE j.chat_id = v.id
                AND ${laneParam ? `ec."instanceId" = ${laneParam}` : `ec."instanceId" = ANY($1)`}
             ) AS sales_unread
       FROM page v
       LEFT JOIN katibe.read_marker rm ON rm.chat_id = v.id AND rm.user_id = ${userParam}
       /* Önizləmə seçilmiş nömrənin son mesajıdır: sətir «bu nömrədə axırıncı
          nə deyildi» sualına cavab verməlidir, «hansısa nömrədə» yox. */
       LEFT JOIN LATERAL (
         SELECT m.body, m.direction, m.kind FROM katibe.message m
          WHERE m.chat_id = v.id
            ${laneParam
              ? `AND EXISTS (SELECT 1 FROM katibe.message_source msp
                              WHERE msp.message_id = m.id
                                AND msp.source_id = ${laneParam})`
              : ""}
          ORDER BY m.ts DESC, m.id DESC LIMIT 1
       ) last ON TRUE
      ORDER BY v.last_ts DESC NULLS LAST`,
    params,
  );

  /* Önizləmə də teqləri adla göstərir — sətir «Biz: @158085398163537» kimi
     oxunanda kimə yazıldığı bilinmir. Söhbətlə məhdudlaşdırıla bilmir (60
     fərqli söhbət), ona görə axtarış qlobaldır; `message_sender_idx` onu
     ucuz saxlayır. */
  const previewMentions = await resolveMentions(rows.map((r) => r.preview as string | null));

  const chats: ViewChat[] = rows.map((r) => ({
    id: Number(r.id),
    title: outName(scope, r.display as string | null) ?? "—",
    isGroup: r.kind === "group",
    firstTs: Number(r.first_ts ?? 0),
    lastTs: Number(r.last_ts ?? 0),
    messages: Number(r.message_count ?? 0),
    preview:
      (r.preview_dir === "out" ? "Biz: " : "") +
      ((out(scope, applyMentions((r.preview as string | null) ?? "", previewMentions)) ?? "")
        .slice(0, 160) ||
        KIND_WORD[r.preview_kind as string] ||
        ""),
    awaiting: r.preview_dir === "in",
    salesUnread: Number(r.sales_unread ?? 0),
    unread: Number(r.unread ?? 0),
    sources: eras(scope, r.source_kinds as string[] | null),
    instanceIds: (r.instance_ids as string[] | null) ?? [],
    openedAt: r.opened_at ? new Date(r.opened_at as string).toISOString() : null,
    openedCount: Number(r.opened_count ?? 0),
  }));
  return { chats, total: rows.length > 0 ? Number(rows[0].total) : 0 };
}

/**
 * One conversation, newest `limit` messages, oldest first on the way out.
 *
 * The whole point of this screen is that it does not distinguish eras: a 2018
 * message out of a phone backup and one that arrived this morning through
 * Evolution sit in the same thread, in order. Where a message came from is a
 * badge on the header, never a division in the transcript.
 *
 * `around` PƏNCƏRƏNİ SONDAN QOPARIR.
 *
 * Axtarış nəticəsinə basan adam söhbəti yox, HƏMİN mesajı istəyir. Pəncərə
 * həmişə sonuncu mesajlarla bitdiyi üçün 2019-cu ilin tapıntısı yüklənən
 * səhifədə ümumiyyətlə olmurdu: ekran açılırdı, mesaj isə min sətir aşağıda
 * qalırdı və heç yerə tullanmaq mümkün deyildi. `around` verilirsə pəncərə o
 * mesajın ətrafında qurulur — ondan geri `limit`, irəli `ahead` mesaj — və
 * hər iki tərəfin davamı olub-olmadığı ayrıca qaytarılır.
 */
export async function viewMessages(
  scope: ViewScope,
  chatId: number,
  { limit = 80, ahead = 0, around, instanceId }: {
    limit?: number;
    /** Lövbərdən SONRAKI neçə mesaj oxunsun. Yalnız `around` ilə mənalıdır. */
    ahead?: number;
    /** Pəncərənin mərkəzindəki mesajın id-si. */
    around?: number;
    instanceId?: string;
  } = {},
): Promise<{
  chat: ViewChat;
  messages: ViewMessage[];
  more: boolean;
  /** Pəncərədən SONRA da mesaj var — yalnız lövbərli oxunuşda mümkündür. */
  moreNewer: boolean;
  /** Lövbər tapıldı və pəncərə onun ətrafındadır. */
  anchored: boolean;
} | null> {
  const { chats } = await viewChatById(scope, chatId);
  if (!chats) return null;

  /* Lövbər əhatənin İÇİNDƏ axtarılır: başqa söhbətin (və ya nəzarətçiyə
     bağlı olmayan bir yazışmanın) mesaj id-si sadəcə tapılmır və oxunuş
     adi qaydada, sondan davam edir. */
  const anchor = around === undefined ? null : await anchorAt(scope, chatId, around, instanceId);

  const read = (bound: MessageBound | null, n: number) =>
    messageRows(scope, chatId, { limit: n + 1, instanceId, bound });

  let more: boolean;
  let moreNewer: boolean;
  let page: Record<string, unknown>[];

  if (anchor) {
    /* İki sorğu, bir pəncərə: lövbərdən geri (onu da daxil edərək) və
       lövbərdən irəli. Tək sorğuda bunu yalnız UNION ilə etmək olardı və
       hər iki tərəfin "davamı varmı" sualı orada itərdi. */
    const [older, newer] = await Promise.all([
      read({ ...anchor, dir: "older" }, limit),
      read({ ...anchor, dir: "newer" }, ahead),
    ]);
    more = older.length > limit;
    moreNewer = newer.length > ahead;
    page = [
      ...(more ? older.slice(0, limit) : older).reverse(),
      ...(moreNewer ? newer.slice(0, ahead) : newer),
    ];
  } else {
    const rows = await read(null, limit);
    more = rows.length > limit;
    moreNewer = false;
    page = (more ? rows.slice(0, limit) : rows).reverse();
  }

  /* Teqlər bir sorğu ilə həll olunur — sətir-sətir yox: bir səhifədə eyni
     adam onlarla dəfə teq oluna bilər. */
  const mentions = await resolveMentions(
    page.flatMap((r) => [r.body as string | null, r.reply_body as string | null]),
    chatId,
  );
  /* Adlar da bir sorğu ilə: qrupda bir səhifədə on nəfər danışa bilər. */
  const senders = await resolveSenders(page.map((r) => r.sender_jid as string | null));
  const isGroup = chats.isGroup;

  return {
    chat: chats,
    more,
    moreNewer,
    anchored: anchor !== null,
    messages: page.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      direction: r.direction as "in" | "out",
      senderName: senderLabel(
        scope, isGroup, r.sender_jid as string | null, r.sender_name as string | null, senders),
      body: out(scope, applyMentions(r.body as string | null, mentions)),
      kind: r.kind as string,
      media: (r.media as ViewMessage["media"]) ?? null,
      // The object key is a bucket path and never leaves the server; the label
      // is only its last segment, which is what a person recognises.
      mediaLabel: (r.object_key as string | null)?.split("/").pop() ?? null,
      voiceText: out(scope, r.voice_text as string | null),
      voiceStatus: (r.voice_status as string | null) ?? null,
      starred: Boolean(r.starred),
      reply:
        r.reply_kind === null || r.reply_kind === undefined
          ? null
          : {
              sender: out(scope, r.reply_sender as string | null),
              body: out(scope, applyMentions(r.reply_body as string | null, mentions)),
              kind: r.reply_kind as string,
              direction: r.reply_direction as "in" | "out",
            },
    })),
  };
}

/** Pəncərənin kəsildiyi yer: bu mesajdan geri, ya da bu mesajdan irəli. */
interface MessageBound {
  ts: number;
  id: number;
  /** `older` lövbəri DAXİL edir, `newer` etmir — mesaj iki dəfə düşməsin. */
  dir: "older" | "newer";
}

/**
 * Lövbər mesajın yeri — əhatə, pəncərə və nömrə süzgəci ilə birlikdə.
 *
 * Yalnız id ilə kifayətlənmək olmazdı: sıralama `(ts, id)` cütünədir, çünki
 * eyni saniyədə gələn mesajların ardıcıllığı yalnız id ilə müəyyəndir.
 */
async function anchorAt(
  scope: ViewScope,
  chatId: number,
  messageId: number,
  instanceId?: string,
): Promise<{ ts: number; id: number } | null> {
  const params: unknown[] = [];
  const sc = scopeSql(scope, "m.chat_id", params);
  params.push(chatId);
  const chatParam = `$${params.length}`;
  params.push(messageId);
  const idParam = `$${params.length}`;
  const msgWindow = windowClause(scope, "m.ts", params);
  const laneFilter = laneSql(instanceId, params);

  const { rows } = await pool.query(
    `SELECT m.id, m.ts FROM katibe.message m
      WHERE m.id = ${idParam} AND m.chat_id = ${chatParam}
        AND ${sc.where} AND ${msgWindow} ${laneFilter}
      LIMIT 1`,
    params,
  );
  return rows.length === 0 ? null : { ts: Number(rows[0].ts), id: Number(rows[0].id) };
}

/**
 * Seçilmiş nömrə yazışmanın İÇİNƏ də tətbiq olunur.
 *
 * Anbar bir adamın yazışmasını nömrələr arasında birləşdirir — eyni müştəri
 * dörd satıcıya yazıbsa, o bir söhbətdir. Amma yan paneldə «principal» seçən
 * adam principal-ın yazışmasını oxumaq istəyir; əvvəl süzgəc yalnız SİYAHINI
 * daraldırdı və açılan yazışmada başqa nömrələrin mesajları da görünürdü
 * («Marcel SC»-də principal-ın 37 mesajı var, qalan 331-i başqa nömrələrdən).
 * Nəticədə ekran süzgəci saymırmış kimi oxunurdu.
 */
function laneSql(instanceId: string | undefined, params: unknown[]): string {
  if (!instanceId) return "";
  params.push(instanceId);
  return `AND EXISTS (SELECT 1 FROM katibe.message_source msl
                       WHERE msl.message_id = m.id
                         AND msl.source_id = $${params.length})`;
}

/**
 * Yazışmanın bir parçası, xam sətirlər halında.
 *
 * Sıra HƏMİŞƏ sorğunun öz istiqamətindədir: `older` və lövbərsiz oxunuş
 * yenidən-köhnəyə gəlir (çağıran tərəf çevirir), `newer` isə onsuz da
 * köhnədən-yeniyə. Bir sorğu üç yerdən çağırılır, ona görə proyeksiya bir
 * dəfə yazılır: sütun əlavə edəndə üç yeri unutmaq mümkün olmasın.
 */
async function messageRows(
  scope: ViewScope,
  chatId: number,
  { limit, instanceId, bound }: {
    limit: number;
    instanceId?: string;
    bound: MessageBound | null;
  },
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [];
  const sc = scopeSql(scope, "m.chat_id", params);
  params.push(chatId);
  const chatParam = `$${params.length}`;
  params.push(scope.userId);
  const userParam = `$${params.length}`;
  const msgWindow = windowClause(scope, "m.ts", params);
  const laneFilter = laneSql(instanceId, params);

  let boundFilter = "";
  let order = "DESC";
  if (bound) {
    params.push(bound.ts);
    const tsParam = `$${params.length}`;
    params.push(bound.id);
    const idParam = `$${params.length}`;
    if (bound.dir === "older") {
      boundFilter = `AND (m.ts, m.id) <= (${tsParam}::bigint, ${idParam}::bigint)`;
    } else {
      boundFilter = `AND (m.ts, m.id) > (${tsParam}::bigint, ${idParam}::bigint)`;
      order = "ASC";
    }
  }

  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await pool.query(
    `SELECT m.id, m.ts, m.direction, m.sender_name, m.sender_jid, m.body, m.kind,
            md.storage AS media, md.object_key,
            vt.text AS voice_text, vt.status AS voice_status,
            (st.message_id IS NOT NULL) AS starred,
            rp.sender_name AS reply_sender, rp.body AS reply_body,
            rp.kind AS reply_kind, rp.direction AS reply_direction
       FROM katibe.message m
       LEFT JOIN katibe.media md ON md.message_id = m.id
       LEFT JOIN katibe.starred_message st
              ON st.message_id = m.id AND st.user_id = ${userParam}
       /* One row per message, whatever its provenance.
          A message merged from both the phone backup and Evolution has TWO
          message_source rows, so joining that table directly returned the
          message twice — visible in the transcript as a repeated line. The
          lateral takes at most one transcript and cannot multiply. */
       LEFT JOIN LATERAL (
         SELECT vt.text, vt.status
           FROM katibe.message_source ms
           JOIN katibe.voice_transcript vt ON vt.message_id = ms.external_id
          WHERE ms.message_id = m.id
          LIMIT 1
       ) vt ON TRUE
       /* Cavab verilən mesaj — eyni söhbətdə, stanza ID ilə.
          Tapılmaya da bilər: sitat gətirilən mesaj pəncərədən köhnə ola bilər
          və ya heç köçürülməyib. O halda sətir boş qalır, çünki «kimə cavab»
          sualına yalan cavab verməkdənsə cavab verməmək yaxşıdır. */
       LEFT JOIN LATERAL (
         SELECT q.sender_name, q.body, q.kind, q.direction
           FROM katibe.message q
          WHERE m.reply_to IS NOT NULL
            AND q.chat_id = m.chat_id
            AND q.stanza_id = m.reply_to
          LIMIT 1
       ) rp ON TRUE
      WHERE m.chat_id = ${chatParam} AND ${sc.where} AND ${msgWindow} ${laneFilter} ${boundFilter}
      ORDER BY m.ts ${order}, m.id ${order}
      LIMIT ${limitParam}`,
    params,
  );
  return rows;
}

/** One conversation's header row, scoped — used to 404 before reading it. */
async function viewChatById(scope: ViewScope, chatId: number): Promise<{ chats: ViewChat | null }> {
  const params: unknown[] = [];
  const sc = scopeSql(scope, "c.id", params);
  params.push(chatId);
  const { rows } = await pool.query(
    `SELECT c.id, ${DISPLAY_NAME} AS display, c.kind, c.first_ts, c.last_ts, c.message_count,
            (SELECT array_agg(DISTINCT s.kind) FROM katibe.chat_source cs
               JOIN katibe.source s ON s.id = cs.source_id WHERE cs.chat_id = c.id) AS source_kinds,
            (SELECT array_agg(cs.source_id) FROM katibe.chat_source cs
               JOIN katibe.source s ON s.id = cs.source_id AND s.kind = 'evolution'
              WHERE cs.chat_id = c.id) AS instance_ids
       FROM katibe.chat c
      WHERE c.id = $${params.length} AND ${sc.where}`,
    params,
  );
  if (rows.length === 0) return { chats: null };
  const r = rows[0];
  return {
    chats: {
      id: Number(r.id),
      title: outName(scope, r.display as string | null) ?? "—",
      isGroup: r.kind === "group",
      firstTs: Number(r.first_ts ?? 0),
      lastTs: Number(r.last_ts ?? 0),
      messages: Number(r.message_count ?? 0),
      preview: "",
      awaiting: false,
      salesUnread: 0,
      unread: 0,
      sources: eras(scope, r.source_kinds as string[] | null),
      instanceIds: (r.instance_ids as string[] | null) ?? [],
      openedAt: null,
      openedCount: 0,
    },
  };
}

export interface ViewHit extends ViewMessage {
  chatId: number;
  chatTitle: string;
  isGroup: boolean;
}

/**
 * Search across every conversation in scope.
 *
 * Filters apply whether or not there is a query text: "every voice message
 * from March" is a legitimate question and needs no words in it.
 */
export async function viewSearch(
  scope: ViewScope,
  { query = "", filters = {}, limit = 60 }:
    { query?: string; filters?: ViewFilters; limit?: number } = {},
): Promise<{ hits: ViewHit[]; chats: number }> {
  if (scope.sources.length === 0) return { hits: [], chats: 0 };
  const groups = parseQuery(query.trim());
  const anyFilter =
    filters.direction !== undefined || filters.chatId !== undefined ||
    filters.from !== undefined || filters.to !== undefined ||
    (filters.kinds?.length ?? 0) > 0 || filters.chatType !== undefined ||
    filters.starredOnly === true || filters.voiceOnly === true || filters.unreadOnly === true;
  if (groups.length === 0 && !anyFilter) return { hits: [], chats: 0 };

  const params: unknown[] = [];
  const sc = scopeSql(scope, "m.chat_id", params);
  const where: string[] = [sc.where, windowClause(scope, "m.ts", params)];

  if (groups.length > 0) {
    // The attachment's filename is searchable alongside the text: people look
    // for "delivery-note", and that string exists nowhere else.
    where.push(queryPredicate(groups, "COALESCE(m.body,'') || ' ' || COALESCE(md.object_key,'')", params));
  }
  if (filters.direction) {
    params.push(filters.direction);
    where.push(`m.direction = $${params.length}`);
  }
  if (filters.chatId !== undefined) {
    params.push(filters.chatId);
    where.push(`m.chat_id = $${params.length}`);
  }
  if (filters.from) {
    params.push(Math.floor(new Date(`${filters.from}T00:00:00Z`).getTime() / 1000));
    where.push(`m.ts >= $${params.length}`);
  }
  if (filters.to) {
    params.push(Math.floor(new Date(`${filters.to}T23:59:59Z`).getTime() / 1000));
    where.push(`m.ts <= $${params.length}`);
  }
  if (filters.kinds && filters.kinds.length > 0) {
    params.push(filters.kinds);
    where.push(`m.kind = ANY($${params.length}::text[])`);
  }
  if (filters.chatType) {
    params.push(filters.chatType);
    where.push(`EXISTS (SELECT 1 FROM katibe.chat c WHERE c.id = m.chat_id AND c.kind = $${params.length})`);
  }
  if (filters.instanceId) {
    params.push(filters.instanceId);
    where.push(`EXISTS (SELECT 1 FROM katibe.chat_source cs2
                         WHERE cs2.chat_id = m.chat_id AND cs2.source_id = $${params.length})`);
  }
  if (filters.voiceOnly) where.push(`m.kind = 'audio'`);
  if (filters.starredOnly) where.push(`st.message_id IS NOT NULL`);
  if (filters.unreadOnly) {
    where.push(`m.direction = 'in' AND m.ts > COALESCE(rm.last_read_ts, 0)`);
  }

  params.push(scope.userId);
  const userParam = `$${params.length}`;
  params.push(limit);
  const limitParam = `$${params.length}`;

  const { rows } = await pool.query(
    `SELECT m.id, m.chat_id, m.ts, m.direction, m.sender_name, m.sender_jid, m.body, m.kind,
            md.storage AS media, md.object_key,
            vt.text AS voice_text, vt.status AS voice_status,
            (st.message_id IS NOT NULL) AS starred,
            ${DISPLAY_NAME} AS chat_title, c.kind AS chat_kind
       FROM katibe.message m
       JOIN katibe.chat c ON c.id = m.chat_id
       LEFT JOIN katibe.media md ON md.message_id = m.id
       LEFT JOIN katibe.starred_message st
              ON st.message_id = m.id AND st.user_id = ${userParam}
       LEFT JOIN katibe.read_marker rm ON rm.chat_id = m.chat_id AND rm.user_id = ${userParam}
       /* One row per message, whatever its provenance.
          A message merged from both the phone backup and Evolution has TWO
          message_source rows, so joining that table directly returned the
          message twice — visible in the transcript as a repeated line. The
          lateral takes at most one transcript and cannot multiply. */
       LEFT JOIN LATERAL (
         SELECT vt.text, vt.status
           FROM katibe.message_source ms
           JOIN katibe.voice_transcript vt ON vt.message_id = ms.external_id
          WHERE ms.message_id = m.id
          LIMIT 1
       ) vt ON TRUE
      WHERE ${where.join(" AND ")}
      ORDER BY m.ts DESC
      LIMIT ${limitParam}`,
    params,
  );

  const searchSenders = await resolveSenders(rows.map((r) => r.sender_jid as string | null));

  const hits: ViewHit[] = rows.map((r) => ({
    id: Number(r.id),
    chatId: Number(r.chat_id),
    chatTitle: outName(scope, r.chat_title as string) ?? "—",
    isGroup: r.chat_kind === "group",
    ts: Number(r.ts),
    direction: r.direction as "in" | "out",
    /* Fərdi söhbətdə burada null qayıdır və sıra söhbətin ADINI göstərir —
       ekranda «hae» ilə «hae Leman Head Of HR» iki fərqli adam kimi
       oxunmasın deyə (chat-view.ts:senderLabel). */
    senderName: senderLabel(
      scope, r.chat_kind === "group", r.sender_jid as string | null,
      r.sender_name as string | null, searchSenders),
    body: out(scope, r.body as string | null),
    kind: r.kind as string,
    media: (r.media as ViewMessage["media"]) ?? null,
    mediaLabel: (r.object_key as string | null)?.split("/").pop() ?? null,
    voiceText: out(scope, r.voice_text as string | null),
    voiceStatus: (r.voice_status as string | null) ?? null,
    starred: Boolean(r.starred),
    /* Axtarış sətri tək başına durur: nəticə siyahısında sitat blokları
       nəticələri bir-birindən ayırmağı çətinləşdirərdi. Kontekst mesaja
       keçəndə görünür. */
    reply: null,
  }));
  return { hits, chats: new Set(hits.map((h) => h.chatId)).size };
}

/* ─────────────────────────── the two writes ─────────────────────────── */

/**
 * Moves this user's read marker forward.
 *
 * FORWARD ONLY. Scrolling back through 2019 must not undo what has been read,
 * and a plain assignment would do exactly that the moment the client sends the
 * timestamp it happens to be looking at.
 *
 * Nothing here touches WhatsApp — no read receipt, no presence, nothing the
 * other side can observe. See the table comment for why that is the point.
 */
export async function markRead(scope: ViewScope, chatId: number, ts: number): Promise<void> {
  const params: unknown[] = [];
  const sc = scopeSql(scope, "c.id", params);
  params.push(chatId);
  const chatParam = `$${params.length}`;
  params.push(scope.userId);
  const userParam = `$${params.length}`;
  params.push(ts);
  const tsParam = `$${params.length}`;
  await pool.query(
    `INSERT INTO katibe.read_marker (user_id, chat_id, last_read_ts, opened_at, opened_count)
     SELECT ${userParam}, c.id, ${tsParam}, now(), 1 FROM katibe.chat c
      WHERE c.id = ${chatParam} AND ${sc.where}
     ON CONFLICT (user_id, chat_id) DO UPDATE
       SET last_read_ts = GREATEST(katibe.read_marker.last_read_ts, EXCLUDED.last_read_ts),
           updated_at = now(),
           /* İlk açılış vaxtı saxlanılır, sonrakılar onu əvəz etmir:
              "nə vaxt baxdı" sualının cavabı ilk baxışdır. */
           opened_at = COALESCE(katibe.read_marker.opened_at, now()),
           opened_count = katibe.read_marker.opened_count + 1`,
    params,
  );
}

/** Stars or unstars one message, for this user only. */
export async function setStarred(
  scope: ViewScope,
  messageId: number,
  on: boolean,
): Promise<boolean> {
  const params: unknown[] = [];
  const sc = scopeSql(scope, "m.chat_id", params);
  params.push(messageId);
  const msgParam = `$${params.length}`;
  params.push(scope.userId);
  const userParam = `$${params.length}`;

  if (!on) {
    await pool.query(
      `DELETE FROM katibe.starred_message WHERE message_id = ${msgParam} AND user_id = ${userParam}`,
      params,
    );
    return false;
  }
  // The scope check rides along in the INSERT rather than running before it:
  // one statement, so there is no window in which the answer could change.
  const { rowCount } = await pool.query(
    `INSERT INTO katibe.starred_message (user_id, message_id)
     SELECT ${userParam}, m.id FROM katibe.message m
      WHERE m.id = ${msgParam} AND ${sc.where} AND ${windowClause(scope, "m.ts", params)}
     ON CONFLICT DO NOTHING`,
    params,
  );
  return (rowCount ?? 0) > 0;
}
