import {
  EMPTY,
  reduce,
  type Conversation,
  type ConversationEvent,
  type EscalationReason,
  type Message,
} from './conversation.js';
import { createDemoTransport } from './demo.js';
import {
  findCharacter,
  isCharacterId,
  registerCharacter,
  type Character,
} from './characters/index.js';
import { Rig, type Mood, type Point } from './rig.js';
import { STYLES } from './styles.js';
import { parseHexColor, readTheme, textOn, themeVariables } from './theme.js';
import { createHttpTransport, type Transport } from './transport.js';

const ATTRIBUTES = [
  'endpoint',
  'demo',
  'name',
  'greeting',
  'suggestions',
  'placeholder',
  'nudge',
  'handoff-url',
  'mascot',
  'mascot-name',
  'theme',
  'accent',
  'corners',
  'font',
  'position',
] as const;

const HANDOFFS: Record<EscalationReason, { title: string; body: string }> = {
  human_request: { title: 'Passing you to a person', body: 'The team will pick this up.' },
  action_request: {
    title: 'A person needs to do this',
    body: 'I can answer questions, but I can’t change orders or accounts.',
  },
  no_relevant_sources: {
    title: 'Not in the help pages',
    body: 'I won’t guess. The team can answer this one.',
  },
  ungrounded_answer: {
    title: 'Check this with the team',
    body: 'I couldn’t tie that answer to a help page, so treat it as unconfirmed.',
  },
};

const ICONS = {
  close:
    '<svg class="nd-icon-close" aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7l5 5 5-5"/></svg>',
  chat: '<svg class="nd-icon-chat" aria-hidden="true" width="32" height="32" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8.5A2.5 2.5 0 0 1 8.5 6h15A2.5 2.5 0 0 1 26 8.5v10a2.5 2.5 0 0 1-2.5 2.5H15l-5.5 4.5V21h-1A2.5 2.5 0 0 1 6 18.5z"/><path d="M11.5 11.5h9M11.5 15.5h5.5"/></svg>',
  send: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14V4M4.5 8.5 9 4l4.5 4.5"/></svg>',
};

type Child = Node | string | null | undefined | false;

/** Builds an element. Text always goes in as text, never as markup. */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children.filter((child): child is Node | string => Boolean(child)));
  return element;
}

