/**
 * Human-readable duration in Azerbaijani.
 *
 * Steps up through seconds, minutes, hours and days, because these values
 * span everything from a 20-second reply to a message left waiting for a
 * week — "168 saat" reads far worse than "7 gün".
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds} san`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} dəq`;

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours} saat` : `${hours} saat ${restMinutes} dəq`;

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} gün` : `${days} gün ${restHours} saat`;
}

/**
 * What a message without text is, in one chip-sized phrase — for chat lists,
 * where the preview line has to say something.
 *
 * The transcript on the chat page keeps its own wording ("🎙️ səsli mesaj"):
 * there the label sits inside a sentence, here it stands alone.
 */
const MEDIA_LABELS: Record<string, string> = {
  imageMessage: "🖼️ Şəkil",
  videoMessage: "🎬 Video",
  audioMessage: "🎧 Səs",
  documentMessage: "📄 Sənəd",
  stickerMessage: "🌟 Stiker",
  locationMessage: "📍 Məkan",
  contactMessage: "👤 Kontakt",
  albumMessage: "🖼️ Albom",
  ptvMessage: "🎬 Video mesaj",
};

export function mediaLabel(messageType: string): string {
  return MEDIA_LABELS[messageType] ?? "📎 Fayl";
}

/**
 * Bağlantı vəziyyətinin sözlə qarşılığı.
 *
 * Xam dəyər ("open", "connecting", "close") ekranda qalmır, amma yanında
 * saxlanır: nasazlıq axtaran adam Evolution-un öz sözünü görməlidir, «qoşulu
 * deyil» ilə «heç vaxt qoşulmayıb» eyni şey deyil.
 */
export function instanceStatusWord(status: string): string {
  if (status === "open") return "qoşulu";
  if (status === "connecting") return "qoşulmağa çalışır";
  return "qoşulu deyil";
}

/**
 * Fayl ölçüsü: B → KB → MB → GB.
 *
 * Kəsr yalnız 10 MB-a qədər göstərilir — "3.4 MB" fərqi izah edir, "247.3 MB"
 * isə üç rəqəmi oxunmaz edir. Ölçü qalereyada sütun kimi düzülür, ona görə
 * mətnin eni sabit qalmalıdır.
 */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}
