-- Bayraq şərhləri: "gördüm, səbəbi budur" — bağlamadan.
--
-- "Həll edildi" (agent_posts.acknowledged_at) yeganə hərəkət idi, amma o,
-- bayrağı lentdən çıxarır. Real həyatda tez-tez arada bir hal olur: satıcı
-- məsələni izah edib (məs. "mudriyyətdən qiymət cavabı gözlənilir"), amma
-- iş hələ bitməyib — bağlamaq səbəbi itirər, bağlamamaq isə izahı gizli
-- saxlayar. Bu cədvəl üçüncü yolu açır: bayraq açıq qalır, severity və
-- acknowledged_at toxunulmaz qalır, sadəcə izah lentdə görünür.
--
-- Müəllif katibe.dashboard_users-dəndir (giriş hesabı), katibe.users
-- (satıcı) YOX — şərhi kim İYAZIB sualının cavabı budur (bax
-- 2026-08-25_dashboard_accounts.sql-dəki eyni ayrım).
--
-- Təkrar işlətmək təhlükəsizdir.

CREATE TABLE IF NOT EXISTS katibe.agent_post_comments (
  id             bigserial PRIMARY KEY,
  agent_post_id  bigint NOT NULL REFERENCES katibe.agent_posts(id) ON DELETE CASCADE,
  user_id        integer NOT NULL REFERENCES katibe.dashboard_users(id),
  comment        text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_post_comments_post_idx
  ON katibe.agent_post_comments (agent_post_id, created_at);

ALTER TABLE katibe.agent_post_comments OWNER TO evolution;
