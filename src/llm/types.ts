export interface LlmMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

/**
 * The one capability the application needs from a model: text out, as it is
 * generated. A non-streaming call is just a stream collected to the end.
 */
export interface LlmClient {
  readonly stream: (request: LlmRequest) => AsyncIterable<string>;
}

export class LlmError extends Error {
  override readonly name = 'LlmError';
}

export async function collect(stream: AsyncIterable<string>): Promise<string> {
  let text = '';
  for await (const piece of stream) text += piece;
  return text;
}
