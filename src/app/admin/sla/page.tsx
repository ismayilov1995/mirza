import Link from "next/link";
import { requireAdmin } from "@/lib/access";
import {
  getSlaRules,
  getSlaRuleVersionsByRule,
  getTimezoneNames,
  getUserSlaAssignments,
  type SlaRule,
  type SlaRuleConfig,
  type SlaRuleVersion,
} from "@/lib/queries";
import { createSlaRuleAction, deleteSlaRuleAction, updateSlaRuleAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";
import styles from "../../dashboard.module.css";
import AppHeader from "@/components/AppHeader";

export const dynamic = "force-dynamic";

/** ISO gün nömrələri (1=B.e … 7=Bazar) — Postgres-in EXTRACT(isodow) ilə eyni. */
const DAYS: { value: number; label: string }[] = [
  { value: 1, label: "B.e" },
  { value: 2, label: "Ç.a" },
  { value: 3, label: "Ç" },
  { value: 4, label: "C.a" },
  { value: 5, label: "C" },
  { value: 6, label: "Ş" },
  { value: 7, label: "B" },
];

const DEFAULT_CONFIG: SlaRuleConfig = {
  timezone: "Asia/Baku",
  businessStart: "09:00",
  businessEnd: "18:00",
  businessDays: [1, 2, 3, 4, 5],
  targetBusinessMinutes: 60,
  targetOffhoursMinutes: 120,
  targetWeekendMinutes: 180,
};

function fmtTargets(v: SlaRuleConfig): string {
  return `${v.targetBusinessMinutes} / ${v.targetOffhoursMinutes} / ${v.targetWeekendMinutes} dəq`;
}

function fmtDays(days: number[]): string {
  return DAYS.filter((d) => days.includes(d.value))
    .map((d) => d.label)
    .join(", ");
}

/**
 * null-un mənası sütuna görə fərqlidir — başlanğıc üçün «əvvəldən»
 * (bazada -infinity), son üçün «indi» (hələ bağlanmayıb) — ona görə etiket
 * çağıran tərəfdən verilir.
 */
function fmtDate(d: Date | null, whenNull: string): string {
  if (d === null) return whenNull;
  return d.toLocaleString("az-AZ", { dateStyle: "short", timeStyle: "short" });
}

/**
 * SLA qaydaları: yaratma, redaktə, arxivləmə + versiya tarixçəsi.
 *
 * Ekranın əsas mesajı budur: redaktə qaydanı DƏYİŞMİR, yeni versiya açır.
 * Ona görə hər qaydanın altında versiya tarixçəsi görünür — kimsə "bu rəqəm
 * niyə belədir?" deyəndə cavab burada olsun.
 *
 * Adamı qaydaya bağlamaq isə user ekranındadır (/admin → Users), çünki seçim
 * adamın özünə aiddir.
 */
export default async function SlaPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  await requireAdmin();
  const [sp, rules, versionsByRule, assignments, timezones] = await Promise.all([
    searchParams,
    getSlaRules(),
    getSlaRuleVersionsByRule(),
    getUserSlaAssignments(),
    getTimezoneNames(),
  ]);

  const withoutRule = assignments.filter((a) => a.ruleId === null);

  return (
    <>
      <AppHeader section="Admin" align="page" />
      <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <div className={styles.brand}>SLA qaydaları</div>
          <div className={styles.subtitle}>
            <Link href="/admin">← Admin</Link> · Cavab hədəfi müştəri mesajının gəldiyi ana görə
            seçilir və qaydanın öz timezone-unda hesablanır
          </div>
        </div>
      </header>

      {/* Bir dənə datalist, bütün formalar ona baxır. Əvvəl hər formada ayrıca
          <select> vardı: 499 zona × hər qayda = səhifə yüzlərlə KB olurdu. */}
      <datalist id="tz-names">
        {timezones.map((tz) => (
          <option key={tz} value={tz} />
        ))}
      </datalist>

      {sp.notice && (
        <section className={styles.section}>
          <div className={styles.subtitle}>ℹ️ {sp.notice}</div>
        </section>
      )}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Qaydalar</div>
        </div>

        {rules.length === 0 ? (
          <div className={styles.empty}>
            Hələ qayda yoxdur. Qayda təyin olunmayan adamın cavabları SLA-ya görə ölçülmür — sıfır
            pozuntu kimi yox, «ölçülməyib» kimi görünür.
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ad</th>
                <th>Timezone</th>
                <th>İş saatı</th>
                <th>İş günləri</th>
                <th>Hədəf (iş saatı / kənar / qeyri-iş günü)</th>
                <th className={styles.numCell}>Bağlı</th>
                <th className={styles.numCell}>Versiya</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name}
                    {r.retiredAt && <span className={styles.pill}> arxiv</span>}
                  </td>
                  <td>{r.current?.timezone ?? <span className={styles.jid}>—</span>}</td>
                  <td>
                    {r.current ? `${r.current.businessStart}–${r.current.businessEnd}` : "—"}
                  </td>
                  <td>{r.current ? fmtDays(r.current.businessDays) : "—"}</td>
                  <td>{r.current ? fmtTargets(r.current) : "—"}</td>
                  <td className={styles.numCell}>{r.attachedUserCount}</td>
                  <td className={styles.numCell}>{r.versionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {rules.map((rule) => (
        <RuleEditor key={rule.id} rule={rule} versions={versionsByRule.get(rule.id) ?? []} />
      ))}

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Yeni qayda</div>
        </div>
        <p className={styles.subtitle}>
          Yeni qayda birinci versiyası ilə birlikdə yaranır və <strong>əvvəldən</strong> qüvvəyə
          minir — hələ mövcud olmayan qaydaya görə heç nə ölçülə bilməzdi, ona görə bu keçmişi
          pozmur, əksinə onu əhatə edir.
        </p>
        <ConfigForm
          action={createSlaRuleAction}
          submitLabel="Qayda yarat"
          pendingLabel="Yaradılır…"
        />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <div className={styles.sectionTitle}>Kim hansı qaydadadır</div>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>User</th>
              <th>Qayda</th>
              <th>Nə vaxtdan</th>
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.userId}>
                <td>{a.userName}</td>
                <td>{a.ruleName ?? <span className={styles.jid}>— (ölçülmür)</span>}</td>
                <td>{a.ruleId === null ? "—" : fmtDate(a.assignedAt, "əvvəldən")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.subtitle} style={{ marginTop: 12 }}>
          Qaydanı <Link href="/admin">Users</Link> cədvəlindən seçirsiniz.
          {withoutRule.length > 0 &&
            ` Hazırda ${withoutRule.length} adamın qaydası yoxdur — onların SLA rəqəmləri boş görünəcək.`}
        </p>
      </section>
    </div>
    </>
  );
}

function RuleEditor({ rule, versions }: { rule: SlaRule; versions: SlaRuleVersion[] }) {
  return (
    <section className={styles.section}>
      <details>
        <summary className={styles.sectionTitle} style={{ cursor: "pointer" }}>
          {rule.name} — redaktə və tarixçə
        </summary>

        <p className={styles.subtitle} style={{ marginTop: 12 }}>
          Yadda saxlayanda köhnə versiya bağlanır, yenisi <strong>indidən</strong> açılır. Keçmiş
          cavablar köhnə hədəflərlə ölçülməyə davam edir.
        </p>

        <ConfigForm
          action={updateSlaRuleAction}
          submitLabel="Yadda saxla (yeni versiya)"
          pendingLabel="Yeni versiya yazılır…"
          ruleId={rule.id}
          name={rule.name}
          config={rule.current ?? DEFAULT_CONFIG}
        />

        <div className={styles.sectionTitle} style={{ marginTop: 20 }}>
          Versiyalar
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.numCell}>v</th>
              <th>Qüvvədə</th>
              <th>Timezone</th>
              <th>İş saatı</th>
              <th>İş günləri</th>
              <th>Hədəflər</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className={styles.numCell}>{v.version}</td>
                <td>
                  {fmtDate(v.effectiveFrom, "əvvəldən")} → {fmtDate(v.effectiveTo, "indi")}
                </td>
                <td>{v.timezone}</td>
                <td>
                  {v.businessStart}–{v.businessEnd}
                </td>
                <td>{fmtDays(v.businessDays)}</td>
                <td>{fmtTargets(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <form action={deleteSlaRuleAction} className={styles.inlineForm} style={{ marginTop: 16 }}>
          <input type="hidden" name="ruleId" value={rule.id} />
          <SubmitButton
            variant="inline"
            label={
              rule.attachedUserCount > 0
                ? `Sil (bloklanıb — ${rule.attachedUserCount} adama təyin olunub)`
                : rule.everAttachedUserCount > 0
                  ? "Arxivlə"
                  : "Sil"
            }
            pendingLabel={rule.everAttachedUserCount > 0 ? "Arxivlənir…" : "Silinir…"}
          />
          <span className={styles.subtitle}>
            {rule.attachedUserCount > 0
              ? "Əvvəlcə bu qaydanı adamlardan çıxarın."
              : rule.everAttachedUserCount > 0
                ? "Nə vaxtsa istifadə olunub, ona görə tam silinmir — arxivlənir."
                : "Heç vaxt istifadə olunmayıb, tam silinə bilər."}
          </span>
        </form>
      </details>
    </section>
  );
}

function ConfigForm({
  action,
  submitLabel,
  pendingLabel,
  ruleId,
  name,
  config = DEFAULT_CONFIG,
}: {
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  pendingLabel: string;
  ruleId?: number;
  name?: string;
  config?: SlaRuleConfig;
}) {
  return (
    <form action={action} className={styles.inlineForm} style={{ flexWrap: "wrap", gap: 8 }}>
      {ruleId !== undefined && <input type="hidden" name="ruleId" value={ruleId} />}
      <input
        className={styles.inlineInput}
        type="text"
        name="name"
        placeholder="Qaydanın adı"
        defaultValue={name ?? ""}
        required
      />
      <input
        className={styles.inlineInput}
        type="text"
        name="timezone"
        list="tz-names"
        defaultValue={config.timezone}
        placeholder="Asia/Baku"
        required
      />
      <label className={styles.subtitle}>
        İş saatı{" "}
        <input
          className={styles.inlineInput}
          type="time"
          name="businessStart"
          defaultValue={config.businessStart}
          required
        />{" "}
        –{" "}
        <input
          className={styles.inlineInput}
          type="time"
          name="businessEnd"
          defaultValue={config.businessEnd}
          required
        />
      </label>
      <span className={styles.pillList}>
        {DAYS.map((d) => (
          <label key={d.value} className={styles.pill}>
            <input
              type="checkbox"
              name="businessDays"
              value={d.value}
              defaultChecked={config.businessDays.includes(d.value)}
            />{" "}
            {d.label}
          </label>
        ))}
      </span>
      <label className={styles.subtitle}>
        İş saatı içində{" "}
        <input
          className={styles.inlineInput}
          type="number"
          min={1}
          name="targetBusinessMinutes"
          defaultValue={config.targetBusinessMinutes}
          required
        />{" "}
        dəq
      </label>
      <label className={styles.subtitle}>
        İş saatından kənar{" "}
        <input
          className={styles.inlineInput}
          type="number"
          min={1}
          name="targetOffhoursMinutes"
          defaultValue={config.targetOffhoursMinutes}
          required
        />{" "}
        dəq
      </label>
      <label className={styles.subtitle}>
        Qeyri-iş günü{" "}
        <input
          className={styles.inlineInput}
          type="number"
          min={1}
          name="targetWeekendMinutes"
          defaultValue={config.targetWeekendMinutes}
          required
        />{" "}
        dəq
      </label>
      <SubmitButton variant="inline" label={submitLabel} pendingLabel={pendingLabel} />
    </form>
  );
}
