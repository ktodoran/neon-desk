import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationNotFoundError,
  startChat,
  type ChatDependencies,
  type ChatEvent,
} from '../src/chat/chat.js';
import { handoffMessage } from '../src/chat/prompt.js';
import { REDACTED_CARD } from '../src/chat/redact.js';
import { ROUTING_SYSTEM_PROMPT } from '../src/chat/route.js';
import type { Database } from '../src/db/types.js';
import type { LlmClient } from '../src/llm/types.js';
import { createHashEmbedder } from '../src/rag/embeddings.js';
import { ingestDocument } from '../src/rag/ingest.js';
import { createTestDatabase } from './helpers/database.js';
import { routed, scriptedLlm } from './helpers/llm.js';

const settings = { companyName: 'Acme Outfitters', supportContact: 'support@example.com' };
const embedder = createHashEmbedder();

async function run(events: AsyncGenerator<ChatEvent>) {
  let text = '';
  let done: Extract<ChatEvent, { type: 'done' }> | undefined;
  for await (const event of events) {
    if (event.type === 'delta') text += event.text;
    else done = event;
  }
  return { text, done };
}

describe('startChat', () => {
  let db: Database;

  function deps(llm: LlmClient): ChatDependencies {
    return {
      db,
      embedder,
      llm,
      settings,
      search: { topK: 3, candidates: 10, minScore: 0.3 },
      maxTokens: 300,
    };
  }

  async function storedMessages(conversationId: string) {
    const { rows } = await db.query<{ role: string; content: string; position: number }>(
      'SELECT role, content, position FROM messages WHERE conversation_id = $1 ORDER BY position',
      [conversationId],
    );
    return rows;
  }

  beforeEach(async () => {
    db = await createTestDatabase();
    const chunking = { maxChars: 500, overlapChars: 50 };
    await ingestDocument(
      { db, embedder, chunking },
      {
        source: 'files',
        externalId: 'returns.md',
        title: 'Returns',
        url: 'https://example.com/returns',
        content: 'Our return policy accepts returns within thirty days of delivery.',
      },
    );
    await ingestDocument(
      { db, embedder, chunking },
      {
        source: 'files',
        externalId: 'shipping.md',
        title: 'Shipping',
        content: 'International shipping takes ten to fourteen business days.',
      },
    );
  });
  afterEach(async () => {
    await db.close();
  });

  it('answers from retrieved sources, cites them and stores the exchange', async () => {
    const llm = scriptedLlm(
      routed('question', 'return policy'),
      'Returns are accepted within thirty days of delivery [1].',
    );
    const session = await startChat(deps(llm), { message: 'What is your return policy?' });
    const { text, done } = await run(session.events());

    expect(text).toBe('Returns are accepted within thirty days of delivery [1].');
    expect(done).toMatchObject({
      escalated: false,
      reason: null,
      citations: [{ marker: 1, title: 'Returns', url: 'https://example.com/returns' }],
    });

    // Two model calls: one to route, one to answer.
    expect(llm.requests.map((request) => request.system === ROUTING_SYSTEM_PROMPT)).toEqual([
      true,
      false,
    ]);
    expect(llm.requests[1]?.system).toContain('Acme Outfitters');
    expect(llm.requests[1]?.system).toContain('<source id="1" title="Returns">');
    expect(llm.requests[1]?.messages).toEqual([
      { role: 'user', content: 'What is your return policy?' },
    ]);

    expect(await storedMessages(session.conversationId)).toEqual([
      { role: 'user', content: 'What is your return policy?', position: 0 },
      { role: 'assistant', content: text, position: 1 },
    ]);
    const stored = await db.query<{ citations: unknown }>(
      "SELECT citations FROM messages WHERE role = 'assistant'",
    );
    expect(stored.rows[0]?.citations).toMatchObject([{ marker: 1, title: 'Returns' }]);
  });

  it('searches with the standalone query, and answers with the message as written', async () => {
    const first = scriptedLlm(routed('question', 'return policy'), 'Thirty days [1].');
    const opening = await startChat(deps(first), { message: 'What is your return policy?' });
    await run(opening.events());

    const llm = scriptedLlm(
      routed('question', 'international shipping time'),
      'It takes ten to fourteen business days [1].',
    );
    const session = await startChat(deps(llm), {
      conversationId: opening.conversationId,
      message: 'and how long for abroad?',
    });
    const { done } = await run(session.events());

    expect(session.searchQuery).toBe('international shipping time');
    expect(session.sources[0]?.title).toBe('Shipping');
    // The routing call saw the earlier turns.
    expect(llm.requests[0]?.messages[0]?.content).toContain('What is your return policy?');
    // The answering call sees history plus the customer's own words.
    expect(llm.requests[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(llm.requests[1]?.messages.at(-1)?.content).toBe('and how long for abroad?');
    expect(done?.citations[0]?.title).toBe('Shipping');
    expect(await storedMessages(session.conversationId)).toHaveLength(4);
  });

  it('hands off a request to act without searching or answering', async () => {
    const llm = scriptedLlm(routed('action_request', 'refund order 1182'));
    const session = await startChat(deps(llm), { message: 'Refund order 1182 right now' });
    const { text, done } = await run(session.events());

    expect(llm.requests).toHaveLength(1); // routing only
    expect(session.sources).toEqual([]);
    expect(text).toBe(handoffMessage('action_request', settings));
    expect(done).toEqual({
      type: 'done',
      citations: [],
      escalated: true,
      reason: 'action_request',
    });
  });

  it('still answers a question about a topic that also has actions', async () => {
    // "refund" appears in the message. A keyword filter would refuse this.
    const llm = scriptedLlm(
      routed('question', 'refund and return policy'),
      'Returns are accepted within thirty days [1].',
    );
    const session = await startChat(deps(llm), { message: 'What is your refund policy?' });
    const { done } = await run(session.events());
    expect(done).toMatchObject({ escalated: false, reason: null });
  });

  it('hands off a request for a person', async () => {
    const llm = scriptedLlm(routed('human_request', 'speak to a person'));
    const session = await startChat(deps(llm), { message: 'I want to talk to a human' });
    const { text, done } = await run(session.events());
    expect(text).toBe(handoffMessage('human_request', settings));
    expect(done).toMatchObject({ escalated: true, reason: 'human_request' });
  });

  it('does not ask the model to answer when nothing relevant is retrieved', async () => {
    const llm = scriptedLlm(routed('question', 'quantum chromodynamics'));
    const session = await startChat(deps(llm), { message: 'Explain quantum chromodynamics' });
    const { text, done } = await run(session.events());

    expect(llm.requests).toHaveLength(1); // routing only
    expect(text).toBe(handoffMessage('no_relevant_sources', settings));
    expect(done).toEqual({
      type: 'done',
      citations: [],
      escalated: true,
      reason: 'no_relevant_sources',
    });
    expect(await storedMessages(session.conversationId)).toHaveLength(2);
  });

  it('escalates an answer that cites nothing', async () => {
    const llm = scriptedLlm(
      routed('question', 'price match on returns'),
      "I don't have that information. Please contact support@example.com.",
    );
    const session = await startChat(deps(llm), { message: 'Do you price match on returns?' });
    const { done } = await run(session.events());
    expect(done).toMatchObject({ citations: [], escalated: true, reason: 'ungrounded_answer' });
  });

  it('treats the message as a question when routing fails', async () => {
    const llm = scriptedLlm(new Error('routing model down'), 'Thirty days [1].');
    const session = await startChat(deps(llm), { message: 'What is your return policy?' });
    expect(session.intent).toBe('question');
    expect(session.searchQuery).toBe('What is your return policy?');
    const { done } = await run(session.events());
    expect(done?.escalated).toBe(false);
  });

  it('removes a card number before the model or the database sees it', async () => {
    const llm = scriptedLlm(routed('action_request', 'charge card'));
    const session = await startChat(deps(llm), {
      message: 'Charge my card 4242 4242 4242 4242 for the return',
    });
    await run(session.events());

    const sentToModel = JSON.stringify(llm.requests);
    expect(sentToModel).not.toContain('4242');
    expect(sentToModel).toContain(REDACTED_CARD);
    const stored = await storedMessages(session.conversationId);
    expect(stored[0]?.content).toBe(`Charge my card ${REDACTED_CARD} for the return`);
  });

  it('ignores citation markers that do not match a source', async () => {
    const llm = scriptedLlm(
      routed('question', 'return policy'),
      'Thirty days [1], see also [7] and [0].',
    );
    const session = await startChat(deps(llm), { message: 'What is your return policy?' });
    const { done } = await run(session.events());
    expect(done?.citations.map((citation) => citation.marker)).toEqual([1]);
  });

  it('stores nothing when the model fails partway through an answer', async () => {
    const llm = scriptedLlm(routed('question', 'return policy'), new Error('stream cut off'));
    const session = await startChat(deps(llm), { message: 'What is your return policy?' });

    await expect(run(session.events())).rejects.toThrow('stream cut off');
    expect(await storedMessages(session.conversationId)).toEqual([]);
  });

  it('rejects an unknown conversation id', async () => {
    await expect(
      startChat(deps(scriptedLlm()), {
        conversationId: '00000000-0000-4000-8000-000000000000',
        message: 'hello',
      }),
    ).rejects.toThrow(ConversationNotFoundError);
  });
});
