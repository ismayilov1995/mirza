import { redirect } from "next/navigation";
import { getSession, mySources } from "@/lib/access";
import { archiveSummary, listViewSources } from "@/lib/archive";
import ChatScreen from "@/components/chat/ChatScreen";
import InstanceNav from "@/components/chat/InstanceNav";
import WorkSidebar from "@/components/WorkSidebar";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/**
 * Arxiv — bir ekran, doqquz il.
 *
 * Əvvəl iki səhifə idi: söhbətlərin siyahısı, sonra ayrıca yazışma səhifəsi.
 * Axtarış nəticəsindən söhbətə keçmək səhifə dəyişməsi demək idi və geri
 * qayıdanda nəticələr itirdi — yəni "bunu tapdım, bir də oxşarına baxım"
 * axtarışı hər dəfə yenidən yazmaq demək idi. İndi hər ikisi bir ekrandadır.
 *
 * Səhifənin özü serverdədir və yalnız icazə ilə çərçivəni qurur; oxunan
 * məlumat /api/sohbet/arxiv/* üzərindən gəlir, orada da icazə yenidən
 * yoxlanılır. Bu təkrar qəsdəndir: səhifədən keçmək marşrutdan keçmək demək
 * deyil, marşrut isə birbaşa da çağırıla bilər.
 */
export default async function ArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ chat?: string; msg?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  // Nəzarətçinin öz ekranı var və rol oradan kənara çıxmır.
  if (session.role === "monitor") redirect("/monitor");

  const sources = await mySources();
  const [summary, viewSources] = await Promise.all([
    archiveSummary(sources),
    listViewSources(sources),
  ]);
  const span =
    summary.firstTs && summary.lastTs
      ? `${new Date(summary.firstTs * 1000).getFullYear()}–${new Date(summary.lastTs * 1000).getFullYear()}`
      : "—";

  const sp = await searchParams;
  const initialChatId = sp.chat !== undefined && /^\d+$/.test(sp.chat) ? Number(sp.chat) : null;
  /* ?msg= söhbətin İÇİNDƏ hansı mesajdan başlanacağını deyir. Söhbətsiz
     mənası yoxdur: mesajın hansı yazışmaya aid olduğunu link özü daşımalıdır,
     ekran onu tapmağa çalışmır. Tanınmayan id serverdə sadəcə tapılmır və
     yazışma adi qaydada sondan açılır. */
  const initialMessageId =
    initialChatId !== null && sp.msg !== undefined && /^\d+$/.test(sp.msg) ? Number(sp.msg) : null;

  return (
    <ChatScreen
      endpoints={{
        chats: "/api/sohbet/arxiv/chats",
        messages: "/api/sohbet/arxiv/messages",
        search: "/api/sohbet/arxiv/search",
        media: "/api/sohbet/arxiv/media",
        star: "/api/sohbet/arxiv/star",
        read: "/api/sohbet/arxiv/read",
      }}
      caps={{ media: "inline", masked: false, canStar: true, readMarkers: true }}
      /* Mənbə seçicisi yan paneldədir — siyahının başında təkrarlanmır. */
      laneChips={false}
      lanes={viewSources.map((v) => ({ id: v.id, label: v.name }))}
      tabs={[
        { key: "all", label: "Hamısı" },
        { key: "awaiting", label: "Cavabsız" },
        { key: "flagged", label: "Bayraqlı" },
      ]}
      title="Söhbətlər"
      subtitle={`${summary.messages.toLocaleString("az-AZ")} mesaj · ${summary.chats.toLocaleString("az-AZ")} söhbət · ${span}`}
      initialChatId={initialChatId}
      initialMessageId={initialMessageId}
      /* Arxiv artıq yalnız arxiv deyil: eyni ekranda CANLI yazışmalar da var
         və müştəri cavab yazanda onu görmək üçün səhifəni yeniləmək lazım
         olmamalıdır. Doqquz il əvvəlki söhbət dəyişmir, amma bugünkü dəyişir
         — ekran isə ikisini ayırmır, ona görə yenilənmə ekranın xassəsidir. */
      livePollMs={20_000}
      top={<AppHeader section="İş" />}
      sidebar={
        <WorkSidebar
          activeHref="/arxiv"
          /* Mənbə siyahısı naviqasiyanın altındadır, nəzarət ekranındakı ilə
             eyni komponent: arxivdə seçim "hansı nömrə" yox, "hansı mənbə"
             deməkdir, davranış isə eynidir. */
          extra={
            <InstanceNav
              label="Mənbə"
              instances={viewSources.map((v) => ({
                id: v.id,
                name: v.name,
                chats: v.chats,
                awaiting: 0,
                live: v.live,
                meta: v.kind === "archive" ? "köçürülmüş arxiv" : v.live ? "qoşulu" : "qoşulu deyil",
              }))}
            />
          }
        />
      }
    />
  );
}