/** Only web addresses, so an attribute or an API response cannot smuggle in a script URL. */
function safeUrl(value: string | null, schemes = ['http:', 'https:']): string | null {
  if (value === null || value.trim() === '') return null;
  try {
    const url = new URL(value, document.baseURI);
    return schemes.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

interface Mascot {
  readonly element: HTMLElement;
  start(): void;
  stop(): void;
  setMood(mood: Mood): void;
  pointTo(point: Point): void;
  lookAt(point: Point, milliseconds: number): void;
  speak(): void;
  bob(): void;
  hop(): void;
}

/** A company's own mascot image. It cannot blink, but it still leaps and hops. */
function imageMascot(url: string, reducedMotion: boolean): Mascot {
  const element = h('div', {}, h('img', { src: url, alt: '' }));
  const hop = (): void => {
    if (reducedMotion || typeof element.animate !== 'function') return;
    element.firstElementChild?.animate(
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(-40%)' },
        { transform: 'translateY(0)' },
      ],
      { duration: 480, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)' },
    );
  };
  const nothing = (): void => undefined;
  element.addEventListener('pointerdown', hop);
  return {
    element,
    start: nothing,
    stop: nothing,
    setMood: (mood) => {
      element.dataset['mood'] = mood;
    },
    pointTo: nothing,
    lookAt: nothing,
    speak: nothing,
    bob: nothing,
    hop,
  };
}

/** The widgets on the page, so a character registered late reaches them. */
const live = new Set<NeonDeskElement>();

/**
 * <neon-desk>: a support chat any site can drop in.
 *
 *   <script src="https://your-server/widget.js" defer></script>
 *   <neon-desk endpoint="https://your-server" name="Acme Outfitters"></neon-desk>
 */
export class NeonDeskElement extends HTMLElement {
  static readonly observedAttributes = ATTRIBUTES;

  /**
   * Adds a character of the site's own, drawn to the rig's part names, so that
   * `mascot="<its id>"` gives it the same motion as the built-in ones. Widgets
   * already on the page that ask for it are redrawn.
   */
  static registerCharacter(character: Character): void {
    const { id } = registerCharacter(character);
    for (const widget of live) {
      if (widget.getAttribute('mascot')?.trim() === id) widget.attributeChangedCallback();
    }
  }

  /** Replace to send messages somewhere other than `endpoint`. */
  transport: Transport | null = null;

  private readonly root: ShadowRoot;
  private conversation: Conversation = EMPTY;
  private isOpen = false;
  private request: AbortController | null = null;
  private mascot: Mascot | null = null;
  /** What the character is called, or null when there is none to name. */
  private mascotName: string | null = null;
  private moodTimer = 0;
  private nudgeTimer = 0;
  private built = false;
  private frame = document.createElement('div');
  private panel: HTMLElement = document.createElement('section');
  private log = document.createElement('div');
  private input = document.createElement('textarea');
  private status = document.createElement('p');
  private launcher = document.createElement('button');
  /** What is on screen for each message, so only a message that changed is redrawn. */
  private readonly drawn = new Map<number, { key: string; element: HTMLElement }>();
  private readonly reducedMotion =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback(): void {
    live.add(this);
    this.build();
    document.addEventListener('pointermove', this.onPointerMove, { passive: true });
    // A touch screen has no hovering pointer, so taps and scrolling are what it can watch.
    document.addEventListener('pointerdown', this.onPointerMove, { passive: true });
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.settleMascot);
    const nudge = this.attribute('nudge');
    if (nudge !== null) {
      this.nudgeTimer = window.setTimeout(() => {
        if (!this.isOpen) this.frame.append(h('div', { class: 'nd-nudge' }, nudge));
      }, 2500);
    }
    if (this.hasAttribute('open')) this.open();
  }

  disconnectedCallback(): void {
    live.delete(this);
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerdown', this.onPointerMove);
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.settleMascot);
    clearTimeout(this.moodTimer);
    clearTimeout(this.nudgeTimer);
    this.request?.abort();
    this.mascot?.stop();
  }

  attributeChangedCallback(): void {
    // Rebuilding is cheap and keeps one code path. The conversation survives it.
    if (this.built) {
      const wasOpen = this.isOpen;
      this.mascot?.stop();
      this.build();
      if (wasOpen) this.open({ animate: false });
    }
  }

  open(options: { animate?: boolean } = {}): void {
    if (this.isOpen || !this.built) return;
    this.isOpen = true;
    this.frame.toggleAttribute('data-open', true);
    this.frame.querySelector('.nd-nudge')?.remove();
    this.panel.removeAttribute('data-closing');
    // Measure where the mascot lands with the panel at rest, then let the
    // panel's entrance play; measuring mid-entrance would land it off target.
    this.panel.style.animation = 'none';
    this.panel.hidden = false;
    this.moveMascot(options.animate !== false);
    this.panel.style.animation = '';
    this.launcher.setAttribute('aria-expanded', 'true');
    this.launcher.setAttribute('aria-label', 'Close chat');
    if (this.mood === 'asleep') this.setMood('idle');
    // On a touch screen, focusing the box would throw the keyboard up at once.
    const typing = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    (typing ? this.input : this.panel).focus({ preventScroll: true });
    this.log.scrollTop = this.log.scrollHeight;
    this.dispatchEvent(new CustomEvent('neon-desk:open'));
  }

  close(): void {
    if (!this.isOpen || !this.built) return;
    this.isOpen = false;
    this.frame.toggleAttribute('data-open', false);
    this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.setAttribute('aria-label', this.openLabel);
    this.moveMascot(true);
    const panel = this.panel;
    if (this.reducedMotion) {
      panel.hidden = true;
    } else {
      panel.setAttribute('data-closing', '');
      panel.addEventListener(
        'animationend',
        () => {
          if (!this.isOpen) panel.hidden = true;
        },
        { once: true },
      );
    }
    this.launcher.focus({ preventScroll: true });
    this.dispatchEvent(new CustomEvent('neon-desk:close'));
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Sends a message as if the customer had typed it. */
  async ask(text: string): Promise<void> {
    const message = text.trim().slice(0, 4000);
    if (message === '' || this.isBusy()) return;
    const transport = this.resolveTransport();
    if (transport === null) return;

    this.apply({ type: 'sent', text: message });
    this.setMood('thinking');
    this.request = new AbortController();
    for await (const event of transport(message, this.conversation.id, this.request.signal)) {
      this.apply(event);
      if (event.type === 'delta') {
        this.setMood('speaking');
        this.mascot?.speak();
      } else if (event.type === 'done') {
        this.finish(event.reason);
      } else if (event.type === 'failed') {
        this.setMood('asleep');
      }
    }
    // A transport that ends without saying how it ended must not leave the form locked.
    if (this.isBusy()) {
      this.apply({ type: 'failed', message: 'The answer was cut off. Please try again.' });
      this.setMood('asleep');
    }
  }

  private mood: Mood = 'idle';

  /** A method, not a field: an answer arriving changes it between two checks. */
  private isBusy(): boolean {
    return this.conversation.status !== 'idle';
  }

  private setMood(mood: Mood): void {
    clearTimeout(this.moodTimer);
    this.mood = mood;
    this.mascot?.setMood(mood);
    const who = this.mascotName;
    // Short enough to stay on one line beside the character.
    this.status.textContent =
      mood === 'asleep'
        ? 'Not connected'
        : mood === 'thinking'
          ? who === null
            ? 'Reading the help pages'
            : `${who} is reading`
          : mood === 'speaking'
            ? who === null
              ? 'Answering'
              : `${who} is answering`
            : 'Answers from the help pages';
  }

  private finish(reason: EscalationReason | null): void {
    if (reason === null) {
      this.setMood('idle');
      this.mascot?.hop();
      return;
    }
    // Look down at the handoff card for a moment, then come back.
    this.setMood('handoff');
    this.moodTimer = window.setTimeout(() => {
      this.setMood('idle');
    }, 2600);
    this.dispatchEvent(new CustomEvent('neon-desk:handoff', { detail: { reason } }));
  }

  /** An attribute's trimmed value, or null when it is missing or blank. */
  private attribute(name: string): string | null {
    const value = this.getAttribute(name)?.trim() ?? '';
    return value === '' ? null : value;
  }

  /** "Acme Outfitters’ help pages", "Harbor Dental’s help pages", or "our help pages". */
  private get helpPages(): string {
    const name = this.attribute('name');
    if (name === null) return 'our help pages';
    return `${name}${/s$/i.test(name) ? '’' : '’s'} help pages`;
  }

  private get openLabel(): string {
    return this.mascotName === null ? 'Open chat' : `Open chat with ${this.mascotName}`;
  }

  private resolveTransport(): Transport | null {
    if (this.transport !== null) return this.transport;
    if (this.hasAttribute('demo')) return (this.transport = createDemoTransport());
    const endpoint = safeUrl(this.getAttribute('endpoint'));
    return endpoint === null ? null : (this.transport = createHttpTransport(endpoint));
  }

  private apply(event: ConversationEvent): void {
    this.conversation = reduce(this.conversation, event);
    this.renderLog();
  }

  // ---------- building ----------

  private build(): void {
    const settings = readTheme((name) => this.getAttribute(name));
    const name = this.attribute('name') ?? 'Support';
    const character = this.character;
    // A company's own image has a name only if the site gives it one.
    this.mascotName =
      this.attribute('mascot') === 'none'
        ? null
        : (this.attribute('mascot-name') ?? character?.name ?? null);

    const style = h('style');
    style.textContent = STYLES;

    this.status = h('p', { class: 'nd-status' });
    this.log = h('div', { class: 'nd-log', role: 'log', 'aria-live': 'polite' });
    this.input = h('textarea', {
      class: 'nd-input',
      rows: '1',
      maxlength: '4000',
      'aria-label': 'Your question',
      placeholder: this.attribute('placeholder') ?? 'Ask a question',
    });
    const send = h('button', { class: 'nd-send nd-cut', type: 'submit', 'aria-label': 'Send' });
    send.innerHTML = ICONS.send;
    const form = h('form', { class: 'nd-composer' }, this.input, send);
    const close = h('button', {
      class: 'nd-icon-button',
      type: 'button',
      'aria-label': 'Close chat',
    });
    close.innerHTML = ICONS.close;

    this.panel = h(
      'section',
      {
        class: 'nd-panel',
        role: 'dialog',
        'aria-label': `${name} support chat`,
        id: 'nd-panel',
        tabindex: '-1',
      },
      h(
        'div',
        { class: 'nd-edge nd-cut' },
        h(
          'div',
          { class: 'nd-surface nd-cut' },
          h(
            'header',
            { class: 'nd-header' },
            h('div', { class: 'nd-title' }, h('h2', { class: 'nd-name' }, name), this.status),
            close,
          ),
          this.log,
          form,
          h(
            'p',
            { class: 'nd-footer' },
            'Powered by Neon Desk',
            this.hasAttribute('demo') && ' · demo mode, scripted answers',
          ),
        ),
      ),
      h('div', { class: 'nd-perch' }),
    );
    this.panel.hidden = true;

    this.launcher = h(
      'button',
      {
        class: 'nd-launcher nd-cut',
        type: 'button',
        'aria-label': this.openLabel,
        'aria-expanded': 'false',
        'aria-controls': 'nd-panel',
      },
      h('span', { class: 'nd-launcher-face nd-cut' }, h('span', { class: 'nd-slot' })),
    );
    this.launcher
      .querySelector('.nd-launcher-face')
      ?.insertAdjacentHTML('beforeend', ICONS.chat + ICONS.close);

    this.frame = h(
      'div',
      { class: 'nd', 'data-position': settings.position },
      this.panel,
      this.launcher,
    );
    this.mascot = this.buildMascot(character);
    if (this.mascot !== null) {
      this.mascot.element.classList.add('nd-mascot');
      this.frame.toggleAttribute('data-mascot', true);
      this.frame.append(this.mascot.element);
      const plate = character?.plate;
      const ground = parseHexColor(plate?.ground ?? null);
      if (plate !== undefined && ground !== null) {
        this.frame.toggleAttribute('data-plate', true);
        this.frame.style.setProperty('--nd-plate', plate.ground);
        this.frame.style.setProperty(
          '--nd-plate-edge',
          `linear-gradient(135deg, ${plate.edge[0]}, ${plate.edge[1]})`,
        );
        this.frame.style.setProperty('--nd-plate-ink', textOn(ground));
      }
    }

    // The host's own inline styles stay untouched; ours go on the wrapper.
    for (const [variable, value] of Object.entries(themeVariables(settings))) {
      this.frame.style.setProperty(variable, value);
    }

    this.isOpen = false;
    this.built = true;
    this.drawn.clear();
    this.root.replaceChildren(style, this.frame);

    this.launcher.addEventListener('click', () => {
      this.toggle();
    });
    this.launcher.addEventListener('pointerenter', () => {
      if (!this.isOpen) this.mascot?.bob();
    });
    close.addEventListener('click', () => {
      this.close();
    });
    this.frame.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) this.close();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${String(this.input.scrollHeight + 2)}px`;
      // The character's eyes follow what is being typed. Its body stays still.
      const box = this.input.getBoundingClientRect();
      const along = Math.min(1, this.input.value.length / 40);
      this.mascot?.lookAt({ x: box.left + box.width * along, y: box.top + box.height / 2 }, 1400);
    });

    this.mascotAt = null;
    this.setMood(this.mood);
    this.renderLog();
    this.mascot?.start();
    requestAnimationFrame(this.settleMascot);
  }

  /** The character the `mascot` attribute names, if it names one. */
  private get character(): Character | undefined {
    return findCharacter(this.attribute('mascot') ?? 'frog');
  }

  private buildMascot(character: Character | undefined): Mascot | null {
    const choice = this.attribute('mascot') ?? 'frog';
    if (choice === 'none') return null;
    if (character !== undefined) {
      return new Rig(document, character, { reducedMotion: this.reducedMotion });
    }
    // A bare word is a character that is not registered yet, not an image called that.
    if (isCharacterId(choice)) return null;
    const url = safeUrl(choice);
    return url === null ? null : imageMascot(url, this.reducedMotion);
  }

  private submit(): void {
    const text = this.input.value;
    if (text.trim() === '' || this.isBusy()) return;
    this.input.value = '';
    this.input.style.height = 'auto';
    void this.ask(text);
  }

  // ---------- the mascot's place on screen ----------

  /** Where the mascot belongs right now: in the launcher, or perched on the panel. */
  private mascotTarget(): { x: number; y: number; scale: number } | null {
    const anchor = this.frame.querySelector<HTMLElement>(this.isOpen ? '.nd-perch' : '.nd-slot');
    const box = anchor?.getBoundingClientRect();
    if (box === undefined || box.width === 0 || this.mascot === null) return null;
    const width = this.mascot.element.offsetWidth || 112;
    return { x: box.left, y: box.top, scale: box.width / width };
  }

  private mascotAt: { x: number; y: number; scale: number } | null = null;

  private readonly settleMascot = (): void => {
    this.moveMascot(false);
  };

  private moveMascot(animate: boolean): void {
    const mascot = this.mascot?.element;
    const to = this.mascotTarget();
    if (mascot === undefined || to === null) return;
    const from = this.mascotAt;
    this.mascotAt = to;
    const place = (p: { x: number; y: number; scale: number }, lift = 0, turn = 0): string =>
      `translate(${String(p.x)}px, ${String(p.y - lift)}px) scale(${String(p.scale)}) rotate(${String(turn)}deg)`;
    mascot.style.transform = place(to);
    if (!animate || from === null || this.reducedMotion || typeof mascot.animate !== 'function') {
      return;
    }
    // A leap, not a slide: up and over, landing with a squash.
    const middle = {
      x: (from.x + to.x) / 2,
      y: Math.min(from.y, to.y),
      scale: (from.scale + to.scale) / 2,
    };
    const turn = to.x < from.x ? -14 : 14;
    mascot.animate(
      [
        { transform: place(from), offset: 0 },
        { transform: place(middle, 90, turn), offset: 0.5 },
        { transform: place(to, -6), offset: 0.86 },
        { transform: place(to), offset: 1 },
      ],
      { duration: 520, easing: 'cubic-bezier(0.3, 0.6, 0.3, 1)' },
    );
    // The launcher is still mid-press when a click starts the leap; measure again once it is still.
    window.setTimeout(this.settleMascot, 700);
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.mascot?.pointTo({ x: event.clientX, y: event.clientY });
  };

  private lastScroll = 0;

  /** It follows the page as it scrolls: eyes down when reading on, up when going back. */
  private readonly onScroll = (): void => {
    const top = window.scrollY;
    const box = this.mascot?.element.getBoundingClientRect();
    if (box !== undefined && top !== this.lastScroll) {
      const down = top > this.lastScroll ? 1 : -1;
      this.mascot?.lookAt({ x: box.left + box.width / 2, y: box.top + down * 400 }, 500);
    }
    this.lastScroll = top;
  };

  // ---------- the conversation on screen ----------

  private renderLog(): void {
    const { messages, status } = this.conversation;
    let opening = this.log.querySelector<HTMLElement>('.nd-opening');
    if (opening === null) {
      const greeting =
        this.attribute('greeting') ??
        (this.mascotName === null
          ? `Hi. I answer from ${this.helpPages}, and say so when I can’t.`
          : `Hi, I’m ${this.mascotName}. I answer from ${this.helpPages}, and say so when I can’t.`);
      opening = h(
        'div',
        { class: 'nd-opening nd-message', 'data-role': 'assistant' },
        h('div', { class: 'nd-bubble' }, greeting),
      );
      this.log.replaceChildren(opening, this.renderSuggestions());
    }
    const suggestions = this.log.querySelector<HTMLElement>('.nd-suggestions');
    if (suggestions !== null) suggestions.hidden = messages.length > 0;

    // Redraw only what changed. Rebuilding the whole log on every piece of a
    // streamed answer would replay entrance animations and make a screen reader
    // start over.
    for (const message of messages) {
      const key = JSON.stringify(message);
      const previous = this.drawn.get(message.id);
      if (previous?.key === key) continue;
      const element = this.renderMessage(message);
      if (previous === undefined) this.log.append(element);
      else {
        element.style.animation = 'none';
        previous.element.replaceWith(element);
      }
      this.drawn.set(message.id, { key, element });
    }

    this.log.setAttribute('aria-busy', String(status !== 'idle'));
    this.log.scrollTop = this.log.scrollHeight;
    const send = this.root.querySelector<HTMLButtonElement>('.nd-send');
    if (send !== null) send.disabled = status !== 'idle';
  }

  private renderSuggestions(): HTMLElement {
    const suggestions = (this.attribute('suggestions') ?? '')
      .split('|')
      .map((text) => text.trim())
      .filter((text) => text !== '');
    const box = h('div', { class: 'nd-suggestions' });
    if (suggestions.length === 0) {
      box.hidden = true;
      return box;
    }
    box.append(
      h('p', { class: 'nd-label' }, 'Try one'),
      ...suggestions.map((text) => {
        const chip = h('button', { class: 'nd-chip', type: 'button' }, text);
        chip.addEventListener('click', () => void this.ask(text));
        return chip;
      }),
    );
    return box;
  }

  private renderMessage(message: Message): HTMLElement {
    const bubble = h('div', { class: 'nd-bubble' });
    if (message.failure !== null) {
      bubble.toggleAttribute('data-failed', true);
      bubble.textContent = message.failure;
    } else if (message.pending && message.text === '') {
      bubble.append(h('span', { class: 'nd-reading' }, 'Reading the help pages'));
    } else {
      bubble.append(...this.withMarkers(message));
    }

    const article = h('div', { class: 'nd-message', 'data-role': message.role }, bubble);

    if (message.citations.length > 0) {
      article.append(
        h(
          'div',
          { class: 'nd-sources' },
          h('p', { class: 'nd-label' }, 'Answered from'),
          h(
            'ol',
            {},
            ...message.citations.map((citation) => {
              const url = safeUrl(citation.url);
              const label = [h('b', {}, String(citation.marker)), h('span', {}, citation.title)];
              return h(
                'li',
                {},
                url === null
                  ? h('span', { class: 'nd-source' }, ...label)
                  : h(
                      'a',
                      { class: 'nd-source', href: url, target: '_blank', rel: 'noopener' },
                      ...label,
                    ),
              );
            }),
          ),
        ),
      );
    }

    if (message.escalation !== null) {
      const copy = HANDOFFS[message.escalation];
      const url = safeUrl(this.getAttribute('handoff-url'), ['http:', 'https:', 'mailto:', 'tel:']);
      article.append(
        h(
          'div',
          { class: 'nd-handoff' },
          h('strong', {}, copy.title),
          h('p', {}, copy.body),
          url !== null && h('a', { class: 'nd-button', href: url }, 'Contact the team'),
        ),
      );
    }

    if (message.failure !== null) {
      const question = this.conversation.messages.find((m) => m.id === message.id - 1)?.text;
      const retry = h('button', { class: 'nd-text-button', type: 'button' }, 'Try again');
      retry.addEventListener('click', () => {
        if (question !== undefined) void this.ask(question);
      });
      article.append(retry);
    }
    return article;
  }

  /** The answer's text, with each "[2]" the model wrote turned into a small source marker. */
  private withMarkers(message: Message): (Node | string)[] {
    const known = new Map(message.citations.map((citation) => [citation.marker, citation]));
    return message.text.split(/(\[\d{1,3}\])/).map((part) => {
      const marker = /^\[(\d{1,3})\]$/.exec(part);
      const citation = marker === null ? undefined : known.get(Number(marker[1]));
      if (citation === undefined) return part;
      const url = safeUrl(citation.url);
      const attributes = { class: 'nd-marker', title: citation.title };
      return url === null
        ? h('span', attributes, String(citation.marker))
        : h(
            'a',
            { ...attributes, href: url, target: '_blank', rel: 'noopener' },
            String(citation.marker),
          );
    });
  }
}
