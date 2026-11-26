import { describe, expect, it } from 'vitest';
import { approach, gazeToward } from '../src/rig.js';

const origin = { x: 500, y: 500 };

describe('where a character looks', () => {
  it('looks toward the target on each axis', () => {
    expect(gazeToward(origin, { x: 900, y: 500 })).toMatchObject({ y: 0 });
    expect(gazeToward(origin, { x: 900, y: 500 }).x).toBeGreaterThan(0);
    expect(gazeToward(origin, { x: 100, y: 500 }).x).toBeLessThan(0);
    expect(gazeToward(origin, { x: 500, y: 100 }).y).toBeLessThan(0);
    expect(gazeToward(origin, { x: 500, y: 900 }).y).toBeGreaterThan(0);
  });

  it('looks straight ahead when the target is on top of it', () => {
    expect(gazeToward(origin, origin)).toEqual({ x: 0, y: 0 });
  });

  it('already moves visibly for a nearby pointer', () => {
    expect(gazeToward(origin, { x: 560, y: 500 }).x).toBeGreaterThan(0.3);
  });

  it('turns further the further away the target is, without ever leaving the eye', () => {
    const distances = [20, 60, 150, 400, 1200, 10_000];
    const turns = distances.map((d) => gazeToward(origin, { x: origin.x + d, y: origin.y }).x);

    expect(turns).toEqual([...turns].sort((a, b) => a - b));
    for (const turn of turns) expect(turn).toBeLessThanOrEqual(1);
    expect(turns.at(-1)).toBe(1);
  });

  it('keeps a diagonal look inside the eye on both axes', () => {
    const gaze = gazeToward(origin, { x: 5000, y: -5000 });

    expect(Math.abs(gaze.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(gaze.y)).toBeLessThanOrEqual(1);
  });
});

describe('easing toward a target', () => {
  it('gets closer every step and never overshoots', () => {
    let value = 0;
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      value = approach(value, 1, 14, 1 / 60);
      seen.push(value);
    }

    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(value).toBeGreaterThan(0.98);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('ends in the same place at 30 and 120 frames a second', () => {
    const run = (fps: number): number => {
      let value = 0;
      for (let i = 0; i < fps / 2; i++) value = approach(value, 1, 14, 1 / fps);
      return value;
    };

    expect(run(30)).toBeCloseTo(run(120), 6);
  });
});
