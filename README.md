# rag-support-assistant

A retrieval-grounded customer support assistant any company can embed. It answers from the company's own documents, shows which ones it used, and hands off to a person when it should not answer.

> **Status: under construction.** The knowledge base, retrieval and the chat API are built and tested. Guardrails beyond the basics, the evaluation suite and the embeddable widget are not built yet. See [Roadmap](#roadmap) and [Known limits](#known-limits).

## What works today

- **Ingestion.** Markdown documents are split into overlapping chunks, embedded, and stored in Postgres with pgvector. Re-ingesting an unchanged document costs no embedding calls; re-ingesting an edited one replaces it in place.
- **Hybrid search.** Vector similarity and full-text search run side by side and are merged with reciprocal rank fusion, so both "what's your refund window" and "SKU-88412" find the right passage.
- **A streaming chat endpoint.** Answers arrive as server-sent events, cite the sources they used, and end with a flag saying whether the customer should be routed to a person.
- **Multi-turn conversations.** Follow-up questions are rewritten into standalone search queries using the conversation so far.
- **A no-answer path that never calls a model.** If retrieval finds nothing relevant, the reply is a fixed handoff message.
- **Anthropic and OpenAI-compatible models** behind one small interface.
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

That much runs with no API keys. `.env.example` uses the built-in `hash` embedder, which matches on shared words only and exists for local development and tests.

To chat, set a model in `.env`:

```bash
LLM_PROVIDER=anthropic        # or "openai"
LLM_API_KEY=...
LLM_MODEL=...                 # no default: name the model you intend to use
```

```bash
curl -N -X POST http://localhost:3000/v1/chat \
  -H 'content-type: application/json' \
  -d '{"message": "What is your return policy?"}'
```

For real retrieval quality, also set `EMBEDDINGS_PROVIDER=openai` with an API key and re-ingest. Any service that implements the OpenAI embeddings endpoint works through `EMBEDDINGS_BASE_URL`.

## API

### `POST /v1/chat`

```json
{ "message": "and for international orders?", "conversationId": "optional uuid" }
```

Omit `conversationId` to start a conversation; send the one you received to continue it.

The response is a stream of server-sent events:

| Event   | Data                       | When                                   |
| ------- | -------------------------- | -------------------------------------- |
| `meta`  | `{ conversationId }`       | Once, first                            |
| `delta` | `{ text }`                 | As the answer is generated             |
| `done`  | `{ citations, escalated }` | Once, on success                       |
| `error` | `{ code, message }`        | Instead of `done`, if the stream fails |

`citations` lists each source the answer cited: `{ marker, title, url, documentId }`. `escalated` is `true` when nothing relevant was found or the answer cited no source.

Problems found before the stream starts come back as ordinary JSON errors: `400` for an invalid body, `404` for an unknown conversation, `503` when no model is configured.

### `GET /health`

`200 {"status":"ok"}` when the database answers, `503` when it does not.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run format:check
```

## Design decisions

**Documents are identified by where they came from, not by their content.** A document's key is `(source, external_id)`. Keying on a content hash, the obvious shortcut, means every edit creates a second copy and the stale one keeps getting retrieved. The hash is still stored, but only to skip re-embedding when nothing changed.

**Embedding happens before the transaction opens.** A network call to an embeddings provider can take seconds or fail. Doing it first means no database transaction is held open across it, and a provider failure leaves the previous version of the document untouched.

**Two retrievers, fused by rank.** Embeddings capture meaning but are weak on exact tokens such as product codes. Full-text search is the reverse. Their scores are on unrelated scales, so they are combined by rank position (reciprocal rank fusion) rather than by adding scores.

**No model call when there is nothing to ground an answer in.** A chunk is kept only if it matched keywords or cleared a similarity threshold. If none did, the customer gets a fixed handoff message. The cheapest and most reliable way to stop a model from inventing an answer is not to ask it.

**Follow-ups are rewritten before retrieval.** "And for international?" retrieves nothing useful on its own. With history present, the model first produces a standalone query. If that step fails, the original message is searched as written rather than failing the request.

**Only complete exchanges are stored.** The question and answer are written together, in one transaction, after the answer finishes. If the model fails halfway, the conversation is left exactly as it was.

**Request problems fail before the stream starts.** Validation, the conversation lookup and retrieval all happen before the first byte is sent, so they can return a normal status code. Only a failure during generation has to be reported in-band.

**Generation stops when the client disconnects.** A closed tab aborts the upstream model request, so abandoned answers are not paid for.

**Model and embeddings clients are plain `fetch`.** Each provider contract here is one HTTP endpoint and one stream format, under two hundred lines in total including the SSE parser. Not depending on vendor SDKs keeps providers swappable by URL. The cost is that retries and backoff are not built in yet.

**No default model.** A hardcoded model name goes stale and then fails in production. The operator names the model.

**Tests run against Postgres, not a mock of it.** The suite uses [PGlite](https://pglite.dev), Postgres compiled to WebAssembly, with the pgvector extension loaded. One test file also drives the production `node-postgres` adapter over a real socket. The SSE parser is tested with a stream split at every byte position, and the model clients against streams in each provider's documented shape.

**Environment booleans are parsed explicitly.** `z.coerce.boolean()` turns the string `"false"` into `true`. Only `true`, `false`, `1` and `0` are accepted.

**The embedding width is fixed at 1536.** It is part of the column type. Changing to a model with a different width needs a migration and a re-ingest.

## Known limits

- **The API has no authentication, rate limiting or CORS policy yet.** Do not expose it to the internet as is.
- **Citations are detected, not verified.** The server checks which source numbers the answer referenced, not whether each claim is supported by that source. The evaluation suite in phase 3 measures this.
- **Prompt-injection handling is basic.** Sources are fenced and the model is told to treat them as data. That is a mitigation, not a defense.
- **Model calls are not retried.**
- **Quality has not been measured.** No evaluation numbers exist yet, and the test suite uses a lexical stand-in embedder.

## Layout

```
migrations/        SQL migrations, applied in filename order
src/config.ts      Environment parsing and validation
src/db/            Database interface, Postgres adapter, migration runner
src/rag/           Chunking, embeddings, ingestion, vector and hybrid search
src/llm/           Model interface, SSE parser, Anthropic and OpenAI clients
src/chat/          Prompts, conversation store, chat pipeline
src/cli/           migrate and ingest commands
src/server.ts      HTTP server
test/              Unit and integration tests
examples/knowledge Sample documents
```

## Roadmap

1. **Foundation** — done.
2. **Retrieval and chat** — done.
3. **Guardrails and evaluation** — intent-based handling of account actions, prompt-injection defenses, API authentication and rate limiting, and an evaluation suite with a published results table.
4. **Embeddable widget and deployment** — a script-tag widget, a Shopify example, and an AWS deployment guide.

## License

[MIT](LICENSE)
