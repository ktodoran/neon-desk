-- Full-text search over chunks, alongside the vector index.
--
-- Embeddings are good at meaning and weak at exact tokens: order numbers,
-- product codes, error strings. A lexical index covers that gap.

ALTER TABLE chunks
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;

CREATE INDEX chunks_tsv_gin ON chunks USING gin (tsv);
