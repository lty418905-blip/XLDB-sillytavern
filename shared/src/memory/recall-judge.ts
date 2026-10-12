import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {JUDGE_CALL_SITES} from '../judge/call-sites.ts';
import type {JudgeCallSite} from '../judge/call-sites.ts';
import type {JudgeProvider, JudgeTimers} from '../judge/provider.ts';
import {JUDGE_MODEL_PATTERN} from '../judge/systemone.ts';
import type {JudgeQuestion, JudgeRequest} from '../judge/systemone.ts';
import {wrapJudgeState} from '../judge/state-wrapper.ts';
import {recordRetrievalFallback, recordStage} from '../core/runtime-log.ts';
import {scopeKey} from '../core/types.ts';
import type {Scope} from './access.ts';
import type {CurrentSource} from './context.ts';
import type {TraceHit} from './trace.ts';
import type {RecallJudgeInput} from './recall-judge-input.ts';

// Selected value; verify again with product samples after integration.
export const RECALL_STRONG_THIS = 0.80;
// Selected value; verify again with product samples after integration.
export const RECALL_STRONG_OTHER = 0.10;
// Selected value; verify again with product samples after integration.
export const RECALL_WEAK_THIS = 0.55;
// Selected value; verify again with product samples after integration.
export const RECALL_WEAK_MARGIN = 0.10;
// Selected value; at most two weak events per decision.
export const RECALL_WEAK_LIMIT = 2;
// Selected value; the unclear comparison deliberately has no tolerance.
export const RECALL_UNCLEAR_CEILING = 0.5;
/** Calibration comparison tolerance, except for the unclear ceiling. */
export const RECALL_BAND_EPSILON = 1e-9;
/** Selected safety deadline in milliseconds, including a provider that never settles. */
export const RECALL_JUDGE_TIMEOUT_MS = 3500;
/** Planned process/cache-history caps; the user-selected request limit is four per accepted turn. */
export const RECALL_JUDGE_BOUNDS = Object.freeze({cache: 64, perTurn: 4, turns: 64});
/** Planned per-chat learning-pair byte cap; stop appending complete requests when full. */
export const RECALL_PAIR_BYTE_LIMIT = 8 * 1024 * 1024;
/** Fixed question version and wording; replacing a slot never changes any other decoded character. */
export const RECALL_JUDGE_WORDING = Object.freeze({
  "version": "react-zh-1a",
  "instructions": "这一题只问一件事：玩家这句话是不是在说候选 {slot} 这件事。候选都是这个角色自己亲身经历过的旧事，daysAgo 是那件事距离现在大约几天；其他候选只用来对照，这一题不评它们。玩家可以用自己的话说起这件事、转述别人说的、问角色记不记得，也可能只提到当时的心情、其中一个细节、一个人或一件东西，甚至把一两处细节记错；只要能合理认定玩家指的就是这件过去的事，选 this。玩家说起眼前的事时，如果明显是借眼前的事在提那件旧事（比如说又碰上了、和那次一样），也算 this。玩家只是在聊相近的话题、聊今天或眼前正在发生的事、问一般性的问题、提要求、说戏外的话、表达一般的情绪，没有指向这件过去的事，选 other；词语相似不等于在指这件事。这句话太短，只是附和、应声或接话，或者候选里另有一件事和这句话同样对得上、分不出玩家指的是哪一件，凭这句话认不出来，选 unclear。只依据素材里有的内容判断，不要补上素材没有记录的事。玩家的话可能是繁体或简体，按意思判断，不按字形。",
  "criteria": Object.freeze({
    "this": "玩家这句话指的就是 {slot}：所说的事、对象、地点、人物或当时的心情与 {slot} 吻合，说的是那件过去的事，或者明显是借眼前的事在提它。",
    "other": "玩家没有在指 {slot}：在聊别的话题、今天或眼前正在发生的事、一般性的问题、要求或心情，或者只是用了相似的词。",
    "unclear": "这句话太短或只是附和、接话；或者另一条候选和这句话同样对得上；凭这句话无法认定是不是 {slot}。"
  })
});

