export interface ChunkOptions {
  /** Hard upper bound on the length of a chunk, in characters. */
  readonly maxChars: number;
  /** Roughly how much of the previous chunk to repeat at the start of the next. */
  readonly overlapChars: number;
}

interface Unit {
  readonly text: string;
  /** True when this unit begins a new paragraph in the source text. */
  readonly startsParagraph: boolean;
}

const SENTENCE_BREAK = /(?<=[.!?])\s+/;

/**
 * Breaks text into units no longer than `maxChars`: paragraphs where they
 * fit, otherwise sentences, otherwise fixed-width slices.
 */
function toUnits(text: string, maxChars: number): Unit[] {
  const units: Unit[] = [];
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      units.push({ text: paragraph, startsParagraph: true });
      continue;
    }
    let first = true;
    for (const sentence of paragraph.split(SENTENCE_BREAK)) {
      for (let offset = 0; offset < sentence.length; offset += maxChars) {
        const slice = sentence.slice(offset, offset + maxChars).trim();
        if (slice.length === 0) continue;
        units.push({ text: slice, startsParagraph: first });
        first = false;
      }
    }
  }
  return units;
}

function join(units: readonly Unit[]): string {
  return units
    .map((unit, index) => (index === 0 ? '' : unit.startsParagraph ? '\n\n' : ' ') + unit.text)
    .join('');
}

/** The trailing units of `units` that fit within `budget` characters. */
function tail(units: readonly Unit[], budget: number): Unit[] {
  const kept: Unit[] = [];
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (unit === undefined) break;
    if (join([unit, ...kept]).length > budget) break;
    kept.unshift(unit);
  }
  return kept;
}

/**
 * Splits text into overlapping chunks for embedding.
 *
 * Chunks break on paragraph boundaries where possible, then sentence
 * boundaries, and only mid-sentence when a single sentence exceeds the limit.
 * Overlap is made of whole units, so a chunk never starts mid-sentence unless
 * its source sentence was itself too long.
 *
 * Guarantees: no chunk is empty, none exceeds `maxChars`, every unit of the
 * source appears in at least one chunk, and the function always terminates.
 */
export function chunkText(text: string, options: ChunkOptions): string[] {
  const { maxChars, overlapChars } = options;
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError('maxChars must be a positive integer');
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new RangeError('overlapChars must be an integer in [0, maxChars)');
  }

  const chunks: string[] = [];
  let current: Unit[] = [];
  // Number of units in `current` that are new, as opposed to carried-over overlap.
  let fresh = 0;

  for (const unit of toUnits(text, maxChars)) {
    if (current.length > 0 && join([...current, unit]).length > maxChars) {
      if (fresh > 0) chunks.push(join(current));
      current = tail(current, overlapChars);
      // Drop overlap that would not leave room for the unit that triggered the flush.
      while (current.length > 0 && join([...current, unit]).length > maxChars) {
        current = current.slice(1);
      }
      fresh = 0;
    }
    current.push(unit);
    fresh += 1;
  }

  if (fresh > 0) chunks.push(join(current));
  return chunks;
}
