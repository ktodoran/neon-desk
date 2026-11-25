import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Database } from './types.js';

/** Resolves to <project>/migrations from both src/db and dist/db. */
const DEFAULT_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/**
 * Applies every .sql file in `dir` that has not run yet, in filename order,
 * each in its own transaction. Returns the names of the migrations it applied.
 */
export async function migrate(db: Database, dir: string = DEFAULT_DIR): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((row) => row.name));

  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    ran.push(file);
  }

  return ran;
}
