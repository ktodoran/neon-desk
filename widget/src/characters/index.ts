import { FOX } from './fox.js';
import { FROG } from './frog.js';
import { OWL } from './owl.js';
import { RETRIEVER } from './retriever.js';
import { ROBOT } from './robot.js';
import { SPARK_PLUG } from './spark-plug.js';
import { TOOTH } from './tooth.js';
import { parseHexColor } from '../theme.js';

/**
 * A character the rig can move. The drawing marks its moving parts with class
 * names, and the rig moves whichever of them it finds:
 *
 *   ndc-pupil   slides toward what the character is looking at
 *   ndc-lid     a cover over an eye, scaled from the top to close it
 *   ndc-crease  shown only while the eyes are shut (add ndc-dim to fade it)
 *   ndc-jaw     drops while the character speaks
 *   ndc-on      the signal light itself: dim at rest, bright while working
 *   ndc-sig     a part that is invisible at rest and appears with the signal
 *   ndc-soft    a faint halo around the signal light
 *   ndc-grow    a part that swells with the signal
 */
export interface Character {
  /** The value of the `mascot` attribute that selects it: lowercase letters, digits and hyphens. */
  readonly id: string;
  /** What it is called, unless the site sets `mascot-name`. */
  readonly name: string;
  /** The drawing: one inline `<svg>` with a `viewBox`. */
  readonly svg: string;
  /** How far the `ndc-pupil` parts travel, in the drawing's own units. */
  readonly look?: { readonly x: number; readonly y: number };
  /** How far the `ndc-jaw` parts drop. A character without one speaks with its signal light. */
  readonly jaw?: number;
  /** The colour of the glow around it. */
  readonly glow?: string;
  /**
   * The plate it sits on in the launcher: a ground, and the two colours its edge
   * runs between. Without one, the launcher takes the widget's theme.
   */
  readonly plate?: { readonly ground: string; readonly edge: readonly [string, string] };
}

const BUILT_IN: readonly Character[] = [FROG, OWL, RETRIEVER, FOX, ROBOT, TOOTH, SPARK_PLUG];
const registry = new Map<string, Character>(BUILT_IN.map((character) => [character.id, character]));

/** The ids of every character the `mascot` attribute accepts right now. */
export function characterIds(): string[] {
  return [...registry.keys()];
}

export function findCharacter(id: string): Character | undefined {
  return registry.get(id);
}

// Shapes and the things that fill, clip and label them. Nothing that runs code,
// embeds a document or loads a file.
const ELEMENTS = new Set([
  'svg',
  'g',
  'defs',
  'path',
  'polygon',
  'polyline',
  'rect',
  'circle',
  'ellipse',
  'line',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'title',
  'desc',
]);
// A script address, or a url() that points anywhere but inside the drawing.
const UNSAFE_VALUE = /javascript:|expression\(|@import|url\(\s*["']?(?!#)/i;

function cleanAttributes(element: Element): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    const isLink = name === 'href' || name.endsWith(':href');
    if (
      name.startsWith('on') ||
      (isLink && !attribute.value.trim().startsWith('#')) ||
      UNSAFE_VALUE.test(attribute.value)
    ) {
      element.removeAttribute(attribute.name);
    }
  }
}

/**
 * A drawing a site registered, reduced to shapes: scripts, embedded documents,
 * event handlers and links to anything outside the drawing are removed.
 * Returns null when the markup is not one well-formed `<svg>`.
 */
export function sanitizeSvg(markup: string): string | null {
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const drawing = parsed.documentElement;
  if (drawing.localName !== 'svg' || parsed.querySelector('parsererror') !== null) return null;
  for (const element of [...drawing.querySelectorAll('*')]) {
    if (ELEMENTS.has(element.localName.toLowerCase())) cleanAttributes(element);
    else element.remove();
  }
  cleanAttributes(drawing);
  return new XMLSerializer().serializeToString(drawing);
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Whether a `mascot` value reads as a character's id, registered yet or not, and so not as an image address. */
export function isCharacterId(value: string): boolean {
  return ID.test(value);
}
const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,/%]+\))$/i;
const isHex = (value: unknown): boolean =>
  typeof value === 'string' && parseHexColor(value) !== null;
const isDistance = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 500;

/**
 * Adds a character, so `mascot="<its id>"` draws it with the same motion as the
 * built-in ones. Throws a TypeError that says what is wrong with a definition
 * it cannot use.
 */
export function registerCharacter(character: Character): Character {
  const { id, name, look, jaw, glow, plate } = character;
  if (typeof id !== 'string' || !ID.test(id)) {
    throw new TypeError('A character id is lowercase letters, digits and hyphens.');
  }
  if (id === 'none' || BUILT_IN.some((builtIn) => builtIn.id === id)) {
    throw new TypeError(`"${id}" is already taken by Neon Desk.`);
  }
  if (typeof name !== 'string' || name.trim() === '' || name.length > 40) {
    throw new TypeError('A character needs a name of 40 characters or fewer.');
  }
  if (look !== undefined && !(isDistance(look.x) && isDistance(look.y))) {
    throw new TypeError('look.x and look.y are distances between 0 and 500.');
  }
  if (jaw !== undefined && !isDistance(jaw)) {
    throw new TypeError('jaw is a distance between 0 and 500.');
  }
  if (glow !== undefined && !COLOUR.test(glow)) {
    throw new TypeError('glow is a hex or rgb() colour.');
  }
  if (plate !== undefined && ![plate.ground, ...plate.edge].every(isHex)) {
    throw new TypeError('plate.ground and both plate.edge colours are hex colours.');
  }
  const svg = typeof character.svg === 'string' ? sanitizeSvg(character.svg) : null;
  if (svg === null) throw new TypeError('A character needs one well-formed <svg>.');

  const registered: Character = {
    id,
    name: name.trim(),
    svg,
    ...(look === undefined ? {} : { look: { x: look.x, y: look.y } }),
    ...(jaw === undefined ? {} : { jaw }),
    ...(glow === undefined ? {} : { glow }),
    ...(plate === undefined
      ? {}
      : { plate: { ground: plate.ground, edge: [plate.edge[0], plate.edge[1]] } }),
  };
  registry.set(id, registered);
  return registered;
}
