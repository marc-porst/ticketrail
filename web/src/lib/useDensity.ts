import { useCallback, useState } from 'react';

export type Density = 'comfortable' | 'compact';

const KEY = 'pk:density';

function load(): Density {
  try {
    return localStorage.getItem(KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/**
 * How much of each card the board shows. Compact cards are a single row, so a
 * long lane fits on screen without scrolling. Remembered in this browser only,
 * like collapsed folders: it is how you look at the board, not board state.
 */
export function useDensity() {
  const [density, setDensity] = useState<Density>(load);

  const set = useCallback((next: Density) => {
    setDensity(next);
    try {
      if (next === 'compact') localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      /* private window or storage blocked: it still works for this visit */
    }
  }, []);

  return [density, set] as const;
}

/** How many cards the Done lane shows before folding the older ones away. */
export const DONE_VISIBLE = 6;
