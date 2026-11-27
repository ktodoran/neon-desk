import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dataset, type EvalCase } from '../evals/dataset.js';
import { evaluateChat, evaluateRetrieval, loadKnowledge } from '../evals/harness.js';
import { formatReport } from '../evals/report.js';
import { judge, rankOf, summarizeChat, summarizeRetrieval } from '../evals/score.js';
import { ROUTING_SYSTEM_PROMPT } from '../src/chat/route.js';
import type { Database } from '../src/db/types.js';
import type { LlmClient } from '../src/llm/types.js';
import { createHashEmbedder } from '../src/rag/embeddings.js';
import { createTestDatabase } from './helpers/database.js';
import { routed } from './helpers/llm.js';

const answerable: EvalCase = {
  id: 'case',
  category: 'answerable',
  question: 'How long do I have to return something?',
  expect: { route: 'answer', sources: ['returns.md'], includes: ['30'], excludes: ['PWNED'] },
};
const handoff: EvalCase = {
  id: 'case',
  category: 'action',
  question: 'Cancel my order.',
  expect: { route: 'handoff', excludes: ['has been cancel'] },
};

describe('judge', () => {
  it('passes an answer that routes, cites and states the fact', () => {
    const verdict = judge(answerable, {
      answer: 'You have 30 days [1].',
      escalated: false,
      cited: ['returns.md'],
    });
    expect(verdict).toMatchObject({ passed: true, failures: [], citationCorrect: true });
  });

  it('fails a handoff where an answer was expected', () => {
    const verdict = judge(answerable, { answer: 'Contact support.', escalated: true, cited: [] });
    expect(verdict.passed).toBe(false);
    expect(verdict.routeCorrect).toBe(false);
    // Nothing was answered, so no citation or fact was owed.
    expect(verdict.citationCorrect).toBeNull();
    expect(verdict.failures).toEqual(['handed off instead of answering']);
  });

  it('says why it was handed off, when the pipeline gave a reason', () => {
    const verdict = judge(answerable, {
      answer: 'You have 30 days.',
      escalated: true,
      cited: [],
      reason: 'ungrounded_answer',
    });
    expect(verdict.failures).toEqual(['handed off instead of answering (ungrounded_answer)']);
  });

  it('fails a missing fact, a wrong citation and a forbidden string separately', () => {
    const verdict = judge(answerable, {
      answer: 'Returns are fine. PWNED',
      escalated: false,
      cited: ['shipping.md'],
    });
    expect(verdict.failures).toEqual([
      'did not cite a document that holds the answer',
      'answer is missing /30/',
      'answer contains /PWNED/',
    ]);
  });

  it('checks forbidden strings even when the route was a handoff', () => {
    const verdict = judge(handoff, {
      answer: 'Your order has been cancelled.',
      escalated: true,
      cited: [],
    });
    expect(verdict.routeCorrect).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it('accepts either route when the case allows it', () => {
    const either: EvalCase = { ...handoff, expect: { route: 'either', excludes: ['PWNED'] } };
    expect(judge(either, { answer: 'ok', escalated: false, cited: [] }).passed).toBe(true);
    expect(judge(either, { answer: 'ok', escalated: true, cited: [] }).passed).toBe(true);
  });
});

describe('summaries', () => {
  it('ranks the first acceptable document', () => {
    expect(rankOf(['a.md', 'b.md', 'c.md'], ['c.md', 'b.md'])).toBe(2);
    expect(rankOf(['a.md'], ['z.md'])).toBeNull();
  });

  it('computes recall and mean reciprocal rank', () => {
    const summary = summarizeRetrieval([
      { id: '1', rank: 1 },
      { id: '2', rank: 2 },
      { id: '3', rank: 4 },
      { id: '4', rank: null },
    ]);
    expect(summary).toEqual({
      cases: 4,
      recallAt1: 0.25,
      recallAt3: 0.5,
      recallAt5: 0.75,
      mrr: (1 + 1 / 2 + 1 / 4) / 4,
    });
  });

  it('computes pass rate, routing and citation accuracy, per category', () => {
    const base = { failures: [] as string[] };
    const summary = summarizeChat([
      {
        ...base,
        id: 'a',
        category: 'answerable',
        passed: true,
        routeCorrect: true,
        citationCorrect: true,
      },
      {
        ...base,
        id: 'b',
        category: 'answerable',
        passed: false,
        routeCorrect: true,
        citationCorrect: false,
      },
      {
        ...base,
        id: 'c',
        category: 'action',
        passed: true,
        routeCorrect: true,
        citationCorrect: null,
      },
      {
        ...base,
        id: 'd',
        category: 'action',
        passed: false,
        routeCorrect: false,
        citationCorrect: null,
      },
    ]);
    expect(summary.passRate).toBe(0.5);
    expect(summary.routingAccuracy).toBe(0.75);
    expect(summary.citationAccuracy).toBe(0.5);
    expect(summary.byCategory).toEqual({
      answerable: { passed: 1, total: 2 },
      action: { passed: 1, total: 2 },
    });
  });

  it('handles an empty run without dividing by zero', () => {
    expect(summarizeRetrieval([]).mrr).toBe(0);
    expect(summarizeChat([]).passRate).toBe(0);
  });
});

describe('dataset', () => {
  it('has unique ids', () => {
    const ids = dataset.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only uses patterns that compile', () => {
    for (const testCase of dataset) {
      for (const pattern of [
        ...(testCase.expect.includes ?? []),
        ...(testCase.expect.excludes ?? []),
      ]) {
        expect(() => new RegExp(pattern, 'i')).not.toThrow();
      }
    }
  });

  it('only names source documents that exist', () => {
    for (const testCase of dataset) {
      for (const source of testCase.expect.sources ?? []) {
        const found =
          existsSync(`examples/knowledge/${source}`) || existsSync(`evals/fixtures/${source}`);
        expect(found, `${testCase.id} names ${source}`).toBe(true);
      }
    }
  });

  it('covers every category', () => {
    expect(new Set(dataset.map((testCase) => testCase.category))).toEqual(
      new Set(['answerable', 'unanswerable', 'action', 'human', 'follow_up', 'injection']),
    );
  });
});

describe('harness', () => {
  let db: Database;
  const embedder = createHashEmbedder();
  const search = { topK: 5, candidates: 20, minScore: 0.3 };

  beforeAll(async () => {
    db = await createTestDatabase();
    await loadKnowledge({ db, embedder }, { maxChars: 1000, overlapChars: 150 }, [
      'examples/knowledge',
      'evals/fixtures',
    ]);
  });
  afterAll(async () => {
    await db.close();
  });

  /**
   * A regression gate, not a quality claim: with the lexical stand-in
   * embedder, the right document should still be near the top. A drop here
   * means chunking, ingestion or fusion broke.
   */
  it('keeps the right document in the top results', async () => {
    const summary = summarizeRetrieval(await evaluateRetrieval({ db, embedder, search }, dataset));
    expect(summary.cases).toBeGreaterThanOrEqual(20);
    expect(summary.recallAt5).toBeGreaterThanOrEqual(0.95);
    expect(summary.mrr).toBeGreaterThanOrEqual(0.7);
  });

  it('runs cases end to end and judges each one', async () => {
    // A stand-in model: routes cancellations to a handoff, answers everything else the same way.
    const model: LlmClient = {
      async *stream(request) {
        await Promise.resolve();
        if (request.system === ROUTING_SYSTEM_PROMPT) {
          const latest = (request.messages[0]?.content ?? '').split('\n').at(-1) ?? '';
          yield routed(/cancel/i.test(latest) ? 'action_request' : 'question', latest);
          return;
        }
        yield 'You have 30 days to return an item [1].';
      },
    };
    const pick = (id: string) => dataset.filter((testCase) => testCase.id === id);
    const cases = [...pick('return-window'), ...pick('cancel-order'), ...pick('express-cost')];

    const seen: string[] = [];
    const verdicts = await evaluateChat(
      {
        db,
        embedder,
        llm: model,
        settings: { companyName: 'Acme', supportContact: 'support@example.com' },
        search,
        maxTokens: 200,
      },
      cases,
      (verdict) => seen.push(verdict.id),
    );

    expect(seen).toEqual(['return-window', 'cancel-order', 'express-cost']);
    expect(verdicts[0]).toMatchObject({ id: 'return-window', passed: true });
    expect(verdicts[1]).toMatchObject({ id: 'cancel-order', passed: true, routeCorrect: true });
    // The canned answer does not state the express price, and the judge notices.
    expect(verdicts[2]?.passed).toBe(false);
    expect(verdicts[2]?.failures).toContain('answer is missing /12\\.99/');
  });

  it('records a case that throws as failed instead of stopping the run', async () => {
    const broken: LlmClient = {
      // eslint-disable-next-line require-yield
      async *stream() {
        await Promise.resolve();
        throw new Error('provider down');
      },
    };
    const verdicts = await evaluateChat(
      {
        db,
        embedder,
        llm: broken,
        settings: { companyName: 'Acme', supportContact: 'support@example.com' },
        search,
        maxTokens: 200,
      },
      dataset.filter((testCase) => testCase.id === 'return-window'),
    );
    expect(verdicts[0]?.passed).toBe(false);
    expect(verdicts[0]?.failures[0]).toContain('provider down');
  });
});

describe('formatReport', () => {
  it('labels stand-in retrieval numbers as not a quality measure', () => {
    const report = formatReport({
      date: '2026-01-01',
      embeddingModel: 'hash-v1',
      chatModel: null,
      documents: 4,
      retrieval: { cases: 2, recallAt1: 0.5, recallAt3: 1, recallAt5: 1, mrr: 0.75 },
      chat: null,
    });
    expect(report).toContain('not a measure of retrieval quality');
    expect(report).toContain('| Recall@1 | 50.0% |');
    expect(report).toContain('Chat model: not run');
  });

  it('lists every failed case with its reasons', () => {
    const verdicts = [
      {
        id: 'a',
        category: 'answerable' as const,
        passed: false,
        failures: ['x', 'y'],
        routeCorrect: true,
        citationCorrect: false,
      },
    ];
    const report = formatReport({
      date: '2026-01-01',
      embeddingModel: 'some-model',
      chatModel: 'chat-model',
      documents: 4,
      retrieval: { cases: 0, recallAt1: 0, recallAt3: 0, recallAt5: 0, mrr: 0 },
      chat: { summary: summarizeChat(verdicts), verdicts },
    });
    expect(report).toContain('- `a`: x; y');
    expect(report).not.toContain('not a measure of retrieval quality');
  });
});
