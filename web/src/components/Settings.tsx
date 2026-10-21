import { useEffect, useRef, useState } from 'react';
import { cx } from '../lib/ui.ts';
import { notificationPermission, requestNotificationPermission, type Permission } from '../lib/notify.ts';
import type { NotificationSettings } from '../lib/types.ts';

export function Settings({
  settings,
  onChange,
  confirmLinks,
  onConfirmLinksChange,
}: {
  settings: NotificationSettings;
  onChange: (changes: Partial<NotificationSettings>) => void;
  /** Ask before a drop links two cards. Kept in this browser, not in config.json. */
  confirmLinks?: boolean;
  onConfirmLinksChange?: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState<Permission>(() => notificationPermission());
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setPermission(notificationPermission());
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const muted = !settings.sound && !settings.desktop;

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Settings"
        title={muted ? 'Alerts are off' : 'Settings'}
        className="rounded-md p-1.5 text-zinc-500 transition hover:bg-white/5 hover:text-zinc-200"
      >
        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="2.2" />
          <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4" strokeLinecap="round" />
        </svg>
        {muted && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-zinc-600" />}
      </button>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-1.5 w-[300px] overflow-hidden rounded-xl border border-white/[0.08] bg-[var(--color-surface-2)] pk-panel">
          <p className="border-b border-[var(--color-line)] px-3 py-2 text-[10.5px] font-semibold tracking-wide text-zinc-500 uppercase">
            Alerts
          </p>

          <div className="p-1.5">
            <Toggle
              label="Sound"
              hint="A short chime when a card moves"
              checked={settings.sound}
              onChange={(sound) => onChange({ sound })}
            />
            <Toggle
              label="Desktop notifications"
              hint="Only while this tab is in the background"
              checked={settings.desktop}
              onChange={(desktop) => onChange({ desktop })}
            />
            <Toggle
              label="Also when Claude starts a card"
              hint="Off by default — it fires on every pickup"
              checked={settings.onStart}
              onChange={(onStart) => onChange({ onStart })}
            />
          </div>

          {settings.desktop && permission !== 'granted' && (
            <div className="border-t border-[var(--color-line)] px-3 py-2.5">
              {permission === 'default' && (
                <button
                  onClick={async () => setPermission(await requestNotificationPermission())}
                  className="rounded-md bg-sky-500 px-2.5 py-1 text-[11.5px] font-medium text-sky-950 hover:bg-sky-400"
                >
                  Allow notifications
                </button>
              )}
              {permission === 'denied' && (
                <p className="text-[11px] leading-relaxed text-amber-300/80">
                  Your browser blocked notifications for this site. A page cannot ask again — re-allow it in the
                  browser's site settings.
                </p>
              )}
              {permission === 'unsupported' && (
                <p className="text-[11px] text-zinc-600">This browser has no notification support.</p>
              )}
            </div>
          )}

          {onConfirmLinksChange && (
            <>
              <p className="border-t border-b border-[var(--color-line)] px-3 py-2 text-[10.5px] font-semibold tracking-wide text-zinc-500 uppercase">
                Board
              </p>
              <div className="p-1.5">
                <Toggle
                  label="Ask before linking cards"
                  hint="When a card is dropped on another card. This browser only"
                  checked={confirmLinks ?? true}
                  onChange={onConfirmLinksChange}
                />
              </div>
            </>
          )}

          <p className="border-t border-[var(--color-line)] px-3 py-2 text-[10.5px] leading-relaxed text-zinc-600">
            Alerts are saved in <code className="rounded bg-black/40 px-1 text-zinc-500">.ticketrail/config.json</code>, so they
            apply to this board everywhere.
          </p>
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-white/5"
    >
      <span
        className={cx(
          'mt-0.5 flex h-4 w-7 shrink-0 items-center rounded-full p-0.5 transition',
          checked ? 'bg-sky-500' : 'bg-zinc-700',
        )}
      >
        <span className={cx('size-3 rounded-full bg-white transition', checked && 'translate-x-3')} />
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] text-zinc-200">{label}</span>
        <span className="block text-[10.5px] leading-snug text-zinc-600">{hint}</span>
      </span>
    </button>
  );
}
