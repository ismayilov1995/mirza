import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import {
  getAdminInstances,
  getAdminOverview,
  getBranches,
  getCategories,
  getInstanceAssignments,
  getSlaRules,
  getUnassignedInstances,
  getUserSlaAssignments,
  getUsers,
} from "@/lib/queries";
import {
  assignInstance,
  createBranch,
  createCategory,
  createInstanceAction,
  createUser,
  unassignInstance,
} from "./actions";
import { setUserSlaRuleAction } from "./sla/actions";
import { instanceStatusWord } from "@/lib/format";
import { getCronHealth } from "@/lib/cron-health";
import SubmitButton from "@/components/SubmitButton";
import styles from "../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/* Gözətçinin vaxt damğası Bakı saatı ilə — admin ekranı ilə eyni saat qurşağı. */
const bakuTime = (d: Date | null) =>
  d
    ? new Intl.DateTimeFormat("az-AZ", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone: "Asia/Baku",
      }).format(d)
    : "—";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ silindi?: string; mesaj?: string; sohbet?: string; setir?: string; xeta?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const [
    overview,
    branches,
    categories,
    users,
    assignments,
    unassigned,
    instances,
    slaRules,
    slaAssignments,
    cronHealth,
  ] = await Promise.all([
      getAdminOverview(),
      getBranches(),
      getCategories(),
      getUsers(),
      getInstanceAssignments(),
      getUnassignedInstances(),
      getAdminInstances(),
      getSlaRules(),
      getUserSlaAssignments(),
      getCronHealth(),
    ]);

  const slaByUser = new Map(slaAssignments.map((a) => [a.userId, a]));
  // Arxivlənmiş qaydalar seçim siyahısında görünmür, amma artıq təyin olunmuş
  // adamın sətrində qalır — yoxsa <select> onu səssizcə başqasına dəyişərdi.
  const pickableRules = slaRules.filter((r) => r.retiredAt === null);

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Admin</div>
          <div className={styles.subtitle}>
            <Link href="/">← Dashboard-a qayıt</Link>
          </div>
        </div>
        <div className={styles.headerActions}>
          <Link href="/admin/satis" className={styles.logoutButton}>
            📊 Satıcılar
          </Link>
          <Link href="/admin/sla" className={styles.logoutButton}>
            ⏱️ SLA qaydaları
          </Link>
          <Link href="/admin/suggestions" className={styles.logoutButton}>
            🎯 Client təyinatı
          </Link>
          <Link href="/admin/contacts" className={styles.logoutButton}>
            📇 Ortaq kontaktlar
          </Link>
          <Link href="/admin/suppressions" className={styles.logoutButton}>
            🔇 Susdurulmuş bayraqlar
          </Link>
          <Link href="/admin/monitor" className={styles.logoutButton}>
            👁️ Nəzarətçi icazələri
          </Link>
          <Link href="/settings/mcp" className={styles.logoutButton}>
            🔌 MCP ayarları
          </Link>
        </div>
      </header>

      {sp.silindi ? (
        <div className={styles.notice} role="status">
          ✅ «{sp.silindi}» silindi — anbardan {sp.mesaj ?? "0"} mesaj, {sp.sohbet ?? "0"} söhbət
          və {sp.setir ?? "0"} qeyd təmizləndi.
        </div>
      ) : null}
      {sp.xeta ? (
        <div className={styles.noticeDanger} role="alert">
          ⚠️ {sp.xeta}
        </div>
      ) : null}

      {/*
        Cron gözətçisinin nişanı.
        Hər şey qaydasındadırsa HEÇ NƏ göstərmir — sağlam vəziyyəti hər açılışda
        təkrarlayan zolaq bir müddət sonra oxunmur, sonra da problem yazanda
        gözə dəymir. Yalnız iki halda danışır: problem var, ya da gözətçinin
        ÖZÜ susub. İkincisi qəsdən eyni səviyyədədir — bütün bu iş sakit
        dayanan işi görmək üçün görüldü, gözətçi susanda köhnə «qaydasındadır»
        cavabını göstərmək eyni tələnin bir qat yuxarısı olardı.
      */}
      {cronHealth.missing || cronHealth.stale ? (
        <div className={styles.noticeDanger} role="alert">
          ⚠️ Cron gözətçisi susub —{" "}
          {cronHealth.missing
            ? "heç bir nəticə yoxdur"
            : `son yoxlama ${bakuTime(cronHealth.checkedAt)}`}
          . Cron işlərinin vəziyyəti hazırda BİLİNMİR.
        </div>
      ) : cronHealth.problems.length > 0 ? (
        <div className={styles.noticeDanger} role="alert">
          ⚠️ Cron işlərində {cronHealth.problems.length} problem (yoxlanıldı{" "}
          {bakuTime(cronHealth.checkedAt)}, {cronHealth.okCount} iş qaydasındadır):
          <ul style={{ margin: "8px 0 0", paddingInlineStart: 20 }}>
            {cronHealth.problems.map((p) => (
              <li key={`${p.kind}:${p.job}`}>
                <strong>{p.kind}</strong> — {p.job}: {p.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Users (Katibe)</div>
          <div className={styles.cardValue}>{overview.totalUsers}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Instances (Evolution API)</div>
          <div className={styles.cardValue}>{overview.totalInstances}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Təyin olunmuş instance</div>
          <div className={styles.cardValue}>
            {overview.assignedInstances} / {overview.totalInstances}
          </div>
        </div>
      </section>

      <div className={styles.twoCol}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>Branch-lər</div>
          </div>
          {branches.length === 0 ? (
            <div className={styles.empty}>Hələ heç bir branch yaradılmayıb.</div>
          ) : (
            <div className={styles.pillList}>
              {branches.map((b) => (
                <span key={b.id} className={styles.pill}>
                  {b.name}
                </span>
              ))}
            </div>
          )}
          <form action={createBranch} className={styles.inlineForm}>
            <input
              className={styles.inlineInput}
              type="text"
              name="name"
              placeholder="Yeni branch adı (məs: Online Branch)"
              required
            />
            <SubmitButton variant="inline" label="Əlavə et" pendingLabel="Yaradılır…" />
          </form>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>Category-lər</div>
          </div>
          {categories.length === 0 ? (
            <div className={styles.empty}>Hələ heç bir category yaradılmayıb.</div>
          ) : (
            <div className={styles.pillList}>
              {categories.map((c) => (
                <span key={c.id} className={styles.pill}>
                  {c.name}
                </span>
              ))}
            </div>
          )}
          <form action={createCategory} className={styles.inlineForm}>
            <input
              className={styles.inlineInput}
              type="text"
              name="name"
              placeholder="Yeni category adı (məs: Sales)"
              required
            />
            <SubmitButton variant="inline" label="Əlavə et" pendingLabel="Yaradılır…" />
          </form>
        </section>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Users</div>
        </div>
        {users.length === 0 ? (
          <div className={styles.empty}>Hələ heç bir user yaradılmayıb.</div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Branch</th>
                  <th>Category</th>
                  <th>SLA qaydası</th>
                  <th className={styles.numCell}>Instance</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.branchName ?? <span className={styles.jid}>—</span>}</td>
                    <td>{u.categoryName ?? <span className={styles.jid}>—</span>}</td>
                    <td>
                      <form action={setUserSlaRuleAction} className={styles.rowForm}>
                        <input type="hidden" name="userId" value={u.id} />
                        <select
                          className={styles.rowInput}
                          name="ruleId"
                          defaultValue={slaByUser.get(u.id)?.ruleId ?? ""}
                        >
                          <option value="">— qayda yoxdur —</option>
                          {pickableRules.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                          {(() => {
                            const cur = slaByUser.get(u.id);
                            const retired =
                              cur?.ruleId != null &&
                              !pickableRules.some((r) => r.id === cur.ruleId);
                            return retired ? (
                              <option value={cur!.ruleId!}>{cur!.ruleName} (arxiv)</option>
                            ) : null;
                          })()}
                        </select>
                        <SubmitButton label="Təyin et" pendingLabel="Təyin edilir…" />
                      </form>
                    </td>
                    <td className={styles.numCell}>{u.instanceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <form action={createUser} className={styles.inlineForm}>
          <input className={styles.inlineInput} type="text" name="name" placeholder="Ad (məs: Zəma)" required />
          <select className={styles.inlineInput} name="branchId" defaultValue="">
            <option value="">Branch seç…</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <select className={styles.inlineInput} name="categoryId" defaultValue="">
            <option value="">Category seç…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <SubmitButton variant="inline" label="Əlavə et" pendingLabel="Yaradılır…" />
        </form>
      </section>

      {/* Nömrələrin siyahısı: təyin olunanı da, olunmayanı da. Bura qədər
          qoşulmamış instans yalnız «təyin et» seçicisinin içində görünürdü —
          yəni yarımçıq qalmış bir QR-ı silmək üçün ekran yox idi. */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Nömrələr</div>
        </div>
        {instances.length === 0 ? (
          <div className={styles.empty}>Hələ heç bir nömrə qoşulmayıb.</div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Nömrə</th>
                  <th>Vəziyyət</th>
                  <th>Sahibi</th>
                  <th className={styles.numCell}>Əməliyyat</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td>{i.number ?? <span className={styles.jid}>—</span>}</td>
                    <td>
                      {instanceStatusWord(i.connectionStatus)}{" "}
                      <span className={styles.jid}>({i.connectionStatus})</span>
                    </td>
                    <td>{i.ownerName ?? <span className={styles.jid}>təyin olunmayıb</span>}</td>
                    <td className={styles.numCell}>
                      <Link
                        href={`/admin/instance/${encodeURIComponent(i.name)}`}
                        className={styles.chatLink}
                      >
                        QR
                      </Link>
                      <span className={styles.jid}> · </span>
                      <Link
                        href={`/admin/instance/${encodeURIComponent(i.name)}/sil`}
                        className={styles.chatLink}
                      >
                        Sil
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.jid} style={{ marginTop: 6 }}>
          «Sil» nömrəni WhatsApp-dan çıxarır və qeydlərini təmizləyir — təsdiq ekranı nəyin
          gedəcəyini rəqəmlə göstərir.
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Instance təyinatı</div>
        </div>
        {assignments.length === 0 ? (
          <div className={styles.empty}>Hələ heç bir instance user-ə təyin olunmayıb.</div>
        ) : (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Instance</th>
                  <th>Status</th>
                  <th className={styles.numCell}></th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={a.instanceId}>
                    <td>{a.userName}</td>
                    <td>{a.instanceName}</td>
                    <td>
                      <span className={styles.jid}>{a.connectionStatus}</span>
                    </td>
                    <td className={styles.numCell}>
                      <form action={unassignInstance}>
                        <input type="hidden" name="instanceId" value={a.instanceId} />
                        <SubmitButton variant="quiet" label="Ləğv et" pendingLabel="Ləğv edilir…" />
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Creating an instance is how a new employee's WhatsApp gets connected;
            it is created read-only (never marks chats as read). */}
        <div className={styles.summaryLabel}>Yeni WhatsApp qoş</div>
        <form action={createInstanceAction} className={styles.inlineForm}>
          <input
            className={styles.inlineInput}
            type="text"
            name="name"
            placeholder="Instance adı (məs: zemfira) — hərf, rəqəm, tire"
            required
          />
          <SubmitButton
            variant="inline"
            label="Yarat və QR göstər"
            pendingLabel="Yaradılır — QR gözlənilir…"
          />
        </form>
        <div className={styles.jid} style={{ marginTop: 6 }}>
          Yaratdıqdan sonra QR səhifəsi açılacaq — həmin işçinin telefonundan skan etmək lazımdır.
        </div>

        <div className={styles.summaryLabel}>User-ə təyin et</div>
        {users.length === 0 ? (
          <div className={styles.empty}>Təyinat üçün əvvəlcə bir User yaradın.</div>
        ) : unassigned.length === 0 ? (
          <div className={styles.empty}>Bütün instance-lar artıq təyin olunub.</div>
        ) : (
          <form action={assignInstance} className={styles.inlineForm}>
            <select className={styles.inlineInput} name="instanceId" defaultValue="" required>
              <option value="" disabled>
                Instance seç…
              </option>
              {unassigned.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name} {i.number ? `(${i.number})` : ""} — {i.connectionStatus}
                </option>
              ))}
            </select>
            <select className={styles.inlineInput} name="userId" defaultValue="" required>
              <option value="" disabled>
                User seç…
              </option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
            <SubmitButton variant="inline" label="Təyin et" pendingLabel="Təyin edilir…" />
          </form>
        )}
      </section>

      <div className={styles.footer}>Katibe Admin</div>
    </div>
    </>
  );
}
