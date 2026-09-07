// Bayraq şərhləri — "gördüm, səbəbi budur" bağlamadan.
//
// agent_posts-a heç toxunmur: severity, acknowledged_at, closed_reason burda
// yoxdur, ola da bilməz. Şərh yazmaq bayrağı nə sancaqdan çıxarır, nə də
// dedupe-i sıfırlayır — sql/2026-08-26_agent_post_comments.sql-dəki qeyddə
// olduğu kimi, üçüncü yol budur: bağlamadan izah.

import { pool } from "../db";

export interface PostComment {
  id: number;
  userName: string;
  comment: string;
  createdAt: string;
}

/**
 * Verilmiş instans dairəsindəki (və istəyə görə satıcı filtrindəki) bütün
 * postların şərhləri, post ID-sinə görə qruplaşdırılmış.
 *
 * getAgentFeed-dəki digər sorğularla eyni WHERE forması: instans siyahısı
 * MƏCBURİ (bir instansa girişi olan kiminsə başqasının şərhini oxumaması
 * üçün), satıcı filtri isə NULL olanda sönür.
 */
export async function getCommentsByPost(
  agentKey: string,
  scope: string[],
  userId: number | null,
): Promise<Map<number, PostComment[]>> {
  const map = new Map<number, PostComment[]>();
  if (scope.length === 0) return map;

  const { rows } = await pool.query(
    `SELECT c.agent_post_id, c.id, c.comment, c.created_at, du.username AS user_name
     FROM katibe.agent_post_comments c
     JOIN katibe.agent_posts p ON p.id = c.agent_post_id
     JOIN katibe.dashboard_users du ON du.id = c.user_id
     WHERE p.agent = $1 AND p.instance_id = ANY($2::text[])
       AND ($3::int IS NULL OR p.user_id = $3::int)
     ORDER BY c.created_at ASC`,
    [agentKey, scope, userId],
  );

  for (const r of rows) {
    const postId = Number(r.agent_post_id);
    const list = map.get(postId) ?? [];
    list.push({
      id: Number(r.id),
      userName: String(r.user_name),
      comment: String(r.comment),
      createdAt: new Date(r.created_at as string).toISOString(),
    });
    map.set(postId, list);
  }
  return map;
}

/**
 * Bir şərh əlavə edir. Instans icazəsi çağıran tərəfdən (agent-actions.ts)
 * artıq yoxlanılıb — bura yalnız yazır.
 */
export async function insertPostComment(
  postId: number,
  userId: number,
  comment: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO katibe.agent_post_comments (agent_post_id, user_id, comment)
     VALUES ($1, $2, $3)`,
    [postId, userId, comment],
  );
}
