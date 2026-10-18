import { describe, expect, it } from 'vitest';
import { midString, orderBetween, orderFirst, orderLast } from '../src/core/order.ts';

describe('fractional ordering', () => {
  it('produces a key between two neighbours', () => {
    expect(midString('a', 'b') > 'a').toBe(true);
    expect(midString('a', 'b') < 'b').toBe(true);
  });

  it('handles the open ends', () => {
    expect(midString('', '') > '').toBe(true);
    expect(midString('n', '') > 'n').toBe(true);
    expect(midString('', 'n') < 'n').toBe(true);
  });

  it('survives repeated squeezing between two adjacent keys', () => {
    let low = 'a';
    let high = 'b';
    for (let i = 0; i < 60; i++) {
      const mid = midString(low, high);
      expect(mid > low, `${mid} > ${low}`).toBe(true);
      expect(mid < high, `${mid} < ${high}`).toBe(true);
      high = mid; // always insert just above the low bound: the worst case
    }
  });

  it('keeps a dragged card ordered against its real neighbours', () => {
    const keys = ['a', 'b', 'c'].map((_, i, arr) => orderBetween(arr[i - 1], arr[i + 1]));
    expect([...keys].sort()).toEqual(keys);
  });

  it('places keys before and after a column', () => {
    const keys = ['g', 'n', 'u'];
    expect(orderFirst(keys) < 'g').toBe(true);
    expect(orderLast(keys) > 'u').toBe(true);
  });
});
