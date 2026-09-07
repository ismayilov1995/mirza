import { pool } from "./db";
import { DEFAULT_MONITOR_PROFILE, type MonitorProfile } from "./access";

/*
 * Nəzarətçi qaydalarının idarəsi və nömrə maskalanması.
 *
 * Bu fayl İCAZƏ VERMİR — icazə src/lib/access.ts-dədir. Burada yalnız admin
 * tərəfin yazdığı qaydalar və nəzarətçiyə göstərilməzdən əvvəl mətnin
 * təmizlənməsi var.
 */

export type Visibility = "allow" | "deny";

export interface MonitorAccount {
  userId: number;
  username: string;
  active: boolean;
  lastLoginAt: string | null;
  profile: MonitorProfile;
  /** Görə bildiyi nömrələr — adi təyinat cədvəlindən (dashboard_user_instances). */
  instances: { instanceId: string; instanceName: string }[];
  categoryRules: { categoryId: number; categoryName: string; visibility: Visibility }[];
  chatRules: { remoteJid: string; displayName: string | null; visibility: Visibility; note: string | null }[];
}

/** Bütün nəzarətçi hesabları, qaydaları ilə birlikdə — admin səhifəsi üçün. */
export async function listMonitorAccounts(): Promise<MonitorAccount[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.active, u.last_login_at,
            p.history_days, p.mask_phones, p.group_default, p.direct_default,
            COALESCE((
              SELECT json_agg(json_build_object('instanceId', i.id, 'instanceName', i.name) ORDER BY i.name)
              FROM katibe.dashboard_user_instances g
              JOIN evolution_api."Instance" i ON i.id = g.instance_id
              WHERE g.user_id = u.id
            ), '[]'::json) AS instances,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'categoryId', c.id, 'categoryName', c.name, 'visibility', r.visibility
                     ) ORDER BY c.name)
              FROM katibe.monitor_category_rule r
              JOIN katibe.categories c ON c.id = r.category_id
              WHERE r.user_id = u.id
            ), '[]'::json) AS category_rules,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'remoteJid', r.remote_jid,
                       'displayName', cl.display_name,
                       'visibility', r.visibility,
                       'note', r.note
                     ) ORDER BY r.updated_at DESC)
              FROM katibe.monitor_chat_rule r
              LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = r.remote_jid
              WHERE r.user_id = u.id
            ), '[]'::json) AS chat_rules
     FROM katibe.dashboard_users u
     LEFT JOIN katibe.monitor_profile p ON p.user_id = u.id
     WHERE u.role = 'monitor'
     ORDER BY u.active DESC, lower(u.username)`,
  );

  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    active: r.active,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    profile: r.history_days
      ? {
          historyDays: Number(r.history_days),
          maskPhones: r.mask_phones,
          groupDefault: r.group_default,
          directDefault: r.direct_default,
        }
      : DEFAULT_MONITOR_PROFILE,
    instances: r.instances,
    categoryRules: r.category_rules,
    chatRules: r.chat_rules,
  }));
}

export async function setMonitorProfile(
  userId: number,
  profile: MonitorProfile,
  updatedBy: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO katibe.monitor_profile
       (user_id, history_days, mask_phones, group_default, direct_default, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (user_id) DO UPDATE SET
       history_days = EXCLUDED.history_days,
       mask_phones = EXCLUDED.mask_phones,
       group_default = EXCLUDED.group_default,
       direct_default = EXCLUDED.direct_default,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by`,
    [
      userId,
      profile.historyDays,
      profile.maskPhones,
      profile.groupDefault,
      profile.directDefault,
      updatedBy,
    ],
  );
}

/**
 * Kateqoriya qaydası. `null` görünüş qaydanı SİLİR — yəni həmin kateqoriya
 * yenidən tipə görə default-a qayıdır (qrup gizli, fərdi açıq).
 */
