import type {Memory} from './access.ts';
import {FRAGMENT_BANDS, FRAGMENT_TOTAL_RATIO, isLegacyTemplate, sharedRuns} from './retention.ts';
import {compact, units, scriptOf, wordsOf, codeTokenRanges, numericRanges, mappedText} from './text-units.ts';
import {foldCue} from './trace.ts';
import {scanAmounts} from '../common/amount-expressions.ts';

/** Planned minimum per clause, in units() for its script. */
export const DETAIL_CLAUSE_MIN = Object.freeze({zh: 4, en: 3});
/** Maximum candidates returned for one record, not for a chat. */
export const DETAIL_CANDIDATE_LIMIT = 8;
/** Planned lower distance boundary; equality is eligible. */
export const DETAIL_RESTATE_DISTANCE = 0.15;
/** Maximum newly selected details for one record; valid window items may already exceed its current budget. */
export const DETAIL_SHOWN_MAX = 3;
/** Planned share. The low seed bit implements this value only. */
export const DETAIL_RANDOM_SHARE = 0.5;
export const DETAIL_NOVEL_MIN = 3;
export const DETAIL_CONTENT_MIN = Object.freeze({zh: 4, en: 3});

/** Maximum raw and NFKC-lowercase UTF-16 units in one record's detail. */
export const DETAIL_RAW_LIMIT = 4_000;
/** Maximum raw and NFKC-lowercase UTF-16 units in one displayed gist. */
export const DETAIL_GIST_RAW_LIMIT = 1_000;
/** Maximum raw and NFKC-lowercase UTF-16 units in one displayed feeling. */
export const DETAIL_FEELING_RAW_LIMIT = 500;
/** Maximum raw and NFKC-lowercase UTF-16 units in one displayed anchor. */
export const DETAIL_ANCHOR_RAW_LIMIT = 500;
/** Maximum raw and NFKC-lowercase UTF-16 units in one emotional protection basis quote. */
export const DETAIL_BASIS_RAW_LIMIT = 1_000;
/** Maximum protected values supplied for filtering one record. */
export const DETAIL_PROTECTED_LIMIT = 10;
/** Maximum raw and NFKC-lowercase UTF-16 units in each protected value. */
export const DETAIL_PROTECTED_ITEM_LIMIT = 1_000;
/** Maximum combined raw UTF-16 units; implied by the protected count and per-item limits. */
export const DETAIL_PROTECTED_RAW_LIMIT = 10_000;
/** Maximum displayed fragments supplied for filtering one record. */
export const DETAIL_FRAGMENT_LIMIT = 4;
/** Maximum raw and NFKC-lowercase UTF-16 units in each displayed fragment. */
export const DETAIL_FRAGMENT_ITEM_LIMIT = 500;
/** Maximum combined raw UTF-16 units; implied by the fragment count and per-item limits. */
export const DETAIL_FRAGMENT_RAW_LIMIT = 2_000;
/** Maximum raw and NFKC-lowercase UTF-16 units in each inspected stored scene/sensory item. */
export const DETAIL_STORED_ITEM_LIMIT = 500;
/** Maximum combined raw and NFKC-lowercase units across the inspected stored prefix of one record. */
export const DETAIL_STORED_TOTAL_LIMIT = 6_500;
/** Maximum stored scene/sensory slots inspected per pool build; later slots are not read. */
export const DETAIL_STORED_SCAN_LIMIT = 64;
/** Maximum cue slots inspected per selection; later slots are not read. */
export const DETAIL_CUE_SCAN_LIMIT = 64;
/** Maximum raw UTF-16 units per selection cue; longer cues are skipped whole. */
export const DETAIL_CUE_RAW_LIMIT = 1_000;

// These local values must stay equal to the copy guard's private values.
const ZH_FACT_RUN = 6;
const EN_FACT_WORDS = 3;
/** Maximum raw UTF-16 units per candidate, before trimming, not the whole detail. */
const FRAGMENT_RAW_LIMIT = 1000;
const PAIRS = new Map([['“','”'],['‘','’'],['「','」'],['『','』'],['（','）'],['(',')'],['【','】'],['《','》'],['[',']'],['"','"'],["'","'"]]);
const RESIDUAL_BOUNDARY = /[，,;；:：。．.!！?？…\n]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PERSON = new Set('我你妳您他她它咱');
const EN_YOU = new Set(['you','your','yours','yourself']);
const EN_PERSON = new Set(['i','me','my','mine','you','your','yours','he','him','his','she','her','hers','it','its','we','us','our','ours','they','them','their','theirs']);

