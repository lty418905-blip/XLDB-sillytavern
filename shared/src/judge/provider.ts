import * as nodeFs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {JUDGE_CALL_SITES, JUDGE_CALL_SITE_SPECS, JUDGE_LANE_TIMEOUT_MS, judgeQuestionSpec} from './call-sites.ts';
import type {JudgeCallSite, JudgeSiteGroup, JudgeLane} from './call-sites.ts';
import {SYSTEMONE_PATH, JUDGE_LIMITS, JUDGE_MODEL_PATTERN, validateJudgeRequest, buildSystemoneBody, parseSystemoneAnswers, parseRetryAfterMs, utcDayKey, redactSecret, judgeWireType} from './systemone.ts';
import type {JudgeAnswer, JudgeWireType} from './systemone.ts';
import {JUDGE_PROVIDER_IDS, JUDGE_PROVIDER_PRESETS, validateJudgeBaseUrl} from './providers.ts';
import type {JudgeRemoteProvider} from './providers.ts';
import {JUDGE_QUOTA_SCHEMA, judgeQuotaKey, readJudgeQuotaFile, mergeJudgeQuotaModel, pruneJudgeQuotaFile, writeJudgeQuotaFile} from './quota-file.ts';
import type {JudgeNeedsUserStatus, JudgeQuotaFs, JudgeQuotaFile} from './quota-file.ts';
import {JUDGE_STATE_WRAPPER_VERSION} from './state-wrapper.ts';
export type JudgeProviderKind = 'none' | JudgeRemoteProvider;
export interface JudgeConfig {provider: JudgeProviderKind; baseUrl?: string; model?: string; apiKey?: string; dailyLimit?: number | null; sites?: Partial<Record<JudgeCallSite, boolean>>}
export type JudgeConfigureResult = {ok: true} | {ok: false; error: 'invalid_config' | 'invalid_provider' | 'invalid_base_url' | 'invalid_model' | 'invalid_key' | 'invalid_daily_limit' | 'invalid_sites'};
export interface JudgeFetchResponse {status: number; headers: {get(name: string): string | null}; text(): Promise<string>}
export type JudgeFetch = (url: string, init: {method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal}) => Promise<JudgeFetchResponse>;
export interface JudgeTimers {setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void}
export interface JudgeProviderOptions {fetch?: JudgeFetch; now?: () => number; timers?: JudgeTimers; quotaPath?: string | null; fs?: JudgeQuotaFs; writerId?: string; config?: JudgeConfig; audit?: (record: JudgeAuditRecord) => void}
export type JudgeGateReason = 'clock_error' | 'not_configured' | 'site_locked' | 'site_disabled' | 'needs_user' | 'rate_limit_window' | 'budget_shed';
export type JudgeFailureReason = JudgeGateReason | 'invalid_request' | 'internal_error' | 'http_401' | 'http_402' | 'http_403' | 'http_404' | 'http_429' | 'http_4xx' | 'http_5xx' | 'http_other' | 'timeout' | 'network' | 'bad_response';
export interface JudgeAuditRecord {
  readonly callSite: JudgeCallSite;
  readonly provider: JudgeRemoteProvider;
  readonly requestedModel: string;
  readonly resolvedModel: string | null;
  readonly wrapperVersion: string;
  readonly questions: readonly {readonly id: string; readonly version: string; readonly wireType: JudgeWireType}[];
  readonly outcome: 'ok' | JudgeFailureReason;
  readonly httpStatus: number | null;
  readonly attempts: 1 | 2;
  readonly atMs: number;
  readonly latencyMs: number;
}
export type JudgeResult =
  | {ok: true; callSite: JudgeCallSite; model: string; answers: Readonly<Record<string, JudgeAnswer>>; attempts: 1 | 2; latencyMs: number; audit: JudgeAuditRecord}
  | {ok: false; callSite: string; reason: JudgeFailureReason; httpStatus: number | null; attempts: 0 | 1 | 2; detail: string | null; audit: JudgeAuditRecord | null};
