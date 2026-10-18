export type Permission = NotificationPermission | 'unsupported';

export function notificationPermission(): Permission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** Must be called from a click: browsers ignore a request made on load. */
export async function requestNotificationPermission(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface NotifyOptions {
  title: string;
  body: string;
  /** Re-uses one slot per card, so a card that moves twice replaces itself. */
  tag: string;
  onClick?: () => void;
}

/**
 * Only fires when the tab is hidden. With the board on screen you can already
 * see the card move, and a banner on top of it is just noise.
 */
export function showNotification({ title, body, tag, onClick }: NotifyOptions): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  if (typeof document !== 'undefined' && !document.hidden) return false;

  try {
    const notification = new Notification(title, { body, tag, icon: '/favicon.ico' });
    notification.onclick = () => {
      window.focus();
      notification.close();
      onClick?.();
    };
    return true;
  } catch {
    return false;
  }
}