/** Three probabilities and the local slot; only finite normalized distributions enter this type at runtime. */
export interface RecallProbabilities {
  this: number;
  other: number;
  unclear: number;
}
/** Selected band parameters; alternate values support independent boundary tests. */
export interface RecallBandThresholds {
  strongThis: number;
  strongOther: number;
  weakThis: number;
  weakMargin: number;
  weakLimit: number;
  unclearCeiling: number;
}
/** Selected defaults for the pure band classifier. */
export const RECALL_BAND_THRESHOLDS: Readonly<RecallBandThresholds> = Object.freeze({
  strongThis: RECALL_STRONG_THIS,
  strongOther: RECALL_STRONG_OTHER,
  weakThis: RECALL_WEAK_THIS,
  weakMargin: RECALL_WEAK_MARGIN,
  weakLimit: RECALL_WEAK_LIMIT,
  unclearCeiling: RECALL_UNCLEAR_CEILING,
});
/** Band names used by local learning pairs; both active bands restore only the existing gist path. */
export type RecallBand = 'strong' | 'weak' | 'none';

/** Pure classification, O(k log k) for k candidates (product k <= 3), without mutating probabilities. */
export function recallBands(
  probabilities: Readonly<Record<string, RecallProbabilities>>,
  thresholds: Readonly<RecallBandThresholds> = RECALL_BAND_THRESHOLDS
): Record<string, RecallBand> {
  thresholds ??= RECALL_BAND_THRESHOLDS;
  const entries = Object.entries(probabilities);
  const result: Record<string, RecallBand> = Object.fromEntries(entries.map(([slot]) => [slot, 'none']));
  const eligible = entries.filter(([, value]) => value.unclear <= thresholds.unclearCeiling);
  const strong = eligible.filter(([, value]) => value.this >= thresholds.strongThis - RECALL_BAND_EPSILON &&
    value.other <= thresholds.strongOther + RECALL_BAND_EPSILON);
  const strongSlot = strong.length === 1 ? strong[0]![0] : undefined;
  if (strongSlot !== undefined) result[strongSlot] = 'strong';
  const weak = eligible.filter(([slot, value]) => slot !== strongSlot &&
    value.this >= thresholds.weakThis - RECALL_BAND_EPSILON &&
    value.this - value.other >= thresholds.weakMargin - RECALL_BAND_EPSILON)
    .sort(([leftSlot, left], [rightSlot, right]) => right.this - left.this ||
      (leftSlot < rightSlot ? -1 : leftSlot > rightSlot ? 1 : 0));
  for (const [slot] of weak.slice(0, thresholds.weakLimit)) result[slot] = 'weak';
  return result;
}

/** Compose the fixed allow-listed request, or return the wrapper's bounded failure reason. Work O(state bytes). */
export function recallJudgeRequest(input: RecallJudgeInput):
  {ok: true; request: JudgeRequest} | {ok: false; detail: string} {
  const wrapped = wrapJudgeState(
    {playerLine: input.playerLine, candidates: [...input.candidates, ...input.distractors]},
    {playerLine: true, candidates: {slot: true, daysAgo: true, text: true}}
  );
  if (!wrapped.ok) return wrapped;
  const questions: JudgeQuestion[] = input.candidates.map(candidate => ({
    id: candidate.slot,
    type: 'choice',
    version: RECALL_JUDGE_WORDING.version,
    instructions: RECALL_JUDGE_WORDING.instructions.replaceAll('{slot}', candidate.slot),
    criteria: Object.fromEntries(Object.entries(RECALL_JUDGE_WORDING.criteria)
      .map(([name, wording]) => [name, wording.replaceAll('{slot}', candidate.slot)])),
  }));
  return {ok: true, request: {callSite: 'memory-reactivation', state: wrapped.state, questions}};
}

/** Configure only the recall site; future registry additions are disabled automatically. */
export function recallOnlySites(): Record<JudgeCallSite, boolean> {
  return Object.fromEntries(JUDGE_CALL_SITES.map(site => [site, site === 'memory-reactivation'])) as
    Record<JudgeCallSite, boolean>;
}

