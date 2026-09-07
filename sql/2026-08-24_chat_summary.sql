-- Cached AI summaries of a conversation, so re-opening a chat is instant and
-- doesn't re-bill an API call. Scoped to instance + JID (unlike
-- katibe.contact_labels, which is global) because the conversation itself is
-- between one instance and that contact — a different instance talking to the
-- same number is a different conversation.
--
-- message_count / last_message_ts record what the summary covered, so the UI
-- can tell the user it's out of date once new messages arrive.
CREATE TABLE IF NOT EXISTS katibe.chat_summary (
  instance_id     text NOT NULL,
  remote_jid      text NOT NULL,
  summary         jsonb NOT NULL,
  message_count   integer NOT NULL,
  last_message_ts integer NOT NULL,
  model           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (instance_id, remote_jid)
);
