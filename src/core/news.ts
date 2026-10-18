import fs from 'node:fs';
import path from 'node:path';
import type { Store } from './store.ts';
import type { Task } from './task.ts';

/**
 * What the user added to a card while Claude was working it: chat notes and
 * files. A worker is only told once; the marker of what it has been told
 * lives in .runtime, so it never touches the card or its history.
 *
 * Answers to Claude's own questions are not news: `ask --wait` hands those
 * back directly.
 */
export interface News {
  messages: { at: string; text: string }[];
  files: { name: string; path: string; mime: string }[];
}

function markerFile(store: Store, taskId: string): string {
  return path.join(store.paths.runtime, 'seen', taskId);
}

/** Where "new" starts: the last time the worker was told, else the start of this run. */
function seenSince(store: Store, task: Task): string {
  let marker = '';
  try {
    marker = fs.readFileSync(markerFile(store, task.id), 'utf8').trim();
  } catch {
    /* never told yet */
  }
  const start = task.startedAt ?? task.createdAt;
  return marker && marker > start ? marker : start;
}

export function unseenNews(store: Store, task: Task): News {
  const since = seenSince(store, task);
  const answers = new Set(task.messages.map((m) => m.answeredBy).filter(Boolean));
  return {
    messages: task.messages
      .filter((m) => m.role === 'user' && m.at > since && !answers.has(m.id))
      .map((m) => ({ at: m.at, text: m.text })),
    files: task.attachments
      .filter((a) => a.addedBy === 'user' && a.addedAt > since)
      .map((a) => ({ name: a.name, path: store.filePath(a), mime: a.mime })),
  };
}

export function hasNews(news: News): boolean {
  return news.messages.length > 0 || news.files.length > 0;
}

/** Record that the worker has now been told everything up to this moment. */
export function markSeen(store: Store, task: Task): void {
  try {
    const file = markerFile(store, task.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Date().toISOString());
  } catch {
    /* best effort: at worst the worker hears the same note twice */
  }
}

/** The news as plain text, for commands whose output is a line rather than JSON. */
export function describeNews(news: News): string {
  const lines = ['NEW FROM THE USER while you work on this card. Take it into account before you go on:'];
  for (const m of news.messages) lines.push(`- message: ${m.text.replace(/\s*\n\s*/g, ' ')}`);
  for (const f of news.files) lines.push(`- file "${f.name}": ${f.path}  (open it)`);
  return lines.join('\n');
}
