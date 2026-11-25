import type { LlmClient, LlmRequest } from '../../src/llm/types.js';

export interface ScriptedLlm extends LlmClient {
  /** Every request received, in order. */
  readonly requests: LlmRequest[];
}

/**
 * A model that returns canned replies, one per call, a few characters at a
 * time. An Error in the script makes that call fail partway through.
 */
export function scriptedLlm(...script: (string | Error)[]): ScriptedLlm {
  const requests: LlmRequest[] = [];
  let call = 0;
  return {
    requests,
    async *stream(request: LlmRequest): AsyncGenerator<string> {
      requests.push(request);
      const reply = script[call];
      call += 1;
      if (reply === undefined) throw new Error('scriptedLlm: no reply left in the script');
      await Promise.resolve();
      if (reply instanceof Error) {
        yield 'partial ';
        throw reply;
      }
      for (let i = 0; i < reply.length; i += 7) yield reply.slice(i, i + 7);
    },
  };
}

/** A byte stream that delivers the given strings as separate network chunks. */
export function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** The reply a routing call would give. */
export function routed(
  intent: 'question' | 'action_request' | 'human_request',
  query: string,
): string {
  return JSON.stringify({ intent, query });
}
