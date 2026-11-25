import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import type { Database } from '../src/db/types.js';
import { createTestDatabase } from './helpers/database.js';

describe('migrate', () => {
  let db: Database | undefined;

  afterEach(async () => {
    await db?.close();
  });

  it('records what it applied and does nothing the second time', async () => {
    db = await createTestDatabase(); // runs the migrations once

    const { rows } = await db.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(rows.map((row) => row.name)).toEqual(['001_init.sql']);

    expect(await migrate(db)).toEqual([]);
  });

  it('creates the vector index', async () => {
    db = await createTestDatabase();
    const { rows } = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'chunks_embedding_hnsw'",
    );
    expect(rows[0]?.indexdef).toMatch(/USING hnsw/);
  });
});
