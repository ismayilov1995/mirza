import { requireMonitorScope, visibleJids, type ScopedInstanceId } from "@/lib/access";
import { getAgentFeed } from "@/lib/supervisor/feed";
import { encodeChatId } from "@/lib/monitor-token";
import SupervisorFeed, { type BandFilter } from "@/components/SupervisorFeed";
import AppHeader from "@/components/AppHeader";
import { AppShell, Sidebar, TopBar } from "@/components/ui";

export const dynamic = "force-dynamic";

/** URL-dən gələn zolaq — tanınmayan dəyər süzgəci söndürür, 404 vermir. */
const BANDS: BandFilter[] = ["hamısı", "kritik", "ciddi", "diqqet"];

/**
 * The supervisor's view of the flags raised on Sales.
 *
 * It is the SAME feed the manager reads, not a plainer copy of it. The first
 * attempt was a bespoke screen — safer to reason about, and visibly worse to
 * use, which is its own kind of failure: a reviewer who dislikes the screen
 * reviews less.
 *
 * What keeps that safe is that the feed already renders by role. Rating,
 * muting and suppression are admin-gated inside the component, so a monitor
 * reaching it gets the reading surface and the two verbs they need — review,
 * and close with a reason. Capability comes from what is rendered, not from
 * which URL was opened.
 *
 * Scope and role are passed in rather than derived, because deriving them
 * would send a monitor back to /monitor: requireSession() redirects the role
 * by design, and that redirect is the reason the role is safe to hand out.
 *
 * Çərçivə YAZIŞMALAR EKRANI İLƏ EYNİDİR: eyni sidebar, eyni başlıq, eyni
 * "yalnız oxu" nişanı. Əvvəl bu səhifənin öz başlığı vardı (emoji + link) və
 * iki ekran arasında gedib-gəlmək hər dəfə yeni bir tətbiqə düşmək kimi idi.
 */
export default async function MonitorFlagsPage({
  searchParams,
}: {
  searchParams: Promise<{ b?: string; u?: string; as?: string }>;
}) {
  const sp = await searchParams;
  /*
   * Admin önizləməsi — «bu nəzarətçi hansı bayraqları görür».
   *
   * Yazışmalar ekranında (/monitor) bu çoxdan var idi, burada isə yox: səhifə
   * `requireMonitorScope()`-u arqumentsiz çağırırdı, yəni admin öz ekranından
   * gələn linkə basanda 403 alırdı və qaydaların nəticəsini yalnız nəzarətçinin
   * parolu ilə görmək olardı. Qaydaları qurmağın yeganə dürüst yoxlanışı isə
   * budur.
   *
   * Kimin önizləyə biləcəyinə requireMonitorScope() qərar verir: nəzarətçi
   * başqasının adından baxa bilmir, admin isə yalnız AKTİV nəzarətçi hesabı
   * üçün. Yəni parametr istək deyil, sorğudur.
   */
  const previewId = sp.as ? Number(sp.as) : NaN;
  // Nəzarətçi qapısı — /monitor altındakı hər səhifənin ilk sətri.
  const scope = await requireMonitorScope(Number.isInteger(previewId) ? previewId : undefined);
  const instances = scope.instances as ScopedInstanceId[];

  const band: BandFilter = BANDS.includes(sp.b as BandFilter) ? (sp.b as BandFilter) : "hamısı";
  const rawUser = Number(sp.u);
  const userId = Number.isInteger(rawUser) && rawUser > 0 ? rawUser : undefined;

  /*
   * Söhbətə keçid linkləri BURADA hazırlanır, lentin içində yox.
   *
   * İki səbəb, ikisi də icazə ilə bağlıdır. Birincisi, link üçün JID lazımdır
   * və JID telefon nömrəsidir — onu brauzerə göndərmək maskalanmış ekranın
   * altındakı maskalamanı puç edərdi. Ona görə link opaq token daşıyır
   * (monitor-token.ts), JID isə serverdə qalır.
   *
   * İkincisi, nəzarətçinin gördüyü instansda da GÖRMƏDİYİ söhbətlər var —
   * gizlədilmiş qruplar, profil qaydaları. visibleJids() onları süzür, yəni
   * link yalnız həqiqətən açıla bilən söhbətlər üçün çıxır. Görünməyənə link
   * göstərmək 403-ə aparan yalan vəd olardı.
   */
  const feed = await getAgentFeed(instances, { limit: 40 });
  const posts = [...feed.pinned, ...feed.open];
  const jids = [...new Set(posts.map((p) => p.remoteJid).filter((j): j is string => j !== null))];
  const visible = await visibleJids(scope, jids);

  const chatLinks: Record<number, string> = {};
  for (const p of posts) {
    if (p.remoteJid === null || !visible.has(p.remoteJid)) continue;
    const token = encodeChatId(p.instanceId, p.remoteJid);
    chatLinks[p.id] =
      `/monitor?i=${encodeURIComponent(p.instanceId)}&chat=${encodeURIComponent(token)}` +
      (scope.preview ? `&as=${scope.monitorUserId}` : "");
  }

  const openCount = feed.pinned.length;

  /* Önizləmədə HƏR keçid parametri saxlamalıdır: bir link onu itirsə, adam
     önizləmədən çıxır və növbəti ekranda 403 görür. */
  const as = scope.preview ? `?as=${scope.monitorUserId}` : "";
  const keep = scope.preview ? { as: String(scope.monitorUserId) } : undefined;

  return (
    <AppShell
      top={<AppHeader section="Nəzarət" />}
      sidebar={
        <Sidebar
          activeHref={`/monitor/bayraqlar${as}`}
          sections={[
            {
              label: "Nəzarət",
              items: [
                { href: `/monitor${as}`, label: "Yazışmalar", icon: "messages-square" },
                {
                  href: `/monitor/bayraqlar${as}`,
                  label: "Bayraqlar",
                  icon: "triangle-alert",
                  badge: openCount,
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
      header={
        <TopBar
          title="Bayraqlar"
          subtitle={
            scope.preview
              ? `Önizləmə: ${scope.monitorUsername} nə görür · 6–10 bal müdaxilə tələb edir`
              : "6–10 bal müdaxilə tələb edir · bağlamaq üçün səbəb yazılmalıdır"
          }
        />
      }
    >
      <SupervisorFeed
        scope={instances}
        role="monitor"
        masked
        chatLinks={chatLinks}
        userId={userId}
        band={band}
        basePath="/monitor/bayraqlar"
        keep={keep}
      />
    </AppShell>
  );
}
