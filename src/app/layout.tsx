import type { Metadata } from "next";
import { cookies } from "next/headers";
import { isThemePref, serverTheme, THEME_BOOT_SCRIPT, THEME_COOKIE } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Katibe",
  description: "WhatsApp söhbət statistikaları",
};

/*
 * Tema HTML-in kökündə, ilk boyanışdan əvvəl.
 *
 * Cookie oxunur və data-theme serverdə yazılır — yəni səhifə heç vaxt yanlış
 * temada boyanıb sonra düzəlmir. "Sistem" seçimi serverdə bilinmir (onu yalnız
 * brauzer bilir), ona görə server tündlə başlayır və <head>-dəki kiçik skript
 * eyni kadrda düzəldir.
 *
 * cookies() oxunması bütün səhifələri dinamik edir. Burada bunun qiyməti
 * yoxdur: hər səhifədə onsuz da sessiya yoxlanılır, yəni statik render olunan
 * səhifə heç vaxt olmayıb.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const store = await cookies();
  const raw = store.get(THEME_COOKIE)?.value;
  const theme = serverTheme(isThemePref(raw) ? raw : undefined);

  return (
    <html lang="az" data-theme={theme}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
