import { ConfigError, loadConfig } from './config.js';
import { createPostgresDatabase } from './db/postgres.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPostgresDatabase({
    connectionString: config.database.url,
    ssl: config.database.ssl,
  });
  const server = buildServer({ db, logLevel: config.logLevel });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    server.log.info({ signal }, 'shutting down');
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
