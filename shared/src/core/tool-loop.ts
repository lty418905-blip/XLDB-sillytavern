import { createHash } from 'node:crypto';
import type { Prompt, parseModelJson } from './models.ts';

export type ToolObject = Record<string, unknown>;
export type ToolIssue = { path: string; expected: string };
export type ProposalItem = { id: string; passed: boolean };
export type ProposalReply = { result: ToolObject; items: ProposalItem[]; settled: boolean };
export type ToolDefinition = {
  name: string;
  check(args: ToolObject): ToolIssue | null;
} & ({ proposal?: false; execute(args: ToolObject): ToolObject | PromiseLike<ToolObject> }
  | { proposal: true; execute(args: ToolObject): ProposalReply | PromiseLike<ProposalReply> });
export type ToolSend = (messages: Prompt[], json: boolean, timeoutMs: number) => string | PromiseLike<string>;
export type ToolCall = { tool: string; args: ToolObject };
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
export function canonicalToolArgs(value: ToolObject): { json: string; work: number } {
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
        const keys = keysOf(item as ToolObject);
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
      conversation.push({ role: 'assistant', content: JSON.stringify({ tool: call.tool, args: call.args }) },
        { role: 'user', content: JSON.stringify({ result }) });
    },
    malformed(conversation, raw, issue, correction, maxCodePoints) {
      conversation.push({ role: 'assistant', content: toolReplayPrefix(raw, maxCodePoints).text },
        { role: 'user', content: JSON.stringify({ result: { ok: false, error: 'call_malformed', detail: issue } }) + '\n' + correction });
    },
    transcript: conversation => conversation.map(message => ({ ...message })),
  };
}

export interface ToolLoopLimits {
  requests: number;
  totalMs: number;
  requestMs: number;
  minimumMs: number;
  transportFailures: number;
  badFormats: number;
  outputCharacters: number;
  replayCodePoints: number;
  backoffMs: number;
}
const defaultLimits: Readonly<ToolLoopLimits> = Object.freeze({ requests: 8, totalMs: 120000, requestMs: 60000,
  minimumMs: 2000, transportFailures: 3, badFormats: 2, outputCharacters: 12000, replayCodePoints: 600, backoffMs: 250 });
const jsonModeMemory = new Set<string>();
let runSequence = 0n;

export interface ToolLoopOptions<C> {
  system: string;
  input: unknown;
  tools: readonly ToolDefinition[];
  transport: ToolTransport<C>;
  send: ToolSend;
  provider: { baseUrl: string; model: string };
  sentences: { badFormat: string; malformed: string; withdrawal: string };
  limits?: Partial<ToolLoopLimits>;
  now?: () => number;
  wait?: (milliseconds: number) => void | PromiseLike<void>;
  alive?: () => boolean;
  jsonModeMemory?: Set<string>;
}
export type ToolLoopStop = 'done' | 'kept' | 'requests' | 'time' | 'bad_format' | 'transport' | 'http';
export type ToolLoopOutcome = 'complete' | 'partial' | 'capped' | 'skipped';
export type ToolLoopState = 'finished' | 'cancelled' | 'failed';
export type LastProposal = ProposalReply & { args: ToolObject };
export interface ToolLoopResult {
  id: string;
  state: ToolLoopState;
  outcome: ToolLoopOutcome;
  stop: ToolLoopStop;
  error: string | null;
  requests: number;
  proposals: number;
  lastProposal: LastProposal | null;
  withdrawn: string[];
  dropped: string[];
  log: { transport: string; requests: number; calls: { tool: string | null; argsSha256: string | null; status: string }[] };
  conversation: Prompt[];
}
export interface ToolLoopRun { readonly id: string; readonly done: Promise<ToolLoopResult>; cancel(): void }

