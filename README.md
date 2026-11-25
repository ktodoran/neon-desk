# Neon Desk

A retrieval-grounded customer support assistant any company can embed. It answers from the company's own documents, shows which ones it used, and hands off to a person when it should not answer.

> **Status: under construction.** The knowledge base, retrieval, chat API, guardrails and evaluation harness are built and tested. The evaluation has not yet been run against a live model, and the embeddable widget is not built. See [Roadmap](#roadmap) and [Known limits](#known-limits).

## What works today

- **Ingestion.** Markdown documents are split into overlapping chunks, embedded, and stored in Postgres with pgvector. Re-ingesting an unchanged document costs no embedding calls; re-ingesting an edited one replaces it in place.
- **Hybrid search.** Vector similarity and full-text search run side by side and are merged with reciprocal rank fusion, so both "what's your refund window" and "SKU-88412" find the right passage.
- **A streaming chat endpoint.** Answers arrive as server-sent events, cite the sources they used, and end with a flag saying whether the customer should be routed to a person.
- **Multi-turn conversations.** Follow-up questions are rewritten into standalone search queries using the conversation so far.
- **Routing by intent, not keywords.** "What is your refund policy?" is answered; "Refund order 1182" is handed to a person. Both mention refunds; only one asks the assistant to act.
- **A no-answer path that never asks a model to answer.** If retrieval finds nothing relevant, the reply is a fixed handoff message.
- **Card numbers removed on arrival.** A pasted card number is redacted before the model, the database or the logs see it.
- **API protection.** An origin allowlist, per-client rate limiting on the chat route, and a request size limit.
- **An evaluation harness** with 38 cases covering answerable questions, questions the knowledge base cannot answer, requests to act, follow-ups and injection attempts.
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

| Event   | Data                               | When                                   |
| ------- | ---------------------------------- | -------------------------------------- |
| `meta`  | `{ conversationId }`               | Once, first                            |
| `delta` | `{ text }`                         | As the answer is generated             |
| `done`  | `{ citations, escalated, reason }` | Once, on success                       |
| `error` | `{ code, message }`                | Instead of `done`, if the stream fails |

`citations` lists each source the answer cited: `{ marker, title, url, documentId }`.

`escalated` is `true` when the customer should be routed to a person, and `reason` says why:

| `reason`              | Meaning                                                   |
| --------------------- | --------------------------------------------------------- |
| `action_request`      | The customer asked for a change to an order or account    |
| `human_request`       | The customer asked for a person, or is making a complaint |
| `no_relevant_sources` | Retrieval found nothing to answer from                    |
| `ungrounded_answer`   | The model answered without citing a source                |

`reason` is `null` when `escalated` is `false`.

Problems found before the stream starts come back as ordinary JSON errors: `400` for an invalid body, `404` for an unknown conversation, `413` for an oversized body, `429` when rate limited, `503` when no model is configured.

### `GET /health`

`200 {"status":"ok"}` when the database answers, `503` when it does not.

## Putting it on a website

The API is meant to be called from a widget in a customer's browser, which cannot keep a secret. Access is controlled by which sites the browser will let call it, and cost by rate limiting.

```bash
ALLOWED_ORIGINS=https://www.example.com,https://shop.example.com
RATE_LIMIT_MAX=20
RATE_LIMIT_WINDOW_SECONDS=60
TRUST_PROXY=true    # only behind a proxy you control
```

With `ALLOWED_ORIGINS` empty, no cross-origin browser request is allowed.

## Evaluation

```bash
npm run eval                      # full pipeline, using the model in .env
npm run eval -- --retrieval-only  # search only, no model calls
npm run eval -- --write           # also save the report to evals/RESULTS.md
```

The harness loads the sample knowledge base into an in-process Postgres, runs every case in `evals/dataset.ts` through the real pipeline, and reports:

- **Retrieval:** recall at 1, 3 and 5, and mean reciprocal rank, for questions with a known source document.
- **Routing accuracy:** whether the assistant answered or handed off as it should have.
- **Citation accuracy:** whether an answer cited a document that actually holds the answer.
- **Pass rate by category,** including four injection attempts, one of which is a document planted in the knowledge base that contains instructions aimed at the assistant.

Every check is mechanical: which document was cited, whether a required fact appears, whether a forbidden string leaked. There is no model grading another model, so a run costs only the calls being evaluated.

**Results have not been published yet.** The harness has been exercised end to end against a stand-in model, and a retrieval regression check runs with the test suite, but no numbers from a live model exist. They will be added here, with the model names and date, once a real run has been done.

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

**Guardrails decide on intent, not vocabulary.** A keyword filter that blocks "refund" refuses the most common support question there is. One small model call classifies what the customer is asking the assistant to do and, in the same call, produces the search query. Requests to act and requests for a person get a fixed reply and are never searched or answered.

**Routing fails open, into a grounded path.** If the routing call fails or returns something unparseable, the message is treated as a question. The answering step is still limited to retrieved sources, is told it cannot perform actions, and escalates when it cites nothing. Failing the other way would turn a model hiccup into a refused customer.

**No answer is requested when there is nothing to ground it in.** A chunk is kept only if it matched keywords or cleared a similarity threshold. If none did, the customer gets a fixed handoff message. The cheapest and most reliable way to stop a model from inventing an answer is not to ask it.

**Retrieved text cannot close its own fence.** Sources are wrapped in tags and the model is told to treat them as data. Any tag-like text inside a document is neutralized first, so a document cannot end its block early and have the rest read as instructions.

**Card numbers are removed with a checksum, not just a pattern.** Candidates must pass the Luhn check, which is what keeps order numbers and tracking codes from being redacted by accident.

**The origin allowlist is not the cost control; the rate limit is.** An `Origin` header is trivially forged outside a browser. The allowlist stops other websites from embedding the assistant. The per-client limit on the chat route is what bounds spend.

**Follow-ups are rewritten before retrieval.** "And for international?" retrieves nothing useful on its own. The routing call rewrites each message into a standalone query using the conversation so far. The answering call still sees the customer's own words.

**Only complete exchanges are stored.** The question and answer are written together, in one transaction, after the answer finishes. If the model fails halfway, the conversation is left exactly as it was.

**Request problems fail before the stream starts.** Validation, the conversation lookup and retrieval all happen before the first byte is sent, so they can return a normal status code. Only a failure during generation has to be reported in-band.

**Generation stops when the client disconnects.** A closed tab aborts the upstream model request, so abandoned answers are not paid for.

**Model and embeddings clients are plain `fetch`.** Each provider contract here is one HTTP endpoint and one stream format, under two hundred lines in total including the SSE parser. Not depending on vendor SDKs keeps providers swappable by URL. The cost is that retries and backoff are not built in yet.

**Provider errors show the provider's code, never its body.** A failed call reports the HTTP status and the short machine-readable code, such as `insufficient_quota`. That names the cause without echoing a response body that could contain request data.

**Changing the embedding model re-embeds.** Vectors from different models are not comparable. Each document records the model that embedded it, so a re-ingest after a model change replaces the vectors instead of skipping the document as unchanged.

**Search order is deterministic.** Fused scores tie often, because they depend only on rank. Ties are broken on properties of the content, never on generated ids, so the same data and query always return the same order.

**No default model.** A hardcoded model name goes stale and then fails in production. The operator names the model.

**Tests run against Postgres, not a mock of it.** The suite uses [PGlite](https://pglite.dev), Postgres compiled to WebAssembly, with the pgvector extension loaded. One test file also drives the production `node-postgres` adapter over a real socket. The SSE parser is tested with a stream split at every byte position, and the model clients against streams in each provider's documented shape.

**Environment booleans are parsed explicitly.** `z.coerce.boolean()` turns the string `"false"` into `true`. Only `true`, `false`, `1` and `0` are accepted.

**The embedding width is fixed at 1536.** It is part of the column type. Changing to a model with a different width needs a migration and a re-ingest.

## Known limits

- **Quality has not been measured against a live model.** The evaluation harness exists; published numbers do not.
- **Citations are detected, not verified.** The server checks which source numbers the answer referenced. The evaluation checks that the cited document holds the answer and that required facts appear, but nothing verifies each claim sentence by sentence.
- **Prompt-injection defenses are mitigations.** Fencing, neutralized tags and routing reduce the attack surface. The injection cases in the evaluation measure how well that holds for a given model; they do not prove it.
- **Rate-limit counters live in one process.** Behind several instances the effective limit is multiplied until a shared store is added.
- **There is no per-user authentication.** The API identifies callers by network address only.
- **Model calls are not retried.**
- **Only card numbers are redacted.** Other personal data in a message is stored as written.

## Layout

```
migrations/        SQL migrations, applied in filename order
src/config.ts      Environment parsing and validation
src/db/            Database interface, Postgres adapter, migration runner
src/rag/           Chunking, embeddings, ingestion, vector and hybrid search
src/llm/           Model interface, SSE parser, Anthropic and OpenAI clients
src/chat/          Routing, redaction, prompts, conversation store, chat pipeline
src/cli/           migrate and ingest commands
src/server.ts      HTTP server
evals/             Evaluation cases, harness and report
test/              Unit and integration tests
examples/knowledge Sample documents
```

## Roadmap

1. **Foundation** — done.
2. **Retrieval and chat** — done.
3. **Guardrails and evaluation** — built. Remaining: run the evaluation against a live model and publish the results.
4. **Embeddable widget and deployment** — a script-tag widget, a Shopify example, and an AWS deployment guide.

## License

[MIT](LICENSE)
