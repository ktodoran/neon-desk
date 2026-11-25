export interface ServerSentEvent {
  /** The `event:` field, or "message" when the stream does not name one. */
  readonly event: string;
  readonly data: string;
}

/**
 * Parses a Server-Sent Events byte stream.
 *
 * Network chunks do not respect event boundaries, so bytes are buffered and
 * an event is emitted only once its terminating blank line has arrived.
 */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  function* drain(final: boolean): Generator<ServerSentEvent> {
    const normalized = buffer.replace(/\r\n?/g, '\n');
    const blocks = normalized.split('\n\n');
    // The last block is incomplete until the stream ends.
    buffer = final ? '' : (blocks.pop() ?? '');
    for (const block of blocks) {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue; // comment, used as a keep-alive
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0) yield { event, data: data.join('\n') };
    }
  }

  // A trailing \r may be the first half of a \r\n split across chunks; hold it back.
  let carry = '';
  for await (const chunk of body) {
    const text = carry + decoder.decode(chunk, { stream: true });
    carry = text.endsWith('\r') ? '\r' : '';
    buffer += carry === '' ? text : text.slice(0, -1);
    yield* drain(false);
  }
  buffer += carry + decoder.decode();
  yield* drain(true);
}
