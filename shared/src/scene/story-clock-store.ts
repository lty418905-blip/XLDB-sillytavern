import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {scopeKey} from '../core/types.ts';
import type {StoryLanguage} from '../memory/text-units.ts';
import type {SceneScope,SceneSource,SceneState} from './types.ts';
import type {SceneReference} from './transfer.ts';
import type {WorldEffectReceipt,WorldFoldResult,WorldRunningStep,WorldSettings} from './world-state.ts';
import {initialStoryAnchor} from './story-initial-clock.ts';
import {STORY_CLOCK_RULE_V1,foldStoryClock,legacyStoryClockShiftMs,storyClockFromParts,storyClockParts,storyClockView} from './story-clock.ts';
import {STORY_CLOCK_CORRECTION_KINDS,STORY_CLOCK_DEGRADE_REASONS,STORY_CLOCK_RULE_VERSION,STORY_CLOCK_TIMES_OF_DAY,
  STORY_CLOCK_UNIX_EPOCH_MS} from './story-clock-types.ts';
import type {StoryClockAnalysis,StoryClockCorrection,StoryClockDate,StoryClockDegradeReason,StoryClockFoldInput,
  StoryClockFoldResult,StoryClockFoldSource,StoryClockIssue,StoryClockLegacyAnchor,StoryClockLegacyEffect,StoryClockMs,
  StoryClockSourceInput,StoryClockSourceRef,StoryClockState,StoryClockTime,StoryClockTimeOfDay,StoryClockView} from './story-clock-types.ts';

/**
 * The unified story clock of one roleplay scope (slice SC3a; DESIGN-behaviour-layer.md section 17). The clock value is
 * never stored: every reading is the SC0 fold of the accepted sources and the stored corrections. Legacy time is the
 * old Unix-domain value; the two domains are never added, subtracted or compared with each other.
 * No process, worker, timer or I/O other than the authority's SQLite handle (ruling 41).
 */
export interface StoryClockReading {
  /** SEMANTICS section 6.10 termination states. */
  status: 'settled' | 'settled_with_issues' | 'waiting';
  input: StoryClockFoldInput;
  /** SC0 output; callers must not mutate it. */
  result: StoryClockFoldResult;
  /** storyClockView(result.state, result.dayOneStartMs). */
  view: StoryClockView | null;
}

export interface StoryClockSummary {
  clockRule: number;
  status: StoryClockReading['status'];
  state: StoryClockState;
  originAtMs: StoryClockMs;
  dayOneStartMs: StoryClockMs;
  view: StoryClockView | null;
  pending: boolean;
}

/** What `worldSettings(scope)` returned, and the inputs of the derived anchor when no row is stored. */
export interface StoryClockLegacySettings {
  /** Exactly worldSettings(scope): merged with the initialization assets; derived with the live zone without a row. */
  settings: WorldSettings | null;
  /** True iff a row exists in scene_world_settings. */
  stored: boolean;
  /** Filled only when `settings` is non-null and `stored` is false. */
  references: readonly SceneReference[];
  liveZone: string | null;
}

/** Closures from SceneAuthority, like PhysiologyStore. */
export interface StoryClockDependencies {
  state: (scope: SceneScope) => SceneState;
  isStoryScope: (scope: SceneScope) => boolean;
  tavernRoleplay: (scope: SceneScope) => boolean;
  /** The world fold over `sources` with exactly the given (merged, live-zone) settings. */
  worldFold: (scope: SceneScope, sources: SceneSource[], settings: WorldSettings) => WorldFoldResult;
  /**
   * Aligned with `sources`: entry i is the legacy world time and the first issue code (null without one) of
   * worldFold(scope, sources.slice(0, i + 1), settings), from one pass. Throws what worldFold throws for the settings.
   */
  worldRunning: (scope: SceneScope, sources: SceneSource[], settings: WorldSettings) => readonly WorldRunningStep[];
  legacySettings: (scope: SceneScope) => StoryClockLegacySettings;
  /** Creation time of a roleplay scope without world settings (today's frozen time), else undefined. */
  frozenRoleplayTime: (scope: SceneScope) => number | undefined;
  /** Runs after every correction write, delete or restore: OpenHer snapshots, version, derived projections. */
  afterCorrection: (scope: SceneScope) => void;
}

