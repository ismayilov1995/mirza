-- Transcripts of WhatsApp voice messages.
--
-- One row per audio message, written by scripts/transcribe-voice.ts. Failures
-- are recorded too, with a status — without that the hourly cron would retry
-- the same unreachable file forever and bill for every attempt.
--
-- Nothing here is ever sent to WhatsApp; this table is read-only decoration
-- for the dashboard.
CREATE TABLE IF NOT EXISTS katibe.voice_transcript (
  message_id   text PRIMARY KEY
                 REFERENCES evolution_api."Message"(id) ON DELETE CASCADE,
  instance_id  text NOT NULL,
  remote_jid   text NOT NULL,
  -- The transcription itself. NULL when status <> 'ok'.
  text         text,
  -- Whatever language the model reported hearing (az / ru / en, mostly).
  language     text,
  model        text NOT NULL,
  duration_sec integer,
  -- ok         : transcribed
  -- unavailable: WhatsApp's CDN no longer has the file (~3 weeks and older),
  --              and no key can bring it back — never retry these
  -- failed     : something else went wrong; safe to clear the row to retry
  status       text NOT NULL CHECK (status IN ('ok','unavailable','failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS voice_transcript_chat_idx
  ON katibe.voice_transcript (instance_id, remote_jid);

-- Every other katibe table is owned by `evolution` (the role the app and the
-- cron scripts connect as). Creating this one as `postgres` left it
-- unreadable to them with a bare "permission denied for table".
ALTER TABLE katibe.voice_transcript OWNER TO evolution;
