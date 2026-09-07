import Link from "next/link";
import { myInstances, requireSession } from "@/lib/access";
import { getHandoffChats, type HandoffChat } from "@/lib/supervisor/handoff";
import { formatDuration } from "@/lib/format";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/**
 * "İş bizim tərəfdə deyil" siyahıları — başqa filiala (Dubay, Riyad)
 * yönləndirilənlər və PR üçün yazanlar.
 *
 * Bu səhifə bayraq susdurmanın ƏVƏZİ deyil, ONUN QARŞILIĞIDIR: söhbət lentdən
 * çıxdı, amma yox olmadı. Ona görə hər sətir modelin qərarının səbəbini də
 * daşıyır — "niyə burada?" sualına cavab siyahının içindədir.
 */

const EMPTY_NOTE =
  "Hələ belə söhbət tapılmayıb. Hal söhbətə təzə mesaj gələndə hesablanır, ona görə siyahı gedişatlar getdikcə dolur.";

function bakuTime(iso: string): string {
  return new Intl.DateTimeFormat("az-AZ", {
    timeZone: "Asia/Baku",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function ago(ts: number): string {
  return formatDuration(Math.max(0, Math.floor(Date.now() / 1000) - ts));
}

function ChatTable({ chats }: { chats: HandoffChat[] }) {
  if (chats.length === 0) return <div className={styles.empty}>{EMPTY_NOTE}</div>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Söhbət</th>
          <th>Satıcı</th>
          <th>Son mesaj</th>
          <th>Səbəb</th>
          <th className={styles.numCell}>Bağlanan bayraq</th>
        </tr>
      </thead>
      <tbody>
        {chats.map((c) => (
          <tr key={`${c.instanceId}:${c.remoteJid}`}>
            <td>
              <Link
                href={`/i/${c.instanceId}/chat/${encodeURIComponent(c.remoteJid)}`}
                className={styles.chatLink}
              >
                {c.contact}
              </Link>
            </td>
            <td className={styles.sfCellMuted}>{c.userName ?? c.instanceName ?? "—"}</td>
            <td className={styles.sfCellMuted}>{ago(c.lastMessageTs)} əvvəl</td>
            <td className={styles.suggestionReason}>
              {c.reason}
              {c.confidence !== "HIGH" ? (
                <span className={styles.confidenceBadge}> {c.confidence.toLowerCase()}</span>
              ) : null}
            </td>
            <td className={styles.numCell}>{c.closedFlags || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function HandoffPage() {
  await requireSession();
  const scope = await myInstances();
  const { branch, pr } = await getHandoffChats(scope);
  const lastRun = [...branch, ...pr].reduce<string | null>(
    (max, c) => (max === null || c.classifiedAt > max ? c.classifiedAt : max),
    null,
  );

  return (
    <>
      <AppHeader section="İş" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>İş bizim tərəfdə deyil</div>
          <div className={styles.subtitle}>
            <Link href="/agent">← Nəzarətçi</Link> · başqa filiala yönləndirilmiş və PR üçün yazan
            söhbətlər. Bunlara bayraq açılmır — burada cavab verəcək adam bizim tərəfdə yoxdur.
          </div>
        </div>
        <div className={styles.headerActions}>
          <Link href="/" className={styles.logoutButton}>
            ← Ana səhifə
          </Link>
        </div>
      </header>

      <section className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Filiala yönləndirilib</div>
          <div className={styles.cardValue}>{branch.length.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>PR üçün</div>
          <div className={styles.cardValue}>{pr.length.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Bağlanmış bayraq</div>
          <div className={styles.cardValue}>
            {[...branch, ...pr].reduce((n, c) => n + c.closedFlags, 0).toLocaleString("az-AZ")}
          </div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Sonuncu təsnifat</div>
          <div className={styles.cardValue} style={{ fontSize: 16 }}>
            {lastRun ? bakuTime(lastRun) : "—"}
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>🛫 Filiala yönləndirilib</div>
        </div>
        <ChatTable chats={branch} />
        <div className={styles.legend}>
          Söhbətdə «Dubay komandası sizinlə əlaqə saxlayacaq» və ya «nömrənizi Riyad komandasına
          verirəm» tipli yönləndirmə görünəndə bura düşür — hansı filial olduğu «Səbəb» sütununda
          yazılır. Yönləndirmədən SONRA yeni sual gəlsə, hal öz-özünə dəyişir və söhbət nəzarətə
          qayıdır: təzə bayraq açılır.
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>🤝 PR üçün</div>
        </div>
        <ChatTable chats={pr} />
        <div className={styles.legend}>
          Əməkdaşlıq, reklam, blogger/influencer və sponsorluq təklifləri. Bunlar satış söhbəti
          deyil, ona görə satış SLA-sı ilə ölçülmür.
        </div>
      </section>

      <div className={styles.footer}>Katibe · Evolution API üzərindən, yalnız oxu rejimində</div>
    </div>
    </>
  );
}
