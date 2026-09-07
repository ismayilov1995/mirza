import Link from "next/link";
import { myInstances, requireAdmin } from "@/lib/access";
import {
  getRatingSummary,
  listSuppressionEvents,
  listSuppressions,
  RATING_LABELS,
  type SuppressionOutcome,
} from "@/lib/supervisor/ratings";
import { revokeAgentSuppression } from "@/app/agent-actions";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/**
 * Susdurmaların auditi.
 *
 * Bu səhifə olmasa reytinq 1 kor bir düymə olardı: susdurulmuş bayraq lentdə
 * görünmür, deməli səhv susdurmanın heç bir əlaməti qalmır. Ona görə hər
 * qarşılaşma jurnala yazılır və burada göstərilir — həm gizlədilənlər, həm də
 * klapanların buraxdıqları.
 *
 * "Yenidən göstər" bir kliklə susdurmanı ləğv edir; həmin söhbətdə bayraq
 * növbəti gedişatdan etibarən yenidən çıxır.
 */

const OUTCOME_LABELS: Record<SuppressionOutcome, string> = {
  SUPPRESSED: "gizlədildi",
  ESCALATED: "bal qalxdı — buraxıldı",
  DIFFERENT: "vəziyyət dəyişib — buraxıldı",
  EXPIRED: "müddəti bitdi",
  SNOOZE_BROKEN: "möhlət pozuldu — bayraq qayıtdı",
  SNOOZE_KEPT: "möhlət tutdu — problem həll olundu",
};

const DETECTOR_LABELS: Record<string, string> = {
  unanswered: "cavabsız",
  customer_deciding: "qərar mərhələsi",
  silence: "susqunluq",
};