/** Same chat, branch and accepted player revision share quota across actors; no raw text enters the turn key. */
export function recallTurnKey(scope: Scope, source: CurrentSource): string {
  return JSON.stringify([scope.worldId, scope.sessionId, scope.branchId, source.id, source.revision]);
}

/** Reserve before awaiting. FIFO bounds old turns; regenerations within the retained turn history share quota. */
export function reserveRecallTurn(turns: Map<string, number>, key: string): boolean {
  const count = turns.get(key) ?? 0;
  if (count >= RECALL_JUDGE_BOUNDS.perTurn) return false;
  if (!turns.has(key) && turns.size >= RECALL_JUDGE_BOUNDS.turns) turns.delete(turns.keys().next().value!);
  turns.set(key, count + 1);
  return true;
}

type CacheEntry = {
  request: JudgeRequest;
  probabilities: Record<string, RecallProbabilities>;
  model: string;
  time: number;
  pendingPair: boolean;
};

/** Local outcome; recordUsed must run once after limitRecalls, never before the version assertion. */
export interface RecallJudgeOutcome {
  outcome: 'not_needed' | 'not_asked' | 'failed' | 'success' | 'cache';
  hits: TraceHit[];
  recordUsed?: (hits: readonly TraceHit[]) => void;
}

/** The host injects this step into Core; availability returns only the configured model, never provider diagnostics. */
export interface RecallJudgeStep {
  available(): string | null;
  decide(input: RecallJudgeInput, scope: Scope, model: string, reserve: () => boolean):
    RecallJudgeOutcome | Promise<RecallJudgeOutcome>;
  setLearning(enabled: boolean): void;
  clearCache(): void;
}

/** Optional local pair storage and deterministic test clock/timers. No directory means no disk writes. */
export interface RecallJudgeOptions {
  directory?: string;
  learning?: boolean;
  pairByteLimit?: number;
  now?: () => number;
  timers?: JudgeTimers;
}

// Hashing is O(serialized bytes); raw identifiers never become filenames.
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function chatMarker(scope: Pick<Scope, 'worldId' | 'sessionId'>): string {
  return hash(JSON.stringify([scope.worldId, scope.sessionId]));
}

const PAIR_SUFFIX = '.recall-pairs.jsonl';

/** Remove this chat's pair file only; invalid paths or filesystem failures return false without exposing errors. */
export function clearRecallPairs(directory: string, scope: Pick<Scope, 'worldId' | 'sessionId'>): boolean {
  try {
    fs.rmSync(path.join(directory, chatMarker(scope) + PAIR_SUFFIX), {force: true});
    return true;
  } catch {
    return false;
  }
}

/** Remove only this feature's hashed pair filenames in the supplied directory, without traversing subdirectories. */
export function clearAllRecallPairs(directory: string): boolean {
  try {
    if (!fs.existsSync(directory)) return true;
    for (const name of fs.readdirSync(directory)) {
      if (/^[a-f0-9]{64}\.recall-pairs\.jsonl$/.test(name)) fs.rmSync(path.join(directory, name), {force: true});
    }
    return true;
  } catch {
    return false;
  }
}

// Fixed vocabulary prevents provider details, thrown messages or digit-bearing reasons entering runtime events.
function failed(reason: unknown, httpStatus?: unknown): RecallJudgeOutcome {
  if (!['not_configured', 'site_disabled', 'site_locked'].includes(reason as string)) {
    let failure = 'provider_error';
    let attention: 'configuration' | 'transient' = 'transient';
    if (reason === 'timeout') failure = 'timeout';
    else if (reason === 'network') failure = 'transport';
    else if (reason === 'http_429' || reason === 'rate_limit_window') failure = 'rate_limited';
    else if (reason === 'bad_response') failure = 'invalid_response';
    else if (reason === 'turn_limit') failure = 'turn_limit';
    else if (
      ['http_401', 'http_402', 'http_403', 'http_404', 'needs_user', 'invalid_request'].includes(reason as string)
    ) {
      failure = 'configuration';
      attention = 'configuration';
    }
    recordRetrievalFallback('recall_judge_skipped', {
      stage: 'recall_judge',
      failure,
      attention,
      ...(typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
        ? {httpStatus} : {}),
    });
  }
  return {outcome: 'failed', hits: []};
}

