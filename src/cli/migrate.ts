import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPostgresDatabase } from '../db/postgres.js';

const config = loadConfig();
const db = createPostgresDatabase({
  connectionString: config.database.url,
  ssl: config.database.ssl,
});

try {
  const ran = await migrate(db);
  console.log(ran.length === 0 ? 'Database is up to date.' : `Applied: ${ran.join(', ')}`);
} finally {
  await db.close();
}
