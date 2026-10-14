import {isDeepStrictEqual} from 'node:util';
import type {Configurations, ModelConfig} from '../core/types.ts';
import type {ToolLoopResult} from '../core/tool-loop.ts';
import {finishLedgerRun} from './ledger-stage.ts';
import type {LedgerFinished, startLedgerRun} from './ledger-stage.ts';
import type {LedgerInputRequest} from './ledger-stage-input.ts';
import {serializeLedger} from './world-ledger.ts';
import type {LedgerMarks, LedgerText, StoredLedger} from './world-ledger.ts';

/** Provisional per-source model-input cap, in UTF-16 code units, inclusive.
 * Measured fixtures reach 4,147 units; dense 5,000-character prose with six predecessors reaches 64,350.
 * Inputs starting at 214,060 units are outside this first service integration's budget.
 * Ordinary narrative inputs measured 99,570 units for 20,026 characters and 197,861 for 40,018 characters.
 * Depending on number density, ordinary prose also exceeds this cap around 14,000–26,000 characters. */
export const LEDGER_INPUT_UTF16_LIMIT = 131072;

/** Provisional per-source stored-record cap, in UTF-16 code units, inclusive.
 * Eight ordinary entries measured 16,373–18,049 units; a 512-leaf proof measured 346,710.
 * Oversized records get exactly one retry with facts=null before rejection. */
export const LEDGER_RECORD_UTF16_LIMIT = 131072;

/** Cache payload version for the eight caller-owned fields; older or unknown versions are misses. */
export const LEDGER_CACHE_SCHEMA = 1;

/** User-source foreground budget in milliseconds, inclusive of work after arrival at the ledger step.
 * Product policy selects 45 seconds independently of the run's request and duration limits. */
export const LEDGER_FOREGROUND_USER_MS = 45000;

/** Assistant-source foreground budget in milliseconds, inclusive of work after arrival at the ledger step.
 * Product policy selects 45 seconds independently of the user-source budget and the run's limits. */
export const LEDGER_FOREGROUND_ASSISTANT_MS = 45000;

/** Optional loop clock and wait in monotonic nonnegative milliseconds. Null/nonfunctions use platform defaults.
 * Foreground timer members are used as a pair; an invalid pair uses the platform timers at call time. */
export interface LedgerTiming {
  now?: (() => number) | null;
  wait?: ((milliseconds: number) => Promise<void>) | null;
  setTimeout?: typeof globalThis.setTimeout | null;
  clearTimeout?: typeof globalThis.clearTimeout | null;
}

/** Internal service-only configuration. The numeric gate 4 is captured once at construction.
 * A missing/throwing selector means no configuration; returned objects reach the core unchanged. */
export interface LedgerStageOptions {
  gate?: unknown;
  selectConfig?: ((configurations: Configurations) => ModelConfig | null) | null;
  timing?: LedgerTiming | null;
}

/** Binding required for reuse; marks compare by content, while model configuration deliberately is excluded. */
export interface LedgerRunBinding {
  revision: number;
  pin: string;
  base: string;
  marks: LedgerMarks | null;
}

/** Settled caller result. A null record retains its exact loop termination and log for an interrupted substitute. */
export interface LedgerRunResult {
  ledger: StoredLedger | null;
  finished: LedgerFinished | null;
  loop: ToolLoopResult | null;
  issue: 'finish' | 'record' | 'run' | null;
}

/** Accepted-source context and a count of send invocations owned by one run, including synchronous failures.
 * It carries no response content; the counter starts at zero and never resets on reuse or parking. */
export interface LedgerRunContext {
  source: LedgerText;
  selection: LedgerInputRequest['selection'];
  requests: number;
}

/** Linear cursor over predecessors already processed in one job; the deferred flag is sticky within that job.
 * Index is a source count starting at zero; the cursor never reads storage or interprets record contents. */
export interface LedgerProgress {
  index: number;
  deferred: boolean;
}

/** Registry entry with process-local monotone identity; done never rejects and cancellation is sticky. */
export interface LedgerRunEntry extends LedgerRunBinding {
  id: bigint;
  scope: string;
  sourceId: string;
  fingerprint: string;
  started: NonNullable<ReturnType<typeof startLedgerRun>>;
  cancelled: boolean;
  done: Promise<void>;
  result: LedgerRunResult | null;
  context?: LedgerRunContext;
  deferred: boolean;
}

