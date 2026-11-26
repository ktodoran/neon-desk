// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  characterIds,
  findCharacter,
  registerCharacter,
  sanitizeSvg,
  type Character,
} from '../src/characters/index.js';
import { NeonDeskElement } from '../src/element.js';

if (customElements.get('neon-desk') === undefined) {
  customElements.define('neon-desk', NeonDeskElement);
}

const BUILT_IN = ['frog', 'owl', 'retriever', 'fox', 'robot', 'tooth', 'spark-plug'];

function draw(markup: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  return holder;
}

function mount(attributes: Record<string, string> = {}): NeonDeskElement {
  const widget = new NeonDeskElement();
  widget.setAttribute('demo', '');
  for (const [name, value] of Object.entries(attributes)) widget.setAttribute(name, value);
  document.body.append(widget);
  return widget;
}

const shadow = (widget: NeonDeskElement): ShadowRoot => {
  if (widget.shadowRoot === null) throw new Error('no shadow root');
  return widget.shadowRoot;
};

const LEAF: Character = {
  id: 'leaf',
  name: 'Fern',
  svg: '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><path d="M50 5 L90 60 L50 95 L10 60 Z" fill="#2e9e5b"/><g class="ndc-pupil"><circle cx="40" cy="55" r="5"/><circle cx="60" cy="55" r="5"/></g><circle class="ndc-on" cx="50" cy="20" r="6" fill="#ffd60a"/></svg>',
  look: { x: 4, y: 3 },
  glow: '#2e9e5b',
};

describe('the built-in characters', () => {
  it('are the seven the mascot attribute accepts', () => {
    expect(characterIds()).toEqual(expect.arrayContaining(BUILT_IN));
  });

  it.each(BUILT_IN)('%s has eyes that move, eyes that shut and a signal light', (id) => {
    const character = findCharacter(id);
    const drawing = draw(character?.svg ?? '');

    expect(character?.name).toMatch(/^[A-Z][a-z]+$/);
    expect(drawing.querySelector('svg')?.getAttribute('viewBox')).toMatch(/^[\d ]+$/);
    expect(drawing.querySelectorAll('.ndc-pupil, .ndf-pupil')).toHaveLength(2);
    expect(drawing.querySelectorAll('.ndc-lid, .ndf-lid')).toHaveLength(2);
    expect(drawing.querySelectorAll('.ndc-crease, .ndf-crease')).toHaveLength(2);
    expect(drawing.querySelector('.ndc-on, .ndc-sig, .ndc-grow, .ndf-throat-glow')).not.toBeNull();
  });

  it.each(BUILT_IN)('%s is drawn only with what a registered character may use', (id) => {
    const svg = findCharacter(id)?.svg ?? '';
    const cleaned = sanitizeSvg(svg);

    expect(cleaned).not.toBeNull();
    expect(draw(cleaned ?? '').querySelectorAll('*')).toHaveLength(
      draw(svg).querySelectorAll('*').length,
    );
  });

  it('a character with a mouth says so, and one without speaks with its light', () => {
    expect(findCharacter('owl')?.jaw).toBeGreaterThan(0);
    expect(findCharacter('robot')?.jaw).toBeUndefined();
    expect(draw(findCharacter('owl')?.svg ?? '').querySelector('.ndc-jaw')).not.toBeNull();
    expect(draw(findCharacter('robot')?.svg ?? '').querySelector('.ndc-jaw')).toBeNull();
  });
});

describe('a drawing from outside', () => {
  it('keeps its shapes and loses anything that could run or load', () => {
    const cleaned = sanitizeSvg(
      '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">' +
        '<script>alert(1)</script>' +
        '<foreignObject><div>hello</div></foreignObject>' +
        '<image href="https://example.com/a.png"/>' +
        '<a href="javascript:alert(1)"><rect width="1" height="1"/></a>' +
        '<circle class="ndc-pupil" cx="5" cy="5" r="2" onclick="alert(1)" fill="url(https://example.com/x.svg#a)"/>' +
        '<rect width="4" height="4" style="background: url(https://example.com/t.gif)"/>' +
        '<use xlink:href="https://example.com/sprite.svg#x"/>' +
        '<clipPath id="eye"><circle cx="5" cy="5" r="3"/></clipPath>' +
        '<g clip-path="url(#eye)"><path d="M0 0 L1 1"/></g>' +
        '</svg>',
    );
    const drawing = draw(cleaned ?? '');

    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toMatch(/script|foreignObject|alert|example\.com|onload|onclick/i);
    expect(drawing.querySelector('image, a, use')).toBeNull();
    expect(drawing.querySelector('.ndc-pupil')?.getAttribute('fill')).toBeNull();
    expect(drawing.querySelector('g')?.getAttribute('clip-path')).toBe('url(#eye)');
    expect(drawing.querySelector('path')).not.toBeNull();
  });

  it.each(['', 'just text', '<div>not a drawing</div>', '<svg><g></svg>'])(
    'is refused when it is not one well-formed svg: %j',
    (markup) => {
      expect(sanitizeSvg(markup)).toBeNull();
    },
  );
});

