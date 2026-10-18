/**
 * Fractional indexing over lowercase a-z, so a card can always be dropped
 * between two neighbours without renumbering the column.
 *
 * midString('', '')   -> 'n'      (first card)
 * midString('n', '')  -> 'u'      (append)
 * midString('', 'n')  -> 'g'      (prepend)
 * midString('a', 'b') -> 'an'     (squeeze between neighbours)
 */
const BEFORE_A = 96; // one before 'a'
const AFTER_Z = 123; // one after 'z'

export function midString(prev: string, next: string): string {
  let p = 0;
  let n = 0;
  let pos = 0;

  // walk to the first character where the two bounds differ
  for (pos = 0; p === n; pos++) {
    p = pos < prev.length ? prev.charCodeAt(pos) : BEFORE_A;
    n = pos < next.length ? next.charCodeAt(pos) : AFTER_Z;
  }

  let str = prev.slice(0, pos - 1);

  if (p === BEFORE_A) {
    // prev is a prefix of next: consume next's leading 'a's, which leave no gap
    while (n === 97) {
      n = pos < next.length ? next.charCodeAt(pos++) : AFTER_Z;
      str += 'a';
    }
    if (n === 98) {
      str += 'a';
      n = AFTER_Z;
    }
  } else if (p + 1 === n) {
    // the bounds are adjacent characters: extend prev and split the tail instead
    str += String.fromCharCode(p);
    n = AFTER_Z;
    while ((p = pos < prev.length ? prev.charCodeAt(pos++) : BEFORE_A) === 122) {
      str += 'z';
    }
  }

  return str + String.fromCharCode(Math.ceil((p + n) / 2));
}

export function orderBetween(prev?: string | null, next?: string | null): string {
  return midString(prev ?? '', next ?? '');
}

/** Order key that sorts before everything in `keys`. */
export function orderFirst(keys: string[]): string {
  const sorted = [...keys].sort();
  return orderBetween('', sorted[0] ?? '');
}

/** Order key that sorts after everything in `keys`. */
export function orderLast(keys: string[]): string {
  const sorted = [...keys].sort();
  return orderBetween(sorted[sorted.length - 1] ?? '', '');
}
