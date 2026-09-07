/**
 * Hiding phone numbers from people who do not need them.
 *
 * The supervisor reviews flags to judge whether the agent was right, and that
 * judgement never requires a customer's number. But it does require telling
 * two conversations apart, so the last two digits stay — enough to say "not
 * the same person as the one above", not enough to call anyone.
 *
 * Applied at RENDER, not at read: the number is still in the database, still
 * in the transcript for the people who work the account, and still what the
 * detectors join on. This masks a screen, and it should not be mistaken for
 * the number being withheld from the system.
 */

/**
 * Runs of digits long enough to be a phone number.
 *
 * Seven, because six-digit runs in this archive are order numbers (1008882)
 * and masking those would hide the thing a reviewer most needs to read.
 * Separators are allowed inside so "+994 50 123 45 67" is caught as one.
 */
const PHONE_RUN = /(\+?\d[\d\s().-]{5,}\d)/g;

/** Digits only, to decide whether a match is really long enough. */
function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

export function maskPhones(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(PHONE_RUN, (m) => {
    const d = digitsOf(m);
    if (d.length < 7) return m; // order number, amount, date — leave it alone
    return `•••${d.slice(-2)}`;
  });
}

/** A JID reduced to the same masked form — for titles that carry one. */
export function maskJid(jid: string): string {
  const local = jid.split("@")[0];
  const d = digitsOf(local);
  return d.length >= 7 ? `•••${d.slice(-2)}` : local;
}