describe('registering a character', () => {
  it('makes it available under its id, cleaned', () => {
    registerCharacter({
      ...LEAF,
      svg: LEAF.svg.replace('<path', '<script>alert(1)</script><path'),
    });
    const leaf = findCharacter('leaf');

    expect(leaf?.name).toBe('Fern');
    expect(leaf?.look).toEqual({ x: 4, y: 3 });
    expect(leaf?.svg).toContain('ndc-pupil');
    expect(leaf?.svg).not.toContain('script');
  });

  it.each<[string, Partial<Character>]>([
    ['an id with capitals', { id: 'Leaf' }],
    ['an id Neon Desk uses', { id: 'frog' }],
    ['the id that means no mascot', { id: 'none' }],
    ['a blank name', { name: '  ' }],
    ['a reach that is not a distance', { look: { x: Number.NaN, y: 2 } }],
    ['a negative jaw', { jaw: -4 }],
    ['a glow that is not a colour', { glow: 'red; background: url(x)' }],
    ['markup that is not a drawing', { svg: '<p>hello</p>' }],
  ])('refuses %s', (_what, change) => {
    expect(() => registerCharacter({ ...LEAF, id: 'refused', ...change })).toThrow(TypeError);
    expect(findCharacter('refused')).toBeUndefined();
  });
});

describe('<neon-desk> with a character', () => {
  it('draws the one the mascot attribute names and calls it by its name', () => {
    const root = shadow(mount({ mascot: 'owl', name: 'Hale & Ward' }));
    const drawing = root.querySelector<SVGElement>('.nd-mascot[data-character="owl"] svg');

    expect(drawing?.classList.contains('ndc-svg')).toBe(true);
    expect(drawing?.getAttribute('aria-hidden')).toBe('true');
    expect(drawing?.style.getPropertyValue('--ndc-reach-x')).toBe('22px');
    expect(drawing?.style.getPropertyValue('--ndc-drop')).toBe('16px');
    expect(root.querySelector('.nd-opening')?.textContent).toContain('Hi, I’m Sage.');
    expect(root.querySelector('.nd-launcher')?.getAttribute('aria-label')).toBe(
      'Open chat with Sage',
    );
  });

  it('marks a character that has no mouth, so its light speaks for it', () => {
    const drawing = shadow(mount({ mascot: 'tooth' })).querySelector('.nd-mascot svg');

    expect(drawing?.classList.contains('ndc-no-jaw')).toBe(true);
  });

  it('says who is working while an answer is on its way', async () => {
    const widget = mount({ mascot: 'owl' });
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    widget.transport = async function* () {
      yield { type: 'delta', text: 'Within ' };
      await held;
      yield { type: 'done', citations: [], reason: null };
    };

    const asked = widget.ask('How long does shipping take?');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow(widget).querySelector('.nd-status')?.textContent).toBe('Sage is answering');

    release();
    await asked;
    expect(shadow(widget).querySelector('.nd-status')?.textContent).toBe(
      'Answers from the help pages',
    );
  });

  it('lets the site rename a character', () => {
    const root = shadow(mount({ mascot: 'spark-plug', 'mascot-name': 'Ace' }));

    expect(root.querySelector('.nd-opening')?.textContent).toContain('Hi, I’m Ace.');
    expect(root.querySelector('.nd-launcher')?.getAttribute('aria-label')).toBe(
      'Open chat with Ace',
    );
  });

  it('names nobody when there is no mascot, or an image nobody named', () => {
    const none = shadow(mount({ mascot: 'none' }));
    const image = shadow(mount({ mascot: 'https://example.com/logo.svg' }));
    const named = shadow(mount({ mascot: 'https://example.com/logo.svg', 'mascot-name': 'Bo' }));

    expect(none.querySelector('.nd-opening')?.textContent).toMatch(/^Hi\. I answer/);
    expect(none.querySelector('.nd-launcher')?.getAttribute('aria-label')).toBe('Open chat');
    expect(image.querySelector('.nd-opening')?.textContent).toMatch(/^Hi\. I answer/);
    expect(named.querySelector('.nd-opening')?.textContent).toContain('Hi, I’m Bo.');
  });

  it('redraws a widget that was waiting for a character registered later', () => {
    const widget = mount({ mascot: 'anchor' });
    expect(shadow(widget).querySelector('.nd-mascot')).toBeNull();

    NeonDeskElement.registerCharacter({ ...LEAF, id: 'anchor', name: 'Marlow' });

    expect(shadow(widget).querySelector('.nd-mascot[data-character="anchor"] svg')).not.toBeNull();
    expect(shadow(widget).querySelector('.nd-opening')?.textContent).toContain('Hi, I’m Marlow.');
  });
});
