import { NextResponse } from "next/server";
import { logMonitorView, requireVisibleChat } from "@/lib/access";
import { getMonitorChatHeader, getMonitorMessages } from "@/lib/monitor-queries";
import { intParam, scopeFromRequest, NO_STORE } from "@/lib/monitor-api";
import { decodeChatId } from "@/lib/monitor-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 200;

/**
 * Bir söhbətin yazışması.
 *
 *   ?chat=<token>              → son səhifə + başlıq
 *   ?chat=<token>&before=<ts>  → daha köhnə səhifə ("yuxarı sürüşdür")
 *   ?chat=<token>&after=<ts>   → yalnız yenilər (canlı əlavə), başlıqsız
 *
 * `chat` söhbətin opaq açarıdır (bax monitor-token.ts) — xam JID qəbul
 * edilmir, çünki cavabda da qaytarılmır.
 *
 * Hər üç halda eyni qapıdan keçilir: `requireVisibleChat()` gizli söhbətə 403
 * verir, `after` isə pəncərə sərhədini keçə bilmir.
 *
 * WhatsApp-a heç bir sorğu getmir — mesajlar bazadan oxunur, ona görə burada
 * baxılan söhbət qarşı tərəfdə "oxundu" olmur.
 */
export async function GET(request: Request) {
  const scope = await scopeFromRequest(request);
  const url = new URL(request.url);
  const instanceId = url.searchParams.get("instanceId") ?? "";
  const token = url.searchParams.get("chat") ?? "";
  if (!instanceId || !token) {
    return NextResponse.json({ error: "instanceId və chat tələb olunur" }, { status: 400 });
  }
  const jid = decodeChatId(instanceId, token);
  // Saxta və ya başqa nömrəyə aid token: mövcudluq haqqında heç nə demirik.
  if (!jid) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const chat = await requireVisibleChat(scope, instanceId, jid);

  const after = intParam(url, "after");
  const limit = intParam(url, "limit");
  const live = after !== null;

  const { messages, hasOlder } = await getMonitorMessages(chat, {
    before: intParam(url, "before"),
    after,
    limit: limit === null ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, limit)),
  });

  // Başlıq yalnız ilk yükləmədə lazımdır; canlı sorğu saniyədə bir gələ bilər.
  const header = live ? null : await getMonitorChatHeader(chat);

  // Jurnal yalnız insanın açdığı baxış üçün — canlı poll audit sətri deyil.
  if (!live) await logMonitorView(scope, instanceId, jid, "chat");

  return NextResponse.json(
    { chat: header, messages, hasOlder, historyDays: scope.profile.historyDays },
    { headers: NO_STORE },
  );
}
