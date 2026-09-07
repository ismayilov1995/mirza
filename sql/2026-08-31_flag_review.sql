-- Letting the supervisor close flags, on the record.
--
-- The monitor role is deliberately confined: requireSession() sends it to
-- /monitor and nowhere else, and that default-closed posture is the reason the
-- role is safe to hand out. So this opens ONE door rather than widening the
-- role — a monitor may review flags, and may close one only with a written
-- reason.
--
-- WHY THE NOTE IS MANDATORY. Closing is the only action that removes a flag
-- from the manager's attention. A close without a reason is indistinguishable
-- from a mistake, from a disagreement, and from someone clearing their screen;
-- the note is what makes those three different afterwards. It is also the raw
-- material for improving the detector: "this was not a complaint, they were
-- asking about delivery" is a labelled negative, and there is no other way to
-- collect those at the rate a real reviewer produces them.
ALTER TABLE katibe.agent_posts
  ADD COLUMN IF NOT EXISTS closed_note text;

COMMENT ON COLUMN katibe.agent_posts.closed_note IS
  'Bağlayanın yazdığı səbəb. Bağlama üçün məcburidir (agent-actions.ts).';

-- Every close, kept separately from the post.
--
-- The post itself records only its current state, and a reopened-then-reclosed
-- flag would overwrite its own history. This table is append-only, so "who
-- closed what, when, and what did they say" survives a later edit — which is
-- the point: it exists to be read against the flags, not to be trusted
-- blindly.
CREATE TABLE IF NOT EXISTS katibe.flag_close_log (
  id            bigserial PRIMARY KEY,
  post_id       bigint NOT NULL REFERENCES katibe.agent_posts(id) ON DELETE CASCADE,
  closed_by     integer NOT NULL REFERENCES katibe.dashboard_users(id),
  closed_at     timestamptz NOT NULL DEFAULT now(),
  note          text NOT NULL,
  -- What the flag looked like at the moment it was closed, so the log reads on
  -- its own without re-joining a post that may since have changed.
  severity      integer,
  detector      text,
  title         text,
  -- Set later by an admin reviewing the log: was the close justified?
  verdict       text CHECK (verdict IS NULL OR verdict IN ('fair','wrong','unclear')),
  verdict_by    integer REFERENCES katibe.dashboard_users(id),
  verdict_at    timestamptz,
  verdict_note  text
);

CREATE INDEX IF NOT EXISTS flag_close_log_who_idx
  ON katibe.flag_close_log (closed_by, closed_at DESC);

-- The other direction: a conversation the agent did NOT flag but should have.
--
-- Detectors can only be measured against what they missed if someone records
-- the misses, and the person reading the chats all day is the only one who
-- sees them. Deliberately not tied to a post — there is no post; that is the
-- whole point.
CREATE TABLE IF NOT EXISTS katibe.missed_flag (
  id           bigserial PRIMARY KEY,
  instance_id  text NOT NULL,
  remote_jid   text NOT NULL,
  reported_by  integer NOT NULL REFERENCES katibe.dashboard_users(id),
  reported_at  timestamptz NOT NULL DEFAULT now(),
  note         text NOT NULL,
  -- Which of the reading detector's kinds this looks like, when the reporter
  -- can say. Free text would be unusable as a label.
  kind         text CHECK (kind IS NULL OR kind IN
                 ('leaving','broken_promise','anger','price_dispute','other')),
  -- An admin's later judgement, same shape as the close log's.
  verdict      text CHECK (verdict IS NULL OR verdict IN ('fair','wrong','unclear')),
  verdict_by   integer REFERENCES katibe.dashboard_users(id),
  verdict_at   timestamptz
);

CREATE INDEX IF NOT EXISTS missed_flag_chat_idx
  ON katibe.missed_flag (instance_id, remote_jid, reported_at DESC);

ALTER TABLE katibe.flag_close_log OWNER TO evolution;
ALTER TABLE katibe.missed_flag OWNER TO evolution;
ALTER SEQUENCE katibe.flag_close_log_id_seq OWNER TO evolution;
ALTER SEQUENCE katibe.missed_flag_id_seq OWNER TO evolution;
