import {SCRIPT_FOLD_WORD_PAIRS,SCRIPT_MATCH_WORD_PAIRS} from './script-fold-words.ts';
import {SCRIPT_FOLD_PAIRS} from './script-fold-data.ts';

// Built once. Source text, persisted labels and prompt bodies must never use this map.
const characters: ReadonlyMap<string, string> = new Map(SCRIPT_FOLD_PAIRS);
const matchWords: ReadonlyMap<string, string> = new Map(SCRIPT_MATCH_WORD_PAIRS);
const words: ReadonlyMap<string, string> = new Map(SCRIPT_FOLD_WORD_PAIRS.map(([from, to]) =>
  [[...from].map(foldedCharacter).join(''), to]));

/** One code point and one UTF-16 width in, one out. No NFKC, case or whitespace changes. */
function foldedCharacter(character: string): string {
  const code = character.codePointAt(0)!;
  if (code >= 0xff10 && code <= 0xff19 || code >= 0xff21 && code <= 0xff3a || code >= 0xff41 && code <= 0xff5a || code === 0xff1a)
    return String.fromCodePoint(code - 0xfee0);
  return characters.get(character) ?? character;
}

/** O(n) time and space; visits every code point once, without normalizing the source. */
function characterFoldWork(text: string): {text: string; visited: number} {
  const parts: string[] = [];
  let visited = 0;
  for (const character of text) { parts.push(foldedCharacter(character)); visited++; }
  return {text: parts.join(''), visited};
}

/** O(n) fixed-width lookups. The key source may be raw text or a character-folded copy. */
function wordFoldWork(copy: string, keys: string, table: ReadonlyMap<string, string>): {text: string; wordVisits: number} {
  const result: string[] = [];
  let wordVisits = 0;
  // Fixed two-unit lookup at every position: O(n), preserving all source offsets.
  for (let at = 0; at < copy.length; at++) {
    wordVisits++;
    const word = table.get(keys.slice(at, at + 2));
    if (word !== undefined) { result.push(word); at++; }
    else result.push(copy[at]!);
  }
  return {text: result.join(''), wordVisits};
}

/** O(n) time and space. Lexical matching uses only the original Traditional spellings. */
export function scriptFoldWork(text: string): {text: string; visited: number; wordVisits: number} {
  const copy = characterFoldWork(text);
  return {...wordFoldWork(copy.text, text, matchWords), visited: copy.visited};
}

/** A disposable matching copy. UTF-16 match indices can be used to slice the unchanged source. */
export function foldForMatch(text: string): string { return scriptFoldWork(text).text; }

export interface ScriptQuoteMatch {start: number; end: number; quote: string}

/**
 * KMP comparisons: O(source.length + quote.length), including overlapping matches.
 * Materialized source slices additionally cost their total returned length; a fixed limit stays linear.
 * Empty quotes retain String#indexOf's first-boundary behavior. Returned text is always a source slice.
 */
export function scriptQuoteSearch(source: string, quote: string, limit = 1): {matches: ScriptQuoteMatch[]; work: number} {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid_script_quote_limit');
  const exact = quoteSearch(source, quote, source, limit);
  if (exact.matches.length) return exact;
  const body = characterFoldWork(source), needle = characterFoldWork(quote);
  const folded = quoteSearch(body.text, needle.text, source, limit);
  const work = exact.work + body.visited + needle.visited + folded.work;
  if (folded.matches.length) return {matches: folded.matches, work};
  const wordBody = wordFoldWork(body.text, body.text, words), wordNeedle = wordFoldWork(needle.text, needle.text, words);
  const lexical = quoteSearch(wordBody.text, wordNeedle.text, source, limit);
  return {matches: lexical.matches, work: work + wordBody.wordVisits + wordNeedle.wordVisits + lexical.work};
}

function quoteSearch(haystack: string, needle: string, source: string, limit: number): {matches: ScriptQuoteMatch[]; work: number} {
  const quote = needle, matches: ScriptQuoteMatch[] = [];
  let work = source.length + quote.length;
  if (needle.length === 0) return {matches: [{start: 0, end: 0, quote: ''}], work};
  const failure = new Array<number>(needle.length).fill(0);
  for (let i = 1, j = 0; i < needle.length; i++) {
    while (j > 0 && needle[i] !== needle[j]) { j = failure[j - 1]!; work++; }
    work++;
    if (needle[i] === needle[j]) j++;
    failure[i] = j;
  }
  for (let i = 0, j = 0; i < haystack.length; i++) {
    while (j > 0 && haystack[i] !== needle[j]) { j = failure[j - 1]!; work++; }
    work++;
    if (haystack[i] === needle[j]) j++;
    if (j === needle.length) {
      const start = i + 1 - j, end = i + 1;
      matches.push({start, end, quote: source.slice(start, end)});
      if (matches.length >= limit) break;
      j = failure[j - 1]!;
    }
  }
  return {matches, work};
}

/** Exact spelling takes priority; only absent literal quotes use script-equivalent source slices. */
export function sourceQuote(source: string, quote: string): string | null {
  return scriptQuoteSearch(source, quote).matches[0]?.quote ?? null;
}

export function includesForMatch(source: string, quote: string): boolean { return sourceQuote(source, quote) !== null; }
