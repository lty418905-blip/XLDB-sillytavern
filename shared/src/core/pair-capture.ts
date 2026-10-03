import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelRunner, Prompt } from './models.ts';
import type { ModelConfig } from './types.ts';

export const PAIR_CAPTURE_FORMAT = 'xldb.pair-capture';
export const PAIR_CAPTURE_VERSION = 1;
export const PAIR_CAPTURE_DEFAULTS = Object.freeze({ maxRecords: 2000, maxBytes: 268435456 });
export const PAIR_CAPTURE_LIMITS = Object.freeze({
  maxRecords: Object.freeze({ min: 1, max: 100000 }),
  maxBytes: Object.freeze({ min: 1, max: 2147483647 }),
});
export const PAIR_CAPTURE_ERROR_CODE = Object.freeze(/^(model_[a-z_]+(?:_\d{3})?|invalid_[a-z_]+|context_changed_retry|(?:embedding|rerank)_request_failed)$/);

export interface PairCaptureOptions {
  root: string;
  runId: string;
  maxRecords?: number;
  maxBytes?: number;
  now?: () => number;
  writerId?: string;
  address?: () => unknown;
}
export interface PairCaptureStatus {
  enabled: boolean;
  state: 'disabled' | 'active' | 'capped' | 'failed';
  runId: string | null;
  file: string | null;
  records: number;
  bytes: number;
  written: number;
  dropped: number;
  error: string | null;
}
export interface PairCapture {
  readonly enabled: boolean;
  wrap(run: ModelRunner): ModelRunner;
  status(): PairCaptureStatus;
}

const instances = new WeakSet<PairCapture>();
let installed: PairCapture | null = null;
const optionKeys = ['root', 'runId', 'maxRecords', 'maxBytes', 'now', 'writerId', 'address'];
const invalid = () => Object.assign(new Error('invalid_pair_capture_options'), { code: 'invalid_pair_capture_options' });
const runPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function safely<T>(read: () => T): T | null {
  try { return read(); } catch { return null; }
}
const field = (value: unknown, key: string): unknown => safely(() => value == null ? null : (value as Record<string, unknown>)[key]);
const string = (value: unknown) => typeof value === 'string' ? value : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function pairCaptureFile(root: string, runId: string): string {
  if (typeof root !== 'string' || root.includes('\0') || !path.isAbsolute(root) || typeof runId !== 'string' || !runPattern.test(runId)) throw invalid();
  const file = path.join(root, '.local', 'evidence', 'behaviour', runId, 'pairs.jsonl');
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw invalid();
  return file;
}

function addressSnapshot(read?: () => unknown) {
  const source = safely(() => read?.());
  const value = object(source) ? source : null;
  const scope = safely(() => {
    const sourceScope = field(value, 'scope');
    if (!object(sourceScope)) return null;
    const worldId = string(field(sourceScope, 'worldId'));
    const sessionId = string(field(sourceScope, 'sessionId'));
    const branchId = string(field(sourceScope, 'branchId'));
    const characterId = string(field(sourceScope, 'characterId'));
    return worldId !== null && sessionId !== null && branchId !== null && characterId !== null
      ? { worldId, sessionId, branchId, characterId } : null;
  });
  const parts = safely(() => {
    const sourceParts = field(value, 'parts');
    if (!Array.isArray(sourceParts)) return null;
    const copy = Array.from(sourceParts);
    return copy.every(part => typeof part === 'string') ? copy as string[] : null;
  });
  return {
    operation: string(field(value, 'operation')),
    requestId: string(field(value, 'requestId')),
    bindingId: string(field(value, 'bindingId')),
    scope,
    sourceId: string(field(value, 'sourceId')),
    revision: count(field(value, 'revision')),
    stage: string(field(value, 'stage')),
    characterId: string(field(value, 'characterId')),
    roundId: string(field(value, 'roundId')),
    parts,
    attempt: count(field(value, 'attempt')),
  };
}

