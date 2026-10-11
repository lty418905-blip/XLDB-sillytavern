import { createHash } from 'node:crypto';
import { isPromise } from 'node:util/types';
import type { Prompt, parseModelJson } from './models.ts';

/** JSON object data, with no undefined values, cycles or nonfinite numbers at loop boundaries. */
export type ToolObject = Record<string, unknown>;
/** A checker-owned shape correction; both members are copied before replay. */
export type ToolIssue = { path: string; expected: string };
/** Proposal identity must remain stable across versions; passed records this version's acceptance. */
export type ProposalItem = { id: string; passed: boolean };

/** A complete proposal version, not an incremental update; invalid metadata fails the run. */
export type ProposalReply = {
  /** Pure JSON at depth <= 64; optional fields must be omitted, not undefined.
   * The loop replaces withdrawn/confirmation only in model feedback, retaining this original snapshot.
   * Its feedback JSON including those replacements must fit the single-result and run-result limits.
   * Oversize proposal feedback fails the run without committing this proposal version.
   */
  result: ToolObject;
  /** Unique, nonempty ids, stable across proposals; disappeared ids determine withdrawal. */
  items: ProposalItem[];
  /** Tool-owned resolution flag; kept/complete does not imply that this flag or all passed flags are true. */
  settled: boolean;
};

/** Tool callbacks receive an internal receiver with only name/check/execute/proposal; do not depend on this.
 * Results must be pure JSON (null, boolean, finite number, string, array, plain object), depth <= 64.
 * Undefined fields, cycles or invalid results fail the run after execution with tool_result_failed;
 * that call appears only in log.calls, not the conversation. Optional fields must be omitted.
 * Tools must terminate. Waiting can be abandoned, but underlying side effects may still occur later.
 * Synchronous execution cannot be interrupted and is charged at the next budget gate.
 */
export type ToolDefinition = {
  /** Nonempty unique name; at most one definition may be a proposal tool. */
  name: string;
  /** Receives a pure JSON copy; return null or a shape issue. Do not make it unserializable, deeper
   * than 64, or introduce own __proto__/constructor/prototype keys or numbers outside the safe range.
   * These edits produce a malformed call, not an execution. Exceptions fail with check_failed.
   */
  check(args: ToolObject): ToolIssue | null;
} & ({
  /** Omitted or false selects an ordinary tool. */
  proposal?: false;
  /** Receives another copy. ok !== false means success and may refresh the last identical proposal.
   * ok:false promises no state change; repetition still suppresses the immediately identical call.
   * Repetition is not an idempotency guarantee: another call or a malformed call interrupts it.
   * Oversize ordinary feedback becomes an error code, while success uses this original result.
   * Throws/rejections fail with execute_failed; cancelled/expired waits discard late results.
   */
  execute(args: ToolObject): ToolObject | PromiseLike<ToolObject>;
} | {
  /** True selects the single complete-proposal tool. */
  proposal: true;
  /** Same callback/JSON/wait contract as ordinary execute; metadata follows ProposalReply. */
  execute(args: ToolObject): ProposalReply | PromiseLike<ProposalReply>;
});

/** Sends one model request; timeoutMs is milliseconds, enforced by the caller. No in-flight abort. */
export type ToolSend = (messages: Prompt[], json: boolean, timeoutMs: number) => string | PromiseLike<string>;
/** Executable call with post-check argument data; amounts requiring exact precision belong in strings. */
export type ToolCall = { tool: string; args: ToolObject };
/** Transport decoding separates invalid output format from a decoded object with invalid call shape. */
export type DecodedToolCall = { kind: 'call'; value: ToolObject; raw: string } | { kind: 'bad_format' };

/** Only this boundary knows how calls, answers and corrections become messages. */
export interface ToolTransport<C> {
  name: string;
  open(system: string, input: unknown): C;
  messages(conversation: C, correction: string | null): Prompt[];
  decode(raw: unknown, maxCharacters: number): DecodedToolCall;
  answer(conversation: C, call: ToolCall, result: ToolObject): void;
  malformed(conversation: C, raw: string, issue: ToolIssue, correction: string, maxCodePoints: number): void;
  transcript(conversation: C): Prompt[];
}

const isObject = (value: unknown): value is ToolObject => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new TypeError('invalid_tool_loop_options');

/** UTF-16 key ordering without comparison sorting: at most 17 probes per key code unit, O(n).
 * Iterative serialization also handles deeply nested JSON without recursive stack growth.
 * Work counts traversal units, emitted characters and radix probes; it is independent of wall time.
 */
