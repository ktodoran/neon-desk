-- Conversation history, so follow-up questions can be understood in context.

CREATE TABLE conversations (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id               UUID PRIMARY KEY,
  conversation_id  UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- Position within the conversation. Ordering by timestamp alone is unsafe:
  -- a question and its answer are written in one transaction and share one.
  position         INTEGER NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  -- For assistant messages: the sources the answer cited. Stored as a snapshot,
  -- so the record stays accurate after the knowledge base changes.
  citations        JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, position)
);
