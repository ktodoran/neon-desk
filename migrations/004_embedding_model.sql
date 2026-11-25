-- Which embedding model produced a document's vectors.
--
-- Vectors from different models are not comparable. Recording the model lets
-- a re-ingest detect a model change and re-embed, instead of skipping the
-- document as "unchanged" and leaving stale vectors behind.
-- Rows that predate this column have NULL and are re-embedded on next ingest.

ALTER TABLE documents ADD COLUMN embedding_model TEXT;