export interface JudgeSiteStatus {id: JudgeCallSite; group: JudgeSiteGroup; lane: JudgeLane; priority: number; enabled: boolean; locked: boolean; usable: boolean; blockedBy: JudgeGateReason | null}
export interface JudgeStatus {
  provider: JudgeProviderKind; baseUrl: string | null; model: string | null; keyConfigured: boolean;
  keySlotsConfigured: Readonly<Record<JudgeRemoteProvider, boolean>>; dailyLimit: number | null;
  nowMs: number | null; day: string | null;
  usage: {own: number; others: number; effective: number; remaining: number | null; percent: number | null};
  blockedUntilMs: number | null;
  needsUser: {status: JudgeNeedsUserStatus; sinceMs: number; nextRetryAtMs: number} | null;
  sharedNeedsUser: JudgeNeedsUserStatus[];
  lastFailure: {callSite: string; reason: JudgeFailureReason; httpStatus: number | null; atMs: number} | null;
  lastSuccessAtMs: number | null;
  sites: JudgeSiteStatus[];
  file: {path: string | null; lastRead: 'ok' | 'missing' | 'error' | null; lastReadError: string | null; lastWrite: 'ok' | 'error' | null; lastWriteError: string | null};
  inFlight: number;
}
export interface JudgeProvider {configure(config: unknown): JudgeConfigureResult; setSiteEnabled(site: unknown, enabled: unknown): boolean; evaluate(request: unknown): Promise<JudgeResult>; status(): JudgeStatus}
type Memory = {own: {day: string; n: number; atMs: number}; blockedUntilMs: number | null; others: number; othersNeedsUser: JudgeNeedsUserStatus[]};
const HOUR = 3600000;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function networkCode(error: unknown, key: string): string {
  try {
    const e = error as {cause?: {code?: unknown}; code?: unknown; name?: unknown};
    for (const v of [e?.cause?.code, e?.code, e?.name]) if (typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v)) return key !== '' && v.toLowerCase().includes(key.toLowerCase()) ? 'network_error' : v;
  } catch { /* 回呼可能回傳無法讀取的錯誤。 */ }
  return 'network_error';
}
export function createJudgeProvider(options: JudgeProviderOptions = {}): JudgeProvider {
  const invalid = () => {throw new Error('invalid_judge_provider_options');};
  if (!record(options)) invalid();
  const fetchFn = options.fetch === undefined ? globalThis.fetch : options.fetch;
  const nowFn = options.now === undefined ? Date.now : options.now;
  const timers = options.timers === undefined ? {setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)} : options.timers;
  const fs = options.fs === undefined ? nodeFs : options.fs;
  const quotaPath = options.quotaPath ?? null;
  const writerId = options.writerId === undefined ? 'w' + randomUUID().replaceAll('-', '').slice(0, 16) : options.writerId;
  if (typeof fetchFn !== 'function' || typeof nowFn !== 'function' || !record(timers) || typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function'
    || (quotaPath !== null && (typeof quotaPath !== 'string' || !quotaPath || !path.isAbsolute(quotaPath)))
    || !fs || ['readFileSync', 'writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync'].some(k => typeof (fs as unknown as Record<string, unknown>)[k] !== 'function')
    || typeof writerId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(writerId) || (options.audit !== undefined && typeof options.audit !== 'function')) invalid();
  const slots: Record<JudgeRemoteProvider, string | null> = {'opencode-zen': null, typesafe: null};
  let provider: JudgeProviderKind = 'none', baseUrl: string | null = null, model: string | null = null, dailyLimit: number | null = null, configEpoch = 0;
  const enabled = Object.fromEntries(JUDGE_CALL_SITES.map(id => [id, JUDGE_CALL_SITE_SPECS[id].defaultEnabled])) as Record<JudgeCallSite, boolean>;
  const memories = new Map<string, Memory>();
  let needsUser: JudgeStatus['needsUser'] = null, lastFailure: JudgeStatus['lastFailure'] = null, lastSuccessAtMs: number | null = null, inFlight = 0, sequence = 0;
  const file: JudgeStatus['file'] = {path: quotaPath, lastRead: null, lastReadError: null, lastWrite: null, lastWriteError: null};
  function clock(): number | null {try {const n = nowFn(); return utcDayKey(n) !== null ? n : null;} catch {return null;} }
  const later = (start: number) => clock() ?? start;
  function memory(key: string, now: number): Memory {
    const today = utcDayKey(now)!;
    let m = memories.get(key);
    if (!m) {m = {own: {day: today, n: 0, atMs: now}, blockedUntilMs: null, others: 0, othersNeedsUser: []}; memories.set(key, m);}
    if (m.own.day !== today) {m.own = {day: today, n: 0, atMs: now}; m.others = 0; m.othersNeedsUser = [];}
    return m;
  }
  // REVIEW-2 R1：24 小時合法視窗加 1 小時對時回退寬容，超過才丟棄。
  function discardOversizedWindow(model: {blockedUntilMs: number | null}, now: number): void {
    if (model.blockedUntilMs !== null && model.blockedUntilMs > now + 86400000 + HOUR) model.blockedUntilMs = null;
  }
  function read(now: number): ReturnType<typeof readJudgeQuotaFile> {
    const r = readJudgeQuotaFile(quotaPath!, fs);
    file.lastRead = r.ok ? r.file === null ? 'missing' : 'ok' : 'error';
    file.lastReadError = r.ok ? null : r.error;
    if (r.ok && r.file !== null) for (const model of Object.values(r.file.models)) discardOversizedWindow(model, now);
    return r;
  }
  function refresh(key: string, now: number): void {
    const m = memory(key, now);
    discardOversizedWindow(m, now);
    if (quotaPath === null) return;
    const r = read(now);
    if (!r.ok) return;
    const shared = r.file?.models[key];
    const writers = Object.entries(shared?.writers ?? {}).filter(([id, w]) => id !== writerId && w.day === m.own.day);
    m.others = writers.reduce((n, [, w]) => n + w.n, 0);
    m.othersNeedsUser = [...new Set(writers.map(([, w]) => w.needsUser).filter((v): v is JudgeNeedsUserStatus => v !== null))].sort((a, b) => a - b);
    if (shared?.blockedUntilMs !== null && shared?.blockedUntilMs !== undefined) m.blockedUntilMs = Math.max(m.blockedUntilMs ?? 0, shared.blockedUntilMs);
  }
  function persist(key: string, now: number, epoch: number): void {
    if (quotaPath === null) return;
    const m = memory(key, now), r = read(now);
    discardOversizedWindow(m, now);
    const base: JudgeQuotaFile = r.ok && r.file !== null ? r.file : {schema: JUDGE_QUOTA_SCHEMA, models: {}};
    base.models[key] = mergeJudgeQuotaModel(base.models[key] ?? null, {writerId, writer: {day: m.own.day, n: m.own.n, atMs: now, needsUser: epoch === configEpoch ? needsUser?.status ?? null : null}, blockedUntilMs: m.blockedUntilMs});
    const cleaned = pruneJudgeQuotaFile(base, key, writerId, m.own.day, now);
    const result = writeJudgeQuotaFile(quotaPath, cleaned, writerId + '-' + (++sequence), fs);
    file.lastWrite = result.ok ? 'ok' : 'error'; file.lastWriteError = result.ok ? null : result.error;
  }
  function configure(config: unknown): JudgeConfigureResult {
    try {
      if (!record(config)) return {ok: false, error: 'invalid_config'};
      const p = config.provider;
      if (p !== 'none' && !JUDGE_PROVIDER_IDS.includes(p as JudgeRemoteProvider)) return {ok: false, error: 'invalid_provider'};
      const nextProvider = p as JudgeProviderKind;
      let nextBase: string | null = null, nextModel: string | null = null, nextKey: string | null = null, limit: number | null;
      if (nextProvider !== 'none') {
        const preset = JUDGE_PROVIDER_PRESETS[nextProvider];
        const baseInput = config.baseUrl;
        nextBase = baseInput === undefined ? preset.defaultBaseUrl : validateJudgeBaseUrl(baseInput);
        if (nextBase === null) return {ok: false, error: 'invalid_base_url'};
        const modelInput = config.model;
        const candidate = modelInput === undefined ? preset.defaultModel : modelInput;
        if (typeof candidate !== 'string' || !JUDGE_MODEL_PATTERN.test(candidate)) return {ok: false, error: 'invalid_model'};
        nextModel = candidate; nextKey = slots[preset.keySlot];
        const keyInput = config.apiKey;
        if (keyInput !== undefined) {
          if (typeof keyInput !== 'string') return {ok: false, error: 'invalid_key'};
          const key = keyInput.trim();
          if (key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key)) return {ok: false, error: 'invalid_key'};
          nextKey = key === '' ? null : key;
        }
        const limitInput = config.dailyLimit;
        limit = limitInput === undefined ? Object.hasOwn(preset.freeDailyLimits, candidate) ? preset.freeDailyLimits[candidate] : null : limitInput as number | null;
      } else {
        const limitInput = config.dailyLimit;
        limit = limitInput === undefined ? null : limitInput as number | null;
      }
      if (limit !== null && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000000)) return {ok: false, error: 'invalid_daily_limit'};
      const sitesInput = config.sites;
      const updates = sitesInput === undefined ? {} : sitesInput;
      const updateEntries = record(updates) ? Object.entries(updates) : null;
      if (updateEntries === null || updateEntries.some(([id, v]) => !Object.hasOwn(enabled, id) || typeof v !== 'boolean' || (JUDGE_CALL_SITE_SPECS[id as JudgeCallSite].locked && v))) return {ok: false, error: 'invalid_sites'};
      const oldKey = provider === 'none' ? null : slots[JUDGE_PROVIDER_PRESETS[provider].keySlot];
      if (provider !== nextProvider || baseUrl !== nextBase || model !== nextModel || oldKey !== nextKey) {needsUser = null; configEpoch++;}
      if (nextProvider === 'none') {slots['opencode-zen'] = null; slots.typesafe = null;}
      else slots[JUDGE_PROVIDER_PRESETS[nextProvider].keySlot] = nextKey;
      provider = nextProvider; baseUrl = nextBase; model = nextModel; dailyLimit = limit;
      for (const [id, v] of updateEntries) enabled[id as JudgeCallSite] = v as boolean;
      return {ok: true};
    } catch {return {ok: false, error: 'invalid_config'};}
  }
  function setSiteEnabled(site: unknown, value: unknown): boolean {
    if (typeof site !== 'string' || !Object.hasOwn(enabled, site) || typeof value !== 'boolean') return false;
    if (JUDGE_CALL_SITE_SPECS[site as JudgeCallSite].locked && value) return false;
    enabled[site as JudgeCallSite] = value; return true;
  }
  function gate(id: JudgeCallSite, now: number | null, m: Memory | undefined): JudgeGateReason | null {
    const spec = JUDGE_CALL_SITE_SPECS[id];
    if (now === null) return 'clock_error';
    if (provider === 'none' || slots[JUDGE_PROVIDER_PRESETS[provider].keySlot] === null) return 'not_configured';
    if (spec.locked) return 'site_locked';
    if (!enabled[id]) return 'site_disabled';
    if (needsUser !== null && now < needsUser.nextRetryAtMs) return 'needs_user';
    if (m?.blockedUntilMs !== null && m?.blockedUntilMs !== undefined && now < m.blockedUntilMs) return 'rate_limit_window';
    if (dailyLimit !== null && spec.shedAtPercent !== null && ((m?.own.n ?? 0) + (m?.others ?? 0)) * 100 >= spec.shedAtPercent * dailyLimit) return 'budget_shed';
    return null;
  }
  function failure(callSite: string, reason: JudgeFailureReason, start: number | null, detail: string | null = null): JudgeResult {
    if (start !== null && !['clock_error', 'invalid_request', 'not_configured', 'site_locked', 'site_disabled'].includes(reason)) lastFailure = {callSite, reason, httpStatus: null, atMs: later(start)};
    return {ok: false, callSite, reason, httpStatus: null, attempts: 0, detail, audit: null};
  }
  function evaluate(input: unknown): Promise<JudgeResult> {
    let callSite = '';
    let start: number | null = null;
    try {
      if (record(input) && typeof input.callSite === 'string') callSite = input.callSite.slice(0, 64);
      start = clock();
      if (start === null) return Promise.resolve(failure(callSite, 'clock_error', null));
      const validated = validateJudgeRequest(input);
      if (!validated.ok) return Promise.resolve(failure(callSite, 'invalid_request', start, validated.detail));
      const request = validated.request, id = request.callSite, spec = JUDGE_CALL_SITE_SPECS[id];
      if (provider === 'none' || slots[JUDGE_PROVIDER_PRESETS[provider].keySlot] === null) return Promise.resolve(failure(callSite, 'not_configured', start));
      if (spec.locked) return Promise.resolve(failure(callSite, 'site_locked', start));
      if (!enabled[id]) return Promise.resolve(failure(callSite, 'site_disabled', start));
      const activeProvider = provider, activeBase = baseUrl!, activeModel = model!, preset = JUDGE_PROVIDER_PRESETS[activeProvider], key = slots[preset.keySlot]!, epoch = configEpoch, started = start;
      const quotaKey = judgeQuotaKey(activeProvider, activeModel)!;
      refresh(quotaKey, started);
      const m = memory(quotaKey, started), reason = gate(id, started, m);
      if (reason) return Promise.resolve(failure(callSite, reason, started));
      return new Promise<JudgeResult>(resolve => {
        let settled = false, attempts: 0 | 1 | 2 = 0, handle: unknown, timerInstalled = false, counted = false;
        let httpStatus: number | null = null, pendingHttp: JudgeFailureReason | null = null, resolvedModel: string | null = null;
        const controller = new AbortController();
        function finish(outcome: 'ok' | JudgeFailureReason, detail: string | null = null, answers?: Readonly<Record<string, JudgeAnswer>>): void {
          if (settled) return;
          settled = true;
          if (timerInstalled) {try {timers.clearTimeout(handle);} catch { /* 定案不受清理回呼失敗影響。 */ }}
          if (counted) inFlight--;
          const end = later(started), latencyMs = Math.max(0, end - started);
          if (outcome === 'ok') {
            if (epoch === configEpoch && needsUser !== null) {needsUser = null; persist(quotaKey, end, epoch);}
            lastSuccessAtMs = end;
          } else lastFailure = {callSite: id, reason: outcome, httpStatus, atMs: end};
          let audit: JudgeAuditRecord | null = null;
          if (attempts >= 1) {
            audit = Object.freeze({callSite: id, provider: activeProvider, requestedModel: activeModel, resolvedModel,
              wrapperVersion: JUDGE_STATE_WRAPPER_VERSION,
              questions: Object.freeze(request.questions.map(q => Object.freeze({id: q.id, version: q.version, wireType: judgeWireType(judgeQuestionSpec(id, q.id)!.type, preset.questionTypes)!}))),
              outcome, httpStatus, attempts: attempts as 1 | 2, atMs: started, latencyMs});
          }
          const result: JudgeResult = outcome === 'ok'
            ? {ok: true, callSite: id, model: activeModel, answers: answers!, attempts: attempts as 1 | 2, latencyMs, audit: audit!}
            : {ok: false, callSite: id, reason: outcome, httpStatus, attempts, detail, audit};
          if (audit !== null) {try {options.audit?.(audit);} catch { /* 接收器只收一次，不影響結果。 */ }}
          resolve(result);
        }
        async function run(): Promise<void> {
          try {
            while (!settled && attempts < 2) {
              const attemptNow = later(started);
              const current = memory(quotaKey, attemptNow);
              attempts = (attempts + 1) as 1 | 2;
              current.own.n += 1; current.own.atMs = attemptNow;
              persist(quotaKey, attemptNow, epoch);
              httpStatus = null; pendingHttp = null; resolvedModel = null;
              try {
                const response = await fetchFn(activeBase + SYSTEMONE_PATH, {method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json', authorization: 'Bearer ' + key}, body: buildSystemoneBody(activeModel, request, preset.questionTypes), signal: controller.signal});
                if (settled) return;
                const status = response?.status;
                if (!Number.isInteger(status) || status < 100 || status > 599) {finish('bad_response', 'status_invalid'); return;}
                httpStatus = status;
                if (status < 200 || status >= 300) {
                  pendingHttp = [401, 402, 403, 404, 429].includes(status) ? 'http_' + status as JudgeFailureReason : status >= 500 ? 'http_5xx' : status >= 400 ? 'http_4xx' : 'http_other';
                  const now = later(started);
                  if ([401, 402, 403, 404].includes(status) && epoch === configEpoch) {
                    needsUser = {status: status as JudgeNeedsUserStatus, sinceMs: needsUser?.sinceMs ?? now, nextRetryAtMs: attemptNow + HOUR};
                    persist(quotaKey, now, epoch);
                  }
                  if (status === 429) {
                    let retry: unknown = null;
                    try {retry = response.headers.get('retry-after');} catch { /* 缺少可讀標頭時用預設視窗。 */ }
                    current.blockedUntilMs = Math.max(current.blockedUntilMs ?? 0, now + parseRetryAfterMs(retry, now));
                    persist(quotaKey, now, epoch);
                  }
                  const text = await response.text();
                  if (settled) return;
                  let message: unknown = text;
                  try {const b: unknown = JSON.parse(text); if (record(b) && record(b.error) && typeof b.error.message === 'string') message = b.error.message;} catch { /* 純文字本文也是 detail。 */ }
                  finish(pendingHttp, redactSecret(message, key)); return;
                }
                const text = await response.text();
                if (settled) return;
                if (typeof text !== 'string' || text.length > JUDGE_LIMITS.maxResponseChars) {finish('bad_response', 'response_too_long'); return;}
                let body: unknown;
                try {body = JSON.parse(text);} catch {finish('bad_response', 'invalid_json'); return;}
                if (record(body) && typeof body.model === 'string' && JUDGE_MODEL_PATTERN.test(body.model) && !body.model.toLowerCase().includes(key.toLowerCase())) resolvedModel = body.model;
                const parsed = parseSystemoneAnswers(request, body, preset.questionTypes);
                if (!parsed.ok) {finish('bad_response', parsed.detail); return;}
                finish('ok', null, parsed.answers); return;
              } catch (error) {
                if (settled) return;
                if (pendingHttp !== null) {finish(pendingHttp); return;}
                if (attempts === 2) {finish('network', networkCode(error, key)); return;}
              }
            }
          } catch {finish('internal_error');}
        }
        try {
          handle = timers.setTimeout(() => {if (settled) return; resolvedModel = null; finish(pendingHttp ?? 'timeout'); controller.abort();}, JUDGE_LANE_TIMEOUT_MS[spec.lane]);
          timerInstalled = true;
          if (settled) {timers.clearTimeout(handle); return;}
          inFlight++; counted = true;
          if (needsUser !== null) needsUser.nextRetryAtMs = started + HOUR;
          void run();
        } catch {finish('internal_error');}
      });
    } catch {return Promise.resolve(failure(callSite, 'internal_error', start));}
  }
  function status(): JudgeStatus {
    const nowMs = clock(), day = nowMs === null ? null : utcDayKey(nowMs), quotaKey = provider === 'none' ? null : judgeQuotaKey(provider, model!);
    if (quotaKey !== null && nowMs !== null) refresh(quotaKey, nowMs);
    const m = quotaKey === null ? undefined : memories.get(quotaKey);
    const own = m?.own.n ?? 0, others = m?.others ?? 0, effective = own + others;
    return {provider, baseUrl, model, keyConfigured: provider !== 'none' && slots[JUDGE_PROVIDER_PRESETS[provider].keySlot] !== null,
      keySlotsConfigured: {'opencode-zen': slots['opencode-zen'] !== null, typesafe: slots.typesafe !== null}, dailyLimit, nowMs, day,
      usage: {own, others, effective, remaining: dailyLimit === null ? null : Math.max(0, dailyLimit - effective), percent: dailyLimit === null ? null : Math.floor(effective * 100 / dailyLimit)},
      blockedUntilMs: nowMs !== null && m?.blockedUntilMs !== null && m?.blockedUntilMs !== undefined && nowMs < m.blockedUntilMs ? m.blockedUntilMs : null,
      needsUser: needsUser === null ? null : {...needsUser}, sharedNeedsUser: [...(m?.othersNeedsUser ?? [])], lastFailure: lastFailure === null ? null : {...lastFailure}, lastSuccessAtMs,
      sites: JUDGE_CALL_SITES.map(id => {const s = JUDGE_CALL_SITE_SPECS[id], blockedBy = gate(id, nowMs, m); return {id, group: s.group, lane: s.lane, priority: s.priority, enabled: enabled[id], locked: s.locked, usable: blockedBy === null, blockedBy};}),
      file: {...file}, inFlight};
  }
  if (!configure(options.config === undefined ? {provider: 'none'} : options.config).ok) invalid();
  return {configure, setSiteEnabled, evaluate, status};
}
