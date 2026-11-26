// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConversationEvent } from '../src/conversation.js';
import { NeonDeskElement } from '../src/index.js';
import type { Transport } from '../src/transport.js';

const scripted = (...events: ConversationEvent[]): Transport =>
  // eslint-disable-next-line @typescript-eslint/require-await -- a transport is an async generator
  async function* () {
    yield* events;
  };

function mount(attributes: Record<string, string> = {}): NeonDeskElement {
  const element = new NeonDeskElement();
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

const shadow = (element: NeonDeskElement): ShadowRoot => {
  if (element.shadowRoot === null) throw new Error('no shadow root');
  return element.shadowRoot;
};
const text = (element: NeonDeskElement, selector: string): string[] =>
  [...shadow(element).querySelectorAll(selector)].map((node) => node.textContent);

describe('<neon-desk>', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('starts closed, with a launcher that says what it does', () => {
    const widget = mount({ name: 'Acme Outfitters' });
    const launcher = shadow(widget).querySelector('.nd-launcher');
    const panel = shadow(widget).querySelector<HTMLElement>('.nd-panel');

    expect(launcher?.getAttribute('aria-label')).toBe('Open chat with Pogo');
    expect(launcher?.getAttribute('aria-expanded')).toBe('false');
    expect(panel?.hidden).toBe(true);
    expect(panel?.getAttribute('aria-label')).toBe('Acme Outfitters support chat');
  });

  it('opens and closes from the launcher, and tells the page', () => {
    const widget = mount();
    const heard: string[] = [];
    widget.addEventListener('neon-desk:open', () => heard.push('open'));
    widget.addEventListener('neon-desk:close', () => heard.push('close'));
    const launcher = shadow(widget).querySelector<HTMLButtonElement>('.nd-launcher');

    launcher?.click();
    expect(shadow(widget).querySelector<HTMLElement>('.nd-panel')?.hidden).toBe(false);
    expect(launcher?.getAttribute('aria-expanded')).toBe('true');

    launcher?.click();
    expect(launcher?.getAttribute('aria-expanded')).toBe('false');
    expect(heard).toEqual(['open', 'close']);
  });

  it('closes on Escape', () => {
    const widget = mount();
    widget.open();

    shadow(widget)
      .querySelector('.nd-input')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(shadow(widget).querySelector('.nd-launcher')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('greets with the company’s name, handling a name that ends in s', () => {
    expect(text(mount({ name: 'Acme Outfitters' }), '.nd-bubble')[0]).toContain(
      'Acme Outfitters’ help pages',
    );
    expect(text(mount({ name: 'Harbor Dental' }), '.nd-bubble')[0]).toContain(
      'Harbor Dental’s help pages',
    );
    expect(text(mount(), '.nd-bubble')[0]).toContain('our help pages');
  });

  it('shows an answer with its sources, and the marker in the text points at one', async () => {
    const widget = mount();
    widget.transport = scripted(
      { type: 'meta', conversationId: 'abc' },
      { type: 'delta', text: 'Within 30 days ' },
      { type: 'delta', text: '[1].' },
      {
        type: 'done',
        citations: [{ marker: 1, title: 'Returns', url: 'https://example.com/returns' }],
        reason: null,
      },
    );

    await widget.ask('What is your return policy?');

    expect(text(widget, '.nd-message[data-role="customer"] .nd-bubble')).toEqual([
      'What is your return policy?',
    ]);
    const marker = shadow(widget).querySelector<HTMLAnchorElement>('a.nd-marker');
    expect(marker?.textContent).toBe('1');
    expect(marker?.href).toBe('https://example.com/returns');
    expect(text(widget, '.nd-source span')).toEqual(['Returns']);
    expect(shadow(widget).querySelector('.nd-log')?.getAttribute('aria-busy')).toBe('false');
  });

  it('leaves a bracketed number alone when no source goes with it', async () => {
    const widget = mount();
    widget.transport = scripted(
      { type: 'delta', text: 'See item [7] on your receipt.' },
      { type: 'done', citations: [], reason: 'ungrounded_answer' },
    );

    await widget.ask('Which item?');

    expect(shadow(widget).querySelector('.nd-marker')).toBeNull();
    expect(text(widget, '.nd-message[data-role="assistant"] .nd-bubble').at(-1)).toBe(
      'See item [7] on your receipt.',
    );
  });

  it('shows a handoff card with a contact link, and tells the page why', async () => {
    const widget = mount({ 'handoff-url': 'mailto:support@example.com' });
    const reasons: unknown[] = [];
    widget.addEventListener('neon-desk:handoff', (event) =>
      reasons.push((event as CustomEvent<{ reason: string }>).detail.reason),
    );
    widget.transport = scripted(
      { type: 'delta', text: 'Of course.' },
      { type: 'done', citations: [], reason: 'human_request' },
    );

    await widget.ask('A person please');

    expect(text(widget, '.nd-handoff strong')).toEqual(['Passing you to a person']);
    expect(shadow(widget).querySelector<HTMLAnchorElement>('.nd-handoff a')?.href).toBe(
      'mailto:support@example.com',
    );
    expect(reasons).toEqual(['human_request']);
  });

  it('shows a failure in plain words and offers to try again', async () => {
    const widget = mount();
    let calls = 0;
    // eslint-disable-next-line @typescript-eslint/require-await -- a transport is an async generator
    widget.transport = async function* () {
      calls += 1;
      yield calls === 1
        ? ({ type: 'failed', message: 'Something went wrong on our side.' } as const)
        : ({ type: 'done', citations: [], reason: null } as const);
    };

    await widget.ask('Hello?');
    expect(text(widget, '.nd-bubble[data-failed]')).toEqual(['Something went wrong on our side.']);

    shadow(widget).querySelector<HTMLButtonElement>('.nd-text-button')?.click();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });

  it('does not leave the form locked when a transport ends without finishing', async () => {
    const widget = mount();
    widget.transport = scripted({ type: 'delta', text: 'Half an ans' });

    await widget.ask('Hello?');

    expect(shadow(widget).querySelector<HTMLButtonElement>('.nd-send')?.disabled).toBe(false);
    expect(text(widget, '.nd-bubble[data-failed]')).toHaveLength(1);
  });

  it('ignores a second question while the first is being answered', async () => {
    const widget = mount();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    widget.transport = async function* () {
      calls += 1;
      await held;
      yield { type: 'done', citations: [], reason: null };
    };

    const first = widget.ask('One');
    await widget.ask('Two');
    release();
    await first;

    expect(calls).toBe(1);
    expect(text(widget, '.nd-message[data-role="customer"] .nd-bubble')).toEqual(['One']);
  });

  it('offers the suggested questions until one is asked', async () => {
    const widget = mount({ suggestions: 'Returns?| Shipping? ||' });
    widget.transport = scripted({ type: 'done', citations: [], reason: null });

    expect(text(widget, '.nd-chip')).toEqual(['Returns?', 'Shipping?']);
    shadow(widget).querySelector<HTMLButtonElement>('.nd-chip')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shadow(widget).querySelector<HTMLElement>('.nd-suggestions')?.hidden).toBe(true);
    expect(text(widget, '.nd-message[data-role="customer"] .nd-bubble')).toEqual(['Returns?']);
  });

  it('keeps the conversation when a setting changes', async () => {
    const widget = mount({ name: 'Acme Outfitters' });
    widget.transport = scripted(
      { type: 'delta', text: 'Yes.' },
      { type: 'done', citations: [], reason: null },
    );
    await widget.ask('Open today?');

    widget.setAttribute('theme', 'light');

    expect(text(widget, '.nd-message[data-role="customer"] .nd-bubble')).toEqual(['Open today?']);
  });

  describe('treats everything from outside as text, never as markup', () => {
    it('renders markup in an answer as characters', async () => {
      const widget = mount();
      widget.transport = scripted(
        { type: 'delta', text: '<img src=x onerror="alert(1)"> <b>bold</b>' },
        { type: 'done', citations: [], reason: null },
      );

      await widget.ask('<script>alert(1)</script>');

      expect(shadow(widget).querySelector('.nd-log img, .nd-log script, .nd-log b')).toBeNull();
      expect(text(widget, '.nd-bubble').join(' ')).toContain('<img src=x onerror="alert(1)">');
    });

    it('does not link a source whose address is not a web address', async () => {
      const widget = mount();
      widget.transport = scripted(
        { type: 'delta', text: 'Here [1].' },
        {
          type: 'done',
          citations: [{ marker: 1, title: 'Trap', url: 'javascript:alert(1)' }],
          reason: null,
        },
      );

      await widget.ask('Link?');

      expect(shadow(widget).querySelector('.nd-log a')).toBeNull();
      expect(text(widget, '.nd-source span')).toEqual(['Trap']);
    });

    it('ignores a script address in its own attributes', async () => {
      const widget = mount({
        'handoff-url': 'javascript:alert(1)',
        mascot: 'javascript:alert(1)',
        accent: 'red; background: url(https://evil.example)',
        font: 'x; } * { display: none',
      });
      widget.transport = scripted({ type: 'done', citations: [], reason: 'human_request' });

      await widget.ask('Person');

      expect(shadow(widget).querySelector('.nd-handoff a')).toBeNull();
      expect(shadow(widget).querySelector('.nd-mascot')).toBeNull();
      const frame = shadow(widget).querySelector<HTMLElement>('.nd');
      expect(frame?.style.getPropertyValue('--nd-accent')).toBe('');
      expect(frame?.style.getPropertyValue('--nd-font')).toBe('');
    });
  });

  it('can run with a company’s own mascot, or none', () => {
    const own = mount({ mascot: 'https://example.com/tooth.svg' });
    const none = mount({ mascot: 'none' });

    expect(shadow(own).querySelector<HTMLImageElement>('.nd-mascot img')?.src).toBe(
      'https://example.com/tooth.svg',
    );
    expect(shadow(own).querySelector('.ndf-svg')).toBeNull();
    expect(shadow(none).querySelector('.nd-mascot')).toBeNull();
  });

  it('draws the frog by default, with the parts that move', () => {
    const frog = shadow(mount()).querySelector('.nd-mascot[data-character="frog"]');

    expect(frog?.querySelectorAll('.ndf-pupil')).toHaveLength(2);
    expect(frog?.querySelectorAll('.ndf-lid')).toHaveLength(2);
    expect(frog?.querySelector('.ndf-jaw')).not.toBeNull();
  });
});
