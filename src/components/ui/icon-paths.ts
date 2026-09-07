/*
 * Lucide konturları, dizayn sistemi bundle-ından olduğu kimi çıxarılıb.
 *
 * Paket kimi asılılıq gətirmək əvəzinə mətn: lucide-react bütöv kitabxananı
 * gətirir, bizə isə bu ekranda iyirmi neçə ikon lazımdır. Fayl əl ilə
 * yazılmayıb — scripts qovluğundakı generasiya ilə çıxarılıb, ona görə də
 * içindəki "d" dəyərlərini əl ilə düzəltmək lazım deyil.
 *
 * Sonuncular (sun/moon/monitor, sonra download/images) əl ilə əlavə olunub:
 * tema seçici və fayl kitabxanası dizayn dəstində yox idi, çünki o vaxt nə
 * tema seçimi vardı, nə də qalereya.
 */
export const ICON_PATHS: Record<string, string> = {
  "arrow-left":
    "<path d=\"m12 19-7-7 7-7\"></path> <path d=\"M19 12H5\"></path>",
  "arrow-right":
    "<path d=\"M5 12h14\"></path> <path d=\"m12 5 7 7-7 7\"></path>",
  "arrow-up":
    "<path d=\"m5 12 7-7 7 7\"></path> <path d=\"M12 19V5\"></path>",
  "bell-off":
    "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\"></path> <path d=\"M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742\"></path> <path d=\"m2 2 20 20\"></path> <path d=\"M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05\"></path>",
  "building-2":
    "<path d=\"M10 12h4\"></path> <path d=\"M10 8h4\"></path> <path d=\"M14 21v-3a2 2 0 0 0-4 0v3\"></path> <path d=\"M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2\"></path> <path d=\"M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16\"></path>",
  "check":
    "<path d=\"M20 6 9 17l-5-5\"></path>",
  "chevron-down":
    "<path d=\"m6 9 6 6 6-6\"></path>",
  "chevron-left":
    "<path d=\"m15 18-6-6 6-6\"></path>",
  "chevron-right":
    "<path d=\"m9 18 6-6-6-6\"></path>",
  "circle-alert":
    "<circle cx=\"12\" cy=\"12\" r=\"10\"></circle> <line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\"></line> <line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\"></line>",
  "circle-check":
    "<circle cx=\"12\" cy=\"12\" r=\"10\"></circle> <path d=\"m16 9-5.5 5.5L8 12\"></path>",
  "clock":
    "<circle cx=\"12\" cy=\"12\" r=\"10\"></circle> <path d=\"M12 6v6l4 2\"></path>",
  "ellipsis":
    "<circle cx=\"12\" cy=\"12\" r=\"1\"></circle> <circle cx=\"19\" cy=\"12\" r=\"1\"></circle> <circle cx=\"5\" cy=\"12\" r=\"1\"></circle>",
  "external-link":
    "<path d=\"M15 3h6v6\"></path> <path d=\"M10 14 21 3\"></path> <path d=\"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6\"></path>",
  "eye":
    "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"></path> <circle cx=\"12\" cy=\"12\" r=\"3\"></circle>",
  "file-text":
    "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\"></path> <path d=\"M14 2v5a1 1 0 0 0 1 1h5\"></path> <path d=\"M10 9H8\"></path> <path d=\"M16 13H8\"></path> <path d=\"M16 17H8\"></path>",
  "funnel":
    "<path d=\"M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z\"></path>",
  "hourglass":
    "<path d=\"M5 22h14\"></path> <path d=\"M5 2h14\"></path> <path d=\"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22\"></path> <path d=\"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2\"></path>",
  "image":
    "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"></rect> <circle cx=\"9\" cy=\"9\" r=\"2\"></circle> <path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\"></path>",
  "inbox":
    "<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\"></polyline> <path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"></path>",
  "layout-dashboard":
    "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\"></rect> <rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\"></rect> <rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\"></rect> <rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\"></rect>",
  "loader-circle":
    "<path d=\"M21 12a9 9 0 1 1-6.219-8.56\"></path>",
  "lock":
    "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"></rect> <path d=\"M7 11V7a5 5 0 0 1 10 0v4\"></path>",
  "log-out":
    "<path d=\"m16 17 5-5-5-5\"></path> <path d=\"M21 12H9\"></path> <path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\"></path>",
  "map-pin":
    "<path d=\"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0\"></path> <circle cx=\"12\" cy=\"10\" r=\"3\"></circle>",
  "menu":
    "<path d=\"M4 5h16\"></path> <path d=\"M4 12h16\"></path> <path d=\"M4 19h16\"></path>",
  "message-square-text":
    "<path d=\"M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z\"></path> <path d=\"M7 11h10\"></path> <path d=\"M7 15h6\"></path> <path d=\"M7 7h8\"></path>",
  "messages-square":
    "<path d=\"M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z\"></path> <path d=\"M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1\"></path>",
  "mic":
    "<path d=\"M12 19v3\"></path> <path d=\"M19 10v2a7 7 0 0 1-14 0v-2\"></path> <rect x=\"9\" y=\"2\" width=\"6\" height=\"13\" rx=\"3\"></rect>",
  "panel-left":
    "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"></rect> <path d=\"M9 3v18\"></path>",
  "phone":
    "<path d=\"M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384\"></path>",
  "play":
    "<path d=\"M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z\"></path>",
  "plug":
    "<path d=\"M12 22v-5\"></path> <path d=\"M15 8V2\"></path> <path d=\"M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z\"></path> <path d=\"M9 8V2\"></path>",
  "qr-code":
    "<rect width=\"5\" height=\"5\" x=\"3\" y=\"3\" rx=\"1\"></rect> <rect width=\"5\" height=\"5\" x=\"16\" y=\"3\" rx=\"1\"></rect> <rect width=\"5\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\"></rect> <path d=\"M21 16h-3a2 2 0 0 0-2 2v3\"></path> <path d=\"M21 21v.01\"></path> <path d=\"M12 7v3a2 2 0 0 1-2 2H7\"></path> <path d=\"M3 12h.01\"></path> <path d=\"M12 3h.01\"></path> <path d=\"M12 16v.01\"></path> <path d=\"M16 12h1\"></path> <path d=\"M21 12v.01\"></path> <path d=\"M12 21v-1\"></path>",
  "radar":
    "<path d=\"M19.07 4.93A10 10 0 0 0 6.99 3.34\"></path> <path d=\"M4 6h.01\"></path> <path d=\"M2.29 9.62A10 10 0 1 0 21.31 8.35\"></path> <path d=\"M16.24 7.76A6 6 0 1 0 8.23 16.67\"></path> <path d=\"M12 18h.01\"></path> <path d=\"M17.99 11.66A6 6 0 0 1 15.77 16.67\"></path> <circle cx=\"12\" cy=\"12\" r=\"2\"></circle> <path d=\"m13.41 10.59 5.66-5.66\"></path>",
  "refresh-cw":
    "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"></path> <path d=\"M21 3v5h-5\"></path> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"></path> <path d=\"M8 16H3v5\"></path>",
  "search":
    "<path d=\"m21 21-4.34-4.34\"></path> <circle cx=\"11\" cy=\"11\" r=\"8\"></circle>",
  "settings":
    "<path d=\"M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915\"></path> <circle cx=\"12\" cy=\"12\" r=\"3\"></circle>",
  "shield-check":
    "<path d=\"M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z\"></path> <path d=\"m9 12 2 2 4-4\"></path>",
  "sliders-horizontal":
    "<path d=\"M10 5H3\"></path> <path d=\"M12 19H3\"></path> <path d=\"M14 3v4\"></path> <path d=\"M16 17v4\"></path> <path d=\"M21 12h-9\"></path> <path d=\"M21 19h-5\"></path> <path d=\"M21 5h-7\"></path> <path d=\"M8 10v4\"></path> <path d=\"M8 12H3\"></path>",
  "star":
    "<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z\"></path>",
  "tags":
    "<path d=\"M13.172 2a2 2 0 0 1 1.414.586l6.71 6.71a2.4 2.4 0 0 1 0 3.408l-4.592 4.592a2.4 2.4 0 0 1-3.408 0l-6.71-6.71A2 2 0 0 1 6 9.172V3a1 1 0 0 1 1-1z\"></path> <path d=\"M2 7v6.172a2 2 0 0 0 .586 1.414l6.71 6.71a2.4 2.4 0 0 0 3.191.193\"></path> <circle cx=\"10.5\" cy=\"6.5\" r=\".5\" fill=\"currentColor\"></circle>",
  "timer":
    "<line x1=\"10\" x2=\"14\" y1=\"2\" y2=\"2\"></line> <line x1=\"12\" x2=\"15\" y1=\"14\" y2=\"11\"></line> <circle cx=\"12\" cy=\"14\" r=\"8\"></circle>",
  "trending-up":
    "<path d=\"M16 7h6v6\"></path> <path d=\"m22 7-8.5 8.5-5-5L2 17\"></path>",
  "triangle-alert":
    "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"></path> <path d=\"M12 9v4\"></path> <path d=\"M12 17h.01\"></path>",
  "user":
    "<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"></path> <circle cx=\"12\" cy=\"7\" r=\"4\"></circle>",
  "users":
    "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"></path> <path d=\"M16 3.128a4 4 0 0 1 0 7.744\"></path> <path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"></path> <circle cx=\"9\" cy=\"7\" r=\"4\"></circle>",
  "video":
    "<path d=\"m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5\"></path> <rect x=\"2\" y=\"6\" width=\"14\" height=\"12\" rx=\"2\"></rect>",
  "wifi-off":
    "<path d=\"M12 20h.01\"></path> <path d=\"M8.5 16.429a5 5 0 0 1 7 0\"></path> <path d=\"M5 12.859a10 10 0 0 1 5.17-2.69\"></path> <path d=\"M19 12.859a10 10 0 0 0-2.007-1.523\"></path> <path d=\"M2 8.82a15 15 0 0 1 4.177-2.643\"></path> <path d=\"M22 8.82a15 15 0 0 0-11.288-3.764\"></path> <path d=\"m2 2 20 20\"></path>",
  "x":
    "<path d=\"M18 6 6 18\"></path> <path d=\"m6 6 12 12\"></path>",
  "moon":
    "<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"></path>",
  "sun":
    "<circle cx=\"12\" cy=\"12\" r=\"4\"></circle> <path d=\"M12 2v2\"></path> <path d=\"M12 20v2\"></path> <path d=\"m4.93 4.93 1.41 1.41\"></path> <path d=\"m17.66 17.66 1.41 1.41\"></path> <path d=\"M2 12h2\"></path> <path d=\"M20 12h2\"></path> <path d=\"m6.34 17.66-1.41 1.41\"></path> <path d=\"m19.07 4.93-1.41 1.41\"></path>",
  "monitor":
    "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"></rect> <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"></line> <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"></line>",
  "download":
    "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"></path> <polyline points=\"7 10 12 15 17 10\"></polyline> <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\"></line>",
  "images":
    "<path d=\"M18 22H4a2 2 0 0 1-2-2V6\"></path> <path d=\"m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18\"></path> <circle cx=\"12\" cy=\"8\" r=\"2\"></circle> <rect width=\"16\" height=\"16\" x=\"6\" y=\"2\" rx=\"2\"></rect>",
};

export type IconName = keyof typeof ICON_PATHS;
