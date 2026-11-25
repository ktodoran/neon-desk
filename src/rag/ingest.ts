import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../db/types.js';
import { chunkText, type ChunkOptions } from './chunk.js';
import { toVectorLiteral, type Embedder } from './embeddings.js';

export interface DocumentInput {
  /** Where the document comes from, for example "files" or "helpcenter". */
  readonly source: string;
  /** Stable identifier within `source`: a path, a URL, a CMS id. */
  readonly externalId: string;
  readonly title: string;
  readonly url?: string;
  readonly content: string;
}

export interface IngestResult {
  readonly status: 'created' | 'updated' | 'unchanged';
  readonly documentId: string;
  readonly chunks: number;
}

export interface IngestDependencies {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly chunking: ChunkOptions;
}

export class IngestError extends Error {
  override readonly name = 'IngestError';
}

/** Rows per INSERT. Five parameters per row keeps this far below Postgres's 65,535 limit. */
const INSERT_BATCH = 500;

/**
 * Adds a document to the knowledge base, or brings an existing one up to date.
 *
 * A document is identified by (source, externalId), not by its content, so an
 * edited document replaces its previous version instead of sitting beside it.
 * The content hash and embedding model are only used to skip work when neither changed.
 */
export async function ingestDocument(
  deps: IngestDependencies,
  doc: DocumentInput,
): Promise<IngestResult> {
  const { db, embedder, chunking } = deps;
  const contentHash = createHash('sha256').update(doc.content).digest('hex');
  const url = doc.url ?? null;

  const existing = await db.query<{
    id: string;
    content_hash: string;
    embedding_model: string | null;
    chunk_count: number;
  }>(
    `SELECT d.id, d.content_hash, d.embedding_model, count(c.id)::int AS chunk_count
       FROM documents d
       LEFT JOIN chunks c ON c.document_id = d.id
      WHERE d.source = $1 AND d.external_id = $2
      GROUP BY d.id`,
    [doc.source, doc.externalId],
  );
  const current = existing.rows[0];

  if (current?.content_hash === contentHash && current.embedding_model === embedder.model) {
    // Same text, same embedding model: keep the vectors, refresh only the metadata.
    await db.query('UPDATE documents SET title = $1, url = $2, updated_at = now() WHERE id = $3', [
      doc.title,
      url,
      current.id,
    ]);
    return { status: 'unchanged', documentId: current.id, chunks: current.chunk_count };
  }

  const chunks = chunkText(doc.content, chunking);
  if (chunks.length === 0) {
    throw new IngestError(`Document "${doc.externalId}" has no text to index`);
  }

  // Embed before opening the transaction. A network call should never hold a
  // database transaction open, and a failure here leaves the old version intact.
  const embeddings = await embedder.embed(chunks);
  if (embeddings.length !== chunks.length) {
    throw new IngestError('Embedder returned a different number of vectors than chunks');
  }

  const documentId = await db.transaction(async (tx) => {
    const upserted = await tx.query<{ id: string }>(
      `INSERT INTO documents (id, source, external_id, title, url, content_hash, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source, external_id) DO UPDATE
         SET title = EXCLUDED.title,
             url = EXCLUDED.url,
             content_hash = EXCLUDED.content_hash,
             embedding_model = EXCLUDED.embedding_model,
             updated_at = now()
       RETURNING id`,
      [randomUUID(), doc.source, doc.externalId, doc.title, url, contentHash, embedder.model],
    );
    const id = upserted.rows[0]?.id;
    if (id === undefined) throw new IngestError('Document upsert returned no row');

    await tx.query('DELETE FROM chunks WHERE document_id = $1', [id]);

    for (let start = 0; start < chunks.length; start += INSERT_BATCH) {
      const params: unknown[] = [];
      const rows: string[] = [];
      for (let i = start; i < Math.min(start + INSERT_BATCH, chunks.length); i += 1) {
        const embedding = embeddings[i];
        if (embedding === undefined) throw new IngestError('Missing embedding for chunk');
        const p = params.length;
        params.push(randomUUID(), id, i, chunks[i], toVectorLiteral(embedding));
        rows.push(
          `($${String(p + 1)}, $${String(p + 2)}, $${String(p + 3)}, $${String(p + 4)}, $${String(p + 5)}::vector)`,
        );
      }
      await tx.query(
        `INSERT INTO chunks (id, document_id, chunk_index, content, embedding) VALUES ${rows.join(', ')}`,
        params,
      );
    }

    return id;
  });

  return {
    status: current === undefined ? 'created' : 'updated',
    documentId,
    chunks: chunks.length,
  };
}
