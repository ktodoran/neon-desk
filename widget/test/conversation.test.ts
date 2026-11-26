import { describe, expect, it } from 'vitest';
import { EMPTY, reduce, type Conversation, type ConversationEvent } from '../src/conversation.js';

const play = (...events: ConversationEvent[]): Conversation => events.reduce(reduce, EMPTY);

describe('conversation', () => {
  it('adds the question and an empty answer that is waiting', () => {
    const conversation = play({ type: 'sent', text: 'Where is my order?' });

    expect(conversation.status).toBe('waiting');
    expect(conversation.messages).toMatchObject([
      { id: 0, role: 'customer', text: 'Where is my order?', pending: false },
      { id: 1, role: 'assistant', text: '', pending: true },
    ]);
  });

  it('builds the answer from its pieces and finishes with its sources', () => {
    const conversation = play(
      { type: 'sent', text: 'Returns?' },
      { type: 'meta', conversationId: 'abc' },
      { type: 'delta', text: 'Within 30 ' },
      { type: 'delta', text: 'days [1].' },
      { type: 'done', citations: [{ marker: 1, title: 'Returns', url: null }], reason: null },
    );

    expect(conversation).toMatchObject({ id: 'abc', status: 'idle' });
    expect(conversation.messages[1]).toMatchObject({
      text: 'Within 30 days [1].',
      pending: false,
      citations: [{ marker: 1, title: 'Returns' }],
      escalation: null,
    });
  });

  it('is streaming from the first piece until the answer is done', () => {
    const waiting = play({ type: 'sent', text: 'Hi' });
    const streaming = reduce(waiting, { type: 'delta', text: 'Hel' });

    expect(waiting.status).toBe('waiting');
    expect(streaming.status).toBe('streaming');
  });

  it('records why a person is needed', () => {
    const conversation = play(
      { type: 'sent', text: 'Cancel my order' },
      { type: 'delta', text: 'I can’t do that here.' },
      { type: 'done', citations: [], reason: 'action_request' },
    );

    expect(conversation.messages[1]?.escalation).toBe('action_request');
  });

  it('keeps what had arrived when an answer fails partway', () => {
    const conversation = play(
      { type: 'sent', text: 'Returns?' },
      { type: 'meta', conversationId: 'abc' },
      { type: 'delta', text: 'Within' },
      { type: 'failed', message: 'Something went wrong.' },
    );

    expect(conversation).toMatchObject({ id: 'abc', status: 'idle' });
    expect(conversation.messages[1]).toMatchObject({
      text: 'Within',
      pending: false,
      failure: 'Something went wrong.',
    });
  });

  it('forgets a conversation the server no longer has, so the next message starts a new one', () => {
    const conversation = play(
      { type: 'sent', text: 'Hi' },
      { type: 'meta', conversationId: 'abc' },
      { type: 'done', citations: [], reason: null },
      { type: 'sent', text: 'Still there?' },
      { type: 'failed', message: 'Expired.', forgetConversation: true },
    );

    expect(conversation.id).toBeNull();
  });

  it('ignores a piece that arrives with no answer waiting for it', () => {
    expect(reduce(EMPTY, { type: 'delta', text: 'stray' })).toBe(EMPTY);
  });

  it('numbers messages in order across several exchanges', () => {
    const conversation = play(
      { type: 'sent', text: 'One' },
      { type: 'done', citations: [], reason: null },
      { type: 'sent', text: 'Two' },
    );

    expect(conversation.messages.map((message) => message.id)).toEqual([0, 1, 2, 3]);
  });
});
