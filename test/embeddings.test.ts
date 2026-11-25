import { describe, expect, it, vi } from 'vitest';
import {
  createEmbedder,
  createHashEmbedder,
  createOpenAIEmbedder,
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
} from '../src/rag/embeddings.js';

function cosine(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
}

describe('hash embedder', () => {
  const embedder = createHashEmbedder();

  it('is deterministic and unit length', async () => {
    const [a, b] = await embedder.embed(['return policy', 'return policy']);
    expect(a).toEqual(b);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...(a ?? []))).toBeCloseTo(1, 10);
  });

  it('scores texts that share words above texts that do not', async () => {
    const [query, related, unrelated] = await embedder.embed([
      'what is your return policy',
      'our return policy allows returns within thirty days',
      'international shipping takes two weeks',
    ]);
    expect(cosine(query ?? [], related ?? [])).toBeGreaterThan(
      cosine(query ?? [], unrelated ?? []),
    );
  });

  it('returns a usable vector for text with no words', async () => {
    const [vector] = await embedder.embed(['!!!']);
    expect(Math.hypot(...(vector ?? []))).toBeCloseTo(1, 10);
  });
});

describe('openai embedder', () => {
  const vectorOf = (value: number) => new Array<number>(4).fill(value);

  function fakeFetch(handler: (body: { input: string[] }) => Response) {
    return vi.fn<typeof fetch>((_url, init) => {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(raw) as { input: string[] };
      return Promise.resolve(handler(body));
    });
  }

  const options = {
    apiKey: 'test-key-not-real',
    baseUrl: 'https://embeddings.test/v1',
    model: 'test-model',
    dimensions: 4,
  };

  it('batches requests and restores input order', async () => {
    const fetchMock = fakeFetch(({ input }) =>
      Response.json({
        // Deliberately reversed: the API does not promise order, `index` does.
        data: input.map((text, index) => ({ index, embedding: vectorOf(Number(text)) })).reverse(),
      }),
    );
    const embedder = createOpenAIEmbedder({ ...options, batchSize: 2, fetch: fetchMock });

    const vectors = await embedder.embed(['1', '2', '3', '4', '5']);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vectors.map((vector) => vector[0])).toEqual([1, 2, 3, 4, 5]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://embeddings.test/v1/embeddings');
  });

  it('reports a failed request without leaking the key or the response body', async () => {
    const fetchMock = fakeFetch(
      () => new Response('upstream said: test-key-not-real', { status: 401 }),
    );
    const embedder = createOpenAIEmbedder({ ...options, fetch: fetchMock });

    const error = await embedder.embed(['a']).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmbeddingError);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('test-key-not-real');
  });

  it('rejects vectors of the wrong dimension', async () => {
    const fetchMock = fakeFetch(() => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }));
    const embedder = createOpenAIEmbedder({ ...options, fetch: fetchMock });
    await expect(embedder.embed(['a'])).rejects.toThrow(/dimension/);
  });

  it('rejects a response with the wrong number of vectors', async () => {
    const fetchMock = fakeFetch(() => Response.json({ data: [] }));
    const embedder = createOpenAIEmbedder({ ...options, fetch: fetchMock });
    await expect(embedder.embed(['a'])).rejects.toThrow(EmbeddingError);
  });

  it('wraps network failures', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    const embedder = createOpenAIEmbedder({ ...options, fetch: fetchMock });
    await expect(embedder.embed(['a'])).rejects.toThrow(EmbeddingError);
  });
});

describe('createEmbedder', () => {
  it('refuses to build the openai embedder without a key', () => {
    expect(() =>
      createEmbedder({
        provider: 'openai',
        apiKey: undefined,
        baseUrl: 'https://embeddings.test/v1',
        model: 'test-model',
      }),
    ).toThrow(EmbeddingError);
  });
});
