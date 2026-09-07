import type { ReactNode } from "react";
import Icon from "./Icon";
import { Badge, ReadOnlyLock } from "./index";
import s from "./ui.module.css";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number;
  badgeTone?: "brand" | "critical" | "serious" | "info";
}

/**
 * The one navigation.
 *
 * Before this, getting between screens meant a row of buttons in each page's
 * header, every one of them drawn from the same class as the logout button —
 * so "where am I" and "get me out" looked identical. Here the role decides
 * which sections exist; it is one frame in several configurations rather than
 * three navigations.
 *
 * The read-only note sits at the bottom and is not decoration: it is the
 * product's central promise, and the place people look when they wonder
 * whether opening a chat did something on the phone.
 *
 * Brend, hesab və tema BURADA DEYİL: onlar qlobal başlıqdadır (AppHeader),
 * çünki sidebar-ı olmayan ekranlar da var və eyni sualın cavabı hər ekranda
 * eyni yerdə olmalıdır.
 */
export default function Sidebar({
  sections, activeHref, extra,
}: {
  sections: { label?: string; items: NavItem[] }[];
  activeHref: string;
  /**
   * Naviqasiyanın altındakı əlavə blok — nəzarətdə nömrə siyahısı.
   *
   * Slot kimi verilir, çünki onun məzmunu ekrandan asılıdır: arxivdə nömrə
   * anlayışı yoxdur. Sidebar-ın özü nə göstərəcəyini bilməməlidir.
   */
  extra?: ReactNode;
}) {
  return (
    <nav className={s.nav}>
      <div className={s.navBody}>
        {sections.map((sec, i) => (
          <div className={s.navSection} key={sec.label ?? i}>
            {sec.label && <div className={s.navLabel}>{sec.label}</div>}
            {sec.items.map((it) => (
              /* Nişan rəqəmi ekran oxuyucusuna çılpaq say kimi getməməlidir:
                 "4" heç nə demir, "Bayraqlar, 4 açıq" isə linkin nə vəd
                 etdiyini deyir. */
              <a key={it.href} href={it.href} className={s.navItem}
                aria-label={it.badge ? `${it.label}, ${it.badge} açıq` : undefined}
                aria-current={it.href === activeHref ? "page" : undefined}>
                <Icon name={it.icon} size={15} />
                <span className={s.navItemText}>{it.label}</span>
                {it.badge !== undefined && it.badge > 0 && (
                  <Badge tone={it.badgeTone ?? "faint"} variant="soft" size="xs">{it.badge}</Badge>
                )}
              </a>
            ))}
          </div>
        ))}
        {extra}
      </div>
      <ReadOnlyLock />
    </nav>
  );
}
