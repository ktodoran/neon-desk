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

function toHit(row: Row): SearchHit {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    title: row.title,
    url: row.url,
    source: row.source,
    score: row.score,
  };
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

  return rows.map(toHit).filter((hit) => hit.score >= options.minScore);
}

export interface RetrievedChunk extends SearchHit {
  /** Cosine similarity, or null when only the keyword search found this chunk. */
  readonly vectorScore: number | null;
  /** True when the full-text search matched this chunk. */
  readonly keywordMatch: boolean;
}

export interface HybridSearchOptions {
  /** Chunks to return after fusion. */
  readonly topK: number;
  /** Chunks to take from each retriever before fusion. */
  readonly candidates: number;
  /** Minimum cosine similarity for a chunk found by vector search alone. */
  readonly minScore: number;
}

/**
 * Full-text search. Terms are OR-ed: a customer's question rarely contains
 * only words that all appear in one passage, and ranking handles the rest.
 */
export async function keywordSearch(
  db: Queryable,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  const { rows } = await db.query<Row>(
    `WITH q AS (
       SELECT NULLIF(replace(plainto_tsquery('english', $1)::text, '&', '|'), '')::tsquery AS tsq
     )
     SELECT c.id AS chunk_id,
            c.document_id,
            c.chunk_index,
            c.content,
            d.title,
            d.url,
            d.source,
            ts_rank_cd(c.tsv, q.tsq)::float8 AS score
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       CROSS JOIN q
      WHERE q.tsq IS NOT NULL AND c.tsv @@ q.tsq
      ORDER BY score DESC, c.id
      LIMIT $2`,
    [query, limit],
  );
  return rows.map(toHit);
}

/**
 * Reciprocal rank fusion. Each list contributes 1 / (k + rank) to an item's
 * score, so the result depends only on rank positions. That matters here
 * because cosine similarity and ts_rank are on unrelated scales and cannot be
 * added or compared directly.
 *
 * `k` damps the advantage of the very top ranks; 60 is the value from the
 * original RRF paper and the usual default.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k = 60,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return scores;
}

/**
 * Vector and keyword search, fused. A chunk is kept if either retriever has
 * real evidence for it: a keyword match, or a cosine score above `minScore`.
 * An empty result means the knowledge base has nothing relevant, and the
 * caller should not ask a model to answer.
 */
export async function hybridSearch(
  deps: SearchDependencies,
  query: string,
  options: HybridSearchOptions,
): Promise<RetrievedChunk[]> {
  const [byVector, byKeyword] = await Promise.all([
    searchChunks(deps, query, { topK: options.candidates, minScore: -1 }),
    keywordSearch(deps.db, query, options.candidates),
  ]);

  const vectorScores = new Map(byVector.map((hit) => [hit.chunkId, hit.score]));
  const keywordIds = new Set(byKeyword.map((hit) => hit.chunkId));
  const fused = reciprocalRankFusion([
    byVector.map((hit) => hit.chunkId),
    byKeyword.map((hit) => hit.chunkId),
  ]);

  const byId = new Map([...byVector, ...byKeyword].map((hit) => [hit.chunkId, hit]));
  return [...byId.values()]
    .map((hit) => ({
      ...hit,
      score: fused.get(hit.chunkId) ?? 0,
      vectorScore: vectorScores.get(hit.chunkId) ?? null,
      keywordMatch: keywordIds.has(hit.chunkId),
    }))
    .filter((hit) => hit.keywordMatch || (hit.vectorScore ?? -1) >= options.minScore)
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, options.topK);
}
