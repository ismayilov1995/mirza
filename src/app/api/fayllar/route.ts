import { NextRequest, NextResponse } from "next/server";
import { getSession, mySources } from "@/lib/access";
import { listMedia, MEDIA_TIPS, type MediaTip } from "@/lib/media-library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fayl kitabxanasının növbəti səhifəsi.
 *
 * Səhifənin BİRİNCİ səhifəsi serverdə render olunur (src/app/fayllar/page.tsx)
 * və bu marşrut yalnız "daha çox" üçündür. Süzgəclər eyni adlarla gəlir, çünki
 * onlar URL-dədir: brauzer səhifədəki linkin parametrlərini olduğu kimi ötürür
 * və iki yerdə iki fərqli ad saxlamaq lazım gəlmir.
 *
 * İcazə burada YENİDƏN yoxlanılır. Səhifədən keçmək marşrutdan keçmək demək
 * deyil — marşrut birbaşa da çağırıla bilər.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Giriş yoxdur" }, { status: 401 });
  // Nəzarətçinin arxivə girişi yoxdur; onun ekranı /monitor-dur.
  if (session.role === "monitor") return NextResponse.json({ error: "İcazə yoxdur" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const tip = MEDIA_TIPS.includes(sp.get("tip") as MediaTip) ? (sp.get("tip") as MediaTip) : "hamisi";
  const chatId = intParam(sp.get("chat"));
  const year = intParam(sp.get("il"));
  const q = (sp.get("q") ?? "").slice(0, 120);
  const ts = intParam(sp.get("ts"));
  const id = intParam(sp.get("id"));

  const sources = await mySources();
  const { items, next } = await listMedia(
    sources,
    { tip, chatId, year, q },
    { after: ts !== null && id !== null ? { ts, id } : null },
  );
  return NextResponse.json({ items, next });
}

function intParam(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
