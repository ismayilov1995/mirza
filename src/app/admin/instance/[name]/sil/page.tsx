import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import { getInstanceDeletionFacts, protectedInstanceName } from "@/lib/instance-delete";
import { deleteInstanceAction } from "@/app/admin/actions";
import SubmitButton from "@/components/SubmitButton";
import styles from "../../../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/*
 * Nömrənin silinməsi — təsdiq ekranı.
 *
 * Ayrıca səhifədir, modal deyil, çünki burada oxunacaq rəqəm var və onların
 * bir hissəsi (Evolution mesajları) 65 min sətirlik sayğacdır: modal açılana
 * qədər gözlədən düymə "işləmir" kimi oxunur. Səhifə həm də linkdir — silmək
 * qərarını verən adam onu göndərə, geri düyməsi ilə çıxa bilər.
 *
 * Ekranın işi yalnız GÖSTƏRMƏKDİR. Şərtləri deleteInstanceAction yenidən
 * oxuyur: bu səhifədə düymənin sönük olması qorunma deyil, xəbərdarlıqdır.
 */

function statusWord(status: string): string {
  if (status === "open") return "qoşulu";
  if (status === "connecting") return "qoşulmağa çalışır";
  return "qoşulu deyil";
}

export default async function DeleteInstancePage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ xeta?: string }>;
}) {
  await requireAdmin();
  const { name: raw } = await params;
  const name = decodeURIComponent(raw);
  const { xeta } = await searchParams;

  const facts = await getInstanceDeletionFacts(name);
  const guarded = facts !== null && facts.name === protectedInstanceName();
  // Tarixçə iki yerdədir və ikisi ayrı ölür: Evolution mesajları kaskadla,
  // anbardakı nüsxələr bizim təmizləmə ilə. Qutu ikisini birdən soruşur.
  const history = facts === null ? 0 : facts.messages + facts.mirroredMessages;

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>{name}</div>
          <div className={styles.subtitle}>
            <Link href="/admin">← Admin</Link> · nömrəni sistemdən çıxar
          </div>
        </div>
      </header>

      {xeta ? (
        <div className={styles.noticeDanger} role="alert">
          {xeta}
        </div>
      ) : null}

      {facts === null ? (
        <section className={styles.section}>
          <div className={styles.empty}>
            «{name}» adlı nömrə yoxdur — silinib və ya adı dəyişib.
          </div>
        </section>
      ) : (
        <>
          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>Silinəcək nömrə</div>
            </div>

            <dl className={styles.factList}>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>Vəziyyət</dt>
                <dd className={styles.factValue}>
                  {statusWord(facts.connectionStatus)}{" "}
                  <span className={styles.jid}>({facts.connectionStatus})</span>
                </dd>
              </div>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>Nömrə</dt>
                <dd className={styles.factValue}>{facts.number ?? "—"}</dd>
              </div>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>Sahibi</dt>
                <dd className={styles.factValue}>{facts.ownerName ?? "təyin olunmayıb"}</dd>
              </div>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>Yaradılıb</dt>
                <dd className={styles.factValue}>{facts.createdAt.toISOString().slice(0, 10)}</dd>
              </div>
            </dl>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>Nə gedəcək</div>
            </div>

            <dl className={styles.factList}>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>WhatsApp mesajları</dt>
                <dd className={styles.factValue}>
                  {facts.messages.toLocaleString("az-AZ")}
                  <span className={styles.jid}> · Evolution bazasından</span>
                </dd>
              </div>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>Söhbətlər</dt>
                <dd className={styles.factValue}>{facts.chats.toLocaleString("az-AZ")}</dd>
              </div>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>Anbardakı nüsxələr</dt>
                <dd className={styles.factValue}>
                  {facts.mirroredMessages.toLocaleString("az-AZ")}
                  <span className={styles.jid}> · axtarış, arxiv və statistika bunun üstündədir</span>
                </dd>
              </div>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>Bayraqlar</dt>
                <dd className={styles.factValue}>{facts.flags.toLocaleString("az-AZ")}</dd>
              </div>
              <div className={styles.factRow}>
                <dt className={styles.factLabel}>Təyinat tarixçəsi</dt>
                <dd className={styles.factValue}>{facts.assignments} sətir</dd>
              </div>
            </dl>

            <ul className={styles.muteList}>
              <li>
                Telefon WhatsApp-dan çıxarılır: qoşulu idisə, əlaqə kəsilir və QR yenidən
                skan edilmədən qayıtmır.
              </li>
              <li>
                Yuxarıdakı sətirlər <b>həmişəlik</b> gedir — geri qaytaran ekran yoxdur,
                yalnız bazanın nüsxəsi.
              </li>
              <li>
                Başqa mənbədə də görünən söhbətlərə toxunulmur: onlardan yalnız bu
                nömrənin izi silinir.
              </li>
              <li>Telefonun özündəki yazışmalara heç nə olmur — bura yalnız oxuyurdu.</li>
            </ul>
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHeader}>
              <div className={styles.sectionTitle}>Təsdiq</div>
            </div>

            {guarded ? (
              <div className={styles.empty}>
                «{facts.name}» panelin öz nömrəsidir (<span className={styles.jid}>EVOLUTION_INSTANCE_NAME</span>)
                — media və səs endirmə onun üzərindən gedir. Silmək üçün əvvəlcə həmin ayar
                başqa nömrəyə keçirilməlidir.
              </div>
            ) : (
              <form action={deleteInstanceAction} className={styles.confirmForm}>
                <input type="hidden" name="name" value={facts.name} />

                {history > 0 ? (
                  <label className={styles.checkRow}>
                    <input type="checkbox" name="withHistory" />
                    <span>
                      Bilirəm ki, <b>{history.toLocaleString("az-AZ")}</b> mesaj da silinir.
                    </span>
                  </label>
                ) : null}

                <label className={styles.muteLabel} htmlFor="confirm-name">
                  Təsdiq üçün nömrənin adını yaz: <b>{facts.name}</b>
                </label>
                <input
                  id="confirm-name"
                  className={styles.inlineInput}
                  type="text"
                  name="confirm"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder={facts.name}
                  required
                />

                <div className={styles.confirmActions}>
                  <Link href="/admin" className={styles.logoutButton}>
                    İmtina
                  </Link>
                  <SubmitButton variant="danger" label="Nömrəni sil" pendingLabel="Silinir…" />
                </div>
              </form>
            )}
          </section>
        </>
      )}
    </div>
    </>
  );
}