function serializeToolObject(value: ToolObject, sorted: boolean): { json: string; work: number } {
  if (!isObject(value)) throw invalid();
  let work = 0;
  const keysOf = (object: ToolObject): string[] => {
    const keys = Object.keys(object);
    const jobs: [number, number, number, number][] = [[0, keys.length, 0, 16]];
    while (jobs.length) {
      const [lo, hi, depth, bit] = jobs.pop()!;
      if (hi - lo < 2) continue;
      let left = lo, right = hi - 1;
      while (left <= right) {
        work++;
        const code = depth < keys[left].length ? keys[left].charCodeAt(depth) + 1 : 0;
        if ((code & (1 << bit)) === 0) left++;
        else { [keys[left], keys[right]] = [keys[right], keys[left]]; right--; }
      }
      if (bit > 0) {
        jobs.push([lo, left, depth, bit - 1], [left, hi, depth, bit - 1]);
      } else {
        // The terminator group contains at most one key (object keys are unique).
        if (left > lo && keys[lo].length > depth) jobs.push([lo, left, depth + 1, 16]);
        if (hi > left && keys[left].length > depth) jobs.push([left, hi, depth + 1, 16]);
      }
    }
    return keys;
  };
  type Job = { value: unknown } | { text: string } | { leave: object };
  const jobs: Job[] = [{ value }], active = new Set<object>(), parts: string[] = [];
  while (jobs.length) {
    const job = jobs.pop()!;
    work++;
    if ('text' in job) { parts.push(job.text); work += job.text.length; continue; }
    if ('leave' in job) { active.delete(job.leave); continue; }
    const item = job.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      const text = JSON.stringify(item); parts.push(text); work += text.length;
    } else if (typeof item === 'object') {
      if (active.has(item)) throw new TypeError('invalid_tool_json');
      active.add(item);
      jobs.push({ leave: item });
      if (Array.isArray(item)) {
        parts.push('[');
        jobs.push({ text: ']' });
        for (let i = item.length - 1; i >= 0; i--) {
          jobs.push({ value: item[i] });
          if (i > 0) jobs.push({ text: ',' });
        }
      } else {
        const keys = sorted ? keysOf(item as ToolObject) : Object.keys(item);
        parts.push('{');
        jobs.push({ text: '}' });
        for (let i = keys.length - 1; i >= 0; i--) {
          const key = keys[i];
          jobs.push({ value: (item as ToolObject)[key] }, { text: ':' }, { text: JSON.stringify(key) });
          if (i > 0) jobs.push({ text: ',' });
        }
      }
    } else throw new TypeError('invalid_tool_json');
  }
  return { json: parts.join(''), work };
}

/** Iterative canonical JSON and deterministic work units, O(output size); invalid JSON throws.
 * This serializer does not impose the loop's argument-only reserved-key or safe-number rules.
 */
export function canonicalToolArgs(value: ToolObject): { json: string; work: number } {
  return serializeToolObject(value, true);
}

/** Counts JSON without assembling it; bounded calls stop as soon as the UTF-16 ceiling is exceeded.
 * Work is O(visited container keys plus inspected string code units), with an iterative traversal.
 * Invalid JSON throws. The loop supplies plain-data snapshots, so their fields have no external getters.
 */
function measureToolResult(value: ToolObject, maximumCharacters: number): { characters: number; work: number } {
  if (!isObject(value)) {
    throw invalid();
  }
  let characters = 0;
  let work = 0;
  const active = new Set<object>();
  type SizeJob = { value: unknown }
    | { object: ToolObject; keys: string[]; index: number }
    | { array: unknown[]; index: number };
  const jobs: SizeJob[] = [{ value }];
  const measureString = (text: string) => {
    work++;

    // Even unescaped JSON needs both quotes. Reject long strings without flattening or escaping them.
    if (text.length + 2 > maximumCharacters - characters) {
      characters = maximumCharacters + 1;
      return;
    }
    characters += 2;

    for (let index = 0; index < text.length && characters <= maximumCharacters; index++) {
      const code = text.charCodeAt(index);
      const pairedHigh = code >= 0xd800 && code <= 0xdbff
        && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff;
      const pairedLow = code >= 0xdc00 && code <= 0xdfff
        && text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff;

      if (code === 0x22 || code === 0x5c || code === 8 || code === 9
        || code === 10 || code === 12 || code === 13) {
        characters += 2;
      }
      else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff && !pairedHigh && !pairedLow)) {
        characters += 6;
      }
      else {
        characters++;
      }
      work++;
    }
  };

  while (jobs.length && characters <= maximumCharacters) {
    const job = jobs.pop()!;
    work++;

    if ('object' in job || 'array' in job) {
      const container = 'object' in job ? job.object : job.array;
      const length = 'object' in job ? job.keys.length : job.array.length;

      if (job.index === length) {
        characters++;
        active.delete(container);
        continue;
      }
      if (job.index > 0) {
        characters++;
      }
      const index = job.index++;
      jobs.push(job);

      if ('object' in job) {
        const key = job.keys[index];
        measureString(key);
        characters++;
        jobs.push({ value: job.object[key] });
      }
      else {
        jobs.push({ value: job.array[index] });
      }
      continue;
    }
    const item = job.value;

    if (typeof item === 'string') {
      measureString(item);
    }
    else if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      const length = JSON.stringify(item).length;
      characters += length;
      work += length;
    }
    else if (typeof item === 'object') {
      if (active.has(item)) {
        throw new TypeError('invalid_tool_json');
      }
      active.add(item);
      characters++;

      if (Array.isArray(item)) {
        jobs.push({ array: item, index: 0 });
      }
      else {
        const keys = Object.keys(item);
        work += keys.length;
        jobs.push({ object: item as ToolObject, keys, index: 0 });
      }
    }
    else {
      throw new TypeError('invalid_tool_json');
    }
  }

  return { characters, work };
}

/** Measures feedback JSON in UTF-16 code units without an envelope or an assembled JSON string.
 * Iterative O(JSON size), with deterministic traversal work units; invalid JSON throws.
 * This public measurement is exact; the loop uses a bounded measurement for ordinary results.
 */
export function toolResultSize(value: ToolObject): { characters: number; work: number } {
  return measureToolResult(value, Infinity);
}

/** O(min(input code points, limit)); never splits a surrogate pair. */
export function toolReplayPrefix(raw: string, limit: number): { text: string; work: number } {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 2147483647) throw invalid();
  let end = 0, work = 0;
  while (end < raw.length && work < limit) {
    end += raw.codePointAt(end)! > 0xffff ? 2 : 1;
    work++;
  }
  return { text: raw.slice(0, end), work };
}

