import type { Queryable } from '../db/types.js';
import { toVectorLiteral, type Embedder } from './embeddings.js';

export interface SearchHit {
  readonly chunkId: string;
  readonly documentId: string;
  readonly chunkIndex: number;
  readonly content: string;
  readonly title: string;
  readonly url: string | null;
  readonly source: string;
  /** Cosine similarity between the query and the chunk, from -1 to 1. */
  readonly score: number;
}

export interface SearchOptions {
  readonly topK: number;
  /** Hits scoring below this are dropped. */
  readonly minScore: number;
}

export interface SearchDependencies {
  readonly db: Queryable;
  readonly embedder: Embedder;
}

interface Row {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  title: string;
  url: string | null;
  source: string;
  score: number;
}

/**
 * Returns the chunks most similar to `query`, best first.
 *
 * The score threshold is applied here rather than in SQL. The index already
 * returns the nearest `topK` in order, so a WHERE clause on the computed score
 * could only post-filter those same rows, and keeping it out leaves the query
 * in the exact `ORDER BY embedding <=> $1 LIMIT k` shape the HNSW index serves.
 */
export async function searchChunks(
  deps: SearchDependencies,
  query: string,
  options: SearchOptions,
): Promise<SearchHit[]> {
  const [embedding] = await deps.embedder.embed([query]);
  if (embedding === undefined) return [];

  const { rows } = await deps.db.query<Row>(
    `SELECT c.id AS chunk_id,
            c.document_id,
            c.chunk_index,
            c.content,
            d.title,
            d.url,
            d.source,
            (1 - (c.embedding <=> $1::vector))::float8 AS score
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2`,
    [toVectorLiteral(embedding), options.topK],
  );

  return rows
    .map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      content: row.content,
      title: row.title,
      url: row.url,
      source: row.source,
      score: row.score,
    }))
    .filter((hit) => hit.score >= options.minScore);
}
