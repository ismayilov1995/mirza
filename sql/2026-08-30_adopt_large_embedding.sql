-- Promotes the large embedding to the live one and removes the small.
--
-- Measured on /var/lib/katibe/search-eval.json, sixteen known-item cases:
--
--                     recall@1  recall@5  MRR    ceiling
--   small                   6%       19%  0.125      19%
--   large                  13%       25%  0.186      44%
--   large + rerank         31%       38%  0.331      44%
--
-- The ceiling — how often the answer was among the candidates at all — is what
-- decided it. text-embedding-3-small could not retrieve four cases in five,
-- and no amount of reordering reaches what was never fetched.
--
-- The small column is dropped rather than kept "just in case": it is 108 MB
-- and 52,787 rows of a model we have now measured and rejected, and the
-- comparison that justified it is recorded here and in git.
--
-- After this, `embedding` means the live vector, whatever model currently
-- fills it. The A/B pattern that produced the table above stays available:
-- add a column, add an entry to VARIANTS in src/lib/embedding.ts, run
-- `npm run embed:variant`, then `npm run eval:search`.
DROP INDEX IF EXISTS katibe.message_chunk_embedding_idx;
ALTER TABLE katibe.message_chunk DROP COLUMN IF EXISTS embedding;

ALTER TABLE katibe.message_chunk RENAME COLUMN embedding_large TO embedding;
ALTER INDEX katibe.message_chunk_embedding_large_idx
  RENAME TO message_chunk_embedding_idx;