/** The parser is supplied by the caller as parseModelJson from the model client.
 * Output length is checked before parsing. Each message pass is linear in its content;
 * the number of accumulated exchanges is bounded by the request cap.
 */
export function createJsonToolTransport(parse: typeof parseModelJson): ToolTransport<Prompt[]> {
  return {
    name: 'json',
    open(system, input) {
      const content = JSON.stringify(input);
      if (typeof system !== 'string' || content === undefined) throw invalid();
      return [{ role: 'system', content: system }, { role: 'user', content }];
    },
    messages(conversation, correction) {
      const messages = conversation.map(message => ({ ...message }));
      if (correction !== null) {
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'user') { messages[i].content += '\n' + correction; break; }
        }
      }
      return messages;
    },
    decode(raw, maxCharacters) {
      if (typeof raw !== 'string' || raw.length > maxCharacters) return { kind: 'bad_format' };
      try {
        const value = parse(raw);
        return isObject(value) ? { kind: 'call', value, raw } : { kind: 'bad_format' };
      } catch { return { kind: 'bad_format' }; }
    },
    answer(conversation, call, result) {
      conversation.push({ role: 'assistant', content: serializeToolObject({ tool: call.tool, args: call.args }, false).json },
        { role: 'user', content: serializeToolObject({ result }, false).json });
    },
    malformed(conversation, raw, issue, correction, maxCodePoints) {
      conversation.push({ role: 'assistant', content: toolReplayPrefix(raw, maxCodePoints).text },
        { role: 'user', content: JSON.stringify({ result: { ok: false, error: 'call_malformed', detail: issue } }) + '\n' + correction });
    },
    transcript: conversation => conversation.map(message => ({ ...message })),
  };
}

/** Per-run positive safe-integer limits; invalid overrides throw invalid_tool_loop_options synchronously.
 * Legacy numeric defaults have no recorded individual provenance; the new result limits are provisional.
 * Explicit null/undefined numeric overrides are invalid, matching the existing limit contract.
 */
export interface ToolLoopLimits {
  /** Requests per run, default 8, only reducible; individual source not recorded. */
  requests: number;
  /** Total milliseconds from first dispatch, default 120000, only reducible; source not recorded.
   * Below minimumMs: finished/time/capped with zero requests and error null.
   */
  totalMs: number;
  /** Maximum milliseconds per send, default 60000, only reducible; source not recorded. */
  requestMs: number;
  /** Minimum dispatch milliseconds, default/floor 2000, cannot exceed requestMs; source not recorded. */
  minimumMs: number;
  /** Consecutive retryable failures per run, default 3; positive overrides allowed; source not recorded. */
  transportFailures: number;
  /** Consecutive format errors per run, default 2; malformed shapes reset this; source not recorded. */
  badFormats: number;
  /** Model output UTF-16 code units, default 12000; positive overrides allowed; source not recorded. */
  outputCharacters: number;
  /** Malformed raw replay code points, default 600; positive overrides allowed; source not recorded. */
  replayCodePoints: number;
  /** Retry backoff base milliseconds, default 250; positive overrides allowed; source not recorded. */
  backoffMs: number;
  /** Feedback JSON code units per tool result, default/ceiling 12000, only reducible.
   * Provisional ruling: same scale as model output; calibrate with actual bookkeeping results.
   */
  resultCharacters?: number;
  /** Accepted tool-result JSON code units per run, default/ceiling 48000, only reducible.
   * Provisional ruling: four full-size results. Loop-generated error/replay results do not count.
   */
  runResultCharacters?: number;
}
const defaultLimits: Readonly<Required<ToolLoopLimits>> = Object.freeze({
  requests: 8,
  totalMs: 120000,
  requestMs: 60000,
  minimumMs: 2000,
  transportFailures: 3,
  badFormats: 2,
  outputCharacters: 12000,
  replayCodePoints: 600,
  backoffMs: 250,
  resultCharacters: 12000,
  runResultCharacters: 48000,
});
const jsonModeMemory = new Set<string>();
let runSequence = 0n;

/** Starts one isolated loop; injected getters/callbacks after creation become result codes, not rejections.
 * Argument rules inspect parsed numbers only: exactly 2^53 is rejected, in-range fractions remain approximate.
 * Use strings for exact amounts. No model prompt or caller input size limit is imposed by this interface.
 */
export interface ToolLoopOptions<C> {
  /** Caller-owned system content, passed unchanged to transport.open. */
  system: string;
  /** Caller-owned transport input; serialization/open errors become transport_failed. */
  input: unknown;
  /** Snapshotted definitions; checks/execution use copied arguments and an internal receiver. */
  tools: readonly ToolDefinition[];
  /** Owns message representation; callback/getter failures become transport_failed. */
  transport: ToolTransport<C>;
  /** Enforces request timeout itself; cancellation does not interrupt a pending send. */
  send: ToolSend;
  /** Exact spelling tuple used for process JSON-mode memory; no model configuration is inferred. */
  provider: { baseUrl: string; model: string };
  /** Caller-supplied corrections; no additional sentences are created by the loop. */
  sentences: { badFormat: string; malformed: string; withdrawal: string };
  /** Numeric overrides are snapshotted at creation and cannot reset budgets.
   * Reading limits/override getters precedes handle creation; their thrown errors escape synchronously.
   */
  limits?: Partial<ToolLoopLimits>;
  /** Monotonic nonnegative milliseconds, default performance.now; never inject a wall clock.
   * Any backward/invalid read fails with clock_failed. Only thenable waiting adds budget reads.
   */
  now?: () => number;
  /** Retry backoff only, in milliseconds; throws/rejections become wait_failed. */
  wait?: (milliseconds: number) => void | PromiseLike<void>;
  /** Checked only at existing gates, never polled while waiting; false is sticky cancellation. */
  alive?: () => boolean;
  /** Optional exact-provider JSON-mode cache; method failures become json_mode_memory_failed. */
  jsonModeMemory?: Set<string>;
  /** Optional deadline timers for thenable tool waits; omitted/null uses setTimeout/clearTimeout.
   * Delay is remaining run milliseconds, clamped at zero, <= 120000. Schedule once and clear on exit.
   * Both methods are extracted before calling; do not depend on this.
   * Getter failures become options_failed; callback failures become tool_timer_failed.
   * Cancellation wins ties; a fired deadline wins over an unprocessed result, independent of clock reads.
   */
  toolTimers?: {
    /** Schedules the deadline callback; must return a handle synchronously and not block. */
    setTimeout(callback: () => void, milliseconds: number): unknown;
    /** Cancels its handle synchronously; must release the scheduled callback. */
    clearTimeout(handle: unknown): void;
  } | null;
}

