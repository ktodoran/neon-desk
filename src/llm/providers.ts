import { describeFailure } from '../provider-error.js';
import { parseServerSentEvents } from './sse.js';
import { LlmError, type LlmClient, type LlmRequest } from './types.js';

export interface ProviderOptions {
  readonly apiKey: string;
  /** Base URL without a trailing slash. */
  readonly baseUrl: string;
  readonly model: string;
  /**
   * How much the model should reason before it answers, where the server takes
   * `reasoning_effort`. "none" turns thinking off on models that think by default.
   */
  readonly reasoningEffort?: string | undefined;
  /** Injectable for tests. */
  readonly fetch?: typeof fetch;
}

async function post(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<ReadableStream<Uint8Array>> {
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (cause) {
    throw new LlmError('Model request failed before a response arrived', { cause });
  }
  if (!response.ok) {
    throw new LlmError(`Model request failed with ${await describeFailure(response)}`);
  }
  if (response.body === null) throw new LlmError('Model response had no body');
  return response.body;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new LlmError('Model stream contained malformed JSON');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Anthropic Messages API, streamed. */
export function createAnthropicClient(options: ProviderOptions): LlmClient {
  const doFetch = options.fetch ?? fetch;

  return {
    async *stream(request: LlmRequest): AsyncGenerator<string> {
      const body = await post(
        doFetch,
        `${options.baseUrl}/messages`,
        { 'x-api-key': options.apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: options.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: request.messages,
          stream: true,
        },
        request.signal,
      );

      for await (const { event, data } of parseServerSentEvents(body)) {
        if (event === 'error') throw new LlmError('Model stream reported an error');
        if (event !== 'content_block_delta') continue;
        const payload = parseJson(data);
        if (!isRecord(payload) || !isRecord(payload.delta)) continue;
        const { type, text } = payload.delta;
        if (type === 'text_delta' && typeof text === 'string') yield text;
      }
    },
  };
}

/** OpenAI Chat Completions API, streamed. Works with any compatible server. */
export function createOpenAIClient(options: ProviderOptions): LlmClient {
  const doFetch = options.fetch ?? fetch;
  // The answer's length cap has two names. OpenAI's current models take only the
  // newer one; other servers that speak this API (Ollama, llama.cpp, vLLM) take
  // only the older one and ignore a cap sent under the newer name.
  const capField =
    new URL(options.baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens';

  return {
    async *stream(request: LlmRequest): AsyncGenerator<string> {
      const body = await post(
        doFetch,
        `${options.baseUrl}/chat/completions`,
        { authorization: `Bearer ${options.apiKey}` },
        {
          model: options.model,
          [capField]: request.maxTokens,
          ...(options.reasoningEffort === undefined
            ? {}
            : { reasoning_effort: options.reasoningEffort }),
          messages: [{ role: 'system', content: request.system }, ...request.messages],
          stream: true,
        },
        request.signal,
      );

      for await (const { data } of parseServerSentEvents(body)) {
        if (data === '[DONE]') return;
        const payload = parseJson(data);
        if (!isRecord(payload) || !Array.isArray(payload.choices)) continue;
        const first: unknown = payload.choices[0];
        if (!isRecord(first) || !isRecord(first.delta)) continue;
        const { content } = first.delta;
        if (typeof content === 'string' && content !== '') yield content;
      }
    },
  };
}

export function createLlmClient(config: ProviderOptions & { provider: 'anthropic' | 'openai' }) {
  return config.provider === 'anthropic'
    ? createAnthropicClient(config)
    : createOpenAIClient(config);
}
