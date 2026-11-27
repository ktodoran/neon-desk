import { writeFile } from 'node:fs/promises';
import { ConfigError, loadConfig } from '../src/config.js';
import { createLlmClient } from '../src/llm/providers.js';
import { createEmbedder } from '../src/rag/embeddings.js';
import { createTestDatabase } from '../test/helpers/database.js';
import { dataset } from './dataset.js';
import { evaluateChat, evaluateRetrieval, loadKnowledge } from './harness.js';
import { formatReport } from './report.js';
import { summarizeChat, summarizeRetrieval } from './score.js';

/**
 * Usage:
 *   npm run eval                      the full pipeline, using the model in .env
 *   npm run eval -- --retrieval-only  search only, no model calls
 *   npm run eval -- --write           also save the report to evals/RESULTS.md
 *
 * Runs against an in-process Postgres, so it needs no database and leaves
 * nothing behind. It uses the embeddings and model settings from .env.
 */

const flags = new Set(process.argv.slice(2));
const retrievalOnly = flags.has('--retrieval-only');

try {
  // The run brings its own database; DATABASE_URL is not used.
  const config = loadConfig({ DATABASE_URL: 'postgres://not-used', ...process.env });
  if (!retrievalOnly && config.llm === undefined) {
    throw new ConfigError(
      'No model is configured. Set LLM_PROVIDER, LLM_API_KEY and LLM_MODEL, or pass --retrieval-only.',
    );
  }

  const db = await createTestDatabase();
  const embedder = createEmbedder(config.embeddings);
  const search = {
    topK: config.rag.topK,
    candidates: config.rag.candidates,
    minScore: config.rag.minScore,
  };
  const chunking = {
    maxChars: config.rag.chunkMaxChars,
    overlapChars: config.rag.chunkOverlapChars,
  };

  try {
    const documents = await loadKnowledge({ db, embedder }, chunking, [
      'examples/knowledge',
      'evals/fixtures',
    ]);
    const retrieval = summarizeRetrieval(
      await evaluateRetrieval({ db, embedder, search }, dataset),
    );

    let chat = null;
    if (!retrievalOnly && config.llm !== undefined) {
      const verdicts = await evaluateChat(
        {
          db,
          embedder,
          llm: createLlmClient(config.llm),
          settings: config.assistant,
          search,
          maxTokens: config.llm.maxTokens,
        },
        dataset,
        (verdict) => {
          console.error(`${verdict.passed ? 'pass' : 'FAIL'}  ${verdict.id}`);
        },
      );
      chat = { summary: summarizeChat(verdicts), verdicts };
    }

    const report = formatReport({
      date: new Date().toISOString().slice(0, 10),
      embeddingModel: embedder.model,
      chatModel: retrievalOnly ? null : (config.llm?.model ?? null),
      documents,
      passages: config.rag.topK,
      retrieval,
      chat,
    });
    console.log(report);
    if (flags.has('--write')) {
      await writeFile('evals/RESULTS.md', report);
      console.error('Saved to evals/RESULTS.md');
    }
  } finally {
    await db.close();
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
