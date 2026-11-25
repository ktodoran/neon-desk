import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db/types.js';
import { createHashEmbedder, type Embedder } from '../src/rag/embeddings.js';
import { ingestDocument, IngestError } from '../src/rag/ingest.js';
import { createTestDatabase } from './helpers/database.js';

const chunking = { maxChars: 120, overlapChars: 20 };

const policy = {
  source: 'files',
  externalId: 'returns.md',
  title: 'Returns',
  content:
    'Returns are accepted within thirty days of delivery. Items must be unused. ' +
    'Refunds go back to the original payment method within five business days. ' +
    'Sale items can only be exchanged.',
};

/** A real embedder wrapped so tests can count calls. */
function spyEmbedder(): Embedder & { embed: ReturnType<typeof vi.fn<Embedder['embed']>> } {
  const real = createHashEmbedder();
  return {
    model: real.model,
    dimensions: real.dimensions,
    embed: vi.fn<Embedder['embed']>((texts) => real.embed(texts)),
  };
}

async function count(db: Database, table: 'documents' | 'chunks'): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]?.n ?? -1;
}

describe('ingestDocument', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    await db.close();
  });

  it('creates a document with one row per chunk', async () => {
    const result = await ingestDocument({ db, embedder: spyEmbedder(), chunking }, policy);

    expect(result.status).toBe('created');
    expect(result.chunks).toBeGreaterThan(1);
    expect(await count(db, 'documents')).toBe(1);
    expect(await count(db, 'chunks')).toBe(result.chunks);
  });

  it('skips embedding when the content has not changed', async () => {
    const embedder = spyEmbedder();
    const first = await ingestDocument({ db, embedder, chunking }, policy);
    const second = await ingestDocument(
      { db, embedder, chunking },
      { ...policy, title: 'Returns policy' },
    );

    expect(second).toEqual({
      status: 'unchanged',
      documentId: first.documentId,
      chunks: first.chunks,
    });
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    const { rows } = await db.query<{ title: string }>('SELECT title FROM documents');
    expect(rows).toEqual([{ title: 'Returns policy' }]);
  });

  it('replaces an edited document instead of adding a second copy', async () => {
    const embedder = spyEmbedder();
    const first = await ingestDocument({ db, embedder, chunking }, policy);
    const edited = { ...policy, content: 'Returns are accepted within sixty days.' };
    const second = await ingestDocument({ db, embedder, chunking }, edited);

    expect(second.status).toBe('updated');
    expect(second.documentId).toBe(first.documentId);
    expect(await count(db, 'documents')).toBe(1);
    expect(await count(db, 'chunks')).toBe(1);
    const { rows } = await db.query<{ content: string }>('SELECT content FROM chunks');
    expect(rows).toEqual([{ content: 'Returns are accepted within sixty days.' }]);
  });

  it('keeps documents from different sources apart even when ids collide', async () => {
    const embedder = spyEmbedder();
    await ingestDocument({ db, embedder, chunking }, policy);
    const other = await ingestDocument(
      { db, embedder, chunking },
      { ...policy, source: 'helpcenter' },
    );

    expect(other.status).toBe('created');
    expect(await count(db, 'documents')).toBe(2);
  });

  it('leaves the previous version intact when embedding fails', async () => {
    const good = spyEmbedder();
    const first = await ingestDocument({ db, embedder: good, chunking }, policy);

    const failing: Embedder = {
      model: good.model,
      dimensions: good.dimensions,
      embed: () => Promise.reject(new Error('provider is down')),
    };
    await expect(
      ingestDocument({ db, embedder: failing, chunking }, { ...policy, content: 'New text.' }),
    ).rejects.toThrow('provider is down');

    expect(await count(db, 'chunks')).toBe(first.chunks);
  });

  it('rolls the whole write back when a chunk cannot be stored', async () => {
    const good = spyEmbedder();
    const first = await ingestDocument({ db, embedder: good, chunking }, policy);

    // Vectors of the wrong width are rejected by the column type, mid-transaction,
    // after the old chunks have already been deleted inside it.
    const wrongWidth: Embedder = {
      model: good.model,
      dimensions: 3,
      embed: (texts) => Promise.resolve(texts.map(() => [1, 0, 0])),
    };
    await expect(
      ingestDocument({ db, embedder: wrongWidth, chunking }, { ...policy, content: 'New text.' }),
    ).rejects.toThrow();

    expect(await count(db, 'chunks')).toBe(first.chunks);
    const { rows } = await db.query<{ content: string }>(
      'SELECT content FROM chunks ORDER BY chunk_index LIMIT 1',
    );
    expect(rows[0]?.content).toContain('Returns are accepted within thirty days');
  });

  it('re-embeds an unchanged document when the embedding model changes', async () => {
    const first = spyEmbedder();
    await ingestDocument({ db, embedder: first, chunking }, policy);

    // Same text, different model: the stored vectors are no longer comparable.
    const real = createHashEmbedder();
    const second = { ...spyEmbedder(), model: 'another-model' };
    const result = await ingestDocument({ db, embedder: second, chunking }, policy);

    expect(result.status).toBe('updated');
    expect(second.embed).toHaveBeenCalledTimes(1);
    const { rows } = await db.query<{ embedding_model: string }>(
      'SELECT embedding_model FROM documents',
    );
    expect(rows).toEqual([{ embedding_model: 'another-model' }]);
    expect(real.model).toBe('hash-v1');
  });

  it('rejects a document with no text', async () => {
    await expect(
      ingestDocument({ db, embedder: spyEmbedder(), chunking }, { ...policy, content: '  \n ' }),
    ).rejects.toThrow(IngestError);
    expect(await count(db, 'documents')).toBe(0);
  });
});