export async function setCategoryRule(
  userId: number,
  categoryId: number,
  visibility: Visibility | null,
  updatedBy: number,
): Promise<void> {
  if (visibility === null) {
    await pool.query(
      `DELETE FROM katibe.monitor_category_rule WHERE user_id = $1 AND category_id = $2`,
      [userId, categoryId],
    );
    return;
  }
  await pool.query(
    `INSERT INTO katibe.monitor_category_rule (user_id, category_id, visibility, updated_at, updated_by)
     VALUES ($1, $2, $3, now(), $4)
     ON CONFLICT (user_id, category_id) DO UPDATE SET
       visibility = EXCLUDED.visibility, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [userId, categoryId, visibility, updatedBy],
  );
}

/** Söhbət qaydası — kateqoriyanı üstələyir. `null` qaydanı silir. */
export async function setChatRule(
  userId: number,
  remoteJid: string,
  visibility: Visibility | null,
  note: string | null,
  updatedBy: number,
): Promise<void> {
  if (visibility === null) {
    await pool.query(
      `DELETE FROM katibe.monitor_chat_rule WHERE user_id = $1 AND remote_jid = $2`,
      [userId, remoteJid],
    );
    return;
  }
  await pool.query(
    `INSERT INTO katibe.monitor_chat_rule (user_id, remote_jid, visibility, note, updated_at, updated_by)
     VALUES ($1, $2, $3, NULLIF($4, ''), now(), $5)
     ON CONFLICT (user_id, remote_jid) DO UPDATE SET
       visibility = EXCLUDED.visibility, note = EXCLUDED.note,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [userId, remoteJid, visibility, note ?? "", updatedBy],
  );
}

export interface MonitorViewLogRow {
  id: string;
  username: string;
  instanceName: string;
  remoteJid: string | null;
  chatName: string | null;
  action: string;
  at: string;
}

/** Son baxışlar — "kim, kimin söhbətinə, nə vaxt baxdı". */
export async function getMonitorViewLog(limit = 200): Promise<MonitorViewLogRow[]> {
  const { rows } = await pool.query(
    `SELECT l.id, u.username, COALESCE(i.name, l.instance_id) AS instance_name,
            l.remote_jid, cl.display_name AS chat_name, l.action, l.at
     FROM katibe.monitor_view_log l
     JOIN katibe.dashboard_users u ON u.id = l.user_id
     LEFT JOIN evolution_api."Instance" i ON i.id = l.instance_id
     LEFT JOIN katibe.contact_labels cl ON cl.remote_jid = l.remote_jid
     ORDER BY l.at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: String(r.id),
    username: r.username,
    instanceName: r.instance_name,
    remoteJid: r.remote_jid,
    chatName: r.chat_name,
    action: r.action,
    at: new Date(r.at).toISOString(),
  }));
}

/* ── Maskalama ───────────────────────────────────────────────────────────── */

/**
 * "994500000002" → "+994 50 *** ** 02".
 *
 * Baş və son saxlanılır ki, nəzarətçi iki fərqli müştərini ayırd edə bilsin
 * (və satıcı ilə "sonu 02 olan nömrə" deyə danışa bilsin), amma nömrə
 * yığılası olmasın.
 */
export function maskPhone(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const clean = digits.replace(/\D/g, "");
  if (clean.length < 7) return "***";
  const head = clean.slice(0, 5);
  const tail = clean.slice(-2);
  return `+${head} *** ** ${tail}`;
}

/*
 * Mətnin içindəki nömrələr.
 *
 * Ad sahəsini maskalayıb mesajın mətnini toxunulmaz qoymaq yarımçıq iş olardı:
 * müştəri nömrəsini çox vaxt YAZIŞMANIN İÇİNDƏ göndərir ("əlaqə: 0507787875").
 *
 * Sərhəd qəsdən dardır — 9-15 rəqəm. Qiymətlər (12 500), tarixlər (24.08.2026),
 * metraj və sifariş sayları bu aralığa düşmür, ona görə maskalama yazışmanın
 * mənasını pozmur. 9 rəqəmdən qısa "nömrə" onsuz da yığıla bilməz.
 */
const PHONE_LIKE = /\+?\d[\d\s\-().]{6,18}\d/g;

export function maskPhonesInText(text: string | null): string | null {
  if (!text) return text;
  return text.replace(PHONE_LIKE, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) return match;
    return maskPhone(digits) ?? match;
  });
}

/**
 * Söhbətin göstərilən adı. Ad "Leyla · 994500000002" formasında gələ bilir
 * (bax contactDisplaySql) — maskalama həmin quyruğu da tutur.
 */
export function maskDisplayName(name: string | null): string | null {
  return maskPhonesInText(name);
}
