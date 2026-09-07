-- Direction is a property of (message, viewer), not of the message.
--
-- FOUND BY THE DUAL-READ CHECK, which is what it was built for. Comparing the
-- store back against Evolution, 24-35 of every 400 sampled messages disagreed
-- on direction. All of them are group messages: 8,933 messages carry
-- contradictory directions across instances, and every single one is @g.us.
--
-- The reason is obvious once seen. A message one of our phones sends to a
-- group is fromMe=true in that instance and fromMe=false in the other three,
-- which see it as traffic from another participant. Evolution is right both
-- times; a single canonical `direction` column simply cannot be.
--
-- So the per-source view moves to the link table, where it is exact and the
-- comparison can stay strict. The message keeps a direction too, with a
-- narrower and defensible meaning: did OUR side send this, from the business's
-- point of view — true if any of our instances sent it. That is the question
-- the dashboard actually asks ("who is waiting on us"), and it is the same
-- answer whichever phone was holding the conversation.
ALTER TABLE katibe.message_source
  ADD COLUMN IF NOT EXISTS direction text
    CHECK (direction IS NULL OR direction IN ('in','out'));

COMMENT ON COLUMN katibe.message_source.direction IS
  'Bu mənbənin gördüyü istiqamət — Evolution-un fromMe dəyəri, olduğu kimi.';

COMMENT ON COLUMN katibe.message.direction IS
  'Bizim tərəf göndəribmi: mənbələrdən HƏR HANSI BİRİ fromMe deyirsə out. Qrupda instanslar fərqli görür, bax message_source.direction.';
