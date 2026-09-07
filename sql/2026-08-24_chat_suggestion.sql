-- AI-proposed name + category for a chat, kept separate from
-- katibe.contact_labels so a suggestion is never mistaken for a human
-- decision. The admin accepts one and only then does it become a real label.
--
-- Scoped to instance + JID: the suggestion is derived from the conversation,
-- which belongs to one instance (unlike the accepted label, which is global).
CREATE TABLE IF NOT EXISTS katibe.chat_suggestion (
  instance_id            text NOT NULL,
  remote_jid             text NOT NULL,
  suggested_name         text,
  suggested_category_id  integer REFERENCES katibe.categories(id) ON DELETE SET NULL,
  confidence             text NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  reason                 text,
  model                  text NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- Set once the admin accepts or rejects, so a reviewed chat is not
  -- re-suggested on the next run.
  resolved_at            timestamptz,
  resolution             text CHECK (resolution IN ('ACCEPTED', 'REJECTED')),
  PRIMARY KEY (instance_id, remote_jid)
);

CREATE INDEX IF NOT EXISTS chat_suggestion_pending_idx
  ON katibe.chat_suggestion (instance_id) WHERE resolved_at IS NULL;
