import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import {
  loadPriorities,
  resolveOwner,
  tierOf,
  PRIORITIES_PATH,
  type Owner,
  type Priorities,
  type PriorityEntry,
} from "@mcp/config";
import { resolveChat, type ResolvedChat } from "@mcp/data";
import { buildBrief, type BriefArgs } from "@mcp/brief";
import { pool } from "@/lib/db";
import { getMcpStatus } from "@/lib/mcp-status";
import SearchSubmit from "@/components/SearchForm";
import {
  addEntryAction,
  moveEntryAction,
  removeEntryAction,
  saveBriefSettingsAction,
  saveKeywordsAction,
  updateEntryAction,
} from "./actions";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/**
 * MCP ayarları — Claude-un bu WhatsApp hesabını necə oxuduğunu buradan idarə edirsən.
 *
 * Ayarlar bazada yox, mcp/priorities.json faylındadır: MCP serveri onu hər alət
 * çağırışında yenidən oxuyur, ona görə burada «Yadda saxla» dediyin an növbəti
 * brifinq artıq yeni konfiqurla qurulur — restart lazım deyil.
 *
 * Səhifə üç suala cavab verməlidir: server sağdırmı, hansı söhbətlər önəmlidir,
 * və bu ayarlarla brifinq İNDİ nə göstərir. Sonuncu ona görə burdadır ki, tier
 * siyahısını kor-koranə doldurmaq — ən çox vaxt aparan hissə idi.
 */

const LISTS = [
  { key: "tier1" as const, title: "1-ci səviyyə", hint: "Həmişə brifinqdə — cavab gözləyib-gözləməməsindən asılı olmayaraq." },
  { key: "tier2" as const, title: "2-ci səviyyə", hint: "Yalnız səni gözləyəndə görünür." },
  { key: "mute" as const, title: "Susdurulmuşlar", hint: "Heç vaxt görünmür. Açar söz də bunları geri qaytarmır." },
];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("az-AZ", { dateStyle: "short", timeStyle: "short" });
}

function fmtUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} saat ${m} dəq` : `${m} dəq`;
}

/**
 * Önizləmə + nə qədər çəkdiyi.
 *
 * Komponentdən kənarda, çünki render gövdəsində Date.now() «impure» sayılır —
 * və ölçmə onsuz da bu funksiyaya aiddir, səhifəyə yox.
 */
async function runPreview(
  owner: Owner,
  priorities: Priorities,
  args: BriefArgs,
): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  try {
    return { text: await buildBrief(owner, priorities, args), ms: Date.now() - started };
  } catch (e) {
    return {
      text: `Önizləmə alınmadı: ${e instanceof Error ? e.message : String(e)}`,
      ms: Date.now() - started,
    };
  }
}

function keyOf(e: PriorityEntry): string {
  return e.jid?.trim() ? e.jid.trim() : `ad:${(e.name ?? "").trim().toLowerCase()}`;
}

const TIER_LABEL: Record<string, string> = {
  tier1: "1-ci səviyyə",
  tier2: "2-ci səviyyə",
  mute: "susdurulmuş",
  untiered: "səviyyəsiz",
};

export default async function McpSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; notice?: string; preview?: string; hours?: string; cap?: string }>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const priorities = loadPriorities();

  // Owner-in tapılmaması ölümcül deyil: ayarlar yenə redaktə oluna bilər, sadəcə
  // axtarış və önizləmə işləmir — ona görə səhifə uçmur, səbəbi yazır.
  const owner = await resolveOwner(pool).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  const ownerOk = typeof owner !== "string";

  const [status, hits] = await Promise.all([
    getMcpStatus(),
    ownerOk && q ? resolveChat(owner.instanceId, q, 12) : Promise.resolve([] as ResolvedChat[]),
  ]);

  // Önizləmə bahadır (bütün pəncərəni yenidən qurur), ona görə yalnız istənəndə.
  const wantsPreview = sp.preview === "1" && ownerOk;
  const previewHours = Number(sp.hours) || undefined;
  const previewCap = Number(sp.cap) || undefined;
  const preview = wantsPreview
    ? await runPreview(owner, priorities, { hours: previewHours, maxChatsPerSection: previewCap })
    : null;

  const usage = status.usage;
  const totalEntries = priorities.tier1.length + priorities.tier2.length + priorities.mute.length;

  return (
    <>
      <AppHeader section="Ayarlar" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>MCP ayarları</div>
          <div className={styles.subtitle}>
            <Link href="/">← Dashboard</Link> · Claude bu hesabı yalnız oxuyur; ayarlar{" "}
            <span className={styles.jid}>{PRIORITIES_PATH}</span> faylındadır və dərhal qüvvəyə minir
          </div>
        </div>
        <div className={styles.headerActions}>
          <Link href="/admin" className={styles.logoutButton}>
            🛠️ Admin
          </Link>
        </div>
      </header>

      {sp.notice && (
        <section className={styles.section}>
          <div className={styles.subtitle}>ℹ️ {sp.notice}</div>
        </section>
      )}

      {/* ---------------------------------------------------------------- status */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>
            {status.ok ? "🟢 Server işləyir" : "🔴 Server cavab vermir"}
          </div>
          <div className={styles.subtitle}>
            {status.ok
              ? `${status.tools.length} alət · yalnız oxuma`
              : (status.error ?? "səbəb bilinmir")}
          </div>
        </div>

        {!status.ok && status.error && <div className={styles.empty}>{status.error}</div>}

        <div className={styles.cards}>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Ünvan</div>
            <div className={styles.cardValue} style={{ fontSize: 14 }}>
              {status.publicUrl}
            </div>
            <div className={styles.subtitle}>
              daxili port {status.port} · token {status.tokenConfigured ? "var" : "YOXDUR"}
            </div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Hesab</div>
            <div className={styles.cardValue} style={{ fontSize: 14 }}>
              {ownerOk ? owner.userName : "?"}
            </div>
            <div className={styles.subtitle}>
              {ownerOk ? `${owner.instanceName} · ${owner.ownerJid ?? "jid yoxdur"}` : owner}
            </div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Sorğu (başlanğıcdan)</div>
            <div className={styles.cardValue}>{usage ? usage.requests : "—"}</div>
            <div className={styles.subtitle}>
              {usage ? `${fmtUptime(usage.startedAt)} işləyir · son: ${fmtDate(usage.lastRequestAt)}` : "sayğac yoxdur"}
            </div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardLabel}>Son alət</div>
            <div className={styles.cardValue} style={{ fontSize: 14 }}>
              {usage?.lastTool ? usage.lastTool.name : "—"}
            </div>
            <div className={styles.subtitle}>
              {usage?.lastTool ? fmtDate(usage.lastTool.at) : "hələ çağırılmayıb"}
            </div>
          </div>
        </div>

        {status.tools.length > 0 && (
          <table className={styles.table} style={{ marginTop: 16 }}>
            <thead>
              <tr>
                <th>Alət</th>
                <th>Nə edir</th>
                <th className={styles.numCell}>Çağırış</th>
              </tr>
            </thead>
            <tbody>
              {status.tools.map((t) => (
                <tr key={t.name}>
                  <td>
                    <span className={styles.jid}>{t.name}</span>
                    <div className={styles.subtitle}>{t.title}</div>
                  </td>
                  <td className={styles.subtitle}>{t.description}</td>
                  <td className={styles.numCell}>{usage?.tools?.[t.name] ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ------------------------------------------------------------- brifinq */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Brifinq pəncərəsi</div>
          <div className={styles.subtitle}>morning_brief və waiting_on_me bunlara baxır</div>
        </div>
        <form action={saveBriefSettingsAction}>
          <input type="hidden" name="q" value={q} />
          <div className={styles.inlineForm} style={{ flexWrap: "wrap", alignItems: "center" }}>
            <label className={styles.subtitle}>
              Neçə saat geriyə{" "}
              <input
                className={styles.rowInput}
                type="number"
                name="lookbackHours"
                min={1}
                max={720}
                defaultValue={priorities.lookbackHours}
                required
              />
            </label>
            <label className={styles.subtitle}>
              Bazar ertəsi{" "}
              <input
                className={styles.rowInput}
                type="number"
                name="mondayLookbackHours"
                min={1}
                max={720}
                defaultValue={priorities.mondayLookbackHours ?? ""}
                placeholder="boş = fərq yoxdur"
              />
            </label>
            <label className={styles.pill}>
              <input type="checkbox" name="groupsMentionOnly" defaultChecked={priorities.groupsMentionOnly} />{" "}
              Qruplarda yalnız mənə müraciət
            </label>
            <label className={styles.pill}>
              <input type="checkbox" name="includeUntiered" defaultChecked={priorities.includeUntiered} />{" "}
              Səviyyəsiz söhbətlər də görünsün
            </label>
          </div>
          <div className={styles.subtitle} style={{ marginTop: 14 }}>
            Adının qrupda yazıla biləcək variantları — hər sətirdə bir dənə. WhatsApp mention-u @lid
            kimi yazır, bunlar isə adının mətn içində keçdiyi halları tutur.
          </div>
          <textarea
            className={styles.inlineInput}
            name="mentionAliases"
            rows={3}
            style={{ width: "100%", marginTop: 8, fontFamily: "inherit" }}
            defaultValue={priorities.mentionAliases.join("\n")}
          />
          <div className={styles.inlineForm}>
            <button className={styles.inlineButton} type="submit">
              Yadda saxla
            </button>
          </div>
        </form>
      </section>

      {/* ------------------------------------------------------------ axtarış */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Söhbət əlavə et</div>
          <div className={styles.subtitle}>
            Ad, nömrə və ya jid ilə axtar — jid səhv yazılmasın deyə seçim siyahıdan olur
          </div>
        </div>
        <form className={styles.inlineForm} action="/settings/mcp" method="get">
          <input
            className={styles.inlineInput}
            type="search"
            name="q"
            defaultValue={q}
            placeholder="məsələn: Aygün, 994500000001, ABC"
          />
          <SearchSubmit />
        </form>

        {!ownerOk ? (
          <div className={styles.empty}>Hesab tapılmadı, axtarış işləmir: {owner}</div>
        ) : q && hits.length === 0 ? (
          <div className={styles.empty}>«{q}» üçün söhbət tapılmadı.</div>
        ) : hits.length > 0 ? (
          <table className={styles.table} style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>Söhbət</th>
                <th className={styles.numCell}>Mesaj</th>
                <th>Son</th>
                <th>İndi</th>
                <th>Əlavə et</th>
              </tr>
            </thead>
            <tbody>
              {hits.map((h) => {
                const tier = tierOf(priorities, h.jid, h.name);
                return (
                  <tr key={h.jid}>
                    <td>
                      {h.name}
                      <div className={styles.jid}>{h.jid}</div>
                    </td>
                    <td className={styles.numCell}>{h.messages}</td>
                    <td className={styles.subtitle}>{fmtDate(h.lastMessageAt)}</td>
                    <td>
                      <span className={styles.pill}>{TIER_LABEL[tier]}</span>
                    </td>
                    <td>
                      <div className={styles.pillList}>
                        {LISTS.map((l) => (
                          <form key={l.key} action={addEntryAction}>
                            <input type="hidden" name="q" value={q} />
                            <input type="hidden" name="list" value={l.key} />
                            <input type="hidden" name="jid" value={h.jid} />
                            <input type="hidden" name="name" value={h.name} />
                            <button className={styles.rowButton} type="submit" disabled={tier === l.key}>
                              {l.title}
                            </button>
                          </form>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </section>

      {/* ------------------------------------------------------------ tierlər */}
      {LISTS.map((l) => {
        const entries = priorities[l.key];
        return (
          <section key={l.key} className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>
                {l.title} ({entries.length})
              </div>
              <div className={styles.subtitle}>{l.hint}</div>
            </div>
            {entries.length === 0 ? (
              <div className={styles.empty}>Boşdur.</div>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Ad və qeyd</th>
                    <th>Ünvan</th>
                    <th>Əməliyyat</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const key = keyOf(e);
                    return (
                      <tr key={`${l.key}:${key}`}>
                        <td>
                          <form className={styles.rowForm} action={updateEntryAction}>
                            <input type="hidden" name="q" value={q} />
                            <input type="hidden" name="list" value={l.key} />
                            <input type="hidden" name="key" value={key} />
                            <input
                              className={styles.rowInput}
                              type="text"
                              name="name"
                              defaultValue={e.name ?? ""}
                              placeholder="ad"
                            />
                            <input
                              className={styles.rowInput}
                              style={{ width: 260 }}
                              type="text"
                              name="note"
                              defaultValue={e.note ?? ""}
                              placeholder="qeyd — niyə burdadır"
                            />
                            <button className={styles.rowButton} type="submit">
                              Yenilə
                            </button>
                          </form>
                        </td>
                        <td>
                          {e.jid ? (
                            <span className={styles.jid}>{e.jid}</span>
                          ) : (
                            <span className={styles.subtitle}>
                              adla uyğunlaşır — «{e.name}» keçən hər söhbət
                            </span>
                          )}
                        </td>
                        <td>
                          <div className={styles.pillList}>
                            {LISTS.filter((t) => t.key !== l.key).map((t) => (
                              <form key={t.key} action={moveEntryAction}>
                                <input type="hidden" name="q" value={q} />
                                <input type="hidden" name="key" value={key} />
                                <input type="hidden" name="to" value={t.key} />
                                <button className={styles.rowButton} type="submit">
                                  → {t.title}
                                </button>
                              </form>
                            ))}
                            <form action={removeEntryAction}>
                              <input type="hidden" name="q" value={q} />
                              <input type="hidden" name="list" value={l.key} />
                              <input type="hidden" name="key" value={key} />
                              <button className={styles.rowButton} type="submit">
                                Sil
                              </button>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {/* --------------------------------------------------------- açar sözlər */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Açar sözlər və e-poçt</div>
          <div className={styles.subtitle}>hər sətirdə bir dənə · böyük-kiçik hərf fərq etmir</div>
        </div>
        <form action={saveKeywordsAction}>
          <input type="hidden" name="q" value={q} />
          <div className={styles.twoCol}>
            <div>
              <div className={styles.cardLabel}>Həmişə göstər</div>
              <div className={styles.subtitle}>
                Bu sözlərdən biri keçən mesaj, kim yazmasından asılı olmayaraq brifinqə düşür —
                susdurulmuşlar istisna.
              </div>
              <textarea
                className={styles.inlineInput}
                name="alwaysKeywords"
                rows={5}
                style={{ width: "100%", marginTop: 8, fontFamily: "inherit" }}
                defaultValue={priorities.alwaysKeywords.join("\n")}
              />
            </div>
            <div>
              <div className={styles.cardLabel}>Səs-küy (heç vaxt)</div>
              <div className={styles.subtitle}>
                Bu sözlərdən biri keçən mesaj sayılmır. Söhbətin özü digər mesajlarına görə yenə
                görünə bilər.
              </div>
              <textarea
                className={styles.inlineInput}
                name="neverKeywords"
                rows={5}
                style={{ width: "100%", marginTop: 8, fontFamily: "inherit" }}
                defaultValue={priorities.neverKeywords.join("\n")}
              />
            </div>
          </div>
          <div className={styles.twoCol} style={{ marginTop: 16 }}>
            <div>
              <div className={styles.cardLabel}>E-poçt — həmişə</div>
              <div className={styles.subtitle}>
                Gmail ayrı MCP-dir, amma brifinq bir konfiqurdan oxunsun deyə göndərən siyahıları
                burada saxlanılır.
              </div>
              <textarea
                className={styles.inlineInput}
                name="emailAlwaysFrom"
                rows={4}
                style={{ width: "100%", marginTop: 8, fontFamily: "inherit" }}
                defaultValue={priorities.email.alwaysFrom.join("\n")}
              />
            </div>
            <div>
              <div className={styles.cardLabel}>E-poçt — heç vaxt</div>
              <div className={styles.subtitle}>Bülletenlər, avtomatik bildirişlər.</div>
              <textarea
                className={styles.inlineInput}
                name="emailNeverFrom"
                rows={4}
                style={{ width: "100%", marginTop: 8, fontFamily: "inherit" }}
                defaultValue={priorities.email.neverFrom.join("\n")}
              />
            </div>
          </div>
          <div className={styles.inlineForm}>
            <button className={styles.inlineButton} type="submit">
              Yadda saxla
            </button>
          </div>
        </form>
      </section>

      {/* ----------------------------------------------------------- önizləmə */}
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Brifinq önizləməsi</div>
          <div className={styles.subtitle}>
            Claude-a gedən mətnin EYNİSİ — eyni funksiya qurur. Model çağırılmır, pul xərclənmir.
          </div>
        </div>
        <form className={styles.inlineForm} action="/settings/mcp" method="get" style={{ flexWrap: "wrap" }}>
          <input type="hidden" name="preview" value="1" />
          {q && <input type="hidden" name="q" value={q} />}
          <label className={styles.subtitle}>
            Saat{" "}
            <input
              className={styles.rowInput}
              type="number"
              name="hours"
              min={1}
              max={720}
              defaultValue={previewHours ?? ""}
              placeholder={String(priorities.lookbackHours)}
            />
          </label>
          <label className={styles.subtitle}>
            Bölmə başına söhbət{" "}
            <input
              className={styles.rowInput}
              type="number"
              name="cap"
              min={1}
              max={100}
              defaultValue={previewCap ?? ""}
              placeholder="12"
            />
          </label>
          <button className={styles.inlineButton} type="submit">
            Göstər
          </button>
        </form>

        {totalEntries === 0 && (
          <div className={styles.empty}>
            Prioritet siyahısı boşdur — bu halda brifinq yalnız cavab gözləyənləri göstərir.
          </div>
        )}

        {preview === null ? (
          <div className={styles.empty}>
            «Göstər» de — bütün pəncərə yenidən qurulur, bu bir neçə saniyə çəkir, ona görə səhifə
            özü-özünə işə salmır.
          </div>
        ) : (
          <>
            <div className={styles.subtitle} style={{ marginBottom: 8 }}>
              {(preview.ms / 1000).toFixed(1)} saniyə · {preview.text.length} simvol
            </div>
            <pre className={styles.transcript} style={{ whiteSpace: "pre-wrap" }}>
              {preview.text}
            </pre>
          </>
        )}
      </section>

      <div className={styles.footer}>
        Bu ayarlar həm bu paneldən, həm də Claude-un update_priorities alətindən dəyişdirilə bilər —
        ikisi eyni faylı yazır.
      </div>
    </div>
    </>
  );
}
