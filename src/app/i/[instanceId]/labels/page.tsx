import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getInstanceInfo, type ChatFilter, type ChatTypeFilter } from "@/lib/queries";
import ChatSection, { ChatSectionSkeleton } from "../ChatSection";
import styles from "../../../dashboard.module.css";
import { requireInstance } from "@/lib/access";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/**
 * Naming and categorising chats, on its own page.
 *
 * This was the first section of the instance dashboard, which put a
 * data-entry table above the statistics people actually open the dashboard
 * to read. It is a task you sit down to do, not something you glance at, so
 * it gets its own route and the dashboard is stats-only again.
 */
export default async function ChatLabelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ instanceId: string }>;
  searchParams: Promise<{ chats?: string; type?: string; q?: string; page?: string; quiet?: string }>;
}) {
  const { instanceId: rawInstanceId } = await params;
  const instanceId = await requireInstance(rawInstanceId);
  const sp = await searchParams;

  const chatFilter: ChatFilter =
    sp.chats === "named" || sp.chats === "all" || sp.chats === "suggested" ? sp.chats : "unnamed";
  const typeFilter: ChatTypeFilter =
    sp.type === "group" || sp.type === "individual" || sp.type === "lid" ? sp.type : "all";
  const query = (sp.q ?? "").slice(0, 100);
  const page = Math.max(1, Number(sp.page) || 1);
  const includeQuiet = sp.quiet === "1";

  const info = await getInstanceInfo(instanceId);
  if (!info) notFound();

  return (
    <>
      <AppHeader section="Statistika" align="page" searchInstanceId={rawInstanceId} />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Adlandırma</div>
          <div className={styles.subtitle}>
            <Link href={`/i/${instanceId}`}>← {info.ownerUserName ?? info.name}</Link> · kontaktlara ad
            və kateqoriya ver
          </div>
        </div>
      </header>

      {/* Keyed on every input the list depends on, so changing a filter
          re-suspends into the skeleton instead of leaving stale rows up. */}
      <Suspense
        key={`chats:${chatFilter}:${typeFilter}:${query}:${page}:${includeQuiet}`}
        fallback={<ChatSectionSkeleton />}
      >
        <ChatSection
          instanceId={instanceId}
          chatFilter={chatFilter}
          typeFilter={typeFilter}
          query={query}
          page={page}
          includeQuiet={includeQuiet}
        />
      </Suspense>

      <div className={styles.footer}>Katibe · Evolution API üzərindən, yalnız oxu rejimində</div>
    </div>
    </>
  );
}
