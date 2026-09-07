-- 1. Analyses are per-account, not per-JID.
--
-- The old lookup index keyed on (remote_jid, created_at) matched how
-- getStoredSummary used to query. A JID is the OTHER party's address, so for
-- direct chats it is shared by every account that talks to that person, and
-- one employee's analysis was being shown on another's chat page.
CREATE INDEX IF NOT EXISTS chat_summary_instance_latest_idx
  ON katibe.chat_summary (instance_id, remote_jid, created_at DESC);

-- 2. Ad-hoc questions an admin asks about one conversation.
--
-- `found` is the anti-hallucination contract: the model must say plainly when
-- the transcript does not answer the question rather than inventing something,
-- and `evidence` carries the quoted lines it relied on so a human can check.
CREATE TABLE IF NOT EXISTS katibe.chat_question (
  id          bigserial PRIMARY KEY,
  instance_id text NOT NULL,
  remote_jid  text NOT NULL,
  question    text NOT NULL,
  answer      text NOT NULL,
  found       boolean NOT NULL,
  evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,
  model       text NOT NULL,
  lang        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_question_chat_idx
  ON katibe.chat_question (instance_id, remote_jid, created_at DESC);

-- 3. Cached translations of a stored analysis.
--
-- Keyed by the analysis row, so re-reading a translated summary is free and a
-- new analysis is never silently shown with an old translation.
CREATE TABLE IF NOT EXISTS katibe.summary_translation (
  summary_id bigint NOT NULL REFERENCES katibe.chat_summary(id) ON DELETE CASCADE,
  lang       text NOT NULL,
  payload    jsonb NOT NULL,
  model      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (summary_id, lang)
);

-- Every katibe table is owned by `evolution` — the role the app and crons
-- connect as. Creating one as `postgres` leaves them with "permission denied".
ALTER TABLE katibe.chat_question       OWNER TO evolution;
ALTER TABLE katibe.summary_translation OWNER TO evolution;
ALTER SEQUENCE katibe.chat_question_id_seq OWNER TO evolution;
