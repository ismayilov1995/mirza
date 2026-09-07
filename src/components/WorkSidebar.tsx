import type { ReactNode } from "react";
import { countOpenFlags } from "@/lib/supervisor/feed";
import { myInstances, requireSession } from "@/lib/access";
import { Sidebar } from "@/components/ui";

/**
 * İş ekranlarının ortaq naviqasiyası.
 *
 * Üç səhifə eyni bölmələri istəyir (Nömrələr, Söhbətlər, Nəzarətçi) və əvvəl hər
 * biri onları öz başlığında ayrıca sıralayırdı — üç yerdə, üç fərqli sırada,
 * biri emoji ilə. Nəticədə "harada olduğumu" bildirən element ilə "məni
 * çıxart" düyməsi eyni sinifdən idi.
 *
 * Bölmələr rola görə dəyişir, lakin qərar BURADA verilir: səhifə "mən admin
 * miyəm" sualını verməməlidir, çünki o sualı hər səhifədə vermək onu bir yerdə
 * unutmaq deməkdir.
 */
export default async function WorkSidebar({
  activeHref, extra,
}: {
  activeHref: string;
  /** Naviqasiyanın altındakı əlavə blok — arxivdə mənbə siyahısı. */
  extra?: ReactNode;
}) {
  const session = await requireSession();
  /* Bayraq sayı hər üç ekranın naviqasiyasındadır: yığılmanı görmək üçün
     lentə keçmək lazım olmamalıdır. */
  const openFlags = await countOpenFlags(await myInstances());

  return (
    <Sidebar
      activeHref={activeHref}
      extra={extra}
      sections={[
        {
          label: "İş",
          items: [
            { href: "/", label: "Nömrələr", icon: "layout-dashboard" },
            { href: "/arxiv", label: "Söhbətlər", icon: "inbox" },
            /* Fayllar söhbətlərin ALTINDADIR, çünki eyni arxivin ikinci
               baxışıdır: yazışma zamana görə, qalereya isə fayla görə. */
            { href: "/fayllar", label: "Fayllar", icon: "images" },
            {
              href: "/agent",
              label: "Nəzarətçi",
              icon: "radar",
              badge: openFlags,
              badgeTone: "critical" as const,
            },
          ],
        },
        {
          label: "Hesab",
          items: [
            { href: "/settings/mcp", label: "Ayarlar", icon: "settings" },
            ...(session.role === "admin"
              ? [{ href: "/admin", label: "Admin", icon: "shield-check" }]
              : []),
            { href: "/api/logout", label: "Çıxış", icon: "log-out" },
          ],
        },
      ]}
    />
  );
}
