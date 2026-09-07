import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import PairInstance from "@/components/PairInstance";
import styles from "../../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

export default async function PairInstancePage({ params }: { params: Promise<{ name: string }> }) {
  await requireAdmin();
  const { name: raw } = await params;
  const name = decodeURIComponent(raw);

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>{name}</div>
          <div className={styles.subtitle}>
            <Link href="/admin">← Admin</Link> · WhatsApp hesabını qoşmaq üçün QR kodu skan et
          </div>
        </div>
      </header>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Qoşulma</div>
        </div>
        <PairInstance name={name} />
      </section>

      <div className={styles.footer}>
        Bu instance &quot;oxundu&quot; işarələməmək üçün qurulub — mesajlar yalnız oxunur.
      </div>
    </div>
    </>
  );
}
