-- Client-first sweep.
--
-- Identifying which numbers are CLIENTS is the question the whole dashboard
-- hangs off of, and there are ~430 individual chats to get through. Reviewing
-- each one by hand is not realistic, so a HIGH-confidence proposal is applied
-- straight away and only MEDIUM/LOW ones queue up for a human.
--
-- 'AUTO' is a third resolution next to ACCEPTED/REJECTED so an auto-applied
-- label stays distinguishable from one a human agreed to — the admin can list
-- them and revert any that are wrong.
ALTER TABLE katibe.chat_suggestion
  DROP CONSTRAINT IF EXISTS chat_suggestion_resolution_check;

ALTER TABLE katibe.chat_suggestion
  ADD CONSTRAINT chat_suggestion_resolution_check
  CHECK (resolution IN ('ACCEPTED', 'REJECTED', 'AUTO'));

-- The review page reads the pending queue across every instance, ordered
-- client-first, so the existing per-instance partial index doesn't help it.
CREATE INDEX IF NOT EXISTS chat_suggestion_pending_all_idx
  ON katibe.chat_suggestion (confidence) WHERE resolved_at IS NULL;
