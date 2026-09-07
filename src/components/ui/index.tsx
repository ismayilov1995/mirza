import type { CSSProperties, ReactNode } from "react";
import { severityBand, type SeverityBand } from "@/lib/supervisor/types";
import Icon from "./Icon";
import s from "./ui.module.css";

export { default as Icon } from "./Icon";
export { default as Modal } from "./Modal";
export { default as Sidebar, type NavItem } from "./Sidebar";

/*
 * Dizayn sisteminin primitivləri.
 *
 * Hamısı bir faylda, çünki hər biri otuz sətirdir və birlikdə oxunanda
 * variant adlarının uyğunluğu görünür — Badge-in "tone"-u ilə Button-un
 * "variant"-ı ayrı-ayrı fayllarda asanlıqla bir-birindən uzaqlaşır.
 *
 * Heç biri "use client" deyil: hamısı sırf stil daşıyır, hadisə tutmur. Bu,
 * server komponentlərində də işlədilə bilmələri deməkdir və arxiv ekranının
 * böyük hissəsi məhz serverdə qalır.
 */

type Tone = "neutral" | "brand" | "critical" | "serious" | "info" | "faint";

export function Badge({
  tone = "neutral", variant = "outline", size = "sm", shape = "pill",
  caps = false, icon, children, style, className,
}: {
  tone?: Tone;
  variant?: "outline" | "soft" | "solid";
  size?: "xs" | "sm" | "md";
  shape?: "pill" | "md";
  caps?: boolean;
  icon?: string;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <span
      className={className ? `${s.badge} ${className}` : s.badge}
      data-tone={tone} data-variant={variant} data-size={size}
      data-shape={shape} data-caps={caps ? "true" : undefined}
      style={style}
    >
      {icon && <Icon name={icon} size={size === "md" ? 13 : 11} />}
      {children}
    </span>
  );
}

/**
 * A button, or a link that looks like one.
 *
 * `href` picks the element, and that is the whole rule: navigation is an
 * anchor so it opens in a new tab and shows its target in the status bar,
 * while an action is a button so the keyboard treats it as one. Styling them
 * alike is a visual decision; making them the same element would not be.
 */
export function Button({
  variant = "secondary", size = "md", icon, iconRight, loading = false,
  disabled = false, href, full = false, children, style, title,
  type = "button", name, value, onClick,
}: {
  variant?: "primary" | "secondary" | "quiet" | "danger";
  size?: "sm" | "md";
  icon?: string;
  iconRight?: string;
  loading?: boolean;
  disabled?: boolean;
  href?: string;
  full?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
  title?: string;
  type?: "button" | "submit";
  name?: string;
  value?: string;
  onClick?: () => void;
}) {
  const off = disabled || loading;
  const iconSize = size === "sm" ? 13 : 15;
  const inner = (
    <>
      {loading ? <Icon name="loader-circle" size={iconSize} className={s.spin} />
        : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={iconSize} />}
    </>
  );
  const shared = {
    className: s.button,
    "data-variant": variant, "data-size": size,
    "data-full": full ? "true" : undefined,
    style, title,
  } as const;

  if (href) {
    return (
      <a {...shared} href={off ? undefined : href} aria-disabled={off || undefined}>
        {inner}
      </a>
    );
  }
  return (
    <button {...shared} type={type} name={name} value={value} disabled={off}
      aria-busy={loading || undefined} onClick={onClick}>
      {inner}
    </button>
  );
}

/*
 * Native <input> has its own numeric `size` attribute, so ours is omitted from
 * the spread type — otherwise "md" is checked against a number and the whole
 * prop collapses to never.
 */
