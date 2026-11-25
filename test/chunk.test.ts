import { describe, expect, it } from 'vitest';
import { chunkText } from '../src/rag/chunk.js';

const options = { maxChars: 200, overlapChars: 60 };

function sentences(count: number, prefix = 'Sentence'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} number ${String(i)} ends here.`).join(
    ' ',
  );
}

/** Length of the longest suffix of `previous` that is also a prefix of `next`. */
function sharedLength(previous: string, next: string): number {
  for (let length = Math.min(previous.length, next.length); length > 0; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) return length;
  }
  return 0;
}

describe('chunkText', () => {
  it('returns nothing for empty or whitespace-only text', () => {
    expect(chunkText('', options)).toEqual([]);
    expect(chunkText('  \n\n \t ', options)).toEqual([]);
  });

  it('keeps short text as one chunk', () => {
    expect(chunkText('A short answer.', options)).toEqual(['A short answer.']);
  });

  it('never produces a chunk longer than maxChars', () => {
    const text = [sentences(30), sentences(12, 'Other'), 'x'.repeat(950)].join('\n\n');
    const chunks = chunkText(text, options);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(options.maxChars);
    }
  });

  it('keeps every sentence of the source', () => {
    const chunks = chunkText(sentences(40), options);
    const all = chunks.join(' ');
    for (let i = 0; i < 40; i += 1) {
      expect(all).toContain(`Sentence number ${String(i)} ends here.`);
    }
  });

  it('repeats the end of one chunk at the start of the next, within the overlap budget', () => {
    const chunks = chunkText(sentences(40), options);
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i += 1) {
      const shared = sharedLength(chunks[i - 1] ?? '', chunks[i] ?? '');
      // At least one whole sentence carries over, and never more than the budget.
      expect(shared).toBeGreaterThanOrEqual('Sentence number 0 ends here.'.length);
      expect(shared).toBeLessThanOrEqual(options.overlapChars);
    }
  });

  it('breaks on paragraph boundaries when paragraphs fit', () => {
    const paragraph = (n: number) => `Paragraph ${String(n)}. ` + 'word '.repeat(25).trim() + '.';
    const chunks = chunkText([paragraph(1), paragraph(2), paragraph(3)].join('\n\n'), {
      maxChars: 200,
      overlapChars: 0,
    });
    expect(chunks).toEqual([paragraph(1), paragraph(2), paragraph(3)]);
  });

  it('splits a single unbroken run of text that exceeds the limit', () => {
    const chunks = chunkText('y'.repeat(1001), { maxChars: 100, overlapChars: 0 });
    expect(chunks).toHaveLength(11);
    expect(chunks.join('')).toBe('y'.repeat(1001));
  });

  it('terminates when overlap is as large as it can be', () => {
    const chunks = chunkText(sentences(200), { maxChars: 120, overlapChars: 119 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(1000);
  });

  it('normalises Windows line endings', () => {
    expect(chunkText('One.\r\n\r\nTwo.', options)).toEqual(['One.\n\nTwo.']);
  });

  it('rejects options that could not make progress', () => {
    expect(() => chunkText('text', { maxChars: 100, overlapChars: 100 })).toThrow(RangeError);
    expect(() => chunkText('text', { maxChars: 0, overlapChars: 0 })).toThrow(RangeError);
    expect(() => chunkText('text', { maxChars: 100, overlapChars: -1 })).toThrow(RangeError);
  });
});
