export interface ServerSentEvent {
  /** The `event:` field, or "message" when the stream does not name one. */
  readonly event: string;
  readonly data: string;
}

/**
 * Turns Server-Sent Events text into events, a piece at a time.
 *
 * Network chunks do not respect event boundaries, so text is buffered and an
 * event is emitted only once its terminating blank line has arrived. This part
 * has no I/O in it, so the server and the browser widget share it.
 */
export interface SseDecoder {
  /** Feeds decoded text and returns the events it completed. */
  push(text: string): ServerSentEvent[];
  /** Returns whatever the end of the stream completes. */
  end(): ServerSentEvent[];
}

export function createSseDecoder(): SseDecoder {
  let buffer = '';
  // A trailing \r may be the first half of a \r\n split across chunks; hold it back.
  let carry = '';

  function drain(final: boolean): ServerSentEvent[] {
    const events: ServerSentEvent[] = [];
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
      if (data.length > 0) events.push({ event, data: data.join('\n') });
    }
    return events;
  }

  return {
    push(chunk) {
      const text = carry + chunk;
      carry = text.endsWith('\r') ? '\r' : '';
      buffer += carry === '' ? text : text.slice(0, -1);
      return drain(false);
    },
    end() {
      buffer += carry;
      carry = '';
      return drain(true);
    },
  };
}

/** Parses a Server-Sent Events byte stream. */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const text = new TextDecoder();
  const decoder = createSseDecoder();
  for await (const chunk of body) {
    yield* decoder.push(text.decode(chunk, { stream: true }));
  }
  yield* decoder.push(text.decode());
  yield* decoder.end();
}
