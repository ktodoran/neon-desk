import type { Database } from '../db/types.js';
import type { LlmClient } from '../llm/types.js';
import type { Embedder } from '../rag/embeddings.js';
import { hybridSearch, type HybridSearchOptions, type RetrievedChunk } from '../rag/search.js';
import {
  appendExchange,
  conversationExists,
  createConversation,
  recentMessages,
  type Citation,
} from './conversations.js';
import {
  buildSystemPrompt,
  citedMarkers,
  handoffMessage,
  type AssistantSettings,
} from './prompt.js';
import { redactCardNumbers } from './redact.js';
import { routeMessage, type Intent } from './route.js';

export interface ChatDependencies {
  readonly db: Database;
  readonly embedder: Embedder;
  readonly llm: LlmClient;
  readonly settings: AssistantSettings;
  readonly search: HybridSearchOptions;
  readonly maxTokens: number;
}

export interface ChatInput {
  /** Omit to start a new conversation. */
  readonly conversationId?: string;
  readonly message: string;
}

/** Why a conversation should go to a person. */
export type EscalationReason =
  'action_request' | 'human_request' | 'no_relevant_sources' | 'ungrounded_answer';

export type ChatEvent =
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'done';
      readonly citations: readonly Citation[];
      /** True when the customer should be routed to a person. */
      readonly escalated: boolean;
      /** Set exactly when `escalated` is true. */
      readonly reason: EscalationReason | null;
    };

export interface ChatSession {
  readonly conversationId: string;
  readonly intent: Intent;
  /** The query used for retrieval, after any rewriting. */
  readonly searchQuery: string;
  /** What was retrieved, in the order the model saw it. Empty when nothing was searched. */
  readonly sources: readonly RetrievedChunk[];
  readonly events: () => AsyncGenerator<ChatEvent>;
}

export class ConversationNotFoundError extends Error {
  override readonly name = 'ConversationNotFoundError';
}

/** Turns of history given to the model. Older turns are dropped, not summarized. */
const HISTORY_LIMIT = 10;

function toCitations(markers: readonly number[], sources: readonly RetrievedChunk[]): Citation[] {
  return markers.flatMap((marker) => {
    const source = sources[marker - 1];
    return source === undefined
      ? []
      : [{ marker, title: source.title, url: source.url, documentId: source.documentId }];
  });
}

/**
 * Does everything that can fail before a response starts: resolving the
 * conversation, routing the message and retrieving sources. The returned
 * session then streams the answer. Splitting it this way lets an HTTP handler
 * reject a bad request with a normal status code instead of mid-stream.
 */
export async function startChat(
  deps: ChatDependencies,
  input: ChatInput,
  signal?: AbortSignal,
): Promise<ChatSession> {
  const { db, llm, settings } = deps;
  // Before anything else sees the message: the model, the database, the logs.
  const message = redactCardNumbers(input.message);

  let conversationId = input.conversationId;
  if (conversationId === undefined) {
    conversationId = await createConversation(db);
  } else if (!(await conversationExists(db, conversationId))) {
    throw new ConversationNotFoundError(`Conversation ${conversationId} does not exist`);
  }
  const id = conversationId;

  const history = await recentMessages(db, id, HISTORY_LIMIT);
  const routing = await routeMessage(llm, history, message, signal);
  // Requests to act, and requests for a person, are never searched or answered.
  const sources =
    routing.intent === 'question' ? await hybridSearch(deps, routing.query, deps.search) : [];

  async function* events(): AsyncGenerator<ChatEvent> {
    let answer = '';
    let reason: EscalationReason | null = null;

    if (routing.intent !== 'question') {
      reason = routing.intent;
      answer = handoffMessage(routing.intent, settings);
      yield { type: 'delta', text: answer };
    } else if (sources.length === 0) {
      // Nothing relevant was retrieved. Do not ask a model to answer from nothing.
      reason = 'no_relevant_sources';
      answer = handoffMessage('no_relevant_sources', settings);
      yield { type: 'delta', text: answer };
    } else {
      const stream = llm.stream({
        system: buildSystemPrompt(settings, sources),
        messages: [...history, { role: 'user', content: message }],
        maxTokens: deps.maxTokens,
        ...(signal === undefined ? {} : { signal }),
      });
      for await (const text of stream) {
        answer += text;
        yield { type: 'delta', text };
      }
    }

    const citations = toCitations(citedMarkers(answer, sources.length), sources);
    // An answer that cites nothing is not grounded in the knowledge base.
    if (reason === null && citations.length === 0) reason = 'ungrounded_answer';

    // Persist only a completed exchange. If the model fails mid-answer, the
    // error propagates and the conversation is left exactly as it was.
    await db.transaction((tx) => appendExchange(tx, id, message, answer, citations));

    yield { type: 'done', citations, escalated: reason !== null, reason };
  }

  return {
    conversationId: id,
    intent: routing.intent,
    searchQuery: routing.query,
    sources,
    events,
  };
}
