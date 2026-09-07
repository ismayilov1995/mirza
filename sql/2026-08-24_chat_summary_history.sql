-- Keep every analysis instead of overwriting one row per chat.
--
-- Two reasons: the same chat can be analysed with different models (a cheap
-- Sonnet pass, then an Opus one when it matters), and an older summary stays
-- useful as a record of what the conversation looked like back then.
--
-- The dashboard reads the newest row per (instance, jid) and offers to run a
-- new analysis rather than regenerating on its own.
ALTER TABLE katibe.chat_summary DROP CONSTRAINT IF EXISTS chat_summary_pkey;
ALTER TABLE katibe.chat_summary ADD COLUMN IF NOT EXISTS id bigserial PRIMARY KEY;

CREATE INDEX IF NOT EXISTS chat_summary_latest_idx
  ON katibe.chat_summary (instance_id, remote_jid, created_at DESC);
