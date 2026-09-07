-- Per-chat display name + category, set by whoever is looking at the main
-- dashboard for their own instance. This is what lets "Sales" chats be told
-- apart from internal/colleague chats later, without touching Evolution
-- API's own Chat table at all (still read-only towards WhatsApp).
--
-- No FK to evolution_api."Chat" — a label can be set even if the Chat row
-- hasn't synced yet, and instance_id/remote_jid is a stable enough pair on
-- its own. Categories are the same shared list as katibe.users.category_id.

CREATE TABLE IF NOT EXISTS katibe.chat_labels (
  instance_id  text NOT NULL,
  remote_jid   text NOT NULL,
  display_name text,
  category_id  integer REFERENCES katibe.categories(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, remote_jid)
);
