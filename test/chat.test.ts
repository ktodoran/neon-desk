import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationNotFoundError,
  startChat,
  type ChatDependencies,
  type ChatEvent,
} from '../src/chat/chat.js';
import { noAnswerMessage, REWRITE_SYSTEM_PROMPT } from '../src/chat/prompt.js';
import type { Database } from '../src/db/types.js';
import type { LlmClient } from '../src/llm/types.js';
import { createHashEmbedder } from '../src/rag/embeddings.js';
import { ingestDocument } from '../src/rag/ingest.js';
import { createTestDatabase } from './helpers/database.js';
import { scriptedLlm } from './helpers/llm.js';

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
    const llm = scriptedLlm('Returns are accepted within thirty days of delivery [1].');
    const session = await startChat(deps(llm), { message: 'What is your return policy?' });
    const { text, done } = await run(session.events());

    expect(text).toBe('Returns are accepted within thirty days of delivery [1].');
    expect(done).toMatchObject({
      escalated: false,
      citations: [{ marker: 1, title: 'Returns', url: 'https://example.com/returns' }],
    });

    // First turn: one model call, and it is the answer, not a rewrite.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.system).toContain('Acme Outfitters');
    expect(llm.requests[0]?.system).toContain('<source id="1" title="Returns">');
    expect(llm.requests[0]?.messages).toEqual([
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

  it('rewrites a follow-up into a standalone query before searching', async () => {
    const first = scriptedLlm('Returns are accepted within thirty days [1].');
    const opening = await startChat(deps(first), { message: 'What is your return policy?' });
    await run(opening.events());

    const llm = scriptedLlm(
      'international shipping time',
      'It takes ten to fourteen business days [1].',
    );
    const session = await startChat(deps(llm), {
      conversationId: opening.conversationId,
      message: 'and how long for abroad?',
    });
    const { done } = await run(session.events());

    expect(session.searchQuery).toBe('international shipping time');
    expect(llm.requests[0]?.system).toBe(REWRITE_SYSTEM_PROMPT);
    expect(llm.requests[0]?.messages[0]?.content).toContain('What is your return policy?');
    expect(llm.requests[0]?.messages[0]?.content).toContain('and how long for abroad?');

    // The answering call sees the earlier turns and the message as the customer wrote it.
    expect(llm.requests[1]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(llm.requests[1]?.messages.at(-1)?.content).toBe('and how long for abroad?');
    expect(done?.citations[0]?.title).toBe('Shipping');
    expect(await storedMessages(session.conversationId)).toHaveLength(4);
  });

  it('searches with the original message when the rewrite fails', async () => {
    const first = scriptedLlm('Thirty days [1].');
    const opening = await startChat(deps(first), { message: 'What is your return policy?' });
    await run(opening.events());

    const llm = scriptedLlm(new Error('rewrite model down'), 'Ten to fourteen days [1].');
    const session = await startChat(deps(llm), {
      conversationId: opening.conversationId,
      message: 'international shipping?',
    });
    expect(session.searchQuery).toBe('international shipping?');
  });

  it('does not call the model when nothing relevant is retrieved', async () => {
    const llm = scriptedLlm();
    const session = await startChat(deps(llm), { message: 'Explain quantum chromodynamics' });
    const { text, done } = await run(session.events());

    expect(llm.requests).toHaveLength(0);
    expect(text).toBe(noAnswerMessage(settings));
    expect(done).toEqual({ type: 'done', citations: [], escalated: true });
    expect(await storedMessages(session.conversationId)).toHaveLength(2);
  });

  it('escalates an answer that cites nothing', async () => {
    const llm = scriptedLlm("I don't have that information. Please contact support@example.com.");
    const session = await startChat(deps(llm), { message: 'Do you price match on returns?' });
    const { done } = await run(session.events());
    expect(done).toMatchObject({ citations: [], escalated: true });
  });

  it('ignores citation markers that do not match a source', async () => {
    const llm = scriptedLlm('Thirty days [1], see also [7] and [0].');
    const session = await startChat(deps(llm), { message: 'What is your return policy?' });
    const { done } = await run(session.events());
    expect(done?.citations.map((citation) => citation.marker)).toEqual([1]);
  });

  it('stores nothing when the model fails partway through an answer', async () => {
    const llm = scriptedLlm(new Error('stream cut off'));
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
