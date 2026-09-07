/**
 * «Zakazi Dubai Showroom» qrupundakı sifariş mesajlarını cədvəl sətrinə çevirir.
 *
 * Niyə saf funksiya: burada bir dənə də sorğu, fayl və ya şəbəkə yoxdur — girişi
 * mesajın mətni, çıxışı sətirdir. Qaydalar real mesajlara qarşı yoxlanılıb
 * (2026-09-07, 02–06 sentyabr dövrü) və o yoxlamanı təkrarlamağın yeganə ucuz
 * yolu parseri I/O-dan ayrı saxlamaqdır.
 *
 * ÜÇ QAYDA GÖZLƏ GÖRÜNMÜR, AMMA HƏR İKİNCİ SƏTRİ SƏHV EDƏ BİLƏR:
 *
 *   1. Amount «Стоимость» ifadəsindəki bütün rəqəmlərin CƏMİDİR, «Оплатила» yox.
 *      Noor Al Dosari: `Стоимость:26500+3000` → 29500, halbuki Оплатила 20700 idi
 *      (qalan 8800 borc). Оплатила götürsək qismən ödənişli hər sifariş azalır.
 *
 *   2. Sifarişin tarixi mesajın UTC tarixidir, Dubay vaxtı yox. Gecə 02:55 Dubay
 *      (= 22:55 UTC) sifarişi cədvəldə əvvəlki günə yazılıb; UTC bunu özü tutur.
 *
 *   3. Köhnə mesajlarda tarix sahələri `Реальная дата` / `Дата сдачи`, yenilərdə
 *      `Event`. İkisini də tanımasaq 100-dən çox sətir tarixsiz qalır.
 */

export const SHEET_COLS = [
  "Date of order", "Order", "Name", "Urgency", "Amount", "Debt", "Shipped",
  "From", "Deadline", "Real Date", "Phone Number", "Collection", "Size",
  "By", "Paid",
] as const;

export type SheetCol = (typeof SHEET_COLS)[number];

export type ZakaziRow = Record<SheetCol, string> & {
  /** Sifariş, yoxsa xidmət/doplata sətri — yoxlayarkən süzgəc üçün. */
  kind: "sifariş" | "xidmət";
  /** Mesajın orijinal vaxtı (UTC) — şübhəli sətri mesajla tutuşdurmaq üçün. */
  msgTime: string;
  /** Mesajın epoch saniyəsi — təkrar göndərişi tutmaq üçün. */
  ts: number;
  /** Parserin özünün qeydi (məs. təkrar göndəriş birləşdirilib). */
  note: string;
  /** «Наименование» sahəsinin toxunulmamış mətni. */
  rawItem: string;
  /** «Стоимость» sahəsinin toxunulmamış mətni. */
  rawPrice: string;
};

/**
 * Açar sözlər. SIRA ƏHƏMİYYƏTLİDİR: `метод оплаты` `оплат…`-dan əvvəl gəlməlidir,
 * yoxsa ödəniş üsulu ödənilmiş məbləğ kimi oxunar.
 */
const KEYS: [string, string][] = [
  ["header", String.raw`[hн]ов(?:ый|ая)\s+(?:заказ|продажа)`],
  ["service", String.raw`fitting\s*charge|alteration|аlteration|delivery|dhl|label|additional|доплата`],
  ["realdate", String.raw`реальн(?:ая|ой)\s+дат[аы]`],
  ["deadline", String.raw`дата\s+сдачи|срок\s+сдачи`],
  ["name", String.raw`им[ея]`],
  ["item", String.raw`наименование`],
  ["price", String.raw`стоимость`],
  ["method", String.raw`метод\s+оплаты`],
  ["paid", String.raw`оплат(?:ила|ил|а|или|ено)`],
  ["balance", String.raw`остаток`],
  ["event", String.raw`event|ивент`],
  ["phone", String.raw`тел(?:ефон)?|tel|phone`],
  ["size", String.raw`размер|size`],
  ["seller", String.raw`продавец|seller`],
  ["measure", String.raw`по\s+меркам`],
  ["showroom", String.raw`sold\s+from\s+showroom|из\s+шоурума`],
];

/**
 * Açar sözdən əvvəl hərf olmamalıdır.
 *
 * Sıfır enli baxış lazımdır, sadə `[\s\n]` yox: «Новый заказ \nИмя:…» sətrində
 * başlığın ardındakı `\s*` yeni sətri udur və növbəti axtarış «Имя»-nı sətir
 * başı saymır — nəticədə ad, satıcı və mənbə sahələri sükutla itir.
 */
