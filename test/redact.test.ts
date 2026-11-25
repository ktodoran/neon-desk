import { describe, expect, it } from 'vitest';
import { REDACTED_CARD, redactCardNumbers } from '../src/chat/redact.js';

describe('redactCardNumbers', () => {
  // Standard published test numbers: valid checksums, not real accounts.
  it.each([
    ['4242424242424242', 'plain'],
    ['4242 4242 4242 4242', 'spaced'],
    ['4242-4242-4242-4242', 'dashed'],
    ['378282246310005', '15 digits'],
  ])('removes a card number (%s, %s)', (number) => {
    expect(redactCardNumbers(`my card is ${number}, please refund it`)).toBe(
      `my card is ${REDACTED_CARD}, please refund it`,
    );
  });

  it('removes every card number in a message', () => {
    const text = 'try 4242424242424242 or 5555 5555 5555 4444';
    expect(redactCardNumbers(text)).toBe(`try ${REDACTED_CARD} or ${REDACTED_CARD}`);
  });

  it.each([
    'order 1234567890123456 has not arrived',
    'tracking 9400111899223100012345',
    'call 1-800-555-0199',
    'it cost $1,299.00 on 2026-11-25',
    'SKU-88412',
  ])('leaves other numbers alone: %s', (text) => {
    expect(redactCardNumbers(text)).toBe(text);
  });
});
