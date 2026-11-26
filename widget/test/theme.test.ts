import { describe, expect, it } from 'vitest';
import {
  contrast,
  parseHexColor,
  readTheme,
  sanitizeFont,
  textOn,
  themeVariables,
} from '../src/theme.js';

const attributes =
  (values: Record<string, string>) =>
  (name: string): string | null =>
    values[name] ?? null;

describe('theme', () => {
  it('reads short and long hex colors', () => {
    expect(parseHexColor('#fff')).toEqual([255, 255, 255]);
    expect(parseHexColor('#B7FF1A')).toEqual([183, 255, 26]);
    expect(parseHexColor(' #0b7f8c ')).toEqual([11, 127, 140]);
  });

  it.each(['red', '#12', '#gggggg', 'rgb(0,0,0)', 'url(javascript:alert(1))', '', null])(
    'does not accept %j as a color',
    (value) => {
      expect(parseHexColor(value)).toBeNull();
    },
  );

  it('puts dark text on a light accent and light text on a dark one', () => {
    expect(textOn([183, 255, 26])).toBe('#050505'); // neon lime
    expect(textOn([255, 122, 26])).toBe('#050505'); // orange
    expect(textOn([31, 92, 63])).toBe('#ffffff'); // deep green
    expect(textOn([11, 127, 140])).toBe('#ffffff'); // teal
  });

  it('picks text that clears the 4.5:1 contrast needed for body text', () => {
    for (const hex of ['#b7ff1a', '#ff7a1a', '#1f5c3f', '#0b7f8c', '#777777', '#000', '#fff']) {
      const accent = parseHexColor(hex);
      const text = parseHexColor(accent === null ? null : textOn(accent));
      expect(accent).not.toBeNull();
      expect(text).not.toBeNull();
      if (accent !== null && text !== null) expect(contrast(accent, text)).toBeGreaterThan(4.5);
    }
  });

  it('falls back to the defaults for values it does not know', () => {
    expect(readTheme(attributes({ theme: 'sepia', corners: 'wavy', position: 'top' }))).toEqual({
      theme: 'dark',
      accent: null,
      corners: 'cut',
      font: null,
      position: 'bottom-right',
    });
  });

  it('sets the accent, the text on it and the edge from one color', () => {
    const settings = readTheme(attributes({ accent: '#1f5c3f', font: 'Fraunces, serif' }));

    expect(themeVariables(settings)).toEqual({
      '--nd-accent': '#1f5c3f',
      '--nd-on-accent': '#ffffff',
      '--nd-edge': '#1f5c3f',
      '--nd-font': 'Fraunces, serif',
    });
  });

  it('sets nothing when the site keeps the defaults', () => {
    expect(themeVariables(readTheme(attributes({})))).toEqual({});
  });

  it('only lets a font-family list through as a font', () => {
    expect(sanitizeFont('"Barlow Condensed", sans-serif')).toBe('"Barlow Condensed", sans-serif');
    expect(sanitizeFont('Inter; } :host { display: none')).toBeNull();
    expect(sanitizeFont('x, url(https://evil.example/f.woff)')).toBeNull();
    expect(sanitizeFont(null)).toBeNull();
  });
});