export interface DetailCandidate {start: number; end: number; text: string; source: 'stored' | 'clause'}
export interface DetailPosition {start: number; end: number; stray?: boolean | null}
export interface ShownDetail extends DetailCandidate {stray: boolean; new: boolean}
export interface DetailLayer {text: string; state: 'visible' | 'masked' | 'blocked'}
export interface DetailPoolInput {
  memory: Memory;
  gist: DetailLayer;
  feeling?: DetailLayer | null;
  anchor?: DetailLayer | null;
  fragments?: readonly string[] | null;
}
/** Deterministic counts of local loops and the cells passed to sharedRuns; not elapsed time. */
export interface DetailWork {
  split: number; novelty: number; pronouns: number; sharedIndex: number;
  sharedProbe: number; sharedCells: number; substring: number; candidates: number;
  validation: number; helpers: number; local: number; protection: number; encoding: number;
}
export interface DetailPool {candidates: DetailCandidate[]; work: DetailWork}
export interface DetailSelectionInput {
  pool: readonly DetailCandidate[];
  distances?: readonly number[] | null;
  seed: number;
  cueRecall?: boolean | null;
  matchedCueFolds?: readonly string[] | null;
  previous?: readonly DetailPosition[] | null;
  fragmentCompactLength: number;
  detailCompactLength: number;
}
export interface DetailSelection {
  items: ShownDetail[];
  candidateCount: number;
  budget: number;
  mode: 'fresh' | 'fallback' | 'window' | 'empty';
}
export interface DetailRevalidationInput {
  positions: readonly DetailPosition[];
  pool: readonly DetailCandidate[];
  fragmentCompactLength: number;
  detailCompactLength: number;
}

const workOf = (): DetailWork => ({split: 0, novelty: 0, pronouns: 0, sharedIndex: 0, sharedProbe: 0, sharedCells: 0, substring: 0, candidates: 0, validation: 16, helpers: 0, local: 0, protection: 0, encoding: 0});
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
// Even a naive substring search takes at most (a+1)(b+1) comparisons; no engine-specific guarantee is needed.
const containsEither = (a: string, b: string, work: DetailWork) => {
  work.local += 4 * (a.length + 1) * (b.length + 1);
  return a.includes(b) || b.includes(a);
};
const positionKey = (item: {start: number; end: number}) => `${item.start}:${item.end}`;
const wordKeys = (text: string) => wordsOf(text.normalize('NFKC').toLowerCase()).map(item => item.word);

// Unicode NFKC expands a code point by at most 18 units, and lowercase by at most 3.
// Charges include allocation/copy passes, not just the explicit loops. Cache hits are charged too.
const FOLD_WORK = 1 + 3 * 54;
const textWork = (text: string, work: DetailWork, passes = 1) => {work.helpers += passes * FOLD_WORK * text.length;};
function foldedSize(text: string, limit: number, work: DetailWork): number {
  work.validation++;
  if (text.length > limit) return -1;
  textWork(text, work);
  const length = text.normalize('NFKC').toLowerCase().length;
  return length <= limit ? length : -1;
}
const foldedWithin = (text: string, limit: number, work: DetailWork) => foldedSize(text, limit, work) >= 0;

/** KMP: at most two character comparisons per haystack unit, including failed prefixes. */
class Pattern {
  key: string;
  failure: Uint32Array;
  work: DetailWork;
  constructor(key: string, work: DetailWork) {
    this.key = key; this.work = work; this.failure = new Uint32Array(key.length);
    work.substring += key.length;
    for (let i = 1, j = 0; i < key.length; i++) {
      while (j && key[i] !== key[j]) {work.substring++; j = this.failure[j - 1]!;}
      work.substring++; if (key[i] === key[j]) j++;
      this.failure[i] = j;
    }
  }
  contains(text: string, boundary?: (start: number, end: number) => boolean): boolean {
    const key = this.key;
    for (let i = 0, j = 0; i < text.length; i++) {
      while (j && text[i] !== key[j]) {this.work.substring++; j = this.failure[j - 1]!;}
      this.work.substring++;
      if (text[i] === key[j]) j++;
      if (j === key.length) {
        if (!boundary || boundary(i + 1 - j, i + 1)) return true;
        j = this.failure[j - 1]!;
      }
    }
    return false;
  }
}

