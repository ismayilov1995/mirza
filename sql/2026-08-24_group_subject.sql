-- Real group names pulled live from the Evolution API.
--
-- Evolution's own Chat.name lags behind and is missing entirely for some
-- groups, while GET /group/fetchAllGroups returns the current subject
-- straight from WhatsApp — 395 groups vs 268 Chat rows here, and four groups
-- the dashboard showed as unnamed turned out to have real names
-- ("Dubai | Fabric Order Only", "Waiting for Deadline", ...).
--
-- These are authoritative WhatsApp names, not guesses, so unlike
-- katibe.chat_suggestion they need no human approval — they slot into name
-- resolution just above Chat.name (an admin label still wins).
CREATE TABLE IF NOT EXISTS katibe.group_subject (
  remote_jid text PRIMARY KEY,
  subject    text NOT NULL,
  size       integer,
  synced_at  timestamptz NOT NULL DEFAULT now()
);