const KEY_RE = new RegExp(
  String.raw`(?<![А-Яа-яЁёA-Za-z])(` +
    KEYS.map(([n, p]) => `(?<${n}>${p})`).join("|") +
    String.raw`)\s*:?\s*`,
  "gi",
);

const MONEY = /\d[\d\s.,]*/g;

type Fields = Partial<Record<string, string>>;

function splitFields(text: string): { fields: Fields; kind: string | null } {
  const hits: { field: string; start: number; end: number }[] = [];
  KEY_RE.lastIndex = 0;
  for (const m of text.matchAll(KEY_RE)) {
    const groups = m.groups ?? {};
    const field = Object.keys(groups).find((k) => groups[k] !== undefined);
    if (!field) continue;
    hits.push({ field, start: m.index! + m[0].length - m[0].trimStart().length, end: m.index! + m[0].length });
  }
  const fields: Fields = {};
  hits.forEach((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : text.length;
    if (fields[h.field] === undefined) {
      fields[h.field] = text.slice(h.end, end).replace(/^[\s,.;:]+|[\s,.;:]+$/g, "");
    }
  });
  return { fields, kind: hits.length ? hits[0].field : null };
}

/** '26500+3000, color' → [26500, 3000]; 'aed', tarix parçaları düşür. */
function nums(expr: string | undefined): { v: number; start: number; end: number }[] {
  if (!expr) return [];
  const out: { v: number; start: number; end: number }[] = [];
  MONEY.lastIndex = 0;
  for (const m of expr.matchAll(MONEY)) {
    let raw = m[0].replace(/[\s,]/g, "").replace(/\.$/, "");
    if (raw.includes(".")) raw = raw.split(".")[0];
    if (/^\d{1,7}$/.test(raw)) out.push({ v: Number(raw), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

function parsePrice(expr: string | undefined): { total: number; urgency: string } {
  const vals = nums(expr);
  const total = vals.reduce((a, b) => a + b.v, 0);
  let urgency = "";
  if (expr) {
    for (const { v, start, end } of vals) {
      const around = (expr.slice(Math.max(0, start - 12), start) + expr.slice(end, end + 12)).toLowerCase();
      if (around.includes("urgent") || around.includes("срочн")) urgency = String(v);
    }
  }
  return { total, urgency };
}

/** '25.09.26' / '1.10.26 in Qatar' → '25.09.2026'. */
function parseDate(val: string | undefined): string {
  if (!val) return "";
  const m = val.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (!m) return "";
  const [, dd, mm, yyRaw] = m;
  const yy = Number(yyRaw) < 100 ? Number(yyRaw) + 2000 : Number(yyRaw);
  const d = new Date(Date.UTC(yy, Number(mm) - 1, Number(dd)));
  if (d.getUTCMonth() !== Number(mm) - 1 || d.getUTCDate() !== Number(dd)) return "";
  return `${dd.padStart(2, "0")}.${mm.padStart(2, "0")}.${yy}`;
}

/** `+`, boşluq və baş sıfır atılır — cədvəldəki forma budur. */
function parsePhone(val: string | undefined): string {
  if (!val) return "-";
  const digits = val.split("\n")[0].replace(/\D/g, "").replace(/^0+/, "");
  return digits || "-";
}

const COLOR_NUM = /color\s*(?:number\s*)?[#-]?\s*([a-z]?-?\d+)/i;
const SIZE_NUM = /\bsize\s*[#-]?\s*(\d+)/i;
const UK_SIZE = /\b(\d{1,2})\s*uk\b/i;
const PLAIN_COLORS = ["black", "white", "pink", "beige", "gold", "blue", "green", "red",
  "purple", "maroon", "burgundy", "silver", "nude", "grey", "gray"];

/** «Наименование» → (Collection, Size). Kod SS/CFW/RC + rəqəm, qalanı ölçü/rəngdir. */
function parseItem(val: string | undefined): { coll: string; size: string } {
  if (!val) return { coll: "", size: "" };
  const v = val.trim();
  const m = v.match(/^([A-Za-z]{1,5}\s*\d{3,5}[A-Za-z]?)/);
  const coll = m ? m[1].replace(/\s+/g, "").toUpperCase() : (v.split(/\s+/)[0] ?? "").toUpperCase();
  const rest = (m ? v.slice(m[0].length) : "").replace(/^[\s,()/-]+|[\s,()/-]+$/g, "");
  let size = "";
  const c = rest.match(COLOR_NUM);
  const u = rest.match(UK_SIZE);
  const s = rest.match(SIZE_NUM);
  if (c) size = "Color " + c[1].toUpperCase().replace("-", "");
  else if (u) size = u[1] + "UK";
  else if (s) size = "Size " + s[1];
  else {
    const low = rest.toLowerCase();
    const hit = PLAIN_COLORS.find((col) => new RegExp(`\\b${col}\\b`).test(low));
    if (hit) size = hit[0].toUpperCase() + hit.slice(1);
  }
  return { coll, size };
}

const SERVICE_MAP: [RegExp, string][] = [
  [/fitting/, "Fitting"],
  [/[aа]lteration/, "Alteration"],
  [/dhl|delivery/, "DHL"],
  [/label/, "Label"],
  [/доплата|additional/, "Extra"],
];

function serviceKind(text: string): string {
  const head = text.trim().split("\n")[0].toLowerCase();
  return SERVICE_MAP.find(([re]) => re.test(head))?.[1] ?? "Service";
}

/**
 * Bir mesajı sətrə çevirir; sifariş mesajı deyilsə `null`.
 *
 * @param tsSeconds mesajın epoch saniyəsi
 * @param orderNo   cədvəldəki sifariş nömrəsi (D + ilin son rəqəmi + ay + sıra)
 */
export function parseOrderMessage(text: string, tsSeconds: number, orderNo: string): ZakaziRow | null {
  const { fields, kind } = splitFields(text);
  if ((kind !== "header" && kind !== "service") || !fields.name) return null;
  const isService = kind === "service";

  const dt = new Date(tsSeconds * 1000);
  const d2 = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${d2(dt.getUTCDate())}.${d2(dt.getUTCMonth() + 1)}.${dt.getUTCFullYear()}`;

  const { total: priceTotal, urgency } = parsePrice(fields.price);
  const paid = nums(fields.paid).reduce((a, b) => a + b.v, 0);
  const balanceVals = nums(fields.balance);

  let amount = priceTotal;
  let debt = balanceVals.length
    ? balanceVals.reduce((a, b) => a + b.v, 0)
    : Math.max(priceTotal - paid, 0);

  let { coll, size } = parseItem(fields.item);
  if (!size && fields.size) size = fields.size.trim();

  let from: string;
  if (isService) {
    coll = serviceKind(text);
    size = "";
    from = "Service";
    if (!amount) {
      amount = paid;
      debt = 0;
    }
  } else {
    from = "showroom" in fields ? "Showroom" : "measure" in fields ? "Po merkam" : "";
  }

  return {
    "Date of order": dateStr,
    "Order": orderNo,
    "Name": fields.name.replace(/\s+/g, " ").trim(),
    "Urgency": urgency,
    "Amount": amount ? String(amount) : "",
    "Debt": String(debt),
    "Shipped": "",
    "From": from,
    "Deadline": parseDate(fields.deadline),
    "Real Date": parseDate(fields.realdate ?? fields.event),
    "Phone Number": parsePhone(fields.phone),
    "Collection": coll,
    "Size": size,
    "By": (fields.seller ?? "-").trim() || "-",
    "Paid": String(paid),
    kind: isService ? "xidmət" : "sifariş",
    msgTime: `${dateStr} ${d2(dt.getUTCHours())}:${d2(dt.getUTCMinutes())}`,
    ts: tsSeconds,
    note: "",
    rawItem: (fields.item ?? "").trim(),
    rawPrice: (fields.price ?? "").trim(),
  };
}

/**
 * Səhv göndərilib yenidən yazılmış sifarişləri birləşdirir.
 *
 * NİYƏ LAZIMDIR: satıcı sifarişi natamam və ya səhv göndərəndə onu silmir —
 * düzəldib TƏZƏDƏN göndərir. Evolution-un cədvəlində köhnə variant qalmır,
 * `katibe.message` arxivində isə hər ikisi durur. Sentyabrın ilk həftəsində
 * belə üç cüt var; birləşdirməsək hər düzəliş cədvəldə dublikat sətrə çevrilir.
 *
 * AÇARDA MƏBLƏĞ YOXDUR, ÇÜNKİ DÜZƏLİŞ ÇOX VAXT MƏHZ MƏBLƏĞİ DÜZƏLDİR.
 * Eman Mohammed Alhammadi: 04.09 19:22-də `Стоимость:4700 +500`, 23:31-də eyni
 * paltar üçün `Стоимость:5200 +500`. Məbləği açara qoysaq bu cüt ayrı-ayrı iki
 * sifariş kimi düşər — yəni dedupe məhz ən çox lazım olan halda işləməz.
 * Sabit qalan telefon + kolleksiyadır. Kolleksiya birinci mesajda düşübsə
 * (Sheikha Al Nowaini-də «Наименование» sətri yox idi) telefon + məbləğə,
 * telefon da yoxdursa ad + kolleksiyaya baxılır.
 *
 * TARİX BİRİNCİ GÖNDƏRİŞDƏN GÖTÜRÜLÜR, QALAN HƏR ŞEY SONUNCUDAN. Sheikha-nın
 * düzəlişi ertəsi gün səhər 05:04-də gəlib, cədvəldə isə sətir 02.09-dadır —
 * yəni sifariş ilk yazılan gündə sayılır, düzəliş onu gələcəyə sürüşdürmür.
 * Sonuncu variantın qiyməti və adı isə doğru olandır.
 *
 * SƏTİR SÜKUTLA İTMİR: birləşmə `note`-a yazılır və yoxlama sütununda görünür.
 */
export function dedupeReposts(rows: ZakaziRow[], windowSec = 86_400): ZakaziRow[] {
  const seen = new Map<string, number>();
  const out: ZakaziRow[] = [];

  const keysOf = (r: ZakaziRow): string[] => {
    const phone = r["Phone Number"];
    if (phone !== "-") {
      const ks = [`p:${phone}|amt:${r.Amount}`];
      if (r.Collection) ks.unshift(`p:${phone}|c:${r.Collection}`);
      return ks;
    }
    const name = r.Name.toLowerCase().replace(/[^a-zəöüçşğı]/g, "").slice(0, 8);
    return [`n:${name}|${r.Collection || r.Amount}`];
  };

  for (const row of [...rows].sort((a, b) => a.ts - b.ts)) {
    const keys = keysOf(row);
    const hit = keys.map((k) => seen.get(k)).find((i) => i !== undefined);
    if (hit !== undefined && row.ts - out[hit].ts <= windowSec) {
      const first = out[hit];
      out[hit] = {
        ...row,
        "Date of order": first["Date of order"],
        ts: first.ts,
        note: `${first.msgTime}-də göndərilmiş variantın düzəlişi ilə birləşdirildi`,
      };
      for (const k of keysOf(out[hit])) seen.set(k, hit);
      continue;
    }
    for (const k of keys) seen.set(k, out.length);
    out.push(row);
  }
  return out;
}

/** Dedupe-dan SONRA nömrələyir ki, cədvəldə boşluq qalmasın. */
export function assignOrderNumbers(rows: ZakaziRow[], startSeq: number): ZakaziRow[] {
  return rows.map((r, i) => ({ ...r, Order: orderNumber(r.ts, startSeq + i + 1) }));
}

/** Sifariş nömrəsi: D + ilin son rəqəmi + ay + aylıq sıra (D609033). */
export function orderNumber(tsSeconds: number, seq: number): string {
  const dt = new Date(tsSeconds * 1000);
  return `D${dt.getUTCFullYear() % 10}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(seq).padStart(3, "0")}`;
}

/**
 * Əl ilə baxılmalı sətirlər.
 *
 * Boş sahə səhv demək deyil — Showroom satışında Event olmur, xidmət sətrində
 * satıcı olmur. Ona görə yalnız həmin növ üçün DOĞRUDAN gözlənilən sahələr
 * yoxlanılır, yoxsa siyahı hər gün onlarla yalan siqnalla dolar və baxılmaz.
 */
export function reviewNotes(r: ZakaziRow): string[] {
  const n: string[] = [];
  if (r.note) n.push(r.note);
  if (!r.Amount) n.push("məbləğ yoxdur");
  if (!r.Collection) n.push("kolleksiya yoxdur");
  if (r.kind === "sifariş") {
    if (r["Phone Number"] === "-") n.push("telefon yoxdur");
    if (r.By === "-") n.push("satıcı yoxdur");
    if (!r.From) n.push("po merkam/showroom yazılmayıb");
    if (!r["Real Date"] && r.From !== "Showroom") n.push("Event tarixi yoxdur");
  }
  return n;
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(rows: ZakaziRow[], withReviewCols = false): string {
  const cols: string[] = [...SHEET_COLS];
  if (withReviewCols) cols.push("_növ", "_mesaj vaxtı", "_Наименование", "_Стоимость", "_baxılsın");
  const line = (cells: string[]) => cells.map(csvCell).join(",");
  const body = rows.map((r) => {
    const cells = SHEET_COLS.map((c) => r[c]);
    if (withReviewCols) {
      cells.push(r.kind, r.msgTime, r.rawItem, r.rawPrice, reviewNotes(r).join("; "));
    }
    return line(cells);
  });
  return [line(cols), ...body].join("\n") + "\n";
}
