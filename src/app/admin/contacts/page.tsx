import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import { getCategories, getCategoryCounts, getDirectory } from "@/lib/queries";
import { setChatLabel } from "../../chat-actions";
import { CHAT_TYPE_LABELS } from "@/lib/jid";
import ChatLinks, { ChatTitleLink } from "@/components/ChatLinks";
import SearchSubmit from "@/components/SearchForm";
import SubmitButton from "@/components/SubmitButton";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/**
 * The shared contact directory.
 *
 * Names live in katibe.contact_labels, keyed by JID with no instance column,
 * so a name typed once already applies to every account that talks to that
 * number. This page is where that shared map can be seen and edited in one
 * place, including which accounts each contact appears in.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cat?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const query = (sp.q ?? "").slice(0, 100);
  // "none" is its own bucket, so an absent `cat` means "all" and cannot be
  // conflated with "uncategorised".
  const cat: number | "none" | undefined =
    sp.cat === "none" ? "none" : sp.cat && Number.isInteger(Number(sp.cat)) ? Number(sp.cat) : undefined;

  const [entries, categories, counts] = await Promise.all([
    getDirectory(query, { categoryId: cat }),
    getCategories(),
    getCategoryCounts(),
  ]);

  // Keeping the search term while switching category — and vice versa — is
  // the whole point of filtering; dropping one when the other changes makes
  // the bar feel like it resets.
  const hrefFor = (next?: number | "none") => {
    const p = new URLSearchParams();
    if (next !== undefined) p.set("cat", String(next));
    if (query) p.set("q", query);
    const qs = p.toString();
    return `/admin/contacts${qs ? `?${qs}` : ""}`;
  };
  const activeName =
    cat === undefined ? null : cat === "none" ? "Kateqoriyasız" : (counts.find((c) => c.id === cat)?.name ?? null);

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Ortaq kontakt bazası</div>
          <div className={styles.subtitle}>
            <Link href="/admin">← Admin</Link> · burada verilən ad bütün hesablarda görünür
          </div>
        </div>
      </header>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>{activeName ?? "Adlandırılmış kontaktlar"}</div>
          <div className={styles.legend}>{entries.length} qeyd</div>
        </div>

        <div className={styles.rangeGroup} style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <Link href={hrefFor()} className={cat === undefined ? styles.rangeLinkActive : styles.rangeLink}>
            Hamısı
          </Link>
          {counts.map((c) => (
            <Link
              key={c.id ?? "none"}
              href={hrefFor(c.id ?? "none")}
              className={
                (c.id === null ? cat === "none" : cat === c.id) ? styles.rangeLinkActive : styles.rangeLink
              }
            >
              {c.name} ({c.contacts})
            </Link>
          ))}
        </div>

        <form method="GET" action="/admin/contacts" className={styles.inlineForm}>
          {cat !== undefined && <input type="hidden" name="cat" value={String(cat)} />}
          <input
            className={styles.inlineInput}
            type="text"
            name="q"
            placeholder="Ad, qrup adı və ya nömrə/JID ilə axtar…"
            defaultValue={query}
          />
          <SearchSubmit />
          {(query || cat !== undefined) && (
            <Link href="/admin/contacts" className={styles.logoutButton}>
              Təmizlə
            </Link>
          )}
        </form>

        {entries.length === 0 ? (
          <div className={styles.empty}>
            {query || cat !== undefined
              ? "Bu filtrə uyğun kontakt tapılmadı."
              : "Hələ heç bir kontakta ad verilməyib. Dashboard-dakı Chat-lər bölməsindən başlaya bilərsən."}
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ad / nömrə</th>
                <th>Növ</th>
                <th>Hansı hesablarda</th>
                <th className={styles.numCell}>Mesaj</th>
                <th>Dəyiş</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.jid}>
                  <td>
                    <ChatTitleLink jid={e.jid} instances={e.instances}>
                      {e.displayName ?? (
                        <span className={styles.jid}>{e.groupSubject ?? "ad yoxdur"}</span>
                      )}
                    </ChatTitleLink>
                    {e.chatType !== "group" &&
                      (e.phoneNumber ? (
                        <div>
                          <a href={`https://wa.me/${e.phoneNumber}`} target="_blank" rel="noreferrer">
                            +{e.phoneNumber}
                          </a>
                        </div>
                      ) : (
                        <div className={styles.jid}>nömrə gizlidir</div>
                      ))}
                    <div className={styles.jid}>{e.jid}</div>
                    {e.categoryName && <div className={styles.jid}>{e.categoryName}</div>}
                  </td>
                  <td>
                    <span className={styles.jid}>{CHAT_TYPE_LABELS[e.chatType]}</span>
                  </td>
                  <td>
                    <ChatLinks jid={e.jid} instances={e.instances} />
                  </td>
                  <td className={styles.numCell}>{e.messageCount.toLocaleString("az-AZ")}</td>
                  <td>
                    <form action={setChatLabel} className={styles.rowForm}>
                      <input type="hidden" name="jid" value={e.jid} />
                      <input
                        className={styles.rowInput}
                        type="text"
                        name="displayName"
                        placeholder="Ad"
                        defaultValue={e.displayName ?? ""}
                      />
                      <select className={styles.rowInput} name="categoryId" defaultValue={e.categoryId ?? ""}>
                        <option value="">Kateqoriya…</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <SubmitButton label="Saxla" pendingLabel="Saxlanılır…" />
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className={styles.footer}>
        Bir dəfə ad ver — həmin nömrə/qrup bütün hesablarda eyni adla görünür.
      </div>
    </div>
    </>
  );
}
