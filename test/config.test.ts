import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://localhost/test',
  EMBEDDINGS_PROVIDER: 'hash',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.database).toEqual({
      url: 'postgres://localhost/test',
      ssl: false,
      poolMax: 10,
    });
    expect(config.rag).toEqual({
      topK: 5,
      candidates: 20,
      minScore: 0.3,
      chunkMaxChars: 1000,
      chunkOverlapChars: 150,
    });
    expect(config.llm).toBeUndefined();
  });

  it('reads the string "false" as false', () => {
    // The bug this replaces: z.coerce.boolean() turns any non-empty string into true.
    expect(loadConfig({ ...base, DATABASE_SSL: 'false' }).database.ssl).toBe(false);
    expect(loadConfig({ ...base, DATABASE_SSL: '0' }).database.ssl).toBe(false);
    expect(loadConfig({ ...base, DATABASE_SSL: 'true' }).database.ssl).toBe(true);
    expect(loadConfig({ ...base, DATABASE_SSL: '1' }).database.ssl).toBe(true);
  });

  it('rejects a boolean it does not recognise instead of guessing', () => {
    expect(() => loadConfig({ ...base, DATABASE_SSL: 'yes' })).toThrow(ConfigError);
  });

  it('treats an empty value as not set', () => {
    expect(loadConfig({ ...base, PORT: '', EMBEDDINGS_API_KEY: '' }).port).toBe(3000);
  });

  it('names every invalid variable in one error', () => {
    expect(() => loadConfig({ PORT: 'abc', EMBEDDINGS_PROVIDER: 'hash' })).toThrow(
      /DATABASE_URL[\s\S]*PORT|PORT[\s\S]*DATABASE_URL/,
    );
  });

  it('requires an API key for the openai provider', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgres://localhost/test', EMBEDDINGS_PROVIDER: 'openai' }),
    ).toThrow(/EMBEDDINGS_API_KEY/);
  });

  it('refuses the development embedder in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/EMBEDDINGS_PROVIDER/);
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    expect(() =>
      loadConfig({ ...base, CHUNK_MAX_CHARS: '200', CHUNK_OVERLAP_CHARS: '200' }),
    ).toThrow(/CHUNK_OVERLAP_CHARS/);
  });

  it('allows no browser origins by default', () => {
    expect(loadConfig(base).http).toEqual({
      allowedOrigins: [],
      rateLimit: { max: 20, windowSeconds: 60 },
      trustProxy: false,
    });
  });

  it('parses a comma-separated origin allowlist', () => {
    const config = loadConfig({
      ...base,
      ALLOWED_ORIGINS: 'https://www.example.com/, https://shop.example.com',
    });
    expect(config.http.allowedOrigins).toEqual([
      'https://www.example.com',
      'https://shop.example.com',
    ]);
  });

  it('rejects an origin that is not a URL', () => {
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: 'example.com' })).toThrow(
      /ALLOWED_ORIGINS/,
    );
  });

  it('leaves chat unconfigured when no LLM provider is set', () => {
    expect(loadConfig({ ...base, LLM_PROVIDER: '' }).llm).toBeUndefined();
  });

  it('requires a key and a model once an LLM provider is set', () => {
    expect(() => loadConfig({ ...base, LLM_PROVIDER: 'anthropic' })).toThrow(
      /LLM_API_KEY[\s\S]*LLM_MODEL/,
    );
  });

  it('fills in the provider base URL and has no default model', () => {
    const config = loadConfig({
      ...base,
      LLM_PROVIDER: 'anthropic',
      LLM_API_KEY: 'test-key-not-real',
      LLM_MODEL: 'some-model',
    });
    expect(config.llm).toEqual({
      provider: 'anthropic',
      apiKey: 'test-key-not-real',
      model: 'some-model',
      baseUrl: 'https://api.anthropic.com/v1',
      maxTokens: 800,
    });
  });

  it('rejects fewer candidates than results', () => {
    expect(() => loadConfig({ ...base, RAG_TOP_K: '10', RAG_CANDIDATES: '5' })).toThrow(
      /RAG_CANDIDATES/,
    );
  });

  it('strips a trailing slash from the embeddings base URL', () => {
    const config = loadConfig({ ...base, EMBEDDINGS_BASE_URL: 'https://example.com/v1/' });
    expect(config.embeddings.baseUrl).toBe('https://example.com/v1');
  });
});
