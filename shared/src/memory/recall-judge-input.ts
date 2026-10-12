import {foldForMatch} from '../common/script-fold.ts';
import {currentMemory} from './access.ts';
import type {Memory, MemorySnapshot} from './access.ts';
import type {CurrentSource} from './context.ts';
import {ProtectedFactDetector, isLegacyTemplate, retainedAccess, traceEligible} from './retention.ts';
import {codeTokenRanges, compact, mappedText, units} from './text-units.ts';
import {clearKeyText, eventKey} from './trace.ts';
import type {TraceCandidate} from './trace.ts';

/** Selected outbound budgets, in text units, per player line and per memory respectively. */
export const RECALL_JUDGE_TEXT_LIMITS = Object.freeze({player: 600, memory: 240, candidates: 3, search: 8});
/** Fixed replacement for each connected protected span; it counts as one Chinese text unit. */
export const RECALL_JUDGE_MASK = '〔略〕';
/** Deterministic input-work charges; counters measure visited units and comparisons, never elapsed time. */
export interface RecallJudgeTextWork {
  scan: number;
  substring: number;
  protection: number;
  helpers: number;
}

/** A fresh counter for optional cold-work assertions. */
export function recallJudgeTextWork(): RecallJudgeTextWork {
  return {scan: 0, substring: 0, protection: 0, helpers: 0};
}

// KMP finds overlapping occurrences in O(text + pattern), without rescanning prefixes for every match.
function codeMatches(text: string, pattern: string, work: RecallJudgeTextWork): [number, number][] {
  const failure = new Uint32Array(pattern.length);
  const result: [number, number][] = [];
  for (let index = 1, matched = 0; index < pattern.length; index++) {
    while (matched && pattern[index] !== pattern[matched]) {
      work.scan++;
      matched = failure[matched - 1]!;
    }
    work.scan++;
    if (pattern[index] === pattern[matched]) matched++;
    failure[index] = matched;
  }
  for (let index = 0, matched = 0; index < text.length; index++) {
    while (matched && text[index] !== pattern[matched]) {
      work.scan++;
      matched = failure[matched - 1]!;
    }
    work.scan++;
    if (text[index] === pattern[matched]) matched++;
    if (matched === pattern.length) {
      result.push([index + 1 - matched, index + 1]);
      matched = failure[matched - 1]!;
    }
  }
  return result;
}

/**
 * Replace protected values in the original text. Empty/template/mismatched folds yield an empty string.
 * Work is O(f + p*n + n), with f fact bytes, p fact/code patterns and n text units; no shared-run matrix.
 */
export function maskRecallJudgeText(
  text: string,
  facts: readonly string[],
  work: RecallJudgeTextWork = recallJudgeTextWork()
): string {
  work ??= recallJudgeTextWork();
  work.scan += text.length;
  if (!text.trim() || isLegacyTemplate(text)) return '';
  const folded = foldForMatch(text);
  const copies = facts.map(fact => foldForMatch(fact));
  work.scan += text.length + facts.reduce((sum, fact) => sum + fact.length, 0);
  if (folded.length !== text.length || copies.some((copy, index) => copy.length !== facts[index]!.length)) return '';

  const spans = new ProtectedFactDetector(copies, work).spans(folded);
  const tokens = copies.flatMap(fact => codeTokenRanges(fact));
  const digitCodes = new Set(tokens.filter(token => token.kind !== 'caps').map(token => token.token.toLowerCase()));
  const capsCodes = new Set(tokens.filter(token => token.kind === 'caps').map(token => token.token));
  for (const [codes, sensitive] of [[digitCodes, false], [capsCodes, true]] as const) {
    if (!codes.size) continue;
    const mapped = mappedText(folded, {dropPunctuation: false, lower: !sensitive});
    work.scan += folded.length + mapped.text.length;
    for (const code of codes) {
      for (const [from, to] of codeMatches(mapped.text, code, work)) {
        if (sensitive && (/[A-Za-z0-9]/.test(mapped.text[from - 1] ?? '') ||
          /[A-Za-z0-9]/.test(mapped.text[to] ?? ''))) continue;
        spans.push([mapped.start[from]!, mapped.end[to - 1]!]);
      }
    }
  }

  // A difference array merges overlapping and touching ranges in linear time, even for repeated long values.
  const coverage = new Int32Array(text.length + 1);
  for (const [from, to] of spans) {
    coverage[from]++;
    coverage[to]--;
    work.scan++;
  }
  const parts: string[] = [];
  const rest: string[] = [];
  let depth = 0;
  let beginning = 0;
  let hidden = false;
  for (let index = 0; index <= text.length; index++) {
    depth += coverage[index]!;
    const nextHidden = depth > 0;
    work.scan++;
    if (nextHidden === hidden) continue;
    if (nextHidden) {
      const kept = text.slice(beginning, index);
      parts.push(kept, RECALL_JUDGE_MASK);
      rest.push(kept);
    } else {
      beginning = index;
    }
    hidden = nextHidden;
  }
  parts.push(text.slice(beginning));
  rest.push(text.slice(beginning));
  return compact(rest.join('')) ? parts.join('') : '';
}

