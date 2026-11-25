import { ConfigError, loadConfig } from './config.js';
import { createPostgresDatabase } from './db/postgres.js';
import { createLlmClient } from './llm/providers.js';
import { createEmbedder } from './rag/embeddings.js';
import { buildServer } from './server.js';

const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPostgresDatabase({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    maxConnections: config.database.poolMax,
  });
  const chat =
    config.llm === undefined
      ? undefined
      : {
          db,
          embedder: createEmbedder(config.embeddings),
          llm: createLlmClient(config.llm),
          settings: config.assistant,
          search: {
            topK: config.rag.topK,
            candidates: config.rag.candidates,
            minScore: config.rag.minScore,
          },
          maxTokens: config.llm.maxTokens,
        };
  const server = buildServer({ db, logLevel: config.logLevel, chat });
  if (chat === undefined) {
    server.log.warn('LLM_PROVIDER is not set; POST /v1/chat will answer 503');
  }

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    server.log.info({ signal }, 'shutting down');
    // In-flight answers get a grace period. After that, drop whatever is left:
    // a connected but silent client must not be able to hold a deploy open.
    setTimeout(() => {
      server.server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS).unref();
    // Stop accepting requests, let in-flight ones finish, then release the pool.
    void server
      .close()
      .then(() => db.close())
      .then(
        () => process.exit(0),
        (error: unknown) => {
          server.log.error({ err: error }, 'shutdown failed');
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });

  await server.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
