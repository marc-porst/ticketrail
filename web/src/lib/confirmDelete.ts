const KEY = 'pk:confirm-delete';

/**
 * Whether deleting a card asks first. Remembered in this browser only, like
 * the link question: it is how you like to work, not a board setting.
 */
export function shouldConfirmDelete(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setConfirmDelete(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    /* private window or storage blocked: it still asks, which is the safe side */
  }
}
