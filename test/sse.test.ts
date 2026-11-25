import { describe, expect, it } from 'vitest';
import { parseServerSentEvents, type ServerSentEvent } from '../src/llm/sse.js';
import { streamOf } from './helpers/llm.js';

async function parse(...chunks: string[]): Promise<ServerSentEvent[]> {
  const events: ServerSentEvent[] = [];
  for await (const event of parseServerSentEvents(streamOf(...chunks))) events.push(event);
  return events;
}

describe('parseServerSentEvents', () => {
  it('parses named and unnamed events', async () => {
    expect(await parse('event: ping\ndata: {"a":1}\n\ndata: plain\n\n')).toEqual([
      { event: 'ping', data: '{"a":1}' },
      { event: 'message', data: 'plain' },
    ]);
  });

  it('reassembles events split across network chunks at any byte', async () => {
    const whole = 'event: delta\ndata: {"text":"hello"}\n\nevent: done\ndata: {}\n\n';
    const expected = await parse(whole);
    for (let cut = 1; cut < whole.length; cut += 1) {
      expect(await parse(whole.slice(0, cut), whole.slice(cut))).toEqual(expected);
    }
  });

  it('handles CRLF line endings, including a CRLF split between chunks', async () => {
    expect(await parse('data: one\r', '\n\r\ndata: two\r\n\r\n')).toEqual([
      { event: 'message', data: 'one' },
      { event: 'message', data: 'two' },
    ]);
  });

  it('joins multi-line data and ignores comments', async () => {
    expect(await parse(': keep-alive\n\ndata: line one\ndata: line two\n\n')).toEqual([
      { event: 'message', data: 'line one\nline two' },
    ]);
  });

  it('emits a final event that has no trailing blank line', async () => {
    expect(await parse('data: last')).toEqual([{ event: 'message', data: 'last' }]);
  });

  it('does not split a multi-byte character across chunks', async () => {
    const bytes = new TextEncoder().encode('data: café\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 10)); // ends inside "é"
        controller.enqueue(bytes.slice(10));
        controller.close();
      },
    });
    const events: ServerSentEvent[] = [];
    for await (const event of parseServerSentEvents(stream)) events.push(event);
    expect(events).toEqual([{ event: 'message', data: 'café' }]);
  });
});
