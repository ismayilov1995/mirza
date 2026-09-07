import { requireMonitorScope, type ScopedInstanceId } from "@/lib/access";
import { getMonitorInstances } from "@/lib/monitor-queries";
import { countOpenFlags } from "@/lib/supervisor/feed";
import { decodeChatId } from "@/lib/monitor-token";
import { pool } from "@/lib/db";
import ChatScreen from "@/components/chat/ChatScreen";
import InstanceNav from "@/components/chat/InstanceNav";
import AppHeader from "@/components/AppHeader";
import { Sidebar } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Nəzarətçi görünüşü — satıcıların WhatsApp-ı, yalnız oxumaq üçün.
 *
 * ARXİVLƏ EYNİ EKRAN. Əvvəl iki ayrı tətbiq idi: iki mesaj forması, iki tarix
 * formatı, medianın nə olduğuna dair iki fikir. Biri düzələndə digəri
 * düzəlmirdi. İndi fərq yalnız iki propdadır — hansı əhatə (nəzarətçi) və nəyə
 * icazə (maskalanmış, media klikləndikdə açılır).
 *
 * Səhifə qəsdən app-in qalan hissəsindən ayrıdır: nə statistika, nə AI
 * analizi, nə kataloq. Nəzarətçi rolunun bütün icazəsi budur — requireSession()
 * bu rolu hər yerdən buraya qaytarır, və məhz o "default olaraq bağlı" duruş
 * rolu paylamağı təhlükəsiz edir.
 *
 * Admin `?as=<userId>` ilə eyni səhifəni aça bilir: "bu nəzarətçi nə görür"
 * önizləməsi. Qaydaları qurmağın yeganə dürüst yoxlanışı budur.
 */
export default async function MonitorPage({
  searchParams,
}: {
  searchParams: Promise<{ as?: string; i?: string; chat?: string }>;
}) {
  const sp = await searchParams;
  const previewId = sp.as ? Number(sp.as) : NaN;
  const scope = await requireMonitorScope(Number.isInteger(previewId) ? previewId : undefined);
  /* Satıcıların adları — zolaq seçicisi üçün. Nəzarətçi nömrəni yox, adamı
     axtarır, ona görə etiket instansın adı deyil, sahibinin adıdır. */
  const [instances, openFlags] = await Promise.all([
    getMonitorInstances(scope),
    /* Naviqasiyadakı nişan. Bayraq sayı YAZIŞMALAR ekranında da lazımdır:
       nəzarətçi günün çox hissəsini burada keçirir və bayraqların yığıldığını
       görmək üçün o biri səhifəni açmağa məcbur olmamalıdır. */
    countOpenFlags(scope.instances as ScopedInstanceId[]),
  ]);

  /*
   * Bayraq ekranından gələn dərin keçid.
   *
   * Ora hələ də opaq token göndərir, çünki o ekranda söhbətin açarı instans +
   * JID-dir və JID telefon nömrəsidir. Burada isə açar kanonik söhbət ID-sidir
   * — sadəcə sətir nömrəsi, heç nə açıqlamır. Tərcümə SERVERDƏ olur: token
   * açılır, JID tapılır, ondan söhbət. Token icazə deyil və burada da deyil —
   * söhbətin görünməsinə ekranın öz əhatəsi qərar verir.
   */
  let initialChatId: number | null = null;
  if (sp.i && sp.chat) {
    const jid = decodeChatId(sp.i, sp.chat);
    if (jid) {
      const { rows } = await pool.query<{ chat_id: string }>(
        `SELECT chat_id FROM katibe.chat_jid WHERE remote_jid = $1`,
        [jid],
      );
      if (rows.length > 0) initialChatId = Number(rows[0].chat_id);
    }
  }

  const as = scope.preview ? `?as=${scope.monitorUserId}` : "";

  return (
    <ChatScreen
      endpoints={{
        chats: `/api/sohbet/nezaret/chats${as}`,
        messages: `/api/sohbet/nezaret/messages${as}`,
        search: `/api/sohbet/nezaret/search${as}`,
        media: "/api/sohbet/nezaret/media",
        star: `/api/sohbet/nezaret/star${as}`,
        read: `/api/sohbet/nezaret/read${as}`,
      }}
      /*
       * Media KLİKLƏNDİKDƏ açılır, öz-özünə görünmür.
       *
       * Nömrələr maskalanan bir ekranda müştərinin göndərdiyi bütün şəkilləri
       * avtomatik göstərmək maskalamanı mənasız edərdi. Klik isə faylı açmağı
       * hərəkətə çevirir — və hər açılış jurnala düşür.
       */
      caps={{
        media: "click",
        masked: true,
        canStar: true,
        readMarkers: true,
        canReportFlag: true,
      }}
      title="Nəzarət"
      subtitle={
        scope.preview
          ? `Önizləmə: ${scope.monitorUsername} nə görür`
          : `${scope.monitorUsername} · son ${scope.profile.historyDays} gün · nömrələr maskalanıb`
      }
      initialChatId={initialChatId}
      top={<AppHeader section="Nəzarət" />}
      livePollMs={25_000}
      lanes={instances.map((i) => ({
        id: i.instanceId,
        label: i.ownerName ?? i.instanceName,
        awaiting: i.awaiting,
      }))}
      /* Nömrə seçicisi sidebar-dadır — siyahının başında təkrarlanmır. */
      laneChips={false}
      tabs={[
        { key: "all", label: "Hamısı" },
        { key: "awaiting", label: "Cavabsız" },
        { key: "flagged", label: "Bayraqlı" },
      ]}
      sidebar={
        <Sidebar
          activeHref={`/monitor${as}`}
          /* Nömrə siyahısı naviqasiyanın altındadır: nəzarətçinin ilk sualı
             "hansı nömrədə iş var?" olur və nömrələr ekranlar arasında
             dəyişmir. Seçim ChatScreen-in state-indədir, kontekstlə bağlanır
             (chat/lane-context.tsx). */
          extra={
            <InstanceNav
              instances={instances.map((i) => ({
                id: i.instanceId,
                name: i.ownerName ?? i.instanceName,
                chats: i.visibleChats,
                awaiting: i.awaiting,
                live: i.connectionStatus === "open",
              }))}
            />
          }
          sections={[
            {
              label: "Nəzarət",
              items: [
                { href: `/monitor${as}`, label: "Yazışmalar", icon: "messages-square" },
                {
                  href: `/monitor/bayraqlar${as}`,
                  label: "Bayraqlar",
                  icon: "triangle-alert",
                  badge: openFlags,
                  badgeTone: "critical",
                },
              ],
            },
            {
              label: "Hesab",
              items: [{ href: "/api/logout", label: "Çıxış", icon: "log-out" }],
            },
          ]}
        />
      }
    />
  );
}
