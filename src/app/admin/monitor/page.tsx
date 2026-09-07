import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import { getCategories } from "@/lib/queries";
import { getMonitorViewLog, listMonitorAccounts } from "@/lib/monitor";
import { getMonitorRuleCandidates } from "@/lib/monitor-queries";
import { saveProfileAction, setCategoryRuleAction, setChatRuleAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

const bakuTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("az-AZ", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Baku",
      }).format(new Date(iso))
    : "—";

/**
 * Nəzarətçi hesablarının görünmə qaydaları.
 *
 * Hesabın ÖZÜ və nömrə təyinatları /admin/accounts-dadır (orada bütün rollar
 * üçün eyni forma var) — burada yalnız "nəyi görsün" sualı həll olunur, ona
 * görə iki yerdə iki fərqli hesab anlayışı yaranmır.
 */
export default async function MonitorAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; q?: string; type?: string; notice?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;

  const [accounts, categories, viewLog] = await Promise.all([
    listMonitorAccounts(),
    getCategories(),
    getMonitorViewLog(50),
  ]);

  const selectedId = Number(sp.user);
  const selected = accounts.find((a) => a.userId === selectedId) ?? accounts[0] ?? null;
  const type = sp.type === "group" || sp.type === "individual" ? sp.type : "all";
  const search = sp.q ?? "";

  // Söhbət siyahısı yalnız seçilmiş hesab üçün çəkilir — bu, ən bahalı sorğudur.
  const candidates = selected
    ? await getMonitorRuleCandidates({
        monitorUserId: selected.userId,
        profile: selected.profile,
        instanceIds: selected.instances.map((i) => i.instanceId),
        search,
        type,
        limit: 120,
      })
    : [];

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Nəzarətçi icazələri</div>
          <div className={styles.subtitle}>
            <Link href="/admin">← Admin</Link> · hesab və nömrə təyinatı{" "}
            <Link href="/admin/accounts">hesablar səhifəsindədir</Link>
          </div>
        </div>
      </header>

      {sp.notice ? <div className={styles.empty}>{sp.notice}</div> : null}

      {accounts.length === 0 ? (
        <section className={styles.section}>
          <div className={styles.empty}>
            Hələ nəzarətçi hesabı yoxdur. <Link href="/admin/accounts">Hesablar</Link> səhifəsində
            rolu <b>nəzarətçi</b> olan hesab yarat və ona baxacağı nömrələri təyin et.
          </div>
        </section>
      ) : (
        <>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>Hesab</div>
            </div>
            <div className={styles.pillList}>
              {accounts.map((a) => (
                <Link
                  key={a.userId}
                  href={`/admin/monitor?user=${a.userId}`}
                  className={a.userId === selected?.userId ? styles.pillLink : styles.pill}
                >
                  {a.username}
                  {a.active ? "" : " (söndürülüb)"}
                </Link>
              ))}
            </div>
          </section>

          {selected && (
            <>
              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div className={styles.sectionTitle}>{selected.username} — profil</div>
                  <div className={styles.legend}>
                    son giriş {bakuTime(selected.lastLoginAt)} ·{" "}
                    {/* İki ekran, iki ayrı sual: hansı yazışmaları görür və
                        hansı bayraqları görür. Qaydalar ikisinə də təsir edir,
                        ona görə ikisini də yoxlamaq mümkün olmalıdır. */}
                    <Link href={`/monitor?as=${selected.userId}`} className={styles.jid}>
                      yazışmalarına bax →
                    </Link>{" "}
                    ·{" "}
                    <Link href={`/monitor/bayraqlar?as=${selected.userId}`} className={styles.jid}>
                      bayraqlarına bax →
                    </Link>
                  </div>
                </div>

                <div className={styles.jid} style={{ marginBottom: 10 }}>
                  Nömrələr:{" "}
                  {selected.instances.length === 0
                    ? "təyin olunmayıb — heç nə görmür"
                    : selected.instances.map((i) => i.instanceName).join(", ")}
                </div>

                <form action={saveProfileAction} className={styles.inlineForm}>
                  <input type="hidden" name="userId" value={selected.userId} />
                  <label className={styles.pill}>
                    Tarixçə (gün)
                    <input
                      className={styles.inlineInput}
                      type="number"
                      name="historyDays"
                      min={1}
                      max={3650}
                      defaultValue={selected.profile.historyDays}
                      style={{ width: 90, marginLeft: 8 }}
                    />
                  </label>
                  <label className={styles.pill}>
                    <input
                      type="checkbox"
                      name="maskPhones"
                      defaultChecked={selected.profile.maskPhones}
                      style={{ marginRight: 6 }}
                    />
                    Nömrələr maskalansın
                  </label>
                  <label className={styles.pill}>
                    Qruplar
                    <select
                      className={styles.inlineInput}
                      name="groupDefault"
                      defaultValue={selected.profile.groupDefault}
                      style={{ marginLeft: 8 }}
                    >
                      <option value="hidden">gizli</option>
                      <option value="visible">açıq</option>
                    </select>
                  </label>
                  <label className={styles.pill}>
                    Fərdi
                    <select
                      className={styles.inlineInput}
                      name="directDefault"
                      defaultValue={selected.profile.directDefault}
                      style={{ marginLeft: 8 }}
                    >
                      <option value="visible">açıq</option>
                      <option value="hidden">gizli</option>
                    </select>
                  </label>
                  <SubmitButton variant="accent" label="Saxla" pendingLabel="Saxlanılır…" />
                </form>
              </section>

              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div className={styles.sectionTitle}>Kateqoriya qaydaları</div>
                  <div className={styles.legend}>tip default-unu üstələyir</div>
                </div>
                <table className={styles.table}>
                  <tbody>
                    {categories.map((cat) => {
                      const rule = selected.categoryRules.find((r) => r.categoryId === cat.id);
                      return (
                        <tr key={cat.id}>
                          <td>{cat.name}</td>
                          <td className={styles.jid}>
                            {rule ? (rule.visibility === "allow" ? "açıq" : "gizli") : "default"}
                          </td>
                          <td>
                            <form action={setCategoryRuleAction} className={styles.rowForm}>
                              <input type="hidden" name="userId" value={selected.userId} />
                              <input type="hidden" name="categoryId" value={cat.id} />
                              <select
                                className={styles.rowInput}
                                name="visibility"
                                defaultValue={rule?.visibility ?? "default"}
                              >
                                <option value="default">default</option>
                                <option value="allow">açıq</option>
                                <option value="deny">gizli</option>
                              </select>
                              <SubmitButton variant="quiet" label="Tətbiq et" pendingLabel="…" />
                            </form>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>

              <section className={styles.section}>
                <div className={styles.sectionHeader}>
                  <div className={styles.sectionTitle}>Söhbətlər</div>
                  <div className={styles.legend}>
                    son {selected.profile.historyDays} gündə aktiv olanlar · söhbət qaydası hər şeyi
                    üstələyir
                  </div>
                </div>

                <form className={styles.inlineForm} action="/admin/monitor" method="get">
                  <input type="hidden" name="user" value={selected.userId} />
                  <input
                    className={styles.inlineInput}
                    type="search"
                    name="q"
                    placeholder="Ad və ya JID"
                    defaultValue={search}
                  />
                  <select className={styles.inlineInput} name="type" defaultValue={type}>
                    <option value="all">hamısı</option>
                    <option value="group">qruplar</option>
                    <option value="individual">fərdi</option>
                  </select>
                  <button className={styles.rowButton} type="submit">
                    Axtar
                  </button>
                </form>

                <table className={styles.table} style={{ marginTop: 10 }}>
                  <thead>
                    <tr>
                      <th>Söhbət</th>
                      <th>Kateqoriya</th>
                      <th>Vəziyyət</th>
                      <th>Qayda</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => (
                      <tr key={c.jid}>
                        <td>
                          {c.chatType === "group" ? "👥 " : "👤 "}
                          {c.name}
                          <div className={styles.jid}>
                            {c.messageCount} mesaj · {c.jid}
                          </div>
                        </td>
                        <td className={styles.jid}>{c.categoryName ?? "—"}</td>
                        <td>
                          <span
                            className={styles.severityBadge}
                            data-band={c.visible ? "info" : "ciddi"}
                          >
                            {c.visible ? "görünür" : "gizli"}
                          </span>
                          <div className={styles.jid}>
                            {c.source === "chat"
                              ? "söhbət qaydası"
                              : c.source === "category"
                                ? "kateqoriya"
                                : "default"}
                          </div>
                        </td>
                        <td>
                          <form action={setChatRuleAction} className={styles.rowForm}>
                            <input type="hidden" name="userId" value={selected.userId} />
                            <input type="hidden" name="jid" value={c.jid} />
                            <select
                              className={styles.rowInput}
                              name="visibility"
                              defaultValue={c.source === "chat" ? (c.visible ? "allow" : "deny") : "default"}
                            >
                              <option value="default">default</option>
                              <option value="allow">açıq</option>
                              <option value="deny">gizli</option>
                            </select>
                            <SubmitButton variant="quiet" label="Tətbiq et" pendingLabel="…" />
                          </form>
                        </td>
                      </tr>
                    ))}
                    {candidates.length === 0 && (
                      <tr>
                        <td colSpan={4} className={styles.empty}>
                          Söhbət tapılmadı.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </section>
            </>
          )}

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>Baxış jurnalı</div>
              <div className={styles.legend}>kim, kimin söhbətinə, nə vaxt</div>
            </div>
            <table className={styles.table}>
              <tbody>
                {viewLog.map((row) => (
                  <tr key={row.id}>
                    <td>{bakuTime(row.at)}</td>
                    <td>{row.username}</td>
                    <td>{row.instanceName}</td>
                    <td className={styles.jid}>{row.chatName ?? row.remoteJid ?? row.action}</td>
                    <td className={styles.jid}>{row.action}</td>
                  </tr>
                ))}
                {viewLog.length === 0 && (
                  <tr>
                    <td colSpan={5} className={styles.empty}>
                      Hələ baxış yoxdur.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
    </>
  );
}
