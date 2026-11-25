# rag-support-assistant

A retrieval-grounded customer support assistant any company can embed. It answers from the company's own documents, shows which ones it used, and hands off to a person when it should not answer.

> **Status: under construction.** The knowledge-base foundation is built and tested. The chat endpoint, guardrails, evaluation suite and embeddable widget are not built yet. See [Roadmap](#roadmap).

## What works today

- **Ingestion.** Markdown documents are split into overlapping chunks, embedded, and stored in Postgres with pgvector. Re-ingesting an unchanged document costs no embedding calls; re-ingesting an edited one replaces it in place.
- **Vector search.** Cosine similarity over an HNSW index, returning chunks with their document title, URL and score.
- **Validated configuration.** Every environment variable is parsed and checked at startup, and all problems are reported in one error.
- **A health endpoint** that reports whether the database is reachable.
- **Tests that run against a real Postgres**, in process, with no Docker.

## Quick start

Requires Node.js 22.12 or newer and Docker.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migrate
npm run ingest -- examples/knowledge
npm run dev
```

```bash
curl http://localhost:3000/health
```

`.env.example` uses the built-in `hash` embedder, which needs no API key. It matches on shared words only and exists for local development and tests. For real retrieval, set `EMBEDDINGS_PROVIDER=openai` and an API key; any service that implements the OpenAI embeddings endpoint works through `EMBEDDINGS_BASE_URL`.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run format:check
```

## Design decisions

**Documents are identified by where they came from, not by their content.** A document's key is `(source, external_id)`. Keying on a content hash, the obvious shortcut, means every edit creates a second copy and the stale one keeps getting retrieved. The hash is still stored, but only to skip re-embedding when nothing changed.

**Embedding happens before the transaction opens.** A network call to an embeddings provider can take seconds or fail. Doing it first means no database transaction is held open across it, and a provider failure leaves the previous version of the document untouched. The delete-and-reinsert of chunks then runs in one transaction on one connection.

**Tests run against Postgres, not a mock of it.** The suite uses [PGlite](https://pglite.dev), Postgres compiled to WebAssembly, with the pgvector extension loaded. Ingestion and search are tested with the same SQL that runs in production, including a rollback test that fails a write halfway through. One test file also drives the production `node-postgres` adapter over a real socket.

**The embeddings client is a single `fetch` call.** The contract is one HTTP endpoint. Not depending on a vendor SDK keeps the provider swappable by URL and the dependency list short.

**Environment booleans are parsed explicitly.** `z.coerce.boolean()` turns the string `"false"` into `true`. Only `true`, `false`, `1` and `0` are accepted; anything else is an error.

**The embedding width is fixed at 1536.** It is part of the column type. Changing models to one with a different width needs a migration and a re-ingest, and the code says so rather than pretending it is a config flag.

## Layout

```
migrations/        SQL migrations, applied in filename order
src/config.ts      Environment parsing and validation
src/db/            Database interface, Postgres adapter, migration runner
src/rag/           Chunking, embeddings, ingestion, search
src/cli/           migrate and ingest commands
src/server.ts      HTTP server
test/              Unit and integration tests
examples/knowledge Sample documents
```

## Roadmap

1. **Foundation** — done.
2. **Retrieval and chat** — hybrid search (vector plus full-text), multi-turn conversations, streamed answers with citations.
3. **Guardrails and evaluation** — intent-based handling of account actions, prompt-injection defenses, and an evaluation suite with a published results table.
4. **Embeddable widget and deployment** — a script-tag widget, a Shopify example, and an AWS deployment guide.

## License

[MIT](LICENSE)
