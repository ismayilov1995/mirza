-- A third embedding of the same chunks, for testing BAAI/bge-m3.
--
-- WHAT THIS IS TESTING. After adopting text-embedding-3-large the ranking is
-- as good as the candidates allow — the reranker puts the answer on top
-- whenever the index fetched it — but the index fetches it only 44% of the
-- time. That 44% is the ceiling, and no reranker can pass it. This column asks
-- whether a different model family fetches more.
--
-- WHY THIS MODEL. BGE-M3 is trained on 100+ languages including Azerbaijani,
-- where OpenAI's models are trained on whatever the web gave them; this
-- archive is transliterated Azerbaijani mixed with Russian, which is where the
-- misses are. Its dense output is natively 1024, so it needs no truncation and
-- fits the same column width as the current one.
--
-- WHY IT IS NOT RUN LOCALLY. BGE-M3 is XLM-RoBERTa-large — 568M parameters,
-- over a gigabyte of weights at fp16. This host has 1.9 GB of RAM with about
-- 850 MB free, two cores, no GPU, and is simultaneously holding live WhatsApp
-- connections, Postgres and the dashboard. It is served over an API instead
-- (see VARIANTS in src/lib/embedding.ts), at roughly $0.04 for the archive.
--
-- Provisional, like the large column was: dropped in a follow-up if it loses.
ALTER TABLE katibe.message_chunk
  ADD COLUMN IF NOT EXISTS embedding_bge vector(1024);

CREATE INDEX IF NOT EXISTS message_chunk_embedding_bge_idx
  ON katibe.message_chunk USING hnsw (embedding_bge vector_cosine_ops);
