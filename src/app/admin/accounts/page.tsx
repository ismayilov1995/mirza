import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import { listAccounts, listAllInstances } from "@/lib/accounts";
import {
  createAccountAction,
  setActiveAction,
  setGrantsAction,
  setInstancePrivateAction,
  setPasswordAction,
  setRoleAction,
} from "./actions";
import SubmitButton from "@/components/SubmitButton";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

function bakuTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("az-AZ", {
    timeZone: "Asia/Baku",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const me = await requireAdmin();
  const [accounts, instances] = await Promise.all([listAccounts(), listAllInstances()]);
  const notice = (await searchParams).notice;

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Hesablar</div>
          <div className={styles.subtitle}>Giriş hesabları və hansı nömrələri görə bildikləri</div>
        </div>
        <div className={styles.headerActions}>
          <Link href="/admin" className={styles.logoutButton}>
            ← Admin
          </Link>
        </div>
      </header>

      {notice ? (
        <div className={styles.section}>
          <div className={styles.bubbleText}>{notice}</div>
        </div>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionTitle}>Nömrələrin privatlığı</div>
        <div className={styles.empty} style={{ paddingTop: 0 }}>
          Privat nömrəni yalnız açıq icazəsi olan görür — admin olsa belə. Şəxsi nömrənizi belə
          qoruyun: privat edin, sonra yalnız özünüzə icazə verin.
        </div>
        <div className={styles.chartScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Nömrə</th>
                <th>Vəziyyət</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {instances.map((i) => (
                <tr key={i.instanceId}>
                  <td>{i.instanceName}</td>
                  <td>
                    {i.private ? (
                      <span className={styles.severityBadge} data-band="ciddi">
                        🔒 Privat
                      </span>
                    ) : (
                      <span className={styles.jid}>Adminlərə açıq</span>
                    )}
                  </td>
                  <td>
                    <form action={setInstancePrivateAction}>
                      <input type="hidden" name="instanceId" value={i.instanceId} />
                      <input type="hidden" name="private" value={i.private ? "0" : "1"} />
                      <SubmitButton
                        variant="quiet"
                        label={i.private ? "Privatlıqdan çıxar" : "Privat et"}
                        pendingLabel="Dəyişdirilir…"
                      />
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionTitle}>Yeni hesab</div>
        <form action={createAccountAction} className={styles.agentMeta}>
          <input className={styles.input} name="username" placeholder="İstifadəçi adı" required />
          <input className={styles.input} name="email" placeholder="E-poçt (istəyə bağlı)" />
          <input
            className={styles.input}
            name="password"
            type="password"
            placeholder="Müvəqqəti parol (min 10 simvol)"
            required
          />
          <select className={styles.input} name="role" defaultValue="viewer">
            <option value="viewer">viewer — yalnız verilən nömrələr</option>
            <option value="admin">admin — hər şey (privatlardan başqa)</option>
            <option value="monitor">nəzarətçi — yalnız oxu, /monitor ekranı</option>
          </select>
          <SubmitButton variant="accent" label="Yarat" pendingLabel="Yaradılır…" />
        </form>
      </section>

      {accounts.map((a) => (
        <section key={a.id} className={styles.section}>
          <div className={styles.sectionTitle}>
            {a.username}
            {a.id === me.userId ? <span className={styles.jid}> · siz</span> : null}{" "}
            <span className={styles.severityBadge} data-band={a.role === "admin" ? "diqqet" : "info"}>
              {a.role}
            </span>{" "}
            {a.active ? null : (
              <span className={styles.severityBadge} data-band="ciddi">
                söndürülüb
              </span>
            )}
            {a.mustChangePassword ? <span className={styles.jid}> · parol dəyişməlidir</span> : null}
          </div>
          <div className={styles.jid}>
            {a.email ?? "e-poçt yoxdur"} · yaradılıb {bakuTime(a.createdAt)} · son giriş{" "}
            {bakuTime(a.lastLoginAt)}
          </div>

          <form action={setGrantsAction} style={{ marginTop: 12 }}>
            <input type="hidden" name="userId" value={a.id} />
            <div className={styles.pillList}>
              {instances.map((i) => {
                const on = a.instances.some((g) => g.instanceId === i.instanceId);
                return (
                  <label key={i.instanceId} className={styles.pill}>
                    <input
                      type="checkbox"
                      name="instanceId"
                      value={i.instanceId}
                      defaultChecked={on}
                      style={{ marginRight: 6 }}
                    />
                    {i.instanceName}
                    {i.private ? " 🔒" : ""}
                  </label>
                );
              })}
            </div>
            <div style={{ marginTop: 10 }}>
              <SubmitButton
                variant="accent"
                label="İcazələri yadda saxla"
                pendingLabel="Yadda saxlanılır…"
              />
            </div>
          </form>

          <div className={styles.agentMeta} style={{ marginTop: 12 }}>
            <form action={setPasswordAction} className={styles.agentMeta}>
              <input type="hidden" name="userId" value={a.id} />
              <input
                className={styles.input}
                name="password"
                type="password"
                placeholder="Yeni parol"
                required
              />
              <SubmitButton variant="quiet" label="Parolu sıfırla" pendingLabel="Sıfırlanır…" />
            </form>

            {/* Rol üç variantlıdır, ona görə açıb-bağlayan düymə əvəzinə seçim:
                "admin et / viewer et" düyməsi nəzarətçini heç vaxt göstərməzdi. */}
            <form action={setRoleAction} className={styles.agentMeta}>
              <input type="hidden" name="userId" value={a.id} />
              <select className={styles.input} name="role" defaultValue={a.role}>
                <option value="viewer">viewer</option>
                <option value="admin">admin</option>
                <option value="monitor">nəzarətçi</option>
              </select>
              <SubmitButton variant="quiet" label="Rolu dəyiş" pendingLabel="Dəyişdirilir…" />
            </form>

            <form action={setActiveAction}>
              <input type="hidden" name="userId" value={a.id} />
              <input type="hidden" name="active" value={a.active ? "0" : "1"} />
              <SubmitButton
                variant="quiet"
                label={a.active ? "Söndür" : "Aktivləşdir"}
                pendingLabel="Dəyişdirilir…"
              />
            </form>
          </div>
        </section>
      ))}

      <div className={styles.footer}>Katibe · Evolution API üzərindən, yalnız oxu rejimində</div>
    </div>
    </>
  );
}