/** Fixed six-character / three-word windows are built once per record, never per clause. */
class ProtectionIndex {
  exact: {pattern: Pattern; han: boolean}[] = [];
  hanRuns = new Set<string>();
  enRuns = new Set<string>();
  work: DetailWork;
  constructor(facts: string[], work: DetailWork) {
    this.work = work;
    for (const fact of facts) {
      textWork(fact, work, 5); // compact, mappedText, scriptOf, wordsOf and per-word folding.
      const key = compact(fact), mapped = mappedText(fact, {dropPunctuation: true}).text;
      work.protection += 1 + key.length + mapped.length;
      if (key.length < 2 || mapped.length < 2) continue;
      const han = scriptOf(fact) === 'zh', needles = mapped === key ? [mapped] : [mapped, key];
      for (const needle of needles) {
        this.exact.push({pattern: new Pattern(needle, work), han});
        if (han) {
          const chars = [...needle]; work.protection += needle.length;
          for (let i = 0; i + ZH_FACT_RUN <= chars.length; i++) {
            work.protection += 2 * ZH_FACT_RUN;
            this.hanRuns.add(chars.slice(i, i + ZH_FACT_RUN).join(''));
          }
        }
      }
      if (!han) {
        const words = wordsOf(fact).map(item => item.word.normalize('NFKC').toLowerCase());
        for (let i = 0; i + EN_FACT_WORDS <= words.length; i++) {
          const window = words.slice(i, i + EN_FACT_WORDS);
          work.protection += 2 * (EN_FACT_WORDS + window.join('').length);
          this.enRuns.add(JSON.stringify(window));
        }
      }
    }
  }
  hits(text: string): boolean {
    const work = this.work;
    if (!this.exact.length) return false;
    textWork(text, work, 3); // mappedText, wordsOf and per-word folding.
    const loose = mappedText(text, {dropPunctuation: true});
    // A Latin/number followed by marks is still a word end, just as the copy guard's regex specifies.
    const wordEnd = new Uint8Array(text.length + 1), wordStart = new Uint8Array(text.length + 1);
    let last = false;
    for (let at = 0; at < text.length;) {
      const char = String.fromCodePoint(text.codePointAt(at)!);
      if (!/\p{M}/u.test(char)) last = /[\p{Script=Latin}\p{N}]/u.test(char);
      wordStart[at] = /[\p{Script=Latin}\p{N}]/u.test(char) ? 1 : 0;
      at += char.length; wordEnd[at] = last ? 1 : 0; work.protection += 4;
    }
    for (const {pattern, han} of this.exact) {
      work.protection++;
      if (pattern.contains(loose.text, han ? undefined : (from, to) => {
        work.protection += 3;
        return !wordEnd[loose.start[from]!] && !wordStart[loose.end[to - 1]!];
      })) return true;
    }
    const chars = [...loose.text]; work.protection += loose.text.length;
    if (this.hanRuns.size) for (let i = 0; i + ZH_FACT_RUN <= chars.length; i++) {
      work.protection += 2 * ZH_FACT_RUN;
      if (this.hanRuns.has(chars.slice(i, i + ZH_FACT_RUN).join(''))) return true;
    }
    if (this.enRuns.size) {
      const words = wordsOf(text).map(item => item.word.normalize('NFKC').toLowerCase());
      for (let i = 0; i + EN_FACT_WORDS <= words.length; i++) {
        const window = words.slice(i, i + EN_FACT_WORDS);
        work.protection += 2 * (EN_FACT_WORDS + window.join('').length);
        if (this.enRuns.has(JSON.stringify(window))) return true;
      }
    }
    return false;
  }
}

function strings(value: unknown, maxCount: number, maxUnits: number, work: DetailWork): string[] {
  work.validation += 4;
  if (!Array.isArray(value)) throw new Error('invalid_strings');
  const length = value.length, result: string[] = [];
  if (!integer(length) || length > maxCount) throw new Error('invalid_length');
  let total = 0;
  for (let i = 0; i < length; i++) {
    work.validation += 4;
    const item = value[i];
    if (typeof item !== 'string') throw new Error('invalid_string');
    total += item.length;
    if (total > maxUnits) throw new Error('invalid_strings_length');
    result.push(item);
  }
  return result;
}

function layerText(value: unknown, maxUnits: number, work: DetailWork, required = false): string {
  if (value == null && !required) return '';
  if (!object(value)) throw new Error('invalid_layer');
  const text = value.text, state = value.state;
  if (typeof text !== 'string' || !foldedWithin(text, maxUnits, work) || !['visible','masked','blocked'].includes(state as string)) throw new Error('invalid_layer');
  return state === 'blocked' ? '' : text;
}

interface TextNode {next: Map<string | null, number>; link: number; length: number; end: number}
/**
 * A suffix automaton gives first verbatim positions and substring membership without rescanning the detail
 * for every stored item. Construction and queries are linear in text units (amortized Map operations).
 * A null separator between accepted strings cannot occur in a string, so matches never cross items.
 */
class TextIndex {
  nodes: TextNode[] = [{next: new Map(), link: -1, length: 0, end: 0}];
  last = 0;
  offset = 0;
  work: DetailWork;
  constructor(work: DetailWork) {this.work = work;}
  append(text: string, separated = false): void {
    for (const char of text) this.push(char, char.length);
    if (separated) this.push(null, 1);
  }
  push(char: string | null, width: number): void {
    this.work.substring++;
    this.offset += width;
    const current = this.nodes.length;
    this.nodes.push({next: new Map(), link: 0, length: this.nodes[this.last]!.length + 1, end: this.offset});
    let p = this.last;
    while (p >= 0 && !this.nodes[p]!.next.has(char)) {
      this.work.substring++;
      this.nodes[p]!.next.set(char, current); p = this.nodes[p]!.link;
    }
    if (p >= 0) {
      const q = this.nodes[p]!.next.get(char)!;
      if (this.nodes[p]!.length + 1 === this.nodes[q]!.length) this.nodes[current]!.link = q;
      else {
        const clone = this.nodes.length, node = this.nodes[q]!;
        this.work.substring += node.next.size;
        this.nodes.push({...node, next: new Map(node.next), length: this.nodes[p]!.length + 1});
        while (p >= 0 && this.nodes[p]!.next.get(char) === q) {
          this.work.substring++;
          this.nodes[p]!.next.set(char, clone); p = this.nodes[p]!.link;
        }
        node.link = clone; this.nodes[current]!.link = clone;
      }
    }
    this.last = current;
  }
  find(text: string): number {
    let at = 0;
    for (const char of text) {
      this.work.substring++;
      const next = this.nodes[at]!.next.get(char);
      if (next === undefined) return -1;
      at = next;
    }
    return this.nodes[at]!.end - text.length;
  }
}

