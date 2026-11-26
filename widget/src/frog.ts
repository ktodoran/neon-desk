import { FROG_SVG } from './frog-art.js';

/** What the assistant is doing, which is what the frog shows. */
export type FrogMood = 'idle' | 'thinking' | 'speaking' | 'handoff' | 'asleep';

export interface Point {
  readonly x: number;
  readonly y: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * Where the eyes should point to look at something, as -1..1 on each axis.
 *
 * The response is steep near the frog and flattens with distance, so the eyes
 * visibly move for a pointer anywhere on the page instead of pinning to the
 * edge as soon as it leaves the widget.
 */
export function gazeToward(from: Point, target: Point): Point {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return { x: 0, y: 0 };
  const reach = (distance / (distance + 160)) * 1.35;
  return {
    x: clamp((dx / distance) * reach, -1, 1),
    y: clamp((dy / distance) * reach, -1, 1),
  };
}

/** Moves a value toward a target at a rate that does not depend on the frame rate. */
export function approach(current: number, target: number, rate: number, seconds: number): number {
  return target + (current - target) * Math.exp(-rate * seconds);
}

interface Glance {
  readonly gaze: Point;
  readonly until: number;
}

/**
 * The frog. It owns one element and a frame loop that turns "what is happening"
 * (a mood, a pointer position, a spoken syllable) into a handful of CSS custom
 * properties. All of the drawing and easing lives in the stylesheet.
 */
export class Frog {
  readonly element: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly reducedMotion: boolean;

  private mood: FrogMood = 'idle';
  private gaze: Point = { x: 0, y: 0 };
  private pointer: Point | null = null;
  private pointerMovedAt = 0;
  private glance: Glance | null = null;
  private lid = 0;
  private jaw = 0;
  private throat = 0;
  private squintUntil = 0;
  private blinkAt = 0;
  private blinkUntil = 0;
  private fidgetAt = 0;
  private frame = 0;
  private lastTick = 0;
  private centre: Point = { x: 0, y: 0 };
  private centreReadAt = -Infinity;
  private pointerNear = false;

  constructor(doc: Document, options: { reducedMotion: boolean }) {
    this.reducedMotion = options.reducedMotion;
    this.element = doc.createElement('div');
    this.element.className = 'ndf';
    this.body = doc.createElement('div');
    this.body.className = 'ndf-body';
    // Static markup defined in this bundle, not user input.
    this.body.innerHTML = FROG_SVG;
    this.element.append(this.body);
    this.element.addEventListener('pointerdown', () => {
      this.poke();
    });
  }

