-- Katibe's own message store, so Evolution becomes a source rather than the
-- database.
--
-- WHY THIS EXISTS. Everything the dashboard knows currently comes from
-- evolution_api."Message" — 25 files, ~72 references, three foreign keys. That
-- is fine while Evolution is the only source, and it stops being fine the
-- moment a second one arrives. Measured on 2026-08-31, the archive and
-- Evolution overlap on 93,589 messages, and each holds messages the other
-- does not: 1,465,862 only in the archive, 105,335 only in Evolution. Neither
-- is authoritative. A store that can hold both is the only shape that fits.
--
-- WHAT THIS MIGRATION DOES: creates the tables. Nothing reads them yet and no
-- existing query changes. The mirror, the comparison, and the cut-over are
-- separate steps, in that order, because two migrations debugged at once is
-- one migration too many.
--
-- THE REQUIREMENT THAT SHAPED IT. "Six months from now I want to migrate
-- again without separating old from new." So every import must be idempotent:
-- feeding the same export twice changes nothing, an interrupted run resumes,
-- and a newer export lands on top of the older rather than beside it. That is
-- what the unique key on (remote_jid, stanza_id) and katibe.message_source
-- are for.

-- ---------------------------------------------------------------- mənbələr
--
-- A source is one place messages come from: an Evolution instance, or one
-- archive import. Giving the archive a source id is what keeps src/lib/access.ts
-- working unchanged — its whole permission model resolves authorisation from an
-- instance id, and merged canonical rows have no single instance, while archive
-- rows have none at all. A synthetic source behaves like an instance to every
-- caller, and "archive is visible to its owner only" then falls out of
-- owner_user_id instead of needing a rule of its own.
CREATE TABLE IF NOT EXISTS katibe.source (
  -- Evolution instance uuid, or a stable label like 'archive:business'.
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('evolution','archive')),
  -- Whose source it is. NULL only for Evolution instances, whose ownership is
  -- already recorded in katibe.user_instances and must not be duplicated here.
  owner_user_id integer REFERENCES katibe.users(id) ON DELETE SET NULL,
  label         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ söhbət
