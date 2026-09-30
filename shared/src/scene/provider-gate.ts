import { processingFailure } from './processing.ts';

/** Scheduling priority within one provider. */
export type GatePriority = 'foreground' | 'background';

/** Provider limits, backoff policy and injectable clock. */
export interface ProviderGateOptions {
  defaultLimit?: number;
  limits?: Record<string, number>;
  queueTimeoutMs?: number;
  cooldownBaseMs?: number;
  cooldownMaxMs?: number;
  recoverAfterSuccesses?: number;
  isRateLimited?(error: unknown): boolean;
  retryAfterMs?(error: unknown): number | undefined;
  now?(): number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** Per-call scheduling and cancellation options. */
export interface GateRunOptions {
  priority?: GatePriority;
  signal?: AbortSignal;
  queueTimeoutMs?: number;
  label?: string;
}

/** Detached counters for one provider. */
export interface ProviderGateStats {
  providerKey: string;
  configuredLimit: number;
  effectiveLimit: number;
  inFlight: number;
  queuedForeground: number;
  queuedBackground: number;
  started: number;
  completed: number;
  failed: number;
  rateLimited: number;
  timedOut: number;
  aborted: number;
  cooldownUntilMs: number | null;
  maxQueueWaitMs: number;
  totalQueueWaitMs: number;
}

interface QueuedTask {
  queuedAt: number;
  priority: GatePriority;
  start(): void;
  reject(error: unknown): void;
  cleanup(): void;
}

interface ProviderState {
  stats: ProviderGateStats;
  queue: QueuedTask[];
  consecutive429: number;
  successes: number;
  cooldownTimer: GateTimer | undefined;
}

interface GateTimer {
  cancel(): void;
}

function integerIn(value: unknown, min: number, max = Infinity): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Canonical HTTP origin without credentials, paths or model identity. */
export function providerKeyOf(config: { baseUrl: string }): string {
  try {
    const url = new URL(config.baseUrl.trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch { /* Report a stable error without exposing the URL. */ }
  throw new Error('invalid_provider_base_url');
}

/** Independent provider queues with foreground priority and adaptive limits. */
export class ProviderGate {
  private readonly options: Required<ProviderGateOptions>;
  private readonly providers = new Map<string, ProviderState>();
  private readonly closedError = new Error('provider_gate_closed');
  private closed = false;

  /** Validate and snapshot the policy without creating provider queues. */
  constructor(options: ProviderGateOptions = {}) {
    const invalid = () => { throw new Error('invalid_provider_gate_options'); };
    if (!options || typeof options !== 'object' || Array.isArray(options)) invalid();
    for (const key of ['defaultLimit', 'queueTimeoutMs', 'cooldownBaseMs', 'cooldownMaxMs', 'recoverAfterSuccesses'] as const) {
      const value = options[key];
      const min = key === 'defaultLimit' || key === 'recoverAfterSuccesses' ? 1 : 0;
      if (value !== undefined && !integerIn(value, min, key === 'defaultLimit' ? 32 : Infinity)) invalid();
    }
    if (options.limits !== undefined && (!options.limits || typeof options.limits !== 'object' ||
        Array.isArray(options.limits) || Object.values(options.limits).some(value => !integerIn(value, 1, 32)))) invalid();
    for (const key of ['isRateLimited', 'retryAfterMs', 'now', 'setTimer', 'clearTimer'] as const) {
      if (options[key] !== undefined && typeof options[key] !== 'function') invalid();
    }
    if ((options.cooldownMaxMs ?? 30000) < (options.cooldownBaseMs ?? 1000)) invalid();
    this.options = {
      defaultLimit: options.defaultLimit ?? 4,
      limits: { ...options.limits },
      queueTimeoutMs: options.queueTimeoutMs ?? 60000,
      cooldownBaseMs: options.cooldownBaseMs ?? 1000,
      cooldownMaxMs: options.cooldownMaxMs ?? 30000,
      recoverAfterSuccesses: options.recoverAfterSuccesses ?? 8,
      isRateLimited: options.isRateLimited ?? (error => processingFailure(error).kind === 'rate_limited'),
      retryAfterMs: options.retryAfterMs ?? (() => undefined),
      now: options.now ?? Date.now,
      setTimer: options.setTimer ?? ((callback, ms) => setTimeout(callback, ms)),
      clearTimer: options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    };
  }

  /** Schedule one task and preserve its result or rejection identity. */
  run<T>(providerKey: string, task: (signal: AbortSignal) => Promise<T>, options: GateRunOptions = {}): Promise<T> {
    if (typeof providerKey !== 'string' || providerKey.length === 0 || typeof task !== 'function' ||
        !options || typeof options !== 'object' || Array.isArray(options) ||
        (options.priority !== undefined && options.priority !== 'foreground' && options.priority !== 'background') ||
        (options.queueTimeoutMs !== undefined && !integerIn(options.queueTimeoutMs, 0))) {
      return Promise.reject(new Error('invalid_provider_gate_options'));
    }
    if (this.closed) return Promise.reject(this.closedError);
    const queuedAt = this.options.now();
    const state = this.provider(providerKey);
    const signal = options.signal ?? new AbortController().signal;
    const abortError = () => signal.reason instanceof Error ? signal.reason : new Error('provider_gate_aborted');
    if (signal.aborted) {
      state.stats.aborted++;
      return Promise.reject(abortError());
    }
    return new Promise<T>((resolve, reject) => {
      let timer: GateTimer | undefined;
      const remove = (error: Error, counter: 'aborted' | 'timedOut') => {
        const index = state.queue.indexOf(entry);
        if (index < 0) return;
        state.queue.splice(index, 1);
        entry.cleanup();
        state.stats[counter]++;
        reject(error);
      };
      const onAbort = () => remove(abortError(), 'aborted');
      const entry: QueuedTask = {
        queuedAt, priority: options.priority ?? 'foreground', reject,
        cleanup: () => {
          timer?.cancel();
          timer = undefined;
          signal.removeEventListener('abort', onAbort);
        },
        start: () => {
          // Catch synchronous task throws as well as asynchronous rejections.
          let result: Promise<T>;
          try { result = task(signal); }
          catch (error) { result = Promise.reject(error); }
          void Promise.resolve(result).then(value => {
            state.stats.completed++;
            state.consecutive429 = 0;
            state.successes++;
            if (state.successes >= this.options.recoverAfterSuccesses && state.stats.effectiveLimit < state.stats.configuredLimit) {
              state.stats.effectiveLimit++;
              state.successes = 0;
            }
            state.stats.inFlight--;
            resolve(value);
            this.drain(state);
          }, error => {
            state.stats.failed++;
            try {
              if (this.options.isRateLimited(error)) this.rateLimited(state, error);
            } finally {
              state.stats.inFlight--;
              reject(error);
              this.drain(state);
            }
          }).catch(() => { /* A policy callback must not create an unhandled rejection. */ });
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      state.queue.push(entry);
      const timeout = options.queueTimeoutMs ?? this.options.queueTimeoutMs;
      if (timeout > 0) timer = this.timerAt(queuedAt + timeout,
        () => remove(new Error('provider_gate_timeout'), 'timedOut'));
      this.drain(state);
    });
  }

  /** Change the configured cap while preserving an existing adaptive reduction. */
  setLimit(providerKey: string, limit: number): void {
    if (!integerIn(limit, 1, 32)) throw new Error('invalid_provider_gate_limit');
    const state = this.provider(providerKey);
    const stats = state.stats;
    stats.effectiveLimit = stats.effectiveLimit < stats.configuredLimit ? Math.min(stats.effectiveLimit, limit) : limit;
    stats.configuredLimit = limit;
    this.drain(state);
  }

  /** Return sorted snapshots without exposing mutable scheduler state. */
  stats(providerKey?: string): ProviderGateStats[] {
    const keys = providerKey === undefined ? [...this.providers.keys()].sort() : [providerKey];
    return keys.flatMap(key => {
      const state = this.providers.get(key);
      if (!state) return [];
      return [{ ...state.stats,
        queuedForeground: state.queue.filter(entry => entry.priority === 'foreground').length,
        queuedBackground: state.queue.filter(entry => entry.priority === 'background').length,
        cooldownUntilMs: this.cooling(state) ? state.stats.cooldownUntilMs : null,
      }];
    });
  }

  /** Reject queued and future calls while allowing running tasks to settle. */
  close(): void {
    this.closed = true;
    for (const state of this.providers.values()) {
      state.cooldownTimer?.cancel();
      state.cooldownTimer = undefined;
      for (const entry of state.queue.splice(0)) {
        entry.cleanup();
        entry.reject(this.closedError);
      }
    }
  }

  private provider(key: string): ProviderState {
    let state = this.providers.get(key);
    if (!state) {
      const limit = Object.hasOwn(this.options.limits, key) ? this.options.limits[key] : this.options.defaultLimit;
      state = {
        queue: [], consecutive429: 0, successes: 0, cooldownTimer: undefined,
        stats: { providerKey: key, configuredLimit: limit, effectiveLimit: limit, inFlight: 0,
          queuedForeground: 0, queuedBackground: 0, started: 0, completed: 0, failed: 0,
          rateLimited: 0, timedOut: 0, aborted: 0, cooldownUntilMs: null, maxQueueWaitMs: 0, totalQueueWaitMs: 0 },
      };
      this.providers.set(key, state);
    }
    return state;
  }

  private cooling(state: ProviderState): boolean {
    return state.stats.cooldownUntilMs !== null && state.stats.cooldownUntilMs > this.options.now();
  }

  private timerAt(deadline: number, callback: () => void): GateTimer {
    let handle: unknown;
    const arm = () => {
      // Long waits need multiple native timers without shortening the deadline.
      const delay = Math.min(2147483647, Math.max(0, deadline - this.options.now()));
      handle = this.options.setTimer(() => {
        if (this.options.now() < deadline) arm();
        else callback();
      }, delay);
    };
    arm();
    return { cancel: () => this.options.clearTimer(handle) };
  }

  private drain(state: ProviderState): void {
    while (!this.closed && !this.cooling(state) && state.stats.inFlight < state.stats.effectiveLimit && state.queue.length) {
      const foreground = state.queue.findIndex(entry => entry.priority === 'foreground');
      const entry = state.queue.splice(foreground < 0 ? 0 : foreground, 1)[0];
      entry.cleanup();
      const wait = this.options.now() - entry.queuedAt;
      state.stats.totalQueueWaitMs += wait;
      state.stats.maxQueueWaitMs = Math.max(state.stats.maxQueueWaitMs, wait);
      state.stats.inFlight++;
      state.stats.started++;
      entry.start();
    }
  }

  private rateLimited(state: ProviderState, error: unknown): void {
    const cooling = this.cooling(state);
    const consecutive429 = state.consecutive429 + 1;
    const base = this.options.cooldownBaseMs;
    let retryAfter: unknown;
    try { retryAfter = this.options.retryAfterMs(error); }
    catch { /* Invalid retry hints use the computed backoff. */ }
    const duration = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
      ? retryAfter : Math.min(this.options.cooldownMaxMs, base === 0 ? 0 : base * 2 ** (consecutive429 - 1));
    const until = this.options.now() + duration;
    state.stats.rateLimited++;
    state.consecutive429 = consecutive429;
    state.successes = 0;
    if (!cooling) state.stats.effectiveLimit = Math.max(1, Math.floor(state.stats.effectiveLimit / 2));
    state.stats.cooldownUntilMs = cooling ? Math.max(state.stats.cooldownUntilMs!, until) : until;
    state.cooldownTimer?.cancel();
    state.cooldownTimer = undefined;
    if (!this.closed && this.cooling(state)) {
      state.cooldownTimer = this.timerAt(state.stats.cooldownUntilMs, () => {
        state.cooldownTimer = undefined;
        state.stats.cooldownUntilMs = null;
        this.drain(state);
      });
    }
  }
}