/**
 * Forward containment uses the suffix automaton; reverse containment uses code-point KMP. For C keys with
 * total length K, at most 4(C+1)K comparisons plus linear index construction, C <= floor(d/4)+65 <= 1065.
 */
class AcceptedIndex {
  text: TextIndex;
  patterns: {symbols: Uint32Array; failure: Uint32Array}[] = [];
  pending = new Uint32Array();
  work: DetailWork;
  constructor(work: DetailWork) {this.work = work; this.text = new TextIndex(work);}
  overlaps(key: string): boolean {
    if (this.text.find(key) >= 0) return true;
    const symbols = Uint32Array.from(key, char => char.codePointAt(0)!);
    this.work.encoding += 3 * key.length;
    this.pending = symbols;
    for (const pattern of this.patterns) {
      this.work.substring++;
      if (pattern.symbols.length > symbols.length) continue;
      for (let i = 0, j = 0; i < symbols.length; i++) {
        while (j && symbols[i] !== pattern.symbols[j]) {this.work.substring++; j = pattern.failure[j - 1]!;}
        this.work.substring += 2;
        if (symbols[i] === pattern.symbols[j]) j++;
        if (j === pattern.symbols.length) return true;
      }
    }
    return false;
  }
  add(key: string): void {
    this.work.substring++;
    this.text.append(key, true);
    const symbols = this.pending, failure = new Uint32Array(symbols.length);
    this.work.substring += symbols.length;
    for (let i = 1, j = 0; i < symbols.length; i++) {
      while (j && symbols[i] !== symbols[j]) {this.work.substring++; j = failure[j - 1]!;}
      this.work.substring += 2;
      if (symbols[i] === symbols[j]) j++;
      failure[i] = j;
    }
    this.patterns.push({symbols, failure});
  }
}

function paired(text: string): boolean {
  const stack: string[] = [], closing = new Set(PAIRS.values());
  for (const char of text) {
    if (char === "'" || (char === '’' && stack.at(-1) !== '’')) continue;
    if (stack.at(-1) === char) {stack.pop(); continue;}
    const close = PAIRS.get(char);
    // Curly single opening quotes still need a partner, even though a lone apostrophe is allowed.
    if (char === '‘') {stack.push('’'); continue;}
    if (close !== undefined) stack.push(close);
    else if (closing.has(char)) return false;
  }
  return stack.length === 0;
}

/** Fixed-size windows index the gist once: O(g). No joined words can collide across a boundary. */
function runIndex(tokens: string[], size: number, han: boolean, work: DetailWork): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    work.sharedIndex++;
    const window = tokens.slice(i, i + size);
    work.local += 2 * (size + window.join('').length);
    if (window.length === size && (!han || window.every(char => CJK.test(char)))) result.add(JSON.stringify(window));
  }
  return result;
}

/**
 * sharedRuns itself visits left.length * right.length cells. Only a matching fixed-size gist window is
 * passed as left; right is one raw-bounded candidate. Total local probing is O(g + sum(candidate lengths)).
 */
function restates(tokens: string[], index: Set<string>, size: number, work: DetailWork): boolean {
  if (!index.size) return false;
  for (let i = 0; i + size <= tokens.length; i++) {
    work.sharedProbe++;
    const window = tokens.slice(i, i + size);
    work.local += 2 * (size + window.join('').length);
    if (!index.has(JSON.stringify(window))) continue;
    work.sharedCells += window.length * tokens.length;
    work.helpers += 4 * window.length * tokens.length + (window.length + 1) * (tokens.length + 1);
    return sharedRuns(window, tokens, size, false).length > 0;
  }
  return false;
}

/** O(candidate length), with gist membership precomputed; repeated new tokens count once. */
function novel(tokens: string[], known: Set<string>, han: boolean, work: DetailWork): boolean {
  const different = new Set<string>();
  for (const token of tokens) {
    work.novelty++;
    if ((!han || CJK.test(token)) && !known.has(token)) different.add(token);
  }
  return different.size >= DETAIL_NOVEL_MIN;
}

