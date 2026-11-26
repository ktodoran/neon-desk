import type { ConversationEvent } from './conversation.js';
import type { Transport } from './transport.js';

/**
 * A stand-in for the server, for trying the widget without one.
 *
 * It follows the same rules the real assistant does (answer from the help
 * pages and cite them, refuse to act, hand off when asked or when nothing
 * matches) with a few scripted replies drawn from the example knowledge base
 * in this repository. It is never used unless the page asks for it.
 */
interface Scripted {
  readonly match: RegExp;
  readonly events: readonly ConversationEvent[];
}

const answer = (text: string, title: string): ConversationEvent[] => [
  { type: 'delta', text },
  { type: 'done', citations: [{ marker: 1, title, url: null }], reason: null },
];

const SCRIPT: readonly Scripted[] = [
  {
    match: /person|human|agent|someone|representative/i,
    events: [
      {
        type: 'delta',
        text: 'Of course. Please contact support@example.com to reach a person.',
      },
      { type: 'done', citations: [], reason: 'human_request' },
    ],
  },
  {
    match: /cancel|refund my|change my|update my|delete my/i,
    events: [
      {
        type: 'delta',
        text: 'I can’t make changes to orders or accounts from this chat. Please contact support@example.com and they’ll take care of it.',
      },
      { type: 'done', citations: [], reason: 'action_request' },
    ],
  },
  {
    match: /return|send (it )?back|exchange/i,
    events: answer(
      'You can return any item within 30 days, as long as it’s in its original condition with the tags attached [1].',
      'FAQ: What is your return policy?',
    ),
  },
  {
    match: /ship|deliver|arrive|how long/i,
    events: answer(
      'Standard shipping takes 5–7 business days. It’s free on orders over $50 and $5.99 otherwise. Express shipping, 2–3 business days, is available at checkout [1].',
      'Shipping & Returns: Domestic shipping',
    ),
  },
];

const NOTHING_FOUND: readonly ConversationEvent[] = [
  {
    type: 'delta',
    text: 'I don’t have information about that. Please contact support@example.com and they’ll be able to help.',
  },
  { type: 'done', citations: [], reason: 'no_relevant_sources' },
];

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

export function createDemoTransport(pace = 1): Transport {
  return async function* (message, _conversationId, signal) {
    // Asked each time: the customer can close the chat while this is waiting.
    const stopped = (): boolean => signal.aborted;
    yield { type: 'meta', conversationId: '00000000-0000-4000-8000-000000000000' };
    await wait(1500 * pace, signal);
    const events = SCRIPT.find((entry) => entry.match.test(message))?.events ?? NOTHING_FOUND;
    for (const event of events) {
      if (stopped()) return;
      if (event.type !== 'delta') {
        yield event;
        continue;
      }
      // Arrive a few words at a time, as a model's answer does.
      for (const piece of event.text.match(/\S+\s*/g) ?? []) {
        await wait(55 * pace, signal);
        if (stopped()) return;
        yield { type: 'delta', text: piece };
      }
    }
  };
}