  /** Starts the frame loop. Safe to call more than once. */
  start(): void {
    if (this.frame !== 0 || this.reducedMotion) return;
    const now = performance.now();
    this.lastTick = now;
    this.blinkAt = now + 1800;
    this.fidgetAt = now + 5000;
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  setMood(mood: FrogMood): void {
    this.mood = mood;
    this.element.dataset['mood'] = mood;
    if (this.reducedMotion) this.paint();
  }

  /** Tells the frog where the pointer is, in viewport coordinates. */
  pointTo(point: Point): void {
    this.pointer = point;
    this.pointerMovedAt = performance.now();
  }

  /** Looks at a spot for a moment, whatever the pointer is doing. */
  lookAt(point: Point, milliseconds: number): void {
    this.glance = {
      gaze: gazeToward(this.readCentre(true), point),
      until: performance.now() + milliseconds,
    };
  }

  /** One syllable: the jaw drops and springs back. Called once per piece of the answer. */
  speak(): void {
    this.jaw = 1;
  }

  /** A small dip, for each key the customer presses. */
  bob(): void {
    this.play(
      [
        { transform: 'translateY(0)' },
        { transform: 'translateY(5%)' },
        { transform: 'translateY(0)' },
      ],
      140,
    );
  }

  /** Crouch, jump, land. For an answer that arrived, or a poke. */
  hop(): void {
    this.squintUntil = performance.now() + 620;
    this.play(
      [
        { transform: 'translateY(0) scale(1, 1)', offset: 0 },
        { transform: 'translateY(8%) scale(1.14, 0.82)', offset: 0.18 },
        { transform: 'translateY(-62%) scale(0.92, 1.14)', offset: 0.5 },
        { transform: 'translateY(6%) scale(1.1, 0.88)', offset: 0.8 },
        { transform: 'translateY(0) scale(1, 1)', offset: 1 },
      ],
      560,
    );
  }

  /** Being tapped: it blinks, puffs its throat and hops. */
  poke(): void {
    const now = performance.now();
    this.blinkAt = now;
    this.throat = 1;
    this.hop();
  }

  private play(keyframes: Keyframe[], duration: number): void {
    if (this.reducedMotion || typeof this.body.animate !== 'function') return;
    this.body.animate(keyframes, { duration, easing: 'cubic-bezier(0.3, 0.7, 0.3, 1)' });
  }

  private readCentre(force = false): Point {
    const now = performance.now();
    // Measuring forces layout, so do it a few times a second, not every frame.
    if (force || now - this.centreReadAt > 200) {
      const box = this.element.getBoundingClientRect();
      this.centre = { x: box.left + box.width / 2, y: box.top + box.height * 0.3 };
      this.centreReadAt = now;
    }
    return this.centre;
  }

  private targetGaze(now: number): Point {
    if (this.mood === 'thinking') {
      // Reading: eyes sweep a line left to right, then snap back to the start.
      const sweep = ((now / 900) % 1) * 2 - 1;
      return { x: sweep * 0.85, y: -0.55 };
    }
    if (this.mood === 'handoff') return { x: 0.35, y: 1 };
    if (this.mood === 'asleep') return { x: 0, y: 0.4 };
    if (this.glance !== null) {
      if (now < this.glance.until) return this.glance.gaze;
      this.glance = null;
    }
    if (this.pointer !== null && now - this.pointerMovedAt < 6000) {
      const centre = this.readCentre();
      // The pointer coming right up to it gets a reaction: a blink and a puffed throat.
      const near = Math.hypot(this.pointer.x - centre.x, this.pointer.y - centre.y) < 90;
      if (near && !this.pointerNear) {
        this.blinkAt = now;
        this.throat = 1;
        this.bob();
      }
      this.pointerNear = near;
      return gazeToward(centre, this.pointer);
    }
    return { x: 0, y: 0 };
  }

  private readonly tick = (now: number): void => {
    const seconds = Math.min(0.1, (now - this.lastTick) / 1000);
    this.lastTick = now;

    const target = this.targetGaze(now);
    this.gaze = {
      x: approach(this.gaze.x, target.x, 14, seconds),
      y: approach(this.gaze.y, target.y, 14, seconds),
    };

    // With nothing to look at, glance around so it never sits frozen.
    if (now > this.fidgetAt) {
      this.fidgetAt = now + 3500 + Math.random() * 4000;
      const idle = this.mood === 'idle' && now - this.pointerMovedAt > 6000;
      if (idle && this.glance === null) {
        const gaze = { x: Math.random() * 1.6 - 0.8, y: Math.random() * 0.8 - 0.5 };
        this.glance = { gaze, until: now + 900 + Math.random() * 700 };
        if (Math.random() < 0.3) this.throat = 0.8;
      }
    }

    if (now > this.blinkAt) {
      this.blinkUntil = now + 130;
      // Now and then a double blink.
      this.blinkAt = now + (Math.random() < 0.2 ? 320 : 2400 + Math.random() * 3200);
    }
    let lid = 0;
    if (this.mood === 'asleep') lid = 1;
    else if (now < this.blinkUntil) lid = 1;
    else if (now < this.squintUntil) lid = 0.42;
    this.lid = approach(this.lid, lid, lid > this.lid ? 60 : 22, seconds);

    this.jaw = approach(this.jaw, 0, 13, seconds);
    let throat = 0;
    if (this.mood === 'thinking') throat = 0.55 + 0.45 * Math.sin(now / 150);
    else if (this.mood === 'speaking') throat = 0.5;
    this.throat = approach(this.throat, throat, this.mood === 'thinking' ? 30 : 4, seconds);

    this.paint();
    this.frame = requestAnimationFrame(this.tick);
  };

  private paint(): void {
    if (this.reducedMotion) {
      // No movement: only the steady signals a still image can carry.
      this.lid = this.mood === 'asleep' ? 1 : 0;
      this.throat = this.mood === 'thinking' || this.mood === 'speaking' ? 0.7 : 0;
    }
    const style = this.element.style;
    style.setProperty('--ndf-look-x', this.gaze.x.toFixed(3));
    style.setProperty('--ndf-look-y', this.gaze.y.toFixed(3));
    style.setProperty('--ndf-lid', this.lid.toFixed(3));
    style.setProperty('--ndf-jaw', this.jaw.toFixed(3));
    style.setProperty('--ndf-throat', this.throat.toFixed(3));
    this.element.classList.toggle('is-shut', this.lid > 0.9);
  }
}
