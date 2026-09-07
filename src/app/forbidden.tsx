import Link from "next/link";
import styles from "./dashboard.module.css";

// forbidden() çağırılanda göstərilir — bax src/lib/access.ts.
export default function Forbidden() {
  return (
    <div className={styles.page}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Giriş yoxdur</div>
        <div className={styles.empty}>
          Bu səhifəyə baxmaq icazəniz yoxdur. Səhv olduğunu düşünürsünüzsə, sizə lazım olan nömrənin
          hesabınıza təyin edilməsini istəyin.
        </div>
        <Link href="/" className={styles.pillLink}>
          ← Ana səhifə
        </Link>
      </div>
    </div>
  );
}