/** Per-source step data, held only until the existing job assembles its analysis.
 * Optional persisted keys are omitted, never explicitly undefined or null. */
export interface LedgerStep {
  marks?: LedgerMarks;
  ledger?: StoredLedger;
  entry?: LedgerRunEntry;
  arrivedAt?: number | null;
  deferred?: 'timeout' | 'waiting';
  notice?: string;
  fallback?: {
    source: LedgerText;
    selection: LedgerInputRequest['selection'];
    pin: string | null;
    base: string;
    fingerprint: string;
  };
  issue?: string;
  details?: string[];
}

function containsUndefined(value: unknown): boolean {

  if (value === undefined)
    return true;

  if (value === null || typeof value !== 'object')
    return false;

  return Object.keys(value).some(key => containsUndefined((value as Record<string, unknown>)[key]));
}

/** Apply only the four service submission checks. Returns the original record unless facts must be dropped.
 * Size is measured after serialization, identity is top-level only, and invalid/unreadable input returns null. */
export function checkedLedger(
  value: unknown,
  sourceId: string,
  revision: number
): StoredLedger | null {

  try {

    let ledger = value as StoredLedger;
    let serialized = serializeLedger(ledger);

    if (!serialized.ok)
      return null;

    if (serialized.value.length > LEDGER_RECORD_UTF16_LIMIT) {

      ledger = {
        ...ledger,
        facts: null
      };
      serialized = serializeLedger(ledger);

      if (!serialized.ok || serialized.value.length > LEDGER_RECORD_UTF16_LIMIT)
        return null;
    }

    // References inside entries legitimately address earlier sources; only each row's owner is constrained here.
    if ([...ledger.entries, ...ledger.unbooked].some(
      row => row.sourceId !== sourceId || row.revision !== revision
    )) {

      return null;
    }

    if (containsUndefined(ledger))
      return null;

    return ledger;
  } catch {

    return null;
  }
}

