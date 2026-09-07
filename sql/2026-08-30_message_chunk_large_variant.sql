-- A second embedding of the same chunks, for measuring one model against
-- another on the same rows.
--
-- text-embedding-3-small finds the topic of a query reliably and the specific
-- exchange almost never (recall@10 13% on the set in /var/lib/katibe/
-- search-eval.json). Two explanations fit that: the model does not really read
-- transliterated Azerbaijani, or dense retrieval ranks by subject rather than
-- by whether a passage answers the question. The first is a model problem and
-- this column tests it; the second is not, and no embedding model fixes it.
--
-- Kept in the same table on purpose. Both vectors describe the same text, so
-- the comparison is free of every other difference — chunking, filtering,
-- scope — that a separate table would quietly introduce.
--
-- 1024 rather than 3072 (the model's native width): Matryoshka truncation
-- again, and pgvector's HNSW cannot index beyond 2000 dimensions anyway.
--
-- This column is provisional. If large does not win, it and its index are
-- dropped in a follow-up migration rather than left to cost 200 MB forever.
ALTER TABLE katibe.message_chunk
  ADD COLUMN IF NOT EXISTS embedding_large vector(1024);

CREATE INDEX IF NOT EXISTS message_chunk_embedding_large_idx
  ON katibe.message_chunk USING hnsw (embedding_large vector_cosine_ops);
