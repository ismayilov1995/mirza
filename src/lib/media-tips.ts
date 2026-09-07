/*
 * Fayl tiplərinin adları — bazasız.
 *
 * Ayrı fayldır, çünki bunları HƏM server sorğusu (media-library.ts), HƏM də
 * qalereyanın client komponenti oxuyur. media-library.ts-dən götürsəydi,
 * `pool` ilə birlikdə bütün baza qatı brauzer bundle-ına düşərdi — tip
 * ixracları silinir, dəyər ixracları isə silinmir.
 */

/** URL-də yaşayan süzgəc dəyərləri — diakritikasız, çünki link paylaşılır. */
export type MediaTip = "hamisi" | "sekil" | "video" | "ses" | "sened" | "stiker";

export const MEDIA_TIPS: MediaTip[] = ["hamisi", "sekil", "video", "ses", "sened", "stiker"];

/** Ekranda görünən ad — rəqəmin yanındakı söz (docs/rules.md §4). */
export const TIP_LABEL: Record<MediaTip, string> = {
  hamisi: "Hamısı",
  sekil: "Şəkil",
  video: "Video",
  ses: "Səs",
  sened: "Sənəd",
  stiker: "Stiker",
};

export const TIP_ICON: Record<MediaTip, string> = {
  hamisi: "inbox",
  sekil: "image",
  video: "video",
  ses: "mic",
  sened: "file-text",
  stiker: "star",
};

/*
 * katibe.message.kind 20 fərqli dəyər daşıyır, amma media sətri olanların 99.7
 * %-i beş dəyərdədir. Qalanı ("other", "templateMessage", "location", …) heç
 * bir çipə düşmür və yalnız "Hamısı"da görünür: onlara ayrıca ad vermək altı
 * çipi on beşə çıxarardı və heç kim "listResponseMessage" süzgəcini açmır.
 */
export const TIP_KINDS: Record<Exclude<MediaTip, "hamisi">, string[]> = {
  sekil: ["image"],
  video: ["video"],
  ses: ["audio"],
  sened: ["document"],
  stiker: ["sticker"],
};

/** Hansı çipə düşür — heç birinə düşmürsə null ("Hamısı"da görünür). */
export function tipOf(kind: string): Exclude<MediaTip, "hamisi"> | null {
  for (const tip of Object.keys(TIP_KINDS) as Exclude<MediaTip, "hamisi">[]) {
    if (TIP_KINDS[tip].includes(kind)) return tip;
  }
  return null;
}

/** Kartın üstündəki söz: tanınan tipin adı, tanınmayan üçün sadəcə «Fayl». */
export function tipWord(kind: string): string {
  const tip = tipOf(kind);
  return tip ? TIP_LABEL[tip] : "Fayl";
}