/** Termination reason; failed/cancelled always use http, independently of the underlying cause. */
export type ToolLoopStop =
  /** A processed proposal settled without requiring another withdrawal confirmation. */
  | 'done'
  /** Identical last proposal retained; this is not acceptance of the proposal's business content. */
  | 'kept'
  /** Request count exhausted. */
  | 'requests'
  /** Insufficient dispatch budget or a pending tool's deadline fired. */
  | 'time'
  /** Consecutive model format-error limit reached. */
  | 'bad_format'
  /** Consecutive retryable transport-failure limit reached. */
  | 'transport'
  /** Nonretryable sender error, callback failure, or cancellation. */
  | 'http';

/** Loop-level disposition; complete does not mean that a proposal is postable. */
export type ToolLoopOutcome =
  /** Finished with done/kept; caller must inspect settled, items[].passed and result.ok. */
  | 'complete'
  /** At least one proposal processed, but no complete loop termination. */
  | 'partial'
  /** Finished at request/time cap before any proposal was processed. */
  | 'capped'
  /** No proposal and no successful cap/completion disposition. */
  | 'skipped';

/** Execution state, distinct from proposal acceptance and protocol termination. */
export type ToolLoopState =
  /** Protocol/budget ended normally, including a pending tool abandoned with tool_wait_expired. */
  | 'finished'
  /** Explicit cancellation or false liveness; error cancelled and stop http. */
  | 'cancelled'
  /** Caller/tool contract failure; error identifies its boundary and stop is http. */
  | 'failed';

/** Last processed full proposal, with its post-check argument snapshot, or null when none was committed. */
export type LastProposal = ProposalReply & { args: ToolObject };

/** Resolved once and never changed by a late abandoned tool. Read state/outcome/stop together. */
export interface ToolLoopResult {
  /** Process-unique run identity, also present on the immutable run handle. */
  id: string;
  /** Execution status; no claim about business success. */
  state: ToolLoopState;
  /** Loop-level disposition, not posting permission. */
  outcome: ToolLoopOutcome;
  /** Termination reason; failed/cancelled use http. */
  stop: ToolLoopStop;
  /** Last run error code, cleared only for complete; null is possible even for a zero-request time cap.
   * tool_wait_expired means an abandoned still-running tool; synchronous budget exhaustion keeps old semantics.
   */
  error: string | null;
  /** Number of model sends, including failures and retries. */
  requests: number;
  /** Successfully processed proposal versions; invalid/oversize/abandoned proposals are excluded. */
  proposals: number;
  /** Last committed proposal; settled, items[].passed and result.ok must be checked by the caller. */
  lastProposal: LastProposal | null;
  /** Previously passed ids absent from the final version and subsequently confirmed withdrawn. */
  withdrawn: string[];
  /** Previously passed ids absent from the final version without withdrawal confirmation. */
  dropped: string[];
  /** Calls and bounded statuses only. Abandoned waits use tool_wait_cancelled/tool_wait_expired;
   * invalid or oversize proposals use tool_result_failed/proposal_result_oversized and never enter conversation.
   */
  log: {
    transport: string;
    requests: number;
    calls: { tool: string | null; argsSha256: string | null; status: string }[];
  };
  /** Transport transcript; messages already accepted by it are never shortened or rewritten by the loop. */
  conversation: Prompt[];
  /** Count of ordinary results replaced by size error codes; proposals fail instead of being replaced. */
  replacedResults: number;
  /** UTF-16 code units of accepted tool feedback JSON; no envelope or loop-generated errors/replays. */
  acceptedResultCharacters: number;
}

/** Immutable handle; execution begins in a microtask in the creating async context. */
export interface ToolLoopRun {
  /** Process-unique identity that never changes. */
  readonly id: string;
  /** Never rejects; resolves after protocol stop, cancellation, or a contained callback failure.
   * Pending send must terminate itself; synchronous blocking code cannot be interrupted.
   */
  readonly done: Promise<ToolLoopResult>;
  /** Sticky cancellation; wakes tool waits, but never aborts sends or undoes tool side effects. */
  cancel(): void;
}

function limitsOf(overrides: Partial<ToolLoopLimits> | undefined): Required<ToolLoopLimits> {
  const limits = { ...defaultLimits, ...overrides };

  for (const name of Object.keys(limits) as (keyof ToolLoopLimits)[]) {
    const value = limits[name];

    if (!Object.hasOwn(defaultLimits, name) || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
      throw invalid();
    }
  }

  if (limits.requests > 8 || limits.totalMs > 120000 || limits.requestMs > 60000
    || limits.minimumMs < 2000 || limits.minimumMs > limits.requestMs
    || limits.resultCharacters > 12000 || limits.runResultCharacters > 48000) {
    throw invalid();
  }

  return limits;
}

