/** The settings a site can pass as attributes on <neon-desk>. */
export interface ThemeSettings {
  readonly theme: 'dark' | 'light';
  readonly accent: string | null;
  readonly corners: 'cut' | 'round' | 'square';
  readonly font: string | null;
  readonly position: 'bottom-right' | 'bottom-left';
}

const oneOf = <T extends string>(value: string | null, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

export function readTheme(get: (name: string) => string | null): ThemeSettings {
  return {
    theme: oneOf(get('theme'), ['dark', 'light'], 'dark'),
    accent: parseHexColor(get('accent')) === null ? null : get('accent'),
    corners: oneOf(get('corners'), ['cut', 'round', 'square'], 'cut'),
    font: sanitizeFont(get('font')),
    position: oneOf(get('position'), ['bottom-right', 'bottom-left'], 'bottom-right'),
  };
}

/** Reads #rgb or #rrggbb. Anything else is not a color this widget will use. */
export function parseHexColor(value: string | null): [number, number, number] | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value?.trim() ?? '');
  if (match?.[1] === undefined) return null;
  const hex = match[1].length === 3 ? match[1].replace(/./g, '$&$&') : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const INK: [number, number, number] = [5, 5, 5];
const PAPER: [number, number, number] = [255, 255, 255];

/** Black or white, whichever is easier to read on the accent. */
export function textOn(accent: [number, number, number]): string {
  return contrast(accent, INK) >= contrast(accent, PAPER) ? '#050505' : '#ffffff';
}

/**
 * A font name goes straight into a style rule, so only let through what a
 * font-family list can contain.
 */
export function sanitizeFont(value: string | null): string | null {
  const font = value?.trim() ?? '';
  return /^[\w\s,'"-]{1,120}$/.test(font) ? font : null;
}

/** The custom properties that differ from the stylesheet's defaults. */
export function themeVariables(settings: ThemeSettings): Record<string, string> {
  const variables: Record<string, string> = {};
  const accent = parseHexColor(settings.accent);
  if (accent !== null && settings.accent !== null) {
    variables['--nd-accent'] = settings.accent;
    variables['--nd-on-accent'] = textOn(accent);
    // A custom accent replaces the two-color Neon Desk edge with a single color.
    variables['--nd-edge'] = settings.accent;
  }
  if (settings.font !== null) variables['--nd-font'] = settings.font;
  return variables;
}
