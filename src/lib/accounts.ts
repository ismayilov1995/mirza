import { pool } from "./db";
import { hashPassword } from "./password";
import type { Role } from "./access";

// Giriş hesablarının idarəsi. Bütün yazmalar /admin/accounts səhifəsindən və
// seed skriptindən gəlir; hər ikisi eyni funksiyaları çağırır ki, qaydalar
// (parol uzunluğu, sessiya ləğvi, son admin qorunması) iki yerdə ayrılmasın.

export interface DashboardAccount {
  id: number;
  username: string;
  email: string | null;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  instances: { instanceId: string; instanceName: string; private: boolean }[];
}

export async function listAccounts(): Promise<DashboardAccount[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.role, u.active, u.must_change_password,
            u.last_login_at, u.created_at,
            COALESCE(
              (SELECT json_agg(json_build_object(
                 'instanceId', i.id, 'instanceName', i.name,
                 'private', COALESCE(ia.private, false)
               ) ORDER BY i.name)
               FROM katibe.dashboard_user_instances g
               JOIN evolution_api."Instance" i ON i.id = g.instance_id
               LEFT JOIN katibe.instance_access ia ON ia.instance_id = i.id
               WHERE g.user_id = u.id),
              '[]'::json
            ) AS instances
     FROM katibe.dashboard_users u
     ORDER BY u.active DESC, lower(u.username)`,
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    email: r.email,
    role: r.role,
    active: r.active,
    mustChangePassword: r.must_change_password,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    instances: r.instances,
  }));
}

export interface InstanceOption {
  instanceId: string;
  instanceName: string;
  private: boolean;
}

export async function listAllInstances(): Promise<InstanceOption[]> {
  const { rows } = await pool.query(
    `SELECT i.id, i.name, COALESCE(ia.private, false) AS private
     FROM evolution_api."Instance" i
     LEFT JOIN katibe.instance_access ia ON ia.instance_id = i.id
     ORDER BY i.name`,
  );
  return rows.map((r) => ({ instanceId: r.id, instanceName: r.name, private: r.private }));
}

export async function createAccount(input: {
  username: string;
  email: string | null;
  password: string;
  role: Role;
  mustChangePassword: boolean;
  createdBy: number | null;
}): Promise<number> {
  const hash = await hashPassword(input.password);
  const { rows } = await pool.query(
    `INSERT INTO katibe.dashboard_users
       (username, email, password_hash, role, must_change_password, password_changed_at, created_by)
     VALUES ($1, NULLIF($2, ''), $3, $4, $5, now(), $6)
     RETURNING id`,
    [input.username, input.email ?? "", hash, input.role, input.mustChangePassword, input.createdBy],
  );
  return rows[0].id;
}

/**
 * Parolu dəyişir və BÜTÜN açıq sessiyaları öldürür.
 *
 * session_epoch artımı vacibdir: parol oğurlanıbsa, onu dəyişmək o parolla
 * açılmış cookie-ni öz-özünə etibarsız etmir — cookie parolu daşımır. Epoch
 * artımı isə edir.
 */
export async function setPassword(
  userId: number,
  password: string,
  mustChange: boolean,
): Promise<void> {
  const hash = await hashPassword(password);
  await pool.query(
    `UPDATE katibe.dashboard_users
     SET password_hash = $2, must_change_password = $3,
         password_changed_at = now(), session_epoch = session_epoch + 1
     WHERE id = $1`,
    [userId, hash, mustChange],
  );
}

/**
 * Hesabı söndürür/açır. Söndürmək açıq sessiyaları da öldürür.
 *
 * Son aktiv admini söndürmək rədd edilir — əks halda sistemə heç kim girə
 * bilməzdi və bərpa yalnız birbaşa SQL ilə mümkün olardı.
 */
export async function setActive(userId: number, active: boolean): Promise<string | null> {
  if (!active) {
    const guard = await lastAdminGuard(userId);
    if (guard) return guard;
  }
  await pool.query(
    `UPDATE katibe.dashboard_users
     SET active = $2, session_epoch = session_epoch + 1
     WHERE id = $1`,
    [userId, active],
  );
  return null;
}

export async function setRole(userId: number, role: Role): Promise<string | null> {
  if (role !== "admin") {
    const guard = await lastAdminGuard(userId);
    if (guard) return guard;
  }
  // Rol dəyişikliyi də sessiyanı öldürür: səlahiyyəti azaldılan adamın açıq
  // səhifəsi köhnə rolla işləməyə davam etməməlidir.
  await pool.query(
    `UPDATE katibe.dashboard_users SET role = $2, session_epoch = session_epoch + 1 WHERE id = $1`,
    [userId, role],
  );
  return null;
}

async function lastAdminGuard(userId: number): Promise<string | null> {
  const { rows } = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM katibe.dashboard_users
     WHERE role = 'admin' AND active AND id <> $1`,
    [userId],
  );
  return Number(rows[0].c) === 0 ? "Sonuncu aktiv admin qala bilməz" : null;
}

export async function setInstanceGrants(
  userId: number,
  instanceIds: string[],
  grantedBy: number | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM katibe.dashboard_user_instances WHERE user_id = $1`, [userId]);
    if (instanceIds.length > 0) {
      await client.query(
        `INSERT INTO katibe.dashboard_user_instances (user_id, instance_id, granted_by)
         SELECT $1, unnest($2::text[]), $3`,
        [userId, instanceIds, grantedBy],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** İnstansın privat bayrağı — privat olan yalnız açıq icazə ilə görünür. */
export async function setInstancePrivate(instanceId: string, isPrivate: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO katibe.instance_access (instance_id, private, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (instance_id) DO UPDATE SET private = EXCLUDED.private, updated_at = now()`,
    [instanceId, isPrivate],
  );
}