/** O(candidate length); only the specified pronouns and their immediately following plural suffix are removed. */
function clauseContent(text: string, han: boolean, user: boolean, work: DetailWork): boolean {
  if (!han) {
    const words = wordKeys(text);
    let count = 0, addressed = false;
    for (const word of words) {
      work.pronouns++;
      // Apostrophes bound pronoun halves; a remaining contraction/possessive is still one wordsOf token.
      const parts = word.split(/['’]/u);
      if (parts.some(part => EN_YOU.has(part))) addressed = true;
      if (parts.some(part => part && !EN_PERSON.has(part))) count++;
    }
    return !(user && addressed) && count >= DETAIL_CONTENT_MIN.en;
  }
  const chars = [...text];
  let count = 0, addressed = false;
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!; work.pronouns++;
    if ('你妳您'.includes(char)) addressed = true;
    if (PERSON.has(char)) {
      if (chars[i + 1] === '们' || chars[i + 1] === '們') {i++; work.pronouns++;}
    } else if (CJK.test(char)) count++;
  }
  return !(user && addressed) && count >= DETAIL_CONTENT_MIN.zh;
}

/**
 * One record per call. Splitting is O(detail.length); each UTF-16 unit is visited once, trim/slice totals O(d).
 * Protected six-character/three-word runs are indexed once in O(f); whole-value comparisons are linear KMP
 * with at most twenty needles. Deduplication is O(c*K), K total candidate-key units, c <= floor(dFolded/4)+65.
 * Other containment has a conservative O(K*v) bound, v <= 5000 supplied layer/evidence/fragment units;
 * K <= 10500 across the detail and inspected stored prefix. Both raw and folded inputs are
 * bounded; oversize empties the pool, without truncation. The sixty-four stored slots are a bounded prefix.
 * Work charges every helper's cold upper bound, even on cache hits: folds use at most 54 emitted units per
 * raw unit, token sorting adds ceil(log2(1+54*n)) passes; sharedRuns includes table initialization and ranges.
 * Whole-detail and protected copies are checked directly. Rule four rejects raw code spans; dotted-I folds
 * additionally check source digit codes in lowercase mapped text, using one lazy source index and linear KMP.
 * The exported legacy-template predicate is charged for trim/hash. No guard result cache is populated.
 * scanAmounts uses 256 folded passes.
 * No source/chat-size cutoff. Selection and revalidation retain their existing independent input limits.
 * Only consumed record fields are validated; unrelated metadata is not inspected. Any throwing read empties the pool.
 */
export function buildRecallDetailPool(input: DetailPoolInput): DetailPool {
  const work = workOf();
  work.validation++;
  try {
    const memory = input.memory;
    if (!object(memory)) return {candidates: [], work};
    const detail = memory.detail, override = memory.accessOverride, source = memory.source;
    work.validation += 6;
    if (typeof detail !== 'string' || !foldedWithin(detail, DETAIL_RAW_LIMIT, work) || (override != null && typeof override !== 'boolean') || override || !object(source)) return {candidates: [], work};
    const author = source.author;
    if (author != null && !object(author)) return {candidates: [], work};
    const role = author?.role;
    if (author != null && role !== 'user' && role !== 'assistant') return {candidates: [], work};
    const facts = strings(memory.protectedFacts, DETAIL_PROTECTED_LIMIT, DETAIL_PROTECTED_RAW_LIMIT, work);
    const gist = layerText(input.gist, DETAIL_GIST_RAW_LIMIT, work, true), feeling = layerText(input.feeling, DETAIL_FEELING_RAW_LIMIT, work), anchor = layerText(input.anchor, DETAIL_ANCHOR_RAW_LIMIT, work);
    work.validation += 16 + facts.length;
    if (!facts.every(fact => foldedWithin(fact, DETAIL_PROTECTED_ITEM_LIMIT, work))) return {candidates: [], work};
    textWork(gist, work);
    if (!compact(gist)) return {candidates: [], work};
    const fragmentsInput = input.fragments;
    const fragmentValues = strings(fragmentsInput ?? [], DETAIL_FRAGMENT_LIMIT, DETAIL_FRAGMENT_RAW_LIMIT, work);
    work.validation += 4 + fragmentValues.length;
    if (!fragmentValues.every(value => foldedWithin(value, DETAIL_FRAGMENT_ITEM_LIMIT, work))) return {candidates: [], work};
    const fragments = fragmentValues.map(value => {textWork(value, work); return compact(value);}).filter(Boolean);
    const retention = memory.retention;
    if (retention != null && !object(retention)) return {candidates: [], work};
    const protection = retention?.emotionalProtection;
    if (protection != null && !object(protection)) return {candidates: [], work};
    const basis = protection?.basisQuote;
    work.validation += 8;
    if (protection != null && (typeof basis !== 'string' || !foldedWithin(basis, DETAIL_BASIS_RAW_LIMIT, work))) return {candidates: [], work};
    textWork(basis ?? '', work);
    const evidence = compact(basis ?? '');
    const episode = memory.episode;
    if (episode != null && !object(episode)) return {candidates: [], work};
    const scene = episode?.scene, sensory = episode?.sensoryCues;
    if (sensory != null && !Array.isArray(sensory)) return {candidates: [], work};
    const stored: unknown[] = [scene];
    if (sensory != null) {
      const length = sensory.length;
      if (!integer(length)) return {candidates: [], work};
      const room = DETAIL_STORED_SCAN_LIMIT - (scene == null ? 0 : 1);
      for (let i = 0; i < Math.min(length, room); i++) {work.validation++; stored.push(sensory[i]);}
    }
    let storedRaw = 0, storedFolded = 0;
    for (const value of stored) if (typeof value === 'string') {
      work.validation += 3; storedRaw += value.length;
      if (storedRaw > DETAIL_STORED_TOTAL_LIMIT) return {candidates: [], work};
      const size = foldedSize(value, DETAIL_STORED_ITEM_LIMIT, work);
      if (size < 0) return {candidates: [], work};
      storedFolded += size;
      if (storedFolded > DETAIL_STORED_TOTAL_LIMIT) return {candidates: [], work};
    }
    textWork(detail, work); textWork(gist, work, 3); textWork(feeling, work); textWork(anchor, work);
    const detailKey = compact(detail), gistKey = compact(gist), gistWords = wordKeys(gist);
    const layers = [gistKey, compact(feeling), compact(anchor)].filter(Boolean);
    const hanTokens = [...gistKey], knownHan = new Set(hanTokens), knownWords = new Set(gistWords);
    const hanRuns = runIndex(hanTokens, ZH_FACT_RUN, true, work), enRuns = runIndex(gistWords, EN_FACT_WORDS, false, work);
    const verbatim = new TextIndex(work), accepted = new AcceptedIndex(work), protectedIndex = new ProtectionIndex(facts, work);
    work.local += 8 + 4 * (gistKey.length + gist.length);
    if (stored.some(value => typeof value === 'string' && value.length <= FRAGMENT_RAW_LIMIT)) verbatim.append(detail);
    const all: DetailCandidate[] = [];
    let digitCodes: Pattern[] | undefined;
    const consider = (raw: unknown, origin: 'stored' | 'clause', offset?: number) => {
      work.candidates++;
      if (typeof raw !== 'string' || raw.length > FRAGMENT_RAW_LIMIT) return;
      const text = raw.trim(), key = compact(text);
      work.local += 16 * raw.length + 64;
      textWork(text, work);
      if (!text || !key) return;
      const start = offset === undefined ? verbatim.find(text) : offset + raw.length - raw.trimStart().length;
      if (start < 0) return;
      textWork(text, work, 2);
      const lang = scriptOf(text), size = units(text), [min, max] = FRAGMENT_BANDS[lang];
      if (size < min || size > max || (origin === 'clause' && size < DETAIL_CLAUSE_MIN[lang])) return;
      // mappedText + disjoint regex passes + at most O(n log n) token sorting, even on a cold helper cache.
      textWork(text, work, 12 + Math.ceil(Math.log2(1 + 54 * text.length)));
      if (codeTokenRanges(text).length || numericRanges(text).length) return;
      // Lowercase can turn dotted I into ASCII i plus a mark. Match only codes present in the source,
      // as the copy guard does; a lone dotted-I digit sequence without a source code stays ordinary text.
      if (key.includes('i\u0307')) {
        if (digitCodes === undefined) {
          const codes = new Set<string>();
          for (const value of [detail, ...facts]) {
            textWork(value, work, 12 + Math.ceil(Math.log2(1 + 54 * value.length)));
            for (const code of codeTokenRanges(value)) {
              work.protection += code.token.length + 1;
              if (code.kind !== 'caps') codes.add(code.token.toLowerCase());
            }
          }
          digitCodes = [...codes].map(code => new Pattern(code, work));
        }
        textWork(text, work); work.protection += text.length;
        const folded = mappedText(text, {dropPunctuation: false}).text;
        if (digitCodes.some(code => code.contains(folded))) return;
      }
      if (protectedIndex.hits(text)) return;
      // Full-detail copies are also rejected by the later half-detail ratio; keep this direct check.
      work.local += 4 * key.length;
      if (key.length >= detailKey.length) work.local += 4 * (key.length + 1) * (detailKey.length + 1);
      if (key.length >= detailKey.length && (key === detailKey || (detailKey.length >= 6 && key.includes(detailKey)))) return;
      work.helpers += 3 * text.length + 8;
      if (isLegacyTemplate(text)) return;
      work.local += 4 * (key.length + evidence.length);
      if (evidence && containsEither(key, evidence, work)) return;
      work.local += 3 * text.length + 4 * (3 * key.length + layers.reduce((n, value) => n + value.length, 0));
      if (!paired(text)) return;
      if (layers.some(layer => containsEither(key, layer, work))) return;
      const han = lang === 'zh', tokens = han ? [...key] : wordKeys(text);
      textWork(text, work, han ? 0 : 2); work.local += key.length;
      if (restates(tokens, han ? hanRuns : enRuns, han ? ZH_FACT_RUN : EN_FACT_WORDS, work)) return;
      if (!novel(tokens, han ? knownHan : knownWords, han, work)) return;
      if (origin === 'clause') {
        textWork(text, work, han ? 0 : 2); work.local += 3 * (key.length + text.length);
        if (!clauseContent(text, han, role === 'user', work)) return;
      }
      // scanAmounts is O(n) with fixed lexical tables; charge 256 passes of its expanded text, plus folding.
      textWork(text, work, 256);
      if (scanAmounts(text).some(amount => !amount.bare)) return;
      if (key.length >= FRAGMENT_TOTAL_RATIO * detailKey.length) return;
      if (accepted.overlaps(key)) return;
      accepted.add(key);
      all.push({start, end: start + text.length, text, source: origin});
    };
    for (const value of stored) consider(value, 'stored');
    let from = 0;
    for (let at = 0; at <= detail.length; at++) {
      work.split++;
      if (at === detail.length || RESIDUAL_BOUNDARY.test(detail[at]!)) {
        consider(detail.slice(from, at), 'clause', from); from = at + 1;
      }
    }
    const kept = all.filter(item => !fragments.some(fragment => {
      textWork(item.text, work, 2); work.local += 4 * (compact(item.text).length + fragment.length);
      return containsEither(compact(item.text), fragment, work);
    }));
    const storedKept = kept.filter(item => item.source === 'stored').slice(0, DETAIL_CANDIDATE_LIMIT);
    const clauses = kept.filter(item => item.source === 'clause'), room = DETAIL_CANDIDATE_LIMIT - storedKept.length;
    const selected = clauses.length <= room ? clauses : Array.from({length: room}, (_, i) => clauses[Math.floor(i * clauses.length / room)]!);
    work.local += 8 * (all.length + kept.length + stored.length + selected.length + 1);
    return {candidates: [...storedKept, ...selected], work};
  } catch {return {candidates: [], work};}
}

function readPool(value: unknown): DetailCandidate[] {
  if (!Array.isArray(value)) throw new Error('invalid_pool');
  const length = value.length;
  if (!integer(length) || length > DETAIL_CANDIDATE_LIMIT) throw new Error('invalid_pool');
  const result: DetailCandidate[] = [], seen = new Set<string>();
  for (let i = 0; i < length; i++) {
    const item = value[i];
    if (!object(item)) throw new Error('invalid_candidate');
    const start = item.start, end = item.end, text = item.text, source = item.source;
    if (!integer(start) || !integer(end) || end <= start || typeof text !== 'string' || text.length > FRAGMENT_RAW_LIMIT ||
      !compact(text) || end - start !== text.length || (source !== 'stored' && source !== 'clause')) throw new Error('invalid_candidate');
    const candidate = {start, end, text, source}, key = positionKey(candidate);
    if (seen.has(key)) throw new Error('duplicate_candidate');
    seen.add(key); result.push(candidate as DetailCandidate);
  }
  return result;
}

function lengths(fragment: unknown, detail: unknown): [number, number] {
  if (!integer(fragment) || !integer(detail) || detail === 0) throw new Error('invalid_lengths');
  return [fragment, detail * FRAGMENT_TOTAL_RATIO];
}

function distancesOf(input: DetailSelectionInput, size: number): number[] | null {
  try {
    const value = input.distances;
    if (!Array.isArray(value) || value.length !== size) return null;
    const result: number[] = [];
    for (let i = 0; i < size; i++) {
      const distance = value[i];
      if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0 || distance > 2) return null;
      result.push(distance);
    }
    return result;
  } catch {return null;}
}

