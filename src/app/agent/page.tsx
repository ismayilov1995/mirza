import { Suspense } from "react";
import SupervisorFeed, { SupervisorFeedSkeleton, type BandFilter } from "@/components/SupervisorFeed";
import SupervisorRunBar from "@/components/SupervisorRunBar";
import LiveUpdates from "@/components/LiveUpdates";
import WorkSidebar from "@/components/WorkSidebar";
import { AppShell, Button, TopBar } from "@/components/ui";
import { requireSession } from "@/lib/access";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

const BANDS: BandFilter[] = ["hamısı", "kritik", "ciddi", "diqqet"];

/**
 * Nəzarətçi lentinin öz səhifəsi.
 *
 * Kölgə dövründə lentə baxılan yer budur; SUPERVISOR_FEED=main olanda lent ana
 * səhifəyə də çıxır (feed.ts). Sessiya qoruması src/proxy.ts-dən yox,
 * requireSession()-dan gəlir; icazə süzgəci isə lentin öz içindədir
 * (myInstances).
 *
 * Çərçivə nəzarətçinin /monitor/bayraqlar ekranı ilə eynidir və bu qəsdəndir:
 * iki ekran EYNİ lenti göstərir, biri menecerə, digəri nəzarətçiyə. Fərqli
 * görünsəydilər, eyni bayraq haqqında danışan iki adam fərqli şey gördüyünü
 * düşünərdi.
 */
export default async function AgentPage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string; b?: string }>;
}) {
  await requireSession();
  // Satıcı və bal filtri URL-dədir: server komponent qalır, client JS lazım gəlmir.
  const sp = await searchParams;
  const raw = Number(sp.u);
  const userId = Number.isInteger(raw) && raw > 0 ? raw : undefined;
  const band: BandFilter = BANDS.includes(sp.b as BandFilter) ? (sp.b as BandFilter) : "hamısı";

  return (
    <AppShell
      top={<AppHeader section="İş" />}
      sidebar={<WorkSidebar activeHref="/agent" />}
      header={
        <TopBar
          title="Nəzarətçi"
          subtitle="Satış yazışmalarına avtomatik nəzarət · yoxlama 09:00–21:00 arası (B.e–Şənbə) saatda bir gəlir"
          actions={
            <>
              <LiveUpdates />
              <Button size="sm" icon="external-link" href="/agent/handoff">
                Filial / PR
              </Button>
            </>
          }
        />
      }
    >
      <SupervisorRunBar />

      <Suspense key={`${userId ?? "all"}-${band}`} fallback={<SupervisorFeedSkeleton />}>
        <SupervisorFeed userId={userId} band={band} />
      </Suspense>
    </AppShell>
  );
}
