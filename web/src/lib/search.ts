import type { Task } from './types.ts';

/** Lower case, accents folded, so "uber" finds "Über". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** The words of a query; blank means no search at all. */
export function searchTerms(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/**
 * Whether a card matches the header search. Only the title and description
 * count, and every word has to appear somewhere in them, in any order.
 */
export function matchesSearch(task: Pick<Task, 'title' | 'description'>, terms: string[]): boolean {
  if (!terms.length) return true;
  const haystack = fold(`${task.title}\n${task.description ?? ''}`);
  return terms.every((term) => haystack.includes(term));
}
