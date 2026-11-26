import { createSseDecoder } from '../../src/llm/sse.js';
import type { Citation, ConversationEvent, EscalationReason } from './conversation.js';

/** Sends one message and yields what comes back. Never throws: failures are events. */
export type Transport = (
  message: string,
  conversationId: string | null,
  signal: AbortSignal,
) => AsyncGenerator<ConversationEvent>;

const REASONS: readonly EscalationReason[] = [
  'action_request',
  'human_request',
  'no_relevant_sources',
  'ungrounded_answer',
];

const FAILURES: Record<string, string> = {
  RATE_LIMITED: 'That was a lot of questions in a short time. Give it a minute and try again.',
  CHAT_NOT_CONFIGURED: 'The assistant isn’t switched on yet.',
  CONVERSATION_NOT_FOUND: 'That conversation has expired. Ask again to start a new one.',
};
const GENERIC_FAILURE = 'Something went wrong on our side. Please try again.';
const OFFLINE = 'I can’t reach the assistant right now. Check your connection and try again.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): Citation[] => {
    if (
      !isRecord(item) ||
      typeof item['marker'] !== 'number' ||
      typeof item['title'] !== 'string'
    ) {
      return [];
    }
    const url = typeof item['url'] === 'string' ? item['url'] : null;
    return [{ marker: item['marker'], title: item['title'], url }];
  });
}

/** Turns one server-sent event into a conversation event, or null to skip it. */
export function decodeEvent(event: string, data: string): ConversationEvent | null {
  const body = parseJson(data);
  if (!isRecord(body)) return null;
  if (event === 'meta' && typeof body['conversationId'] === 'string') {
    return { type: 'meta', conversationId: body['conversationId'] };
  }
  if (event === 'delta' && typeof body['text'] === 'string') {
    return { type: 'delta', text: body['text'] };
  }
  if (event === 'done') {
    const reason = REASONS.find((known) => known === body['reason']) ?? null;
    return { type: 'done', citations: toCitations(body['citations']), reason };
  }
  if (event === 'error') return { type: 'failed', message: GENERIC_FAILURE };
  return null;
}

async function failureFrom(response: Response): Promise<ConversationEvent> {
  const body: unknown = await response.json().catch(() => null);
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : {};
  const code = typeof error['code'] === 'string' ? error['code'] : '';
  return {
    type: 'failed',
    message: FAILURES[code] ?? GENERIC_FAILURE,
    forgetConversation: code === 'CONVERSATION_NOT_FOUND',
  };
}

/** Talks to a Neon Desk server's POST /v1/chat. */
export function createHttpTransport(endpoint: string): Transport {
  const url = endpoint.replace(/\/+$/, '') + '/v1/chat';
  return async function* (message, conversationId, signal) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conversationId === null ? { message } : { message, conversationId }),
        signal,
      });
    } catch {
      if (!signal.aborted) yield { type: 'failed', message: OFFLINE };
      return;
    }
    if (!response.ok || response.body === null) {
      yield await failureFrom(response);
      return;
    }

    const decoder = createSseDecoder();
    const text = new TextDecoder();
    const reader = response.body.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        const events = done
          ? [...decoder.push(text.decode()), ...decoder.end()]
          : decoder.push(text.decode(value, { stream: true }));
        for (const raw of events) {
          const event = decodeEvent(raw.event, raw.data);
          if (event === null) continue;
          if (event.type === 'done' || event.type === 'failed') finished = true;
          yield event;
        }
        if (done) break;
      }
    } catch {
      if (signal.aborted) return;
    }
    // The connection closed before the server said it was finished.
    if (!finished && !signal.aborted) yield { type: 'failed', message: OFFLINE };
  };
}