export function Input({
  size = "md", icon, style, ...rest
}: {
  size?: "sm" | "md" | "lg";
  icon?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">) {
  const field = (
    <input className={s.field} data-size={size} data-icon={icon ? "true" : undefined}
      style={style} {...rest} />
  );
  if (!icon) return field;
  return (
    <span className={s.fieldWrap}>
      <Icon name={icon} size={15} className={s.fieldIcon} />
      {field}
    </span>
  );
}

/**
 * A filter, as a link.
 *
 * Filters live in the URL so the pages that use them can stay server
 * components, so this is an anchor rather than a button — and that has a
 * second payoff the design did not ask for: a filtered view can be
 * bookmarked, and sent to somebody else.
 */
export function FilterChip({
  active = false, href, shape = "pill", children, style, onClick, title,
}: {
  active?: boolean;
  href?: string;
  shape?: "pill" | "md";
  children?: ReactNode;
  style?: CSSProperties;
  onClick?: () => void;
  title?: string;
}) {
  if (href) {
    return (
      <a className={s.chip} data-shape={shape} href={href} title={title}
        aria-current={active ? "page" : undefined} style={style}>
        {children}
      </a>
    );
  }
  return (
    <button className={s.chip} data-shape={shape} data-active={active ? "true" : undefined}
      type="button" onClick={onClick} title={title} style={style}>
      {children}
    </button>
  );
}

export function EmptyState({
  tone = "neutral", title, children, actions, icon, style,
}: {
  tone?: "neutral" | "positive" | "warning";
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
  icon?: string;
  style?: CSSProperties;
}) {
  const fallback = tone === "positive" ? "circle-check" : tone === "warning" ? "triangle-alert" : "inbox";
  return (
    <div className={s.empty} data-tone={tone} style={style}>
      <Icon name={icon ?? fallback} size={18} className={s.emptyIcon} />
      <div className={s.emptyBody}>
        {title && <div className={s.emptyTitle}>{title}</div>}
        <div className={s.emptyText}>{children}</div>
        {actions && (
          <div style={{ display: "flex", gap: "var(--space-3)", marginTop: "var(--space-6)", flexWrap: "wrap" }}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

export function TopBar({
  title, subtitle, back, actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
}) {
  /*
   * Ad və alt başlıq EYNİ XƏTDƏDİR, iç-içə deyil.
   *
   * Əvvəl ikisi ayrıca qutuda alt-alta dururdu və o qutu düymələrlə eni
   * bölüşürdü — nəticədə alt başlıq çox tez kəsilirdi («Nəzarətçi / Satış
   * yazış…»). İndi hər ikisi zolağın öz uşağıdır: ad yer tutmur (`flex:none`),
   * qalan eni alt başlıq alır və yalnız doğrudan yer çatmayanda kəsilir.
   */
  return (
    <header className={s.topbar}>
      {back && (
        <a className={s.topbarBack} href={back.href}>
          <Icon name="arrow-left" size={14} />
          {back.label}
        </a>
      )}
      <div className={s.topbarTitle}>{title}</div>
      {subtitle && <div className={s.topbarSub}>{subtitle}</div>}
      {actions && <div className={s.topbarActions}>{actions}</div>}
    </header>
  );
}

/* ——— Panel ———
 *
 * Prototipdə üç ayrı sinif idi (.section + .sectionHeader + .sectionTitle) və
 * heç vaxt ayrı işlənmirdi — burada bir komponentdir.
 *
 * `pad={false}` sıra siyahısı saxlayan panel üçündür: sıraların ayırıcı xətti
 * panelin kənarına qədər getməlidir, doldurma onu havada saxlayardı.
 */
export function Panel({
  title, hint, actions, pad = true, children, style, id,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  pad?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
  id?: string;
}) {
  const head = title || actions || hint;
  return (
    <section className={s.panel} data-pad={pad ? undefined : "false"} style={style} id={id}>
      {head && (
        <div className={s.panelHead} data-empty={children ? undefined : "true"}>
          <div className={s.panelTitles}>
            {title && <h2 className={s.panelTitle}>{title}</h2>}
            {hint && <span className={s.panelHint}>{hint}</span>}
          </div>
          {actions && <div className={s.panelActions}>{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Bir rəqəm, bir etiket, bir izah.
 *
 * `hint` boş buraxılmır: "16:20" özü sual doğurur, "hədəf 2 saat" isə cavab
 * verir. Rəqəmin nə demək olduğunu kartın özü izah etməlidir.
 */
export function StatCard({
  label, value, hint, tone = "neutral", href, style,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "brand" | "critical" | "serious";
  href?: string;
  style?: CSSProperties;
}) {
  const inner = (
    <>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statValue}>{value}</div>
      {hint && <div className={s.statHint}>{hint}</div>}
    </>
  );
  if (href) {
    return (
      <a className={s.statCard} data-tone={tone} href={href} style={style}>{inner}</a>
    );
  }
  return <div className={s.statCard} data-tone={tone} style={style}>{inner}</div>;
}

/** Kartların şəbəkəsi — dörd kart geniş ekranda bir sıra, dar ekranda qatlanır. */
export function StatGrid({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return <div className={s.statGrid} style={style}>{children}</div>;
}

/**
 * Canlı yenilənmə göstəricisi.
 *
 * Nəbz yalnız bağlantı diri olanda vurur — dayanmış nöqtə "yenilənmə dayanıb"
 * deməkdir və bu, göstəricinin bütün mənasıdır. prefers-reduced-motion
 * altında nəbz onsuz da dayanır (tokens.css).
 */
export function LiveDot({
  live = true, label, style,
}: {
  live?: boolean;
  label?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <span className={s.liveDot} data-live={live ? "true" : "false"} style={style}>
      <span className={s.livePulse} />
      {label ?? (live ? "canlı" : "bağlantı yoxdur")}
    </span>
  );
}

/**
 * Məhsulun əsas vədi, nişan halında.
 *
 * Əvvəl hər səhifənin altında kiçik boz mətn idi və oxunmurdu. İndi iki
 * variantı var: sidebar-ın altındakı daimi bloku, və başlıqda yer tutmayan
 * `inline` nişanı. İkisi də eyni cümləni deyir, çünki adam "bu ekranı açmaq
 * telefonda nəsə etdimi?" sualını gündə bir dəfə verir.
 */
export function ReadOnlyLock({
  variant = "sidebar",
  note = "Bu panel WhatsApp-a heç nə yazmır və mesajları «oxundu» etmir. Oxunma izi yalnız buradadır — WhatsApp-da mesaj satıcı özü açana qədər oxunmamış qalır.",
  style,
}: {
  variant?: "sidebar" | "inline";
  note?: string;
  style?: CSSProperties;
}) {
  if (variant === "inline") {
    return (
      <span className={s.lockInline} style={style} title={note}>
        <Icon name="lock" size={11} />
        Yalnız oxu
      </span>
    );
  }
  return (
    <div className={s.navFoot} style={style}>
      <Icon name="lock" size={14} style={{ color: "var(--brand)", marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <div className={s.navFootTitle}>Yalnız oxu rejimi</div>
        <div className={s.navFootText}>{note}</div>
      </div>
    </div>
  );
}

/*
 * Bal zolağının rəngi — tək yerdə.
 *
 * Zolaq bölgüsü məhsulun real qərarıdır: 6–8 ilə 9–10 əvvəl eyni qırmızı idi
 * və "indi nəyə bax" sualına rəng cavab vermirdi. İndi ayrılır.
 *
 * Rəng sinif adı ilə yox, `--band` dəyişəni ilə paylanır: sıranın reyi,
 * rəqəmi, verdikti və gözləmə çipi eyni tonu oxuyur, ton isə bir yerdə
 * seçilir.
 */
const BAND_VAR: Record<SeverityBand, string> = {
  kritik: "var(--band-kritik)",
  ciddi: "var(--band-ciddi)",
  diqqet: "var(--band-diqqet)",
  info: "var(--band-melumat)",
};

const VERDICT: Record<SeverityBand, string> = {
  kritik: "müdaxilə",
  ciddi: "müdaxilə",
  diqqet: "izlə",
  info: "yaxşı",
};

/**
 * Bal reyi: 1–10 rəqəmi və altında verdikt sözü.
 *
 * Söz rəngin dublikatı deyil, onun əvəzedicisidir: rəngi ayırd etməyən adam
 * da "müdaxilə" ilə "izlə" arasındakı fərqi görməlidir. Rəng tək daşıyıcı
 * olsaydı, zolaq sistemi elə həmin adam üçün mövcud olmazdı.
 */
export function SeverityScore({
  score, verdict, style,
}: {
  score: number;
  verdict?: string;
  style?: CSSProperties;
}) {
  const band = severityBand(score);
  return (
    <div className={s.score} data-band={band}
      style={{ ["--band" as string]: BAND_VAR[band], ...style }}>
      <span className={s.scoreNum}>{score}</span>
      <span className={s.scoreVerdict}>{verdict ?? VERDICT[band]}</span>
    </div>
  );
}

/**
 * Nəzarətçi lentinin bir sırası.
 *
 * Solda bal reyi, zolaq rəngi sol haşiyədən oxunur, fon işığını yalnız kritik
 * sıralar alır — hamısı alsaydı fərq itərdi.
 *
 * `children` qəsdən açıqdır: sübut qutusu, bağlama forması, şərhlər və
 * admin-e məxsus qiymət zolağı sıradan sıraya dəyişir, amma başlıq, bal, gövdə
 * və alt sətir dəyişmir. Dəyişməyəni komponent saxlayır, dəyişəni çağıran
 * verir — ona görə eyni sıra həm nəzarətçinin, həm menecerin ekranında işləyir.
 */
export function FlagRow({
  score, title, href, wait, who, detector, repeat, body, reason,
  children, actions, time, last = false, style,
}: {
  score: number;
  title: ReactNode;
  href?: string;
  wait?: ReactNode;
  who?: ReactNode;
  detector?: ReactNode;
  repeat?: ReactNode;
  body?: ReactNode;
  reason?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  time?: ReactNode;
  last?: boolean;
  style?: CSSProperties;
}) {
  const band = severityBand(score);
  return (
    <div className={s.flagRow} data-band={band} data-last={last ? "true" : undefined}
      style={{ ["--band" as string]: BAND_VAR[band], ...style }}>
      <SeverityScore score={score} verdict={detector === "hesabat" ? "hesabat" : undefined} />
      <div className={s.flagBody}>
        <div className={s.flagTitleRow}>
          {href
            ? <a className={s.flagTitle} href={href}>{title}</a>
            : <span className={s.flagTitle}>{title}</span>}
          {wait && <span className={s.flagWait}>{wait}</span>}
          {who && <span className={s.flagWho}>{who}</span>}
          {detector && (
            <Badge tone="faint" shape="md" size="xs" caps
              style={{ fontWeight: "var(--weight-regular)" }}>
              {detector}
            </Badge>
          )}
          {repeat && <span className={s.flagRepeat}>{repeat}</span>}
        </div>
        {body && <div className={s.flagText}>{body}</div>}
        {reason && <div className={s.flagReason}>Bal düzəlişi: {reason}</div>}
        {children}
        {(actions || time) && (
          <div className={s.flagFoot}>
            {actions}
            {time && <span className={s.flagTime}>{time}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Sıra daxilindəki sübut qutusu.
 *
 * Müştərinin öz sözü agentin cümləsindən ayrı qutuda durur, çünki ikisinin
 * çəkisi eyni deyil: biri iddiadır, digəri sübutdur. Bir yerdə axanda oxucu
 * hansının hansı olduğunu ayıra bilmir.
 */
export function EvidenceBox({
  label, children, style,
}: {
  label?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className={s.evidenceBox} style={style}>
      {label && <span className={s.evidenceLabel}>{label}</span>}
      <span className={s.evidenceText}>{children}</span>
    </div>
  );
}

/** Bağlanmış bayrağın təsdiq zolağı — səbəb və vaxt bir sətirdə. */
export function ResolvedStrip({
  children, time, style,
}: {
  children?: ReactNode;
  time?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className={s.resolvedStrip} style={style}>
      <Icon name="circle-check" size={14} style={{ color: "var(--brand)", flex: "none" }} />
      <span className={s.resolvedText}>{children}</span>
      {time && <span className={s.resolvedTime}>{time}</span>}
    </div>
  );
}

/**
 * Ekranın çərçivəsi: üstdə qlobal başlıq, altında naviqasiya və məzmun.
 *
 * Sürüşən yalnız məzmundur, səhifə deyil — başlıq və sidebar yerində qalır.
 * Panel gün boyu açıq durur və "harada idim" sualını hər sürüşmədən sonra
 * yenidən vermək iş alətində itkidir.
 *
 * `top` (AppHeader) çərçivənin ƏN ÜSTÜNDƏDİR, sidebar-ın da: brend, hesab və
 * tema bütün ekranlarda eyni yerdə oturmalıdır, `header` isə yalnız «hansı
 * ekrandayam» sualına cavab verən nazik zolaqdır.
 */
export function AppShell({
  top, sidebar, header, children, scroll = true,
}: {
  top?: ReactNode;
  sidebar?: ReactNode;
  header?: ReactNode;
  children?: ReactNode;
  /** Məzmun öz daxilində düzülürsə (söhbət ekranı) sürüşməni o özü idarə edir. */
  scroll?: boolean;
}) {
  return (
    <div className={s.shellOuter}>
      {top}
      <div className={s.shell}>
        {sidebar}
        <div className={s.shellMain}>
          {header}
          {scroll ? (
            <div className={s.shellScroll}>
              <div className={s.shellInner}>{children}</div>
            </div>
          ) : children}
        </div>
      </div>
    </div>
  );
}
