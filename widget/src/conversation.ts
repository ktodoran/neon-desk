/** A source the answer cited, as the API returns it. */
export interface Citation {
  readonly marker: number;
  readonly title: string;
  readonly url: string | null;
}

export type EscalationReason =
  'action_request' | 'human_request' | 'no_relevant_sources' | 'ungrounded_answer';

export interface Message {
  readonly id: number;
  readonly role: 'customer' | 'assistant';
  readonly text: string;
  /** True while the answer is still arriving. */
  readonly pending: boolean;
  readonly citations: readonly Citation[];
  /** Set when the customer should be routed to a person. */
  readonly escalation: EscalationReason | null;
  /** Set when the answer could not be produced or completed. */
  readonly failure: string | null;
}

export interface Conversation {
  readonly id: string | null;
  readonly messages: readonly Message[];
  /** waiting: sent, nothing back yet. streaming: the answer is arriving. */
  readonly status: 'idle' | 'waiting' | 'streaming';
}

/** Everything that can happen to a conversation. */
export type ConversationEvent =
  | { readonly type: 'sent'; readonly text: string }
  | { readonly type: 'meta'; readonly conversationId: string }
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'done';
      readonly citations: readonly Citation[];
      readonly reason: EscalationReason | null;
    }
  | { readonly type: 'failed'; readonly message: string; readonly forgetConversation?: boolean };

export const EMPTY: Conversation = { id: null, messages: [], status: 'idle' };

function replaceLast(conversation: Conversation, change: Partial<Message>): readonly Message[] {
  const last = conversation.messages.at(-1);
  if (last === undefined) return conversation.messages;
  return [...conversation.messages.slice(0, -1), { ...last, ...change }];
}

/**
 * The whole conversation is one value and this is the only thing that changes
 * it, so what is on screen can always be rebuilt from it.
 */
export function reduce(conversation: Conversation, event: ConversationEvent): Conversation {
  switch (event.type) {
    case 'sent': {
      const next = conversation.messages.length;
      const base = { pending: false, citations: [], escalation: null, failure: null } as const;
      return {
        ...conversation,
        status: 'waiting',
        messages: [
          ...conversation.messages,
          { ...base, id: next, role: 'customer', text: event.text },
          { ...base, id: next + 1, role: 'assistant', text: '', pending: true },
        ],
      };
    }
    case 'meta':
      return { ...conversation, id: event.conversationId };
    case 'delta': {
      const last = conversation.messages.at(-1);
      if (last?.pending !== true) return conversation;
      return {
        ...conversation,
        status: 'streaming',
        messages: replaceLast(conversation, { text: last.text + event.text }),
      };
    }
    case 'done':
      return {
        ...conversation,
        status: 'idle',
        messages: replaceLast(conversation, {
          pending: false,
          citations: event.citations,
          escalation: event.reason,
        }),
      };
    case 'failed':
      return {
        id: event.forgetConversation === true ? null : conversation.id,
        status: 'idle',
        messages: replaceLast(conversation, { pending: false, failure: event.message }),
      };
  }
}
