/*
 * Vaxt damğası: HH:MM DD.MM.YYYY, həmişə Bakı vaxtı ilə.
 *
 * Hissələr formatToParts ilə götürülür və sətir əl ilə yığılır. Lokal həm
 * sıranı, həm ayırıcını özü seçir; burada isə forma sabit olmalıdır, çünki bu
 * ekranda vaxtlar sütun boyu müqayisə edilir və eni dəyişən damğa bunu pozur.
 *
 * Bakı vaxtı serverin yox, işin vaxtıdır: eyni yazışmaya Bakıdan və Dubaydan
 * baxan iki nəfər eyni saatı görməlidir.
 */
const partsFmt = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Asia/Baku",
});

function parts(ts: number): Record<string, string> {
  return Object.fromEntries(
    partsFmt.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]),
  ) as Record<string, string>;
}

/** HH:MM, or HH:MM DD.MM.YYYY when the day matters. */
export function stamp(ts: number, withDay = false): string {
  const p = parts(ts);
  const time = `${p.hour}:${p.minute}`;
  return withDay ? `${time} ${p.day}.${p.month}.${p.year}` : time;
}

/** DD.MM.YYYY — the day divider, and the key that decides where one goes. */
export function dayKey(ts: number): string {
  const p = parts(ts);
  return `${p.day}.${p.month}.${p.year}`;
}
