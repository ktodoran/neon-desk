import type { Database } from '../db/types.js';
import { collect, type LlmClient, type LlmMessage } from '../llm/types.js';
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
  buildRewriteMessages,
  buildSystemPrompt,
  citedMarkers,
  noAnswerMessage,
  REWRITE_SYSTEM_PROMPT,
  type AssistantSettings,
} from './prompt.js';

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

export type ChatEvent =
  | { readonly type: 'delta'; readonly text: string }
  | {
      readonly type: 'done';
      readonly citations: readonly Citation[];
      /** True when the customer should be routed to a person. */
      readonly escalated: boolean;
    };

export interface ChatSession {
  readonly conversationId: string;
  /** The query used for retrieval, after any rewriting. */
  readonly searchQuery: string;
  readonly events: () => AsyncGenerator<ChatEvent>;
}

export class ConversationNotFoundError extends Error {
  override readonly name = 'ConversationNotFoundError';
}

/** Turns of history given to the model. Older turns are dropped, not summarized. */
const HISTORY_LIMIT = 10;
const REWRITE_MAX_TOKENS = 128;

/**
 * A follow-up like "what about international?" retrieves nothing useful on
 * its own. With history present, ask the model for a standalone query first.
 * If that fails, search with the message as written: a weaker search beats
 * failing the whole request.
 */
async function standaloneQuery(
  llm: LlmClient,
  history: readonly LlmMessage[],
  message: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (history.length === 0) return message;
  try {
    const rewritten = await collect(
      llm.stream({
        system: REWRITE_SYSTEM_PROMPT,
        messages: buildRewriteMessages(history, message),
        maxTokens: REWRITE_MAX_TOKENS,
        ...(signal === undefined ? {} : { signal }),
      }),
    );
    const query = rewritten.trim();
    return query === '' ? message : query;
  } catch {
    return message;
  }
}

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
 * conversation, rewriting the query and retrieving sources. The returned
 * session then streams the answer. Splitting it this way lets an HTTP handler
 * reject a bad request with a normal status code instead of mid-stream.
 */
export async function startChat(
  deps: ChatDependencies,
  input: ChatInput,
  signal?: AbortSignal,
): Promise<ChatSession> {
  const { db, llm, settings } = deps;

  let conversationId = input.conversationId;
  if (conversationId === undefined) {
    conversationId = await createConversation(db);
  } else if (!(await conversationExists(db, conversationId))) {
    throw new ConversationNotFoundError(`Conversation ${conversationId} does not exist`);
  }
  const id = conversationId;

  const history = await recentMessages(db, id, HISTORY_LIMIT);
  const searchQuery = await standaloneQuery(llm, history, input.message, signal);
  const sources = await hybridSearch(deps, searchQuery, deps.search);

  async function* events(): AsyncGenerator<ChatEvent> {
    let answer = '';

    if (sources.length === 0) {
      // Nothing relevant was retrieved. Do not ask a model to answer from nothing.
      answer = noAnswerMessage(settings);
      yield { type: 'delta', text: answer };
    } else {
      const stream = llm.stream({
        system: buildSystemPrompt(settings, sources),
        messages: [...history, { role: 'user', content: input.message }],
        maxTokens: deps.maxTokens,
        ...(signal === undefined ? {} : { signal }),
      });
      for await (const text of stream) {
        answer += text;
        yield { type: 'delta', text };
      }
    }

    const citations = toCitations(citedMarkers(answer, sources.length), sources);

    // Persist only a completed exchange. If the model fails mid-answer, the
    // error propagates and the conversation is left exactly as it was.
    await db.transaction((tx) => appendExchange(tx, id, input.message, answer, citations));

    // An answer that cites nothing is not grounded in the knowledge base.
    yield { type: 'done', citations, escalated: citations.length === 0 };
  }

  return { conversationId: id, searchQuery, events };
}