function clock(now: () => number) {
  return safely(() => {
    const ms = now();
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    return { ms, at: new Date(ms).toISOString() };
  });
}

function entering(config: ModelConfig, prompts: Prompt[], json: boolean, now: () => number, address?: () => unknown) {
  const start = clock(now);
  const location = safely(() => addressSnapshot(address)) ?? addressSnapshot();
  const model = string(field(config, 'model'));
  const thinkingValue = field(config, 'thinking');
  const thinking = thinkingValue === 'enabled' || thinkingValue === 'disabled' ? thinkingValue : null;
  const key = string(field(config, 'key'));
  const baseUrl = string(field(config, 'baseUrl'))?.trim().replace(/\/+$/, '') ?? null;
  const secrets = [...new Set([key, baseUrl].filter((value): value is string => value !== null && value.length >= 8))].sort((a, b) => b.length - a.length);
  let redactions = 0;
  const redact = (text: string) => {
    for (const secret of secrets) {
      const pieces = text.split(secret);
      redactions += pieces.length - 1;
      text = pieces.join('[redacted]');
    }
    return text;
  };
  const savedPrompts = safely(() => Array.isArray(prompts) ? Array.from(prompts, prompt => {
    if (typeof prompt !== 'object' || prompt === null) return { role: null, content: null };
    const role = string(field(prompt, 'role'));
    const content = string(field(prompt, 'content'));
    return { role, content: content === null ? null : redact(content) };
  }) : null);
  if (savedPrompts === null) redactions = 0;
  return { start, location, model, thinking, json: typeof json === 'boolean' ? json : null,
    prompts: savedPrompts, redact, redactions: () => redactions };
}

/**
 * Opt-in local test evidence. Existing lines are counted once per instance;
 * multiple writers can collectively exceed the limits. Unsettled calls leave no line.
 */
