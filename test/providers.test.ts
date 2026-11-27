import { describe, expect, it, vi } from 'vitest';
import { createAnthropicClient, createOpenAIClient } from '../src/llm/providers.js';
import { collect, LlmError } from '../src/llm/types.js';
import { streamOf } from './helpers/llm.js';

const request = {
  system: 'Be brief.',
  messages: [{ role: 'user' as const, content: 'Hi' }],
  maxTokens: 50,
};

function fetchReturning(response: () => Response) {
  return vi.fn<typeof fetch>(() => Promise.resolve(response()));
}

function sentBody(mock: ReturnType<typeof fetchReturning>): Record<string, unknown> {
  const init = mock.mock.calls[0]?.[1];
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
}

function sentHeaders(mock: ReturnType<typeof fetchReturning>): Record<string, string> {
  return (mock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

describe('anthropic client', () => {
  // A recorded-shape Messages API stream: text arrives in content_block_delta events.
  const stream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const options = { apiKey: 'test-key-not-real', baseUrl: 'https://llm.test/v1', model: 'm' };

  it('yields text deltas and sends the documented request', async () => {
    const fetchMock = fetchReturning(() => new Response(streamOf(...stream)));
    const client = createAnthropicClient({ ...options, fetch: fetchMock });

    expect(await collect(client.stream(request))).toBe('Hello there');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://llm.test/v1/messages');
    expect(sentHeaders(fetchMock)).toMatchObject({
      'x-api-key': 'test-key-not-real',
      'anthropic-version': '2023-06-01',
    });
    expect(sentBody(fetchMock)).toEqual({
      model: 'm',
      max_tokens: 50,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    });
  });

  it('fails on an in-stream error event', async () => {
    const fetchMock = fetchReturning(
      () =>
        new Response(
          streamOf(
            stream[3] ?? '',
            'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n',
          ),
        ),
    );
    const client = createAnthropicClient({ ...options, fetch: fetchMock });
    await expect(collect(client.stream(request))).rejects.toThrow(LlmError);
  });

  it('reports an HTTP failure without the key or the response body', async () => {
    const fetchMock = fetchReturning(
      () => new Response('bad key test-key-not-real', { status: 401 }),
    );
    const client = createAnthropicClient({ ...options, fetch: fetchMock });
    const error = await collect(client.stream(request)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as Error).message).toContain('401');
    expect((error as Error).message).not.toContain('test-key-not-real');
  });
});

describe('openai client', () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":" there"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"total_tokens":9}}\n\n',
    'data: [DONE]\n\n',
  ];
  const options = { apiKey: 'test-key-not-real', baseUrl: 'https://llm.test/v1', model: 'm' };

  it('yields content deltas and puts the system prompt first', async () => {
    const fetchMock = fetchReturning(() => new Response(streamOf(...stream)));
    const client = createOpenAIClient({ ...options, fetch: fetchMock });

    expect(await collect(client.stream(request))).toBe('Hello there');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://llm.test/v1/chat/completions');
    expect(sentHeaders(fetchMock)).toMatchObject({ authorization: 'Bearer test-key-not-real' });
    expect(sentBody(fetchMock)).toMatchObject({
      model: 'm',
      stream: true,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
      ],
    });
  });

  it('names the length cap the way the server it is talking to expects', async () => {
    const openai = fetchReturning(() => new Response(streamOf(...stream)));
    const local = fetchReturning(() => new Response(streamOf(...stream)));

    await collect(
      createOpenAIClient({
        ...options,
        baseUrl: 'https://api.openai.com/v1',
        fetch: openai,
      }).stream(request),
    );
    await collect(
      createOpenAIClient({
        ...options,
        baseUrl: 'http://localhost:11434/v1',
        fetch: local,
      }).stream(request),
    );

    expect(sentBody(openai)).toMatchObject({ max_completion_tokens: 50 });
    expect(sentBody(openai)).not.toHaveProperty('max_tokens');
    expect(sentBody(local)).toMatchObject({ max_tokens: 50 });
    expect(sentBody(local)).not.toHaveProperty('max_completion_tokens');
  });

  it('asks for a reasoning effort only when one is set', async () => {
    const plain = fetchReturning(() => new Response(streamOf(...stream)));
    const quiet = fetchReturning(() => new Response(streamOf(...stream)));

    await collect(createOpenAIClient({ ...options, fetch: plain }).stream(request));
    await collect(
      createOpenAIClient({ ...options, reasoningEffort: 'none', fetch: quiet }).stream(request),
    );

    expect(sentBody(plain)).not.toHaveProperty('reasoning_effort');
    expect(sentBody(quiet)).toMatchObject({ reasoning_effort: 'none' });
  });

  it('keeps a model’s thinking out of the answer', async () => {
    const thinking = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning":"The user wants"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning":" a greeting."}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = fetchReturning(() => new Response(streamOf(...thinking)));

    expect(
      await collect(createOpenAIClient({ ...options, fetch: fetchMock }).stream(request)),
    ).toBe('Hello');
  });

  it('rejects malformed JSON in the stream', async () => {
    const fetchMock = fetchReturning(() => new Response(streamOf('data: {not json\n\n')));
    const client = createOpenAIClient({ ...options, fetch: fetchMock });
    await expect(collect(client.stream(request))).rejects.toThrow(LlmError);
  });

  it('wraps a network failure', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    const client = createOpenAIClient({ ...options, fetch: fetchMock });
    await expect(collect(client.stream(request))).rejects.toThrow(LlmError);
  });
});
