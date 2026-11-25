import { Readable } from 'node:stream';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ConversationNotFoundError,
  startChat,
  type ChatDependencies,
  type ChatSession,
} from './chat/chat.js';
import type { Database } from './db/types.js';

export interface ServerOptions {
  readonly db: Database;
  /** A pino level, or false to disable logging (used by tests). */
  readonly logLevel: string | false;
  /** Undefined when no LLM is configured. The chat route then answers 503. */
  readonly chat?: ChatDependencies | undefined;
}

const chatBody = z.object({
  message: z.string().trim().min(1).max(4000),
  conversationId: z.uuid().optional(),
});

const CLIENT_ERRORS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'The request could not be understood' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send the body as application/json' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' },
};

function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The chat response as Server-Sent Events:
 *   meta   { conversationId }           once, first
 *   delta  { text }                     zero or more
 *   done   { citations, escalated }     once, on success
 *   error  { code, message }            once, instead of done, on failure
 */
async function* toServerSentEvents(
  session: ChatSession,
  log: FastifyBaseLogger,
): AsyncGenerator<string> {
  yield frame('meta', { conversationId: session.conversationId });
  try {
    for await (const event of session.events()) {
      const { type, ...data } = event;
      yield frame(type, data);
    }
  } catch (error) {
    // Headers are already sent, so the failure has to travel in-band.
    log.error({ err: error }, 'chat stream failed');
    yield frame('error', {
      code: 'STREAM_FAILED',
      message: 'The answer could not be completed.',
    });
  }
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const server = Fastify({
    logger: options.logLevel === false ? false : { level: options.logLevel },
  });

  /**
   * Readiness, not just liveness: reports whether the database answers, so a
   * load balancer stops routing to an instance that cannot serve requests.
   */
  server.get('/health', async (_request, reply) => {
    try {
      await options.db.query('SELECT 1');
      return { status: 'ok' };
    } catch (error) {
      server.log.error({ err: error }, 'health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  server.post('/v1/chat', async (request, reply) => {
    if (options.chat === undefined) {
      return reply.code(503).send({
        error: { code: 'CHAT_NOT_CONFIGURED', message: 'No language model is configured' },
      });
    }

    const parsed = chatBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Expected { message: string (1-4000 characters), conversationId?: uuid }',
        },
      });
    }

    // Stop paying for generation when the customer closes the tab.
    const abort = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) abort.abort();
    });

    let session: ChatSession;
    try {
      session = await startChat(
        options.chat,
        {
          message: parsed.data.message,
          ...(parsed.data.conversationId === undefined
            ? {}
            : { conversationId: parsed.data.conversationId }),
        },
        abort.signal,
      );
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return reply.code(404).send({
          error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' },
        });
      }
      throw error;
    }

    return (
      reply
        .header('content-type', 'text/event-stream; charset=utf-8')
        .header('cache-control', 'no-cache, no-transform')
        // Tells nginx-style proxies not to buffer the stream.
        .header('x-accel-buffering', 'no')
        .send(Readable.from(toServerSentEvents(session, request.log)))
    );
  });

  server.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );

  server.setErrorHandler((error, _request, reply) => {
    // The framework and its plugins signal client mistakes (malformed JSON, an
    // oversized body, too many requests) by throwing errors that carry a 4xx
    // status. Those are the client's to fix, so pass the status through.
    const status = clientErrorStatus(error);
    if (status !== undefined) {
      return reply.code(status).send({ error: CLIENT_ERRORS[status] ?? CLIENT_ERRORS[400] });
    }
    server.log.error({ err: error }, 'unhandled error');
    // Internal detail stays in the logs. Clients get a stable, generic shape.
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  });

  return server;
}
