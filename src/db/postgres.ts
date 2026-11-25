import pg from 'pg';
import type { Database, Queryable, QueryResult } from './types.js';

export interface PostgresOptions {
  readonly connectionString: string;
  readonly ssl: boolean;
  /** Maximum pooled connections. Keep this low on serverless runtimes. */
  readonly maxConnections?: number;
}

type Runner = Pick<pg.Pool | pg.PoolClient, 'query'>;

function queryable(runner: Runner): Queryable {
  return {
    async query<Row>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<Row>> {
      const result = await runner.query(sql, [...params]);
      return { rows: result.rows as Row[] };
    },
    async exec(sql: string): Promise<void> {
      await runner.query(sql);
    },
  };
}

/** One pool for the whole process. Every module shares it through `Database`. */
export function createPostgresDatabase(options: PostgresOptions): Database {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    // Verify the server certificate. Disabling verification defeats the point of TLS.
    ssl: options.ssl ? { rejectUnauthorized: true } : false,
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  return {
    ...queryable(pool),

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      // BEGIN, the work and COMMIT must share one connection. Issuing them on
      // the pool would let each statement land on a different connection.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(queryable(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
