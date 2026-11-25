/**
 * Width of every stored embedding. The `chunks.embedding` column is declared
 * with this dimension, so changing it requires a migration and a re-ingest.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export interface Embedder {
  readonly dimensions: number;
  /** Returns one vector per input, in input order. */
  readonly embed: (texts: readonly string[]) => Promise<number[][]>;
}

export class EmbeddingError extends Error {
  override readonly name = 'EmbeddingError';
}

export interface OpenAIEmbedderOptions {
  readonly apiKey: string;
  /** Base URL of any OpenAI-compatible API, without a trailing slash. */
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions?: number;
  /** Inputs per request. */
  readonly batchSize?: number;
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
}

interface EmbeddingsResponse {
  data: { index: number; embedding: number[] }[];
}

function isEmbeddingsResponse(body: unknown): body is EmbeddingsResponse {
  if (typeof body !== 'object' || body === null || !('data' in body)) return false;
  const { data } = body;
  return (
    Array.isArray(data) &&
    data.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'index' in item &&
        typeof item.index === 'number' &&
        'embedding' in item &&
        Array.isArray(item.embedding),
    )
  );
}

/**
 * Embeds text through the OpenAI embeddings HTTP API, or any service that
 * implements the same contract. Uses `fetch` directly: the contract is one
 * endpoint, and avoiding an SDK keeps the provider swappable by URL.
 */
export function createOpenAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
  const batchSize = options.batchSize ?? 64;
  const doFetch = options.fetch ?? fetch;

  async function embedBatch(batch: readonly string[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await doFetch(`${options.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model: options.model, input: batch, dimensions }),
      });
    } catch (cause) {
      throw new EmbeddingError('Embeddings request failed before a response arrived', { cause });
    }

    if (!response.ok) {
      // Report the status only. The response body and request headers stay out of logs.
      throw new EmbeddingError(`Embeddings request failed with HTTP ${String(response.status)}`);
    }

    const body: unknown = await response.json();
    if (!isEmbeddingsResponse(body) || body.data.length !== batch.length) {
      throw new EmbeddingError('Embeddings response did not match the request');
    }

    const vectors = [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    if (vectors.some((vector) => vector.length !== dimensions)) {
      throw new EmbeddingError(
        `Embeddings response had the wrong dimension (expected ${String(dimensions)})`,
      );
    }
    return vectors;
  }

  return {
    dimensions,
    async embed(texts: readonly string[]): Promise<number[][]> {
      const vectors: number[][] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        vectors.push(...(await embedBatch(texts.slice(start, start + batchSize))));
      }
      return vectors;
    },
  };
}

/** FNV-1a, 32-bit. */
function hash(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic, offline embedder: a hashed bag of words, L2-normalized.
 * Texts that share words score as similar, which is enough to exercise the
 * pipeline end to end without a network call or an API key.
 *
 * It has no notion of meaning. Use it for tests and local development only.
 */
export function createHashEmbedder(dimensions: number = EMBEDDING_DIMENSIONS): Embedder {
  function embedOne(text: string): number[] {
    const vector = new Array<number>(dimensions).fill(0);
    for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      const h = hash(token);
      const index = h % dimensions;
      // The top bit picks a sign, so unrelated tokens that collide tend to cancel.
      vector[index] = (vector[index] ?? 0) + (h & 0x80000000 ? -1 : 1);
    }
    const norm = Math.hypot(...vector);
    // An all-zero vector has no direction, and cosine distance to it is undefined.
    if (norm === 0) {
      vector[0] = 1;
      return vector;
    }
    return vector.map((value) => value / norm);
  }

  return {
    dimensions,
    embed: (texts) => Promise.resolve(texts.map(embedOne)),
  };
}

export interface EmbedderConfig {
  readonly provider: 'openai' | 'hash';
  readonly apiKey: string | undefined;
  readonly baseUrl: string;
  readonly model: string;
}

export function createEmbedder(config: EmbedderConfig): Embedder {
  if (config.provider === 'hash') return createHashEmbedder();
  if (config.apiKey === undefined) {
    throw new EmbeddingError('An API key is required for the "openai" embeddings provider');
  }
  return createOpenAIEmbedder({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
  });
}

/** pgvector's text input format. */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(',')}]`;
}
