-- A fourth embedding of the same chunks: Qwen/Qwen3-Embedding-8B.
--
-- Tested alongside BGE-M3 for the same reason and at the same price. Both are
-- open-weight models served by a third party rather than by their authors,
-- which is the point: the question is whether a model family trained
-- deliberately across 100+ languages retrieves more of this transliterated
-- Azerbaijani than one trained on whatever the web supplied.
--
-- Stored at 1024 like the others. The model is natively 4096 and Matryoshka-
-- trained, so src/lib/embedding.ts truncates and renormalises rather than
-- relying on the gateway to honour a `dimensions` argument; pgvector's HNSW
-- would refuse 4096 in any case.
--
-- Provisional. Whichever of the three loses gets dropped.
ALTER TABLE katibe.message_chunk
  ADD COLUMN IF NOT EXISTS embedding_qwen vector(1024);

CREATE INDEX IF NOT EXISTS message_chunk_embedding_qwen_idx
  ON katibe.message_chunk USING hnsw (embedding_qwen vector_cosine_ops);
