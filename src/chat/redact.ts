/**
 * Removes payment card numbers from text before it is sent to a model, stored
 * or logged. Customers paste card numbers into support chats; nothing here
 * has any use for one.
 *
 * A candidate is 13 to 19 digits, optionally grouped by spaces or dashes, and
 * must pass the Luhn checksum. The checksum is what keeps order numbers,
 * phone numbers and tracking codes from being redacted by accident.
 */
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

export const REDACTED_CARD = '[card number removed]';

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function redactCardNumbers(text: string): string {
  return text.replace(CARD_CANDIDATE, (match) =>
    passesLuhn(match.replace(/[ -]/g, '')) ? REDACTED_CARD : match,
  );
}
