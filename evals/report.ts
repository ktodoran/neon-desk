import type { CaseVerdict, ChatSummary, RetrievalSummary } from './score.js';

export interface ReportInput {
  readonly date: string;
  readonly embeddingModel: string;
  /** Null for a retrieval-only run. */
  readonly chatModel: string | null;
  readonly documents: number;
  readonly retrieval: RetrievalSummary;
  readonly chat: {
    readonly summary: ChatSummary;
    readonly verdicts: readonly CaseVerdict[];
  } | null;
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** The run as Markdown: what was measured, with what, and every case that failed. */
export function formatReport(input: ReportInput): string {
  const lines: string[] = [
    '# Evaluation results',
    '',
    `- Date: ${input.date}`,
    `- Embedding model: \`${input.embeddingModel}\``,
    `- Chat model: ${input.chatModel === null ? 'not run' : `\`${input.chatModel}\``}`,
    `- Knowledge base: ${String(input.documents)} documents`,
    '',
  ];

  if (input.embeddingModel === 'hash-v1') {
    lines.push(
      '> Retrieval used the built-in stand-in embedder, which matches on shared words only.',
      '> These numbers check that the pipeline works. They are not a measure of retrieval quality.',
      '',
    );
  }

  lines.push(
    '## Retrieval',
    '',
    `Questions with a known source document: ${String(input.retrieval.cases)}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Recall@1 | ${percent(input.retrieval.recallAt1)} |`,
    `| Recall@3 | ${percent(input.retrieval.recallAt3)} |`,
    `| Recall@5 | ${percent(input.retrieval.recallAt5)} |`,
    `| MRR | ${input.retrieval.mrr.toFixed(3)} |`,
    '',
  );

  if (input.chat !== null) {
    const { summary, verdicts } = input.chat;
    lines.push(
      '## End to end',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      `| Cases passed | ${percent(summary.passRate)} of ${String(summary.cases)} |`,
      `| Routing accuracy | ${percent(summary.routingAccuracy)} |`,
      `| Citation accuracy | ${percent(summary.citationAccuracy)} |`,
      '',
      '| Category | Passed |',
      '| --- | --- |',
      ...Object.entries(summary.byCategory).map(
        ([category, { passed, total }]) => `| ${category} | ${String(passed)} / ${String(total)} |`,
      ),
      '',
    );

    const failed = verdicts.filter((verdict) => !verdict.passed);
    if (failed.length > 0) {
      lines.push('### Failed cases', '');
      for (const verdict of failed) {
        lines.push(`- \`${verdict.id}\`: ${verdict.failures.join('; ')}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
