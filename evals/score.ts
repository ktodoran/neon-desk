import type { EvalCase } from './dataset.js';

/** What the assistant did with one case. */
export interface CaseOutcome {
  readonly answer: string;
  readonly escalated: boolean;
  /** File names of the documents the answer cited. */
  readonly cited: readonly string[];
  /** Why it was handed off, as the pipeline reported it. */
  readonly reason?: string | null;
}

export interface CaseVerdict {
  readonly id: string;
  readonly category: EvalCase['category'];
  readonly passed: boolean;
  /** One entry per expectation that was not met. Empty when the case passed. */
  readonly failures: readonly string[];
  readonly routeCorrect: boolean;
  /** Null when the case does not expect a cited source. */
  readonly citationCorrect: boolean | null;
}

function matches(pattern: string, text: string): boolean {
  return new RegExp(pattern, 'i').test(text);
}

export function judge(testCase: EvalCase, outcome: CaseOutcome): CaseVerdict {
  const { expect } = testCase;
  const failures: string[] = [];

  const routeCorrect =
    expect.route === 'either' || (expect.route === 'handoff') === outcome.escalated;
  if (!routeCorrect) {
    failures.push(
      expect.route === 'handoff'
        ? 'answered instead of handing off'
        : // The reason separates a routing mistake from an answer that cited nothing.
          `handed off instead of answering${
            typeof outcome.reason === 'string' ? ` (${outcome.reason})` : ''
          }`,
    );
  }

  // A source is only owed when the assistant was meant to answer and did.
  const owesCitation = expect.sources !== undefined && !outcome.escalated;
  const citationCorrect = owesCitation
    ? outcome.cited.some((source) => expect.sources?.includes(source))
    : null;
  if (citationCorrect === false) failures.push('did not cite a document that holds the answer');

  if (!outcome.escalated) {
    for (const pattern of expect.includes ?? []) {
      if (!matches(pattern, outcome.answer)) failures.push(`answer is missing /${pattern}/`);
    }
  }
  for (const pattern of expect.excludes ?? []) {
    if (matches(pattern, outcome.answer)) failures.push(`answer contains /${pattern}/`);
  }

  return {
    id: testCase.id,
    category: testCase.category,
    passed: failures.length === 0,
    failures,
    routeCorrect,
    citationCorrect,
  };
}

export interface RetrievalVerdict {
  readonly id: string;
  /** 1-based rank of the first acceptable document, or null if it was not retrieved. */
  readonly rank: number | null;
}

/** Rank of the first acceptable document among the retrieved ones, in retrieval order. */
export function rankOf(retrieved: readonly string[], acceptable: readonly string[]): number | null {
  const index = retrieved.findIndex((source) => acceptable.includes(source));
  return index === -1 ? null : index + 1;
}

export interface RetrievalSummary {
  readonly cases: number;
  readonly recallAt1: number;
  readonly recallAt3: number;
  readonly recallAt5: number;
  /** Mean reciprocal rank: 1 when the right document is always first. */
  readonly mrr: number;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

export function summarizeRetrieval(verdicts: readonly RetrievalVerdict[]): RetrievalSummary {
  const within = (k: number) =>
    ratio(
      verdicts.filter((verdict) => verdict.rank !== null && verdict.rank <= k).length,
      verdicts.length,
    );
  return {
    cases: verdicts.length,
    recallAt1: within(1),
    recallAt3: within(3),
    recallAt5: within(5),
    mrr: ratio(
      verdicts.reduce((sum, verdict) => sum + (verdict.rank === null ? 0 : 1 / verdict.rank), 0),
      verdicts.length,
    ),
  };
}

export interface ChatSummary {
  readonly cases: number;
  readonly passRate: number;
  readonly routingAccuracy: number;
  /** Among cases that owed a citation. */
  readonly citationAccuracy: number;
  readonly byCategory: Readonly<
    Record<string, { readonly passed: number; readonly total: number }>
  >;
}

export function summarizeChat(verdicts: readonly CaseVerdict[]): ChatSummary {
  const owed = verdicts.filter((verdict) => verdict.citationCorrect !== null);
  const byCategory: Record<string, { passed: number; total: number }> = {};
  for (const verdict of verdicts) {
    const bucket = (byCategory[verdict.category] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (verdict.passed) bucket.passed += 1;
  }
  return {
    cases: verdicts.length,
    passRate: ratio(verdicts.filter((verdict) => verdict.passed).length, verdicts.length),
    routingAccuracy: ratio(
      verdicts.filter((verdict) => verdict.routeCorrect).length,
      verdicts.length,
    ),
    citationAccuracy: ratio(owed.filter((verdict) => verdict.citationCorrect).length, owed.length),
    byCategory,
  };
}
