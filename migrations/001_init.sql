-- Knowledge base: source documents and their embedded chunks.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id            UUID PRIMARY KEY,
  -- Where the document came from ("files", "helpcenter", ...) and its stable id there.
  -- Together they identify a document across re-ingests, so an edit updates in place.
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  title         TEXT NOT NULL,
  url           TEXT,
  -- SHA-256 of the content. Lets a re-ingest skip unchanged documents without re-embedding.
  content_hash  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, external_id)
);

CREATE TABLE chunks (
  id            UUID PRIMARY KEY,
  document_id   UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  -- Dimension must match EMBEDDING_DIMENSIONS in src/rag/embeddings.ts.
  embedding     vector(1536) NOT NULL,
  UNIQUE (document_id, chunk_index)
);

-- HNSW rather than IVFFlat: no training step, so recall does not depend on
-- how many rows existed when the index was built.
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