/** O(first 64 cue slots + their bounded text); invalid types fail, oversized strings are skipped whole. */
function cueFolds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('invalid_cues');
  const length = value.length, result: string[] = [];
  if (!integer(length)) throw new Error('invalid_cues_length');
  for (let i = 0; i < Math.min(length, DETAIL_CUE_SCAN_LIMIT); i++) {
    const cue = value[i];
    if (typeof cue !== 'string') throw new Error('invalid_cue');
    if (cue.length > DETAIL_CUE_RAW_LIMIT) continue;
    const key = foldCue(cue);
    if (key) result.push(key);
  }
  return result;
}

const intersects = (a: DetailPosition, b: DetailPosition) => a.start < b.end && b.start < a.end;
function fits(item: DetailCandidate, items: readonly ShownDetail[], used: number, bound: number): boolean {
  return used + compact(item.text).length < bound && !items.some(old => intersects(item, old));
}
function display(items: ShownDetail[]): ShownDetail[] {
  return items.some(item => !item.stray) ? items.sort((a, b) => a.start - b.start) : [];
}

function revalidated(positions: unknown, pool: DetailCandidate[], fragment: number, bound: number): ShownDetail[] {
  if (!Array.isArray(positions)) throw new Error('invalid_positions');
  const length = positions.length, byPosition = new Map(pool.map(item => [positionKey(item), item]));
  if (!integer(length)) throw new Error('invalid_positions');
  const pending: ShownDetail[] = [], seen = new Set<string>();
  for (let i = 0; i < length; i++) {
    const entry = positions[i];
    if (!object(entry)) continue;
    const start = entry.start, end = entry.end, stray = entry.stray;
    if (!integer(start) || !integer(end) || end <= start || (stray != null && typeof stray !== 'boolean')) continue;
    const key = positionKey({start, end}), item = byPosition.get(key);
    if (!item || seen.has(key)) continue;
    seen.add(key); pending.push({...item, stray: stray === true, new: false});
  }
  pending.sort((a, b) => Number(a.stray) - Number(b.stray) || a.start - b.start);
  const result: ShownDetail[] = [];
  let used = fragment;
  for (const item of pending) if (fits(item, result, used, bound)) {result.push(item); used += compact(item.text).length;}
  return display(result);
}

