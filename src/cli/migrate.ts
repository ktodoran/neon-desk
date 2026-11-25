import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPostgresDatabase } from '../db/postgres.js';

const config = loadConfig();
const db = createPostgresDatabase({
  connectionString: config.database.url,
  ssl: config.database.ssl,
  maxConnections: config.database.poolMax,
});

try {
  const ran = await migrate(db);
  console.log(ran.length === 0 ? 'Database is up to date.' : `Applied: ${ran.join(', ')}`);
} catch (error) {
  // A one-line reason, not a stack trace: these are operator-facing commands.
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
