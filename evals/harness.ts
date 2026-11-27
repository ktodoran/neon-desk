import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { startChat, type ChatDependencies } from '../src/chat/chat.js';
import type { ChunkOptions } from '../src/rag/chunk.js';
import { ingestDocument } from '../src/rag/ingest.js';
import { hybridSearch } from '../src/rag/search.js';
import type { EvalCase } from './dataset.js';
import { judge, rankOf, type CaseVerdict, type RetrievalVerdict } from './score.js';

/** Ingests every Markdown file in the given directories, keyed by file name. */
export async function loadKnowledge(
  deps: Pick<ChatDependencies, 'db' | 'embedder'>,
  chunking: ChunkOptions,
  directories: readonly string[],
): Promise<number> {
  let count = 0;
  for (const directory of directories) {
    const files = (await readdir(directory)).filter((file) => extname(file) === '.md').sort();
    for (const file of files) {
      const content = await readFile(join(directory, file), 'utf8');
      const heading = /^#\s+(.+)$/m.exec(content);
      await ingestDocument(
        { ...deps, chunking },
        {
          source: 'files',
          externalId: file,
          title: heading?.[1]?.trim() ?? basename(file, '.md'),
          content,
        },
      );
      count += 1;
    }
  }
  return count;
}

/**
 * Retrieval on its own: for each question with a known source document, where
 * does that document first appear in the results? No model is involved, so
 * this isolates the search from everything built on top of it.
 *
 * Follow-up cases are skipped: their search query is produced by the model.
 */
export async function evaluateRetrieval(
  deps: Pick<ChatDependencies, 'db' | 'embedder' | 'search'>,
  cases: readonly EvalCase[],
): Promise<RetrievalVerdict[]> {
  const verdicts: RetrievalVerdict[] = [];
  for (const testCase of cases) {
    const acceptable = testCase.expect.sources;
    if (acceptable === undefined || testCase.history !== undefined) continue;
    const hits = await hybridSearch(deps, testCase.question, { ...deps.search, topK: 5 });
    // Several chunks of one document count once, at the best position.
    const documents = [...new Set(hits.map((hit) => hit.externalId))];
    verdicts.push({ id: testCase.id, rank: rankOf(documents, acceptable) });
  }
  return verdicts;
}

async function ask(deps: ChatDependencies, conversationId: string | undefined, message: string) {
  const session = await startChat(
    deps,
    conversationId === undefined ? { message } : { conversationId, message },
  );
  let answer = '';
  let escalated = false;
  let reason: string | null = null;
  const cited: string[] = [];
  for await (const event of session.events()) {
    if (event.type === 'delta') {
      answer += event.text;
    } else {
      escalated = event.escalated;
      reason = event.reason;
      for (const citation of event.citations) {
        const source = session.sources.find((hit) => hit.documentId === citation.documentId);
        if (source !== undefined) cited.push(source.externalId);
      }
    }
  }
  return { conversationId: session.conversationId, outcome: { answer, escalated, cited, reason } };
}

/**
 * The whole pipeline, one case at a time: routing, retrieval, generation,
 * citation. Cases run in sequence so a provider's rate limit is not the thing
 * being measured. A case that throws is recorded as failed rather than
 * stopping the run.
 */
export async function evaluateChat(
  deps: ChatDependencies,
  cases: readonly EvalCase[],
  onCase?: (verdict: CaseVerdict) => void,
): Promise<CaseVerdict[]> {
  const verdicts: CaseVerdict[] = [];
  for (const testCase of cases) {
    let verdict: CaseVerdict;
    try {
      let conversationId: string | undefined;
      for (const earlier of testCase.history ?? []) {
        ({ conversationId } = await ask(deps, conversationId, earlier));
      }
      const { outcome } = await ask(deps, conversationId, testCase.question);
      verdict = judge(testCase, outcome);
    } catch (error) {
      verdict = {
        id: testCase.id,
        category: testCase.category,
        passed: false,
        failures: [`error: ${error instanceof Error ? error.message : String(error)}`],
        routeCorrect: false,
        citationCorrect: null,
      };
    }
    verdicts.push(verdict);
    onCase?.(verdict);
  }
  return verdicts;
}
