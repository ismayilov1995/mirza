-- Keeps the winner, drops the three models measured out of the job today.
--
-- All four were embedded over the same 52,872 chunks and scored on the same
-- sixteen cases (/var/lib/katibe/search-eval.json). Rerank figures are the
-- mean of three runs, because a single run of it swings by about 0.08:
--
--                        recall@5  MRR    ceiling
--   text-embedding-3-small    19%  0.125      19%   (where the day started)
--   text-embedding-3-large    38%  0.277      44%
--   bge-m3                    38%  0.260      56%
--   qwen 1024                 54%  0.373      75%   <- kept
--   qwen 2000                 58%  0.398      81%
--
-- The 2000-wide variant is dropped despite the higher mean: its MRR range
-- (0.395-0.402) sits inside the 1024 variant's (0.345-0.414) and recall@10 is
-- identical, so the difference is not something sixteen cases can resolve.
-- What it does cost is real — 423 MB and twice the embedding time on every
-- new chunk, forever.
--
-- Nothing is lost that cannot be rebuilt: re-embedding any of these is a
-- column, a VARIANTS entry and an hour or two. The numbers above are the
-- durable part, and they are also in the commits that produced them.
--
-- After this the live vector is called `embedding` again, which it has not
-- been since the -large column was retired in place this morning.
DROP INDEX IF EXISTS katibe.message_chunk_embedding_idx;
DROP INDEX IF EXISTS katibe.message_chunk_embedding_bge_idx;
DROP INDEX IF EXISTS katibe.message_chunk_embedding_qwen2k_idx;

ALTER TABLE katibe.message_chunk
  DROP COLUMN IF EXISTS embedding,
  DROP COLUMN IF EXISTS embedding_bge,
  DROP COLUMN IF EXISTS embedding_qwen2k;

ALTER TABLE katibe.message_chunk RENAME COLUMN embedding_qwen TO embedding;
ALTER INDEX katibe.message_chunk_embedding_qwen_idx RENAME TO message_chunk_embedding_idx;
