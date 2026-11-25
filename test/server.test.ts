import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatDependencies } from '../src/chat/chat.js';
import type { Database } from '../src/db/types.js';
import type { LlmClient } from '../src/llm/types.js';
import { createHashEmbedder } from '../src/rag/embeddings.js';
import { ingestDocument } from '../src/rag/ingest.js';
import { buildServer } from '../src/server.js';
import { createTestDatabase } from './helpers/database.js';
import { routed, scriptedLlm } from './helpers/llm.js';

function fakeDatabase(query: Database['query']): Database {
  return {
    query,
    exec: () => Promise.resolve(),
    transaction: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
  };
}

describe('server', () => {
  it('reports healthy when the database answers', async () => {
    const server = await buildServer({
      db: fakeDatabase(() => Promise.resolve({ rows: [] })),
      logLevel: false,
    });
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports unavailable when the database does not', async () => {
    const server = await buildServer({
      db: fakeDatabase(() => Promise.reject(new Error('connection refused'))),
      logLevel: false,
    });
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.body).not.toContain('connection refused');
  });

  it('answers unknown routes with a stable error shape', async () => {
    const server = await buildServer({
      db: fakeDatabase(() => Promise.resolve({ rows: [] })),
      logLevel: false,
    });
    const response = await server.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
});

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

function frames(body: string): Frame[] {
  return body
    .split('\n\n')
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const [eventLine = '', dataLine = ''] = block.split('\n');
      return {
        event: eventLine.replace('event: ', ''),
        data: JSON.parse(dataLine.replace('data: ', '')) as Record<string, unknown>,
      };
    });
}

describe('POST /v1/chat', () => {
  let db: Database;
  const embedder = createHashEmbedder();

  function chat(llm: LlmClient): ChatDependencies {
    return {
      db,
      embedder,
      llm,
      settings: { companyName: 'Acme Outfitters', supportContact: 'support@example.com' },
      search: { topK: 3, candidates: 10, minScore: 0.3 },
      maxTokens: 300,
    };
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await ingestDocument(
      { db, embedder, chunking: { maxChars: 500, overlapChars: 50 } },
      {
        source: 'files',
        externalId: 'returns.md',
        title: 'Returns',
        content: 'Our return policy accepts returns within thirty days of delivery.',
      },
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it('streams meta, deltas and done as server-sent events', async () => {
    const server = await buildServer({
      db,
      logLevel: false,
      chat: chat(
        scriptedLlm(routed('question', 'return policy'), 'Within thirty days of delivery [1].'),
      ),
    });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: 'What is your return policy?' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');

    const events = frames(response.body);
    expect(events[0]?.event).toBe('meta');
    expect(events[0]?.data.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    const text = events
      .filter((frame) => frame.event === 'delta')
      .map((frame) => frame.data.text)
      .join('');
    expect(text).toBe('Within thirty days of delivery [1].');
    expect(events.at(-1)).toMatchObject({
      event: 'done',
      data: { escalated: false, reason: null, citations: [{ marker: 1, title: 'Returns' }] },
    });
  });

  it('reports a mid-stream failure in-band, without internal detail', async () => {
    const server = await buildServer({
      db,
      logLevel: false,
      chat: chat(
        scriptedLlm(routed('question', 'return policy'), new Error('upstream secret detail')),
      ),
    });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: 'What is your return policy?' },
    });

    const events = frames(response.body);
    expect(events.at(-1)?.event).toBe('error');
    expect(events.some((frame) => frame.event === 'done')).toBe(false);
    expect(response.body).not.toContain('upstream secret detail');
  });

  it('rejects an invalid body before streaming anything', async () => {
    const server = await buildServer({ db, logLevel: false, chat: chat(scriptedLlm()) });
    for (const payload of [{}, { message: '   ' }, { message: 'hi', conversationId: 'nope' }]) {
      const response = await server.inject({ method: 'POST', url: '/v1/chat', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    }
  });

  it('answers 404 for an unknown conversation', async () => {
    const server = await buildServer({ db, logLevel: false, chat: chat(scriptedLlm()) });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: 'hi', conversationId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'CONVERSATION_NOT_FOUND' } });
  });

  it('answers 400, not 500, for a body that is not valid JSON', async () => {
    const server = await buildServer({ db, logLevel: false, chat: chat(scriptedLlm()) });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat',
      headers: { 'content-type': 'application/json' },
      payload: '{"message": ',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'BAD_REQUEST', message: 'The request could not be understood' },
    });
  });

  it('answers 413 for an oversized body', async () => {
    const server = await buildServer({ db, logLevel: false, chat: chat(scriptedLlm()) });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: 'x'.repeat(20_000) },
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('rate limits the chat route per client, and only the chat route', async () => {
    const server = await buildServer({
      db,
      logLevel: false,
      chat: chat(
        scriptedLlm(
          routed('question', 'return policy'),
          'One [1].',
          routed('question', 'return policy'),
          'Two [1].',
        ),
      ),
      http: { allowedOrigins: [], rateLimit: { max: 2, windowSeconds: 60 }, trustProxy: false },
    });
    const ask = () =>
      server.inject({
        method: 'POST',
        url: '/v1/chat',
        payload: { message: 'What is your return policy?' },
      });

    expect((await ask()).statusCode).toBe(200);
    expect((await ask()).statusCode).toBe(200);
    const limited = await ask();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });

    // Health checks come from infrastructure and must never be throttled.
    expect((await server.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('answers a preflight only for an allowed origin', async () => {
    const server = await buildServer({
      db,
      logLevel: false,
      chat: chat(scriptedLlm()),
      http: {
        allowedOrigins: ['https://shop.example.com'],
        rateLimit: { max: 20, windowSeconds: 60 },
        trustProxy: false,
      },
    });
    const preflight = (origin: string) =>
      server.inject({
        method: 'OPTIONS',
        url: '/v1/chat',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });

    const allowed = await preflight('https://shop.example.com');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://shop.example.com');

    const other = await preflight('https://evil.example.net');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows no cross-origin callers by default', async () => {
    const server = await buildServer({ db, logLevel: false, chat: chat(scriptedLlm()) });
    const response = await server.inject({
      method: 'OPTIONS',
      url: '/v1/chat',
      headers: { origin: 'https://shop.example.com', 'access-control-request-method': 'POST' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers 503 when no model is configured', async () => {
    const server = await buildServer({ db, logLevel: false });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/chat',
      payload: { message: 'hi' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'CHAT_NOT_CONFIGURED' } });
  });

  it('cancels generation when the client disconnects', async () => {
    let aborted = false;
    const stalled: LlmClient = {
      async *stream(request) {
        if (request.system.startsWith('You route')) {
          yield routed('question', 'return policy');
          return;
        }
        yield 'Within thirty days [1]. ';
        // Then hang, as a slow model would, until the request is cancelled.
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      },
    };
    const server = await buildServer({ db, logLevel: false, chat: chat(stalled) });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });

    try {
      const controller = new AbortController();
      const response = await fetch(`${address}/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'What is your return policy?' }),
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      // Read until the first piece of the answer has arrived, then hang up.
      let received = '';
      while (!received.includes('event: delta')) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done) break;
        received += new TextDecoder().decode(chunk.value as Uint8Array);
      }
      controller.abort();

      await expect.poll(() => aborted, { timeout: 5000 }).toBe(true);
    } finally {
      // fetch keeps a pooled connection open, which would otherwise delay close().
      server.server.closeAllConnections();
      await server.close();
    }
  });
});