function limitsOf(overrides: Partial<ToolLoopLimits> | undefined): ToolLoopLimits {
  const limits = { ...defaultLimits, ...overrides };
  for (const name of Object.keys(limits) as (keyof ToolLoopLimits)[]) {
    const value = limits[name];
    if (!Object.hasOwn(defaultLimits, name) || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw invalid();
  }
  if (limits.requests > 8 || limits.totalMs > 120000 || limits.requestMs > 60000 || limits.minimumMs < 2000 || limits.minimumMs > limits.requestMs) throw invalid();
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
function snapshotObject(value: unknown): ToolObject {
  if (!isObject(value)) throw invalid();
  const copy: ToolObject = {}, active = new Set<object>();
  type Container = ToolObject | unknown[];
  const jobs: ({ source: Container; target: Container } | { leave: object })[] = [{ source: value, target: copy }];
  // O(n) in the JSON tree size; iterative, each getter is read once, no toJSON callbacks.
  while (jobs.length) {
    const job = jobs.pop()!;
    if ('leave' in job) { active.delete(job.leave); continue; }
    const { source, target } = job;
    if (active.has(source)) throw invalid();
    const prototype = Object.getPrototypeOf(source);
    if (!Array.isArray(source) && prototype !== null && prototype !== Object.prototype) throw invalid();
    active.add(source); jobs.push({ leave: source });
    const keys = Array.isArray(source) ? Array.from({ length: source.length }, (_, index) => String(index)) : Object.keys(source);
    for (const key of keys) {
      const item: unknown = (source as ToolObject)[key];
      let next: unknown = item;
      if (item !== null && typeof item === 'object') {
        next = Array.isArray(item) ? [] : {};
        jobs.push({ source: item as Container, target: next as Container });
      } else if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))) throw invalid();
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
  const execute = async (): Promise<ToolLoopResult> => {
    let state: ToolLoopState = 'finished', stop: ToolLoopStop = 'http', error: string | null = null;
    let requests = 0, proposals = 0, lastProposal: LastProposal | null = null;
    let conversation: C | undefined, transcript: Prompt[] = [], transport: ToolTransport<C> | undefined;
    let transportName = 'json', failure = 'options_failed';
    let alive: (() => boolean) | undefined;
    const calls: ToolLoopResult['log']['calls'] = [];
    let activeCall: ToolLoopResult['log']['calls'][number] | null = null;
    const everPassed = new Set<string>(), confirmed = new Set<string>();
    let pendingConfirmation: Set<string> | null = null, usedConfirmation = false;
    const checkCancelled = () => {
      if (cancelled) return true;
      failure = 'alive_failed';
      const live = alive ? alive() : true;
      if (typeof live !== 'boolean') throw invalid();
      if (!live) cancelled = true;
      return cancelled;
    };
    try {
      transport = options.transport;
      transportName = transport.name;
      const send = options.send, now = options.now ?? (() => performance.now());
      const wait = options.wait ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
      alive = options.alive;
      const sentences = { ...options.sentences };
      if (typeof transportName !== 'string' || typeof send !== 'function' || typeof now !== 'function' || typeof wait !== 'function' ||
        (alive !== undefined && typeof alive !== 'function') || !['badFormat', 'malformed', 'withdrawal'].every(key => typeof sentences[key as keyof typeof sentences] === 'string')) throw invalid();
      const provider = options.provider;
      if (typeof provider.baseUrl !== 'string' || typeof provider.model !== 'string') throw invalid();
      // Preserve endpoint and model spelling. Tuple encoding avoids separator collisions.
      const providerKey = JSON.stringify([provider.baseUrl, provider.model]);
      const memory = options.jsonModeMemory ?? jsonModeMemory;
      const tools = new Map<string, ToolDefinition>();
      let proposalTools = 0;
      for (const entry of options.tools) {
        const tool = { name: entry.name, check: entry.check, execute: entry.execute, proposal: entry.proposal } as ToolDefinition;
        if (typeof tool.name !== 'string' || !tool.name || tools.has(tool.name) || typeof tool.check !== 'function' || typeof tool.execute !== 'function' ||
          (tool.proposal !== undefined && typeof tool.proposal !== 'boolean')) throw invalid();
        if (tool.proposal) proposalTools++;
        tools.set(tool.name, tool);
      }
      if (proposalTools > 1) throw invalid();
      failure = 'transport_failed';
      conversation = transport.open(options.system, options.input);
      let deadline: number | undefined, lastNow = -Infinity;
      let badFormats = 0, transportFailures = 0, correction: string | null = null;
      let previousCall: string | null = null, previousProposal: string | null = null;
      const clock = () => {
        failure = 'clock_failed';
        const time = now();
        if (!Number.isFinite(time) || time < 0 || time < lastNow || time > Number.MAX_SAFE_INTEGER - limits.totalMs) throw invalid();
        lastNow = time;
        return time;
      };
      const confirm = () => {
        if (pendingConfirmation) for (const item of pendingConfirmation) confirmed.add(item);
        pendingConfirmation = null;
      };
      for (;;) {
        if (checkCancelled()) break;
        failure = 'transport_failed';
        const messages = transport.messages(conversation, correction);
        failure = 'json_mode_memory_failed';
        const json = !memory.has(providerKey);
        // Include liveness callback time in the dispatch budget.
        if (checkCancelled()) break;
        const time = clock();
        deadline ??= time + limits.totalMs;
        const timeoutMs = Math.floor(Math.min(deadline - time, limits.requestMs));
        if (timeoutMs < limits.minimumMs) { stop = 'time'; break; }
        if (requests >= limits.requests) { stop = 'requests'; break; }
        // A clock callback may explicitly cancel the run too.
        if (cancelled) break;
        requests++;
        let raw: unknown, modelError: string | null = null;
        try { raw = await send(messages, json, timeoutMs); }
        catch (cause) { modelError = codeOf(cause); }
        if (checkCancelled()) break;
        if (modelError !== null) {
          error = modelError;
          if (modelError === 'model_http_400' && json) {
            failure = 'json_mode_memory_failed';
            memory.add(providerKey);
            // A complete HTTP rejection interrupts a transport-failure streak, not a format streak.
            transportFailures = 0;
            continue;
          }
          const http = /^model_http_(\d{3})$/.exec(modelError);
          const status = http ? Number(http[1]) : 0;
          if (['model_connection_failed', 'model_stream_failed', 'model_output_incomplete'].includes(modelError) || status === 408 || status === 429 || (status >= 500 && status <= 599)) {
            const remaining = deadline - clock();
            if (remaining <= 0) { stop = 'time'; break; }
            transportFailures++;
            if (transportFailures >= limits.transportFailures) { stop = 'transport'; break; }
            if (requests >= limits.requests) { stop = 'requests'; break; }
            failure = 'wait_failed';
            await wait(Math.min(limits.backoffMs * transportFailures, remaining, 2147483647));
            continue;
          }
          if (!['model_invalid_response', 'model_output_truncated', 'model_invalid_json'].includes(modelError)) { stop = 'http'; break; }
        }
        transportFailures = 0;
        failure = 'transport_failed';
        const decoded = modelError === null ? transport.decode(raw, limits.outputCharacters) : { kind: 'bad_format' as const };
        if (!decoded || (decoded.kind !== 'bad_format' && (decoded.kind !== 'call' || !isObject(decoded.value) || typeof decoded.raw !== 'string'))) throw invalid();
        if (decoded.kind === 'bad_format') {
          error = modelError ?? 'model_invalid_json';
          badFormats++;
          if (badFormats >= limits.badFormats) { stop = 'bad_format'; break; }
          correction = sentences.badFormat;
          continue;
        }
        badFormats = 0;
        correction = null;
        const value = decoded.value;
        const tool = typeof value.tool === 'string' ? tools.get(value.tool) : undefined;
        let issue: ToolIssue | null = !tool ? { path: 'tool', expected: 'known_tool' }
          : !isObject(value.args) ? { path: 'args', expected: 'object' } : null;
        if (tool && issue === null) {
          failure = 'check_failed';
          issue = tool.check(value.args as ToolObject);
          if (issue !== null) {
            if (!isObject(issue) || typeof issue.path !== 'string' || typeof issue.expected !== 'string') throw invalid();
            issue = { path: issue.path, expected: issue.expected };
          }
        }
        if (issue !== null) {
          previousCall = null;
          calls.push({ tool: tool?.name ?? null, argsSha256: null, status: 'call_malformed' });
          failure = 'transport_failed';
          transport.malformed(conversation, decoded.raw, issue, sentences.malformed, limits.replayCodePoints);
          continue;
        }
        failure = 'tool_failed';
        const args = snapshotObject(value.args), canonical = canonicalToolArgs(args).json;
        const call: ToolCall = { tool: tool!.name, args };
        const callKey = JSON.stringify(tool!.name) + ':' + canonical;
        const row = { tool: tool!.name, argsSha256: createHash('sha256').update(canonical).digest('hex'), status: 'ok' };
        calls.push(row);
        if (tool!.proposal && previousProposal === canonical) {
          confirm(); row.status = 'kept'; stop = 'kept'; break;
        }
        if (!tool!.proposal && previousCall === callKey) {
          row.status = 'repeated_call';
          failure = 'transport_failed';
          transport.answer(conversation, call, { ok: false, error: 'repeated_call' });
          continue;
        }
        previousCall = callKey;
        activeCall = row;
        failure = 'execute_failed';
        const output = await tool!.execute(snapshotObject(args));
        failure = 'tool_result_failed';
        let result: ToolObject;
        let finish = false;
        if (tool!.proposal) {
          if (!isObject(output)) throw invalid();
          const reply = output as unknown as ProposalReply;
          result = snapshotObject(reply.result);
          const items: ProposalItem[] = [], ids = new Set<string>();
          if (!Array.isArray(reply.items) || typeof reply.settled !== 'boolean') throw invalid();
          for (const item of reply.items) {
            if (!item || typeof item.id !== 'string' || !item.id || typeof item.passed !== 'boolean' || ids.has(item.id)) throw invalid();
            items.push({ id: item.id, passed: item.passed }); ids.add(item.id);
          }
          const withdrawn = lastProposal ? lastProposal.items.filter(item => !ids.has(item.id)).map(item => item.id) : [];
          const acceptedWithdrawal = lastProposal ? lastProposal.items.some(item => item.passed && !ids.has(item.id)) : false;
          confirm();
          for (const item of items) { if (item.passed) everPassed.add(item.id); confirmed.delete(item.id); }
          lastProposal = { args, result, items, settled: reply.settled };
          proposals++;
          previousProposal = canonical;
          result = { ...result };
          delete result.withdrawn;
          delete result.confirmation;
          if (withdrawn.length) result.withdrawn = withdrawn;
          if (reply.settled && acceptedWithdrawal && !usedConfirmation) {
            usedConfirmation = true;
            pendingConfirmation = new Set(withdrawn);
            result.confirmation = sentences.withdrawal;
          } else finish = reply.settled;
        } else result = snapshotObject(output);
        row.status = resultCode(result);
        activeCall = null;
        failure = 'transport_failed';
        transport.answer(conversation, call, result);
        if (finish) { stop = 'done'; break; }
      }
    } catch { state = 'failed'; error = failure; stop = 'http'; if (activeCall) activeCall.status = failure; }
    try {
      if (checkCancelled()) { state = 'cancelled'; error = 'cancelled'; stop = 'http'; }
      if (transport && conversation !== undefined) {
        failure = 'transport_failed';
        const messages = transport.transcript(conversation);
        if (!Array.isArray(messages)) throw invalid();
        transcript = messages.map(message => {
          const { role, content } = message;
          if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string') throw invalid();
          return { role, content };
        });
      }
      // Transcript extraction itself may call user code.
      if (checkCancelled()) { state = 'cancelled'; error = 'cancelled'; stop = 'http'; }
    } catch { state = cancelled ? 'cancelled' : 'failed'; error = cancelled ? 'cancelled' : failure; stop = 'http'; }
    const present = new Set(lastProposal?.items.map(item => item.id) ?? []);
    const withdrawn: string[] = [], dropped: string[] = [];
    for (const item of everPassed) if (!present.has(item)) (confirmed.has(item) ? withdrawn : dropped).push(item);
    const outcome: ToolLoopOutcome = state === 'finished' && (stop === 'done' || stop === 'kept') ? 'complete'
      : proposals > 0 ? 'partial' : state === 'finished' && (stop === 'requests' || stop === 'time') ? 'capped' : 'skipped';
    return { id, state, outcome, stop, error: outcome === 'complete' ? null : error, requests, proposals, lastProposal, withdrawn, dropped,
      log: { transport: transportName, requests, calls }, conversation: transcript };
  };
  return Object.freeze({ id, done: Promise.resolve().then(execute), cancel: () => { cancelled = true; } });
}