// Error messages can have hostile getters. Only bounded codes may escape into diagnostics.
function codeOf(error: unknown): string {
  try {
    const code = typeof error === 'string' ? error : (error as { message?: unknown } | null)?.message;
    return typeof code === 'string' && code.length <= 64 && /^model_(?:[a-z_]+|http_\d{3})$/.test(code) ? code : 'model_failed';
  } catch { return 'model_failed'; }
}
function resultCode(result: ToolObject): string {
  if (result.ok !== false) return 'ok';
  const code = result.error;
  return typeof code === 'string' && code.length <= 48 && /^[a-z][a-z_]*$/.test(code) ? code : 'tool_failed';
}
const reservedKeyIssue: ToolIssue = { path: 'args', expected: 'no_reserved_keys' };
const unsafeNumberIssue: ToolIssue = { path: 'args', expected: 'safe_number' };

function snapshotObject(value: unknown, argumentsOnly = false): ToolObject {
  if (!isObject(value)) {
    throw invalid();
  }

  const copy: ToolObject = {};
  const active = new Set<object>();
  type Container = ToolObject | unknown[];
  const jobs: ({ source: Container; target: Container; depth: number } | { leave: object })[] = [
    { source: value, target: copy, depth: 1 },
  ];
  // O(n) in JSON output size; iterative, one getter read, no toJSON callbacks.
  // Each argument/result root counts as one container; objects and arrays share the limit of 64.
  while (jobs.length) {
    const job = jobs.pop()!;

    if ('leave' in job) {
      active.delete(job.leave);
      continue;
    }

    const { source, target, depth } = job;

    if (depth > 64 || active.has(source)) {
      throw invalid();
    }

    const prototype = Object.getPrototypeOf(source);

    if (!Array.isArray(source) && prototype !== null && prototype !== Object.prototype) {
      throw invalid();
    }

    // Own keys only: inherited constructor is normal, and result data keeps its existing semantics.
    if (argumentsOnly && (Object.hasOwn(source, '__proto__') || Object.hasOwn(source, 'constructor')
      || Object.hasOwn(source, 'prototype'))) {
      throw reservedKeyIssue;
    }

    active.add(source);
    jobs.push({ leave: source });
    const keys = Array.isArray(source)
      ? Array.from({ length: source.length }, (_, index) => String(index))
      : Object.keys(source);

    for (const key of keys) {
      const item: unknown = (source as ToolObject)[key];
      let next: unknown = item;

      if (item !== null && typeof item === 'object') {
        next = Array.isArray(item) ? [] : {};
        jobs.push({ source: item as Container, target: next as Container, depth: depth + 1 });
      } else if (item !== null && typeof item !== 'string' && typeof item !== 'boolean'
        && !(typeof item === 'number' && Number.isFinite(item))) {
        throw invalid();
      } else if (argumentsOnly && typeof item === 'number' && Math.abs(item) > Number.MAX_SAFE_INTEGER) {
        // Parsed values are the only available evidence; in-range fractions remain accepted.
        throw unsafeNumberIssue;
      }

      Object.defineProperty(target, key, { value: next, writable: true, enumerable: true, configurable: true });
    }
  }

  return copy;
}

/** Starts in a microtask in the creating async context. No request is aborted on cancellation.
 * All injected operations after creation, including getters and thenables, are inside the result boundary.
 * Budgets cannot be enlarged or reset. Request timeouts are enforced by send (e.g. ledgerTurn).
 */
