import Link from "next/link";
import { getSession, myInstances, mySources, type Role } from "@/lib/access";
import { viewChats } from "@/lib/chat-view";
import ThemeToggle from "@/components/ThemeToggle";
import { Icon, Input, ReadOnlyLock } from "@/components/ui";
import s from "@/components/ui/ui.module.css";

/**
 * Panelin qlobal başlığı — bütün ekranların üstündə, eyni yerdə.
 *
 * NİYƏ BİR DƏNƏDİR. Əvvəl ekranın kimliyi üç yerə səpələnmişdi: brend
 * sidebar-ın başında, tema onun altında, «yalnız oxu» səhifə başlığında,
 * çıxış isə köhnə ekranlarda naviqasiya linkləri ilə eyni sinifdə idi. Yəni
 * «hansı hesabla, hansı rejimdəyəm?» sualı ekrandan ekrana başqa yerdə cavab
 * alırdı — və köhnə ekranlarda heç almırdı.
 *
 * SERVER KOMPONENTİDİR və özü oxuyur: sessiya, cavabsız yazışmaların cəmi,
 * axtarışın hədəfi. Səhifə ona yalnız hansı bölmədə olduğunu deyir. Səbəb
 * WorkSidebar-dakı ilə eynidir — «mən kiməm» sualını hər səhifədə vermək onu
 * bir səhifədə unutmaq deməkdir.
 */

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  viewer: "İstifadəçi",
  monitor: "Nəzarətçi",
};

/** «zemfira.sc» → «ZE», «sebine n» → «SN». */
function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default async function AppHeader({
  section,
  align = "sidebar",
  searchInstanceId,
}: {
  /** Brendin yanındakı bölmə adı: «Nəzarət», «Arxiv», «Admin». */
  section: string;
  /**
   * Sol sütunun eni. `sidebar` — naviqasiyası olan ekranlar (brend sidebar-ın
   * üstündə oturur); `page` — köhnə, sidebar-sız ekranlar.
   *
   * Çıxış da bundan asılıdır: sidebar-ı olan ekranda «Çıxış» naviqasiyanın
   * «Hesab» bölməsindədir, sidebar-sız ekranda isə heç yerdə olmazdı — orada
   * hesab nişanının özü çıxış linkidir.
   */
  align?: "sidebar" | "page";
  /** Axtarışın hədəfi — /i/<id> ekranlarında həmin nömrə. */
  searchInstanceId?: string;
}) {
  /*
   * getSession(), requireSession() YOX.
   *
   * requireSession() rol marşrutlaşdırması edir: nəzarətçini hər yerdən
   * /monitor-a YÖNLƏNDİRİR. Başlıq /monitor səhifəsinin özündə də durur, yəni
   * o çağırış səhifəni öz-özünə göndərirdi — nəzarətçi hesabı ilə açanda
   * ERR_TOO_MANY_REDIRECTS. (Admin hesabında görünmürdü, çünki yönləndirmə
   * yalnız monitor rolu üçündür.)
   *
   * Başlıq qapı deyil, göstəricidir: icazəni səhifənin öz ilk sətri verir
   * (requireMonitorScope / requireSession / requireAdmin). Sessiya yoxdursa
   * burada heç nə çəkilmir — yönləndirməni yenə səhifə edir.
   */
  const session = await getSession();
  if (!session) return null;

  /*
   * Cavabsız yazışmaların cəmi və ən yenisi.
   *
   * Nəzarətçi rolu üçün oxunmur: onun əhatəsi ayrıca qurulur (önizləmə rejimi
   * də daxil) və başlıq həmin qurğunu təxmin etməməlidir. Nəzarətçinin öz
   * ekranında bu say onsuz da nömrə-üzrə sidebar-dadır.
   */
  let newCount = 0;
  let newHref: string | null = null;
  let searchHref: string | null = null;

  if (session.role !== "monitor") {
    const sources = await mySources();
    if (sources.length > 0) {
      const { total, chats } = await viewChats(
        { kind: "archive", userId: session.userId, sources },
        { tab: "awaiting", limit: 1 },
      );
      newCount = total;
      // Siyahı ən yenidən sıralanır, ona görə birinci sıra «ən yeni cavabsız».
      if (chats.length > 0) newHref = `/arxiv?chat=${chats[0].id}`;
    }

    const target = searchInstanceId ?? (await myInstances())[0];
    if (target) searchHref = `/i/${encodeURIComponent(target)}/search`;
  }

  const name = session.username;
  const role = ROLE_LABEL[session.role];

  const user = (
    <>
      <span className={s.userAvatar} aria-hidden>{initials(name)}</span>
      <span className={s.userLines}>
        <span className={s.userName}>{name}</span>
        <span className={s.userRole}>{role}</span>
      </span>
    </>
  );

  return (
    <header className={s.appHeader} data-align={align}>
      <Link className={s.appBrand} href="/" title="Başlanğıc səhifə">
        <span className={s.brandMark} aria-hidden>K</span>
        <span className={s.brandText}>
          <span className={s.brandName}>Katibe</span>
          <span className={s.brandSection}>{section}</span>
        </span>
      </Link>

      <div className={s.headerSearch}>
        {searchHref && (
          /* Sadə GET forması: nəticə ekranı serverdədir və URL-də yaşayır,
             yəni axtarış linki göndərilə bilir və geri düyməsi işləyir. */
          <form action={searchHref} method="get" style={{ flex: 1, minWidth: 0 }} role="search">
            <Input
              size="sm"
              icon="search"
              type="search"
              name="q"
              placeholder="Yazışmalarda axtar…"
              aria-label="Yazışmalarda axtar"
            />
          </form>
        )}
      </div>

      <div className={s.headerRight}>
        {newCount > 0 && newHref && (
          <a className={s.newPill} href={newHref} title="Ən yeni cavabsız yazışmaya keç">
            <Icon name="inbox" size={15} style={{ color: "var(--text-faint)" }} />
            <span className={s.newPillCount}>{newCount}</span>
            <span className={s.newPillLabel}>yeni</span>
          </a>
        )}

        <ReadOnlyLock variant="inline" />

        <ThemeToggle compact />

        <span className={s.headerRule} aria-hidden />

        {align === "page" ? (
          <a className={s.userChip} href="/api/logout" title={`${name} · ${role} — çıxış`}>
            {user}
          </a>
        ) : (
          <span className={s.userChip} title={`${name} · ${role}`}>{user}</span>
        )}
      </div>
    </header>
  );
}
