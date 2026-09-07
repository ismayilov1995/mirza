import { ICON_PATHS } from "./icon-paths";

/**
 * One line-art glyph.
 *
 * `title` decides the accessibility story rather than a separate prop: an icon
 * with a title is an image with a name, one without is decoration and gets
 * aria-hidden. Passing both a title and a visible label beside it would make
 * a screen reader say the same thing twice, so callers give it a title only
 * when the icon stands alone.
 */
export default function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  className,
  style,
  title,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={{ flex: "none", display: "block", ...style }}
      dangerouslySetInnerHTML={{ __html: (title ? `<title>${title}</title>` : "") + d }}
    />
  );
}