/** O(recorded positions + total pool text); pool has at most eight entries. No distance or current-turn recall is needed. */
export function revalidateRecallDetails(input: DetailRevalidationInput): ShownDetail[] {
  try {
    const pool = readPool(input.pool), [fragment, bound] = lengths(input.fragmentCompactLength, input.detailCompactLength);
    return revalidated(input.positions, pool, fragment, bound);
  } catch {return [];}
}

/**
 * O(recorded positions + bounded cue text + pool text * bounded cue count); sorting is bounded by eight entries.
 * Each inspected cue and each candidate is folded at most once per selection (at most 64 + 8 calls).
 * Reads external fields once into local copies. Only invalid distances fall back; other malformed inputs return empty.
 * Output is in source order; render non-stray items together and the marked stray separately.
 */
export function selectRecallDetails(input: DetailSelectionInput): DetailSelection {
  const empty = (): DetailSelection => ({items: [], candidateCount: 0, budget: 0, mode: 'empty'});
  try {
    const pool = readPool(input.pool), seed = input.seed;
    if (!integer(seed) || seed > 0xffffffff) return empty();
    const [fragment, bound] = lengths(input.fragmentCompactLength, input.detailCompactLength);
    const cueRecall = input.cueRecall, cueInput = input.matchedCueFolds, previous = input.previous;
    if (cueRecall != null && typeof cueRecall !== 'boolean') return empty();
    const cues = cueFolds(cueInput ?? []);
    const distances = distancesOf(input, pool.length);
    const ranked = pool.map((item, i) => ({item, distance: distances?.[i] ?? 0})).filter(entry => !distances || entry.distance >= DETAIL_RESTATE_DISTANCE);
    const eligible = new Set(ranked.map(entry => entry.item));
    let cue: DetailCandidate | undefined;
    if (cueRecall === true && cues.length) {
      for (const item of pool) {
        if (!eligible.has(item)) continue;
        const key = foldCue(item.text);
        if (cues.some(cueKey => key.includes(cueKey))) {cue = item; break;}
      }
    }
    const n = ranked.length, budget = Math.min(DETAIL_SHOWN_MAX, Math.floor(n / 2));
    if (distances) ranked.sort((a, b) => Number(b.item === cue) - Number(a.item === cue) || a.distance - b.distance || a.item.start - b.item.start);
    const old = previous == null ? [] : revalidated(previous, pool, fragment, bound);
    if (old.length) {
      let used = fragment; for (const item of old) used += compact(item.text).length;
      const keys = new Set(old.map(positionKey));
      const addition = distances ? ranked.find(entry => !keys.has(positionKey(entry.item)))?.item : cue;
      if (old.length < budget && addition && !keys.has(positionKey(addition)) && fits(addition, old, used, bound)) old.push({...addition, stray: false, new: true});
      return {items: display(old), candidateCount: n, budget, mode: 'window'};
    }
    const picked: ShownDetail[] = [];
    const add = (item: DetailCandidate | undefined, stray = false) => {
      const used = fragment + picked.reduce((total, entry) => total + compact(entry.text).length, 0);
      if (item && fits(item, picked, used, bound)) picked.push({...item, stray, new: true});
    };
    if (n === 1 && cueRecall === true && ranked[0]!.item === cue) add(cue);
    else if (budget > 0) {
      if (!distances) add(cue ?? pool[seed % pool.length]);
      else {
        add(ranked[0]!.item);
        const coin = (seed & 1) === 1;
        if (budget >= 2 && (!coin || budget === 3)) add(ranked[1]!.item);
        if (budget >= 2 && coin) add(ranked[2 + ((seed >>> 1) % (n - 2))]!.item, true);
      }
    }
    return {items: display(picked), candidateCount: n, budget, mode: distances ? 'fresh' : 'fallback'};
  } catch {return empty();}
}