/** The legacy emotion times of the prefixes of one timeline; made by StoryClockStore.legacyTimeline. */
export interface StoryClockLegacyTimeline {
  /** legacyTimeMs(scope, [], fallbackMs, timeline). */
  initial: (fallbackMs: number) => number;
  /** legacyTimeMs(scope, timeline.slice(0, index + 1), fallbackMs, timeline); a RangeError for an index outside the timeline. */
  at: (index: number, fallbackMs: number) => number;
}

export interface PersistedStoryClockCorrectionRow {
  id: string;
  seq: number;
  created: number;
  sourceId: string;
  sourceRevision: number;
  kind: string;
  body: string;
}

export interface StoryClockOriginValue {
  date: StoryClockDate | null;
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
}

/** The legacy start of a story world, from which the fold's anchor is taken when the opening source is legacy. */
export interface StoryClockLegacyOrigin {
  stored: boolean;
  /** The settings' startTimeMs: the stored row's, or the live-zone derivation. */
  startTimeMs: number;
  /** Creation time of the scene (R8: a stored start equal to it was never dated). */
  createdAtMs: number;
  liveZone: string | null;
  /** The old rule for one zone; used for derived settings only. */
  derive: (timeZone: string) => {startTimeMs: number; dated: boolean; timeKnown: boolean} | null;
}

export interface StoryClockFoldInputArgs {
  /** The whole source list the caller works on; only accepted sources enter the fold. */
  timeline: readonly SceneSource[];
  tavernRoleplay: boolean;
  /** Receipts of the merged-settings world fold over the timeline; empty without a story world. */
  receipts: readonly WorldEffectReceipt[];
  /** Null when worldSettings(scope) is null or not mode 'story'. */
  legacy: StoryClockLegacyOrigin | null;
  /** Stored corrections, decoded; malformed rows passed through. */
  corrections: readonly unknown[];
}

const TABLE = `CREATE TABLE IF NOT EXISTS scene_story_clock_corrections (
  scope TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, created INTEGER NOT NULL,
  source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(scope,id), UNIQUE(scope,seq));`;
const ROW_COLUMNS = 'id,seq,created,source_id AS sourceId,source_revision AS sourceRevision,kind,body';
const MEMO_LIMIT = 32;

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
const refKey = (sourceId: string, revision: number) => JSON.stringify([sourceId, revision]);

/** The clock input of one source: the first matching row of the SC3a card, section 2.3. */
function sourceClock(source: SceneSource, effects: readonly StoryClockLegacyEffect[]): StoryClockSourceInput {
  if (source.processing === 'pending') return {kind: 'pending'};
  const analysis: unknown = source.analysis;
  if (isObject(analysis) && Object.hasOwn(analysis, 'storyClock')) {
    const value = analysis.storyClock;
    if (isObject(value) && value.kind === 'degraded') {
      const reason = (STORY_CLOCK_DEGRADE_REASONS as readonly unknown[]).includes(value.reason)
        ? value.reason as StoryClockDegradeReason : 'failed';
      return {kind: 'degraded', reason, issues: Array.isArray(value.issues) ? value.issues as StoryClockIssue[] : []};
    }
    // A value left over from an earlier revision or attempt is never this revision's analysis.
    if (source.processing === 'failed') return {kind: 'degraded', reason: 'failed', issues: []};
    return {kind: 'analysis', analysis: value as StoryClockAnalysis};
  }
  return {kind: 'legacy', effects};
}

/** Which row of section 2.3 an accepted source falls under. */
export function storyClockSourceKind(source: SceneSource): StoryClockSourceInput['kind'] {
  return sourceClock(source, []).kind;
}

