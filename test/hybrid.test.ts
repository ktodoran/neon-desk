import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/types.js';
import { createHashEmbedder } from '../src/rag/embeddings.js';
import { ingestDocument } from '../src/rag/ingest.js';
import { hybridSearch, keywordSearch, reciprocalRankFusion } from '../src/rag/search.js';
import { createTestDatabase } from './helpers/database.js';

describe('reciprocalRankFusion', () => {
  it('ranks an item found by both lists above items found by one', () => {
    const scores = reciprocalRankFusion([
      ['a', 'b', 'c'],
      ['c', 'a', 'd'],
    ]);
    const order = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order).toEqual(['a', 'c', 'b', 'd']);
  });

  it('scores by rank position only', () => {
    const scores = reciprocalRankFusion([['a', 'b']], 60);
    expect(scores.get('a')).toBeCloseTo(1 / 61, 12);
    expect(scores.get('b')).toBeCloseTo(1 / 62, 12);
  });

  it('returns nothing for no rankings', () => {
    expect(reciprocalRankFusion([]).size).toBe(0);
  });
});

describe('keyword and hybrid search', () => {
  let db: Database;
  const embedder = createHashEmbedder();
  const chunking = { maxChars: 500, overlapChars: 50 };

  beforeAll(async () => {
    db = await createTestDatabase();
    const documents = [
      [
        'returns.md',
        'Returns',
        'Our return policy accepts returns within thirty days of delivery.',
      ],
      ['parts.md', 'Replacement parts', 'Order replacement part SKU-88412 for the hinge assembly.'],
      ['shipping.md', 'Shipping', 'Standard shipping takes five to seven business days.'],
    ] as const;
    for (const [externalId, title, content] of documents) {
      await ingestDocument(
        { db, embedder, chunking },
        { source: 'files', externalId, title, content },
      );
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it('finds an exact product code by keyword', async () => {
    const hits = await keywordSearch(db, 'SKU-88412', 5);
    expect(hits.map((hit) => hit.title)).toEqual(['Replacement parts']);
  });

  it('matches any term of a natural-language question, not all of them', async () => {
    const hits = await keywordSearch(db, 'how long does standard shipping usually take', 5);
    expect(hits[0]?.title).toBe('Shipping');
  });

  it('returns nothing for a query made only of stop words', async () => {
    expect(await keywordSearch(db, 'what is the', 5)).toEqual([]);
  });

  it('keeps a keyword match even when the vector threshold would reject it', async () => {
    const hits = await hybridSearch({ db, embedder }, 'SKU-88412', {
      topK: 3,
      candidates: 10,
      minScore: 0.99,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: 'Replacement parts', keywordMatch: true });
    expect(hits[0]?.vectorScore).not.toBeNull();
  });

  it('returns nothing when neither retriever has evidence', async () => {
    const hits = await hybridSearch({ db, embedder }, 'quantum chromodynamics', {
      topK: 3,
      candidates: 10,
      minScore: 0.3,
    });
    expect(hits).toEqual([]);
  });

  it('puts the chunk both retrievers agree on first, and respects topK', async () => {
    const hits = await hybridSearch({ db, embedder }, 'return policy', {
      topK: 1,
      candidates: 10,
      minScore: -1,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('Returns');
  });
});