// Only the expected three probabilities are copied. Other response fields are never retained.
function probabilitiesOf(result: unknown, questions: readonly JudgeQuestion[]): Record<string, RecallProbabilities> | null {
  const answers = (result as {answers?: Record<string, {distribution?: Record<string, unknown>}>})?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const probabilities: Record<string, RecallProbabilities> = {};
  for (const question of questions) {
    if (!Object.hasOwn(answers, question.id)) return null;
    const answer = answers[question.id] as {id?: unknown; type?: unknown; distribution?: Record<string, unknown>};
    if (!answer || answer.id !== question.id || answer.type !== 'choice') return null;
    const value = answer.distribution;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      !['this', 'other', 'unclear'].every(option => Object.hasOwn(value, option))) return null;
    const row = {this: value.this, other: value.other, unclear: value.unclear};
    if (Object.values(row).some(number => typeof number !== 'number' || !Number.isFinite(number) ||
      number < 0 || number > 1)) return null;
    const accepted = row as RecallProbabilities;
    if (Math.abs(accepted.this + accepted.other + accepted.unclear - 1) > RECALL_BAND_EPSILON) return null;
    probabilities[question.id] = accepted;
  }
  return probabilities;
}

/**
 * Create a bounded process-local decision cache around an existing provider; never creates or configures a provider.
 * Data work is O(request bytes + questions); injected provider, clock and timer failures become fixed fallbacks.
 */
