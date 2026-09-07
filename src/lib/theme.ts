/*
 * Tema: tünd, işıqlı, və ya sistemin dediyi.
 *
 * İKİ AYRI ANLAYIŞ. Saxlanılan SEÇİM üç haldadır (dark/light/system); DOM-dakı
 * data-theme isə həmişə ikidən biridir. Səbəb odur ki, "sistem" bir palitra
 * deyil, palitranı seçən qaydadır — onu brauzerdə həll edib nəticəni yazmaq
 * CSS-də işıqlı palitranı iki dəfə (bir dəfə seçim üçün, bir dəfə media
 * sorğusu üçün) yazmaqdan qısa və səhvsizdir.
 *
 * SEÇİM COOKIE-DƏDİR, localStorage-də yox. Server ilk HTML-i göndərəndə hansı
 * temanı yazacağını bilməlidir; localStorage yalnız brauzerdə oxunur, yəni
 * səhifə əvvəl yanlış temada boyanıb sonra düzələrdi. Bir anlıq ağ ekran
 * gecə işləyən adam üçün kiçik məsələ deyil.
 */

export type ThemePref = "dark" | "light" | "system";
export type Theme = "dark" | "light";

export const THEME_COOKIE = "katibe_theme";

export function isThemePref(v: unknown): v is ThemePref {
  return v === "dark" || v === "light" || v === "system";
}

/**
 * The theme to paint before the browser has said anything.
 *
 * "system" resolves to dark here because the panel has always been dark and a
 * stored preference of "system" must not change what somebody sees between the
 * server's paint and the script's. The inline script corrects it in the same
 * frame when the OS actually prefers light.
 */
export function serverTheme(pref: ThemePref | undefined): Theme {
  return pref === "light" ? "light" : "dark";
}

/**
 * Runs before the first paint, inlined into <head>.
 *
 * Kept as a string on purpose: a component cannot do this, because anything
 * React renders happens after the document has already been painted once.
 */
export const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var m = document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);
    var pref = m ? decodeURIComponent(m[1]) : "dark";
    if (pref === "system") {
      document.documentElement.dataset.theme =
        window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
  } catch (e) {}
})();
`.trim();
