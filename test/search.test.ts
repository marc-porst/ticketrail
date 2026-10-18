import { describe, expect, it } from 'vitest';
import { matchesSearch, searchTerms } from '../web/src/lib/search.ts';

const card = (title: string, description = '') => ({ title, description });

describe('card search', () => {
  it('matches every word, in any order, across title and description', () => {
    const terms = searchTerms('  middleware AUTH ');
    expect(terms).toEqual(['middleware', 'auth']);
    expect(matchesSearch(card('Extract the auth middleware'), terms)).toBe(true);
    expect(matchesSearch(card('Auth', 'move it into a middleware'), terms)).toBe(true);
    expect(matchesSearch(card('Extract the auth layer'), terms)).toBe(false);
  });

  it('ignores case and accents', () => {
    expect(matchesSearch(card('Über die Grenze'), searchTerms('uber'))).toBe(true);
    expect(matchesSearch(card('cafe menu'), searchTerms('CAFÉ'))).toBe(true);
  });

  it('only looks at the title and the description', () => {
    const task = { ...card('Plain title', 'plain body'), labels: ['urgent'], result: 'secret result' } as any;
    expect(matchesSearch(task, searchTerms('urgent'))).toBe(false);
    expect(matchesSearch(task, searchTerms('secret'))).toBe(false);
  });

  it('matches everything when the query is blank', () => {
    expect(matchesSearch(card('anything'), searchTerms('   '))).toBe(true);
  });
});
