-- Semantic retrieval over the message archive.
--
-- WHY CHUNKS AND NOT MESSAGES. A third of what people send is "ok", "bəli",
-- "👍" or a bare phone number. Embedded alone those vectors are noise: they
-- sit near every other short message and crowd out real answers. A chunk is a
-- run of consecutive messages inside one chat, so the short ones ride along
-- with the sentence they were answering — which is also the unit a model wants
-- handed back to it. ~280k messages collapse to roughly 40k chunks.
--
-- WHY 512 DIMENSIONS. text-embedding-3-small is natively 1536, but it is
-- trained with Matryoshka representation learning, so a 512-dim truncation
-- keeps retrieval quality while cutting this table from ~1.3 GB to ~430 MB and
-- the HNSW build with it. pgvector 0.6.0 has no halfvec (0.7.0+), so shrinking
-- the dimension is the only lever available here.
--
-- Written by scripts/embed-messages.ts. Nothing here is ever sent to WhatsApp.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS katibe.message_chunk (
  id           bigserial PRIMARY KEY,
  instance_id  text NOT NULL,
  remote_jid   text NOT NULL,
  -- Epoch seconds, matching evolution_api."Message"."messageTimestamp" so the
  -- window filters here can be compared against the rest of the codebase
  -- without a conversion on either side.
  start_ts     integer NOT NULL,
  end_ts       integer NOT NULL,
  -- Message ids covered, in order. Keeping them lets a hit be expanded back
  -- into real rows (sender, media, links) instead of only the flattened text.
  message_ids  text[] NOT NULL,
  -- The flattened text that was actually embedded, speaker-labelled. Stored
  -- rather than rebuilt: the chunker's output must stay stable for as long as
  -- the vector beside it does.
  text         text NOT NULL,
  embedding    vector(512),
  model        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Every read is scoped to one instance (src/lib/access.ts), and the vector
-- scan has to be filtered by it too — a shared index with no instance
-- predicate would let one account's search surface another's chunks.
CREATE INDEX IF NOT EXISTS message_chunk_scope_idx
  ON katibe.message_chunk (instance_id, remote_jid, start_ts DESC);

-- Resumability for the backfill: "where did this chat get to" in one seek.
CREATE INDEX IF NOT EXISTS message_chunk_progress_idx
  ON katibe.message_chunk (instance_id, remote_jid, end_ts DESC);

-- A chunk is identified by the message it opens with, so re-running the
-- chunker over the same span updates in place instead of duplicating.
--
-- NOT start_ts, which is the obvious choice and is wrong: WhatsApp timestamps
-- have one-second resolution, and a burst of a dozen messages inside one
-- second hits the chunker's size ceiling mid-second, so two consecutive chunks
-- of the same chat legitimately start at the same instant. That collides here
-- and, worse, collides *within a single INSERT*, which Postgres rejects
-- outright with "ON CONFLICT DO UPDATE command cannot affect row a second
-- time" — the whole batch fails, not just the pair.
CREATE UNIQUE INDEX IF NOT EXISTS message_chunk_head_idx
  ON katibe.message_chunk (instance_id, remote_jid, (message_ids[1]));

-- Cosine, because embedding vectors are already unit-normalised and cosine is
-- what OpenAI documents for this model family.
--
-- HNSW rather than IVFFlat: it needs no representative sample to be trained
-- against, which matters because this table starts empty and fills over
-- several backfill runs. m/ef_construction are the pgvector defaults; at 40k
-- rows they are not the limiting factor.
CREATE INDEX IF NOT EXISTS message_chunk_embedding_idx
  ON katibe.message_chunk USING hnsw (embedding vector_cosine_ops);

-- Same reason as katibe.voice_transcript: the app and the cron scripts connect
-- as `evolution`, and a table created by `postgres` is invisible to them.
ALTER TABLE katibe.message_chunk OWNER TO evolution;
ALTER SEQUENCE katibe.message_chunk_id_seq OWNER TO evolution;
