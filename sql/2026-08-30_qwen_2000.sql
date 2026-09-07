-- The same model at the widest vector pgvector can index.
--
-- Qwen3-Embedding-8B is natively 4096 and Matryoshka-trained, and it won the
-- comparison at 1024 — the width chosen so every candidate was measured at
-- equal storage:
--
--                       recall@5  MRR    ceiling
--   text-embedding-3-large   25%  0.186      44%
--   bge-m3                   38%  0.260      56%
--   qwen 1024                56%  0.334      75%
--
-- That fairness cost Qwen three quarters of its signal, so this asks what the
-- quarter we kept was leaving behind. 2000 and not 4096 because pgvector's
-- HNSW refuses beyond 2000 dimensions — this is the ceiling of the index, not
-- a tuning choice.
--
-- Provisional like the others: if the extra width does not pay, the column and
-- its index are dropped rather than left to cost 400 MB.
ALTER TABLE katibe.message_chunk
  ADD COLUMN IF NOT EXISTS embedding_qwen2k vector(2000);

CREATE INDEX IF NOT EXISTS message_chunk_embedding_qwen2k_idx
  ON katibe.message_chunk USING hnsw (embedding_qwen2k vector_cosine_ops);
