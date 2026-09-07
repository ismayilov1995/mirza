import { pool } from "../db";
import { contactDisplaySql, groupSubjectJoin, phoneSql } from "../queries";
import { AGENT_KEY } from "./run";
import { HANDOFF_STATES_SQL, STATE_LABELS, type ChatState } from "./chat-state";
import type { ScopedInstanceId } from "../access";

/*
 * "İş bizim tərəfdə deyil" siyahıları.
 *
 * İki hal, bir məntiq: başqa filiala (Dubay/Riyad) yönləndirilmiş müştəri və
 * PR üçün yazan adam.
 * Hər ikisində satış SLA-sı ilə ölçmək səhvdir — burada cavab verəcək kimsə
 * yoxdur, ona görə "N saatdır cavabsız" bayrağı yalan ölçüdür.
 *
 * BUNLAR GİZLƏDİLMİR, KÖÇÜRÜLÜR. Susdurulmuş bayraqdan (reytinq 1) prinsipial
 * fərqi budur: söhbət lentdən çıxır, amma bu səhifədə tam siyahı kimi durur —
 * sayı, kimliyi, modelin səbəbi və sonuncu mesajın vaxtı ilə. Menecer "kim
 * Dubaya getdi" sualına baxa bilir.
 *
 * Hal SAXLANMIR, hesablanır: söhbətə təzə mesaj gələn kimi yenidən təsnif
 * olunur (chat-state.ts), yəni filiala yönləndirilmiş müştəri yeni sifarişlə
 * qayıdanda öz-özünə nəzarətə düşür və təzə bayraq açılır.
 */

export interface HandoffChat {
  instanceId: string;
  instanceName: string | null;
  userName: string | null;
  remoteJid: string;
  contact: string;
  phone: string | null;
  state: ChatState;
  stateLabel: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reason: string;
  model: string;
  lastMessageTs: number;
  classifiedAt: string;
  /** Bu söhbətdə bu səbəblə bağlanmış bayraqların sayı. */
  closedFlags: number;
}

export interface HandoffLists {
  branch: HandoffChat[];
  pr: HandoffChat[];
}

export async function getHandoffChats(
  scope: ScopedInstanceId[],
  { limit = 300 }: { limit?: number } = {},
): Promise<HandoffLists> {
  if (scope.length === 0) return { branch: [], pr: [] };

  const { rows } = await pool.query(
    `WITH handoff AS (
       SELECT cs.instance_id, cs.remote_jid, cs.state, cs.confidence, cs.reason,
              cs.model, cs.last_message_ts, cs.classified_at
       FROM katibe.chat_state cs
       WHERE cs.instance_id = ANY($1::text[])
         AND cs.state IN (${HANDOFF_STATES_SQL})
       ORDER BY cs.last_message_ts DESC
       LIMIT $2
     )
     SELECT h.instance_id, h.remote_jid, h.state, h.confidence, h.reason,
            h.model, h.last_message_ts, h.classified_at,
            i.name AS instance_name, u.name AS user_name,
            ${contactDisplaySql("h.remote_jid")} AS contact,
            ${phoneSql("h.remote_jid", "ln")} AS phone,
            (SELECT COUNT(*) FROM katibe.agent_posts p
              WHERE p.agent = $3 AND p.instance_id = h.instance_id
                AND p.remote_jid = h.remote_jid AND p.closed_reason = 'HANDOFF') AS closed_flags
     FROM handoff h
     LEFT JOIN evolution_api."Instance" i ON i.id = h.instance_id
     LEFT JOIN katibe.user_instances ui ON ui.instance_id = h.instance_id AND ui.ended_at IS NULL
     LEFT JOIN katibe.users u ON u.id = ui.user_id
     LEFT JOIN evolution_api."Chat" ch
       ON ch."instanceId" = h.instance_id AND ch."remoteJid" = h.remote_jid
     LEFT JOIN evolution_api."Contact" ct
       ON ct."instanceId" = h.instance_id AND ct."remoteJid" = h.remote_jid
     LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = h.remote_jid
     ${groupSubjectJoin("h.remote_jid", "gs")}
     LEFT JOIN katibe.lid_number ln ON ln.lid_jid = h.remote_jid
     LEFT JOIN katibe.chat_identity ci ON ci.remote_jid = h.remote_jid
     -- Ad zəncirinin son həlqəsi: gələn mesajın öz pushName-i. Detektorlarda
     -- bu, pəncərə üzərindəki CTE-dən gəlir; burada pəncərə yoxdur, ona görə
     -- söhbət başına LATERAL — siyahı kiçikdir və "Message_remoteJid_idx"
     -- sorğunu indeksdə saxlayır.
     LEFT JOIN LATERAL (
       SELECT MAX(m."pushName") AS push_name
       FROM evolution_api."Message" m
       WHERE m."instanceId" = h.instance_id
         AND m.key->>'remoteJid' = h.remote_jid
         AND NOT (m.key->>'fromMe')::boolean
         AND m."pushName" <> ''
     ) pn ON true
     ORDER BY h.last_message_ts DESC`,
    [scope, limit, AGENT_KEY],
  );

  const map = (r: Record<string, unknown>): HandoffChat => ({
    instanceId: String(r.instance_id),
    instanceName: (r.instance_name as string) ?? null,
    userName: (r.user_name as string) ?? null,
    remoteJid: String(r.remote_jid),
    contact: String(r.contact),
    phone: (r.phone as string) ?? null,
    state: r.state as ChatState,
    stateLabel: STATE_LABELS[r.state as ChatState],
    confidence: r.confidence as HandoffChat["confidence"],
    reason: String(r.reason),
    model: String(r.model),
    lastMessageTs: Number(r.last_message_ts),
    classifiedAt: new Date(r.classified_at as string).toISOString(),
    closedFlags: Number(r.closed_flags ?? 0),
  });

  const all = rows.map(map);
  return {
    branch: all.filter((c) => c.state === "FORWARDED_TO_BRANCH"),
    pr: all.filter((c) => c.state === "FOR_PR"),
  };
}
