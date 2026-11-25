import Fastify, { type FastifyInstance } from 'fastify';
import type { Database } from './db/types.js';

export interface ServerOptions {
  readonly db: Database;
  /** A pino level, or false to disable logging (used by tests). */
  readonly logLevel: string | false;
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

  server.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found' } }),
  );

  server.setErrorHandler((error, _request, reply) => {
    server.log.error({ err: error }, 'unhandled error');
    // Internal detail stays in the logs. Clients get a stable, generic shape.
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
  });

  return server;
}
