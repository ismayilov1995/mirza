-- Conversation chunks over the canonical store.
--
-- Separate from katibe.message_chunk, which chunks evolution_api."Message" and
-- serves the live MCP search. This one chunks katibe.message, so it covers
-- both eras — the archive's nine years and the live feed — in one index.
--
-- The two exist side by side only during the migration. When the rest of the
-- app moves onto the canonical store, the live search moves onto this table
-- and the old one is dropped; until then the working search must not be
-- disturbed by work on the archive.
--
-- Same chunking rules as the live side, for the same measured reasons: a run
-- of consecutive messages rather than one message, because a third of what
-- people send is "ok" and its vector answers nothing; and 1024 dimensions of
-- Qwen3-Embedding-8B, which beat text-embedding-3-large on this corpus by more
-- than the entire reranking stage was worth.
CREATE TABLE IF NOT EXISTS katibe.chunk (
  id          bigserial PRIMARY KEY,
  chat_id     bigint NOT NULL REFERENCES katibe.chat(id) ON DELETE CASCADE,
  start_ts    integer NOT NULL,
  end_ts      integer NOT NULL,
  -- Canonical message ids, in order, so a hit expands back into real rows.
  message_ids bigint[] NOT NULL,
  text        text NOT NULL,
  embedding   vector(1024),
  model       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Identified by the message it opens with, NOT by start_ts. WhatsApp
-- timestamps have one-second resolution and a burst inside one second hits the
-- chunker's size ceiling mid-second, so two consecutive chunks legitimately
-- share an instant — which collides, and collides inside a single INSERT,
-- where Postgres rejects the whole batch. That lesson was paid for once
-- already on the live chunker.
CREATE UNIQUE INDEX IF NOT EXISTS chunk_head_idx
  ON katibe.chunk (chat_id, (message_ids[1]));

CREATE INDEX IF NOT EXISTS chunk_chat_idx ON katibe.chunk (chat_id, start_ts DESC);

CREATE INDEX IF NOT EXISTS chunk_embedding_idx
  ON katibe.chunk USING hnsw (embedding vector_cosine_ops);

ALTER TABLE katibe.chunk OWNER TO evolution;
ALTER SEQUENCE katibe.chunk_id_seq OWNER TO evolution;