export function createRecallJudge(provider: JudgeProvider, options: RecallJudgeOptions = {}): RecallJudgeStep {
  options ??= {};
  const cache = new Map<string, CacheEntry>();
  const directory = options.directory;
  const byteLimit = options.pairByteLimit ?? RECALL_PAIR_BYTE_LIMIT;
  if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) throw new Error('invalid_recall_pair_limit');
  const now = options.now ?? Date.now;
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let learning = options.learning ?? true;

  function outcome(entry: CacheEntry, input: RecallJudgeInput, scope: Scope, cached: boolean): RecallJudgeOutcome {
    const bands = recallBands(entry.probabilities);
    const active = input.candidates.filter(candidate => bands[candidate.slot] !== 'none')
      .sort((left, right) => Number(bands[right.slot] === 'strong') - Number(bands[left.slot] === 'strong') ||
        entry.probabilities[right.slot]!.this - entry.probabilities[left.slot]!.this ||
        (left.slot < right.slot ? -1 : left.slot > right.slot ? 1 : 0));
    return {
      outcome: cached ? 'cache' : 'success',
      hits: active.map(candidate => ({id: candidate.id, strong: bands[candidate.slot] === 'strong'})),
      recordUsed(hits) {
        if (!entry.pendingPair) return;
        // Consume synchronously before any IO: concurrent cache users can never append the same request twice.
        entry.pendingPair = false;
        if (!learning || !directory) return;
        try {
          const restored = new Set(hits.map(hit => hit.id));
          const chat = chatMarker(scope);
          const actor = hash(scopeKey(scope));
          const data = entry.request.questions.map(question => JSON.stringify({
            state: entry.request.state,
            question,
            probabilities: entry.probabilities[question.id],
            band: bands[question.id],
            restored: input.candidates.some(candidate => candidate.slot === question.id && restored.has(candidate.id)),
            model: entry.model,
            time: entry.time,
            chat,
            actor,
          })).join('\n') + '\n';
          fs.mkdirSync(directory, {recursive: true});
          const file = path.join(directory, chat + PAIR_SUFFIX);
          const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
          if (size + Buffer.byteLength(data) <= byteLimit) fs.appendFileSync(file, data, 'utf8');
        } catch {
          // Local learning cannot stop a reply, and filesystem messages may contain private paths.
        }
      },
    };
  }

  return {
    available() {
      try {
        const status = provider.status();
        const model = status.model;
        if (status.keyConfigured !== true || typeof model !== 'string' || !JUDGE_MODEL_PATTERN.test(model) ||
          !Array.isArray(status.sites)) return null;
        const site = status.sites.find(site => site.id === 'memory-reactivation');
        return site?.enabled === true && site.locked === false ? model : null;
      } catch {
        return null;
      }
    },
    decide(input, scope, model, reserve) {
      try {
        const composed = recallJudgeRequest(input);
        if (!composed.ok) {
          if (composed.detail === 'state_too_long') {
            recordStage('not_asked', {stage: 'recall_judge', parts: ['recall_judge', 'state_too_long']});
            return {outcome: 'not_asked', hits: []};
          }
          return failed('invalid_request');
        }
        const request = composed.request;
        // State precedes cache; cache precedes quota. Oversized state and cache hits never consume a request.
        const key = hash(JSON.stringify([scopeKey(scope), request.state, RECALL_JUDGE_WORDING.version, model]));
        const cached = cache.get(key);
        if (cached) return outcome(cached, input, scope, true);
        if (!reserve()) return failed('turn_limit');

        return new Promise<RecallJudgeOutcome>(resolve => {
          let finished = false;
          let handle: unknown;
          const finish = (value: RecallJudgeOutcome) => {
            if (finished) return;
            finished = true;
            try {
              timers.clearTimeout(handle);
            } catch {
              // The settled result has priority over timer cleanup.
            }
            resolve(value);
          };
          try {
            handle = timers.setTimeout(() => {
              if (!finished) finish(failed('timeout'));
            }, RECALL_JUDGE_TIMEOUT_MS);
            Promise.resolve(provider.evaluate(request)).then(result => {
              if (finished) return;
              try {
                if (result?.ok !== true) {
                  finish(failed(result?.reason, result?.httpStatus));
                  return;
                }
                const probabilities = probabilitiesOf(result, request.questions);
                if (!probabilities) {
                  finish(failed('bad_response'));
                  return;
                }
                const time = now();
                if (!Number.isSafeInteger(time) || time < 0) {
                  finish(failed('clock_error'));
                  return;
                }
                const entry: CacheEntry = {request, probabilities, model, time, pendingPair: learning && !!directory};
                if (cache.size >= RECALL_JUDGE_BOUNDS.cache) cache.delete(cache.keys().next().value!);
                cache.set(key, entry);
                finish(outcome(entry, input, scope, false));
              } catch {
                finish(failed('bad_response'));
              }
            }, () => {
              if (!finished) finish(failed('network'));
            });
          } catch {
            finish(failed('internal_error'));
          }
        });
      } catch {
        return failed('internal_error');
      }
    },
    setLearning(enabled) {
      learning = enabled === true;
      if (!learning) for (const entry of cache.values()) entry.pendingPair = false;
    },
    clearCache() {
      cache.clear();
    },
  };
}

/** Facts for the host's later disclosure; these are not user-facing consent or settings text. */
export const RECALL_DISCLOSURE_FACTS = Object.freeze({
  traceEmbedding: {source: 'clear keys of faded, restorable memories', maximumTextsPerSearch: 128},
  reranking: 'May repeat more often while trace results are not cacheable; document text is unchanged.',
  judge: {playerUnits: 600, candidates: 3, controls: 1, memoryUnits: 240, protectedValues: 'in-place marks', age: 'story days'},
  detailEmbedding: {
    source: 'Recalled memories, including those later omitted or removed because context exceeds its limit.',
    texts: 'Gist, emotionally protected visible feeling, and up to eight original candidate fragments.',
    maximumTextsPerContext: 32,
    requestsPerContext: 1,
    filtering: 'Protected values, multi-digit numbers and code tokens are filtered by the existing candidate pool. ' +
      'Amount filtering covers yuan-family currency words and yen/yuan signs; fen requires an attached qian word. ' +
      'It also rejects some non-amount phrases. Foreign-currency spellings and named currencies in Chinese numerals may remain.',
  },
});