export function createPairCapture(options: PairCaptureOptions | null | undefined): PairCapture {
  if (options == null) {
    const disabled: PairCapture = Object.freeze({ enabled: false, wrap: (run: ModelRunner) => run,
      status: () => ({ enabled: false, state: 'disabled' as const, runId: null, file: null,
        records: 0, bytes: 0, written: 0, dropped: 0, error: null }) });
    instances.add(disabled);
    return disabled;
  }
  const settings = (() => {
    try {
      if (!object(options) || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !optionKeys.includes(key))) throw invalid();
      const root = options.root;
      if (typeof root !== 'string' || root.includes('\0') || !path.isAbsolute(root)) throw invalid();
      if (!fs.statSync(root).isDirectory()) throw invalid();
      const runId = options.runId;
      const file = pairCaptureFile(root, runId);
      const { maxRecords = PAIR_CAPTURE_DEFAULTS.maxRecords, maxBytes = PAIR_CAPTURE_DEFAULTS.maxBytes } = options;
      for (const [value, bounds] of [[maxRecords, PAIR_CAPTURE_LIMITS.maxRecords], [maxBytes, PAIR_CAPTURE_LIMITS.maxBytes]] as const) {
        if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max) throw invalid();
      }
      const { now = Date.now, address, writerId = randomUUID() } = options;
      if (typeof now !== 'function' || (address !== undefined && typeof address !== 'function') || typeof writerId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(writerId)) throw invalid();
      return { root, runId, maxRecords, maxBytes, now, writerId, address, file };
    } catch { throw invalid(); }
  })();
  let state: PairCaptureStatus['state'] = 'active';
  let records = 0, bytes = 0, written = 0, dropped = 0, seq = 1;
  let error: string | null = null;
  let prepared = false;
  const fail = (cause: unknown) => {
    state = 'failed';
    const code = field(cause, 'code');
    error = typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : 'write_failed';
  };
  const prepare = () => {
    if (prepared) return;
    fs.mkdirSync(path.dirname(settings.file), { recursive: true });
    if (fs.existsSync(settings.file)) {
      const existing = fs.readFileSync(settings.file);
      if (existing.length > 0 && existing[existing.length - 1] !== 10) throw new Error('write_failed');
      bytes = existing.length;
      records = existing.reduce((total, byte) => total + (byte === 10 ? 1 : 0), 0);
    }
    prepared = true;
  };
  const append = (line: string, lineBytes: number) => {
    fs.appendFileSync(settings.file, line, 'utf8');
    records += 1;
    bytes += lineBytes;
    seq += 1;
  };
  const settle = (snapshot: ReturnType<typeof entering>, outcome: 'ok' | 'error', value: unknown) => {
    if (state === 'capped') { dropped += 1; return; }
    if (state === 'failed') return;
    try {
      const end = clock(settings.now);
      const output = outcome === 'ok' && typeof value === 'string' ? snapshot.redact(value) : null;
      const message = value instanceof Error ? string(field(value, 'message')) : null;
      const record = {
        format: PAIR_CAPTURE_FORMAT, version: PAIR_CAPTURE_VERSION, type: 'pair', writer: settings.writerId, seq,
        at: end?.at ?? null,
        durationMs: end !== null && snapshot.start !== null && end.ms >= snapshot.start.ms ? Math.round(end.ms - snapshot.start.ms) : null,
        address: snapshot.location, model: snapshot.model, thinking: snapshot.thinking, json: snapshot.json,
        prompts: snapshot.prompts, outcome, output,
        error: outcome === 'error' ? message !== null && PAIR_CAPTURE_ERROR_CODE.test(message) ? message : 'operation_failed' : null,
        redactions: snapshot.redactions(),
      };
      const line = JSON.stringify(record) + '\n';
      const lineBytes = Buffer.byteLength(line, 'utf8');
      prepare();
      const limit = records >= settings.maxRecords ? 'records' : bytes + lineBytes > settings.maxBytes ? 'bytes' : null;
      if (limit !== null) {
        dropped += 1;
        state = 'capped';
        const marker = JSON.stringify({ format: PAIR_CAPTURE_FORMAT, version: PAIR_CAPTURE_VERSION, type: 'cap_reached',
          writer: settings.writerId, seq, at: end?.at ?? null, limit }) + '\n';
        append(marker, Buffer.byteLength(marker, 'utf8'));
      } else {
        append(line, lineBytes);
        written += 1;
      }
    } catch (cause) { fail(cause); }
  };
  const capture: PairCapture = Object.freeze({
    enabled: true,
    wrap: (run: ModelRunner): ModelRunner => (config, prompts, json) => {
      if (state === 'failed') return run(config, prompts, json);
      if (state === 'capped') { dropped += 1; return run(config, prompts, json); }
      const snapshot = entering(config, prompts, json, settings.now, settings.address);
      let result: ReturnType<ModelRunner>;
      try { result = run(config, prompts, json); } catch (cause) { result = Promise.reject(cause); }
      return result.then(value => { settle(snapshot, 'ok', value); return value; },
        cause => { settle(snapshot, 'error', cause); throw cause; });
    },
    status: () => ({ enabled: true, state, runId: settings.runId,
      file: `.local/evidence/behaviour/${settings.runId}/pairs.jsonl`, records, bytes, written, dropped, error }),
  });
  instances.add(capture);
  return capture;
}

export function capturingRunner(run: ModelRunner, current: () => PairCapture | null | undefined): ModelRunner {
  return (config, prompts, json) => {
    const capture = safely(current);
    return capture?.enabled === true ? capture.wrap(run)(config, prompts, json) : run(config, prompts, json);
  };
}
export function installPairCapture(capture: PairCapture | null): PairCapture | null {
  if (capture !== null && !instances.has(capture)) throw invalid();
  const previous = installed;
  installed = capture;
  return previous;
}
export function activePairCapture(): PairCapture | null { return installed; }
