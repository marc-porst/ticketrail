const KEY = 'pk:confirm-link';

/**
 * Whether dropping a card on another card asks first. Remembered in this
 * browser only, like collapsed folders: it is how you like to work, not
 * something the board or Claude needs to know.
 */
export function shouldConfirmLink(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setConfirmLink(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    /* private window or storage blocked: it still asks, which is the safe side */
  }
}
