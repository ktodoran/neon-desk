import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { migrate } from '../../src/db/migrate.js';
import type { Database, Queryable, QueryResult } from '../../src/db/types.js';

type Runner = Pick<PGlite, 'query' | 'exec'>;

function queryable(runner: Runner): Queryable {
  return {
    async query<Row>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
      const result = await runner.query<Row>(sql, [...params]);
      return { rows: result.rows };
    },
    async exec(sql: string): Promise<void> {
      await runner.exec(sql);
    },
  };
}

/**
 * A real Postgres with pgvector, compiled to WebAssembly and running inside
 * the test process. The integration tests exercise the same SQL the
 * production driver runs, with no Docker and no shared state between files.
 */
export async function createTestDatabase(): Promise<Database> {
  const pglite = new PGlite({ extensions: { vector } });

  const db: Database = {
    ...queryable(pglite),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) =>
      pglite.transaction((tx) => fn(queryable(tx))),
    close: () => pglite.close(),
  };

  await migrate(db);
  return db;
}
