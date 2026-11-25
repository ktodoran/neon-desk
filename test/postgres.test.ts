import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { createPostgresDatabase } from '../src/db/postgres.js';
import type { Database } from '../src/db/types.js';
import { createHashEmbedder } from '../src/rag/embeddings.js';
import { ingestDocument } from '../src/rag/ingest.js';
import { searchChunks } from '../src/rag/search.js';

/**
 * The other integration tests talk to PGlite through its own API. This file
 * puts the production adapter under test: node-postgres, over a real socket,
 * speaking the Postgres wire protocol to an in-process server.
 */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not determine a free port'));
      });
    });
  });
}

describe('postgres adapter', () => {
  let pglite: PGlite;
  let server: PGLiteSocketServer;
  let db: Database;

  beforeAll(async () => {
    pglite = new PGlite({ extensions: { vector } });
    const port = await freePort();
    server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
    await server.start();

    db = createPostgresDatabase({
      connectionString: `postgres://postgres@127.0.0.1:${String(port)}/postgres`,
      ssl: false,
      // PGlite is a single-session database.
      maxConnections: 1,
    });
    await migrate(db);
    await db.exec('CREATE TABLE tx_probe (n INTEGER NOT NULL)');
  });

  afterAll(async () => {
    await db.close();
    await server.stop();
    await pglite.close();
  });

  it('commits a transaction that resolves', async () => {
    const returned = await db.transaction(async (tx) => {
      await tx.query('INSERT INTO tx_probe (n) VALUES ($1)', [1]);
      return 'done';
    });

    expect(returned).toBe('done');
    const { rows } = await db.query<{ n: number }>('SELECT n FROM tx_probe');
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('rolls back a transaction that throws, and releases the connection', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO tx_probe (n) VALUES ($1)', [2]);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    // With a pool of one, this query would hang if the connection had leaked.
    const { rows } = await db.query<{ n: number }>('SELECT n FROM tx_probe ORDER BY n');
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('ingests and searches end to end through the driver', async () => {
    const embedder = createHashEmbedder();
    const ingested = await ingestDocument(
      { db, embedder, chunking: { maxChars: 500, overlapChars: 50 } },
      {
        source: 'files',
        externalId: 'returns.md',
        title: 'Returns',
        content: 'Our return policy accepts returns within thirty days of delivery.',
      },
    );
    expect(ingested).toMatchObject({ status: 'created', chunks: 1 });

    const hits = await searchChunks({ db, embedder }, 'return policy', { topK: 1, minScore: 0 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: 'Returns', url: null, chunkIndex: 0 });
    expect(typeof hits[0]?.score).toBe('number');
    expect(typeof hits[0]?.documentId).toBe('string');
  });
});
