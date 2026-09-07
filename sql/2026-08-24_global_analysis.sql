-- Make analysis global per JID, the way names already are.
--
-- A group both employees are in was being summarised once per instance:
-- paying twice for near-identical output, since whichever account sees more
-- of the conversation already has essentially all of it (merging the two
-- gains 0-5%). Suggestions had the same duplication in the review queue.
--
-- Keyed by remote_jid alone from here on, matching katibe.contact_labels.
-- instance_id is kept as a record of which account the analysis was read
-- from, but no longer takes part in identity.

-- chat_summary keeps its history (one row per run), so only the "newest per
-- chat" lookup changes: drop instance from the index.
DROP INDEX IF EXISTS katibe.chat_summary_latest_idx;
CREATE INDEX IF NOT EXISTS chat_summary_latest_idx
  ON katibe.chat_summary (remote_jid, created_at DESC);

-- chat_suggestion is one row per chat, so duplicates must be collapsed before
-- the key can change. Keep the newest row per JID; an already-resolved
-- decision wins over an unresolved one so a handled chat is not re-queued.
DELETE FROM katibe.chat_suggestion s
USING katibe.chat_suggestion keep
WHERE s.remote_jid = keep.remote_jid
  AND s.instance_id IS DISTINCT FROM keep.instance_id
  AND (
    (keep.resolved_at IS NOT NULL AND s.resolved_at IS NULL)
    OR (
      (keep.resolved_at IS NULL) = (s.resolved_at IS NULL)
      AND (keep.created_at, keep.instance_id) > (s.created_at, s.instance_id)
    )
  );

ALTER TABLE katibe.chat_suggestion DROP CONSTRAINT IF EXISTS chat_suggestion_pkey;
ALTER TABLE katibe.chat_suggestion ADD PRIMARY KEY (remote_jid);