function bakuTime(iso: string): string {
  return new Intl.DateTimeFormat("az-AZ", {
    timeZone: "Asia/Baku",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function bakuDay(iso: string): string {
  return new Intl.DateTimeFormat("az-AZ", {
    timeZone: "Asia/Baku",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

export default async function SuppressionsPage() {
  await requireAdmin();
  const scope = await myInstances();
  const [suppressions, events, ratings] = await Promise.all([
    listSuppressions(scope),
    listSuppressionEvents(scope),
    getRatingSummary(scope),
  ]);

  const active = suppressions.filter((s) => s.revokedAt === null);
  const totalHidden = suppressions.reduce((n, s) => n + s.suppressedCount, 0);
  const totalReleased = suppressions.reduce((n, s) => n + s.releasedCount, 0);
  const ratedTotal = ratings.reduce((n, r) => n + r.count, 0);

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>Susdurulmuş bayraqlar</div>
          <div className={styles.subtitle}>
            <Link href="/admin">← Admin</Link> · lentdə «1 — Lazımsız» verilən və «Bir daha
            göstərmə» ilə birdəfəlik bağlanan bayraqlar burada hesabat verir. Susdurulmuş bayraq heç
            yerdə görünmür, ona görə səhv susdurmanı yalnız bu siyahı üzə çıxara bilər.
          </div>
        </div>
      </header>

      <section className={styles.cards}>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Qüvvədə olan susdurma</div>
          <div className={styles.cardValue}>{active.length.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Gizlədilmiş bayraq</div>
          <div className={styles.cardValue}>{totalHidden.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Klapan işə düşüb</div>
          <div className={styles.cardValue}>{totalReleased.toLocaleString("az-AZ")}</div>
        </div>
        <div className={styles.card}>
          <div className={styles.cardLabel}>Qiymətləndirilmiş bayraq</div>
          <div className={styles.cardValue}>{ratedTotal.toLocaleString("az-AZ")}</div>
        </div>
      </section>

      {ratings.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionTitle}>Dataset — menecerin qiymətləri</div>
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Qiymət</th>
                <th>Mənası</th>
                <th className={styles.numCell}>Say</th>
              </tr>
            </thead>
            <tbody>
              {ratings.map((r) => (
                <tr key={r.rating}>
                  <td>{r.rating}</td>
                  <td>{RATING_LABELS[r.rating]}</td>
                  <td className={styles.numCell}>{r.count.toLocaleString("az-AZ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.legend}>
            1 və 5 verilən son bayraqlar Nəzarətçinin promptuna nümunə kimi əlavə olunur — model
            növbəti dəfə bu evdə nəyin lazımsız, nəyin vacib sayıldığını görür.
          </div>
        </section>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Susdurmalar</div>
        </div>
        {suppressions.length === 0 ? (
          <div className={styles.empty}>Hələ heç bir bayraq susdurulmayıb.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Söhbət</th>
                <th>Bayraq növü</th>
                <th className={styles.numCell}>Gizlədilib</th>
                <th className={styles.numCell}>Buraxılıb</th>
                <th>Müddət</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {suppressions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link
                      href={`/i/${s.instanceId}/chat/${encodeURIComponent(s.remoteJid)}`}
                      className={styles.jid}
                    >
                      {s.contact ?? s.remoteJid}
                    </Link>
                    <div className={styles.suggestionReason}>
                      {s.userName ? `${s.userName} · ` : ""}
                      {s.createdBy ? `${s.createdBy} rədd etdi · ` : ""}
                      {bakuDay(s.createdAt)} · rədd anındakı bal {s.baseSeverity}
                    </div>
                  </td>
                  <td>{DETECTOR_LABELS[s.detector] ?? s.detector}</td>
                  <td className={styles.numCell}>{s.suppressedCount}</td>
                  <td className={styles.numCell}>{s.releasedCount}</td>
                  <td>
                    {/* Möhlətin nəticəsi ləğv tarixindən ƏVVƏL yazılır: müddəti
                        bitmiş möhlət texniki olaraq «ləğv olunub», amma menecerin
                        sualı o deyil — «bəs problem qaldımı?» sualıdır və cavab
                        bir-iki gedişat sonra gəlir. */}
                    {s.snoozeOutcomePending && s.revokedAt ? (
                      `${s.snoozeDays} gün möhlət bitdi · nəticə gözlənilir`
                    ) : s.revokedAt ? (
                      `ləğv olunub · ${bakuDay(s.revokedAt)}`
                    ) : s.permanent ? (
                      <span className={styles.sfHow} data-how="MUTED">
                        <span className={styles.sfHowDot} />
                        daimi · «Bir daha göstərmə»
                      </span>
                    ) : s.snoozeDays !== null && s.expiresAt ? (
                      `${s.snoozeDays} gün möhlət · ${bakuDay(s.expiresAt)} 09:00-dək`
                    ) : s.expiresAt ? (
                      `${bakuDay(s.expiresAt)}-ə qədər`
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {s.revokedAt === null ? (
                      <form action={revokeAgentSuppression} className={styles.rowForm}>
                        <input type="hidden" name="suppressionId" value={s.id} />
                        <button type="submit" className={styles.rowButton}>
                          Yenidən göstər
                        </button>
                      </form>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className={styles.legend}>
          «1 — Lazımsız» ilə açılan susdurma üç halda öz-özünə keçilir: müddəti bitəndə (30 gün),
          bayrağın balı rədd anındakından 2 vahid qalxanda, və söhbətin son mesajları vəziyyətin
          dəyişdiyini göstərəndə. Hər üçü aşağıdakı jurnalda görünür. <b>Daimi</b> susdurmada
          (lentdəki «Bir daha göstərmə» düyməsi) bu üç klapanın heç biri işləmir — onu yalnız
          buradakı «Yenidən göstər» ləğv edə bilər.
          {" "}
          <b>Möhlət</b> (lentdəki «Möhlət ver») üçüncü haldır: müddəti var, eskalasiya klapanı
          işləyir, amma model rəyi soruşulmur — və müddət bitəndə nəticəsini özü yazır. Jurnalda
          «möhlət pozuldu» sətri bayrağın həqiqətən geri qayıtdığını, «möhlət tutdu» isə
          qayıtmadığını bildirir.
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Jurnal — nə susduruldu, nə buraxıldı</div>
        </div>
        {events.length === 0 ? (
          <div className={styles.empty}>Hələ heç bir susdurma hadisəsi qeydə alınmayıb.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Vaxt</th>
                <th>Söhbət</th>
                <th className={styles.numCell}>Bal</th>
                <th>Nəticə</th>
                <th>Səbəb</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{bakuTime(e.createdAt)}</td>
                  <td>
                    <Link
                      href={`/i/${e.instanceId}/chat/${encodeURIComponent(e.remoteJid)}`}
                      className={styles.jid}
                    >
                      {e.contact ?? e.remoteJid}
                    </Link>
                  </td>
                  <td className={styles.numCell}>{e.wouldBeSeverity}</td>
                  <td>{OUTCOME_LABELS[e.outcome]}</td>
                  <td className={styles.suggestionReason}>{e.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <footer className={styles.footer}>
        Susdurma yalnız həmin söhbət + həmin bayraq növü üçün işləyir. Başqa müştəridə eyni
        vəziyyət yenə bayraqlanır.
      </footer>
    </div>
    </>
  );
}