function nonarrayObject(value: unknown): value is Record<string, unknown> {

  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a cache row's closed eight-field shape, four reuse bindings, and record checks.
 * All absent/null fields or throwing getters are misses; extra transcript contents are not interpreted. */
export function cachedLedger(
  value: unknown,
  binding: LedgerRunBinding,
  sourceId: string
): StoredLedger | null {

  try {

    if (!nonarrayObject(value))
      return null;

    const fields = [
      'schema',
      'revision',
      'pin',
      'base',
      'marks',
      'ledger',
      'conversation',
      'ignoredFactRefs'
    ];

    if (fields.some(field => !Object.hasOwn(value, field)))
      return null;

    const {schema, revision, pin, base, marks, ledger, conversation, ignoredFactRefs} = value;

    if (schema !== LEDGER_CACHE_SCHEMA || !Number.isInteger(revision) || typeof pin !== 'string'
      || typeof base !== 'string'
      || !nonarrayObject(marks)
      || !nonarrayObject(ledger)
      || !Array.isArray(conversation)
      || !Array.isArray(ignoredFactRefs))
      return null;

    if (revision !== binding.revision || pin !== binding.pin || base !== binding.base
      || !isDeepStrictEqual(marks, binding.marks))
      return null;

    return checkedLedger(ledger, sourceId, binding.revision);
  } catch {

    return null;
  }
}

/** In-memory runs, at most one per (full scope key, source id).
 * Committed deferred sources retain their runs until completion; other successful commits remove entries.
 * Thus each scope is bounded by accepted sources with an uncommitted run, including still-running failed jobs.
 * No timer, task, worker, or database activity occurs at construction. */
export class LedgerRuns {
  private readonly entries = new Map<string, LedgerRunEntry>();
  private sequence = 0n;

  /** Number of live or retained entries, for bounded-work diagnostics; this does not start or wait for anything. */
  get size(): number {

    return this.entries.size;
  }

  private key(scope: string, sourceId: string): string {

    return JSON.stringify([scope, sourceId]);
  }

  /** Return a matching entry; a mismatch is cancelled and removed before the caller reads any cache row. */
  reuse(
    scope: string,
    sourceId: string,
    binding: LedgerRunBinding
  ): LedgerRunEntry | null {

    const key = this.key(scope, sourceId);
    const entry = this.entries.get(key);

    if (!entry)
      return null;

    if (!entry.cancelled && entry.revision === binding.revision && entry.pin === binding.pin
      && entry.base === binding.base
      && isDeepStrictEqual(entry.marks, binding.marks))
      return entry;

    this.remove(entry);

    return null;
  }

  /** Register an already-created run and attach its never-rejecting completion immediately.
   * The save callback may only persist cache data; any callback failure cannot alter the retained loop result. */
  register(
    scope: string,
    sourceId: string,
    binding: LedgerRunBinding,
    fingerprint: string,
    started: NonNullable<ReturnType<typeof startLedgerRun>>,
    save: (entry: LedgerRunEntry) => void,
    context?: LedgerRunContext | null,

  ): LedgerRunEntry {

    const entry: LedgerRunEntry = {
      ...binding,
      id: ++this.sequence,
      scope,
      sourceId,
      fingerprint,
      started,
      cancelled: false,
      done: Promise.resolve(),
      result: null,
      deferred: false,
      ...(context == null ? {} : {context}),
    };

    this.entries.set(this.key(scope, sourceId), entry);
    entry.done = started.run.done.then(
      loop => {

        const finished = finishLedgerRun(started.handle, loop);
        const ledger = finished ? checkedLedger(finished.ledger, sourceId, entry.revision) : null;

        entry.result = {
          ledger,
          finished,
          loop,
          issue: !finished ? 'finish' : !ledger ? 'record' : null
        };

        this.saveCompleted(entry, save);
      }
    ).catch(
      () => {

        // A failed cache write cannot erase the valid loop outcome, and must never become an unhandled rejection.
        if (!entry.result) {

          entry.result = {
            ledger: null,
            finished: null,
            loop: null,
            issue: 'run'
          };

          try {

            this.saveCompleted(entry, save);
          } catch {
            // A failed detached cache write cannot reject the completion promise.
          }
        }
      }
    );

    return entry;
  }

  /** Save once at completion; only a successfully parked source permits a null-result substitute.
   * Detachment happens even if the caller cannot write the cache. */
  private saveCompleted(entry: LedgerRunEntry, save: (entry: LedgerRunEntry) => void): void {

    try {

      if (entry.result?.ledger || entry.deferred)
        save(entry);
    } finally {

      if (entry.deferred)
        this.detach(entry);
    }
  }

  /** Detach only this exact identity without cancelling a completed run. */
  private detach(entry: LedgerRunEntry): void {

    const key = this.key(entry.scope, entry.sourceId);

    if (this.entries.get(key) === entry)
      this.entries.delete(key);
  }

  /** Cancel the source's current entry synchronously, including a completed retained entry; missing keys do nothing. */
  cancel(scope: string, sourceId: string): void {

    const entry = this.entries.get(this.key(scope, sourceId));

    if (entry)
      this.remove(entry);
  }

  /** Identity check for late completion: equal fingerprints do not make an obsolete run current. */
  isCurrent(entry: LedgerRunEntry): boolean {

    return !entry.cancelled && this.entries.get(this.key(entry.scope, entry.sourceId)) === entry;
  }

  /** Cancel and detach one exact entry. A newer entry with the same external key is never removed. */
  remove(entry: LedgerRunEntry): void {

    entry.cancelled = true;
    entry.started.run.cancel();

    const key = this.key(entry.scope, entry.sourceId);

    if (this.entries.get(key) === entry)
      this.entries.delete(key);
  }

  /** Apply a successful source commit. Deferred identities stay alive until completion; others are cancelled.
   * If completion preceded this commit, only a missing record needs a new cache attempt. */
  committed(
    scope: string,
    sources: readonly {id: string; revision: number;}[],
    deferred?: ReadonlySet<string> | null,
    save?: ((entry: LedgerRunEntry) => void) | null,
  ): void {

    for (const source of sources) {

      const entry = this.entries.get(this.key(scope, source.id));

      if (entry?.revision !== source.revision)
        continue;

      if (!deferred?.has(source.id)) {

        this.remove(entry);

        continue;
      }

      entry.deferred = true;

      if (entry.result) {

        try {

          if (!entry.result.ledger)
            save?.(entry);
        } finally {

          this.detach(entry);
        }
      }
    }
  }

  /** Remove deleted/revised sources at the end of a pending job, retaining same-revision failed work. */
  prune(scope: string, accepted: ReadonlyMap<string, number>): void {

    for (const entry of this.entries.values()) {

      if (entry.scope === scope && accepted.get(entry.sourceId) !== entry.revision)
        this.remove(entry);
    }
  }
}
