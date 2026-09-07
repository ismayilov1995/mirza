import Link from "next/link";
import {
  getCategories,
  getChats,
  CHAT_PAGE_SIZE,
  MIN_CHAT_MESSAGES,
  AWAITING_RECENT_DAYS,
  type ChatFilter,
  type ChatTypeFilter,
} from "@/lib/queries";
import { acceptSuggestion, rejectSuggestion, setChatLabel } from "../../chat-actions";
import { CHAT_TYPE_LABELS } from "@/lib/jid";
import FilterLink from "@/components/FilterLink";
import SearchSubmit from "@/components/SearchForm";
import styles from "../../dashboard.module.css";
import type { ScopedInstanceId } from "@/lib/access";

export interface ChatSectionParams {
  instanceId: ScopedInstanceId;
  chatFilter: ChatFilter;
  typeFilter: ChatTypeFilter;
  query: string;
  page: number;
  includeQuiet: boolean;
}

const CHAT_FILTERS: { key: ChatFilter; label: string }[] = [
  { key: "unnamed", label: "Adsızlar" },
  { key: "named", label: "Adlılar" },
  { key: "suggested", label: "🤖 AI təklifi" },
  { key: "all", label: "Hamısı" },
];

const TYPE_FILTERS: { key: ChatTypeFilter; label: string }[] = [
  { key: "all", label: "Hamısı" },
  { key: "group", label: "👥 Qrup" },
  { key: "individual", label: "👤 Fərdi" },
  { key: "lid", label: "🔒 Gizli" },
];

/** Skeleton shown by the Suspense boundary while a filter change is in flight. */
export function ChatSectionSkeleton() {
  return (
    <section className={styles.section}>
      <div className={styles.summaryLoading}>
        <span className={styles.spinner} aria-hidden />
        <div>Chat-lər yüklənir…</div>
      </div>
    </section>
  );
}

