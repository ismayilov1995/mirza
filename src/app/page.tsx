import Link from "next/link";
import { Suspense } from "react";
import { getUsersWithInstances } from "@/lib/queries";
import { isFeedOnMainPage } from "@/lib/supervisor/feed";
import { myInstances, requireSession } from "@/lib/access";
import SupervisorFeed, { SupervisorFeedSkeleton } from "@/components/SupervisorFeed";
import LiveUpdates from "@/components/LiveUpdates";
import WorkSidebar from "@/components/WorkSidebar";
import { AppShell, Badge, EmptyState, Panel, TopBar } from "@/components/ui";
import AppHeader from "@/components/AppHeader";
import s from "@/components/ui/ui.module.css";

export const dynamic = "force-dynamic";

/**
 * Nömrələr — hansı satıcının hansı nömrələri var.
 *
 * Ekranın çərçivəsi arxiv və nəzarətlə eynidir (AppShell + WorkSidebar +
 * TopBar). Əvvəl öz başlığı vardı: emoji brend, yanında beş link, hamısı
 * çıxış düyməsi ilə eyni sinifdən — yəni "harada olduğumu" bildirən element
 * ilə "məni çıxart" düyməsi eyni görünürdü.
 */
export default async function UserPickerPage() {
  await requireSession();
  // Siyahı çağıranın görə bildiyi nömrələrlə kəsilir — əks halda səhifə hər
  // instansın ID-sini verirdi və o ID-lər birbaşa URL-də işlənə bilirdi.
  const allowed = new Set<string>(await myInstances());
  const users = (await getUsersWithInstances())
    .map((u) => ({ ...u, instances: u.instances.filter((i) => allowed.has(i.instanceId)) }))
    .filter((u) => u.instances.length > 0);
  // Kölgə rejimi: lent .env.local-dakı SUPERVISOR_FEED=main açılana qədər
  // yalnız /agent səhifəsindədir — bax src/lib/supervisor/feed.ts.
  const feedOnMain = isFeedOnMainPage();

  const totalInstances = users.reduce((n, u) => n + u.instances.length, 0);

  const userGrid =
    users.length === 0 ? (
      <EmptyState title="Nömrə yoxdur">
        Hələ heç bir satıcı yaradılmayıb. <Link href="/admin">Admin panelindən</Link> satıcı yaradıb
        ona nömrə təyin et.
      </EmptyState>
    ) : (
      <div className={s.cardGrid}>
        {users.map((u) => (
          <Panel
            key={u.id}
            title={u.name}
            hint={[u.branchName, u.categoryName].filter(Boolean).join(" · ") || undefined}
          >
            {u.instances.map((i) => (
              <Link key={i.instanceId} href={`/i/${i.instanceId}`} className={s.linkRow}>
                <span className={s.linkRowName}>{i.instanceName}</span>
                {/* Xam "open"/"close" sözü ekranda qalmır: qoşulma vəziyyəti
                    hər yerdə eyni iki sözlə deyilir (bax InstanceNav). */}
                <Badge
                  tone={i.connectionStatus === "open" ? "brand" : "faint"}
                  variant="soft"
                  size="xs"
                >
                  {i.connectionStatus === "open" ? "qoşulu" : "qoşulu deyil"}
                </Badge>
              </Link>
            ))}
          </Panel>
        ))}
      </div>
    );

  return (
    <AppShell
      top={<AppHeader section="İş" />}
      sidebar={<WorkSidebar activeHref="/" />}
      header={
        <TopBar
          title="Nömrələr"
          subtitle={`${users.length} satıcı · ${totalInstances} nömrə — statistikanı görmək üçün birini seç`}
          actions={feedOnMain ? <LiveUpdates /> : null}
        />
      }
    >
      {userGrid}
      {/* Boşluq AppShell-in öz qaydasındadır — burada inline flex qabı vardı,
          eyni qərarın ikinci nüsxəsi idi. */}
      {feedOnMain && (
        <Suspense fallback={<SupervisorFeedSkeleton />}>
          <SupervisorFeed />
        </Suspense>
      )}
    </AppShell>
  );
}
