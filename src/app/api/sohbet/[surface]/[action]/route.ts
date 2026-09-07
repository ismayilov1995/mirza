import { NextResponse } from "next/server";
import {
  markRead, setStarred, viewChats, viewMessages, viewSearch,
  type ChatTab, type ViewFilters, type ViewScope,
} from "@/lib/chat-view";
import {
  monitorSources, mySources, requireMonitorScope, requireSession,
} from "@/lib/access";

const TABS: ChatTab[] = ["all", "awaiting", "flagged"];

/*
 * Ortaq söhbət ekranının arxa tərəfi — hər iki səth üçün.
 *
 * SƏTH İCAZƏ DEYİL. URL-dəki "arxiv"/"nezaret" yalnız HANSI icazə yoxlamasının
 * işə düşəcəyini seçir; hər ikisi əsl yoxlamadır və hər ikisi sessiyadan
 * gəlir. Uydurulmuş səth adı 404 alır, mövcud səth isə həmin səthin öz
 * qapısından keçir — yəni nəzarətçi "arxiv" yazmaqla arxivə çıxa bilmir,
 * çünki orada mySources() işləyir və o, sessiyanın kim olduğuna baxır.
 *
 * Bir fayl, iki səth: sorğu məntiqi eynidir, fərq yalnız əhatədədir. Ayrı-ayrı
 * marşrut ailələri qursaydıq, biri düzəldiləndə digərinin unudulması ən adi
 * səhv olardı.
 */

export const dynamic = "force-dynamic";

async function scopeFor(surface: string, previewAs?: number): Promise<ViewScope | null> {
  if (surface === "arxiv") {
    const session = await requireSession();
    return { kind: "archive", userId: session.userId, sources: await mySources() };
  }
  if (surface === "nezaret") {
    /* Admin önizləməsi ("bu nəzarətçi nə görür") burada da işləməlidir,
       yoxsa səhifə önizləmə əhatəsini, marşrut isə həqiqi əhatəni göstərər və
       ekran özü ilə ziddiyyət təşkil edər. Kimin önizləyə biləcəyinə
       requireMonitorScope() qərar verir — bu arqument istək deyil, sorğudur. */
    const monitor = await requireMonitorScope(previewAs);
    return {
      kind: "monitor",
      userId: monitor.monitorUserId,
      sources: await monitorSources(monitor),
      monitor,
    };
  }
  return null;
}

function filtersFrom(sp: URLSearchParams): ViewFilters {
  const dir = sp.get("dir");
  const type = sp.get("type");
  const chat = sp.get("chat");
  return {
    direction: dir === "in" || dir === "out" ? dir : undefined,
    chatId: chat !== null && /^\d+$/.test(chat) ? Number(chat) : undefined,
    from: sp.get("from") || undefined,
    to: sp.get("to") || undefined,
    kinds: sp.get("kinds")?.split(",").filter(Boolean),
    chatType: type === "group" || type === "individual" ? type : undefined,
    instanceId: sp.get("instance") || undefined,
    starredOnly: sp.get("starred") === "1",
    voiceOnly: sp.get("voice") === "1",
    unreadOnly: sp.get("unread") === "1",
  };
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ surface: string; action: string }> },
) {
  const { surface, action } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const as = Number(sp.get("as"));
  const scope = await scopeFor(surface, Number.isInteger(as) ? as : undefined);
  if (!scope) return NextResponse.json({ error: "yoxdur" }, { status: 404 });

  if (action === "chats") {
    const page = Math.max(0, Number(sp.get("p")) || 0);
    return NextResponse.json(
      await viewChats(scope, {
        search: sp.get("q") ?? "",
        limit: 60,
        offset: page * 60,
        /* Satıcı süzgəci istəkdir, icazə deyil: sorğu onsuz da əhatə ilə
           məhdudlaşır, ona görə tanımadığı ID sadəcə boş nəticə verir. */
        instanceId: sp.get("instance") || undefined,
        /* Tanınmayan tab süzgəci söndürür, xəta vermir: URL əl ilə
           yazılıbsa, boş ekran yerinə tam siyahı göstərmək doğrudur. */
        tab: TABS.includes(sp.get("tab") as ChatTab) ? (sp.get("tab") as ChatTab) : "all",
      }),
    );
  }

  if (action === "messages") {
    const chatId = Number(sp.get("chat"));
    if (!Number.isInteger(chatId)) return NextResponse.json({ error: "chat" }, { status: 400 });
    // A ceiling, so a hand-edited ?n= cannot ask for a 14,000-message page.
    const n = Math.min(3000, Math.max(20, Number(sp.get("n")) || 80));
    /* Lövbər: axtarış nəticəsindən gələn mesajın id-si. Tanınmayan və ya
       əhatədən kənar id süzülüb atılmır, sadəcə tapılmır — yazışma onda adi
       qaydada sondan oxunur (chat-view.ts:anchorAt). */
    const at = Number(sp.get("at"));
    const ahead = Math.min(3000, Math.max(0, Number(sp.get("f")) || 0));
    /* Seçilmiş nömrə siyahıda olduğu kimi yazışmada da tətbiq olunur —
       əks halda «principal» seçən adam başqa nömrələrin mesajlarını oxuyur. */
    const got = await viewMessages(scope, chatId, {
      limit: n,
      around: Number.isInteger(at) && at > 0 ? at : undefined,
      ahead,
      instanceId: sp.get("instance") || undefined,
    });
    if (!got) return NextResponse.json({ error: "yoxdur" }, { status: 404 });
    return NextResponse.json(got);
  }

  if (action === "search") {
    return NextResponse.json(
      await viewSearch(scope, { query: sp.get("q") ?? "", filters: filtersFrom(sp), limit: 60 }),
    );
  }

  return NextResponse.json({ error: "yoxdur" }, { status: 404 });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ surface: string; action: string }> },
) {
  const { surface, action } = await ctx.params;
  const as = Number(new URL(req.url).searchParams.get("as"));
  const scope = await scopeFor(surface, Number.isInteger(as) ? as : undefined);
  if (!scope) return NextResponse.json({ error: "yoxdur" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "gövdə" }, { status: 400 });

  if (action === "read") {
    const chatId = Number(body.chatId);
    const ts = Number(body.ts);
    if (!Number.isInteger(chatId) || !Number.isInteger(ts)) {
      return NextResponse.json({ error: "arqument" }, { status: 400 });
    }
    await markRead(scope, chatId, ts);
    return NextResponse.json({ ok: true });
  }

  if (action === "star") {
    const messageId = Number(body.messageId);
    if (!Number.isInteger(messageId)) return NextResponse.json({ error: "arqument" }, { status: 400 });
    const on = body.on === true;
    await setStarred(scope, messageId, on);
    return NextResponse.json({ ok: true, starred: on });
  }

  return NextResponse.json({ error: "yoxdur" }, { status: 404 });
}