export default async function ChatSection({
  instanceId,
  chatFilter,
  typeFilter,
  query,
  page,
  includeQuiet,
}: ChatSectionParams) {
  // A search is meant to find one chat wherever it sits, so it isn't narrowed
  // by the named/unnamed tab the user happens to be on — nor by the
  // low-volume gate, which getChats drops for any non-empty search.
  const effectiveFilter: ChatFilter = query.trim() ? "all" : chatFilter;

  const [chatData, categories] = await Promise.all([
    getChats(instanceId, {
      named: effectiveFilter,
      type: typeFilter,
      search: query,
      page,
      includeQuiet,
    }),
    getCategories(),
  ]);

  // Changing any filter returns to page 1 — staying on page 7 of a list that
  // just shrank to two pages shows an empty table.
  const url = (o: Partial<ChatSectionParams>) => {
    const p = new URLSearchParams({
      chats: String(o.chatFilter ?? chatFilter),
      type: String(o.typeFilter ?? typeFilter),
    });
    const q = o.query ?? query;
    if (q) p.set("q", q);
    if (o.includeQuiet ?? includeQuiet) p.set("quiet", "1");
    const pg = o.page ?? 1;
    if (pg > 1) p.set("page", String(pg));
    return `/i/${instanceId}/labels?${p.toString()}`;
  };

  const first = chatData.matchCount === 0 ? 0 : (chatData.page - 1) * CHAT_PAGE_SIZE + 1;
  const last = (chatData.page - 1) * CHAT_PAGE_SIZE + chatData.shown;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div className={styles.sectionTitle}>Kontakta ad və kateqoriya ver</div>
        <div className={styles.legend}>
          {chatData.namedCount} adlı · {chatData.unnamedCount} adsız
          {chatData.suggestedCount > 0 && ` · 🤖 ${chatData.suggestedCount} təklif gözləyir`}
        </div>
        <div className={styles.filterStack}>
          <div className={styles.rangeGroup}>
            {CHAT_FILTERS.map((f) => (
              <FilterLink key={f.key} href={url({ chatFilter: f.key })} active={f.key === chatFilter}>
                {f.label}
              </FilterLink>
            ))}
          </div>
          <div className={styles.rangeGroup}>
            {TYPE_FILTERS.map((f) => (
              <FilterLink key={f.key} href={url({ typeFilter: f.key })} active={f.key === typeFilter}>
                {f.label}
              </FilterLink>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.subtitle} style={{ marginBottom: 10 }}>
        WhatsApp bu kontaktlar üçün heç bir ad göndərmir (telefon kitabçasında yoxdurlar, ya da{" "}
        <code>@lid</code> ilə nömrələri gizlədilib) — Evolution-da da bu ad mövcud deyil, ona görə əl ilə
        vermək lazımdır. Verdiyin ad <strong>qlobaldır</strong>: bütün cədvəllərdə həmin adla görünəcək.
      </div>

      {/* The gate is worth stating plainly, because a chat someone remembers
          seeing here can now be missing, and the reason is not guessable. */}
      {!query && (chatData.quietCount > 0 || includeQuiet) && (
        <div className={styles.subtitle} style={{ marginBottom: 10 }}>
          {includeQuiet ? (
            <>
              Bütün chat-lər göstərilir — <strong>{MIN_CHAT_MESSAGES}</strong> mesajdan az olanlar da
              daxil.{" "}
              <Link href={url({ includeQuiet: false })}>Az mesajlıları gizlət</Link>
            </>
          ) : (
            <>
              <strong>{chatData.quietCount}</strong> sakit chat gizlədilib ({MIN_CHAT_MESSAGES}{" "}
              mesajdan az). Son {AWAITING_RECENT_DAYS} gündə bizdən cavab gözləyənlər gizlədilmir.{" "}
              <Link href={url({ includeQuiet: true })}>Hamısını göstər</Link>
            </>
          )}
        </div>
      )}

      <form method="GET" action={`/i/${instanceId}/labels`} className={styles.inlineForm}>
        <input type="hidden" name="chats" value={chatFilter} />
        <input type="hidden" name="type" value={typeFilter} />
        {includeQuiet && <input type="hidden" name="quiet" value="1" />}
        <input
          className={styles.inlineInput}
          type="text"
          name="q"
          placeholder="Ad və ya nömrə/JID ilə axtar…"
          defaultValue={query}
        />
        <SearchSubmit />
        {query && (
          <Link href={url({ query: "" })} className={styles.logoutButton}>
            Təmizlə
          </Link>
        )}
      </form>
      {query && (
        <div className={styles.subtitle} style={{ marginTop: 8 }}>
          &quot;{query}&quot; üzrə {chatData.matchCount} nəticə (bütün chat-lər arasında axtarılır — az
          mesajlılar da daxil).
        </div>
      )}

      {chatData.chats.length === 0 ? (
        <div className={styles.empty}>
          {chatFilter === "unnamed" && chatData.unnamedCount === 0
            ? "Adsız chat qalmayıb — hamısının adı var. 🎉"
            : "Bu filtrdə chat tapılmadı."}
        </div>
      ) : (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Kontakt</th>
                <th className={styles.numCell}>Mesaj</th>
                <th>Növ</th>
                <th>Cari ad / kateqoriya</th>
                <th>🤖 AI təklifi</th>
                <th>Yenilə</th>
              </tr>
            </thead>
            <tbody>
              {chatData.chats.map((c) => (
                <tr key={c.jid}>
                  <td>
                    {c.needsLabel && (
                      <span className={styles.needsLabelBadge} title="WhatsApp bunun üçün ad vermir">
                        🏷️{" "}
                      </span>
                    )}
                    {/* prefetch={false}: a full page of these fires one server
                        render per link on hover/viewport, and each chat page
                        aggregates the Message table. */}
                    <Link
                      href={`/i/${instanceId}/chat/${encodeURIComponent(c.jid)}`}
                      className={styles.chatLink}
                      prefetch={false}
                      title="Yazışmanı və AI xülasəsini gör"
                    >
                      {c.contactName}
                    </Link>
                    {c.awaitingReply && (
                      <span
                        className={styles.awaitingBadge}
                        style={{ marginLeft: 6 }}
                        title={`Son mesaj onlardandır (son ${AWAITING_RECENT_DAYS} gün)`}
                      >
                        bizi gözləyir
                      </span>
                    )}
                    <div className={styles.jid}>{c.jid}</div>
                  </td>
                  <td className={styles.numCell}>{c.msgCount.toLocaleString("az-AZ")}</td>
                  <td>
                    <span className={styles.jid}>{CHAT_TYPE_LABELS[c.chatType]}</span>
                  </td>
                  <td>
                    {c.displayName ?? <span className={styles.jid}>ad yoxdur</span>}
                    {c.categoryName && <div className={styles.jid}>{c.categoryName}</div>}
                  </td>
                  <td>
                    {c.suggestion ? (
                      <div>
                        <div>
                          {c.suggestion.name ?? (
                            <span className={styles.jid}>(yalnız kateqoriya)</span>
                          )}{" "}
                          <span className={styles.confidenceBadge} data-level={c.suggestion.confidence}>
                            {c.suggestion.confidence}
                          </span>
                        </div>
                        {c.suggestion.categoryName && (
                          <div className={styles.jid}>{c.suggestion.categoryName}</div>
                        )}
                        {c.suggestion.reason && (
                          <div className={styles.suggestionReason}>{c.suggestion.reason}</div>
                        )}
                        <div className={styles.rowForm} style={{ marginTop: 6 }}>
                          <form action={acceptSuggestion}>
                            <input type="hidden" name="instanceId" value={instanceId} />
                            <input type="hidden" name="jid" value={c.jid} />
                            <button className={styles.acceptButton} type="submit">
                              ✓ Qəbul et
                            </button>
                          </form>
                          <form action={rejectSuggestion}>
                            <input type="hidden" name="instanceId" value={instanceId} />
                            <input type="hidden" name="jid" value={c.jid} />
                            <button className={styles.rowButton} type="submit">
                              ✕
                            </button>
                          </form>
                        </div>
                      </div>
                    ) : (
                      <span className={styles.jid}>—</span>
                    )}
                  </td>
                  <td>
                    <form action={setChatLabel} className={styles.rowForm}>
                      <input type="hidden" name="jid" value={c.jid} />
                      <input type="hidden" name="instanceId" value={instanceId} />
                      <input
                        className={styles.rowInput}
                        type="text"
                        name="displayName"
                        placeholder="Ad"
                        defaultValue={c.displayName ?? ""}
                      />
                      <select className={styles.rowInput} name="categoryId" defaultValue={c.categoryId ?? ""}>
                        <option value="">Kateqoriya…</option>
                        {categories.map((cat) => (
                          <option key={cat.id} value={cat.id}>
                            {cat.name}
                          </option>
                        ))}
                      </select>
                      <button className={styles.rowButton} type="submit">
                        Saxla
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className={styles.pager}>
            <span className={styles.jid}>
              {first}–{last} / {chatData.matchCount}
            </span>
            <div className={styles.rangeGroup}>
              {chatData.page > 1 && (
                <FilterLink href={url({ page: chatData.page - 1 })}>← Əvvəlki</FilterLink>
              )}
              <span className={styles.jid} style={{ alignSelf: "center" }}>
                {chatData.page} / {chatData.pageCount}
              </span>
              {chatData.page < chatData.pageCount && (
                <FilterLink href={url({ page: chatData.page + 1 })}>Növbəti →</FilterLink>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
