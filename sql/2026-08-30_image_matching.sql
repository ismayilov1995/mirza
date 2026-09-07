-- Matching photos people send against the dress collection.
--
-- THE PROBLEM. Customers send a picture and ask about it — a screenshot from a
-- lookbook, or a close-up of a gown at a fitting — and nothing in the system
-- knows which of the 406 models that is. The text half of search cannot help:
-- these messages usually carry no caption at all.
--
-- SCOPE, DELIBERATELY NARROW. Only chats categorised `Client`, plus individual
-- chats with no category yet. 85% of incoming images come from groups that are
-- internal — logistics, shipping barcodes, store chatter, fabric photos — and
-- matching those against a dress catalogue is wasted work. Measured on the
-- images stored so far: 237 in scope against 2,539 out of it.
--
-- WHY TWO TABLES AND NOT A COLUMN ON Message. Evolution owns that table and
-- Prisma migrates it; everything katibe derives lives beside it, as with
-- voice_transcript.
CREATE TABLE IF NOT EXISTS katibe.catalog_item (
  -- The article code, which is also the filename the collection arrived in
  -- (B2501.jpg) and the vocabulary the business already uses in chat.
  code        text PRIMARY KEY,
  -- Leading letters of the code: B, C, S, P, F, R. Kept split out because a
  -- series is a collection and people ask about them as such.
  series      text NOT NULL,
  file_path   text NOT NULL,
  -- CLIP ViT-B/32, 512 dimensions, images and text in one space.
  embedding   vector(512),
  model       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catalog_item_embedding_idx
  ON katibe.catalog_item USING hnsw (embedding vector_cosine_ops);

-- One row per incoming image we have looked at, including the ones we could
-- not fetch: without recording those, every run would retry the same dead
-- media forever — the lesson voice_transcript already paid for.
CREATE TABLE IF NOT EXISTS katibe.message_image (
  message_id  text PRIMARY KEY
                REFERENCES evolution_api."Message"(id) ON DELETE CASCADE,
  instance_id text NOT NULL,
  remote_jid  text NOT NULL,
  embedding   vector(512),
  model       text,
  -- ok         : embedded
  -- unavailable: the stored copy is gone and cannot come back
  -- failed     : something else; safe to clear the row to retry
  status      text NOT NULL CHECK (status IN ('ok','unavailable','failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_image_scope_idx
  ON katibe.message_image (instance_id, remote_jid);

CREATE INDEX IF NOT EXISTS message_image_embedding_idx
  ON katibe.message_image USING hnsw (embedding vector_cosine_ops);

ALTER TABLE katibe.catalog_item OWNER TO evolution;
ALTER TABLE katibe.message_image OWNER TO evolution;