export function createToolLoop<C>(options: ToolLoopOptions<C>): ToolLoopRun {
  const limits = limitsOf(options.limits);
  const id = `tool-run-${++runSequence}`;
  let cancelled = false;
  let wakeToolWait: (() => void) | null = null;
  const execute = async (): Promise<ToolLoopResult> => {
    let state: ToolLoopState = 'finished';
    let stop: ToolLoopStop = 'http';
    let error: string | null = null;
    let requests = 0;
    let proposals = 0;
    let replacedResults = 0;
    let acceptedResultCharacters = 0;
    let lastProposal: LastProposal | null = null;
    let conversation: C | undefined;
    let transcript: Prompt[] = [];
    let transport: ToolTransport<C> | undefined;
    let transportName = 'json';
    let failure = 'options_failed';
    let alive: (() => boolean) | undefined;
    const calls: ToolLoopResult['log']['calls'] = [];
    let activeCall: ToolLoopResult['log']['calls'][number] | null = null;
    const everPassed = new Set<string>();
    const confirmed = new Set<string>();
    let pendingConfirmation: Set<string> | null = null;
    let usedConfirmation = false;
    const checkCancelled = () => {
      if (cancelled) {
        return true;
      }
      failure = 'alive_failed';
      const live = alive ? alive() : true;

      if (typeof live !== 'boolean') {
        throw invalid();
      }

      if (!live) {
        cancelled = true;
      }

      return cancelled;
    };

    try {
      transport = options.transport;
      transportName = transport.name;
      const send = options.send;
      const now = options.now ?? (() => performance.now());
      const wait = options.wait ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
      const suppliedTimers = options.toolTimers;
      const toolTimers = suppliedTimers == null ? {
        setTimeout: (callback: () => void, milliseconds: number): unknown => setTimeout(callback, milliseconds),
        clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
      } : {
        setTimeout: suppliedTimers.setTimeout,
        clearTimeout: suppliedTimers.clearTimeout,
      };
      alive = options.alive;
      const sentences = {
        ...options.sentences
      };

      if (typeof transportName !== 'string'
        || typeof send !== 'function'
        || typeof now !== 'function'
        || typeof wait !== 'function'
        || typeof toolTimers.setTimeout !== 'function'
        || typeof toolTimers.clearTimeout !== 'function'
        || (alive !== undefined && typeof alive !== 'function')
        || !['badFormat', 'malformed', 'withdrawal'].every(
          key => typeof sentences[key as keyof typeof sentences] === 'string'
        )) {
        throw invalid();
      }
      const provider = options.provider;

      if (typeof provider.baseUrl !== 'string' || typeof provider.model !== 'string') {
        throw invalid();
      }
      // Preserve endpoint and model spelling. Tuple encoding avoids separator collisions.
      const providerKey = JSON.stringify([
        provider.baseUrl,
        provider.model
      ]);
      const memory = options.jsonModeMemory ?? jsonModeMemory;
      const tools = new Map<string, ToolDefinition>();
      let proposalTools = 0;

      for (const entry of options.tools) {
        const tool = {
          name: entry.name,
          check: entry.check,
          execute: entry.execute,
          proposal: entry.proposal
        } as ToolDefinition;

        if (typeof tool.name !== 'string'
          || !tool.name
          || tools.has(tool.name)
          || typeof tool.check !== 'function'
          || typeof tool.execute !== 'function' ||
          (tool.proposal !== undefined && typeof tool.proposal !== 'boolean')) {
          throw invalid();
        }

        if (tool.proposal) {
          proposalTools++;
        }
        tools.set(tool.name, tool);
      }

      if (proposalTools > 1) {
        throw invalid();
      }
      failure = 'transport_failed';
      conversation = transport.open(options.system, options.input);
      let deadline: number | undefined;
      let lastNow = -Infinity;
      let badFormats = 0;
      let transportFailures = 0;
      let correction: string | null = null;
      let previousCall: string | null = null;
      let previousProposal: string | null = null;
      let needsProposalRefresh = false;
      let fallbackJson = false;

      const clock = () => {
        failure = 'clock_failed';
        const time = now();

        if (!Number.isFinite(time) || time < 0 || time < lastNow || time > Number.MAX_SAFE_INTEGER - limits.totalMs) {
          throw invalid();
        }
        lastNow = time;

        return time;
      };

      const confirm = () => {
        if (pendingConfirmation) {
          for (const item of pendingConfirmation) {
            confirmed.add(item);
          }
        }
        pendingConfirmation = null;
      };

      for (;;) {
        if (checkCancelled()) {
          break;
        }
        failure = 'transport_failed';
        // Only omit messages at the request cap; the remaining gates keep their existing order.
        const messages = requests < limits.requests ? transport.messages(conversation, correction) : [];
        failure = 'json_mode_memory_failed';
        const json = !memory.has(providerKey) && !fallbackJson;
        // Include liveness callback time in the dispatch budget.
        if (checkCancelled()) {
          break;
        }
        const time = clock();
        deadline ??= time + limits.totalMs;
        const timeoutMs = Math.floor(Math.min(deadline - time, limits.requestMs));

        if (timeoutMs < limits.minimumMs) {
          stop = 'time';
          break;
        }

        if (requests >= limits.requests) {
          stop = 'requests';
          break;
        }
        // A clock callback may explicitly cancel the run too.
        if (cancelled) {
          break;
        }
        requests++;
        let raw: unknown;
        let modelError: string | null = null;

        try {
          raw = await send(messages, json, timeoutMs);
        }
        catch (cause) {
          modelError = codeOf(cause);
        }

        if (checkCancelled()) {
          break;
        }

        if (modelError !== null) {
          error = modelError;

          if (modelError === 'model_http_400' && json) {
            fallbackJson = true;
            // A complete HTTP rejection interrupts a transport-failure streak, not a format streak.
            transportFailures = 0;
            continue;
          }
          const http = /^model_http_(\d{3})$/.exec(modelError);
          const status = http ? Number(http[1]) : 0;

          if (['model_connection_failed', 'model_stream_failed', 'model_output_incomplete'].includes(modelError)
            || status === 408 || status === 429 || (status >= 500 && status <= 599)) {
            const remaining = deadline - clock();

            if (remaining <= 0) {
              stop = 'time';
              break;
            }
            transportFailures++;

            if (transportFailures >= limits.transportFailures) {
              stop = 'transport';
              break;
            }

            if (requests >= limits.requests) {
              stop = 'requests';
              break;
            }
            failure = 'wait_failed';
            await wait(Math.min(limits.backoffMs * transportFailures, remaining, 2147483647));
            continue;
          }

          if (!['model_invalid_response', 'model_output_truncated', 'model_invalid_json'].includes(modelError)) {
            stop = 'http';
            break;
          }
        }

        if (modelError === null && fallbackJson) {
          failure = 'json_mode_memory_failed';
          memory.add(providerKey);
          fallbackJson = false;
        }
        transportFailures = 0;
        failure = 'transport_failed';
        const decoded = modelError === null ? transport.decode(raw, limits.outputCharacters) : {
          kind: 'bad_format' as const
        };

        if (!decoded
          || (decoded.kind !== 'bad_format'
            && (decoded.kind !== 'call'
              || !isObject(decoded.value)
              || typeof decoded.raw !== 'string'))) {
          throw invalid();
        }

        if (decoded.kind === 'bad_format') {
          error = modelError ?? 'model_invalid_json';
          badFormats++;

          if (badFormats >= limits.badFormats) {
            stop = 'bad_format';
            break;
          }
          correction = sentences.badFormat;
          continue;
        }
        badFormats = 0;
        correction = null;
        const value = decoded.value;
        const tool = typeof value.tool === 'string' ? tools.get(value.tool) : undefined;
        let issue: ToolIssue | null = !tool ? {
          path: 'tool',
          expected: 'known_tool'
        } : !isObject(value.args) ? {
          path: 'args',
          expected: 'object'
        } : null;
        let args: ToolObject = {};
        let canonical = '';

        if (issue === null) {
          // Bound and snapshot model arguments before invoking the tool's check.
          try {
            args = snapshotObject(value.args, true);
          }
          catch (cause) {
            issue = cause === reservedKeyIssue || cause === unsafeNumberIssue ? {
              ...(cause as ToolIssue)
            } : {
              path: 'args',
              expected: 'serializable_object'
            };
          }
        }

        if (tool && issue === null) {
          failure = 'check_failed';
          issue = tool.check(args);

          if (issue !== null) {
            if (!isObject(issue) || typeof issue.path !== 'string' || typeof issue.expected !== 'string') {
              throw invalid();
            }
            issue = {
              path: issue.path,
              expected: issue.expected
            };
          }
        }

        if (issue === null) {
          // Preserve post-check validation and canonicalization when check edits its snapshot.
          try {
            args = snapshotObject(args, true);
            canonical = canonicalToolArgs(args).json;
          }
          catch (cause) {
            issue = cause === reservedKeyIssue || cause === unsafeNumberIssue ? {
              ...(cause as ToolIssue)
            } : {
              path: 'args',
              expected: 'serializable_object'
            };
          }
        }

        if (issue !== null) {
          previousCall = null;
          calls.push({
            tool: tool?.name ?? null,
            argsSha256: null,
            status: 'call_malformed'
          });
          failure = 'transport_failed';
          transport.malformed(conversation, decoded.raw, issue, sentences.malformed, limits.replayCodePoints);
          continue;
        }
        failure = 'tool_failed';
        const call: ToolCall = {
          tool: tool!.name,
          args
        };
        const callKey = JSON.stringify(tool!.name) + ':' + canonical;
        const row = {
          tool: tool!.name,
          argsSha256: createHash('sha256').update(canonical).digest('hex'),
          status: 'ok'
        };
        calls.push(row);

        if (tool!.proposal && previousProposal === canonical && !needsProposalRefresh) {
          confirm();
          row.status = 'kept';
          stop = 'kept';
          break;
        }

        if (!tool!.proposal && previousCall === callKey) {
          row.status = 'repeated_call';
          failure = 'transport_failed';
          transport.answer(conversation, call, {
            ok: false,
            error: 'repeated_call'
          });
          continue;
        }
        previousCall = callKey;
        activeCall = row;
        failure = 'execute_failed';
        const returned = tool!.execute(snapshotObject(args));
        let completion: Promise<unknown> | null = null;
        let output: unknown;

        if (isPromise(returned)) {
          // Await keeps the native Promise path, including its existing treatment of an overridden then.
          completion = (async () => await returned)();
        }
        else {
          if (returned !== null && (typeof returned === 'object' || typeof returned === 'function')) {
            const then = (returned as {
              then?: unknown;
            }).then;

            if (typeof then === 'function') {
              // Capture then exactly once, as await did, and assimilate in a microtask.
              completion = Promise.resolve({
                then(resolve: (value: unknown) => void, reject: (cause: unknown) => void) {
                  return then.call(returned, resolve, reject);
                },
              });
            }
          }
        }

        if (completion === null) {
          // Synchronous results still cross one microtask and are processed even if cancel was called in execute.
          await undefined;
          output = returned;
        }
        else {
          // Attach both handlers before any injected operation can fail; late rejection is always consumed.
          const observed = completion.then(value => ({
            value,
            rejected: false as const
          }), cause => ({
            cause,
            rejected: true as const
          }));
          let deadlineTriggered = false;
          let timerHandle: unknown;
          let timerScheduled = false;
          let interrupted = new Promise<null>(resolve => {
            wakeToolWait = () => resolve(null);
          });

          try {
            if (!cancelled) {
              const remaining = Math.max(0, deadline - clock());
              failure = 'tool_timer_failed';
              timerHandle = toolTimers.setTimeout(() => {
                deadlineTriggered = true;
                wakeToolWait?.();
              }, remaining);
              timerScheduled = true;
            }
            let settled = cancelled ? null : await Promise.race([observed, interrupted]);

            // An uncancelled callback from an earlier wait may wake this one without settling it.
            while (settled === null && !cancelled && !deadlineTriggered) {
              interrupted = new Promise<null>(resolve => {
                wakeToolWait = () => resolve(null);
              });
              settled = await Promise.race([observed, interrupted]);
            }

            // Flags are inspected after awakening: ties cannot depend on thenable microtask depth.
            if (cancelled || deadlineTriggered) {
              row.status = cancelled ? 'tool_wait_cancelled' : 'tool_wait_expired';
              activeCall = null;

              if (!cancelled) {
                error = 'tool_wait_expired';
                stop = 'time';
              }
              break;
            }
            failure = 'execute_failed';

            if (settled!.rejected) {
              throw settled!.cause;
            }
            output = settled!.value;
          }
          finally {
            wakeToolWait = null;

            if (timerScheduled) {
              // Clearing is required on completion, interruption and failure, including an undefined handle.
              const previousFailure = failure;
              failure = 'tool_timer_failed';
              toolTimers.clearTimeout(timerHandle);
              failure = previousFailure;
            }
          }
        }
        failure = 'tool_result_failed';
        let result: ToolObject;
        let finish = false;
        let resultCharacters = 0;

        if (tool!.proposal) {
          if (!isObject(output)) {
            throw invalid();
          }
          const reply = output as unknown as ProposalReply;
          result = snapshotObject(reply.result);
          const items: ProposalItem[] = [];
          const ids = new Set<string>();

          if (!Array.isArray(reply.items) || typeof reply.settled !== 'boolean') {
            throw invalid();
          }

          for (const item of reply.items) {
            if (!item
              || typeof item.id !== 'string'
              || !item.id
              || typeof item.passed !== 'boolean'
              || ids.has(item.id)) {
              throw invalid();
            }
            items.push({
              id: item.id,
              passed: item.passed
            });
            ids.add(item.id);
          }
          const withdrawn = lastProposal
            ? lastProposal.items.filter(item => !ids.has(item.id)).map(item => item.id)
            : [];
          const acceptedWithdrawal = lastProposal
            ? lastProposal.items.some(item => item.passed && !ids.has(item.id))
            : false;
          const candidateProposal = {
            args,
            result,
            items,
            settled: reply.settled
          };
          result = {
            ...result
          };
          delete result.withdrawn;
          delete result.confirmation;

          if (withdrawn.length) {
            result.withdrawn = withdrawn;
          }
          let requiresConfirmation = false;

          if (reply.settled && acceptedWithdrawal && !usedConfirmation) {
            requiresConfirmation = true;
            result.confirmation = sentences.withdrawal;
          }
          else {
            finish = reply.settled;
          }
          // Size includes loop-owned feedback fields. Nothing about this proposal is committed until it fits.
          resultCharacters = toolResultSize(result).characters;

          if (resultCharacters > limits.resultCharacters
            || acceptedResultCharacters + resultCharacters > limits.runResultCharacters) {
            failure = 'proposal_result_oversized';
            throw invalid();
          }
          confirm();

          for (const item of items) {
            if (item.passed) {
              everPassed.add(item.id);
            }
            confirmed.delete(item.id);
          }
          lastProposal = candidateProposal;
          proposals++;
          previousProposal = canonical;
          needsProposalRefresh = false;

          if (requiresConfirmation) {
            usedConfirmation = true;
            pendingConfirmation = new Set(withdrawn);
          }
        }
        else {
          result = snapshotObject(output);

          try {
            resultCharacters = measureToolResult(result, limits.resultCharacters).characters;
          }
          catch {
            // A result that cannot be measured cannot fit; retain the ordinary-result replacement path.
            resultCharacters = Infinity;
          }
        }
        row.status = resultCode(result);
        // Execution success, not the replacement feedback, decides whether a proposal must be refreshed.
        if (!tool!.proposal && result.ok !== false) {
          needsProposalRefresh = true;
        }

        if (!tool!.proposal) {
          const sizeError = resultCharacters > limits.resultCharacters ? 'tool_result_too_large'
            : acceptedResultCharacters + resultCharacters > limits.runResultCharacters ? 'run_results_too_large'
              : null;

          if (sizeError !== null) {
            row.status = sizeError;
            result = {
              ok: false,
              error: sizeError
            };
            resultCharacters = 0;
            replacedResults++;
          }
        }
        activeCall = null;
        failure = 'transport_failed';
        transport.answer(conversation, call, result);
        acceptedResultCharacters += resultCharacters;

        if (finish) {
          stop = 'done';
          break;
        }
      }
    }
    catch {
      state = 'failed';
      error = failure;
      stop = 'http';

      if (activeCall) {
        activeCall.status = failure;
      }
    }

    try {
      if (checkCancelled()) {
        state = 'cancelled';
        error = 'cancelled';
        stop = 'http';
      }

      if (transport && conversation !== undefined) {
        failure = 'transport_failed';
        const messages = transport.transcript(conversation);

        if (!Array.isArray(messages)) {
          throw invalid();
        }
        transcript = messages.map(message => {
          const { role, content } = message;

          if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string') {
            throw invalid();
          }

          return {
            role,
            content
          };
        });
      }
      // Transcript extraction itself may call user code.
      if (checkCancelled()) {
        state = 'cancelled';
        error = 'cancelled';
        stop = 'http';
      }
    }
    catch {
      state = cancelled ? 'cancelled' : 'failed';
      error = cancelled ? 'cancelled' : failure;
      stop = 'http';
    }
    const present = new Set(lastProposal?.items.map(item => item.id) ?? []);
    const withdrawn: string[] = [];
    const dropped: string[] = [];

    for (const item of everPassed) {
      if (!present.has(item)) {
        (confirmed.has(item) ? withdrawn : dropped).push(item);
      }
    }
    const outcome: ToolLoopOutcome = state === 'finished' && (stop === 'done' || stop === 'kept') ? 'complete'
      : proposals > 0 ? 'partial' : state === 'finished'
        && (stop === 'requests'
          || stop === 'time') ? 'capped' : 'skipped';

    return {
      id,
      state,
      outcome,
      stop,
      error: outcome === 'complete' ? null : error,
      requests,
      proposals,
      lastProposal,
      withdrawn,
      dropped,
      log: {
        transport: transportName,
        requests,
        calls
      },
      conversation: transcript,
      replacedResults,
      acceptedResultCharacters
    };
  };

  return Object.freeze({
    id,
    done: Promise.resolve().then(execute),
    cancel: () => {
      cancelled = true;
      wakeToolWait?.();
    }
  });
}
