import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/types.js';
import { createHashEmbedder } from '../src/rag/embeddings.js';
import { ingestDocument } from '../src/rag/ingest.js';
import { searchChunks } from '../src/rag/search.js';
import { createTestDatabase } from './helpers/database.js';

const documents = [
  {
    source: 'files',
    externalId: 'returns.md',
    title: 'Returns',
    url: 'https://example.com/help/returns',
    content: 'Our return policy accepts returns within thirty days of delivery for a full refund.',
  },
  {
    source: 'files',
    externalId: 'shipping.md',
    title: 'Shipping',
    content:
      'Standard shipping takes five to seven business days. Express shipping takes two days.',
  },
  {
    source: 'files',
    externalId: 'warranty.md',
    title: 'Warranty',
    content: 'Every product carries a one year limited warranty against manufacturing defects.',
  },
];

describe('searchChunks', () => {
  let db: Database;
  const embedder = createHashEmbedder();

  beforeAll(async () => {
    db = await createTestDatabase();
    for (const doc of documents) {
      await ingestDocument({ db, embedder, chunking: { maxChars: 500, overlapChars: 50 } }, doc);
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it('ranks the most relevant chunk first and carries its document metadata', async () => {
    const hits = await searchChunks({ db, embedder }, 'what is your return policy', {
      topK: 3,
      minScore: 0,
    });

    expect(hits[0]).toMatchObject({
      title: 'Returns',
      url: 'https://example.com/help/returns',
      source: 'files',
      chunkIndex: 0,
    });
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 1);
  });

  it('returns scores in descending order', async () => {
    const hits = await searchChunks({ db, embedder }, 'how long does shipping take', {
      topK: 3,
      minScore: -1,
    });
    expect(hits).toHaveLength(3);
    expect(hits[0]?.title).toBe('Shipping');
    const scores = hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('respects topK', async () => {
    const hits = await searchChunks({ db, embedder }, 'shipping', { topK: 1, minScore: -1 });
    expect(hits).toHaveLength(1);
  });

  it('drops hits below the score threshold', async () => {
    const hits = await searchChunks({ db, embedder }, 'quantum chromodynamics lecture notes', {
      topK: 3,
      minScore: 0.3,
    });
    expect(hits).toEqual([]);
  });

  it('returns null for a document with no URL', async () => {
    const hits = await searchChunks({ db, embedder }, 'limited warranty defects', {
      topK: 1,
      minScore: 0,
    });
    expect(hits[0]?.url).toBeNull();
  });
});
