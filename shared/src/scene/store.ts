import {advanceEmotionWithClock, emotionAtWithClock, storyTimeOfDay, realTimeOfDay,
  convertTimeOfDay, validateEmotionDelta, readEmotionRelation} from '../emotion/openher.ts';
import {planEmotionClock} from '../emotion/clock.ts';
import {advanceEmotionAnchor} from '../emotion/openher.ts';
import {createEmotionLineResolver, isOwnEmotionLine} from './emotion-own-line.ts';
import type {EmotionLineResolver} from './emotion-own-line.ts';
import {
  selectEmotionCounterpart, storedEmotionCounterpart, withEmotionCounterpart, withoutEmotionCounterpart,
} from './emotion-counterpart.ts';
import {createRelationshipFold} from '../emotion/relationships.ts';
import {recordStage, currentModelAddress} from '../core/runtime-log.ts';
import type {EmotionRelationInput} from '../emotion/openher.ts';
import type {OmittedEmotionJump} from '../emotion/clock.ts';
import {createEmotionEngineKey, emotionEngineRuleOf, recognizesEmotionSnapshot} from '../emotion/engine.ts';
import type {EmotionEngineKey, EmotionEngineRule} from '../emotion/engine.ts';
import { CURRENT_STORE_FORMAT, STORE_WRITER_VERSION, stampStoreFormat } from '../core/store-format.ts';
import {limitWorldBlock,worldBlockOmissionLines} from './world-block-limit.ts';
import type {WorldBlockOmissions,WorldBlockCoordinate,WorldBlockLink} from './world-block-limit.ts';
import type { DatabaseSync } from 'node:sqlite';
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {isPromise, isProxy} from 'node:util/types';
import { createEmotion, advanceEmotion, emotionAt, emotionSummary, emotionSettingsOf, emotionSettingsEqual, validateEmotionState } from '../emotion/openher.ts';
import {actorHasEmotion} from './actor-emotion.ts';
import type { EmotionState } from '../emotion/openher.ts';
import { foldRelationships, relationshipAnchor as foldedRelationshipAnchor, validateRelationships } from '../emotion/relationships.ts';
import type { FoldedRelationship } from '../emotion/relationships.ts';
import { scopeKey } from '../core/types.ts';
import type { Preference } from '../core/store.ts';
import type { Memory, MemorySnapshot, MemoryView, Access, RecallDetailRange } from '../memory/access.ts';
import {foldCue, foldedCues, TRACE_RECORD_LIMIT, TRACE_STRONG_CUES} from '../memory/trace.ts';
import { projectMemories } from '../memory/access.ts';
import {retentionSnapshot} from '../memory/retention.ts';
import { emotionIdentitySeed, npcScope } from './types.ts';
import type { SceneScope, SceneRoster, SceneMessage, SceneSource, SceneState, SceneAnalysis, SceneWriteGuard, SceneProfileCandidate, SceneRecall, SceneCharacter } from './types.ts';
import {foldWorldState,foldWorldStateRunning,projectWorldState} from './world-state.ts';
import type {WorldFoldResult,WorldProjection,WorldRunningStep,WorldSettings,WorldSourceEffects} from './world-state.ts';
import {SceneLifecycle,MESSAGE_CHECKPOINT_REASON} from './lifecycle.ts';
import {Processing} from './processing.ts';
import {SceneTransfer} from './transfer.ts';
import {SceneInteractions} from './interaction.ts';
import {SceneDirector} from './director.ts';
import {Commitments,validateCommitmentOperations} from '../commitments/index.ts';
import type {CommitmentCandidate,CommitmentMode,ValidatedCommitmentOperation} from '../commitments/types.ts';
import {NpcResourceController} from './resources.ts';
import {SceneInitialization} from './initialization.ts';
import {PhysiologyStore} from '../common/physiology.ts';
import {GeographyStore} from '../common/geography.ts';
import {SceneCalendarStore} from './calendar-store.ts';
import {initialStorySettings} from './story-initial-clock.ts';
import {readWorldLedgerRows,worldLedgerOptions,storedLedgerFields,ledgerOnlySettings,captureWorldLedgerRows,
  ensureWorldLedgerTables,prepareWorldLedgerWrites,guardWorldLedgerBindings,appendWorldLedgerRows,
  eraseWorldLedgerSource,sweepWorldLedgerTombstones} from './world-ledger-store.ts';
import type {WorldLedgerWrite,WorldLedgerRows} from './world-ledger-store.ts';
import type {LedgerAfter,LedgerFoldOptions,LedgerDetail} from './world-ledger.ts';
import {StoryClockStore,storyClockLine,storyElapsedMs} from './story-clock-store.ts';
import type {StoryClockLegacySettings,StoryClockSummary,StoryClockReading,
  StoryEmotionTimeline} from './story-clock-store.ts';
import {STORY_CLOCK_DEGRADE_REASONS} from './story-clock-types.ts';
import type {StoryClockDegradeReason,StoryClockIssue,StoryClockSourceRef,StoryClockView} from './story-clock-types.ts';
import {commitmentStoryClock,storyNow} from './story-clock-consumers.ts';
import {storyLanguageOf} from '../memory/text-units.ts';
import type {StoryLanguage} from '../memory/text-units.ts';
import {defaultSceneHooks} from './extension.ts';
import type {ContactEmotionProjection,SceneAuthorityExtensionFactory,SceneAuthorityHooks,SceneSubjectBinding} from './extension.ts';

export type {SceneSubjectBinding} from './extension.ts';

/** Read-only terminal-skip test; work is O(P + R + K) in this source's pending, ready and skipped entries. */
function hasCompletedEmotionSkip(analysis: SceneState['sources'][number]['analysis'], characterId: string): boolean {
  return Boolean(
    analysis?.emotionPendingIds?.includes(characterId)
    && !analysis.emotionCandidateReadyIds?.includes(characterId)
    && analysis.skippedStages?.some(skipped => skipped.stage === 'emotion' && skipped.characterId === characterId),
  );
}

/** The staged own-speech rule turns accepted speech into time anchors instead of appraisal events. */
const OWN_SPEECH_ANCHOR_RULE: EmotionEngineRule = 3;

/** Selects applied events in O(sources); rebuild additionally requires the stored observation plan. */
function emotionEvents(
  sources: SceneSource[],
  characterId: string,
  requirePlan: boolean,
  rule: EmotionEngineRule,
  resolveOwnLine?: EmotionLineResolver,
): SceneSource[] {
  return sources.filter(source => {
    if (source.status !== 'accepted' || source.processing !== 'ready') return false;
    if (requirePlan && !source.analysis?.plan) return false;
    if (rule === OWN_SPEECH_ANCHOR_RULE && isOwnEmotionLine(source, characterId, resolveOwnLine)) return false;
    const characters = source.analysis?.characters;
    return characters !== undefined && Object.hasOwn(characters, characterId)
      && Boolean(characters[characterId]?.emotion) && !source.analysis?.emotionPendingIds?.includes(characterId);
  });
}

/** Selects interleaved external events and own-speech anchors in O(sources), without altering stored candidates. */
function emotionReplaySteps(sources: SceneSource[], characterId: string, requirePlan = false,
  resolveOwnLine?: EmotionLineResolver) {
  const events = emotionEvents(sources, characterId, requirePlan, OWN_SPEECH_ANCHOR_RULE, resolveOwnLine);
  const anchors = sources.filter(source => source.status === 'accepted' && source.processing === 'ready'
    && (!requirePlan || source.analysis?.plan) && isOwnEmotionLine(source, characterId, resolveOwnLine));
  const applicable = new Set([...events, ...anchors]);
  return {events, anchors, sources: sources.filter(source => applicable.has(source))};
}

// The process retains at most 1,024 diagnosed record versions, evicting the oldest insertion first.
const invalidEmotionRecords = new Set<string>();

/** Records a corrupt stored appraisal once per scoped source/content version, actor and error code. */
function recordInvalidEmotion(scope: SceneScope, source: SceneSource, characterId: string,
  delta: unknown, code: string): void {
  // A read without a diagnostic sink must not suppress a later observable diagnostic.
  if (currentModelAddress() === null) return;
  const version = createHash('sha256').update(JSON.stringify(delta)).digest('hex');
  const key = JSON.stringify([scopeKey(scope), source.id, source.revision, version, characterId, code]);
  if (invalidEmotionRecords.has(key)) return;
  invalidEmotionRecords.add(key);
  if (invalidEmotionRecords.size > 1024) {
    invalidEmotionRecords.delete(invalidEmotionRecords.values().next().value!);
  }
  recordStage(code, {stage: 'emotion', sourceId: source.id, revision: source.revision, characterId});
}

/** Builds pre-event relation inputs in one source/candidate pass; pending candidates still enter the same fold. */
function emotionRelationInputs(scope: SceneScope, sources: SceneSource[], events: SceneSource[],
  character: SceneCharacter, roster: SceneRoster): Map<SceneSource, EmotionRelationInput | null> {
  const eventSet = new Set(events);
  const fold = createRelationshipFold(character.id, emotionSettingsOf(character.emotion).stableRelationRate);
  const inputs = new Map<SceneSource, EmotionRelationInput | null>();
  for (const source of sources) {
    if (eventSet.has(source)) {
      const delta = source.analysis!.characters[character.id]!.emotion!;
      if (readEmotionRelation(delta.relation).invalid) {
        recordInvalidEmotion(scope, source, character.id, delta, 'invalid_emotion_relation');
      }
      const counterpartId = storedEmotionCounterpart(
        delta, source, source.analysis?.plan, character.id, roster, actorHasEmotion,
        () => recordInvalidEmotion(scope, source, character.id, delta, 'invalid_emotion_counterpart'),
      );
      inputs.set(source, counterpartId === null ? null : {
        counterpartId,
        prior: fold.get(counterpartId)?.relations ?? {depth: 0, trust: 0, valence: 0},
      });
    }
    // A source's candidates affect the next event, never its own prior.
    fold.append(source);
  }
  return inputs;
}

/** Prefix fingerprints bind snapshots to every event input without persisting derived metadata. */
function emotionSnapshotHeader(scope: SceneScope, character: SceneCharacter, engine: EmotionEngineKey,
  initialTime: number) {
  return createHash('sha256').update(JSON.stringify([
    scopeKey(scope), character.id, character.emotion, engine, initialTime,
  ]));
}

/** Appends one event or anchor in constant work beyond the candidate payload and returns its prefix digest. */
function appendEmotionSnapshotInput(hash: ReturnType<typeof createHash>, input: {
  source: SceneSource;
  anchor: boolean;
  delta: unknown;
  relationInput: EmotionRelationInput | null;
  eventTimeMs: number;
  hungerHours: number;
  timeOfDay: number;
}): string {
  hash.update(JSON.stringify([
    input.source.id,
    input.source.revision,
    input.anchor,
    input.delta,
    input.relationInput,
    input.eventTimeMs,
    input.hungerHours,
    input.timeOfDay,
  ]));
  return hash.copy().digest('hex');
}

/** Story actors start at their first event or anchor; real-time actors retain the scope creation instant. */
function emotionInitialTime(clock: StoryEmotionTimeline | null, events: SceneSource[], createdAtMs: number): number {
  if (clock === null) return createdAtMs;
  const firstEvent = events[0];
  if (firstEvent === undefined) return clock.atMs;
  const position = clock.positions.get(JSON.stringify([firstEvent.id, firstEvent.revision]))!;
  return clock.sources[position]!.clockMs;
}

/** Derives the local-day fraction from immutable event time or the story clock's known-time flag. */
function emotionEventTimeOfDay(source: SceneSource, delta: unknown,
  clockSource: StoryEmotionTimeline['sources'][number] | undefined): number {
  if (clockSource !== undefined) return storyTimeOfDay(clockSource.clockMs, clockSource.timeOfDayKnown);
  if (source.acceptedTimeZone != null) return realTimeOfDay(source.acceptedAtMs, source.acceptedTimeZone);
  return convertTimeOfDay(validateEmotionDelta(delta).context.timeOfDay);
}

/** Pure fold work owned by one outer call; code-unit and entry budgets apply to the entire call. */
interface SceneReadStep {
  active: boolean;
  saturated: boolean;
  keyUnits: number;
  folds: Map<string, WorldFoldResult | WorldRunningStep[]>;
}

// Measured public paths retain at most four entries. Sixteen leaves twelve entries of headroom.
const READ_FOLD_ENTRY_LIMIT = 16;
// Measured keys total at most 2,300,431 UTF-16 units per call; eight million leaves over threefold capacity.
const READ_FOLD_KEY_UNIT_LIMIT = 8_000_000;

/**
 * Splice one member value or insertion into valid JSON text, preserving all code units outside the range.
 * Offsets use UTF-16 code units. Throw invalid_emotion_snapshot_replacement for invalid JSON or altered surroundings.
 * Parsing and checking the surrounding text take O(text length + replacement length) work and memory.
 */
function spliceObjectMember(objectText: string, start: number, end: number, replacement: string): string {
  const prefix = objectText.slice(0, start);
  const suffix = objectText.slice(end);
  const result = prefix + replacement + suffix;

  try {
    JSON.parse(result);
  } catch {
    throw new Error('invalid_emotion_snapshot_replacement');
  }

  if (result.length !== prefix.length + replacement.length + suffix.length
    || result.slice(0, start) !== prefix
    || result.slice(start + replacement.length) !== suffix) {
    throw new Error('invalid_emotion_snapshot_replacement');
  }

  return result;
}

/**
 * Replace the first matching member along a nonempty path of at most two names in validated JSON object text.
 * The replacement is valid JSON. Missing members are inserted; non-object containers throw
 * invalid_emotion_snapshot_container, and an invalid splice throws invalid_emotion_snapshot_replacement.
 * Each level scans once; the fixed two-level path takes O(text length + body length) work and memory.
 */
function replaceObjectMember(objectText: string, members: readonly string[], body: string): string {
  const [member, ...remaining] = members;
  let offset = 0;
  while (/[\t\n\r ]/.test(objectText[offset])) offset += 1;
  if (objectText[offset] !== '{') {
    throw new Error('invalid_emotion_snapshot_container');
  }
  offset += 1;

  let valueStart = -1;
  let valueEnd = -1;
  let memberCount = 0;

  const stringEnd = (start: number): number => {
    let end = start + 1;

    while (end < objectText.length) {
      const character = objectText[end++];
      if (character === '\\') end += 1;
      else if (character === '"') break;
    }

    return end;
  };

  while (offset < objectText.length) {
    while (/[\t\n\r ,]/.test(objectText[offset])) offset += 1;
    if (objectText[offset] === '}') break;

    const nameEnd = stringEnd(offset);
    const name = JSON.parse(objectText.slice(offset, nameEnd)) as string;
    offset = objectText.indexOf(':', nameEnd) + 1;
    while (/[\t\n\r ]/.test(objectText[offset])) offset += 1;
    const start = offset;
    let depth = 0;

    while (offset < objectText.length) {
      const character = objectText[offset];
      if (character === '"') {
        offset = stringEnd(offset);
        continue;
      }
      if (depth === 0 && (character === ',' || character === '}')) break;
      if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth -= 1;
      offset += 1;
    }

    memberCount += 1;
    if (name === member && valueStart < 0) {
      valueStart = start;
      valueEnd = offset;
      while (/[\t\n\r ]/.test(objectText[valueEnd - 1])) valueEnd -= 1;
    }
  }

  // SQLite reads the first duplicate at each level, so replace that same member.
  if (valueStart >= 0) {
    const replacement = remaining.length === 0 ? body
      : replaceObjectMember(objectText.slice(valueStart, valueEnd), remaining, body);
    return spliceObjectMember(objectText, valueStart, valueEnd, replacement);
  }

  const replacement = remaining.length === 0 ? body : replaceObjectMember('{}', remaining, body);
  const insertion = (memberCount === 0 ? '' : ',') + JSON.stringify(member) + ':' + replacement;
  return spliceObjectMember(objectText, offset, offset, insertion);
}

