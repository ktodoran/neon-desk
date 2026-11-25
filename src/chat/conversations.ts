import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/types.js';
import type { LlmMessage } from '../llm/types.js';

export interface Citation {
  /** The number the answer used for this source, as in "[2]". */
  readonly marker: number;
  readonly title: string;
  readonly url: string | null;
  readonly documentId: string;
}

export async function createConversation(db: Queryable): Promise<string> {
  const id = randomUUID();
  await db.query('INSERT INTO conversations (id) VALUES ($1)', [id]);
  return id;
}

export async function conversationExists(db: Queryable, id: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM conversations WHERE id = $1', [id]);
  return rows.length > 0;
}

/** The most recent `limit` messages, oldest first. */
export async function recentMessages(
  db: Queryable,
  conversationId: string,
  limit: number,
): Promise<LlmMessage[]> {
  const { rows } = await db.query<{ role: 'user' | 'assistant'; content: string }>(
    `SELECT role, content
       FROM (SELECT role, content, position
               FROM messages
              WHERE conversation_id = $1
              ORDER BY position DESC
              LIMIT $2) recent
      ORDER BY position`,
    [conversationId, limit],
  );
  return rows.map((row) => ({ role: row.role, content: row.content }));
}

/** Appends a question and its answer as consecutive messages. Call inside a transaction. */
export async function appendExchange(
  tx: Queryable,
  conversationId: string,
  question: string,
  answer: string,
  citations: readonly Citation[],
): Promise<void> {
  const { rows } = await tx.query<{ next: number }>(
    'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM messages WHERE conversation_id = $1',
    [conversationId],
  );
  const next = rows[0]?.next ?? 0;
  await tx.query(
    `INSERT INTO messages (id, conversation_id, position, role, content, citations)
     VALUES ($1, $2, $3, 'user', $4, '[]'::jsonb),
            ($5, $2, $6, 'assistant', $7, $8::jsonb)`,
    [
      randomUUID(),
      conversationId,
      next,
      question,
      randomUUID(),
      next + 1,
      answer,
      JSON.stringify(citations),
    ],
  );
}