/** Pure: the complete, text-free SC0 input of one timeline. */
export function buildStoryClockFoldInput(args: StoryClockFoldInputArgs): StoryClockFoldInput {
  const effects = new Map<string, StoryClockLegacyEffect[]>();
  for (const receipt of args.receipts) {
    if (receipt.applied !== true) continue;
    const effect: StoryClockLegacyEffect | null =
      receipt.kind === 'clock_advance' ? {kind: 'advance', deltaMs: receipt.clockDeltaMs!, quote: receipt.quote}
      : receipt.kind === 'clock_absolute' ? {kind: 'absolute', setUnixMs: receipt.clockSetMs!, quote: receipt.quote}
      : null;
    if (!effect) continue;
    const key = refKey(receipt.sourceId, receipt.revision);
    const list = effects.get(key);
    if (list) list.push(effect); else effects.set(key, [effect]);
  }
  const accepted = args.timeline.filter(source => source.status === 'accepted');
  const sources: StoryClockFoldSource[] = accepted.map(source => ({sourceId: source.id, revision: source.revision,
    role: source.role, clock: sourceClock(source, effects.get(refKey(source.id, source.revision)) ?? [])}));

  let legacyAnchor: StoryClockLegacyAnchor | null = null;
  const legacy = args.legacy;
  if (legacy && sources[0]?.clock.kind === 'legacy') {
    // The anchor zone is the opening's own stored zone, never the live interaction zone (R7).
    const anchorZone = accepted[0]!.acceptedTimeZone ?? 'UTC';
    if (legacy.stored) {
      const dated = legacy.startTimeMs !== legacy.createdAtMs;
      legacyAnchor = {startTimeMs: legacy.startTimeMs, timeZone: anchorZone, datedByRule: dated, timeKnown: dated};
    } else {
      let timeZone = anchorZone, derived = legacy.derive(anchorZone);
      // The card's wall time does not exist in the anchor zone (or Intl rejects it): the derivation worldSettings made.
      if (!derived && legacy.liveZone !== null) { timeZone = legacy.liveZone; derived = legacy.derive(timeZone); }
      legacyAnchor = derived
        ? {startTimeMs: derived.startTimeMs, timeZone, datedByRule: derived.dated, timeKnown: derived.timeKnown}
        : {startTimeMs: legacy.startTimeMs, timeZone, datedByRule: false, timeKnown: false};
    }
  }
  return {tavernRoleplay: args.tavernRoleplay, legacyAnchor, sources, corrections: args.corrections as StoryClockCorrection[]};
}

/** N27: an age or elapsed span on the story clock is never negative. */
export function storyElapsedMs(fromMs: number, toMs: number): number {
  return typeof fromMs === 'number' && typeof toMs === 'number' && Number.isFinite(fromMs) && Number.isFinite(toMs)
    ? Math.max(0, toMs - fromMs) : 0;
}

// Appendix A of the SC3a card (wording verdict, final): copied verbatim, not to be extended or reworded.
const ZH_SLOTS: Record<StoryClockTimeOfDay, string> = {dawn: '清晨', morning: '早上', noon: '中午', afternoon: '下午',
  dusk: '傍晚', evening: '晚上', night: '夜里', late_night: '深夜'};
const EN_SLOTS: Record<StoryClockTimeOfDay, string> = {dawn: 'early morning', morning: 'morning', noon: 'midday',
  afternoon: 'afternoon', dusk: 'early evening', evening: 'evening', night: 'night', late_night: 'late night'};
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

/**
 * The character-facing clock line. It shows the date only for a dated or month_day clock and the slot only when the
 * time of day is known; never a day number, a clock time, milliseconds or a field name. The slot is hedged only for
 * basis 'fallback'. Empty for a null view, an unknown slot and a relative clock with unknown time of day.
 */
export function storyClockLine(view: StoryClockView | null, language: StoryLanguage): string {
  if (!view) return '';
  const en = language === 'en';
  let date = '';
  if ((view.kind === 'dated' || view.kind === 'month_day') && view.date) {
    const month = EN_MONTHS[view.date.month - 1];
    if (month === undefined) return '';
    const year = view.kind === 'dated' ? view.date.year : null;
    date = en ? `${view.date.day} ${month}${year === null ? '' : ` ${year}`}`
      : `${year === null ? '' : `${year}年`}${view.date.month}月${view.date.day}日`;
  }
  let slot = '';
  if (view.timeOfDay !== null) {
    if (!Object.hasOwn(ZH_SLOTS, view.timeOfDay)) return '';
    // The hour chooses between the two late_night labels and is never printed.
    const small = view.timeOfDay === 'late_night' && view.time !== null && view.time.hour < 5;
    const label = small ? (en ? 'the middle of the night' : '凌晨') : (en ? EN_SLOTS : ZH_SLOTS)[view.timeOfDay];
    slot = (view.basis === 'fallback' ? (en ? 'probably ' : '大概是') : '') + label;
  }
  if (!date && !slot) return '';
  return en ? `\nCurrent time in the story: ${date}${date && slot ? ', ' : ''}${slot}.`
    : `\n现在的剧情时间：${date}${date && slot ? '，' : ''}${slot}。`;
}

function hasTable(db: DatabaseSync): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_story_clock_corrections'").get();
}

