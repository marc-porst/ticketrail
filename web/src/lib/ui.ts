import type { Column, FolderColor } from './types.ts';

export interface Accent {
  dot: string;
  text: string;
  bar: string;
  soft: string;
}

/** One accent per column, used for the header rule, the count pill and card cues. */
export const ACCENT: Record<Column, Accent> = {
  backlog: { dot: 'bg-slate-400', text: 'text-slate-300', bar: 'bg-slate-500/60', soft: 'bg-slate-400/10' },
  plan: { dot: 'bg-violet-400', text: 'text-violet-300', bar: 'bg-violet-500/70', soft: 'bg-violet-400/10' },
  'user-input': { dot: 'bg-amber-400', text: 'text-amber-300', bar: 'bg-amber-500/70', soft: 'bg-amber-400/10' },
  implement: { dot: 'bg-sky-400', text: 'text-sky-300', bar: 'bg-sky-500/70', soft: 'bg-sky-400/10' },
  'in-progress': { dot: 'bg-emerald-400', text: 'text-emerald-300', bar: 'bg-emerald-500/70', soft: 'bg-emerald-400/10' },
  planned: { dot: 'bg-indigo-400', text: 'text-indigo-300', bar: 'bg-indigo-500/70', soft: 'bg-indigo-400/10' },
  done: { dot: 'bg-zinc-500', text: 'text-zinc-400', bar: 'bg-zinc-600/70', soft: 'bg-zinc-500/10' },
};

/**
 * Labels are free text, so their colour is derived from the string rather than
 * stored: the same label is the same colour on every board without a registry
 * to keep in sync. The classes must be written out literally -- Tailwind only
 * emits CSS for class names it can see at build time.
 */
const LABEL_TONES = [
  'bg-rose-400/12 text-rose-300',
  'bg-amber-400/12 text-amber-300',
  'bg-lime-400/12 text-lime-300',
  'bg-emerald-400/12 text-emerald-300',
  'bg-teal-400/12 text-teal-300',
  'bg-sky-400/12 text-sky-300',
  'bg-violet-400/12 text-violet-300',
  'bg-fuchsia-400/12 text-fuchsia-300',
];

/** Folder colours, written out literally for the same Tailwind reason as above. */
export const FOLDER_TONE: Record<FolderColor, { dot: string; rail: string; text: string }> = {
  slate: { dot: 'bg-slate-400', rail: 'border-slate-500/40', text: 'text-slate-300' },
  rose: { dot: 'bg-rose-400', rail: 'border-rose-400/40', text: 'text-rose-300' },
  amber: { dot: 'bg-amber-400', rail: 'border-amber-400/40', text: 'text-amber-300' },
  lime: { dot: 'bg-lime-400', rail: 'border-lime-400/40', text: 'text-lime-300' },
  emerald: { dot: 'bg-emerald-400', rail: 'border-emerald-400/40', text: 'text-emerald-300' },
  sky: { dot: 'bg-sky-400', rail: 'border-sky-400/40', text: 'text-sky-300' },
  violet: { dot: 'bg-violet-400', rail: 'border-violet-400/40', text: 'text-violet-300' },
  fuchsia: { dot: 'bg-fuchsia-400', rail: 'border-fuchsia-400/40', text: 'text-fuchsia-300' },
};

export function labelTone(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return LABEL_TONES[hash % LABEL_TONES.length];
}

export function cx(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function mergeRefs<T>(...refs: ((node: T | null) => void)[]) {
  return (node: T | null) => {
    for (const ref of refs) ref(node);
  };
}