--
-- One row per conversation, not per WhatsApp address. The same person reaches
-- us on 994...@s.whatsapp.net and on 356...@lid, and Evolution stores those as
-- two unrelated chats; the point of this table is that they are one.
--
-- HOW WELL THAT WORKS, measured rather than assumed: katibe.lid_number bridges
-- 484 of 2,169 @lid chats (22.3%), which is 53.3% of @lid messages — the
-- bridge is good on active conversations and thin in the tail. Unbridged @lid
-- chats simply get their own person_key and stay separate, so nothing breaks;
-- they just do not merge yet, and merge later as the number is harvested.
CREATE TABLE IF NOT EXISTS katibe.chat (
  id          bigserial PRIMARY KEY,
  -- Bare phone number when it is known, otherwise the jid itself. Deliberately
  -- not a jid: a jid is an address, and this is meant to outlive addresses.
  person_key  text NOT NULL UNIQUE,
  kind        text NOT NULL CHECK (kind IN ('individual','group','lid','broadcast','other')),
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every address the conversation has ever arrived on. Adding a row here is how
-- two timelines merge — no message data moves.
CREATE TABLE IF NOT EXISTS katibe.chat_jid (
  remote_jid  text PRIMARY KEY,
  chat_id     bigint NOT NULL REFERENCES katibe.chat(id) ON DELETE CASCADE,
  first_seen  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_jid_chat_idx ON katibe.chat_jid (chat_id);

-- ------------------------------------------------------------------- mesaj
--
-- THE DEDUPE KEY IS (remote_jid, stanza_id), AND THAT WAS MEASURED.
--
-- stanza_id alone is not unique: 284,042 rows carry only 196,503 distinct
-- ones. WhatsApp ids are unique per sender, not globally. Of the collisions,
-- 43,226 are the same message stored once per instance that belongs to the
-- group — those must merge, and this key merges them. 2,393 are the same id in
-- different chats — those must not merge, and this key keeps them apart.
--
-- The cost is known and accepted rather than discovered later: 46 of those
-- 43,226 groups hold genuinely different text and will be collapsed into one
-- row (0.016%). 5,104 differ only in timestamp, which is instances recording
-- their own receipt time; the earliest is kept as the closest to when the
-- message was actually sent.
CREATE TABLE IF NOT EXISTS katibe.message (
  id           bigserial PRIMARY KEY,
  chat_id      bigint NOT NULL REFERENCES katibe.chat(id) ON DELETE CASCADE,
  -- The address it arrived on, kept because it is half the identity above.
  remote_jid   text NOT NULL,
  stanza_id    text NOT NULL,
  -- Epoch seconds, matching evolution_api."Message"."messageTimestamp" so the
  -- window filters everywhere else in this codebase carry over unchanged.
  ts           integer NOT NULL,
  direction    text NOT NULL CHECK (direction IN ('in','out')),
  -- In a group, who spoke. NULL in a one-to-one chat, where remote_jid says it.
  sender_jid   text,
  sender_name  text,
  body         text,
  -- 'text' | 'image' | 'audio' | 'video' | 'document' | 'system' | …
  kind         text NOT NULL DEFAULT 'text',
  reply_to     text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_identity UNIQUE (remote_jid, stanza_id)
);

CREATE INDEX IF NOT EXISTS message_chat_ts_idx ON katibe.message (chat_id, ts DESC);
CREATE INDEX IF NOT EXISTS message_ts_idx ON katibe.message (ts DESC);

-- Which sources carry this message, and what each one calls it.
--
-- Separate from the message because a message can legitimately come from
-- several: 93,589 of them are in both the archive and Evolution today. Keeping
-- the link here means the message is stored once and the provenance is still
-- complete — and it is what lets a re-import six months from now recognise
-- what it has already seen instead of writing a second copy.
CREATE TABLE IF NOT EXISTS katibe.message_source (
  message_id  bigint NOT NULL REFERENCES katibe.message(id) ON DELETE CASCADE,
  source_id   text NOT NULL REFERENCES katibe.source(id) ON DELETE CASCADE,
  -- The id this source uses: Evolution's Message.id (a cuid), or the archive's
  -- messages.id. Lets a row be traced back without re-deriving it.
  external_id text NOT NULL,
  PRIMARY KEY (message_id, source_id)
);

CREATE INDEX IF NOT EXISTS message_source_source_idx
  ON katibe.message_source (source_id, external_id);

-- ------------------------------------------------------------------ media
--
-- Files are never copied here. The archive alone is 75.57 GB across 249,499
-- objects and this host has 43 GB free, so the only workable arrangement is
-- the one already in use: the bytes stay in Spaces and a single resolver
-- presigns them, from whichever prefix the row names.
--
-- The viewer rule is unchanged and deliberate: the endpoint takes a message
-- id, never a path, and looks the path up here. A row with storage 'absent'
-- renders a placeholder instead of breaking the transcript.
CREATE TABLE IF NOT EXISTS katibe.media (
  message_id  bigint PRIMARY KEY REFERENCES katibe.message(id) ON DELETE CASCADE,
  storage     text NOT NULL CHECK (storage IN ('evolution','archive','absent')),
  -- Key within the bucket, without a leading slash. NULL when 'absent'.
  object_key  text,
  mime        text,
  size_bytes  bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------- import jurnalı
--
-- Six months from now the question will be "has this file already been
-- imported, and how far did it get". That answer has to live somewhere other
-- than in someone's memory.
CREATE TABLE IF NOT EXISTS katibe.import_run (
  id           bigserial PRIMARY KEY,
  source_id    text NOT NULL REFERENCES katibe.source(id) ON DELETE CASCADE,
  -- What was read: an object key, a table name, a window.
  input        text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','ok','failed')),
  read_count   integer NOT NULL DEFAULT 0,
  inserted     integer NOT NULL DEFAULT 0,
  updated      integer NOT NULL DEFAULT 0,
  skipped      integer NOT NULL DEFAULT 0,
  error        text
);

CREATE INDEX IF NOT EXISTS import_run_source_idx
  ON katibe.import_run (source_id, started_at DESC);

-- Same reason as every other katibe table: the app and the cron scripts
-- connect as `evolution`, and a table created by `postgres` is invisible to
-- them with a bare "permission denied".
ALTER TABLE katibe.source         OWNER TO evolution;
ALTER TABLE katibe.chat           OWNER TO evolution;
ALTER TABLE katibe.chat_jid       OWNER TO evolution;
ALTER TABLE katibe.message        OWNER TO evolution;
ALTER TABLE katibe.message_source OWNER TO evolution;
ALTER TABLE katibe.media          OWNER TO evolution;
ALTER TABLE katibe.import_run     OWNER TO evolution;
ALTER SEQUENCE katibe.chat_id_seq       OWNER TO evolution;
ALTER SEQUENCE katibe.message_id_seq    OWNER TO evolution;
ALTER SEQUENCE katibe.import_run_id_seq OWNER TO evolution;
