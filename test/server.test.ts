import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/types.js';
import { buildServer } from '../src/server.js';

function fakeDatabase(query: Database['query']): Database {
  return {
    query,
    exec: () => Promise.resolve(),
    transaction: () => Promise.reject(new Error('not used')),
    close: () => Promise.resolve(),
  };
}

describe('server', () => {
  it('reports healthy when the database answers', async () => {
    const server = buildServer({
      db: fakeDatabase(() => Promise.resolve({ rows: [] })),
      logLevel: false,
    });
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports unavailable when the database does not', async () => {
    const server = buildServer({
      db: fakeDatabase(() => Promise.reject(new Error('connection refused'))),
      logLevel: false,
    });
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.body).not.toContain('connection refused');
  });

  it('answers unknown routes with a stable error shape', async () => {
    const server = buildServer({
      db: fakeDatabase(() => Promise.resolve({ rows: [] })),
      logLevel: false,
    });
    const response = await server.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });
});