/** World sources and all NPC projections share the existing SQLite transaction. */
export class SceneAuthority {
  private db: DatabaseSync;
  readonly #emotionEngineRule: EmotionEngineRule;
  /** Read-only authorship eligibility in constant work; actor eligibility is checked separately. */
  readonly shouldAppraiseEmotion: (source: SceneMessage, characterId: string,
    resolveOwnLine?: EmotionLineResolver) => boolean;
  declare private readonly readSteps: AsyncLocalStorage<SceneReadStep>;
  /** Tests and diagnostics read this count; no failed input or error is retained. */
  declare private readSharingFailures: number;
  private emotionReplayCache=new Map<string,EmotionState>();
  // Retain one pre-anchor prefix per actor/scope; cold or evicted entries replay from source facts.
  private emotionSnapshotInputs = new Map<string, Map<string, string>>();
  readonly #emotionValidityCache = new Map<string, {stamp: string; invalidFrom: number}>();
  private savepointSequence=0;
  declare private ledgerReadFrame?: {
    key: string;
    rows?: WorldLedgerRows;
    stamp?: string;
    databaseStamp?: string;
    liveSources?: SceneSource[];
    views?: Map<SceneSource[], {
      timeline: SceneSource[] | undefined;
      sources: WorldSourceEffects[];
      options: LedgerFoldOptions;
      stamp?: string;
    }>;
  };
  readonly #ledgerTimelineIdentities = new WeakMap<SceneSource[], number>();
  #nextLedgerTimelineIdentity = 0;
  readonly lifecycle:SceneLifecycle;
  readonly processing:Processing;
  readonly transfer:SceneTransfer;
  readonly interactions:SceneInteractions;
  readonly director:SceneDirector;
  readonly commitments:Commitments;
  readonly npcResources:NpcResourceController;
  readonly initialization:SceneInitialization;
  readonly calendar:SceneCalendarStore;
  readonly physiology:PhysiologyStore;
  readonly geography:GeographyStore;
  /** The unified story clock (SC3a). This class only delegates: it builds no fold input and does no clock arithmetic. */
  readonly storyClock:StoryClockStore;
  private readonly hooks:SceneAuthorityHooks;
  /**
   * `extension` adds members and hooks (the Agent companion); without it every hook is a no-op, subject() is null and
   * no companion table is created. The authority is then typed `SceneAuthority & M` by its owner (Authority<M>).
   */
  constructor(
    db: DatabaseSync,
    migrateEmotionStates = true,
    extension?: SceneAuthorityExtensionFactory<object>,
    // Only literal true enables geography in Tavern roleplay; omission keeps it unavailable in that scope.
    // Restore geography by passing true at the server Authority construction.
    tavernGeography = false,
    // Only literal true enables physiology in Tavern roleplay; omission keeps it unavailable in that scope.
    // Restore physiology by passing true at the server Authority construction.
    tavernPhysiology = false,
    // Test-only engine selection; product callers omit it.
    emotionEngineRule?: EmotionEngineRule
  ) {
    this.#emotionEngineRule = emotionEngineRuleOf(emotionEngineRule);
    this.shouldAppraiseEmotion = (source, characterId, resolveOwnLine) => this.#emotionEngineRule !== 3
      || !isOwnEmotionLine(source, characterId, resolveOwnLine);
    Object.defineProperty(this, 'shouldAppraiseEmotion', {writable: false, configurable: false, enumerable: false});
    Object.defineProperties(this, {
      readSteps: { value: new AsyncLocalStorage<SceneReadStep>() },
      readSharingFailures: { value: 0, writable: true },
    });
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS scene_worlds (
      key TEXT PRIMARY KEY, scope TEXT NOT NULL, roster TEXT NOT NULL, version INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scene_sources (
      scope TEXT NOT NULL REFERENCES scene_worlds(key), id TEXT NOT NULL, revision INTEGER NOT NULL,
      message TEXT NOT NULL, observed INTEGER NOT NULL, status TEXT NOT NULL, processing TEXT NOT NULL,
      analysis TEXT, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS scene_controls (
      scope TEXT NOT NULL REFERENCES scene_worlds(key), character TEXT NOT NULL, id TEXT NOT NULL,
      revision INTEGER NOT NULL, access TEXT NOT NULL, PRIMARY KEY(scope,character,id,revision));
      CREATE TABLE IF NOT EXISTS scene_preference_controls (
      scope TEXT NOT NULL REFERENCES scene_worlds(key), character TEXT NOT NULL, id TEXT NOT NULL,
      body TEXT NOT NULL, PRIMARY KEY(scope,character,id));
      CREATE TABLE IF NOT EXISTS scene_world_settings (
      scope TEXT PRIMARY KEY REFERENCES scene_worlds(key), settings TEXT NOT NULL, clock_floor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS scene_write_operations (
      scope TEXT NOT NULL, id TEXT NOT NULL, request_hash TEXT NOT NULL, sources_hash TEXT NOT NULL,
      PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS scene_index_cleanup (
      scope TEXT NOT NULL, character TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(scope,character));`);
    this.initializeLedgerSourceRevision();
    this.processing = new Processing(db);
    this.transfer = new SceneTransfer(db, this);
    this.storyClock = new StoryClockStore(db, {
      state: scope => this.state(scope),
      isStoryScope: scope => this.isStoryScope(scope),
      tavernRoleplay: scope => this.interactions.isTavernRoleplay(scope),
      worldFold: (scope, sources, settings, timeline) => {
        const input = this.ledgerViewInput(scope, sources, settings, timeline);
        return Object.keys(input.options).length
          ? this.foldWorldForStep(settings, input.sources, input.options)
          : this.foldWorldForStep(settings, input.sources);
      },
      // One running fold of this view's sources and selected rows, aligned to the original source array.
      worldRunning: (scope, sources, settings, timeline) => {
        const input = this.ledgerViewInput(scope, sources, settings, timeline);
        const steps = this.foldWorldRunningForStep(settings, input.sources, input.options);
        let position = -1;
        let last: WorldRunningStep = { timeMs: settings.startTimeMs, issue: null };
        return sources.map(source => {
          if (source.status === 'accepted' && source.processing === 'ready'
            && source.analysis?.plan)
            last = steps[++position]!;
          return last;
        });
      },
      withLedgerRows: (scope, action) => this.withLedgerRows(scope, action),
      ledgerReader: scope => this.ledgerReader(scope),
      ledgerTimeline: (scope, sources, timeline) => this.ledgerTimelineForCall(scope, sources, timeline),
      ledgerData: (scope, sources = this.state(scope).sources, timeline) => {
        const rows = this.ledgerRowsForCall(scope);
        if (!this.usableLedgerRows(rows))
          return null;
        if (timeline !== undefined)
          this.checkLedgerPrefix(sources, timeline);

        // Row bytes and connection metadata validate a memo without decoding the source table.
        const frame = this.ledgerReadFrame;
        const digest = () => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
        const raw = frame?.key === scopeKey(scope) ? frame.stamp ??= digest() : digest();
        let timelineIdentity = 0;
        if (timeline !== undefined) {
          timelineIdentity = this.#ledgerTimelineIdentities.get(timeline) ?? ++this.#nextLedgerTimelineIdentity;
          this.#ledgerTimelineIdentities.set(timeline, timelineIdentity);
        }
        return JSON.stringify([raw, timelineIdentity]);
      },
      ledgerVersion: () => this.ledgerDatabaseStamp(),
      legacySettings: (scope, sources) => this.legacyWorldSettings(scope, sources),
      frozenRoleplayTime: scope => this.interactions.frozenRoleplayTime(scope),
      afterCorrection: scope => {
        this.rebuildEmotionStates(scope);
        this.bump(scope);
        this.rebuildDerived(scope);
      },
    });
    this.interactions = new SceneInteractions(db, (scope, now) => this.world(scope, undefined, now), scope => {
      const summary = this.storyClock.summary(scope);
      return summary && { status: summary.status, pending: summary.pending, view: summary.view };
    });
    this.npcResources = new NpcResourceController(db);
    this.initialization = new SceneInitialization(db, this);
    this.director = new SceneDirector(db);
    this.commitments = new Commitments(db);
    this.calendar = new SceneCalendarStore(db, this);
    this.geography = new GeographyStore(db, {
      state: scope => this.state(scope),
      modeOf: scope => this.interactions.modeOf(scope),
      fullRoleplay: scope => this.interactions.isTavernRoleplay(scope),
      tavernAvailable: tavernGeography,
      transaction: action => this.transaction(action),
      checkpoint: (scope, reason) => {
        this.lifecycle.checkpoint(scope, reason, { automatic: true });
      },
      bump: scope => this.bump(scope),
    });
    this.physiology = new PhysiologyStore(db, {
      state: scope => this.state(scope),
      modeOf: scope => this.interactions.modeOf(scope),
      fullRoleplay: scope => this.interactions.isTavernRoleplay(scope),
      tavernAvailable: tavernPhysiology,
      clock: (scope, now) => {
        const clock = this.interactions.clock(scope, now);
        return { ...clock, timeMs: typeof clock.timeMs === 'number' ? clock.timeMs : null };
      },
      // Physiology has its own state type, but both status callers pass a full SceneState.
      // They use either the stored state or a generation view.
      storyTime:(scope,state)=>{
        const now = storyNow(this, scope, state as unknown as SceneState);
        if (now === null)
          return null;
        let entries: Map<string, { revision: number; atMs: number }> | undefined;
        return {
          nowMs: now.atMs,
          originMs: now.originAtMs,
          at: (sourceId, revision) => {
            entries ??= new Map(
              now.sources.map(entry => [entry.sourceId, { revision: entry.revision, atMs: entry.state.atMs }])
            );
            const entry = entries.get(sourceId);
            return entry !== undefined && (revision === undefined || entry.revision === revision) ? entry.atMs : null;
          }
        };
      },
      transaction: action => this.transaction(action),
      checkpoint: (scope, reason) => {
        this.lifecycle.checkpoint(scope, reason, { automatic: true });
      },
      bump: scope => this.bump(scope),
    });
    const hooks = defaultSceneHooks();
    if (extension) {
      const built = extension(db, {
        scene: this,
        transaction: action => this.transaction(action),
        bump: scope => this.bump(scope),
        rebuildDerived: (scope, nowMs) => this.rebuildDerived(scope, nowMs),
        configure: (scope, roster, nowMs) => this.configure(scope, roster, nowMs, false)
      });
      Object.assign(hooks, built.hooks ?? {});
      // Descriptors, not values: an accessor member (personalModelIdentity) stays a single accessor.
      Object.defineProperties(this, Object.getOwnPropertyDescriptors(built.members));
    }
    this.hooks = hooks;
    this.lifecycle = new SceneLifecycle(db, scope => {
      // N16 first: it decides which sources are 'ready', which both rebuilds read.
      this.requeueOpening(scope);
      this.rebuildEmotionStates(scope);
      this.rebuildDerived(scope);
      this.invalidateDirector(scope);
    }, hooks.checkpoint);
    if (migrateEmotionStates)
      this.migrateEmotionStates();
  }

  state(scope: SceneScope, includeEmotionStates = false): SceneState {
    const row = this.db.prepare('SELECT roster,version,created FROM scene_worlds WHERE key=?').get(scopeKey(scope)) as
      {roster:string;version:number;created:number} | undefined;
    if (!row) return {scope, version:0, createdAtMs:0, roster:{characters:[]}, sources:[]};
    const sources = this.db.prepare(`SELECT message,revision,observed,status,processing,${includeEmotionStates?'analysis':"json_remove(analysis,'$.emotionStates') AS analysis"} FROM scene_sources WHERE scope=? ORDER BY rowid`)
      .all(scopeKey(scope)) as {message:string;revision:number;observed:number;status:SceneSource['status'];processing:SceneSource['processing'];analysis:string|null}[];
    return {scope, version:row.version, createdAtMs:row.created, roster:JSON.parse(row.roster), sources:sources.map(source => ({
      ...JSON.parse(source.message), revision:source.revision, observedAtMs:source.observed, status:source.status,
      processing:source.processing, analysis:source.analysis ? JSON.parse(source.analysis) : null,
    }))};
  }

  /**
   * Share pure folds until the outer call returns or its native promise settles; nested calls keep the owner.
   * Results and errors pass through unchanged. A continuation inherited from a closed call never reopens it.
   */
  withReadStep<T>(action: () => T): T {
    const inherited = this.readSteps.getStore();
    if (inherited !== undefined)
      return action();

    const step: SceneReadStep = {
      active: true,
      saturated: false,
      keyUnits: 0,
      folds: new Map(),
    };
    const close = () => {
      step.active = false;
      step.folds.clear();
      step.keyUnits = 0;
    };

    return this.readSteps.run(
      step,
      () => {
        let result: T;
        try {
          result = action();
        } catch (error) {
          close();
          throw error;
        }

        if (isPromise(result)) {
          try {
            // Observe settlement without replacing the promise or touching a caller's overridden then getter.
            Promise.prototype.then.call(result, close, close);
          } catch {
            // A promise subclass can reject observation through its species getter. Sharing is optional.
            close();
          }
        } else {
          close();
        }
        return result;
      }
    );
  }

  /** Delegate the full world fold; inputs and output retain the original fold's units and failure semantics. */
  private foldWorldForStep(
    settings: WorldSettings,
    sources: WorldSourceEffects[],
    options: LedgerFoldOptions = {},
  ): WorldFoldResult {
    return this.foldForReadStep('full', settings, sources, options, () => foldWorldState(settings, sources, options));
  }

  private foldWorldRunningForStep(
    settings: WorldSettings,
    sources: WorldSourceEffects[],
    options: LedgerFoldOptions,
  ): WorldRunningStep[] {
    return this.foldForReadStep(
      'running',
      settings,
      sources,
      options,
      () => foldWorldStateRunning(settings, sources, options)
    );
  }

  private foldForReadStep<T extends WorldFoldResult | WorldRunningStep[]>(
    kind: 'full' | 'running',
    settings: WorldSettings,
    sources: WorldSourceEffects[],
    options: LedgerFoldOptions,
    action: () => T,
  ): T {
    const step = this.readSteps.getStore();
    if (!step?.active || step.saturated)
      return action();
    // Once a budget is exhausted, drop results that later calls cannot use and stop building keys.
    if (step.folds.size >= READ_FOLD_ENTRY_LIMIT || step.keyUnits >= READ_FOLD_KEY_UNIT_LIMIT) {
      step.saturated = true;
      step.folds.clear();
      return action();
    }

    const objects = new WeakSet<object>();
    let key: string | undefined;
    try {
      if (plainReadInput([settings, sources, options], objects)) {
        // Both world folds ignore these bounds in story mode. Companion mode retains both exact values.
        const { nowMs: _now, monotonicFloorMs: _floor, ...storyOptions } = options;
        const foldOptions = settings.mode === 'story' ? storyOptions : options;
        key = JSON.stringify([kind, settings, sources, foldOptions]);
        const cached = step.folds.get(key);
        if (cached !== undefined)
          return structuredClone(cached) as T;
        if (key.length > READ_FOLD_KEY_UNIT_LIMIT - step.keyUnits) {
          step.saturated = true;
          step.folds.clear();
          key = undefined;
        }
      }
    } catch {
      // Deep or otherwise uncopyable data must retain the original fold's result and failure behavior.
      this.readSharingFailures++;
      key = undefined;
    }

    const result = action();
    // Some invalid inputs can be returned inside diagnostics. Such aliases must still point at the caller's input.
    if (key !== undefined) {
      try {
        if (detachedReadResult(result, objects)) {
          step.folds.set(key, structuredClone(result));
          step.keyUnits += key.length;
        }
      } catch {
        this.readSharingFailures++;
      }
    }
    return result;
  }

  /** The bound real user of an active Agent companion scope; always null without the companion extension. */
  subject(scope:SceneScope):SceneSubjectBinding|null {return this.hooks.subject(scope);}

  /** Needed after interaction inheritance, which occurs after lifecycle fork materialization. */
  refreshDerived(scope:SceneScope,nowMs=Date.now()):void {this.transaction(()=>this.rebuildDerived(scope,nowMs));}

  /** Saves a roster atomically; accepted emotion records replay locally under changed settings or identity. */
  configure(
    scope: SceneScope,
    roster: SceneRoster,
    now = Date.now(),
    captureCheckpoint = true,
    beforeWrite?: (state: SceneState, roster: SceneRoster) => void,
  ) {
    return this.transaction(() => {
      const state = this.state(scope);
      // Preserve opaque stored members before the equality check, including explicit null and member order.
      const retainReserved = <T extends object>(incoming: T, stored: T | undefined, names: string[]): T => {
        if (!names.some(name => Object.hasOwn(incoming, name) || stored && Object.hasOwn(stored, name))) {
          return incoming;
        }
        const supplied = new Map(Object.entries(incoming));
        const retained = new Map<string, unknown>();
        for (const [name, value] of Object.entries(stored ?? {})) {
          if (names.includes(name)) retained.set(name, value);
          else if (supplied.has(name)) retained.set(name, supplied.get(name));
        }
        for (const [name, value] of supplied) {
          if (!names.includes(name) && !retained.has(name)) retained.set(name, value);
        }
        return Object.fromEntries(retained) as T;
      };
      const storedCharacters = new Map(state.roster.characters.map(character => [character.id, character]));
      const characters = roster.characters.map(character => retainReserved(
        character,
        storedCharacters.get(character.id),
        ['calibration', 'emotionProvenance'],
      ));
      roster = retainReserved({...roster, characters}, state.roster, ['emotionControls']);
      if (state.version && JSON.stringify(state.roster) === JSON.stringify(roster)) {
        return {
          version: state.version,
          roster,
          needsProcessing: state.sources.some(source => source.status === 'accepted' && source.processing !== 'ready'),
        };
      }
      const previous = new Map(state.roster.characters.map(character => [character.id, character]));
      const replayIds = roster.characters.filter(character => {
        const before = previous.get(character.id);
        return before && actorHasEmotion(character) && (
          !emotionSettingsEqual(before.emotion, character.emotion)
          || before.persona !== character.persona
          || JSON.stringify(before.identitySource) !== JSON.stringify(character.identitySource)
        );
      }).map(character => character.id);
      const ids = new Set(roster.characters.map(character => character.id));
      const usedCharacterRemoved = state.sources.some(source => source.status !== 'deleted' && [
        source.envelope.targetId,
        ...source.envelope.presentIds,
        ...(source.speakerId ? [source.speakerId] : []),
      ].some(id => !ids.has(id)));
      if (usedCharacterRemoved) throw new Error('invalid_scene_character_in_use');

      // The guard observes the validated pre-write state before checkpoints or cache invalidation.
      beforeWrite?.(state, roster);

      if (state.version && captureCheckpoint) this.lifecycle.checkpoint(scope, '角色配置变更', {automatic: true});
      if (state.version) this.processing.clearScope(scope);
      this.db.prepare('INSERT INTO scene_worlds VALUES(?,?,?,1,?) '
        + 'ON CONFLICT(key) DO UPDATE SET roster=excluded.roster,version=scene_worlds.version+1')
        .run(scopeKey(scope), JSON.stringify(scope), JSON.stringify(roster), now);
      this.hooks.onConfigured(scope);
      this.invalidateConfigurationChanges(scope, state, roster);
      const worldSettings = this.worldSettings(scope);
      if (worldSettings) {
        const updated = {
          ...worldSettings,
          actorLabels: Object.fromEntries(roster.characters.map(actor => [actor.id, [actor.name, ...actor.aliases]])),
        };
        foldWorldState(updated, []);
        if (JSON.stringify(updated) !== JSON.stringify(worldSettings)) {
          this.db.prepare('UPDATE scene_world_settings SET settings=? WHERE scope=?')
            .run(JSON.stringify(updated), scopeKey(scope));
          this.markAllPending(scope);
        }
      }
      // Naming changes keep their existing invalidation; only the still-accepted records can replay below.
      for (const characterId of replayIds) this.rebuildEmotionStates(scope, characterId);
      this.rebuildDerived(scope);
      const next = this.state(scope);
      return {
        version: next.version,
        roster,
        needsProcessing: next.sources.some(source => source.status === 'accepted' && source.processing !== 'ready'),
      };
    });
  }

  /** Accepted raw text is durable independently of whether background analysis succeeds. */
  reconcile(
    scope: SceneScope,
    messages: SceneMessage[],
    replace = true,
    now = Date.now(),
    guard?: SceneWriteGuard
  ) {
    return this.transaction(
      () => {
        const state = this.state(scope);
        if (!state.version)
          throw new Error('invalid_scene_not_configured');
        if (new Set(messages.map(message => message.id)).size !== messages.length)
          throw new Error('duplicate_message_id');
        // Validate every message before hashing, checkpointing or writing. Unknown entry fields survive round trips.
        for (const message of messages) {
          try {
            if (!Object.hasOwn(message, 'recalled'))
              continue;
            const recalled = message.recalled;
            if (message.role !== 'assistant' || !Array.isArray(recalled) || recalled.length > TRACE_RECORD_LIMIT) {
              throw new Error('invalid_scene_recall');
            }
            for (const entry of recalled) {
              if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
                typeof entry.character !== 'string' || entry.character.length < 1 || entry.character.length > 200 ||
                typeof entry.source !== 'string' || entry.source.length < 1 || entry.source.length > 200 ||
                !Number.isSafeInteger(entry.revision) || entry.revision < 1 ||
                typeof entry.identity !== 'string' || !/^[0-9a-f]{64}$/.test(entry.identity) ||
                (Object.hasOwn(entry, 'strength') && entry.strength !== 'weak'))
                throw new Error('invalid_scene_recall');
              if (!Object.hasOwn(entry, 'details'))
                continue;
              if (!Array.isArray(entry.details) || entry.details.length < 1 || entry.details.length > 3) {
                throw new Error('invalid_scene_recall');
              }
              let previousEnd = 0;
              let strayCount = 0;
              for (const range of entry.details) {
                if (!range || typeof range !== 'object' || Array.isArray(range) ||
                  Object.keys(range).some(key => !['start', 'end', 'stray'].includes(key)) ||
                  !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
                  range.start < previousEnd || range.start < 0 || range.start >= range.end || range.end > 20000 ||
                  (Object.hasOwn(range, 'stray') && range.stray !== true))
                  throw new Error('invalid_scene_recall');
                previousEnd = range.end;
                if (Object.hasOwn(range, 'stray') && range.stray === true && ++strayCount > 1)
                  throw new Error('invalid_scene_recall');
              }
            }
          }
          catch {
            throw new Error('invalid_scene_recall');
          }
        }
        const requestHash = createHash('sha256').update(JSON.stringify([messages, replace, guard?.expectedVersion, guard?.reconfirmIds ?? []])).digest('hex');
        if (guard) {
          if (!Number.isSafeInteger(guard.expectedVersion) || guard.expectedVersion < 0 || !guard.operationId || guard.operationId.length > 200)
            throw new Error('invalid_scene_operation');
          const previous = this.db.prepare('SELECT request_hash,sources_hash FROM scene_write_operations WHERE scope=? AND id=?')
            .get(scopeKey(scope), guard.operationId) as {
              request_hash: string;
              sources_hash: string;
            } | undefined;
          if (previous) {
            if (previous.request_hash !== requestHash)
              throw new Error('invalid_scene_operation');
            if (previous.sources_hash !== sourcesHash(state))
              throw new Error('context_changed_retry');
            return {removed: 0, changed: false, duplicate: true, ...this.syncState(scope)};
          }
          if (state.version !== guard.expectedVersion)
            throw new Error('context_changed_retry');
        }
        let changed = false;
        let userActivityChanged = false;
        let removed = 0;
        const causalChanges: {
          index: number;
          characters: Set<string>;
        }[] = [];
        const deletedSourceIds = new Set(state.sources.filter(source => source.status === 'deleted').map(source => source.id));
        const incoming = new Map(messages.map(message => [message.id, message]));
        const changing = messages.some(
          message => guard?.reconfirmIds?.includes(message.id) || !state.sources.some(source => source.id === message.id && sameContent(source, message))
        )
          || (replace && state.sources.some(source => source.status !== 'deleted' && !incoming.has(source.id)));
        if (changing)
          this.lifecycle.checkpoint(scope, MESSAGE_CHECKPOINT_REASON, {automatic: true});
        // The zone of the new sources of this call: read on first use, at most once, and never kept beyond the call.
        let newSourceTimeZone: string | undefined;
        for (const message of messages) {
          const previous = state.sources.find(source => source.id === message.id);
          if (previous?.status === 'deleted')
            throw new Error('invalid_scene_deleted_source');
          const reconfirm = guard?.reconfirmIds?.includes(message.id) === true;
          if (previous && sameContent(previous, message) && !reconfirm)
            continue;
          if (previous && (message.revision < previous.revision || message.revision > previous.revision + 1))
            throw new Error('context_changed_retry');
          const revision = previous ? previous.revision + 1 : 1;
          const acceptedAtMs = previous?.acceptedAtMs ?? Math.min(message.acceptedAtMs, now);
          // Editing an existing source is an explicit user correction, not a replay of its old derivation.
          const replyTo = message.replyTo ?? previous?.replyTo;
          const acceptedTimeZone = previous ? previous.acceptedTimeZone : (newSourceTimeZone ??= this.interactions.isTavernRoleplay(scope)
            ? this.interactions.get(scope, 'sillytavern').timeZone
            : this.interactions.modeOf(scope) ? this.interactions.clock(scope).timeZone ?? 'UTC' : 'UTC');
          const next: SceneMessage = {
            ...message,
            revision,
            acceptedAtMs,
            acceptedTimeZone,
            dependencies: message.dependencies ?? previous?.dependencies ?? [],
            ...(replyTo ? {replyTo} : {})
          };
          if (replyTo) {
            const current = this.state(scope).sources, origin = current.find(source => source.id === replyTo.id);
            if (next.role !== 'assistant' || !origin || origin.status !== 'accepted' || origin.revision !== replyTo.revision || origin.id === next.id ||
              (previous && current.indexOf(origin) >= current.findIndex(source => source.id === previous.id)))
              throw new Error('invalid_scene_reply_to');
            if (!next.dependencies!.some(item => item.id === replyTo.id && item.revision === replyTo.revision))
              next.dependencies = [...next.dependencies!, replyTo];
          }
          if (previous) {
            this.processing.clearSources(scope, [previous.id]);
            const characters = new Set(
              [
                ...Object.keys(previous.analysis?.characters ?? {}),
                message.envelope.targetId,
                ...message.envelope.presentIds,
                ...(message.speakerId ? [message.speakerId] : []),
              ]
            );
            causalChanges.push({index: state.sources.indexOf(previous), characters});
          }
          const retained = previous?.analysis ? withoutUserModelCandidates(
            withoutEmotionStates(
              {
                ...previous.analysis,
                plan: null,
                controlRevision: previous.analysis.controlRevision ?? previous.revision
              }
            )
          ) : null;
          this.db.prepare(
            `INSERT INTO scene_sources VALUES(?,?,?,?,?,'accepted','pending',?)
          ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision,message=excluded.message,
          observed=excluded.observed,status='accepted',processing='pending',analysis=excluded.analysis`
          )
            .run(
              scopeKey(scope),
              next.id,
              revision,
              JSON.stringify(next),
              now,
              retained ? JSON.stringify(retained) : null
            );
          if (next.role === 'user')
            userActivityChanged = true;
          changed = true;
        }
        if (replace)
          for (const source of state.sources) {
            if (source.status === 'deleted' || incoming.has(source.id))
              continue;
            this.processing.clearSources(scope, [source.id]);
            causalChanges.push(
              {
                index: state.sources.indexOf(source),
                characters: new Set(Object.keys(source.analysis?.characters ?? {}))
              }
            );
            const erased = {...source, text: '', dependencies: [], revision: source.revision + 1};
            delete (erased as Partial<SceneSource>).analysis;
            delete erased.recalled;
            this.db.prepare(
              "UPDATE scene_sources SET revision=revision+1,message=?,observed=?,status='deleted',processing='ready',analysis=NULL WHERE scope=? AND id=?"
            )
              .run(JSON.stringify(erased), now, scopeKey(scope), source.id);
            this.hooks.onSourceErased(scope, source);
            const preferences = this.db.prepare('SELECT character,id FROM scene_preference_controls WHERE scope=?').all(scopeKey(scope)) as {
              character: string;
              id: string;
            }[];
            for (const preference of preferences)
              if (preferenceSourceId(preference.id) === source.id)
                this.db.prepare('DELETE FROM scene_preference_controls WHERE scope=? AND character=? AND id=?').run(scopeKey(scope), preference.character, preference.id);
            eraseWorldLedgerSource(this.db, scope, source.id);
            deletedSourceIds.add(source.id);
            changed = true;
            removed++;
          }
        this.lifecycle.redactUnsafeCheckpoints(scope, deletedSourceIds);
        if (changed) {
          const dependentChanges = this.invalidateDependents(scope);
          this.invalidateCausalSuffix(scope, [...causalChanges, ...dependentChanges]);
          // N16 after the two invalidations (they decide which source is now the opening), before the single bump.
          // Then the OpenHer snapshots, only when this call edited, reconfirmed, deleted or invalidated a source or re-queued
          // the opening: a call whose new sources all stay valid only adds pending sources, which change no snapshot.
          const openingRequeued = this.requeueOpening(scope);
          if (causalChanges.length > 0 || dependentChanges.length > 0 || openingRequeued)
            this.rebuildEmotionStatesGuarded(scope);
          this.bump(scope);
          if (userActivityChanged)
            this.hooks.onUserActivity(scope, now);
          this.rebuildDerived(scope);
        }
        const next = this.state(scope);
        if (removed)
          for (const character of state.roster.characters)
            this.db.prepare('INSERT OR REPLACE INTO scene_index_cleanup VALUES(?,?,?)').run(scopeKey(scope), character.id, next.version);
        if (guard?.reconfirmIds?.some(id => next.sources.find(source => source.id === id)?.status !== 'accepted'))
          throw new Error('invalid_scene_dependencies');
        if (guard)
          this.db.prepare('INSERT INTO scene_write_operations VALUES(?,?,?,?)').run(scopeKey(scope), guard.operationId, requestHash, sourcesHash(next));
        return {removed, changed, duplicate: false, ...this.syncState(scope)};
      }
    );
  }

  syncState(scope:SceneScope) {
    const state=this.state(scope);
    return {version:state.version,needsReview:state.sources.filter(source=>source.status==='needs_review').map(source=>source.id),
      bindings:state.sources.map(source=>({id:source.id,revision:source.revision,status:source.status,dependencies:source.dependencies??[]}))};
  }
  pendingIndexCleanup(scope:SceneScope) {
    return this.db.prepare('SELECT character,version FROM scene_index_cleanup WHERE scope=?').all(scopeKey(scope)) as {character:string;version:number}[];
  }
  /** Recomputing an older degraded source must also discard analyses based on its old projection. */
  invalidateAfterDegraded(scope:SceneScope,sourceId:string,revision:number):void {
    this.transaction(()=>{
      const accepted=this.state(scope).sources.filter(source=>source.status==='accepted');
      const index=accepted.findIndex(source=>source.id===sourceId&&source.revision===revision&&source.analysis?.skippedStages?.length);
      if(index<0)throw new Error('context_changed_retry');
      for(const source of accepted.slice(index+1)){
        const analysis=source.analysis?withoutEmotionStates(source.analysis):null;
        const next=analysis&&source.envelope.mode==='scene'?{...analysis,plan:null}:analysis;
        this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
          .run(next?JSON.stringify(next):null,scopeKey(scope),source.id);
        this.processing.clearSources(scope,[source.id]);
      }
      if(index+1<accepted.length){this.rebuildEmotionStates(scope);this.bump(scope);this.rebuildDerived(scope);}
    });
  }
  indexCleanupScopes():SceneScope[] {
    const rows=this.db.prepare('SELECT DISTINCT scope FROM scene_index_cleanup').all() as {scope:string}[];
    return rows.map(row=>{const [worldId,sessionId,branchId,characterId]=JSON.parse(row.scope);return {worldId,sessionId,branchId,characterId};});
  }
  finishIndexCleanup(scope:SceneScope,character:string,version:number) {
    this.db.prepare('DELETE FROM scene_index_cleanup WHERE scope=? AND character=? AND version=?').run(scopeKey(scope),character,version);
  }
  isOpen(){return this.db.isOpen;}

  /** Only Tavern roleplay scopes defer NPC emotion; other scopes are never scanned. */
  deferredEmotionScopes():SceneScope[] {
    const rows=this.db.prepare(`SELECT DISTINCT s.scope FROM scene_interactions i
      JOIN scene_interaction_bindings b ON b.owner=i.owner JOIN scene_sources s ON s.scope=b.physical_key
      WHERE i.host='sillytavern' AND s.status='accepted' AND s.processing='ready'
      AND json_array_length(json_extract(s.analysis,'$.emotionCandidateReadyIds'))>0`)
      .all() as {scope:string}[];
    return rows.map(row=>{
      const [worldId,sessionId,branchId,characterId]=JSON.parse(row.scope);
      return {worldId,sessionId,branchId,characterId};
    });
  }

  /** Consume one background candidate, or all prepared history for one foreground NPC. */
  completeDeferredEmotion(scope:SceneScope,foregroundCharacterId?:string):boolean {
    return this.transaction(()=>{
      const state=this.state(scope),blocked=new Set<string>();
      const resolveOwnLine = createEmotionLineResolver(state.sources, state.roster);
      let completed=false;
      for(const source of state.sources){
        if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis?.plan)continue;
        for(const id of source.analysis.emotionPendingIds??[]){
          const actor=state.roster.characters.find(character=>character.id===id);
          if(!actor||!actorHasEmotion(actor))continue;
          if (!this.shouldAppraiseEmotion(source, id, resolveOwnLine)) continue;
          if(foregroundCharacterId&&id!==foregroundCharacterId)continue;
          if(blocked.has(id))continue;
          // A terminal skip keeps its stored marker but cannot block later prepared experiences.
          if (hasCompletedEmotionSkip(source.analysis, id)) continue;
          if(!source.analysis.emotionCandidateReadyIds?.includes(id)){
            blocked.add(id);continue;
          }
          if(source.analysis.skippedStages?.some(item=>item.stage==='emotion'&&item.characterId===id)){
            blocked.add(id);continue;
          }
          if(!source.analysis.characters[id])throw new Error('invalid_scene_emotion_schedule');
          const remaining=source.analysis.emotionPendingIds!.filter(item=>item!==id);
          const ready=source.analysis.emotionCandidateReadyIds.filter(item=>item!==id);
          this.db.prepare("UPDATE scene_sources SET analysis=json_set(analysis,'$.emotionPendingIds',json(?),'$.emotionCandidateReadyIds',json(?)) WHERE scope=? AND id=? AND revision=? AND status='accepted' AND processing='ready'")
            .run(JSON.stringify(remaining),JSON.stringify(ready),scopeKey(scope),source.id,source.revision);
          completed=true;
          if(!foregroundCharacterId){this.rebuildEmotionStates(scope,id);return true;}
        }
      }
      if(completed)this.rebuildEmotionStates(scope,foregroundCharacterId);
      return completed;
    });
  }

  /** Install a real model candidate for a pre-upgrade placeholder after explicit processing. */
  recordLegacyEmotionCandidate(scope:SceneScope,expectedVersion:number,sourceId:string,revision:number,
    characterId:string,result:import('../core/models.ts').SceneEmotionResult):void {
    this.transaction(()=>{
      const state=this.state(scope,true);
      const actor=state.roster.characters.find(character=>character.id===characterId);
      if(actor&&!actorHasEmotion(actor))return;
      if(state.version!==expectedVersion)throw new Error('context_changed_retry');
      const source=state.sources.find(item=>item.id===sourceId&&item.revision===revision&&item.status==='accepted'
        &&item.processing==='ready'&&item.analysis?.plan&&item.analysis.emotionPendingIds?.includes(characterId)
        &&!item.analysis.emotionCandidateReadyIds?.includes(characterId));
      const resolveOwnLine = createEmotionLineResolver(state.sources, state.roster);
      if (source && !this.shouldAppraiseEmotion(source, characterId, resolveOwnLine)) return;
      if(!source?.analysis?.plan||!source.analysis.characters[characterId])throw new Error('context_changed_retry');
      const relationships=validateRelationships(result.relationships,
        relationshipValidationContext(source,source.analysis.plan,state.roster,characterId));
      if (Object.hasOwn(result.emotion, 'appraisalRule')) {
        stampStoreFormat(this.db, CURRENT_STORE_FORMAT, STORE_WRITER_VERSION);
      }
      const prior=source.analysis.characters[characterId]!;
      const counterpartId = selectEmotionCounterpart(
        source, source.analysis.plan, characterId, state.roster, actorHasEmotion,
      );
      const emotion = withEmotionCounterpart({...result.emotion, stableRelationDelta: {}}, counterpartId);
      const analysis={...source.analysis,characters:{...source.analysis.characters,
        [characterId]:{...prior,emotion,
          ...(relationships.length?{relationships}:{})}},
        emotionCandidateReadyIds:[...(source.analysis.emotionCandidateReadyIds??[]),characterId]};
      this.db.prepare("UPDATE scene_sources SET analysis=? WHERE scope=? AND id=? AND revision=? AND status='accepted' AND processing='ready'")
        .run(JSON.stringify(analysis),scopeKey(scope),sourceId,revision);
    });
  }

  commit(scope: SceneScope, expectedVersion: number, results: {id:string;revision:number;analysis:SceneAnalysis}[]) {
    return this.transaction(() => {
      const state = this.state(scope);
      if (state.version !== expectedVersion) throw new Error('context_changed_retry');
      const prepared=results.map(result=>{
        const source=state.sources.find(item=>item.id===result.id);
        if(!source||source.status!=='accepted'||source.revision!==result.revision)throw new Error('context_changed_retry');
        return {...result,analysis:localAnalysis(result.analysis,source,this.hooks.decodeUserModelCandidates,state.roster)};
      });
      if (prepared.some(result => Object.values(result.analysis.characters)
        .some(analysis => analysis.emotion && Object.hasOwn(analysis.emotion, 'appraisalRule')))) {
        stampStoreFormat(this.db, CURRENT_STORE_FORMAT, STORE_WRITER_VERSION);
      }
      const settings=this.worldSettings(scope);
      const effective=[...state.sources];
      // The whole final timeline of this commit, complete before the first clock read and never assigned to afterwards:
      // the story-clock reading is cached by this array's identity, so it must not be the array the loop mutates.
      const timeline=state.sources.map(source=>{
        const result=prepared.find(item=>item.id===source.id);
        return result?{...source,processing:'ready' as const,analysis:result.analysis}:source;
      });
      // The legacy times of this commit come from one object over the final timeline: a prefix of `effective` and the
      // same prefix of `timeline` hold the same world effects and the same clock analyses.
      const commitTimes=this.storyClock.legacyTimeline(scope,timeline);
      for(const [index,source] of state.sources.entries()){
        const result=prepared.find(item=>item.id===source.id);if(!result)continue;
        effective[index]={...source,processing:'ready',analysis:result.analysis};
        result.analysis=validateCommitmentAnalysis(source,result.analysis,state.roster,{
          realClockTimeMs:source.acceptedAtMs,
          // Replay this source's accepted story effects; never consult current time.
          storyClockTimeMs:settings?.mode==='story'?commitTimes.at(index,source.acceptedAtMs):undefined,
          timeZone:source.acceptedTimeZone,
        });
        effective[index]={...source,processing:'ready',analysis:result.analysis};
      }
      const windowSelections=new Map<string,Set<string>>();
      for(const source of effective){
        if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis)continue;
        const schedule=source.analysis.emotionSchedule;
        const pending=source.analysis.emotionPendingIds??[];
        const ready=source.analysis.emotionCandidateReadyIds??[];
        if(pending.some(id=>!source.analysis!.characters[id]||!schedule?.deferredIds.includes(id)))
          throw new Error('invalid_scene_emotion_schedule');
        if(new Set(ready).size!==ready.length||ready.some(id=>!pending.includes(id)||
          source.analysis!.skippedStages?.some(item=>item.stage==='emotion'&&item.characterId===id)))
          throw new Error('invalid_scene_emotion_schedule');
        if(!schedule)continue;
        if(!schedule.windowId||new Set(schedule.eligibleIds).size!==schedule.eligibleIds.length||
          new Set(schedule.selectedIds).size!==schedule.selectedIds.length||new Set(schedule.forcedIds).size!==schedule.forcedIds.length||
          new Set(schedule.deferredIds).size!==schedule.deferredIds.length||
          schedule.selectedIds.some(id=>!schedule.eligibleIds.includes(id)||
            (schedule.deferredIds.includes(id)&&!source.analysis?.skippedStages?.some(item=>item.stage==='emotion'&&item.characterId===id)))||
          schedule.forcedIds.some(id=>!schedule.selectedIds.includes(id)))throw new Error('invalid_scene_emotion_schedule');
        const selected=windowSelections.get(schedule.windowId)??new Set<string>();
        for(const id of schedule.selectedIds)if(!schedule.forcedIds.includes(id))selected.add(id);
        if(selected.size>4)throw new Error('invalid_scene_emotion_budget');
        windowSelections.set(schedule.windowId,selected);
      }
      const acceptedResults=prepared;
      const foldInput=this.worldLedgerInput(scope,effective,settings);
      if(foldInput.settings){
        const folded=foldWorldState(foldInput.settings,foldInput.sources,foldInput.options);
        if(folded.issues.length) throw new Error('invalid_world_'+folded.issues[0]!.code.replace(/^invalid_world_/,''));
      }
      for (const result of acceptedResults) {
        const source = state.sources.find(item => item.id === result.id);
        if (!source || source.status !== 'accepted' || source.revision !== result.revision) throw new Error('context_changed_retry');
        if (result.analysis.plan.unresolved.length) throw new Error('invalid_scene_unresolved');
        if(result.analysis.physiologyOperations!==undefined)
          result.analysis.physiologyOperations=this.physiology.validateStored(result.analysis.physiologyOperations,source,result.analysis.plan,state.roster);
        if(result.analysis.geographyOperations!==undefined)
          result.analysis.geographyOperations=this.geography.validateStored(result.analysis.geographyOperations,source,result.analysis.plan,state.roster);
        const allowedIds = new Set(result.analysis.plan.observations.flatMap(observation => observation.readers));
        for (const [characterId,analysis] of Object.entries(result.analysis.characters)) {
          if (!allowedIds.has(characterId) || !state.roster.characters.some(character => character.id === characterId)) throw new Error('invalid_scene_character');
          const quotes = result.analysis.plan.observations.filter(observation => observation.readers.includes(characterId)).map(observation => observation.quote);
          if (analysis.memories.some(memory => !quotes.some(quote => quote.includes(memory.detail)) ||
            memory.protectedFacts.some(fact => !quotes.some(quote => quote.includes(fact))) ||
            (memory.episode?.evidenceQuotes??[]).some(evidence=>!quotes.some(quote=>quote.includes(evidence))))) throw new Error('invalid_scene_memory_source');
          if (analysis.relationships !== undefined) analysis.relationships=validateRelationships(analysis.relationships,
            relationshipValidationContext(source,result.analysis.plan,state.roster,characterId));
        }
        this.migrateControls(scope,source,result.analysis);
        const dependencies=[...(source.dependencies??[])];
        for(const observation of result.analysis.plan.observations) for(const reference of observation.identityEvidence??[]) {
          const origin=state.sources.find(item=>item.id===reference.sourceId && item.status==='accepted' && item.revision===reference.revision);
          if(!origin || origin.id===source.id) throw new Error('invalid_scene_evidence');
          if(!dependencies.some(item=>item.id===origin.id)) dependencies.push({id:origin.id,revision:origin.revision});
        }
        const {analysis:_analysis,observedAtMs:_observed,status:_status,processing:_processing,...message}=source;
        this.db.prepare("UPDATE scene_sources SET processing='ready',analysis=?,message=? WHERE scope=? AND id=? AND revision=?")
          .run(JSON.stringify(result.analysis),JSON.stringify({...message,dependencies}),scopeKey(scope),result.id,result.revision);
      }
      if (acceptedResults.length) {
        this.rebuildEmotionStates(scope);
        this.bump(scope);
        this.rebuildDerived(scope);
        this.hooks.onCommitted(scope);
      }
      return this.state(scope).version;
    });
  }

  /**
   * `storyClock` (the post-SC failure path, SC3b): in a story scope every source this call moves from 'pending' to
   * 'failed' also gets analysis.storyClock = {kind:'degraded',reason,issues}, in the same transaction. Without it, or
   * outside a story scope, the rows are exactly today's.
   */
  fail(scope: SceneScope, version: number, sourceIds?:readonly string[],
    storyClock?:{reason:StoryClockDegradeReason;issues?:readonly StoryClockIssue[]}) {
    if(storyClock!==undefined&&!(STORY_CLOCK_DEGRADE_REASONS as readonly unknown[]).includes(storyClock?.reason))
      throw new Error('invalid_story_clock_degrade');
    this.transaction(() => {
      if (this.state(scope).version !== version) return;
      if(storyClock!==undefined&&this.isStoryScope(scope)){
        const marker=JSON.stringify({kind:'degraded',reason:storyClock.reason,issues:storyClock.issues??[]});
        // A null analysis takes the shape reconcile leaves on an edited source, so readers of analysis.characters keep working.
        const fail=this.db.prepare(`UPDATE scene_sources SET processing='failed',
          analysis=json_set(COALESCE(analysis,'{"plan":null,"characters":{}}'),'$.storyClock',json(?))
          WHERE scope=? AND id=? AND status='accepted' AND processing='pending'`);
        const ids=sourceIds?.length?new Set(sourceIds):new Set(this.state(scope).sources.map(source=>source.id));
        for(const sourceId of ids)fail.run(marker,scopeKey(scope),sourceId);
        // A marked source changes the clock fold (its turn counts with the fallback), so later snapshots may be stale. No version bump.
        this.rebuildEmotionStatesGuarded(scope);
        return;
      }
      if(sourceIds?.length){
        const fail=this.db.prepare("UPDATE scene_sources SET processing='failed' WHERE scope=? AND id=? AND status='accepted' AND processing='pending'");
        for(const sourceId of new Set(sourceIds))fail.run(scopeKey(scope),sourceId);
      }else this.db.prepare("UPDATE scene_sources SET processing='failed' WHERE scope=? AND status='accepted' AND processing='pending'").run(scopeKey(scope));
      // Failed pending sources can introduce legacy clock movement even without an explicit clock marker.
      if (this.#emotionEngineRule === 3) this.rebuildEmotionStatesGuarded(scope);
    });
  }

  /**
   * Build server-owned recall entries in visible-row order. Positions outside the storage limit are omitted.
   * The snapshot and weak ids come from that exact context; no host-supplied recall data is consulted.
   */
  recallRecords(
    characterId: string,
    snapshot: MemorySnapshot,
    views: readonly MemoryView[],
    weakIds: ReadonlySet<string> = new Set()
  ): SceneRecall[] {
    const entries: SceneRecall[] = [];
    const seen = new Set<string>();
    for (const view of views) {
      if (view.reactivated !== true)
        continue;
      if (![view.detail, view.gist, view.feeling, view.anchor].some(value => value?.trim()) &&
        !view.protectedFacts.length && !view.emotionalReaction && !view.rememberedFragments?.length)
        continue;
      const memory = snapshot.memories.get(view.id);
      if (!memory)
        continue;
      const identity = memoryIdentity(memory);
      const key = JSON.stringify([memory.source.messageId, memory.source.revision, identity]);
      if (seen.has(key))
        continue;
      seen.add(key);
      const details = (memory.selectedRecallDetails ?? [])
        .filter(
          range => {
            if (range.end > 20000)
              return false;
            const shown = memory.detail.slice(range.start, range.end).trim();
            return range.stray === true ? view.strayDetail === shown : view.recalledDetails?.includes(shown);
          }
        )
        .map(
          range => ({
            start: range.start,
            end: range.end,
            ...(range.stray === true ? {stray: true as const} : {}),
          })
        );
      entries.push(
        {
          character: characterId,
          source: memory.source.messageId,
          revision: memory.source.revision,
          identity,
          ...(weakIds.has(memory.id) ? {strength: 'weak' as const} : {}),
          ...(details.length ? {details} : {}),
        }
      );
      if (entries.length === TRACE_RECORD_LIMIT)
        break;
    }
    return entries;
  }

  /** Derive retention origins and turn counts from accepted rows; the optional reply source cannot rehearse itself. */
  snapshot(
    scope: SceneScope,
    characterId: string,
    state = this.state(scope),
    currentSource?: {
      id: string;
      revision: number;
    }
  ): MemorySnapshot {
    if (!state.roster.characters.some(character => character.id === characterId)) {
      throw new Error('invalid_scene_character');
    }
    const roleScope = npcScope(scope, characterId);
    const sources = state.sources.filter(source => source.status === 'accepted' && source.processing === 'ready' && source.analysis);
    const controls = this.db.prepare('SELECT id,revision,access FROM scene_controls WHERE scope=? AND character=?')
      .all(scopeKey(scope), characterId) as {
        id: string;
        revision: number;
        access: Access;
      }[];
    const memories = new Map<string, Memory>();
    const reading = this.storyClock.read(scope, state);
    const timeOf = (source: SceneSource) => reading
      ? this.storyClock.atSource(reading, {sourceId: source.id, revision: source.revision}) ?? reading.result.state.atMs
      : source.acceptedAtMs;
    // Each visible excerpt and each candidate cue is folded once per snapshot. Matching uses those cached strings.
    // Sources are visited once for the lookup; each memory matches only its cues and its own recorded entries.
    const foldedSources = new Map<number, string[]>();
    const records = new Map<string, Map<number, {
      weak: boolean;
      details?: RecallDetailRange[];
    }>>();
    // Invalid detail locations cannot erase a rehearsal that otherwise matches the memory.
    // At most three ranges are visited; checking their own keys is linear in the imported key count.
    const rangesOf = (entry: SceneRecall): RecallDetailRange[] | undefined => {
      try {
        if (!Object.hasOwn(entry, 'details'))
          return undefined;

        const value = entry.details;
        if (!Array.isArray(value) || value.length < 1 || value.length > 3)
          return undefined;

        const ranges: RecallDetailRange[] = [];
        let previousEnd = 0;
        let strayCount = 0;
        for (const item of value) {
          if (!item || typeof item !== 'object' || Array.isArray(item) ||
            Object.keys(item).some(key => !['start', 'end', 'stray'].includes(key)) ||
            !Number.isSafeInteger(item.start) || !Number.isSafeInteger(item.end) ||
            item.start < previousEnd || item.start < 0 || item.start >= item.end || item.end > 20000 ||
            (Object.hasOwn(item, 'stray') && item.stray !== true))
            return undefined;

          previousEnd = item.end;
          if (Object.hasOwn(item, 'stray') && item.stray === true && ++strayCount > 1)
            return undefined;

          ranges.push({
            start: item.start,
            end: item.end,
            ...(Object.hasOwn(item, 'stray') && item.stray === true ? {stray: true} : {})
          });
        }

        return ranges;
      }
      catch {
        return undefined;
      }
    };
    for (const [sourceIndex, source] of sources.entries()) {
      if (source.id === currentSource?.id && source.revision === currentSource.revision)
        continue;
      const excerpts = source.analysis?.plan?.observations
        .filter(observation => observation.readers.includes(characterId)).map(observation => foldCue(observation.quote));
      if (excerpts?.length)
        foldedSources.set(sourceIndex, excerpts);
      // Malformed imported lists do not affect reads; the write path remains strict.
      try {
        if (source.role !== 'assistant' || !Array.isArray(source.recalled) ||
          source.recalled.length > TRACE_RECORD_LIMIT)
          continue;
        for (const entry of source.recalled) {
          try {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.character !== characterId ||
              typeof entry.source !== 'string' || !Number.isSafeInteger(entry.revision) ||
              typeof entry.identity !== 'string' || (Object.hasOwn(entry, 'strength') && entry.strength !== 'weak'))
              continue;
            const details = rangesOf(entry);
            const key = JSON.stringify([entry.source, entry.revision, entry.identity]);
            const bySource = records.get(key) ?? new Map();
            const weak = Object.hasOwn(entry, 'strength') && entry.strength === 'weak';
            const previous = bySource.get(sourceIndex);
            // Strong is sticky within one source; within one strength the first entry owns its details.
            if (!previous || (previous.weak && !weak)) {
              bySource.set(sourceIndex, {weak, ...(details ? {details} : {})});
              records.set(key, bySource);
            }
          }
          catch {
            // One corrupt imported entry must not hide the other valid entries.
          }
        }
      }
      catch {
        // A malformed recalled member is absent for this read.
      }
    }
    for (const [sourceIndex, source] of sources.entries()) {
      const plan = source.analysis!.plan;
      if (!plan)
        continue;
      const observations = plan.observations.filter(observation => observation.readers.includes(characterId));
      const analysis = Object.hasOwn(source.analysis!.characters, characterId)
        ? source.analysis!.characters[characterId] : undefined;
      if (!analysis)
        continue;
      for (const [index, candidate] of analysis.memories.entries()) {
        const observation = observations.find(item => item.quote.includes(candidate.detail));
        if (!observation)
          continue;
        const id = `${source.id}:${characterId}#${index}`;
        const controlId = memoryControlId(source.id, characterId, candidate);
        const control = controls.find(control => control.id === controlId && control.revision === 0) ??
          controls.find(control => control.id === id && control.revision === source.revision);
        const access = control?.access ?? 'clear';
        const cues = foldedCues(candidate.retention?.cues ?? []);
        const recorded = records.get(JSON.stringify([source.id, source.revision, memoryIdentity(candidate)]));
        const refreshes = new Map<number, {
          kind: 'full' | 'gist' | 'weak';
          details?: RecallDetailRange[];
        }>();
        if (cues.length) {
          for (const [laterIndex, excerpts] of foldedSources) {
            if (laterIndex <= sourceIndex)
              continue;
            const found = cues.filter(cue => excerpts.some(excerpt => excerpt.includes(cue)));
            const count = found.filter(cue => !found.some(other => other !== cue && other.includes(cue))).length;
            if (count)
              refreshes.set(laterIndex, {kind: count >= TRACE_STRONG_CUES ? 'full' : 'gist'});
          }
        }
        if (recorded) {
          for (const [laterIndex, entry] of recorded) {
            if (laterIndex <= sourceIndex)
              continue;
            const kind = refreshes.get(laterIndex)?.kind ?? (entry.weak ? 'weak' : 'gist');
            refreshes.set(laterIndex, {kind, ...(entry.details ? {details: entry.details} : {})});
          }
        }
        let retentionSource = source;
        let gistSource: SceneSource | undefined;
        let weakSource: SceneSource | undefined;
        let recallDetails: Memory['recallDetails'];
        const strongTurns = new Set<string>();
        const weakTurns = new Set<string>();
        const ownTurn = source.replyTo?.id ?? source.id;
        for (const [laterIndex, refresh] of [...refreshes].sort(([left], [right]) => left - right)) {
          const later = sources[laterIndex]!;
          if (refresh.kind === 'full')
            retentionSource = later;
          else if (refresh.kind === 'gist')
            gistSource = later;
          else
            weakSource = later;
          recallDetails = refresh.details ? {atMs: timeOf(later), ranges: refresh.details} : undefined;
          const turn = later.replyTo?.id ?? later.id;
          if (turn === ownTurn)
            continue;
          if (refresh.kind === 'weak')
            weakTurns.add(turn);
          else
            strongTurns.add(turn);
        }
        for (const turn of strongTurns)
          weakTurns.delete(turn);
        const retentionAtMs = timeOf(retentionSource);
        const gistAtMs = gistSource ? timeOf(gistSource) : undefined;
        const weakAtMs = weakSource ? timeOf(weakSource) : undefined;
        const gistRetentionAtMs = gistAtMs !== undefined && gistAtMs > retentionAtMs ? gistAtMs : undefined;
        const weakRetentionAtMs = weakAtMs !== undefined && weakAtMs > retentionAtMs &&
          (gistRetentionAtMs === undefined || weakAtMs > gistRetentionAtMs) ? weakAtMs : undefined;
        memories.set(
          id,
          {
            ...candidate,
            id,
            scope: roleScope,
            status: 'accepted',
            access,
            accessOverride: control !== undefined,
            retentionAtMs,
            ...(gistRetentionAtMs === undefined ? {} : {gistRetentionAtMs}),
            ...(weakRetentionAtMs === undefined ? {} : {weakRetentionAtMs}),
            ...(strongTurns.size ? {rehearsalSources: strongTurns.size} : {}),
            ...(weakTurns.size ? {weakRehearsalSources: weakTurns.size} : {}),
            ...(recallDetails ? {recallDetails} : {}),
            source: {
              messageId: source.id,
              revision: source.revision,
              occurredAtMs: source.acceptedAtMs,
              knownAtMs: Math.max(source.acceptedAtMs, source.observedAtMs),
              author: {
                role: source.role,
                actorId: source.role === 'user' ? 'player' : source.automatic ? 'narrator' : source.speakerId!,
              },
              knowledge: {
                kind: observation.kind,
                ...(source.role === 'user' && source.envelope.mode === 'direct'
                  ? {actorId: 'player'} : observation.actorId ? {actorId: observation.actorId} : {}),
                observationId: observation.id,
                start: observation.start,
                end: observation.end,
              },
            },
          }
        );
      }
    }
    const references = this.transfer.projection(scope, characterId, state);
    for (const [id, memory] of references.memories)
      memories.set(id, memory);
    const messages = new Map<string, {
      revision: number;
      status: 'accepted' | 'deleted';
    }>(sources.map(source => [source.id, {revision: source.revision, status: 'accepted' as const}]));
    for (const [id, message] of references.messages)
      messages.set(id, message);
    const replyParents = new Map<string, {
      assistantRevision: number;
      parentMessageId: string;
      parentRevision: number;
    }>();
    const previousUsers = new Map<string, SceneSource>();
    for (const source of sources) {
      if (source.role === 'user')
        previousUsers.set(source.id, source);
      if (source.role !== 'assistant' || !source.replyTo)
        continue;
      const parent = previousUsers.get(source.replyTo.id);
      if (parent?.revision === source.replyTo.revision) {
        replyParents.set(
          source.id,
          {
            assistantRevision: source.revision,
            parentMessageId: parent.id,
            parentRevision: parent.revision,
          }
        );
      }
    }
    return {
      scope: roleScope,
      version: state.version,
      messages,
      memories,
      ...(replyParents.size ? {replyParents} : {}),
      ...(reading ? {memoryTimeMs: reading.result.state.atMs} : {}),
    };
  }

  /**
   * Returns expression time in story milliseconds for the current rule, or the legacy Unix domain for the older rule.
   * A real-time scope under the current rule returns null. Clock and ledger errors propagate unchanged.
   */
  expressionClockTime(scope: SceneScope, sources: SceneSource[], fallbackMs: number,
    timeline?: SceneSource[]): number | null {
    if (this.#emotionEngineRule === 3) {
      return this.storyClock.emotionTimeline(scope, sources, timeline)?.atMs ?? null;
    }
    return this.legacyEmotionTime(scope, sources, fallbackMs, sources, timeline);
  }

  emotion(scope: SceneScope, characterId: string, now = Date.now(), state = this.state(scope), timeline?:SceneSource[]) {
    return this.withLedgerRows(scope,()=>{
      const {emotion, settings, clockProjection} = this.emotionBase(scope, characterId, state, timeline);
      if (this.#emotionEngineRule === 3) {
        const character = state.roster.characters.find(item => item.id === characterId)!;
        if (!actorHasEmotion(character)) return emotion;
        if (clockProjection !== undefined) {
          return emotionAtWithClock(emotion, clockProjection.timeMs, clockProjection, settings);
        }
        const clock = this.interactions.modeOf(scope) ? this.interactions.clock(scope, now) : null;
        const timeZone = clock === null ? null : clock.known ? clock.timeZone : null;
        const readTimeMs = Math.max(emotion.updatedAtMs, now);
        return emotionAtWithClock(emotion, now, {
          hungerHours: (readTimeMs - emotion.updatedAtMs) / 3_600_000,
          timeOfDay: realTimeOfDay(readTimeMs, timeZone),
        }, settings);
      }
      const clock=this.interactions.modeOf(scope)?this.interactions.clock(scope,now):null;
      return emotionAt(emotion,this.legacyEmotionTime(scope,state.sources,now,state.sources,timeline),settings,
        clock===null?this.worldSettings(scope)?.mode==='story'?'UTC':null:clock.known?clock.timeZone:null);
    });
  }

  /**
   * E0: the latest persisted (replayed) OpenHer state before any read-time projection, with the character's emotion
   * settings. Cached by the same replay key as `emotion`; the caller must not mutate it.
   */
  emotionBase(scope: SceneScope, characterId: string, state = this.state(scope), timeline?: SceneSource[]): {
    emotion: EmotionState;
    settings: unknown;
    clockProjection?: {timeMs: number; hungerHours: number; timeOfDay: number};
  } {
    return this.withLedgerRows(scope, () => {
      const character = state.roster.characters.find(character => character.id === characterId);
      if (!character)
        throw new Error('invalid_scene_character');
      if (this.#emotionEngineRule === 3) {
        const clock = this.storyClock.emotionTimeline(scope, state.sources, timeline);
        const engine = createEmotionEngineKey(3, clock === null ? 'real' : 'story');
        const eligible = actorHasEmotion(character);
        const positionOf = (source: SceneSource): number => clock!.positions.get(
          JSON.stringify([source.id, source.revision]),
        )!;
        const eligibleIds = state.roster.characters.filter(actorHasEmotion).map(actor => actor.id);
        const invalidFrom = clock === null ? Infinity
          : this.emotionInvalidFrom(scope, state.sources, clock, engine, eligibleIds, state.roster);
        const snapshotRows = this.db.prepare(
          "SELECT s.id,s.revision,j.value AS body FROM scene_sources s,json_each(s.analysis,'$.emotionStates') j " +
          "WHERE s.scope=? AND s.status='accepted' AND s.processing='ready' AND j.key=?",
        ).all(scopeKey(scope), characterId);
        const storedSnapshots = new Map(snapshotRows.map(snapshotRow => [
          JSON.stringify([snapshotRow.id, snapshotRow.revision]), String(snapshotRow.body),
        ]));
        const resolveOwnLine = createEmotionLineResolver(state.sources, state.roster);
        const replay = eligible ? emotionReplaySteps(state.sources, characterId, false, resolveOwnLine)
          : {events: [], anchors: [], sources: []};
        const relationInputs = emotionRelationInputs(scope, state.sources, replay.events, character, state.roster);
        const anchorSet = new Set(replay.anchors);
        const plan = clock === null ? null : planEmotionClock({
          characterId,
          sources: clock.sources,
          events: replay.events.map(source => ({
            sourceIndex: positionOf(source),
            relation: source.analysis!.characters[characterId]!.emotion!.relation,
          })),
          anchorIndices: replay.anchors.map(positionOf),
        });
        const hungerByIndex = new Map([...plan?.events ?? [], ...plan?.anchors ?? []]
          .map(step => [step.sourceIndex, step.hungerHours]));
        const initialTime = emotionInitialTime(clock, replay.sources, state.createdAtMs);
        const snapshotInputs = this.emotionSnapshotInputs.get(JSON.stringify([scopeKey(scope), characterId]));
        const snapshotHash = emotionSnapshotHeader(scope, character, engine, initialTime);
        let previousTime = initialTime;
        let seenAnchor = false;
        let knownSnapshotThrough = -1;
        const steps = replay.sources.map((source, index) => {
          const clockSource = clock?.sources[positionOf(source)];
          const eventTimeMs = clockSource?.clockMs ?? source.acceptedAtMs;
          const anchor = anchorSet.has(source);
          seenAnchor ||= anchor;
          const delta = anchor ? undefined : source.analysis!.characters[characterId]!.emotion!;
          const elapsedHours = Math.max(0, eventTimeMs - previousTime) / 3_600_000;
          const hungerHours = clock === null ? elapsedHours : hungerByIndex.get(positionOf(source))!;
          previousTime = Math.max(previousTime, eventTimeMs);
          const timeOfDay = anchor && clockSource === undefined
            ? realTimeOfDay(source.acceptedAtMs, source.acceptedTimeZone ?? null)
            : emotionEventTimeOfDay(source, delta, clockSource);
          const snapshot = source.analysis?.emotionStates;
          const snapshotBody = snapshot != null && Object.hasOwn(snapshot, characterId)
            ? JSON.stringify(snapshot[characterId]) : storedSnapshots.get(JSON.stringify([source.id, source.revision]));
          const relationInput = relationInputs.get(source) ?? null;
          const fingerprint = seenAnchor ? undefined : appendEmotionSnapshotInput(snapshotHash, {
            source, anchor, delta, relationInput, eventTimeMs, hungerHours, timeOfDay,
          });
          const knownInputs = fingerprint !== undefined
            && snapshotInputs?.get(JSON.stringify([source.id, source.revision])) === fingerprint;
          if (knownInputs) knownSnapshotThrough = index;
          return {
            source, anchor, delta, eventTimeMs, elapsedHours, hungerHours, timeOfDay, relationInput,
            // Only matching prefixes before the first anchor can supply a replay result.
            adoptableBody: !knownInputs || seenAnchor || (clock !== null && positionOf(source) >= invalidFrom)
              ? undefined : snapshotBody,
            // Even without local provenance, validate current pre-anchor snapshots to reject incompatible data.
            validatedBody: seenAnchor || (clock !== null && positionOf(source) >= invalidFrom)
              ? undefined : snapshotBody,
          };
        });
        // A matching final prefix authenticates its earlier inputs too. This preserves valid earlier
        // snapshots when a later stored clock is stale, without retaining one fingerprint per source.
        for (const [index, step] of steps.entries()) {
          if (index <= knownSnapshotThrough) step.adoptableBody = step.validatedBody;
        }
        // Hash the same JSON in bounded chunks so a long history needs no second full snapshot string.
        const replayHeader = JSON.stringify([
          scopeKey(scope), characterId, character.emotion, engine, initialTime,
        ]);
        const replayHash = createHash('sha256').update(replayHeader.slice(0, -1) + ',[');
        for (const [index, step] of steps.entries()) {
          if (index > 0) replayHash.update(',');
          replayHash.update(JSON.stringify([
            step.adoptableBody,
            step.delta,
            step.eventTimeMs,
            step.elapsedHours,
            step.hungerHours,
            step.timeOfDay,
            step.anchor,
            step.source.id,
            step.source.revision,
            step.relationInput,
          ]));
        }
        const replayKey = replayHash.update(']]').digest('hex');
        let emotion = this.emotionReplayCache.get(replayKey);
        if (emotion === undefined) {
          emotion = createEmotion(initialTime, character.emotion, emotionIdentitySeed(scope, characterId), engine);
          for (const step of steps) {
            if (step.anchor) {
              emotion = advanceEmotionAnchor(emotion, step.eventTimeMs, {
                hungerHours: step.hungerHours,
                timeOfDay: step.timeOfDay,
                eventClockMs: step.eventTimeMs,
              }, character.emotion, engine);
            } else {
              const storedState = step.validatedBody === undefined ? undefined : JSON.parse(step.validatedBody);
              const validated = recognizesEmotionSnapshot(storedState, 3, () => engine)
                ? validateEmotionState(storedState) : undefined;
              if (step.adoptableBody !== undefined && validated !== undefined) {
                emotion = validated;
                continue;
              }
              emotion = advanceEmotionWithClock(emotion, step.delta!, step.eventTimeMs, {
                hungerHours: step.hungerHours, timeOfDay: step.timeOfDay, eventClockMs: step.eventTimeMs,
              }, character.emotion, engine, undefined, undefined, {
                sourceId: step.source.id,
                revision: step.source.revision,
              }, step.relationInput);
            }
          }
          // Replayed and adopted states use the same validated member order and numeric representation.
          emotion = validateEmotionState(emotion);
          this.emotionReplayCache.set(replayKey, emotion);
          // The existing replay cache bounds retained neural states across all scopes and rules to 64 entries.
          if (this.emotionReplayCache.size > 64) {
            this.emotionReplayCache.delete(this.emotionReplayCache.keys().next().value!);
          }
        }
        return {
          emotion,
          settings: character.emotion,
          ...(clock === null ? {} : {clockProjection: {
            timeMs: clock.atMs,
            hungerHours: plan?.read?.hungerHours ?? 0,
            timeOfDay: storyTimeOfDay(clock.atMs, clock.timeOfDayKnown),
          }}),
        };
      }
      let engineKey: EmotionEngineKey | undefined;
      const currentKey = () => engineKey ??= createEmotionEngineKey(
        this.#emotionEngineRule, this.isStoryScope(scope) ? 'story' : 'real',
      );
      // The ordinary state read omits neural snapshots. Read them once and fingerprint
      // the actual role history, so unrelated world-version changes keep this replay.
      const rows = this.db.prepare("SELECT s.id,s.revision,j.value AS body,CASE WHEN j.type='object' THEN json_type(j.value,'$.engine') IS NOT NULL ELSE 0 END AS hasEngine FROM scene_sources s,json_each(s.analysis,'$.emotionStates') j WHERE s.scope=? AND s.status='accepted' AND s.processing='ready' AND j.key=?")
        .all(scopeKey(scope), characterId) as {
        id: string;
        revision: number;
        body: string;
        hasEngine: number;
      }[];
      const storedBySource = new Map(rows.map(row => [JSON.stringify([row.id, row.revision]), row]));
      // One object for this call: at most one settings derivation, one legacy world fold and one clock reading.
      const replayTimes = this.storyClock.legacyTimeline(scope, state.sources, timeline);
      const initialTime = replayTimes.initial(state.createdAtMs);
      const events: {
        stored: EmotionState | undefined;
        body: string | undefined;
        delta: import('../emotion/openher.ts').EmotionDelta;
        at: number | undefined;
        index: number;
        acceptedAtMs: number;
      }[] = [];
      for (const [index, source] of state.sources.entries()) {
        if (source.status !== 'accepted' || source.processing !== 'ready')
          continue;
        const analysis = source.analysis?.characters[characterId];
        if (!analysis?.emotion || source.analysis?.emotionPendingIds?.includes(characterId))
          continue;
        const stored = source.analysis?.emotionStates?.[characterId];
        const storedRow = storedBySource.get(JSON.stringify([source.id, source.revision]));
        const body = stored ? JSON.stringify(stored) : storedRow?.body;
        // SQLite reports presence without retaining a parsed neural state for every history entry.
        const tagged = Boolean(stored && Object.hasOwn(stored, 'engine')) || Boolean(storedRow?.hasEngine);
        if (this.#emotionEngineRule === 2 && tagged) currentKey();
        events.push({ stored, body, delta: withoutEmotionCounterpart(analysis.emotion), index,
          acceptedAtMs: source.acceptedAtMs,
          at: body === undefined ? replayTimes.at(index, source.acceptedAtMs) : undefined });
      }
      const replayIdentity: unknown[] = [
        scopeKey(scope),
        characterId,
        character.emotion,
        initialTime,
        events.map(event => [
          event.body,
          event.body === undefined ? event.delta : undefined,
          event.at,
        ]),
      ];
      if (engineKey !== undefined) replayIdentity.push(engineKey);
      const replayKey = createHash('sha256').update(JSON.stringify(replayIdentity)).digest('hex');
      let emotion = this.emotionReplayCache.get(replayKey);
      if (!emotion) {
        const selectedEngine: EmotionEngineKey | undefined = undefined;
        emotion = createEmotion(initialTime, character.emotion, emotionIdentitySeed(scope, characterId), selectedEngine);
        for (const event of events) {
          const snapshot = event.body === undefined ? undefined : event.stored ?? JSON.parse(event.body);
          const unknownSnapshot = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
            && !recognizesEmotionSnapshot(snapshot, this.#emotionEngineRule, currentKey);
          if (event.body !== undefined && !unknownSnapshot) {
            emotion = validateEmotionState(snapshot);
          }
          else {
            // A skipped snapshot still belongs to its original source position on the timeline.
            const at = event.at ?? replayTimes.at(event.index, event.acceptedAtMs);
            emotion = advanceEmotion(emotion, event.delta, at, character.emotion, selectedEngine);
          }
        }
        this.emotionReplayCache.delete(replayKey);
        this.emotionReplayCache.set(replayKey, emotion);
        if (this.emotionReplayCache.size > 64)
          this.emotionReplayCache.delete(this.emotionReplayCache.keys().next().value!);
      }
      return { emotion, settings: character.emotion };
    });
  }

  /**
   * Finds the first stale source once per scope, folded prefix, eligibility set and snapshot write version.
   * Metadata work is O(sources + eligible snapshots) on a miss; warm calls inspect only O(sources) prefix metadata.
   * The database stamp also rejects rolled-back writes and commits made through another connection.
   */
  private emotionInvalidFrom(scope: SceneScope, sources: SceneSource[], clock: StoryEmotionTimeline,
    engine: EmotionEngineKey, eligibleIds: string[], roster: SceneRoster): number {
    const resolveOwnLine = createEmotionLineResolver(sources, roster);
    const eligible = new Set(eligibleIds);
    const prefix = sources.map(source => [source.id, source.revision, source.status, source.processing,
      source.role, source.automatic, source.speakerId, source.replyTo, source.analysis?.plan,
      source.analysis?.skippedStages,
      // Relation data conservatively invalidates this cache; its only cost is additional cache misses.
      eligibleIds.map(id => Object.hasOwn(source.analysis?.characters ?? {}, id)
        ? [id, source.analysis!.characters[id]!.relationships, source.analysis!.characters[id]!.emotion?.relation] : null),
      Object.entries(source.analysis?.emotionStates ?? {}).filter(([actorId]) => eligible.has(actorId))
        .map(([actorId, snapshot]) => [actorId, snapshot?.version, snapshot?.engine, snapshot?.eventClockMs]),
    ]);
    const stamp = JSON.stringify([clock.stamp, prefix, this.ledgerDatabaseStamp(), eligibleIds]);
    const key = scopeKey(scope);
    const previous = this.#emotionValidityCache.get(key);
    if (previous?.stamp === stamp) return previous.invalidFrom;

    let invalidFrom = Infinity;
    for (const source of sources) {
      if (source.status !== 'accepted' || source.processing !== 'ready') continue;
      if (eligibleIds.some(characterId => isOwnEmotionLine(source, characterId, resolveOwnLine))) {
        const position = clock.positions.get(JSON.stringify([source.id, source.revision]));
        if (position !== undefined) invalidFrom = Math.min(invalidFrom, position);
      }
    }
    const inspectSnapshot = (sourceId: string, revision: number, snapshot: unknown): void => {
      const position = clock.positions.get(JSON.stringify([sourceId, revision]));
      if (position === undefined || !recognizesEmotionSnapshot(snapshot, 3, () => engine)) return;
      if ((snapshot as EmotionState).eventClockMs !== clock.sources[position]!.clockMs) {
        invalidFrom = Math.min(invalidFrom, position);
      }
    };
    const snapshotRows = this.db.prepare(
      "SELECT s.id,s.revision,j.key AS actorId,json_extract(j.value,'$.version') AS version," +
      "json_extract(j.value,'$.engine') AS engine,json_type(j.value,'$.engine') AS engineType," +
      "json_extract(j.value,'$.eventClockMs') AS eventClockMs " +
      "FROM scene_sources s,json_each(s.analysis,'$.emotionStates') j " +
      "WHERE s.scope=? AND s.status='accepted' AND s.processing='ready' AND j.type='object'",
    ).iterate(key);
    const ready = new Set(sources.filter(source =>
      source.status === 'accepted' && source.processing === 'ready',
    ).map(source => JSON.stringify([source.id, source.revision])));
    for (const snapshotRow of snapshotRows) {
      if (!eligible.has(String(snapshotRow.actorId))) continue;
      const sourceId = String(snapshotRow.id);
      const revision = Number(snapshotRow.revision);
      if (!ready.has(JSON.stringify([sourceId, revision]))) continue;
      inspectSnapshot(sourceId, revision, {
        version: snapshotRow.version,
        engine: snapshotRow.engineType === 'object' ? JSON.parse(String(snapshotRow.engine)) : snapshotRow.engine,
        eventClockMs: snapshotRow.eventClockMs,
      });
    }
    for (const source of sources) {
      if (source.status !== 'accepted' || source.processing !== 'ready') continue;
      for (const [actorId, snapshot] of Object.entries(source.analysis?.emotionStates ?? {})) {
        if (eligible.has(actorId)) inspectSnapshot(source.id, source.revision, snapshot);
      }
    }
    this.#emotionValidityCache.set(key, {stamp, invalidFrom});
    // Match the replay cache's existing bound; eviction only causes a fresh metadata scan.
    if (this.#emotionValidityCache.size > 64) {
      this.#emotionValidityCache.delete(this.#emotionValidityCache.keys().next().value!);
    }
    return invalidFrom;
  }

  /**
   * Recomputes omitted jumps for one actor or every eligible actor; results never enter storage or prompts.
   * Real-time scopes and the historical rule return an empty list. Work per actor is O(sources + events).
   * Source getters, clock errors and actor predicate errors propagate unchanged.
   */
  emotionJumpDiagnostics(scope: SceneScope, characterId?: string | null,
    state = this.state(scope), timeline?: SceneSource[]): OmittedEmotionJump[] {
    if (this.#emotionEngineRule !== 3) return [];
    return this.withLedgerRows(scope, () => {
      const clock = this.storyClock.emotionTimeline(scope, state.sources, timeline);
      if (clock === null) return [];
      const diagnostics: OmittedEmotionJump[] = [];
      for (const character of state.roster.characters) {
        if (characterId != null && character.id !== characterId || !actorHasEmotion(character)) continue;
        const replay = emotionReplaySteps(state.sources, character.id, false,
          createEmotionLineResolver(state.sources, state.roster));
        const events = replay.events.map(source => ({
          sourceIndex: clock.positions.get(JSON.stringify([source.id, source.revision]))!,
          relation: source.analysis!.characters[character.id]!.emotion!.relation,
        }));
        const plan = planEmotionClock({
          characterId: character.id,
          sources: clock.sources,
          events,
          anchorIndices: replay.anchors.map(source => clock.positions.get(
            JSON.stringify([source.id, source.revision]),
          )!),
        });
        for (const diagnostic of plan.diagnostics) diagnostics.push(diagnostic);
      }
      return diagnostics;
    });
  }

  /** Expression uses one explicit addressee, never the legacy global relation. */
  responseEmotion(scope:SceneScope,characterId:string,now=Date.now(),state=this.state(scope),targetId:string|null='player',timeline?:SceneSource[]) {
    const emotion=this.emotion(scope,characterId,now,state,timeline);
    const relation=targetId===null?undefined:this.relationshipAnchor(scope,characterId,targetId,state);
    return {...emotion,stableRelations:relation?.relations??{depth:0,trust:0,valence:0}};
  }

  /**
   * One source-bound contact projection shared by foreground, proactive, and relationship reads. Without the companion
   * extension (or outside an Agent companion scope) it is the response emotion without a contact affect.
   */
  contactEmotionProjection(scope:SceneScope,characterId:string,nowMs:number,state=this.state(scope),
    currentReply:{sourceId:string;revision:number}|null=null,timeline?:SceneSource[]):ContactEmotionProjection{
    const base=this.responseEmotion(scope,characterId,nowMs,state,'player',timeline);
    return this.hooks.contactEmotion(scope,characterId,nowMs,state,currentReply,base)??{emotion:base,affect:null};
  }

  /** Every roleplay binding, and an unbound scope whose stored world settings are a story world, has a story clock. */
  private isStoryScope(scope:SceneScope):boolean {
    return this.worldSettings(scope)?.mode==='story'||this.interactions.frozenRoleplayTime(scope)!==undefined;
  }

  /**
   * The unified story clock value (StoryClockMs). Without `ref` it is the clock after the last accepted source; with
   * `ref` it is the final-timeline value after that source revision.
   */
  storyClockAt(scope:SceneScope,state=this.state(scope),ref?:StoryClockSourceRef):number {
    const reading=this.storyClock.read(scope,state);
    if(!reading)throw new Error('invalid_story_clock_scope');
    if(ref===undefined)return reading.result.state.atMs;
    const at=this.storyClock.atSource(reading,ref);
    if(at===null)throw new Error('invalid_story_clock_source');
    return at;
  }

  /**
   * OpenHer's story metabolism time, in the old Unix domain until OH3: the legacy world time over `sources` plus the
   * explicit cue movement of their post-SC analyses, read from the one fold of `timeline` (the whole list the caller
   * works on; `sources` is a prefix of it). Never wall-clock waiting.
   */
  legacyEmotionTime(scope:SceneScope,sources:SceneSource[],fallbackMs:number,timeline:SceneSource[]=sources,rowTimeline?:SceneSource[]):number {
    return this.storyClock.legacyTimeMs(scope,sources,fallbackMs,timeline,rowTimeline);
  }

  preferences(scope: SceneScope, characterId: string, state = this.state(scope), currentReplySourceId?:string): Preference[] {
    const result = new Map<string,Preference>();
    const controls=this.db.prepare('SELECT id,body FROM scene_preference_controls WHERE scope=? AND character=?').all(scopeKey(scope),characterId) as {id:string;body:string}[];
    for (const source of state.sources) {
      if (source.status !== 'accepted' || source.processing !== 'ready') continue;
      for (const [i,preference] of (source.analysis?.characters[characterId]?.preferences ?? []).entries()) {
        if(preference.duration==='turn'&&source.id!==currentReplySourceId)continue;
        const control=controls.find(row=>row.id===preferenceControlId(source.id,preference));
        const override=control?JSON.parse(control.body):{};
        result.set(preference.category,{...preference,...override,id:`${source.id}:${characterId}:pref:${i}`,sourceId:source.id,revision:source.revision,enabled:override.enabled??true,corrected:override.text!==undefined});
      }
    }
    return [...result.values()];
  }

  /** Current source-backed relations from one NPC. Deleted, pending and stale source analyses do not participate. */
  relationships(scope:SceneScope,characterId:string,state=this.state(scope)):FoldedRelationship[] {
    const character=state.roster.characters.find(item=>item.id===characterId);
    if(!character) throw new Error('invalid_scene_character');
    return foldRelationships(state.sources,characterId,emotionSettingsOf(character.emotion).stableRelationRate);
  }

  relationshipAnchor(scope:SceneScope,characterId:string,targetId:string,state=this.state(scope)):FoldedRelationship|undefined {
    const character=state.roster.characters.find(item=>item.id===characterId);
    if(!character) throw new Error('invalid_scene_character');
    return foldedRelationshipAnchor(state.sources,characterId,targetId,emotionSettingsOf(character.emotion).stableRelationRate);
  }

  /** Reads the stored roster, version, and accepted-event flags once; no views or writes are performed. */
  emotionRoster(scope: SceneScope) {
    const state = this.state(scope);
    return {
      version: state.version,
      roster: state.roster,
      emotionAcceptedEvents: acceptedEmotionEvents(this, scope, state),
    };
  }

  inspect(scope: SceneScope, characterId?: string, now = Date.now()) {
    const state = this.state(scope);
    const characters = state.roster.characters.filter(character => characterId === undefined || character.id === characterId);
    return {version:state.version,roster:state.roster,world:this.world(scope,undefined,now),worldSettings:this.worldSettings(scope),needsReview:state.sources.filter(source => source.status === 'needs_review').map(source => source.id),
      sources:state.sources.map(({analysis,...source}) => ({...source,observations:analysis?.plan?.observations ?? []})),
      views:characters.map(character => {
        const snapshot = retentionSnapshot(this.snapshot(scope,character.id,state),now);
        return {characterId:character.id,name:character.name,
          memories:projectMemories(snapshot,{scope:snapshot.scope,asOfMs:now,ids:[...snapshot.memories.keys()]}).memories,
          emotion:emotionSummary(this.responseEmotion(scope,character.id,now,state)),preferences:this.preferences(scope,character.id),
          relationships:this.relationships(scope,character.id,state)};
      })};
  }

  worldSettings(scope:SceneScope):WorldSettings|null {
    return this.legacyWorldSettings(scope).settings;
  }

  /** worldSettings(scope), with the inputs the story clock needs to rebuild a derived start in the opening's own zone. */
  private legacyWorldSettings(scope:SceneScope,sources?:SceneSource[]):StoryClockLegacySettings {
    let settings=this.rawWorldSettings(scope);
    const stored=settings!==null;
    let references:StoryClockLegacySettings['references']=[],liveZone:string|null=null;
    if(!settings&&this.interactions.isTavernRoleplay(scope)){
      const head=this.settingsHead(scope);
      const state=sources!==undefined&&this.usableLedgerRows(this.ledgerRowsForCall(scope))?{...head,sources}:head;
      if(state.version){
        const candidates=this.transfer.acceptedReferences(scope),zone=this.interactions.get(scope,'sillytavern').timeZone;
        settings=initialStorySettings(state,candidates,zone);
        if(settings){references=candidates;liveZone=zone;}
      }
    }
    return {settings:settings?this.initialization.mergeAssets(scope,settings):null,stored,references,liveZone};
  }

  /**
   * What the derivation of the settings reads of the scene: the scene row and the first source row in rowid order (the
   * fixed opening position), never a later source. The one source carries no analysis. Two rows are returned; the
   * subquery walks the scope's primary-key index entries: O(sources of the scope), without reading their payloads.
   */
  private settingsHead(scope:SceneScope):SceneState {
    const key=scopeKey(scope);
    const row=this.db.prepare('SELECT roster,version,created FROM scene_worlds WHERE key=?').get(key) as
      {roster:string;version:number;created:number}|undefined;
    if(!row)return {scope,version:0,createdAtMs:0,roster:{characters:[]},sources:[]};
    const first=this.db.prepare('SELECT message,revision,observed,status,processing FROM scene_sources WHERE scope=? AND rowid=(SELECT MIN(rowid) FROM scene_sources WHERE scope=?)')
      .get(key,key) as {message:string;revision:number;observed:number;status:SceneSource['status'];processing:SceneSource['processing']}|undefined;
    return {scope,version:row.version,createdAtMs:row.created,roster:JSON.parse(row.roster),sources:first?[{...JSON.parse(first.message),
      revision:first.revision,observedAtMs:first.observed,status:first.status,processing:first.processing,analysis:null}]:[]};
  }

  private rawWorldSettings(scope:SceneScope):WorldSettings|null {
    const row=this.db.prepare('SELECT settings FROM scene_world_settings WHERE scope=?').get(scopeKey(scope)) as {settings:string}|undefined;
    return row?JSON.parse(row.settings):null;
  }

  configureWorld(scope:SceneScope,value:WorldSettings|null,captureCheckpoint=true) {
    return this.transaction(()=>{
      const state=this.state(scope);
      if(!state.version)throw new Error('invalid_scene_not_configured');
      this.interactions.assertWorldMode(scope,value?.mode??null);
      if(value){
        const known=new Set(['player',...state.roster.characters.map(actor=>actor.id)]);
        if(Object.keys(value.actorLabels).some(id=>!known.has(id)))throw new Error('invalid_world_actor');
        foldWorldState(value,[]);
      }
      // `shown` is what inspect() returns and the panel loads (merged with the initialization assets); `raw` is the stored row.
      const raw=this.rawWorldSettings(scope),shown=this.worldSettings(scope);
      // 1. No change: an identical save never reprocesses the chat and never writes a correction.
      if(value?sameSettings(value,shown)||sameSettings(value,raw):raw===null)return {version:state.version,clock:'unchanged' as const};
      // 2. Date-only edit of a story world that already has an accepted source: one origin correction on the unified
      // clock. The stored settings row, every analysis and every processing state stay as they are.
      if(value&&shown&&value.mode==='story'&&shown.mode==='story'&&state.sources.some(source=>source.status==='accepted')&&
        (sameSettings(withoutStart(value),withoutStart(shown))||(raw!==null&&sameSettings(withoutStart(value),withoutStart(raw))))){
        const edit=this.storyClock.originDateEdit(scope,state,value.startTimeMs,shown.startTimeMs);
        if(!edit.changed)return {version:state.version,clock:'unchanged' as const};
        if(captureCheckpoint)this.lifecycle.checkpoint(scope,'世界初始设置变更',{automatic:true});
        this.storyClock.writeOriginCorrection(scope,edit.binding,edit.value);
        return {version:this.state(scope).version,clock:'origin_correction' as const};
      }
      // 3. Everything else: today's path.
      if(captureCheckpoint)this.lifecycle.checkpoint(scope,'世界初始设置变更',{automatic:true});
      this.processing.clearScope(scope);
      if(value)this.db.prepare('INSERT OR REPLACE INTO scene_world_settings VALUES(?,?,?)').run(scopeKey(scope),JSON.stringify(value),value.startTimeMs);
      else this.db.prepare('DELETE FROM scene_world_settings WHERE scope=?').run(scopeKey(scope));
      this.markAllPending(scope);
      this.bump(scope);
      this.rebuildDerived(scope);
      return {version:this.state(scope).version,clock:'reprocessed' as const};
    });
  }

  world(
    scope: SceneScope,
    readerId?: string,
    now = Date.now(),
    state = this.state(scope),
    timeline?: SceneSource[]
  ):
    (WorldFoldResult & { storyClock?: StoryClockSummary }) |
    (WorldProjection & { storyClock?: StoryClockView | null }) | null {
    const originalSettings = this.worldSettings(scope);
    return this.withLedgerRows(scope, () => {
      const rows = this.ledgerRowsForCall(scope);
      let settings = originalSettings;
      if (this.usableLedgerRows(rows)) {
        const derived = this.legacyWorldSettings(scope, state.sources);
        if (!derived.stored)
          settings = derived.settings;
      }
      if (!settings) {
        if (this.usableLedgerRows(rows) && timeline !== undefined)
          this.checkLedgerPrefix(state.sources, timeline);
        return null;
      }
      const input = this.ledgerViewInput(scope, state.sources, settings, timeline);
      const row = this.db.prepare('SELECT clock_floor FROM scene_world_settings WHERE scope=?')
        .get(scopeKey(scope)) as { clock_floor: number } | undefined;
      const options = {
        nowMs: now,
        monotonicFloorMs: row?.clock_floor ?? settings.startTimeMs,
        ...input.options
      };
      const folded = this.foldWorldForStep(settings, input.sources, options);
      if (settings.mode === 'companion' && row && folded.state.timeMs > row.clock_floor)
        this.db.prepare('UPDATE scene_world_settings SET clock_floor=? WHERE scope=?')
          .run(folded.state.timeMs, scopeKey(scope));
      if (settings.mode !== 'story')
        return readerId === undefined ? folded : projectWorldState(folded, readerId);
      // A story world carries the unified clock beside the legacy one.
      // @deprecated folded.state.timeMs and the projection's timeMs still use the legacy Unix clock.
      // Host displays read these values.
      // These compatibility values stay until the host readers move to `storyClock`.
      const summary = this.storyClock.summary(scope, state);
      if (readerId === undefined)
        return summary ? { ...folded, storyClock: summary } : folded;
      const projection = projectWorldState(folded, readerId);
      // The same visibility rule as timeMs: the player, or everyone when the time is public.
      return readerId === 'player' || folded.state.publicTime
        ? { ...projection, storyClock: summary?.view ?? null } : projection;
    });
  }

  /**
   * Render one reader's world block. Story history and open lists are bounded per call; other modes retain their
   * complete projection. The optional language controls only the existing clock line. Read errors propagate.
   */
  worldContext(
    scope: SceneScope,
    readerId: string,
    state = this.state(scope),
    language?: StoryLanguage,
    timeline?: SceneSource[],
  ) {
    const block = this.readWorldBlock(scope, readerId, state, language, timeline);
    const header = '\n脚本确认的当前世界状态（仅此角色可见；不得自行改算或补全未知余额）：';
    if (block.projection && block.projection.mode !== 'story') {
      return header + JSON.stringify(block.projection);
    }

    const worldPart = block.projection
      ? header + JSON.stringify(block.projection) + worldBlockOmissionLines(block.omissions) : '';
    if (!storyClockLine(block.view, 'zh')) {
      return worldPart;
    }

    const resolved = language ?? (state.roster.characters.some(character => character.id === readerId)
      ? storyLanguageOf(this.snapshot(scope, readerId, state)) : 'zh');
    return worldPart + storyClockLine(block.view, resolved);
  }

  /**
   * Read omitted row counts for the same arguments and defaults as worldContext. Counts are nonnegative integers;
   * other modes return zeros. Validation errors and the existing companion clock-floor update are preserved.
   */
  worldContextOmissions(
    scope: SceneScope,
    readerId: string,
    state = this.state(scope),
    language?: StoryLanguage,
    timeline?: SceneSource[],
  ): WorldBlockOmissions {
    return this.readWorldBlock(scope, readerId, state, language, timeline).omissions;
  }

  /** Share only this consumer's world and age reads; the no-world clock keeps its original separate read. */
  private readWorldBlock(
    scope: SceneScope,
    readerId: string,
    state: SceneState,
    language?: StoryLanguage,
    timeline?: SceneSource[],
  ): {projection: WorldProjection | null; view: StoryClockView | null; omissions: WorldBlockOmissions} {
    // Language validation precedes the companion floor update, including when the reader is also invalid.
    if (language !== undefined && language !== 'zh' && language !== 'en') {
      throw new Error('invalid_story_language');
    }

    const read = this.ledgerReader(scope);
    const folded = read(() => this.world(scope, undefined, Date.now(), state, timeline)) as
      (WorldFoldResult & {storyClock?: StoryClockSummary}) | null;
    const omissions: WorldBlockOmissions = {history: 0, pending: 0, committed: 0};
    if (!folded) {
      return {projection: null, view: this.storyClock.summary(scope, state)?.view ?? null, omissions};
    }

    const projected = projectWorldState(folded, readerId);
    if (projected.mode !== 'story') {
      return {projection: projected, view: null, omissions};
    }

    const {timeMs: _legacyTime, ...projection} = projected;
    const view = readerId === 'player' || folded.state.publicTime ? folded.storyClock?.view ?? null : null;
    const reading = read(() => this.storyClock.read(scope, state));
    const coordinates = this.worldBlockCoordinates(state, reading);
    const locate = (rows: readonly {sourceId: string; revision: number}[]) => rows.map(row =>
      coordinates.locations.get(JSON.stringify([row.sourceId, row.revision])) ?? {});
    const links = this.worldBlockLinks(folded, readerId);
    const limited = limitWorldBlock({
      projection,
      receiptCoordinates: locate(projection.receipts),
      entryCoordinates: locate(projection.ledger?.entries ?? []),
      lastPosition: coordinates.lastPosition,
      ...links,
    });
    return {projection: limited.projection, view, omissions: limited.omissions};
  }

  /** O(S) identities and clock lookups per call. Duplicate revisions use their final source position. */
  private worldBlockCoordinates(state: SceneState, reading: StoryClockReading | null) {
    const locations = new Map<string, WorldBlockCoordinate>();
    let lastPosition = -1;
    for (let index = 0; index < state.sources.length; index++) {
      const source = state.sources[index]!;
      const sourceId = source.id;
      const atMs = reading ? this.storyClock.atSource(reading, {sourceId, revision: source.revision}) : null;
      locations.set(JSON.stringify([sourceId, source.revision]), {
        position: index,
        ageMs: atMs === null || !reading ? null : storyElapsedMs(atMs, reading.result.state.atMs),
      });
      // The fallback position is the last admitted world source, matching the ledger's source-index domain.
      if (source.status === 'accepted' && source.processing === 'ready' && source.analysis?.plan) {
        lastPosition = index;
      }
    }

    return {locations, lastPosition};
  }

  /** O(C + D) folded rows; mirror only the projection filter for the two arrays that carry target relationships. */
  private worldBlockLinks(folded: WorldFoldResult, readerId: string): {
    committedLinks: WorldBlockLink[] | null;
    depositLinks: WorldBlockLink[] | null;
  } {
    const open = folded.ledger?.open;
    if (!open) {
      return {committedLinks: null, depositLinks: null};
    }

    const visible = (row: LedgerDetail) => row.readerIds.includes(readerId) && !row.causedByCorrection &&
      row.kind !== 'adjustment' && row.disposition !== 'void' && row.category !== 'untracked';
    const links = (rows: LedgerDetail[]): WorldBlockLink[] => rows.filter(visible).map(row => ({
      sourceId: row.sourceId,
      revision: row.revision,
      key: JSON.stringify(row.key),
      target: row.relation ? JSON.stringify(row.relation.target) : null,
    }));
    return {committedLinks: links(open.committed), depositLinks: links(open.deposits)};
  }

  /** Administrative rows, including original body strings for fingerprints and rejected rows for the panel. */
  worldLedgerRows(scope:SceneScope) {return readWorldLedgerRows(this.db,scope);}

  /** One panel decision: one transaction, checkpoint and version bump; source processing and parked stages stay intact. */
  writeWorldLedger(scope: SceneScope, expectedVersion: number, items: readonly WorldLedgerWrite[]) {
    return this.transaction(() => {
      const state = this.state(scope);
      if (state.version !== expectedVersion) throw new Error('context_changed_retry');

      const writes = prepareWorldLedgerWrites(items);
      guardWorldLedgerBindings(state, writes, captureWorldLedgerRows(this.db, scope));
      // Sweep inside this transaction so its checkpoint cannot retain tombstone-bound correction bytes.
      sweepWorldLedgerTombstones(this.db, scope);
      this.lifecycle.checkpoint(
        scope,
        writes.some(write => write.table === 'accounts') ? '账户变更' : '交易校正',
        {automatic: true},
      );
      ensureWorldLedgerTables(this.db);

      const rows = appendWorldLedgerRows(this.db, scope, state, writes);
      // Ledger corrections can change an earlier legacy clock receipt without changing a later endpoint.
      if (this.#emotionEngineRule === 3) this.rebuildEmotionStatesGuarded(scope);
      this.bump(scope);
      this.rebuildDerived(scope);
      return {version: state.version + 1, rows};
    });
  }

  /** One input for full folds and prefix queries. The caller owns the complete source timeline; only rows are read here. */
  worldLedgerInput(scope:SceneScope,sources:SceneSource[],settings:WorldSettings|null=this.worldSettings(scope),purpose:'ledger'|'clock'='ledger',rows=this.ledgerRowsForCall(scope)) {
    const options=worldLedgerOptions(rows),baseline=settings===null;
    if(settings===null&&purpose==='ledger'&&this.interactions.isTavernRoleplay(scope)&&
      (this.usableLedgerRows(rows)||sources.some(source=>source.analysis!=null&&Object.hasOwn(source.analysis,'ledger')&&source.analysis.ledger!=null)))
      settings=ledgerOnlySettings(this.settingsHead(scope));
    const input=this.worldSources(sources);
    if(baseline&&settings)for(const source of input){source.candidates=[];delete source.storyClockOwned;}
    return {settings,sources:input,options};
  }

  /** A synchronous call owns its row snapshot; nested folds share it and the frame is discarded even on failure. */
  private withLedgerRows<T>(scope:SceneScope,action:()=>T):T {
    const key=scopeKey(scope),previous=this.ledgerReadFrame;
    if(previous?.key===key)return action();
    this.ledgerReadFrame={key};
    try{return action();}finally{if(previous)this.ledgerReadFrame=previous;else delete this.ledgerReadFrame;}
  }

  /** Related lazy readings keep a single snapshot for one immutable synchronous consumer. */
  private ledgerReader(scope:SceneScope):<T>(action:()=>T)=>T {
    const key=scopeKey(scope);let captured:NonNullable<SceneAuthority['ledgerReadFrame']>|undefined;
    return action=>{
      const previous=this.ledgerReadFrame;captured??={key};this.ledgerReadFrame=captured;
      try{return action();}finally{if(previous)this.ledgerReadFrame=previous;else delete this.ledgerReadFrame;}
    };
  }

  /** Only successfully decoded rows select the ledger-aware behaviour; rejected rows remain administrative data. */
  private usableLedgerRows(rows:WorldLedgerRows):boolean {return rows.accounts.length+rows.corrections.length>0;}

  /** Explicit timelines must be the very same positional prefix objects; O(n) time, O(1) extra space. */
  private checkLedgerPrefix(sources:SceneSource[],timeline:SceneSource[]):void {
    if(sources.length>timeline.length||sources.some((source,index)=>source!==timeline[index]))
      throw new TypeError('story_clock_prefix_mismatch');
  }

  /** O(sources log sources + row bytes): keep raw row pairs until the final world fold. */
  private ledgerViewInput(
    scope: SceneScope,
    sources: SceneSource[],
    settings: WorldSettings | null,
    timeline?: SceneSource[],
  ) {
    const rows = this.ledgerRowsForCall(scope);
    const input = this.worldLedgerInput(scope, sources, settings, 'clock', rows);
    if (!this.usableLedgerRows(rows)) {
      return {...input, timeline, stamp: undefined as string | undefined};
    }

    const frame = this.ledgerReadFrame;
    const cached = frame?.key === scopeKey(scope) ? frame.views?.get(sources) : undefined;
    if (cached && cached.timeline === timeline) return cached;

    const complete = this.ledgerTimelineForCall(scope, sources, timeline, rows)!;
    // Full or standalone inputs keep every raw row, even a clear with no surviving target.
    if (complete.length === sources.length) {
      const view = {...input, timeline, stamp: undefined as string | undefined};
      if (frame?.key === scopeKey(scope)) (frame.views ??= new Map()).set(sources, view);
      return view;
    }
    const completeSources = this.worldLedgerInput(scope, complete, settings, 'clock', rows).sources;
    const count = input.sources.length;
    const positions = new Map<string, number>();
    const identity = (source: {sourceId?: string; revision?: number}) =>
      JSON.stringify([source.sourceId, source.revision]);
    for (let index = 0; index < completeSources.length; index++) {
      const key = identity(completeSources[index]!);
      if (!positions.has(key)) positions.set(key, index + 1);
    }

    // The model locates unknown anchors by accepted time, retaining the greatest preceding position.
    let times: {time: number; position: number}[] | undefined;
    const positionAfter = (after: LedgerAfter): number => {
      if (after === null) return 0;
      const exact = positions.get(identity(after));
      if (exact !== undefined) return exact;
      if (times === undefined) {
        times = completeSources.flatMap((source, index) =>
          Number.isSafeInteger(source.acceptedAtMs) && source.acceptedAtMs >= 0
            ? [{time: source.acceptedAtMs, position: index + 1}]
            : []);
        times.sort((left, right) => left.time - right.time);
        let maximum = 0;
        for (const entry of times) {
          maximum = Math.max(maximum, entry.position);
          entry.position = maximum;
        }
      }
      let lower = 0;
      let upper = times.length;
      while (lower < upper) {
        const middle = (lower + upper) >>> 1;
        if (times[middle]!.time <= after.acceptedAtMs) lower = middle + 1;
        else upper = middle;
      }
      return lower ? times[lower - 1]!.position : 0;
    };
    const adjustments = new Map(rows.corrections
      .filter(row => row.value.action === 'adjustment')
      .map(row => ['user:' + row.value.id, row.value]));
    const accountEvents = rows.accounts
      .filter(row => row.value.kind === 'create' || positionAfter(row.value.after) <= count)
      .map(row => row.value);
    const corrections = rows.corrections.filter(row => {
      const correction = row.value;
      const adjusted = typeof correction.anchor === 'string' ? adjustments.get(correction.anchor) : undefined;
      // A source-less withdrawal travels with its adjustment, including when neither remains active.
      if (correction.action === 'adjustment' || correction.action === 'clear' && adjusted) {
        return positionAfter((adjusted ?? correction).after ?? null) <= count;
      }
      const position = positions.get(identity(correction)) ?? 0;
      return position > 0 && position <= count;
    }).map(row => row.value);
    const selected: LedgerFoldOptions = {
      ...(accountEvents.length ? {accountEvents} : {}),
      ...(corrections.length ? {corrections} : {}),
    };
    const view = {timeline, sources: input.sources, options: selected, stamp: undefined as string | undefined};
    if (frame?.key === scopeKey(scope)) (frame.views ??= new Map()).set(sources, view);
    return view;
  }

  /** O(source bytes) per frame; unknown, unordered or incomplete identities keep the standalone input semantics. */
  private ledgerTimelineForCall(
    scope: SceneScope,
    sources: SceneSource[],
    timeline?: SceneSource[],
    rows = this.ledgerRowsForCall(scope),
  ): SceneSource[] | undefined {
    if (!this.usableLedgerRows(rows)) return undefined;
    if (timeline !== undefined) {
      this.checkLedgerPrefix(sources, timeline);
      return timeline;
    }

    const frame = this.ledgerReadFrame;
    let live = frame?.key === scopeKey(scope) ? frame.liveSources : undefined;
    if (live === undefined) {
      const liveRows = this.db.prepare(
        "SELECT message,revision,observed,status,processing,json_remove(analysis,'$.emotionStates') AS analysis " +
        'FROM scene_sources WHERE scope=? ORDER BY rowid',
      ).all(scopeKey(scope)) as {
        message: string;
        revision: number;
        observed: number;
        status: SceneSource['status'];
        processing: SceneSource['processing'];
        analysis: string | null;
      }[];
      live = liveRows.map(source => ({
        ...JSON.parse(source.message),
        revision: source.revision,
        observedAtMs: source.observed,
        status: source.status,
        processing: source.processing,
        analysis: source.analysis ? JSON.parse(source.analysis) : null,
      }));
      if (frame?.key === scopeKey(scope)) frame.liveSources = live;
    }

    const identity = (source: SceneSource) => JSON.stringify([source.id, source.revision]);
    const positions = new Map(live.map((source, index) => [identity(source), index]));
    const included = new Set<string>();
    let boundary = -1;
    for (const source of sources) {
      const key = identity(source);
      const position = positions.get(key);
      if (position === undefined || position <= boundary) return sources;
      boundary = position;
      included.add(key);
    }
    if (live.slice(0, boundary + 1).some(source => source.status === 'accepted' && !included.has(identity(source)))) {
      return sources;
    }
    if (boundary === live.length - 1) return sources;

    // Processing can hold a newer analysis at an accepted position; it remains the view's own fold input.
    return [...sources, ...live.slice(boundary + 1)];
  }

  /** A connection-local revision rolls back with tracked writes without changing persisted schema or rows. */
  private initializeLedgerSourceRevision(): void {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS scene_source_revision (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO scene_source_revision VALUES(1, 0);
      CREATE TEMP TRIGGER IF NOT EXISTS scene_source_revision_insert AFTER INSERT ON main.scene_sources
      BEGIN
        UPDATE scene_source_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS scene_source_revision_update AFTER UPDATE ON main.scene_sources
      BEGIN
        UPDATE scene_source_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS scene_source_revision_delete AFTER DELETE ON main.scene_sources
      BEGIN
        UPDATE scene_source_revision SET revision = revision + 1 WHERE singleton = 1;
      END;
    `);
  }

  /** Attach connection-local triggers only after the lazy ledger tables exist, including after DDL rollback. */
  private trackLedgerRowRevisions(): void {
    const untracked = this.db.prepare(
      "SELECT name FROM main.sqlite_schema WHERE type='table' " +
      "AND name IN ('scene_world_ledger_accounts','scene_world_ledger_corrections') " +
      "AND NOT EXISTS (SELECT 1 FROM temp.sqlite_schema WHERE type='trigger' " +
      "AND name = main.sqlite_schema.name || '_read_revision_insert')",
    ).all() as {name: string}[];

    // The schema query restricts these identifiers to two fixed table names; no caller text reaches the SQL.
    for (const table of untracked) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        this.db.exec(`
          CREATE TEMP TRIGGER IF NOT EXISTS ${table.name}_read_revision_${operation.toLowerCase()}
          AFTER ${operation} ON main.${table.name}
          BEGIN
            UPDATE scene_source_revision SET revision = revision + 1 WHERE singleton = 1;
          END;
        `);
      }
    }
  }

  /** O(1) metadata: local writes, rollback-sensitive source/ledger revision, and external commits. */
  private ledgerDatabaseStamp(): string {
    this.trackLedgerRowRevisions();
    const local = this.db.prepare(
      'SELECT revision, total_changes() AS changes FROM temp.scene_source_revision WHERE singleton = 1',
    ).get() as {revision: number; changes: number};
    const external = this.db.prepare('PRAGMA data_version').get() as {data_version: number};

    // total_changes distinguishes revision reuse after rollback; data_version changes only for external commits.
    return JSON.stringify([local.changes, local.revision, external.data_version]);
  }

  /** A write or rollback invalidates all derived frame data before another snapshot can be used. */
  private ledgerRowsForCall(scope: SceneScope): WorldLedgerRows {
    const frame = this.ledgerReadFrame;
    if (frame?.key !== scopeKey(scope)) return this.worldLedgerRows(scope);

    const databaseStamp = this.ledgerDatabaseStamp();
    if (frame.databaseStamp !== databaseStamp) {
      delete frame.rows;
      delete frame.stamp;
      delete frame.liveSources;
      delete frame.views;
      frame.databaseStamp = databaseStamp;
    }

    return frame.rows ??= this.worldLedgerRows(scope);
  }

  private worldSources(sources:SceneSource[]):WorldSourceEffects[] {
    return sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&source.analysis?.plan).map(source=>({
      sourceId:source.id,revision:source.revision,role:source.role,text:source.text,acceptedAtMs:source.acceptedAtMs,
      plan:source.analysis!.plan!,candidates:source.analysis!.worldEffects??[],
      // A post-SC source: its clock candidates are still checked, never applied (the story clock owns its time).
      ...(Object.hasOwn(source.analysis!,'storyClock')?{storyClockOwned:true}:{}),
      ...(source.analysis!.ledger==null?{}:{ledger:source.analysis!.ledger}),
      ...(source.analysis!.ledgerMarks==null?{}:{ledgerMarks:source.analysis!.ledgerMarks}),
      ...(source.replyTo==null?{}:{replyTo:source.replyTo}),
    }));
  }

  setAccess(scope: SceneScope, characterId: string, memoryId: string, access: Access) {
    if (!['clear','gist','feeling','anchor','hidden'].includes(access)) throw new Error('invalid_access');
    this.transaction(() => {
      const memory = this.snapshot(scope,characterId).memories.get(memoryId);
      if (!memory) throw new Error('record_not_found');
      if(memory.source.reference)throw new Error('invalid_reference_access_use_delete');
      this.lifecycle.checkpoint(scope,'记忆访问设置变更',{automatic:true});
      this.db.prepare('INSERT OR REPLACE INTO scene_controls VALUES(?,?,?,?,?)')
        .run(scopeKey(scope),characterId,memoryControlId(memory.source.messageId,characterId,memory),0,access);
      this.bump(scope);
    });
  }

  setPreference(scope:SceneScope,characterId:string,id:string,enabled:boolean,newText?:string) {
    if(typeof enabled!=='boolean'||(newText!==undefined&&(typeof newText!=='string'||!newText.trim()||newText.length>500)))throw new Error('invalid_preference');
    this.transaction(()=>{
      const preference=this.preferences(scope,characterId).find(item=>item.id===id);
      if(!preference)throw new Error('record_not_found');
      this.lifecycle.checkpoint(scope,'偏好设置变更',{automatic:true});
      const controlId=preferenceControlId(preference.sourceId,preference);
      const stored=this.db.prepare('SELECT body FROM scene_preference_controls WHERE scope=? AND character=? AND id=?').get(scopeKey(scope),characterId,controlId) as {body:string}|undefined;
      const previous=stored?JSON.parse(stored.body):{};
      this.db.prepare('INSERT OR REPLACE INTO scene_preference_controls VALUES(?,?,?,?)').run(scopeKey(scope),characterId,controlId,JSON.stringify({...previous,enabled,...(newText===undefined?{}:{text:newText})}));
      this.bump(scope);
    });
  }

  private invalidateDependents(scope: SceneScope) {
    const invalidated:{index:number;characters:Set<string>}[]=[];
    let changed = true;
    while (changed) {
      changed = false;
      const sources = this.state(scope).sources;
      for (const source of sources) {
        if (source.status !== 'accepted') continue;
        const valid = (source.dependencies ?? []).every(dependency => sources.some(origin => origin.id === dependency.id && origin.revision === dependency.revision && origin.status === 'accepted'));
        if (valid) continue;
        invalidated.push({index:sources.indexOf(source),characters:new Set(Object.keys(source.analysis?.characters??{}))});
        this.processing.clearSources(scope,[source.id]);
        this.db.prepare("UPDATE scene_sources SET status='needs_review',processing='failed',analysis=NULL WHERE scope=? AND id=?").run(scopeKey(scope),source.id);
        changed = true;
      }
    }
    return invalidated;
  }
  private rebuildDerived(scope:SceneScope,nowMs=Date.now()):void {
    const state=this.state(scope);
    // The commitment clock: built here, once per call, on the array that is folded, and passed as returned (undefined outside a story scope).
    this.commitments.replaceProjection(scope,state.sources,commitmentStoryClock(this,scope,state.sources));
    this.hooks.rebuildDerived(scope,state,nowMs);
  }
  private invalidateCausalSuffix(scope:SceneScope,changes:{index:number;characters:Set<string>}[]) {
    if(!changes.length)return;
    const hasWorld=Boolean(this.worldSettings(scope));
    for(const [index,source] of this.state(scope).sources.entries()){
      if(source.status!=='accepted'||!source.analysis)continue;
      const characters=Object.keys(source.analysis.characters);
      if(!changes.some(change=>change.index<index&&(hasWorld||characters.some(character=>change.characters.has(character)))))continue;
      // Keep the old plan and candidates for a scoped retry and access-control migration.
      this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
        .run(source.analysis?JSON.stringify(withoutEmotionStates(source.analysis)):null,scopeKey(scope),source.id);
      this.processing.clearSources(scope,[source.id]);
      // The source is reanalyzed as a unit, so every participating role may get
      // a new delta. Its downstream analyses must use those new deltas too.
      changes.push({index,characters:new Set([...characters,source.envelope.targetId,...source.envelope.presentIds,...(source.speakerId?[source.speakerId]:[])])});
    }
  }
  /**
   * N16: a source analysed as a non-opening (its story-clock analysis has no origin) that is now the opening source is
   * analysed again. A legacy or failed opening never is. No transaction and no version bump of its own: both callers
   * (reconcile and the lifecycle callback) are inside one and have already changed the version.
   */
  private requeueOpening(scope:SceneScope):boolean {
    const state=this.state(scope),opening=this.storyClock.openingAwaitingOrigin(scope,state);
    if(!opening)return false;
    const source=state.sources.find(item=>item.id===opening.sourceId)!;
    // Keep the old plan and candidates for a scoped retry, as invalidateCausalSuffix does.
    this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
      .run(source.analysis?JSON.stringify(withoutEmotionStates(source.analysis)):null,scopeKey(scope),source.id);
    this.processing.clearSources(scope,[source.id]);
    return true;
  }
  private invalidateConfigurationChanges(scope: SceneScope, state: SceneState, roster: SceneRoster) {
    const previous = new Map(state.roster.characters.map(character => [character.id, character]));
    const changedModel = new Set<string>();
    const changedPerspective = new Set<string>();
    for (const character of roster.characters) {
      const before = previous.get(character.id);
      if (!before) continue;
      if (before.name !== character.name) changedModel.add(character.id);
      if (before.name !== character.name || JSON.stringify(before.aliases) !== JSON.stringify(character.aliases)) {
        changedPerspective.add(character.id);
      }
    }
    if (!changedModel.size && !changedPerspective.size) return;

    const changes: {index: number; characters: Set<string>}[] = [];
    for (const [index, source] of state.sources.entries()) {
      if (source.status !== 'accepted' || !source.analysis) continue;
      const analyzed = Object.keys(source.analysis.characters);
      const modelAffected = analyzed.some(character => changedModel.has(character));
      const envelopeCharacters = [
        source.envelope.targetId,
        ...source.envelope.presentIds,
        ...(source.speakerId ? [source.speakerId] : []),
      ];
      const replan = source.envelope.mode === 'scene'
        && envelopeCharacters.some(character => changedPerspective.has(character));
      if (!modelAffected && !replan) continue;
      const retained = withoutEmotionStates(replan ? {...source.analysis, plan: null} : source.analysis);
      // plan:null preserves old candidates for mask migration while requesting a fresh perspective plan.
      this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
        .run(JSON.stringify(retained), scopeKey(scope), source.id);
      changes.push({index, characters: new Set([...analyzed, ...envelopeCharacters])});
    }
    this.invalidateCausalSuffix(scope, changes);
  }
  private migrateControls(scope:SceneScope,source:SceneSource,next:SceneAnalysis) {
    const ranking:Access[]=['clear','gist','feeling','anchor','hidden'];
    for(const [characterId,nextAnalysis] of Object.entries(next.characters)){
      const prefix=`${source.id}:${characterId}#`;
      const stored=(this.db.prepare('SELECT id,revision,access FROM scene_controls WHERE scope=? AND character=? AND revision<=?')
        .all(scopeKey(scope),characterId,source.revision) as {id:string;revision:number;access:Access}[]).filter(row=>row.id.startsWith(prefix)&&/^(?:\d+|@[a-f0-9]{64})$/.test(row.id.slice(prefix.length)));
      const durable=new Map(stored.filter(row=>row.revision===0).map(row=>[row.id,row.access]));
      const existingDurable=new Set(durable.keys());
      const legacy=stored.filter(row=>row.revision>0);
      const expectedRevision=source.analysis?.controlRevision??source.revision;
      const previous=source.analysis?.characters[characterId];
      const restrictions:Access[]=[];
      // Upgrade the old position-based controls when their source candidates are
      // available. Unknown legacy positions keep their conservative restriction.
      for(const row of legacy){
        const memory=row.revision===expectedRevision?previous?.memories[Number(row.id.slice(prefix.length))]:undefined;
        if(memory){
          const id=memoryControlId(source.id,characterId,memory);
          if(!existingDurable.has(id)&&ranking.indexOf(row.access)>=ranking.indexOf(durable.get(id)??'clear'))durable.set(id,row.access);
          this.db.prepare('DELETE FROM scene_controls WHERE scope=? AND character=? AND id=? AND revision=?').run(scopeKey(scope),characterId,row.id,row.revision);
        }else if(row.access!=='clear')restrictions.push(row.access);
      }
      const current=nextAnalysis.memories.map(memory=>memoryControlId(source.id,characterId,memory));
      for(const [id,access] of durable)if(!current.includes(id)&&access!=='clear')restrictions.push(access);
      if(restrictions.length){
        const fallback=restrictions.reduce((strictest,current)=>ranking.indexOf(current)>ranking.indexOf(strictest)?current:strictest,'clear' as Access);
        for(const id of current)if(!durable.has(id))durable.set(id,fallback);
      }
      // Keep unmatched identities too: a model may omit a memory on one pass and
      // extract it again later. Omission must not erase the user's restriction.
      for(const [id,access] of durable)this.db.prepare('INSERT OR REPLACE INTO scene_controls VALUES(?,?,?,?,?)')
        .run(scopeKey(scope),characterId,id,0,access);
    }
  }
  private bump(scope: SceneScope) { this.invalidateDirector(scope);this.db.prepare('UPDATE scene_worlds SET version=version+1 WHERE key=?').run(scopeKey(scope)); }
  /**
   * Director plans exist only for roleplay bindings, so a companion binding never touches the director table. A roleplay
   * binding always invalidates (creating the table on first use); an unbound legacy scope invalidates an existing table.
   */
  private invalidateDirector(scope:SceneScope):void {
    const mode=this.interactions.modeOf(scope);
    if(mode!=='companion')this.director.invalidate(scope,mode==='roleplay');
  }
  private markAllPending(scope:SceneScope) {
    for(const source of this.state(scope).sources) {
      if(source.status!=='accepted')continue;
      this.db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
        .run(source.analysis?JSON.stringify(withoutEmotionStates(source.analysis)):null,scopeKey(scope),source.id);
    }
  }
  private migrateEmotionStates() {
    this.transaction(() => {
      const worlds = this.db.prepare('SELECT scope FROM scene_worlds').all() as {
        scope: string;
      }[];
      for (const row of worlds) {
        const scope = JSON.parse(row.scope) as SceneScope;
        // N16 first: a restore can leave an analysed non-opening as the opening. Both calls always run (never a()||b()):
        // a re-queued opening leaves the 'ready' set, so the snapshots after it are rebuilt in the same open.
        const requeued = this.requeueOpening(scope);
        const rebuilt = this.rebuildEmotionStates(scope, undefined, true);
        if (requeued || rebuilt)
          this.bump(scope);
        this.rebuildDerived(scope);
      }
    });
  }
  /** Rebuild local neural snapshots only from recorded accepted candidates. */
  private rebuildEmotionStates(scope: SceneScope, onlyCharacterId?: string, preserveUnknownSnapshots = false): boolean {
    const state = this.state(scope), key = scopeKey(scope);
    const resolveOwnLine = createEmotionLineResolver(state.sources, state.roster);
    const eligibility = new Map(state.roster.characters.map(character => [character.id, actorHasEmotion(character)]));
    let engineKey: EmotionEngineKey | undefined;
    const currentKey = () => engineKey ??= createEmotionEngineKey(
      this.#emotionEngineRule, this.isStoryScope(scope) ? 'story' : 'real',
    );
    let changed = false;
    let unknownSnapshot = false;
    const taggedSnapshots = new Set<string>();
    // Validate one persisted group at a time; ordinary scene state holds none.
    for (const source of state.sources) {
      const rows = this.db.prepare("SELECT j.key,j.value FROM scene_sources s,json_each(s.analysis,'$.emotionStates') j WHERE s.scope=? AND s.id=?")
        .iterate(key, source.id);
      const obsolete: string[] = [];
      for (const row of rows) {
        const actorId = String(row.key);
        if (onlyCharacterId && actorId !== onlyCharacterId)
          continue;
        if (eligibility.get(actorId) === false)
          continue;
        const snapshot = JSON.parse(String(row.value));
        if (snapshot !== null && typeof snapshot === 'object' && Object.hasOwn(snapshot, 'engine'))
          taggedSnapshots.add(JSON.stringify([source.id, actorId]));
        if (snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
          && !recognizesEmotionSnapshot(snapshot, this.#emotionEngineRule, currentKey)) {
          unknownSnapshot = true;
          continue;
        }
        validateStoredEmotionStates({ [actorId]: snapshot }, this.#emotionEngineRule, currentKey);
        if (source.status !== 'accepted' || source.processing !== 'ready' || !source.analysis?.plan || !source.analysis.characters[actorId] ||
          source.analysis.emotionPendingIds?.includes(actorId)
          || (this.#emotionEngineRule === 3 && (isOwnEmotionLine(source, actorId, resolveOwnLine)
            || !source.analysis?.characters[actorId]?.emotion)))
          obsolete.push(actorId);
      }
      for (const actorId of obsolete) {
        this.db.prepare("UPDATE scene_sources SET analysis=json_set(analysis,'$.emotionStates',json_patch(json_extract(analysis,'$.emotionStates'),json_object(?,NULL))) WHERE scope=? AND id=?")
          .run(actorId, key, source.id);
        changed = true;
      }
    }
    // Opening validates every recognized snapshot in the existing pass, but leaves future snapshots for reads.
    if (preserveUnknownSnapshots && unknownSnapshot)
      return changed;
    // Replaying one role across its history avoids an all-NPC neural map.
    // One object for the whole rebuild, every role: one settings derivation and one pass over the sources, on first use.
    const clock = this.#emotionEngineRule === 3 ? this.storyClock.emotionTimeline(scope, state.sources) : null;
    const snapshotTimes = this.#emotionEngineRule === 2 ? this.storyClock.legacyTimeline(scope, state.sources) : null;
    for (const character of state.roster.characters.filter(item => eligibility.get(item.id) && (!onlyCharacterId || item.id === onlyCharacterId))) {
      const selectedEngine = this.#emotionEngineRule === 3 ? currentKey() : undefined;
      const replay = selectedEngine === undefined ? {events: [], anchors: [], sources: []}
        : emotionReplaySteps(state.sources, character.id, true, resolveOwnLine);
      const relationInputs = selectedEngine === undefined ? null
        : emotionRelationInputs(scope, state.sources, replay.events, character, state.roster);
      const anchorSet = new Set(replay.anchors);
      const positionOf = (source: SceneSource): number => clock!.positions.get(
        JSON.stringify([source.id, source.revision]),
      )!;
      const plan = clock === null ? null : planEmotionClock({
        characterId: character.id,
        sources: clock.sources,
        events: replay.events.map(source => ({
          sourceIndex: positionOf(source), relation: source.analysis!.characters[character.id]!.emotion!.relation,
        })),
        anchorIndices: replay.anchors.map(positionOf),
      });
      const hungerByIndex = new Map([...plan?.events ?? [], ...plan?.anchors ?? []]
        .map(step => [step.sourceIndex, step.hungerHours]));
      const initialTime = snapshotTimes !== null ? snapshotTimes.initial(state.createdAtMs)
        : emotionInitialTime(clock, replay.sources, state.createdAtMs);
      let emotion = createEmotion(
        initialTime,
        character.emotion,
        emotionIdentitySeed(scope, character.id),
        selectedEngine,
      );
      const snapshotHash = selectedEngine === undefined ? null
        : emotionSnapshotHeader(scope, character, selectedEngine, initialTime);
      const snapshotInputs = new Map<string, string>();
      let seenAnchor = false;
      const replaySources = selectedEngine === undefined ? state.sources : replay.sources;
      for (const [index, source] of replaySources.entries()) {
        if (source.status !== 'accepted' || source.processing !== 'ready' || !source.analysis?.plan)
          continue;
        const candidate = source.analysis.characters[character.id];
        const anchor = selectedEngine !== undefined && anchorSet.has(source);
        if (!anchor && (!candidate?.emotion || source.analysis.emotionPendingIds?.includes(character.id)))
          continue;
        if (this.#emotionEngineRule === 3) {
          const clockSource = clock?.sources[positionOf(source)];
          const eventTimeMs = clockSource?.clockMs ?? source.acceptedAtMs;
          const timeOfDay = anchor && clockSource === undefined
            ? realTimeOfDay(source.acceptedAtMs, source.acceptedTimeZone ?? null)
            : emotionEventTimeOfDay(source, candidate?.emotion, clockSource);
          const options = {
            hungerHours: clock === null ? Math.max(0, eventTimeMs - emotion.updatedAtMs) / 3_600_000
              : hungerByIndex.get(positionOf(source))!,
            timeOfDay,
            eventClockMs: eventTimeMs,
          };
          seenAnchor ||= anchor;
          if (!seenAnchor) {
            const fingerprint = appendEmotionSnapshotInput(snapshotHash!, {
              source,
              anchor,
              delta: candidate!.emotion!,
              relationInput: relationInputs!.get(source) ?? null,
              eventTimeMs,
              hungerHours: options.hungerHours,
              timeOfDay,
            });
            // Earlier prefixes can never be the latest adopted snapshot; keep memory independent of history.
            snapshotInputs.clear();
            snapshotInputs.set(JSON.stringify([source.id, source.revision]), fingerprint);
          }
          if (anchor) {
            emotion = advanceEmotionAnchor(emotion, eventTimeMs, options, character.emotion, selectedEngine);
            // Time-only steps have no per-source snapshot; subsequent reads replay them from their source facts.
            continue;
          }
          emotion = advanceEmotionWithClock(emotion, candidate!.emotion!, eventTimeMs, options,
            character.emotion, selectedEngine, undefined, undefined,
            {sourceId: source.id, revision: source.revision}, relationInputs!.get(source) ?? null);
        } else {
          emotion = advanceEmotion(
            emotion,
            candidate!.emotion!,
            snapshotTimes!.at(index, source.acceptedAtMs),
            character.emotion,
            selectedEngine,
          );
        }
        const body = JSON.stringify(validateEmotionState(emotion));
        const previous = this.db.prepare("SELECT j.value AS body FROM scene_sources s,json_each(s.analysis,'$.emotionStates') j WHERE s.scope=? AND s.id=? AND j.key=?")
          .get(key, source.id, character.id) as {
          body: string;
        } | undefined;
        if (previous?.body !== body) {
          const replaceSnapshot = selectedEngine !== undefined
            || taggedSnapshots.has(JSON.stringify([source.id, character.id]));
          if (replaceSnapshot) {
            // Merge-patch discards nulls and retains omitted members. Replace the member text instead;
            // the rest of the analysis must retain its whitespace, duplicate members and number spellings.
            const row = this.db.prepare('SELECT analysis FROM scene_sources WHERE scope=? AND id=?')
              .get(key, source.id) as {analysis: string};
            const analysis = replaceObjectMember(row.analysis, ['emotionStates', character.id], body);
            // Validate the selected first member independently before changing authority data.
            const replaced = this.db.prepare(
              "SELECT j.value AS body FROM json_each(?, '$.emotionStates') j WHERE j.key=? LIMIT 1",
            ).get(analysis, character.id) as {body: string} | undefined;
            if (replaced?.body !== body) {
              throw new Error('invalid_emotion_snapshot_replacement');
            }
            this.db.prepare('UPDATE scene_sources SET analysis=? WHERE scope=? AND id=?')
              .run(analysis, key, source.id);
          } else {
            this.db.prepare("UPDATE scene_sources SET analysis=json_set(analysis,'$.emotionStates',json_patch(COALESCE(json_extract(analysis,'$.emotionStates'),'{}'),json_object(?,json(?)))) WHERE scope=? AND id=?")
              .run(character.id, body, key, source.id);
          }
          changed = true;
        }
      }
      if (selectedEngine !== undefined) {
        const snapshotKey = JSON.stringify([key, character.id]);
        this.emotionSnapshotInputs.delete(snapshotKey);
        this.emotionSnapshotInputs.set(snapshotKey, snapshotInputs);
        // Match the replay cache limit of 64 actor/scope entries; eviction only causes a cold replay.
        if (this.emotionSnapshotInputs.size > 64) {
          this.emotionSnapshotInputs.delete(this.emotionSnapshotInputs.keys().next().value!);
        }
      }
    }
    return changed;
  }
  /**
   * rebuildEmotionStates for reconcile and the marked fail, which a world issue already in the stored state must not
   * undo: the rebuild runs in its own savepoint; an invalid_world_<code> error rolls that savepoint back (no partial
   * snapshot write survives) and gives false, so the caller goes on and the snapshots keep their values until a path
   * that rebuilds them runs on a repaired world. Any other error is rethrown unchanged.
   */
  private rebuildEmotionStatesGuarded(scope:SceneScope):boolean {
    try{return this.transaction(()=>this.rebuildEmotionStates(scope));}
    catch(error){
      if(error instanceof Error&&error.message.startsWith('invalid_world_'))return false;
      throw error;
    }
  }
  transaction<T>(action:()=>T):T {
    const savepoint=`scene_authority_${++this.savepointSequence}`;
    const outer=!this.db.isTransaction;
    this.db.exec(outer?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);
    try { const result = action(); this.db.exec(outer?'COMMIT':`RELEASE ${savepoint}`); return result; }
    catch(error) { this.db.exec(outer?'ROLLBACK':`ROLLBACK TO ${savepoint}`);if(!outer)this.db.exec(`RELEASE ${savepoint}`);throw error; }
  }
}

/** Equality of two world settings as key-sorted JSON; array order counts. */
function sameSettings(left:unknown,right:unknown):boolean {
  const sorted=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
  return left!==null&&right!==null&&sorted(left)===sorted(right);
}
function withoutStart(settings:WorldSettings):Omit<WorldSettings,'startTimeMs'> {
  const {startTimeMs:_start,...rest}=settings;
  return rest;
}
function sameContent(left: SceneMessage, right: SceneMessage) {
  return left.text === right.text && left.role === right.role && left.automatic === right.automatic && left.speakerId === right.speakerId &&
    JSON.stringify(left.envelope) === JSON.stringify(right.envelope) &&
    (right.dependencies===undefined||JSON.stringify(left.dependencies??[])===JSON.stringify(right.dependencies)) &&
    (right.replyTo===undefined||JSON.stringify(left.replyTo)===JSON.stringify(right.replyTo));
}
function sourcesHash(state:SceneState) {
  return createHash('sha256').update(JSON.stringify(state.sources.map(source=>[source.id,source.revision,source.status]))).digest('hex');
}
/** Stable identity binds stored ranges to the exact detail and kind, independently of extraction order. */
function memoryIdentity(memory: {
  kind?: string;
  detail: string;
}): string {
  return createHash('sha256').update(JSON.stringify([memory.kind ?? 'legacy', memory.detail])).digest('hex');
}

function memoryControlId(sourceId: string, characterId: string, memory: {
  kind?: string;
  detail: string;
}) {
  const identity = memoryIdentity(memory);
  return `${sourceId}:${characterId}#@${identity}`;
}

function preferenceControlId(sourceId:string,preference:{category:string;quote:string}) {
  return `${sourceId}:pref:@${createHash('sha256').update(JSON.stringify([preference.category,preference.quote])).digest('hex')}`;
}
function preferenceSourceId(id:string) { return id.slice(0,id.lastIndexOf(':pref:@')); }
function localAnalysis(value:SceneAnalysis,source:SceneSource,
  decodeUserModelCandidates:SceneAuthorityHooks['decodeUserModelCandidates'],roster:SceneRoster):SceneAnalysis {
  const input=value as SceneAnalysis&{emotionStates?:unknown;storyClock?:unknown};
  // The world stage's story-clock output (SC2) passes through unvalidated; SC0 treats a malformed stored value as degraded.
  // A value JSON cannot hold counts as absent, so a source without the key stores byte-identical rows.
  const storyClock=Object.hasOwn(input,'storyClock')?input.storyClock:undefined;
  // Stored as its own JSON copy: the fold input never aliases a caller-owned object and always equals the stored row.
  const clockText=storyClock===undefined||typeof storyClock==='function'||typeof storyClock==='symbol'?undefined:JSON.stringify(storyClock);
  const clockAbsent=clockText===undefined;
  const expectation=input.contactResponseExpectation;
  if(expectation!==undefined&&(typeof expectation!=='object'||expectation===null||
    ![true,false,null].includes(expectation.expected)||
    (expectation.quote!==null&&(typeof expectation.quote!=='string'||!expectation.quote||!source.text.includes(expectation.quote)))))
    throw new Error('invalid_contact_response_expectation');
  const absence=input.absenceExplanation;
  if(absence!==undefined&&absence!==null&&(source.role!=='user'||source.envelope.mode!=='direct'||
    absence.sourceId!==source.id||absence.sourceRevision!==source.revision||
    absence.sourceAcceptedAtMs!==source.acceptedAtMs||absence.characterId!==source.envelope.targetId||
    !source.text.includes(absence.quote)))throw new Error('invalid_absence_evidence');
  const actors = new Map(roster.characters.map(actor => [actor.id, actor]));
  const characters = Object.fromEntries(Object.entries(input.characters).map(([id, analysis]) => {
    const actor = actors.get(id);
    if ((actor && !actorHasEmotion(actor)) || analysis.emotion == null) {
      const { emotion, ...rest } = analysis;
      return [id, rest];
    }

    return [id, { ...analysis, emotion: { ...analysis.emotion!, stableRelationDelta: {} } }];
  }));
  return {plan:input.plan,characters,
    ...(input.skippedStages===undefined?{}:{skippedStages:input.skippedStages}),
    ...(input.emotionSchedule===undefined?{}:{emotionSchedule:input.emotionSchedule}),
    ...(input.emotionPendingIds===undefined?{}:{emotionPendingIds:input.emotionPendingIds}),
    ...(input.emotionCandidateReadyIds===undefined?{}:{emotionCandidateReadyIds:input.emotionCandidateReadyIds}),
    ...(expectation===undefined?{}:{contactResponseExpectation:expectation}),
    ...(absence===undefined?{}:{absenceExplanation:absence}),
    ...(input.worldEffects===undefined?{}:{worldEffects:input.worldEffects}),
    ...(input.commitmentOperations===undefined?{}:{commitmentOperations:input.commitmentOperations}),
    ...(input.physiologyOperations===undefined?{}:{physiologyOperations:input.physiologyOperations}),
    ...(input.geographyOperations===undefined?{}:{geographyOperations:input.geographyOperations}),
    ...storedLedgerFields(input),
    ...userModelCandidatesOf(input.userModelCandidates,source.text,decodeUserModelCandidates),
    ...(clockAbsent?{}:{storyClock:JSON.parse(clockText) as unknown})};
}
/** Without a decoder (no companion extension) candidates are dropped, never rejected. */
function userModelCandidatesOf(value:unknown,sourceText:string,
  decode:SceneAuthorityHooks['decodeUserModelCandidates']):{userModelCandidates?:SceneProfileCandidate[]} {
  if(value===undefined)return {};
  const decoded=decode(value,sourceText);
  return decoded===undefined?{}:{userModelCandidates:[...decoded]};
}
function relationshipValidationContext(source:SceneSource,plan:import('./types.ts').PerspectivePlan,roster:SceneRoster,subjectId:string) {
  const observations=plan.observations.filter(observation=>observation.readers.includes(subjectId));
  const participantIds=new Set<string>([subjectId]);
  for(const observation of observations) {
    if(observation.actorId)participantIds.add(observation.actorId);
    for(const recipient of observation.recipients??[])participantIds.add(recipient);
  }
  const actors=roster.characters.filter(character=>participantIds.has(character.id));
  return {subjectId,actorIds:roster.characters.map(character=>character.id),userActorId:'player',actors,observations,messageRole:source.role};
}
function validateCommitmentAnalysis(source:SceneSource,analysis:SceneAnalysis,roster:SceneRoster,
  time:{realClockTimeMs:number;storyClockTimeMs?:number;timeZone?:string}):SceneAnalysis {
  if(analysis.commitmentOperations===undefined)return analysis;
  if(!Array.isArray(analysis.commitmentOperations))throw new Error('invalid_commitment_operations');
  const actorIds=[...roster.characters.map(character=>character.id),'player'];
  const commitmentOperations=analysis.commitmentOperations.map(operation=>{
    if(!operation||typeof operation!=='object'||Array.isArray(operation))throw new Error('invalid_commitment_operation');
    if(operation.sourceId!==source.id||operation.sourceRevision!==source.revision||operation.sourceAcceptedAtMs!==source.acceptedAtMs)
      throw new Error('invalid_commitment_source');
    if(operation.mode!=='roleplay'&&operation.mode!=='companion')throw new Error('invalid_commitment_mode');
    const candidate=commitmentCandidate(operation);
    return validateCommitmentOperations({source,plan:analysis.plan,actorIds,userActorId:'player',mode:operation.mode,
      clockTimeMs:operation.mode==='companion'?time.realClockTimeMs:time.storyClockTimeMs,timeZone:time.timeZone,revalidate:true},
      {operations:[candidate]})[0]!;
  });
  return {...analysis,commitmentOperations};
}
function commitmentCandidate(operation:ValidatedCommitmentOperation):CommitmentCandidate {
  const {sourceId:_sourceId,sourceRevision:_sourceRevision,sourceAcceptedAtMs:_acceptedAt,mode:_mode,...candidate}=operation;
  return candidate;
}
function withoutEmotionStates<T extends {emotionStates?:Record<string,EmotionState>}>(value:T):Omit<T,'emotionStates'> {
  const {emotionStates:_ignored,...rest}=value;
  return rest;
}
function withoutUserModelCandidates<T extends {userModelCandidates?:SceneProfileCandidate[]}>(value:T):Omit<T,'userModelCandidates'> {
  const {userModelCandidates:_ignored,...rest}=value;
  return rest;
}
function validateStoredEmotionStates(
  value: unknown,
  rule: EmotionEngineRule,
  currentKey: () => EmotionEngineKey,
): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('invalid_scene_emotion_states');
  for (const state of Object.values(value as Record<string, unknown>)) {
    if (state !== null && typeof state === 'object' && !Array.isArray(state)
      && !recognizesEmotionSnapshot(state, rule, currentKey))
      continue;
    validateEmotionState(state);
  }
}

/** Plain data can be keyed without invoking getters, toJSON, proxies, or user iterators; work is O(data bytes). */
function plainReadInput(value: unknown, objects: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true;
  if (typeof value === 'number')
    return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || isProxy(value) || objects.has(value))
    return false;

  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (prototype !== (array ? Array.prototype : Object.prototype))
    return false;
  if (Object.hasOwn(Object.prototype, 'toJSON')
    || (array && Object.hasOwn(Array.prototype, 'toJSON')))
    return false;
  objects.add(value);

  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1)
    return false;
  for (const key of keys) {
    if (array && key === 'length')
      continue;
    if (typeof key !== 'string')
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      return false;
    // JSON omits named array properties; index keys must preserve every input member.
    if (array && !/^(0|[1-9][0-9]*)$/.test(key))
      return false;
    if (!plainReadInput(descriptor.value, objects))
      return false;
  }
  return true;
}

/** A shared fold snapshot may preserve its internal aliases, but may not copy an alias into a caller's input. */
function detachedReadResult(value: unknown, inputs: WeakSet<object>, visited = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object')
    return typeof value !== 'function' && typeof value !== 'symbol';
  if (inputs.has(value) || isProxy(value))
    return false;
  if (visited.has(value))
    return true;
  visited.add(value);

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype)
    return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string')
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, 'value')
      || !detachedReadResult(descriptor.value, inputs, visited))
      return false;
  }
  return true;
}

/**
 * Computes accepted emotion history for every eligible roster member in one pass over the scope's records.
 * Work is O(roster members + sources + recorded candidates); pending, failed and deferred candidates do not count.
 * The optional state is the caller's transaction-local read, avoiding another scan. Invalid storage errors propagate.
 */
export function acceptedEmotionEvents(
  authority: SceneAuthority,
  scope: SceneScope,
  state = authority.state(scope),
): Record<string, boolean> {
  const accepted = new Map(state.roster.characters
    .filter(character => actorHasEmotion(character))
    .map(character => [character.id, false]));
  for (const source of state.sources) {
    if (source.status !== 'accepted' || source.processing !== 'ready' || !source.analysis?.plan) continue;
    const pending = new Set(source.analysis.emotionPendingIds ?? []);
    for (const characterId of Object.keys(source.analysis.characters)) {
      if (accepted.has(characterId) && !pending.has(characterId)) accepted.set(characterId, true);
    }
  }
  return Object.fromEntries(accepted);
}
