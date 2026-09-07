-- Admin model for the multi-tenant Katibe dashboard: which Katibe user owns
-- which Evolution API instance, and the Branch/Category taxonomy the admin
-- uses to organize users (and, later, individual chats).
--
-- Lives in the katibe schema (same place as katibe.message_topic) — kept
-- separate from Evolution API's own evolution_api schema so it's untouched
-- by Evolution's migrations. Safe to re-run (IF NOT EXISTS throughout).

-- Admin-managed list of company branches (e.g. "Online Branch").
CREATE TABLE IF NOT EXISTS katibe.branches (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Shared category list. Used both for Users (e.g. "Sales") and, later, for
-- individual chats (e.g. distinguishing a client chat from an internal
-- one) — one list, two attachment points, per admin's choice.
CREATE TABLE IF NOT EXISTS katibe.categories (
  id         serial PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Katibe-side "employee" records the admin creates and maps to a branch and
-- category. No login of their own yet — dashboard auth stays the single
-- shared admin password (src/lib/auth.ts). Add real per-user auth later if
-- ever needed.
CREATE TABLE IF NOT EXISTS katibe.users (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  branch_id   integer REFERENCES katibe.branches(id) ON DELETE SET NULL,
  category_id integer REFERENCES katibe.categories(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Which Evolution API instance's messages belong to which Katibe user.
-- instance_id is the primary key so one instance maps to exactly one user;
-- a user may own several instances.
CREATE TABLE IF NOT EXISTS katibe.user_instances (
  instance_id text PRIMARY KEY REFERENCES evolution_api."Instance"(id) ON DELETE CASCADE,
  user_id     integer NOT NULL REFERENCES katibe.users(id) ON DELETE CASCADE,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_instances_user_idx ON katibe.user_instances(user_id);
