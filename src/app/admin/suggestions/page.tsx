import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import {
  getAutoAppliedLabels,
  getPendingSuggestions,
  getSuggestionCounts,
  type SuggestionFilter,
} from "@/lib/queries";
import { CHAT_TYPE_LABELS } from "@/lib/jid";
import ChatLinks, { ChatTitleLink } from "@/components/ChatLinks";
import SelectionToolbar from "@/components/SelectionToolbar";
import SubmitButton from "@/components/SubmitButton";
import {
  acceptSelectedSuggestions,
  labelAsClient,
  rejectSelectedSuggestions,
  revertAutoLabelAction,
} from "./actions";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

const FILTERS: { key: SuggestionFilter; label: string }[] = [
  { key: "client", label: "Yalnız Client" },
  { key: "other", label: "Digər kateqoriyalar" },
  { key: "all", label: "Hamısı" },
];

/**
 * Review queue for the client sweep (scripts/identify-clients.ts).
 *
 * The sweep applies what it is sure about and leaves everything else here.
 * Hundreds of numbers can't be confirmed one at a time, so the whole page is
 * built around deciding a set at once: rows arrive pre-ticked and ordered
 * client-first, and the reviewer unticks the wrong ones instead of ticking
 * the right ones.
 */
export default async function SuggestionsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const filter: SuggestionFilter =
    sp.filter === "client" || sp.filter === "other" ? sp.filter : "client";

  const [pending, counts, auto] = await Promise.all([
    getPendingSuggestions(filter),
    getSuggestionCounts(),
    getAutoAppliedLabels(),
  ]);

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Client təyinatı</div>
          <div className={styles.subtitle}>
            <Link href="/admin">← Admin</Link> · AI-ın əmin olduqları avtomatik tətbiq olunub, qalanı
            burada təsdiq gözləyir
          </div>
        </div>
      </header>

      <section className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Təsdiq gözləyir</div>
          <div className={styles.cardValue}>{counts.pending.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Bunlardan Client təklifi</div>
          <div className={styles.cardValue}>{counts.pendingClients.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Avtomatik tətbiq olunub</div>
          <div className={styles.cardValue}>{counts.auto.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Bunlardan Client</div>
          <div className={styles.cardValue}>{counts.autoClients.toLocaleString("az-AZ")}</div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Təsdiq gözləyən təkliflər</div>
          <div className={styles.rangeGroup}>
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={`/admin/suggestions?filter=${f.key}`}
                className={filter === f.key ? styles.rangeLinkActive : styles.rangeLink}
              >
                {f.label}
              </Link>
            ))}
          </div>
        </div>

        {pending.length === 0 ? (
          <div className={styles.empty}>
            Bu filtrdə təsdiq gözləyən təklif yoxdur. Yeni nömrələri yoxlamaq üçün serverdə{" "}
            <code>npm run identify:clients</code> işlədin.
          </div>
        ) : (
          <form action={acceptSelectedSuggestions}>
            <input type="hidden" name="filter" value={filter} />

            <div className={styles.legend} style={{ marginBottom: 10 }}>
              {pending.length} sətir göstərilir · hamısı ilkin olaraq seçilib — səhv olanların
              qarşısındakı işarəni götürün, sonra “Qəbul et” düyməsinə basın.
            </div>

            <SelectionToolbar name="jid" total={pending.length} initialChecked={pending.length}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: 32 }}>✓</th>
                  <th>Kontakt</th>
                  <th>AI təklifi</th>
                  <th>Səbəb</th>
                  <th className={styles.numCell}>Mesaj</th>
                  <th>Tək-tək</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.jid}>
                    <td>
                      <input type="checkbox" name="jid" value={p.jid} defaultChecked />
                    </td>
                    <td>
                      <ChatTitleLink jid={p.jid} instances={p.instances}>
                        {p.ownName ?? <span className={styles.jid}>(WhatsApp adı yoxdur)</span>}
                      </ChatTitleLink>
                      {/* The number is the point of the whole client list, so it
                          leads — and its absence has to be just as visible,
                          since WhatsApp hides it for most @lid chats. */}
                      <div>
                        {p.phoneNumber ? (
                          <a href={`https://wa.me/${p.phoneNumber}`} target="_blank" rel="noreferrer">
                            +{p.phoneNumber}
                          </a>
                        ) : (
                          <span className={styles.jid}>nömrə gizlidir</span>
                        )}
                      </div>
                      <div className={styles.jid}>{p.jid}</div>
                      <div className={styles.jid}>{CHAT_TYPE_LABELS[p.chatType]}</div>
                      <ChatLinks jid={p.jid} instances={p.instances} />
                    </td>
                    <td>
                      <div>
                        <strong>{p.categoryName ?? "—"}</strong>{" "}
                        <span className={styles.confidenceBadge} data-level={p.confidence}>
                          {p.confidence}
                        </span>
                      </div>
                      {/* Only shown when it would actually be used: a chat that
                          already has a WhatsApp name keeps it. */}
                      {p.suggestedName && !p.ownName && (
                        <div className={styles.jid}>ad: {p.suggestedName}</div>
                      )}
                    </td>
                    <td>
                      <div className={styles.suggestionReason}>{p.reason}</div>
                    </td>
                    <td className={styles.numCell}>{p.messageCount.toLocaleString("az-AZ")}</td>
                    <td>
                      {!p.isClient && (
                        /* Bound, not a form field: this button sits in the
                           bulk form and brings its own action, and React
                           drops a submitter's name/value from the FormData
                           precisely in that case. */
                        <SubmitButton
                          action={labelAsClient.bind(null, p.jid)}
                          shared
                          variant="accent"
                          label="→ Client et"
                          pendingLabel="Client edilir…"
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </SelectionToolbar>

            <div className={styles.rowForm} style={{ marginTop: 14 }}>
              <SubmitButton
                shared
                variant="accent"
                label="✓ Seçilmişləri qəbul et"
                pendingLabel="Qəbul edilir…"
              />
              <SubmitButton
                action={rejectSelectedSuggestions}
                shared
                label="✕ Seçilmişləri rədd et"
                pendingLabel="Rədd edilir…"
              />
            </div>
          </form>
        )}

        {pending.length > 0 && (
          <form action={acceptSelectedSuggestions} className={styles.rowForm} style={{ marginTop: 10 }}>
            <input type="hidden" name="filter" value={filter} />
            {/* `all` ignores the checkboxes and takes the whole filtered queue,
                including rows past the 300 this page renders. */}
            <input type="hidden" name="all" value="1" />
            <SubmitButton
              label={`Bu filtrdəki bütün ${filter === "client" ? "Client " : ""}təklifləri qəbul et`}
              pendingLabel="Hamısı qəbul edilir — bu bir neçə saniyə çəkir…"
            />
          </form>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Avtomatik tətbiq olunanlar</div>
          <div className={styles.legend}>{auto.length} qeyd</div>
        </div>
        <div className={styles.legend} style={{ marginBottom: 10 }}>
          AI bunlarda əmin olduğu üçün etiket birbaşa yazılıb. Səhv görsəniz “Geri al” — etiket
          silinir və nömrə yenidən adsız qalır.
        </div>

        {auto.length === 0 ? (
          <div className={styles.empty}>Hələ avtomatik tətbiq olunmuş etiket yoxdur.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Kontakt</th>
                <th>Kateqoriya</th>
                <th>Səbəb</th>
                <th className={styles.numCell}>Mesaj</th>
                <th>Geri al</th>
              </tr>
            </thead>
            <tbody>
              {auto.map((a) => (
                <tr key={a.jid}>
                  <td>
                    {a.name}
                    <div className={styles.jid}>{a.jid}</div>
                  </td>
                  <td>{a.categoryName ?? "—"}</td>
                  <td>
                    <div className={styles.suggestionReason}>{a.reason}</div>
                  </td>
                  <td className={styles.numCell}>{a.messageCount.toLocaleString("az-AZ")}</td>
                  <td>
                    <form action={revertAutoLabelAction}>
                      <input type="hidden" name="jid" value={a.jid} />
                      <button className={styles.rowButton} type="submit">
                        ↩ Geri al
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className={styles.footer}>
        Client etiketi bütün hesablarda eyni nömrəyə şamil olunur — bir dəfə təsdiqlə, hər yerdə
        görünsün.
      </div>
    </div>
    </>
  );
}
