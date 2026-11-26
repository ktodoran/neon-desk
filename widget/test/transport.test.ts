import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatDependencies } from '../../src/chat/chat.js';
import type { Database } from '../../src/db/types.js';
import type { LlmClient } from '../../src/llm/types.js';
import { createHashEmbedder } from '../../src/rag/embeddings.js';
import { ingestDocument } from '../../src/rag/ingest.js';
import { buildServer } from '../../src/server.js';
import { createTestDatabase } from '../../test/helpers/database.js';
import { routed, scriptedLlm } from '../../test/helpers/llm.js';
import type { ConversationEvent } from '../src/conversation.js';
import { createHttpTransport, decodeEvent } from '../src/transport.js';

describe('decoding server-sent events', () => {
  it('reads each kind of event the API sends', () => {
    expect(decodeEvent('meta', '{"conversationId":"abc"}')).toEqual({
      type: 'meta',
      conversationId: 'abc',
    });
    expect(decodeEvent('delta', '{"text":"Hi"}')).toEqual({ type: 'delta', text: 'Hi' });
    expect(
      decodeEvent(
        'done',
        '{"citations":[{"marker":1,"title":"Returns","url":null,"documentId":"d1"}],"escalated":false,"reason":null}',
      ),
    ).toEqual({
      type: 'done',
      citations: [{ marker: 1, title: 'Returns', url: null }],
      reason: null,
    });
  });

  it('turns an in-stream error into a failure without repeating the server’s wording', () => {
    const event = decodeEvent('error', '{"code":"STREAM_FAILED","message":"internal detail"}');

    expect(event).toMatchObject({ type: 'failed' });
    expect(JSON.stringify(event)).not.toContain('internal detail');
  });

  it('skips anything it does not understand instead of throwing', () => {
    expect(decodeEvent('delta', 'not json')).toBeNull();
    expect(decodeEvent('delta', '{"text":42}')).toBeNull();
    expect(decodeEvent('ping', '{}')).toBeNull();
    expect(decodeEvent('meta', '[]')).toBeNull();
  });

  it('drops malformed sources and an unknown reason', () => {
    expect(
      decodeEvent(
        'done',
        '{"citations":[{"marker":"1"},null,{"marker":2,"title":"B"}],"reason":"whim"}',
      ),
    ).toEqual({ type: 'done', citations: [{ marker: 2, title: 'B', url: null }], reason: null });
  });
});

/** The widget's transport against the real server, over a real socket. */
describe('talking to a Neon Desk server', () => {
  let db: Database;
  const embedder = createHashEmbedder();
  const servers: { close(): Promise<unknown> }[] = [];

  async function serve(llm?: LlmClient): Promise<string> {
    const chat: ChatDependencies | undefined =
      llm === undefined
        ? undefined
        : {
            db,
            embedder,
            llm,
            settings: { companyName: 'Acme Outfitters', supportContact: 'support@example.com' },
            search: { topK: 3, candidates: 10, minScore: 0.3 },
            maxTokens: 300,
          };
    const server = await buildServer({ db, logLevel: false, chat });
    await server.listen({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    return `http://127.0.0.1:${String((server.server.address() as AddressInfo).port)}`;
  }

  async function collect(
    endpoint: string,
    message: string,
    conversationId: string | null = null,
  ): Promise<ConversationEvent[]> {
    const events: ConversationEvent[] = [];
    const transport = createHttpTransport(endpoint);
    for await (const event of transport(message, conversationId, new AbortController().signal)) {
      events.push(event);
    }
    return events;
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
    await Promise.all(servers.map((server) => server.close()));
    await db.close();
  });

  it('receives an answer as it streams, then its sources', async () => {
    const endpoint = await serve(
      scriptedLlm(routed('question', 'return policy'), 'Within thirty days of delivery [1].'),
    );

    const events = await collect(endpoint, 'What is your return policy?');

    expect(events[0]).toMatchObject({ type: 'meta' });
    const text = events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('');
    expect(text).toBe('Within thirty days of delivery [1].');
    expect(events.filter((event) => event.type === 'delta').length).toBeGreaterThan(1);
    expect(events.at(-1)).toEqual({
      type: 'done',
      citations: [{ marker: 1, title: 'Returns', url: null }],
      reason: null,
    });
  });

  it('is told when a person is needed, and why', async () => {
    const endpoint = await serve(scriptedLlm(routed('human_request', 'talk to a person')));

    const events = await collect(endpoint, 'Let me talk to someone');

    expect(events.at(-1)).toEqual({ type: 'done', citations: [], reason: 'human_request' });
  });

  it('accepts a trailing slash on the endpoint', async () => {
    const endpoint = await serve(scriptedLlm(routed('human_request', 'talk to a person')));

    const events = await collect(`${endpoint}/`, 'Let me talk to someone');

    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('reports a failed answer once, in plain words', async () => {
    const endpoint = await serve(
      scriptedLlm(routed('question', 'return policy'), new Error('model exploded')),
    );

    const events = await collect(endpoint, 'What is your return policy?');

    const failures = events.filter((event) => event.type === 'failed');
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).not.toContain('exploded');
  });

  it('explains that the assistant is not switched on when no model is configured', async () => {
    const endpoint = await serve();

    expect(await collect(endpoint, 'Hello')).toEqual([
      {
        type: 'failed',
        message: 'The assistant isn’t switched on yet.',
        forgetConversation: false,
      },
    ]);
  });

  it('asks for a fresh conversation when the server no longer has this one', async () => {
    const endpoint = await serve(scriptedLlm());

    const events = await collect(endpoint, 'Hello', '00000000-0000-4000-8000-000000000000');

    expect(events).toMatchObject([{ type: 'failed', forgetConversation: true }]);
  });

  it('says it cannot reach the assistant when nothing is listening', async () => {
    const events = await collect('http://127.0.0.1:9', 'Hello');

    expect(events).toMatchObject([{ type: 'failed' }]);
    expect(JSON.stringify(events)).toContain('can’t reach');
  });

  it('stops quietly when the customer leaves', async () => {
    const endpoint = await serve(
      scriptedLlm(routed('question', 'return policy'), 'Within thirty days of delivery [1].'),
    );
    const abort = new AbortController();
    const events: ConversationEvent[] = [];

    for await (const event of createHttpTransport(endpoint)('Returns?', null, abort.signal)) {
      events.push(event);
      abort.abort();
    }

    expect(events.some((event) => event.type === 'failed')).toBe(false);
  });
});
