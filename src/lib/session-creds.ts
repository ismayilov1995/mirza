/**
 * WhatsApp sessiya kredensialının qoşulmuş olub-olmadığını deyir.
 *
 * Bu bir sətirlik sual bütün sessiya qorumasının oxudur: Evolution "sessiya
 * yoxdur" ilə "sessiyanı oxuya bilmədim" arasında fərq qoymur və ikinci halda
 * işləyən sessiyanı təzə, qoşulmamış açarla əvəz edir. Fərqi biz burada
 * qoyuruq — nüsxə yalnız qoşulmuş kredensialdan götürülür, bərpa da yalnız
 * ona yazılır.
 *
 * Ayrı fayldadır ki, həm nüsxə, həm bərpa skripti onu ortaq işlətsin: əvvəl
 * biri o birindən import edirdi və import özü nüsxə gedişatını işə salırdı.
 */

/** creds iki qat JSON-dur (Baileys BufferJSON + Evolution JSON.stringify). */
export function isPaired(credsRaw: string): boolean {
  try {
    let v: unknown = credsRaw;
    for (let i = 0; i < 3 && typeof v === "string"; i++) v = JSON.parse(v);
    if (!v || typeof v !== "object") return false;
    const o = v as Record<string, unknown>;
    // Üçü də olmalıdır. me tək başına kifayət deyil: qoşulma yarımçıq
    // qalanda me görünə, account/signalIdentities isə hələ olmaya bilər.
    return Boolean(o.me) && Boolean(o.account) && Boolean(o.signalIdentities);
  } catch {
    // Parse alınmırsa ETİBARSIZ sayılır. "Şübhədə saxla" burada səhv olardı:
    // oxunmayanı nüsxə saymaq onu bərpa edilə bilən sanmaq deməkdir.
    return false;
  }
}