/** Read-only capture for lifecycle checkpoints; a database without the table has no rows. */
export function captureStoryClockCorrectionRows(db: DatabaseSync, scope: SceneScope): PersistedStoryClockCorrectionRow[] {
  if (!hasTable(db)) return [];
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM scene_story_clock_corrections WHERE scope=? ORDER BY seq`)
    .all(scopeKey(scope)) as unknown as PersistedStoryClockCorrectionRow[];
}

/** Replaces every row of the scope; ids, seq and created are kept. Any code that deletes a scope calls it with []. */
export function restoreStoryClockCorrectionRows(db: DatabaseSync, scope: SceneScope,
  rows: readonly PersistedStoryClockCorrectionRow[]): void {
  db.exec(TABLE);
  const key = scopeKey(scope);
  db.prepare('DELETE FROM scene_story_clock_corrections WHERE scope=?').run(key);
  const insert = db.prepare(`INSERT INTO scene_story_clock_corrections
    (scope,id,seq,created,source_id,source_revision,kind,body) VALUES(?,?,?,?,?,?,?,?)`);
  for (const row of rows) insert.run(key, row.id, row.seq, row.created, row.sourceId, row.sourceRevision, row.kind, row.body);
}

/** A stored row as a fold correction; a row with an unknown kind or an unparseable body is passed through malformed. */
function decodeCorrection(row: PersistedStoryClockCorrectionRow): unknown {
  const base = {correctionId: row.id, seq: row.seq, createdAtMs: row.created,
    binding: {sourceId: row.sourceId, revision: row.sourceRevision}, kind: row.kind};
  if (!(STORY_CLOCK_CORRECTION_KINDS as readonly string[]).includes(row.kind)) return base;
  try {
    const body: unknown = JSON.parse(row.body);
    return isObject(body) ? {...body, ...base} : base;
  } catch { return base; }
}

function originValueOf(value: unknown): StoryClockOriginValue | null {
  if (!isObject(value)) return null;
  const {date, time, timeOfDay} = value;
  if (date !== null && !(isObject(date) && (date.year === null || typeof date.year === 'number') &&
    storyClockFromParts({year: (date.year as number | null) ?? STORY_CLOCK_RULE_V1.referenceYear, month: date.month as number,
      day: date.day as number}, {hour: 0, minute: 0}) !== null)) return null;
  if (time !== null && !(isObject(time) &&
    storyClockFromParts({year: 2000, month: 1, day: 1}, time as unknown as StoryClockTime) !== null)) return null;
  if (timeOfDay !== null && !(STORY_CLOCK_TIMES_OF_DAY as readonly unknown[]).includes(timeOfDay)) return null;
  return {
    date: date === null ? null : {year: date.year as number | null, month: date.month as number, day: date.day as number},
    time: time === null ? null : {hour: time.hour as number, minute: time.minute as number},
    timeOfDay: timeOfDay as StoryClockTimeOfDay | null,
  };
}

interface ReadingIndex { explicit: Map<string, number>; at: Map<string, StoryClockMs> }

export class StoryClockStore {
  private readonly db: DatabaseSync;
  private readonly deps: StoryClockDependencies;
  private folds = 0;
  /** Sound only for an array that is never assigned to, pushed to or spliced after the call. */
  private readonly byTimeline = new WeakMap<readonly SceneSource[], {stamp: string; reading: StoryClockReading}>();
  private readonly byInput = new Map<string, StoryClockReading>();
  private readonly indexes = new WeakMap<StoryClockReading, ReadingIndex>();

  constructor(db: DatabaseSync, deps: StoryClockDependencies) {
    this.db = db;
    this.deps = deps;
    db.exec(TABLE);
  }

  /** Calls of foldStoryClock so far; read by the cost test only. */
  get foldCount(): number { return this.folds; }

  /** Null iff the scope is not a story scope. */
  read(scope: SceneScope, state: SceneState = this.deps.state(scope)): StoryClockReading | null {
    return this.fold(scope, state.sources, this.deps.legacySettings(scope), state);
  }

  summary(scope: SceneScope, state?: SceneState): StoryClockSummary | null {
    const reading = this.read(scope, state);
    return reading && {clockRule: reading.result.clockRule, status: reading.status, state: reading.result.state,
      originAtMs: reading.result.originAtMs, dayOneStartMs: reading.result.dayOneStartMs, view: reading.view,
      pending: reading.result.pending};
  }

  /** The final-timeline clock value after one accepted source revision, or null when the reading has no such source. */
  atSource(reading: StoryClockReading, ref: StoryClockSourceRef): StoryClockMs | null {
    return this.indexOf(reading).at.get(refKey(ref.sourceId, ref.revision)) ?? null;
  }

  /** The fold of a given source list with the stored corrections; memoised by array identity, then by input hash. */
  readTimeline(scope: SceneScope, timeline: SceneSource[]): StoryClockReading | null {
    return this.fold(scope, timeline, this.deps.legacySettings(scope));
  }

  /**
   * legacyEmotionTime = E0 + X (Unix domain; OpenHer only until OH3). E0 is the old world time over `sources` and
   * throws invalid_world_<code> on a world issue. X is the explicit cue movement of the 'analysis' sources in
   * `sources`, read from the one fold of the whole `timeline`.
   */
  legacyTimeMs(scope: SceneScope, sources: SceneSource[], fallbackMs: number, timeline: SceneSource[] = sources): number {
    const legacy = this.deps.legacySettings(scope);
    return this.legacyBaseMs(scope, sources, fallbackMs, legacy.settings) + this.explicitMs(scope, sources, timeline, legacy);
  }

  /**
   * The legacy emotion time of every prefix of one timeline, for one synchronous caller. `at(index, fallbackMs)` is
   * legacyTimeMs(scope, timeline.slice(0, index + 1), fallbackMs, timeline) and `initial(fallbackMs)` is
   * legacyTimeMs(scope, [], fallbackMs, timeline): the same number, or the same error at the same call. The settings
   * are derived once, the legacy world is folded once over the whole timeline and the clock reading is taken once,
   * each on first need. List bookkeeping is O(timeline.length), in addition to deriving settings, the running fold
   * (including state and purchase-index copies), and the clock reading. Later at calls use O(1) lookups; initial
   * still computes the empty-prefix base, and a scope without settings still reads its frozen time on each call.
   * Nothing is kept on this store. The returned object
   * keeps what it has read, so its caller uses it inside one synchronous call, with `timeline` unchanged, and drops it.
   */
  legacyTimeline(scope: SceneScope, timeline: SceneSource[]): StoryClockLegacyTimeline {
    const length = timeline.length;
    let legacy: StoryClockLegacySettings | undefined;
    let running: readonly WorldRunningStep[] | undefined;
    let firstAnalysis: number | undefined;
    let explicit: number[] | null | undefined;
    const settings = (): StoryClockLegacySettings => legacy ??= this.deps.legacySettings(scope);
    const analysed = (source: SceneSource): boolean => source.status === 'accepted' && storyClockSourceKind(source) === 'analysis';
    // E0 of the prefix that ends at `index`: legacyBaseMs, with the running fold in place of one fold per prefix.
    const base = (index: number, fallbackMs: number): number => {
      const world = settings().settings;
      if (!world) {
        const frozen = this.deps.frozenRoleplayTime(scope);
        if (frozen !== undefined) return frozen;
      }
      if (world?.mode !== 'story') return fallbackMs;
      running ??= this.deps.worldRunning(scope, timeline, world);
      const step = running[index]!;
      if (step.issue !== null) throw new Error('invalid_world_' + step.issue.replace(/^invalid_world_/, ''));
      return step.timeMs;
    };
    // X of the same prefix: explicitMs, from the one reading; nothing is read before a prefix holds an analysed source.
    const moved = (index: number): number => {
      firstAnalysis ??= timeline.findIndex(analysed);
      if (firstAnalysis < 0 || index < firstAnalysis) return 0;
      if (explicit === undefined) {
        const reading = this.fold(scope, timeline, settings());
        if (!reading) explicit = null;
        else {
          const cues = this.indexOf(reading).explicit;
          let total = 0;
          explicit = timeline.map(source => analysed(source) ? total += cues.get(refKey(source.id, source.revision)) ?? 0 : total);
        }
      }
      return explicit === null ? 0 : explicit[index]!;
    };
    return {
      initial: fallbackMs => this.legacyBaseMs(scope, [], fallbackMs, settings().settings),
      at: (index, fallbackMs) => {
        if (!Number.isInteger(index) || index < 0 || index >= length) throw new RangeError('invalid_story_clock_index');
        return base(index, fallbackMs) + moved(index);
      },
    };
  }

  /** Stored rows of the scope in seq order, decoded; malformed rows are passed through for the fold to reject. */
  corrections(scope: SceneScope): unknown[] {
    return this.rows(scope).map(decodeCorrection);
  }

  /**
   * The origin correction a date-only world edit would write: the new start as a floating date and time in the
   * opening's own zone, and whether it differs from the origin in force (the highest-seq origin row bound to the
   * present opening, else the same conversion of the start that was shown).
   */
  originDateEdit(scope: SceneScope, state: SceneState, startTimeMs: number, shownStartTimeMs: number):
    {binding: StoryClockSourceRef; value: StoryClockOriginValue; changed: boolean} {
    const opening = state.sources.find(source => source.status === 'accepted');
    if (!opening) throw new Error('context_changed_retry');
    // Always the opening's stored zone, never the live zone and never a fixed UTC.
    const zone = opening.acceptedTimeZone ?? 'UTC';
    const convert = (unixMs: number): StoryClockOriginValue | null => {
      const parts = storyClockParts(unixMs + (legacyStoryClockShiftMs(unixMs, zone) ?? STORY_CLOCK_UNIX_EPOCH_MS));
      return parts && {date: parts.date, time: parts.time, timeOfDay: null};
    };
    const value = convert(startTimeMs);
    if (!value) throw new Error('invalid_story_clock_origin');
    const row = this.rows(scope).filter(item => item.kind === 'origin' && item.sourceId === opening.id &&
      item.sourceRevision === opening.revision).at(-1);
    let current: StoryClockOriginValue | null;
    if (row) { try { current = originValueOf(JSON.parse(row.body)); } catch { current = null; } }
    else current = convert(shownStartTimeMs);
    return {binding: {sourceId: opening.id, revision: opening.revision}, value,
      changed: JSON.stringify(current) !== JSON.stringify(value)};
  }

  /**
   * Appends one origin correction bound to the present opening source; rows are never rewritten or deleted here.
   * The caller must hold a transaction (as configureWorld does): `afterCorrection` runs after the insert and can throw
   * (invalid_world_<code> from the OpenHer rebuild), and only the caller's rollback removes the row then.
   */
  writeOriginCorrection(scope: SceneScope, binding: StoryClockSourceRef, value: StoryClockOriginValue,
    nowMs: number = Date.now()): {correctionId: string; seq: number} {
    const origin = originValueOf(value);
    if (!origin || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('invalid_story_clock_origin');
    const opening = this.deps.state(scope).sources.find(source => source.status === 'accepted');
    if (!isObject(binding) || !opening || opening.id !== binding.sourceId || opening.revision !== binding.revision)
      throw new Error('context_changed_retry');
    const key = scopeKey(scope);
    const {seq} = this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM scene_story_clock_corrections WHERE scope=?')
      .get(key) as {seq: number};
    const correctionId = `sc-${seq}`;
    this.db.prepare(`INSERT INTO scene_story_clock_corrections
      (scope,id,seq,created,source_id,source_revision,kind,body) VALUES(?,?,?,?,?,?,'origin',?)`)
      .run(key, correctionId, seq, nowMs, opening.id, opening.revision, JSON.stringify(origin));
    this.deps.afterCorrection(scope);
    return {correctionId, seq};
  }

  /** N16: the opening source when it was analysed as a non-opening (an 'analysis' input whose origin is null). */
  openingAwaitingOrigin(scope: SceneScope, state: SceneState): StoryClockSourceRef | null {
    if (!this.deps.isStoryScope(scope)) return null;
    const opening = state.sources.find(source => source.status === 'accepted');
    if (!opening) return null;
    const clock = sourceClock(opening, []);
    if (clock.kind !== 'analysis') return null;
    const analysis: unknown = clock.analysis;
    return isObject(analysis) && analysis.origin === null ? {sourceId: opening.id, revision: opening.revision} : null;
  }

  private rows(scope: SceneScope): PersistedStoryClockCorrectionRow[] {
    return this.db.prepare(`SELECT ${ROW_COLUMNS} FROM scene_story_clock_corrections WHERE scope=? ORDER BY seq`)
      .all(scopeKey(scope)) as unknown as PersistedStoryClockCorrectionRow[];
  }

  private fold(scope: SceneScope, timeline: readonly SceneSource[], legacy: StoryClockLegacySettings,
    state?: SceneState): StoryClockReading | null {
    const settings = legacy.settings;
    // The story-scope test with the settings already in hand: no second worldSettings derivation.
    if (settings?.mode !== 'story' && this.deps.frozenRoleplayTime(scope) === undefined) return null;
    const rows = this.rows(scope), tavernRoleplay = this.deps.tavernRoleplay(scope);
    // A change of corrections, binding, world settings, or (derived settings) live zone or references never reuses a reading.
    const stamp = JSON.stringify([rows, tavernRoleplay, legacy.stored, settings]);
    const held = this.byTimeline.get(timeline);
    if (held?.stamp === stamp) return held.reading;

    const story = settings?.mode === 'story' ? settings : null;
    const legacySources = timeline.some(source => source.status === 'accepted' && storyClockSourceKind(source) === 'legacy');
    let origin: StoryClockLegacyOrigin | null = null;
    // Only a legacy opening reads the anchor, so a chat without legacy sources needs neither the state nor the world fold.
    if (story && legacySources) {
      const live = state ?? this.deps.state(scope);
      origin = {stored: legacy.stored, startTimeMs: story.startTimeMs, createdAtMs: live.createdAtMs, liveZone: legacy.liveZone,
        derive: timeZone => {
          const anchor = initialStoryAnchor(live, legacy.references, timeZone);
          return anchor && {startTimeMs: anchor.settings.startTimeMs, dated: anchor.dated, timeKnown: anchor.timeKnown};
        }};
    }
    const input = buildStoryClockFoldInput({timeline, tavernRoleplay,
      // The same call and the same settings the legacy world time uses, so receipts and skipped sources are HEAD's.
      receipts: story && legacySources ? this.deps.worldFold(scope, timeline as SceneSource[], story).receipts : [],
      legacy: origin, corrections: rows.map(decodeCorrection)});
    const key = createHash('sha256').update(JSON.stringify([STORY_CLOCK_RULE_VERSION, input])).digest('hex');
    let reading = this.byInput.get(key);
    if (!reading) {
      this.folds++;
      const result = foldStoryClock(input);
      reading = {status: result.pending ? 'waiting' : result.issues.length ? 'settled_with_issues' : 'settled',
        input, result, view: storyClockView(result.state, result.dayOneStartMs)};
      this.byInput.set(key, reading);
      if (this.byInput.size > MEMO_LIMIT) this.byInput.delete(this.byInput.keys().next().value!);
    }
    this.byTimeline.set(timeline, {stamp, reading});
    return reading;
  }

  private indexOf(reading: StoryClockReading): ReadingIndex {
    let index = this.indexes.get(reading);
    if (!index) {
      const analysed = new Set(reading.input.sources.filter(source => source.clock.kind === 'analysis')
        .map(source => refKey(source.sourceId, source.revision)));
      const explicit = new Map<string, number>();
      for (const record of reading.result.advances) {
        const key = refKey(record.sourceId, record.revision);
        if (record.basis === 'explicit' && analysed.has(key)) explicit.set(key, (explicit.get(key) ?? 0) + record.deltaMs);
      }
      index = {explicit, at: new Map(reading.result.sources.map(source =>
        [refKey(source.sourceId, source.revision), source.state.atMs]))};
      this.indexes.set(reading, index);
    }
    return index;
  }

  /** E0: today's legacy world time, unchanged. */
  private legacyBaseMs(scope: SceneScope, sources: SceneSource[], fallbackMs: number, settings: WorldSettings | null): number {
    if (!settings) {
      const frozen = this.deps.frozenRoleplayTime(scope);
      if (frozen !== undefined) return frozen;
    }
    if (settings?.mode !== 'story') return fallbackMs;
    const folded = this.deps.worldFold(scope, sources, settings);
    if (folded.issues.length) throw new Error('invalid_world_' + folded.issues[0]!.code.replace(/^invalid_world_/, ''));
    return folded.state.timeMs;
  }

  /** X: explicit cue movement only; no implicit estimate, fallback, legacy +30 step or correction movement. */
  private explicitMs(scope: SceneScope, sources: SceneSource[], timeline: SceneSource[], legacy: StoryClockLegacySettings): number {
    const analysed = sources.filter(source => source.status === 'accepted' && storyClockSourceKind(source) === 'analysis');
    if (!analysed.length) return 0;
    const reading = this.fold(scope, timeline, legacy);
    if (!reading) return 0;
    const explicit = this.indexOf(reading).explicit;
    let total = 0;
    for (const source of analysed) total += explicit.get(refKey(source.id, source.revision)) ?? 0;
    return total;
  }
}