/**
 * Unit-bounded prefix in original spelling; an ASCII run or mask is never split. Uncut text stays byte-identical.
 * Work O(n log n), including NFKC composition across original code points; no per-prefix quadratic scan.
 */
export function clipRecallJudgeText(
  text: string,
  limit: number,
  work: RecallJudgeTextWork = recallJudgeTextWork()
): string {
  work ??= recallJudgeTextWork();
  work.scan += text.length;
  if (units(text) <= limit) return text;
  const points = [...text];
  let lower = 0;
  let upper = points.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const prefix = points.slice(0, middle).join('');
    work.scan += prefix.length;
    if (units(prefix) <= limit) lower = middle;
    else upper = middle - 1;
    work.scan++;
  }
  while (lower > 0 && lower < points.length && /[A-Za-z0-9]/.test(points[lower - 1]!) &&
    /[A-Za-z0-9]/.test(points[lower]!)) {
    lower--;
    work.scan++;
  }
  let result = points.slice(0, lower).join('').trimEnd();
  // Every mark is fixed and short; only a suffix crossing this cut can be incomplete.
  const beginning = result.lastIndexOf('〔');
  if (beginning >= 0 && result.length - beginning < RECALL_JUDGE_MASK.length &&
    text.startsWith(RECALL_JUDGE_MASK, beginning)) result = result.slice(0, beginning).trimEnd();
  return result;
}

/** Original clear-key text, masked before the 240-unit cut; empty candidates do not occupy a slot. */
export function recallJudgeCandidateText(memory: Pick<Memory, 'detail' | 'episode' | 'protectedFacts'>): string {
  return clipRecallJudgeText(
    maskRecallJudgeText(clearKeyText(memory), memory.protectedFacts), RECALL_JUDGE_TEXT_LIMITS.memory
  );
}

/** Local identity mapping and the separately projected outbound fields of one evaluated event. */
export interface RecallJudgeCandidate {
  id: string;
  event: string;
  slot: string;
  daysAgo: number;
  text: string;
}

/** The only memory-derived state fields that may leave the process. */
export interface RecallJudgeInput {
  playerLine: string;
  candidates: RecallJudgeCandidate[];
  distractors: {slot: string; daysAgo: number; text: string}[];
}

/**
 * Recheck candidates on the current snapshot and both clocks, excluding cues and the answered source.
 * Work O(records + ids + text masking); at most eight event candidates are inspected, three are evaluated.
 */
export function recallJudgeInput(
  snapshot: MemorySnapshot,
  query: string,
  now: number,
  source: CurrentSource,
  traces: readonly TraceCandidate[],
  rankedIds: readonly string[],
  cueEvents: ReadonlySet<string>
): RecallJudgeInput {
  const clock = snapshot.memoryTimeMs ?? now;
  const candidates: RecallJudgeCandidate[] = [];
  const events = new Set<string>();
  const ownSource = (memory: Memory) =>
    memory.source.messageId === source.id && memory.source.revision === source.revision;
  // One day is defined by the story clock, in milliseconds, rather than the host time zone.
  const daysAgo = (memory: Memory) => Math.max(0, Math.floor((clock - memory.source.knownAtMs) / 86_400_000));
  for (const trace of traces.slice(0, RECALL_JUDGE_TEXT_LIMITS.search)) {
    for (const id of trace.ids) {
      const memory = currentMemory(snapshot, id, now);
      if (!memory || !traceEligible(memory, clock) || ownSource(memory)) continue;
      const event = eventKey(memory);
      if (events.has(event) || cueEvents.has(event)) continue;
      const text = recallJudgeCandidateText(memory);
      if (!text) continue;
      // Twins use the first eligible nonempty member in the trace's stable authority order.
      candidates.push({id: trace.ids[0]!, event, slot: `c${candidates.length + 1}`, daysAgo: daysAgo(memory), text});
      events.add(event);
      break;
    }
    if (candidates.length === RECALL_JUDGE_TEXT_LIMITS.candidates) break;
  }
  const distractors: RecallJudgeInput['distractors'] = [];
  for (const id of rankedIds) {
    const memory = currentMemory(snapshot, id, now);
    if (!memory || memory.source.reference || ownSource(memory) ||
      retainedAccess(memory, clock).access !== 'clear' || events.has(eventKey(memory))) continue;
    const text = recallJudgeCandidateText(memory);
    if (!text) continue;
    distractors.push({slot: 'd1', daysAgo: daysAgo(memory), text});
    break;
  }
  return {playerLine: clipRecallJudgeText(query, RECALL_JUDGE_TEXT_LIMITS.player), candidates, distractors};
}
