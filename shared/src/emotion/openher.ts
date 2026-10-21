/*
 * Portions adapted from OpenHer at
 * ef5b2145c9c15582499ecc5fb9d10376d82eccdf.
 *
 * XLDB changes: TypeScript port, explicit clock, deterministic state transitions,
 * bounded stable-relation calibration, and persisted neural learning.
 * Licensed under Apache-2.0; see third-party/OpenHer-LICENSE.
 */

import { createNeural, neuralForward, neuralStep, neuralThermodynamic, validateNeuralState } from './neural.ts';
import type { NeuralState } from './neural.ts';
import type {EmotionEngineKey} from './engine.ts';
import {STORY_CLOCK_MAX_MS} from '../scene/story-clock-types.ts';
import {roundFourDecimals} from './decimal-round.ts';

export const DRIVE_NAMES = [
  "connection",
  "novelty",
  "expression",
  "safety",
  "play",
] as const;

export const BEHAVIOR_SIGNAL_NAMES = [
  "directness",
  "vulnerability",
  "playfulness",
  "initiative",
  "depth",
  "warmth",
  "defiance",
  "curiosity",
] as const;

export type DriveName = (typeof DRIVE_NAMES)[number];
export type BehaviorSignalName = (typeof BEHAVIOR_SIGNAL_NAMES)[number];
export type DriveValues = Record<DriveName, number>;
export type BehaviorSignals = Record<BehaviorSignalName, number>;

export interface CriticContext {
  userEmotion: number;
  topicIntimacy: number;
  conversationDepth: number;
  userEngagement: number;
  conflictLevel: number;
  noveltyLevel: number;
  userVulnerability: number;
  timeOfDay: number;
}

export interface StableRelations {
  depth: number;
  trust: number;
  valence: number;
}

/**
 * One person's latest input, ordered oldest to newest by its last accepted update; ids have 1 to 200 characters.
 * Depth/trust are unitless values in [0, 1], and valence is in [-1, 1]. Saved entries must contain exactly these fields.
 */
export interface RelationEmaEntry extends StableRelations {
  counterpartId: string;
}

/**
 * A scene event's resolved person and pre-event unitless prior: depth/trust in [0, 1], valence in [-1, 1].
 * Event entries reject invalid ids or priors with TypeError. Null means no person; omission selects core accumulation.
 */
export interface EmotionRelationInput {
  counterpartId: string;
  prior: StableRelations;
}

/** Upstream minimum unitless relation averaging weight; provisional until engine calibration is frozen. */
export const RELATION_EMA_MINIMUM = 0.15;
/** Upstream multiplier for the event's normalized conversation depth; provisional until calibration is frozen. */
export const RELATION_EMA_DEPTH_WEIGHT = 0.5;
/** Upstream maximum unitless relation averaging weight; provisional until engine calibration is frozen. */
export const RELATION_EMA_MAXIMUM = 0.65;
/** Provisional per-character pair limit; an overflow evicts the pair least recently updated by an event. */
export const RELATION_EMA_LIMIT = 64;

export interface EmotionDelta {
  context: CriticContext;
  frustrationDelta: Partial<DriveValues>;
  driveSatisfaction?: Partial<DriveValues>;
  stableRelationDelta?: Partial<StableRelations>;
  /** Stored readable metadata is opaque during legacy numeric replay, including older preserved values. */
  appraisal?: unknown;
  relation?: unknown;
  appraisalRule?: unknown;
  contract?: unknown;
}

/** Identifies one applied accepted source; revisions are positive safe integers and ids contain 1 to 200 characters. */
export interface EmotionEventSource {
  sourceId: string;
  revision: number;
}

/** Persisted numeric and neural state; engine metadata is opaque until a storage trust decision. */
export interface EmotionState {
  version: 2 | 3;
  engine?: unknown;
  updatedAtMs: number;
  /** Input event clock in milliseconds; unlike updatedAtMs, this value may move backward. */
  eventClockMs?: number;
  /** Last accepted Critic observation; older saved states use updatedAtMs. */
  criticContextAtMs?: number;
  frustration: DriveValues;
  drives: DriveValues;
  criticContext: CriticContext;
  behavioralSignals: BehaviorSignals;
  stableRelations: StableRelations;
  neural: NeuralState;
  lastReward: number;
  /** Latest applied external event, or null before an event; present only under the third rule. */
  lastEvent?: EmotionEventSource | null;
  /** Per-person inputs in oldest-to-newest update order; only the third rule writes this bounded array. */
  relationEma?: RelationEmaEntry[];
  /** Creation baseline, present only under the third numerical rule. */
  baselineOrigin?: DriveValues;
  /** Dimensionless raw-reward moving mean in [-1, 1], present only under the third rule. */
  rewardMean?: number;
  /** Dimensionless centered learning reward in [-1, 1], present only under the third rule. */
  lastLearningReward?: number;
  /** Five stored frustration values immediately before the latest event, including prior anchor metabolism. */
  previousFrustration?: DriveValues;
}

export interface EmotionSettings {
  driveBaseline: DriveValues;
  frustrationDecayPerHour: number;
  connectionHungerPerHour: number;
  noveltyHungerPerHour: number;
  eventRetainedFraction: number;
  stableRelationRate: number;
  hebbianLearningRate: number;
  phaseThreshold: number;
  temperatureCoefficient: number;
  temperatureFloor: number;
  randomizedBaseline: boolean;
}

// OpenHer engine/genome/drive_metabolism.py defaults plus XLDB's stable
// relation absorption rate. The exported object is immutable; every caller gets
// a fresh complete settings object from emotionSettingsOf.
export const DEFAULT_EMOTION_SETTINGS: EmotionSettings = Object.freeze({
  driveBaseline: Object.freeze({
    connection: 0.5,
    novelty: 0.5,
    expression: 0.5,
    safety: 0.5,
    play: 0.5,
  }),
  frustrationDecayPerHour: 0.08,
  connectionHungerPerHour: 0.15,
  noveltyHungerPerHour: 0.05,
  eventRetainedFraction: 0.9,
  stableRelationRate: 0.05,
  hebbianLearningRate: 0.02,
  phaseThreshold: 2,
  temperatureCoefficient: 0.12,
  temperatureFloor: 0.03,
  randomizedBaseline: true,
});

/** Upstream baseline shift per unit accepted frustration delta; provisional engine coefficient, no failure. */
export const BASELINE_LEARNING_RATE = 0.01;

/** Upstream dimensionless baseline spring coefficient in [0, 1]; provisional engine default, no failure. */
export const BASELINE_ELASTICITY = 0.05;

/** Design moving-mean retention per accepted event; provisional engine coefficient in [0, 1], no failure. */
export const REWARD_MEAN_RETENTION = 0.9;

/** Design raw-reward weight per accepted event; literal 0.1 preserves exact arithmetic, no failure. */
export const REWARD_MEAN_WEIGHT = 0.1;

/**
 * Test/tool-only dimensionless coefficients in [0, 1]. Null or omitted members select the exported defaults;
 * rewardMeanRetention + rewardMeanWeight must be at most 1 after those defaults are applied.
 * Invalid members, unknown keys or an excessive combined weight throw TypeError at either third-rule event entry.
 */
export interface EmotionRuleConstants {
  baselineLearningRate?: number | null;
  rewardMeanRetention?: number | null;
  rewardMeanWeight?: number | null;
}

const MIN_METABOLISM_HOURS = 0.001;
// A single interaction's appraisal is no longer treated as the current scene
// after half a day. uncertain: this is a product heuristic, not an empirically
// fitted rate. Accepted-event signals remain frozen within the same window in
// emotionAt (companion contact projection excepted until OH8a).
const CRITIC_CONTEXT_FRESH_MS = 12 * 3_600_000;

// OpenHer sync_to_agent uses baseline + frustration * 0.15. The upstream
// baseline is seeded per persona; this bounded MVP takes a validated baseline
// from the owning character's explicit settings.
export const FRUSTRATION_TO_DRIVE = 0.15;

const DEFAULT_CONTEXT: CriticContext = {
  userEmotion: 0.5,
  topicIntimacy: 0.5,
  conversationDepth: 0.5,
  userEngagement: 0.5,
  conflictLevel: 0.5,
  noveltyLevel: 0.5,
  userVulnerability: 0.5,
  timeOfDay: 0.5,
};

// A neutral input for read-time neural projection, not an observation that the
// user currently has no conflict, vulnerability, or intimacy.
const STALE_CONTEXT: CriticContext = {
  userEmotion: 0,
  topicIntimacy: 0,
  conversationDepth: 0,
  userEngagement: 0.5,
  conflictLevel: 0,
  noveltyLevel: 0,
  userVulnerability: 0,
  timeOfDay: 0.5,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function invalidEmotionSettings(): never {
  throw new TypeError("invalid_scene_emotion_settings");
}

function settingsNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    invalidEmotionSettings();
  }
  return value;
}

/**
 * Validate a partial per-character configuration and return an independent,
 * complete settings object. Configuration errors are rejected rather than
 * clamped so persisted user choices cannot silently change meaning.
 */
export function emotionSettingsOf(value?: unknown): EmotionSettings {
  let input: Record<string, unknown>;
  if (value === undefined) input = {};
  else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    input = value as Record<string, unknown>;
  } else invalidEmotionSettings();

  const allowed = new Set([
    "driveBaseline",
    "frustrationDecayPerHour",
    "connectionHungerPerHour",
    "noveltyHungerPerHour",
    "eventRetainedFraction",
    "stableRelationRate",
    "hebbianLearningRate", "phaseThreshold", "temperatureCoefficient", "temperatureFloor", "randomizedBaseline",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) invalidEmotionSettings();
  if (input.randomizedBaseline !== undefined && typeof input.randomizedBaseline !== 'boolean') invalidEmotionSettings();

  let baselineInput: Record<string, unknown> = {};
  if (input.driveBaseline !== undefined) {
    if (
      typeof input.driveBaseline !== "object"
      || input.driveBaseline === null
      || Array.isArray(input.driveBaseline)
    ) invalidEmotionSettings();
    baselineInput = input.driveBaseline as Record<string, unknown>;
    if (Object.keys(baselineInput).some((key) => !(DRIVE_NAMES as readonly string[]).includes(key))) {
      invalidEmotionSettings();
    }
  }

  const driveBaseline = Object.fromEntries(DRIVE_NAMES.map((drive) => [
    drive,
    settingsNumber(baselineInput[drive], DEFAULT_EMOTION_SETTINGS.driveBaseline[drive], 0, 1),
  ])) as DriveValues;

  return {
    driveBaseline,
    randomizedBaseline: input.randomizedBaseline as boolean | undefined ?? input.driveBaseline === undefined,
    hebbianLearningRate: settingsNumber(input.hebbianLearningRate, DEFAULT_EMOTION_SETTINGS.hebbianLearningRate, 0, 0.1),
    phaseThreshold: settingsNumber(input.phaseThreshold, DEFAULT_EMOTION_SETTINGS.phaseThreshold, 0.1, 20),
    temperatureCoefficient: settingsNumber(input.temperatureCoefficient, DEFAULT_EMOTION_SETTINGS.temperatureCoefficient, 0.001, 1),
    temperatureFloor: settingsNumber(input.temperatureFloor, DEFAULT_EMOTION_SETTINGS.temperatureFloor, 0, 0.5),
    frustrationDecayPerHour: settingsNumber(
      input.frustrationDecayPerHour,
      DEFAULT_EMOTION_SETTINGS.frustrationDecayPerHour,
      0,
      2,
    ),
    connectionHungerPerHour: settingsNumber(
      input.connectionHungerPerHour,
      DEFAULT_EMOTION_SETTINGS.connectionHungerPerHour,
      0,
      1,
    ),
    noveltyHungerPerHour: settingsNumber(
      input.noveltyHungerPerHour,
      DEFAULT_EMOTION_SETTINGS.noveltyHungerPerHour,
      0,
      1,
    ),
    eventRetainedFraction: settingsNumber(
      input.eventRetainedFraction,
      DEFAULT_EMOTION_SETTINGS.eventRetainedFraction,
      0,
      1,
    ),
    stableRelationRate: settingsNumber(
      input.stableRelationRate,
      DEFAULT_EMOTION_SETTINGS.stableRelationRate,
      0,
      0.1,
    ),
  };
}

function boundedValue(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  path: string,
): number {
  if (input[key] === undefined) return fallback;
  return clamp(requireFiniteNumber(input[key], `${path}.${key}`), minimum, maximum);
}

/** Named future judgment fields retained only when reading accepted records; their values are opaque in this version. */
export const STORED_EMOTION_DELTA_MEMBERS = Object.freeze([
  'appraisal',
  'relation',
  'appraisalRule',
  'contract',
] as const);

/** Named future state fields retained on validation; null is a value and unlisted fields are still discarded. */
export const STORED_EMOTION_STATE_MEMBERS = Object.freeze([
  'engine',
  'eventClockMs',
  'lastEvent',
  'relationEma',
  'baselineOrigin',
  'rewardMean',
  'lastLearningReward',
  'previousFrustration',
  'counts',
  'controlDigest',
  'ownAct',
] as const);

/**
 * Compares complete validated settings, including all five baselines even when randomization is enabled.
 * Inputs have the same units and limits as emotionSettingsOf; invalid inputs propagate its existing error.
 */
export function emotionSettingsEqual(left?: unknown, right?: unknown): boolean {
  return JSON.stringify(emotionSettingsOf(left)) === JSON.stringify(emotionSettingsOf(right));
}

/** Legacy backup shape gate: only numeric version 2 returns true; snapshot trust is decided separately. */
export function emotionStateVersionRecognized(version: unknown): boolean {
  return version === 2;
}

function boundedDrives(
  input: Record<string, unknown>,
  minimum: number,
  maximum: number,
  path: string,
): DriveValues {
  return Object.fromEntries(
    DRIVE_NAMES.map((drive) => [
      drive,
      boundedValue(input, drive, 0, minimum, maximum, path),
    ]),
  ) as DriveValues;
}

/**
 * Normalize already-stored sparse Critic candidates during historical replay.
 * New model output must instead pass validateModelEmotionDelta before storage.
 * Historical omissions and finite out-of-range values keep the old fallback
 * and clamp semantics so a code upgrade does not reinterpret accepted events.
 */
export function validateEmotionDelta(input: unknown): EmotionDelta {
  const candidate = requireRecord(input, "emotionDelta");
  const rawContext = requireRecord(candidate.context, "emotionDelta.context");
  const rawFrustration = requireRecord(
    candidate.frustrationDelta,
    "emotionDelta.frustrationDelta",
  );

  const context: CriticContext = {
    userEmotion: boundedValue(rawContext, "userEmotion", 0.5, -1, 1, "emotionDelta.context"),
    topicIntimacy: boundedValue(rawContext, "topicIntimacy", 0.5, 0, 1, "emotionDelta.context"),
    conversationDepth: boundedValue(rawContext, "conversationDepth", 0.5, 0, 1, "emotionDelta.context"),
    userEngagement: boundedValue(rawContext, "userEngagement", 0.5, 0, 1, "emotionDelta.context"),
    conflictLevel: boundedValue(rawContext, "conflictLevel", 0.5, 0, 1, "emotionDelta.context"),
    noveltyLevel: boundedValue(rawContext, "noveltyLevel", 0.5, 0, 1, "emotionDelta.context"),
    userVulnerability: boundedValue(rawContext, "userVulnerability", 0.5, 0, 1, "emotionDelta.context"),
    timeOfDay: boundedValue(rawContext, "timeOfDay", 0.5, 0, 1, "emotionDelta.context"),
  };

  const driveSatisfaction = candidate.driveSatisfaction === undefined
    ? boundedDrives({}, 0, 0.3, "emotionDelta.driveSatisfaction")
    : boundedDrives(
        requireRecord(candidate.driveSatisfaction, "emotionDelta.driveSatisfaction"),
        0,
        0.3,
        "emotionDelta.driveSatisfaction",
      );

  let stableRelationDelta: Partial<StableRelations> | undefined;
  if (candidate.stableRelationDelta !== undefined) {
    const rawRelations = requireRecord(
      candidate.stableRelationDelta,
      "emotionDelta.stableRelationDelta",
    );
    stableRelationDelta = {};
    for (const key of ["depth", "trust", "valence"] as const) {
      if (rawRelations[key] !== undefined) {
        stableRelationDelta[key] = clamp(
          requireFiniteNumber(rawRelations[key], `emotionDelta.stableRelationDelta.${key}`),
          -1,
          1,
        );
      }
    }
  }

  return {
    context,
    frustrationDelta: boundedDrives(
      rawFrustration,
      -3,
      3,
      "emotionDelta.frustrationDelta",
    ),
    driveSatisfaction,
    ...(stableRelationDelta === undefined ? {} : { stableRelationDelta }),
    ...Object.fromEntries(STORED_EMOTION_DELTA_MEMBERS
      .filter(member => Object.hasOwn(candidate, member) && candidate[member] !== undefined)
      .map(member => [member, candidate[member]])),
  };
}

function strictValue(input: Record<string, unknown>, key: string, minimum: number, maximum: number, path: string): number {
  const value = requireFiniteNumber(input[key], `${path}.${key}`);
  if (value < minimum || value > maximum) throw new RangeError(`${path}.${key} out of range`);
  return value;
}

/** New model output must satisfy its contract before it can become an experience. */
export function validateModelEmotionDelta(input: unknown, clockTimeMs: number | null, timeZone = 'UTC'): EmotionDelta {
  const candidate = requireRecord(input, 'emotionDelta');
  const context = requireRecord(candidate.context, 'emotionDelta.context');
  const frustration = requireRecord(candidate.frustrationDelta, 'emotionDelta.frustrationDelta');
  for (const key of Object.keys(DEFAULT_CONTEXT) as (keyof CriticContext)[]) {
    if (key === 'timeOfDay')
      continue;
    strictValue(context, key, key === 'userEmotion' ? -1 : 0, 1, 'emotionDelta.context');
  }
  // Older model templates can still send this field, but it never sets time.
  if (context.timeOfDay !== undefined)
    strictValue(context, 'timeOfDay', 0, 1, 'emotionDelta.context');
  for (const drive of DRIVE_NAMES)
    strictValue(frustration, drive, -3, 3, 'emotionDelta.frustrationDelta');
  if (candidate.driveSatisfaction !== undefined) {
    const satisfaction = requireRecord(candidate.driveSatisfaction, 'emotionDelta.driveSatisfaction');
    for (const drive of DRIVE_NAMES)
      if (satisfaction[drive] !== undefined) {
        strictValue(satisfaction, drive, 0, 0.3, 'emotionDelta.driveSatisfaction');
      }
  }
  if (candidate.stableRelationDelta !== undefined) {
    const relations = requireRecord(candidate.stableRelationDelta, 'emotionDelta.stableRelationDelta');
    for (const key of ['depth', 'trust', 'valence'])
      if (relations[key] !== undefined) {
        strictValue(relations, key, -1, 1, 'emotionDelta.stableRelationDelta');
      }
  }
  const recorded: Record<string, unknown> = {
    ...candidate,
    context: { ...context, timeOfDay: timeOfDayAt(clockTimeMs, timeZone) },
  };
  // Accepted records can carry opaque future fields; new model output cannot introduce those fields.
  for (const member of STORED_EMOTION_DELTA_MEMBERS)
    delete recorded[member];
  return validateEmotionDelta(recorded);
}

/** 0 is local midnight, 0.5 is noon, and values approach 1 before midnight. */
export function timeOfDayAt(clockTimeMs: number | null, timeZone = 'UTC'): number {
  if (clockTimeMs === null) return DEFAULT_CONTEXT.timeOfDay;
  const timestamp = requireFiniteNumber(clockTimeMs, 'clockTimeMs');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(timestamp);
  const part = (type: string) => Number(parts.find(item => item.type === type)?.value);
  return (part('hour') * 3_600 + part('minute') * 60 + part('second')) / 86_400;
}

function neutralDrives(): DriveValues {
  return Object.fromEntries(DRIVE_NAMES.map((drive) => [drive, 0])) as DriveValues;
}

function neutralSignals(): BehaviorSignals {
  return Object.fromEntries(
    BEHAVIOR_SIGNAL_NAMES.map((signal) => [signal, 0.5]),
  ) as BehaviorSignals;
}

function neuralContext(context: CriticContext, relations: StableRelations): Record<string,number> {
  return {...context, relationshipDepth:relations.depth, emotionalValence:relations.valence,
    trustLevel:relations.trust, pendingForesight:0};
}

/** Stable identity hashing is initialization, not a source of runtime randomness. */
function identitySeed(identity: string): number {
  let value=2166136261;
  for (const point of identity) { value ^= point.codePointAt(0)!; value=Math.imul(value,16777619); }
  return value >>> 0;
}

/** Creates a seeded state at Unix milliseconds; optional engine metadata selects a test replay rule.
 * Invalid times, settings and non-string identities retain their existing errors. */
export function createEmotion(
  nowMs: number,
  settings?: unknown,
  identity = 'xldb-default',
  engineKey?: EmotionEngineKey,
): EmotionState {
  const timestamp = requireFiniteNumber(nowMs, "nowMs");
  const selected = emotionSettingsOf(settings);
  const neural=createNeural(identitySeed(identity),{hebbianLr:selected.hebbianLearningRate,phaseThreshold:selected.phaseThreshold});
  if (!selected.randomizedBaseline) {
    neural.driveBaseline={...selected.driveBaseline};
    neural.driveState={...selected.driveBaseline};
  }
  return {
    version: engineKey?.rule ?? 2,
    updatedAtMs: timestamp,
    criticContextAtMs: timestamp,
    frustration: neutralDrives(),
    drives: Object.fromEntries(
      DRIVE_NAMES.map((drive) => [drive, neural.driveBaseline[drive]]),
    ) as DriveValues,
    criticContext: { ...DEFAULT_CONTEXT },
    behavioralSignals: neutralSignals(),
    stableRelations: { depth: 0, trust: 0, valence: 0 },
    neural,
    lastReward:0,
    ...(engineKey?.rule === 3 ? {
      engine: engineKey,
      lastEvent: null,
      relationEma: [],
      baselineOrigin: {...neural.driveBaseline},
      rewardMean: 0,
      lastLearningReward: 0,
      previousFrustration: neutralDrives(),
    } : {}),
  };
}

/**
 * Time-only frustration metabolism: F = F0*e^(-k*h) + hunger*h, clamped to [0, 5]. Connection and novelty hunger
 * accumulate; other drives only decay. Shorter than MIN_METABOLISM_HOURS (or negative) leaves F0 unchanged, exactly as
 * emotionAt does. The contact-pressure model projects E0 with this same function.
 */
export function projectFrustration(frustration: DriveValues, hours: number, settings?: unknown): DriveValues {
  const selected = emotionSettingsOf(settings);
  const elapsed = requireFiniteNumber(hours, 'hours');
  const projected = { ...frustration };
  if (elapsed < MIN_METABOLISM_HOURS) return projected;
  for (const drive of DRIVE_NAMES) {
    const hunger = drive === 'connection' ? selected.connectionHungerPerHour : drive === 'novelty' ? selected.noveltyHungerPerHour : 0;
    projected[drive] = clamp(frustration[drive] * Math.exp(-selected.frustrationDecayPerHour * elapsed) + hunger * elapsed, 0, 5);
  }
  return projected;
}

/**
 * The read-time behavioral signals of a state, computed exactly as emotionAt computes them: one neural forward on a
 * clone with the state's Critic context and relations, then the thermodynamic noise of its total frustration. Nothing is
 * trained and the persisted neural state and random trajectory are unchanged.
 */
export function behavioralSignalsAt(state: EmotionState, settings?: unknown): BehaviorSignals {
  const selected = emotionSettingsOf(settings);
  const forward=neuralForward(state.neural,neuralContext(state.criticContext,state.stableRelations),state.drives);
  return neuralThermodynamic(forward.state,forward.signals,Object.values(state.frustration).reduce((a,b)=>a+b,0),
    selected.temperatureCoefficient,selected.temperatureFloor).signals as BehaviorSignals;
}

/** Read-time projection: elapsed time changes drives, never applies another event. */
export function emotionAt(previous: EmotionState, nowMs: number, settings?: unknown, timeZone: string | null = 'UTC'): EmotionState {
  const selected = emotionSettingsOf(settings);
  const updatedAtMs = Math.max(previous.updatedAtMs, requireFiniteNumber(nowMs, 'nowMs'));
  const hours = (updatedAtMs - previous.updatedAtMs) / 3_600_000;
  const criticContextAtMs = previous.criticContextAtMs ?? previous.updatedAtMs;
  const fresh = updatedAtMs - criticContextAtMs < CRITIC_CONTEXT_FRESH_MS;
  const criticContext = !fresh
    ? { ...STALE_CONTEXT }
    : { ...previous.criticContext };
  // In the frozen branch, timeOfDay is read-time display context only;
  // behavioralSignals retain the accepted-event values, not a new evaluation of this context.
  criticContext.timeOfDay = timeOfDayAt(timeZone === null ? null : updatedAtMs, timeZone ?? 'UTC');
  const frustration = projectFrustration(previous.frustration, hours, selected);
  const drives = {} as DriveValues;
  for (const drive of DRIVE_NAMES) {
    drives[drive] = clamp(previous.neural.driveBaseline[drive] + frustration[drive] * FRUSTRATION_TO_DRIVE, 0, 1);
  }
  // New states have no accepted signal yet; retain their existing short-read
  // behavior and otherwise evaluate their neutral initial context as before.
  if ((previous.neural.interactionCount > 0 && fresh)
      || (previous.neural.interactionCount === 0 && hours < MIN_METABOLISM_HOURS)) {
    return { ...structuredClone(previous), updatedAtMs: hours < MIN_METABOLISM_HOURS ? previous.updatedAtMs : updatedAtMs,
      criticContext, criticContextAtMs, frustration, drives };
  }
  // Forward evaluation occurs on a clone. Discard its recurrent/RNG/history changes:
  // time-only reads cannot train or advance the persisted random trajectory.
  const forward=neuralForward(previous.neural,neuralContext(criticContext,previous.stableRelations),drives);
  const noisy=neuralThermodynamic(forward.state,forward.signals,Object.values(frustration).reduce((a,b)=>a+b,0),selected.temperatureCoefficient,selected.temperatureFloor);
  return { ...structuredClone(previous), updatedAtMs, criticContextAtMs, criticContext, frustration, drives,
    behavioralSignals: noisy.signals as BehaviorSignals };
}

interface RuleThreeMembers {
  baselineOrigin: DriveValues;
  rewardMean: number;
  lastLearningReward: number;
  previousFrustration: DriveValues;
}

function ruleThreeMembers(input: Record<string, unknown>): RuleThreeMembers {
  const checkedDrives = (value: unknown, maximum: number): DriveValues => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid_emotion_state_range');
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== DRIVE_NAMES.length) throw new Error('invalid_emotion_state_range');
    const result = {} as DriveValues;
    for (const name of DRIVE_NAMES) {
      const number = record[name];
      if (!Object.hasOwn(record, name) || typeof number !== 'number' || !Number.isFinite(number)
        || number < 0 || number > maximum) {
        throw new Error('invalid_emotion_state_range');
      }
      result[name] = number;
    }
    return result;
  };
  const checkedReward = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
      throw new Error('invalid_emotion_state_reward');
    }
    return value;
  };
  return {
    baselineOrigin: checkedDrives(input.baselineOrigin, 1),
    rewardMean: checkedReward(input.rewardMean),
    lastLearningReward: checkedReward(input.lastLearningReward),
    previousFrustration: checkedDrives(input.previousFrustration, 5),
  };
}

function unitCoefficient(value: unknown, fallback: number, name: string): number {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(name + ' must be a finite number in [0, 1]');
  }
  return value;
}

interface RuleCoefficients {
  baselineLearningRate: number;
  rewardMeanRetention: number;
  rewardMeanWeight: number;
}

function ruleConstants(value: EmotionRuleConstants | null | undefined): RuleCoefficients {
  const defaults = {
    baselineLearningRate: BASELINE_LEARNING_RATE,
    rewardMeanRetention: REWARD_MEAN_RETENTION,
    rewardMeanWeight: REWARD_MEAN_WEIGHT,
  };
  if (value == null) return defaults;
  const input = requireRecord(value, 'ruleConstants');
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(defaults, name)) throw new TypeError('unknown ruleConstants member: ' + name);
  }
  const coefficients = {
    baselineLearningRate: unitCoefficient(input.baselineLearningRate, defaults.baselineLearningRate,
      'baselineLearningRate'),
    rewardMeanRetention: unitCoefficient(input.rewardMeanRetention, defaults.rewardMeanRetention,
      'rewardMeanRetention'),
    rewardMeanWeight: unitCoefficient(input.rewardMeanWeight, defaults.rewardMeanWeight, 'rewardMeanWeight'),
  };
  // A weighted sum of bounded rewards must stay in the state validator's [-1, 1] interval.
  if (coefficients.rewardMeanRetention + coefficients.rewardMeanWeight > 1) {
    throw new TypeError('rewardMeanRetention + rewardMeanWeight must not exceed 1');
  }
  return coefficients;
}

function advanceRuleThree({
  previous,
  delta,
  updatedAtMs,
  frustration,
  drives,
  stableRelations,
  reward,
  selected,
  engine,
  baselineElasticity,
  constants,
  eventClockMs,
  eventSource,
  relationInput,
}: {
  previous: EmotionState;
  delta: EmotionDelta;
  updatedAtMs: number;
  frustration: DriveValues;
  drives: DriveValues;
  stableRelations: StableRelations;
  reward: number;
  selected: EmotionSettings;
  engine: unknown;
  baselineElasticity: number | null | undefined;
  constants: EmotionRuleConstants | null | undefined;
  eventClockMs?: number | null;
  eventSource?: EmotionEventSource | null;
  relationInput?: EmotionRelationInput | null;
}): EmotionState {
  const stored = ruleThreeMembers(previous as unknown as Record<string, unknown>);
  const relations = advanceRelationInput(previous, delta, relationInput, stableRelations);
  const elasticity = unitCoefficient(baselineElasticity, BASELINE_ELASTICITY, 'baselineElasticity');
  const coefficients = ruleConstants(constants);
  // Center against the previous mean, before this event contributes to that mean.
  const learningReward = clamp(reward - stored.rewardMean, -1, 1);
  const rewardMean = coefficients.rewardMeanRetention * stored.rewardMean
    + coefficients.rewardMeanWeight * reward;
  const learned = neuralStep(
    previous.neural,
    neuralContext(delta.context, relations.stableRelations),
    learningReward,
    delta.driveSatisfaction,
    drives,
  );
  const total = Object.values(frustration).reduce((sum, value) => sum + value, 0);
  const noisy = neuralThermodynamic(
    learned.state,
    learned.signals,
    total,
    selected.temperatureCoefficient,
    selected.temperatureFloor,
  );

  const visibleDrives = {} as DriveValues;
  for (const drive of DRIVE_NAMES) {
    const baseline = previous.neural.driveBaseline[drive];
    const origin = stored.baselineOrigin[drive];
    const shift = (delta.frustrationDelta[drive] ?? 0) * coefficients.baselineLearningRate;
    const pullBack = -(baseline - origin) * elasticity;
    // Upstream addition is left associative. Include user-selected origins outside the upstream [0.1, 0.95].
    const nextBaseline = clamp(baseline + shift + pullBack, Math.min(0.1, origin), Math.max(0.95, origin));
    // This event's forward already consumed the old baseline; only subsequent events consume this value.
    noisy.state.driveBaseline[drive] = nextBaseline;
    visibleDrives[drive] = clamp(nextBaseline + frustration[drive] * FRUSTRATION_TO_DRIVE, 0, 1);
  }

  return {
    version: 3,
    updatedAtMs,
    criticContextAtMs: updatedAtMs,
    frustration,
    drives: visibleDrives,
    criticContext: {...delta.context},
    behavioralSignals: noisy.signals as BehaviorSignals,
    stableRelations: relations.stableRelations,
    relationEma: relations.relationEma,
    neural: noisy.state,
    lastReward: reward,
    ...(engine === undefined ? {} : {engine}),
    ...(eventClockMs == null ? {} : {eventClockMs}),
    baselineOrigin: stored.baselineOrigin,
    rewardMean,
    lastLearningReward: learningReward,
    previousFrustration: {...previous.frustration},
    lastEvent: eventSource == null ? null : {...eventSource},
  };
}

function validRelationTriple(value: unknown): value is StableRelations {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (['depth', 'trust', 'valence'] as const).every(name => Object.hasOwn(input, name)
    && typeof input[name] === 'number' && Number.isFinite(input[name])
    && input[name] >= (name === 'valence' ? -1 : 0) && input[name] <= 1);
}

function validCounterpartId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}

function checkedRelationEma(value: unknown): RelationEmaEntry[] {
  if (!Array.isArray(value) || value.length > RELATION_EMA_LIMIT) {
    throw new Error('invalid_emotion_state_range');
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (!validRelationTriple(entry) || Reflect.ownKeys(entry).length !== 4
      || !Object.hasOwn(entry, 'counterpartId')) {
      throw new Error('invalid_emotion_state_range');
    }
    const counterpartId = (entry as RelationEmaEntry).counterpartId;
    if (!validCounterpartId(counterpartId) || seen.has(counterpartId)) {
      throw new Error('invalid_emotion_state_range');
    }
    seen.add(counterpartId);
  }
  return value as RelationEmaEntry[];
}

/**
 * Reads stored relation increments without mutating history; invalid members are omitted and flagged.
 * Null or omission returns null for legacy numeric tapes; other non-record values return an empty relation.
 * Values are finite unitless increments, not clamped here. Work is O(toward entries); getter errors propagate.
 */
export function readEmotionRelation(value: unknown): {
  relation: {toward?: {target: string; depth?: number; trust?: number}[]; valence?: number} | null;
  invalid: boolean;
} {
  if (value == null) return {relation: null, invalid: false};
  const isRecord = (candidate: unknown): candidate is Record<string, unknown> => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const prototype = Object.getPrototypeOf(candidate);
    return prototype === Object.prototype || prototype === null;
  };
  if (!isRecord(value)) return {relation: {}, invalid: true};

  let invalid = false;
  const finiteMember = (record: Record<string, unknown>, name: string): number | undefined => {
    if (!Object.hasOwn(record, name)) return undefined;
    const member = record[name];
    if (typeof member === 'number' && Number.isFinite(member)) return member;
    invalid = true;
    return undefined;
  };
  const relation: NonNullable<ReturnType<typeof readEmotionRelation>['relation']> = {};
  const valence = finiteMember(value, 'valence');
  if (valence !== undefined) relation.valence = valence;
  if (Object.hasOwn(value, 'toward')) {
    if (!Array.isArray(value.toward)) {
      invalid = true;
    } else {
      relation.toward = [];
      for (const item of value.toward) {
        if (!isRecord(item) || typeof item.target !== 'string') {
          invalid = true;
          continue;
        }
        const depth = finiteMember(item, 'depth');
        const trust = finiteMember(item, 'trust');
        relation.toward.push({
          target: item.target,
          ...(depth === undefined ? {} : {depth}),
          ...(trust === undefined ? {} : {trust}),
        });
      }
    }
  }
  return {relation, invalid};
}

function advanceRelationInput(
  previous: EmotionState,
  delta: EmotionDelta,
  input: EmotionRelationInput | null | undefined,
  accumulated: StableRelations,
): {stableRelations: StableRelations; relationEma: RelationEmaEntry[]} {
  const entries = checkedRelationEma(previous.relationEma).map(entry => ({...entry}));
  // Only the legacy core omits this argument; an explicitly absent scene person preserves the preceding input.
  if (input === undefined) return {stableRelations: accumulated, relationEma: entries};
  if (input === null) return {stableRelations: {...previous.stableRelations}, relationEma: entries};
  if (!validCounterpartId(input.counterpartId) || !validRelationTriple(input.prior)) {
    throw new TypeError('invalid_emotion_relation_input');
  }

  const relation = readEmotionRelation(delta.relation).relation;
  const toward = relation?.toward?.find(item => item.target === input.counterpartId);
  // Scene records clear the legacy increment; numeric tapes retain it only when the relation is absent.
  const increment = relation == null ? delta.stableRelationDelta ?? {} : {
    depth: toward?.depth ?? 0,
    trust: toward?.trust ?? 0,
    valence: relation.valence ?? 0,
  };
  const weight = clamp(RELATION_EMA_MINIMUM + RELATION_EMA_DEPTH_WEIGHT * delta.context.conversationDepth,
    RELATION_EMA_MINIMUM, RELATION_EMA_MAXIMUM);
  const oldIndex = entries.findIndex(entry => entry.counterpartId === input.counterpartId);
  const old = oldIndex < 0 ? input.prior : entries[oldIndex]!;
  const stableRelations = {} as StableRelations;
  for (const name of ['depth', 'trust', 'valence'] as const) {
    const posterior = clamp(input.prior[name] + requireFiniteNumber(increment[name] ?? 0, 'relation increment'),
      name === 'valence' ? -1 : 0, 1);
    stableRelations[name] = roundFourDecimals(weight * posterior + (1 - weight) * old[name]);
  }
  if (oldIndex >= 0) entries.splice(oldIndex, 1);
  entries.push({counterpartId: input.counterpartId, ...stableRelations});
  if (entries.length > RELATION_EMA_LIMIT) entries.shift();
  return {stableRelations, relationEma: entries};
}

// A boolean selector leaves the historical metadata tail's type analysis and bytes intact.
function requestsRuleThree(engineKey: EmotionEngineKey | undefined): boolean {
  return engineKey?.rule === 3;
}

/**
 * Accumulates a validated relation delta at a unitless rate, returning a detached bounded relation triple.
 * Depth and trust retain their normalized [0, 1] ranges; valence retains its signed [-1, 1] range.
 * Callers supply validated state, delta and settings; this arithmetic helper performs no parsing or mutation.
 */
export function accumulateStableRelations(
  previous: StableRelations,
  delta: EmotionDelta['stableRelationDelta'],
  stableRelationRate: number,
): StableRelations {
  const relationDelta = delta ?? {};
  return {
    depth: clamp(previous.depth + (relationDelta.depth ?? 0) * stableRelationRate, 0, 1),
    trust: clamp(previous.trust + (relationDelta.trust ?? 0) * stableRelationRate, 0, 1),
    valence: clamp(previous.valence + (relationDelta.valence ?? 0) * stableRelationRate, -1, 1),
  };
}

/** Advances one accepted event in milliseconds; historical rule 2 retains its exact numerical behavior.
 * Rule 3 centers learning rewards and evolves baselines. Optional elasticity/constants are unit coefficients;
 * null or omission selects defaults, invalid coefficients throw TypeError, and invalid third-rule members throw
 * the existing state reward/range errors. No random draws are added outside the kernel.
 * An omitted/null event source clears the third-rule pointer, since this event has no attributable source.
 * An omitted relation input selects legacy core accumulation; scene callers must pass a pair or explicit null.
 * Keep the event calculation equivalent to advanceEmotionWithClock when its hunger hours equal elapsed hours.
 * Only numeric values are equivalent; omitted-key identity behavior intentionally differs. */
export function advanceEmotion(
  previous: EmotionState,
  candidate: EmotionDelta,
  nowMs: number,
  settings?: unknown,
  engineKey?: EmotionEngineKey,
  baselineElasticity?: number | null,
  constants?: EmotionRuleConstants | null,
  eventSource?: EmotionEventSource | null,
  relationInput?: EmotionRelationInput | null,
): EmotionState {
  const delta = validateEmotionDelta(candidate);
  const selected = emotionSettingsOf(settings);
  const requestedNowMs = requireFiniteNumber(nowMs, "nowMs");
  const updatedAtMs = Math.max(previous.updatedAtMs, requestedNowMs);
  const elapsedHours = Math.max(0, updatedAtMs - previous.updatedAtMs) / 3_600_000;
  const applyMetabolism = elapsedHours >= MIN_METABOLISM_HOURS;
  const decay = applyMetabolism
    ? Math.exp(-selected.frustrationDecayPerHour * elapsedHours)
    : 1;

  const frustration = {} as DriveValues;
  let beforeEventTotal=0;
  for (const drive of DRIVE_NAMES) {
    let current = previous.frustration[drive];
    if (applyMetabolism) {
      current *= decay;
      if (drive === "connection") current += selected.connectionHungerPerHour * elapsedHours;
      if (drive === "novelty") current += selected.noveltyHungerPerHour * elapsedHours;
      current = clamp(current, 0, 5);
    }
    beforeEventTotal += current;
    frustration[drive] = clamp(
      (current + (delta.frustrationDelta[drive] ?? 0)) * selected.eventRetainedFraction,
      0,
      5,
    );
  }

  const drives = {} as DriveValues;
  for (const drive of DRIVE_NAMES) {
    drives[drive] = clamp(
      previous.neural.driveBaseline[drive] + frustration[drive] * FRUSTRATION_TO_DRIVE,
      0,
      1,
    );
  }

  const stableRelations = accumulateStableRelations(
    previous.stableRelations,
    delta.stableRelationDelta,
    selected.stableRelationRate,
  );

  const total=Object.values(frustration).reduce((a,b)=>a+b,0);
  // Upstream reward is reduction in metabolism frustration, never a model's
  // direct weight update. One accepted event performs one full learning cycle.
  const reward=clamp(beforeEventTotal-total,-1,1);
  if (requestsRuleThree(engineKey)) {
    return advanceRuleThree({
      previous,
      delta,
      updatedAtMs,
      frustration,
      drives,
      stableRelations,
      reward,
      selected,
      engine: engineKey,
      baselineElasticity,
      constants,
      eventSource,
      relationInput,
    });
  }
  const synced=structuredClone(previous.neural);
  synced.frustration=total;
  const learned=neuralStep(synced,neuralContext(delta.context,stableRelations),reward,delta.driveSatisfaction,drives);
  const noisy=neuralThermodynamic(learned.state,learned.signals,total,selected.temperatureCoefficient,selected.temperatureFloor);

  return {
    version: engineKey?.rule ?? 2,
    updatedAtMs,
    criticContextAtMs: updatedAtMs,
    frustration,
    // The learned kernel retains satisfaction/tick state for OH0 parity;
    // the actor-visible projection follows upstream sync_to_agent instead.
    drives,
    criticContext: { ...delta.context },
    behavioralSignals: noisy.signals as BehaviorSignals,
    stableRelations,
    neural:noisy.state,
    lastReward:reward,
    ...(engineKey?.rule === 3 ? {engine: engineKey} : {}),
  };
}

/**
 * Separate hunger hours and local-day context for a read. Hours are finite and nonnegative; timeOfDay is in [0, 1).
 * Invalid numeric members throw TypeError in the clock-aware entries; getters propagate their original errors.
 */
export interface EmotionClockProjection {
  hungerHours: number;
  timeOfDay: number;
}

/**
 * Event context plus an optional finite event clock in milliseconds, including negative or fractional values.
 * Null means omission; invalid numeric members throw TypeError and getters propagate their original errors.
 */
export interface EmotionClockStep extends EmotionClockProjection {
  eventClockMs?: number | null;
}

// Unit conversion shared by both second-resolution clock entries.
const SECONDS_PER_DAY = 86_400;
// The engine's specified local-day origin is 06:00, measured in seconds after midnight.
const LOCAL_DAY_ORIGIN_SECONDS = 21_600;

/** Converts a stored midnight fraction in [0, 1] to a six-o'clock fraction; invalid values throw TypeError. */
export function convertTimeOfDay(value: number): number {
  const fraction = requireFiniteNumber(value, 'timeOfDay');
  if (fraction < 0 || fraction > 1) throw new TypeError('invalid_emotion_time_of_day');

  // Historical clock readings are whole seconds. Recover that unit so both entries encode the same instant.
  const wholeSeconds = Math.round(fraction * SECONDS_PER_DAY);
  if (wholeSeconds / SECONDS_PER_DAY === fraction) {
    return ((wholeSeconds - LOCAL_DAY_ORIGIN_SECONDS + SECONDS_PER_DAY) % SECONDS_PER_DAY) / SECONDS_PER_DAY;
  }

  // Preserve finer stored fractions; the engine contract moves the origin by one quarter of a day.
  return ((fraction - 0.25) % 1 + 1) % 1;
}

/**
 * Reads a floating local story clock, in safe integer milliseconds from year one, without a timezone.
 * Unknown local time returns the contract's neutral 0.5; invalid clocks or nonboolean flags throw TypeError.
 */
export function storyTimeOfDay(clockMs: number, timeOfDayKnown: boolean): number {
  if (!Number.isSafeInteger(clockMs) || clockMs < 0 || clockMs > STORY_CLOCK_MAX_MS
    || typeof timeOfDayKnown !== 'boolean') {
    throw new TypeError('invalid_emotion_story_clock');
  }
  if (!timeOfDayKnown) return 0.5;

  // The engine contract defines 06:00 as zero; milliseconds retain the story clock's full precision.
  const localHours = (clockMs % 86_400_000) / 3_600_000;
  const shiftedHours = localHours - 6;
  return (shiftedHours < 0 ? shiftedHours + 24 : shiftedHours) / 24;
}

/**
 * Reads Unix milliseconds in an IANA zone using the historical second-resolution clock reader.
 * Null zones mean unknown local time (0.5); omission selects UTC. Invalid times/zones retain the reader's errors.
 */
export function realTimeOfDay(clockMs: number, timeZone: string | null = 'UTC'): number {
  requireFiniteNumber(clockMs, 'clockMs');
  if (timeZone === null) return 0.5;

  const localSeconds = Math.round(timeOfDayAt(clockMs, timeZone) * SECONDS_PER_DAY);
  // The same contract-defined six-hour origin is used in both clock domains.
  return ((localSeconds - LOCAL_DAY_ORIGIN_SECONDS + SECONDS_PER_DAY) % SECONDS_PER_DAY) / SECONDS_PER_DAY;
}

function checkedClockStep(options: EmotionClockStep): EmotionClockStep {
  const hungerHours = requireFiniteNumber(options.hungerHours, 'hungerHours');
  const timeOfDay = requireFiniteNumber(options.timeOfDay, 'timeOfDay');
  if (hungerHours < 0 || timeOfDay < 0 || timeOfDay >= 1) {
    throw new TypeError('invalid_emotion_clock_step');
  }

  const eventClockMs = options.eventClockMs;
  return {
    hungerHours,
    timeOfDay,
    ...(eventClockMs == null ? {} : {eventClockMs: requireFiniteNumber(eventClockMs, 'eventClockMs')}),
  };
}

function clockFrustration(
  previous: DriveValues,
  elapsedHours: number,
  hungerHours: number,
  selected: EmotionSettings,
): DriveValues {
  // Each independent gate retains the historical minimum interval of 0.001 hours.
  const applyDecay = elapsedHours >= MIN_METABOLISM_HOURS;
  const applyHunger = hungerHours >= MIN_METABOLISM_HOURS;
  const decay = applyDecay ? Math.exp(-selected.frustrationDecayPerHour * elapsedHours) : 1;
  const result = {...previous};
  if (!applyDecay && !applyHunger) return result;

  for (const drive of DRIVE_NAMES) {
    let current = previous[drive];
    if (applyDecay) current *= decay;
    if (applyHunger && drive === 'connection') current += selected.connectionHungerPerHour * hungerHours;
    if (applyHunger && drive === 'novelty') current += selected.noveltyHungerPerHour * hungerHours;
    // Clamp once, after decay then hunger, to preserve the historical event's floating-point order.
    result[drive] = clamp(current, 0, 5);
  }
  return result;
}

/**
 * Advances a third-rule state by time alone, using finite milliseconds and independently supplied hunger hours.
 * Preserves all event, neural, random and relationship members; returns a detached state without modifying input.
 * Invalid versions or clock values throw TypeError. Null event clocks mean omission; time never moves backward.
 */
export function advanceEmotionAnchor(
  previous: EmotionState,
  nowMs: number,
  options: EmotionClockStep,
  settings?: unknown,
  engineKey?: EmotionEngineKey | null,
): EmotionState {
  if (previous.version !== 3 || (engineKey != null && engineKey.rule !== 3)) {
    throw new TypeError('invalid_emotion_anchor_rule');
  }
  const step = checkedClockStep(options);
  const selected = emotionSettingsOf(settings);
  const updatedAtMs = Math.max(previous.updatedAtMs, requireFiniteNumber(nowMs, 'nowMs'));
  const elapsedHours = (updatedAtMs - previous.updatedAtMs) / 3_600_000;
  const frustration = clockFrustration(previous.frustration, elapsedHours, step.hungerHours, selected);
  const drives = {} as DriveValues;
  for (const drive of DRIVE_NAMES) {
    drives[drive] = clamp(previous.neural.driveBaseline[drive] + frustration[drive] * FRUSTRATION_TO_DRIVE, 0, 1);
  }

  // An anchor has no judgment: only time, metabolism and visible drives are replaced.
  return {
    ...structuredClone(previous),
    updatedAtMs,
    frustration,
    drives,
    ...(step.eventClockMs == null ? {} : {eventClockMs: step.eventClockMs}),
  };
}

/**
 * Applies one complete accepted event with separate hunger hours and supplied local-day context.
 * nowMs and optional eventClockMs are finite milliseconds, including negative or fractional values;
 * updatedAtMs never decreases. Omitting eventClockMs writes no such member. Only a null/omitted engine key inherits
 * the previous identity; an explicit rule-two key clears engine metadata. Invalid numeric input throws TypeError;
 * existing candidate/settings/neural errors propagate. Neither input state nor candidate is modified.
 * An omitted/null event source clears the third-rule pointer because the event has no attributable source.
 * An omitted relation input selects legacy core accumulation; scene callers must pass a pair or explicit null.
 * Keep the event calculation equivalent to advanceEmotion when hunger hours equal elapsed hours.
 * Only numeric values are equivalent; omitted-key identity behavior intentionally differs.
 */
export function advanceEmotionWithClock(
  previous: EmotionState,
  candidate: EmotionDelta,
  nowMs: number,
  options: EmotionClockStep,
  settings?: unknown,
  engineKey?: EmotionEngineKey | null,
  baselineElasticity?: number | null,
  constants?: EmotionRuleConstants | null,
  eventSource?: EmotionEventSource | null,
  relationInput?: EmotionRelationInput | null,
): EmotionState {
  const step = checkedClockStep(options);
  const delta = validateEmotionDelta(candidate);
  delta.context.timeOfDay = step.timeOfDay;
  const selected = emotionSettingsOf(settings);
  const requestedNowMs = requireFiniteNumber(nowMs, 'nowMs');
  const updatedAtMs = Math.max(previous.updatedAtMs, requestedNowMs);
  const elapsedHours = Math.max(0, updatedAtMs - previous.updatedAtMs) / 3_600_000;
  const metabolized = clockFrustration(previous.frustration, elapsedHours, step.hungerHours, selected);

  const frustration = {} as DriveValues;
  let beforeEventTotal = 0;
  for (const drive of DRIVE_NAMES) {
    const current = metabolized[drive];
    beforeEventTotal += current;
    frustration[drive] = clamp(
      (current + (delta.frustrationDelta[drive] ?? 0)) * selected.eventRetainedFraction,
      0,
      5,
    );
  }

  const drives = {} as DriveValues;
  for (const drive of DRIVE_NAMES) {
    drives[drive] = clamp(previous.neural.driveBaseline[drive] + frustration[drive] * FRUSTRATION_TO_DRIVE, 0, 1);
  }

  const stableRelations = accumulateStableRelations(
    previous.stableRelations,
    delta.stableRelationDelta,
    selected.stableRelationRate,
  );

  const total = Object.values(frustration).reduce((sum, value) => sum + value, 0);
  const reward = clamp(beforeEventTotal - total, -1, 1);
  if ((engineKey?.rule ?? previous.version) === 3) {
    return advanceRuleThree({
      previous,
      delta,
      updatedAtMs,
      frustration,
      drives,
      stableRelations,
      reward,
      selected,
      engine: engineKey ?? previous.engine,
      baselineElasticity,
      constants,
      eventClockMs: step.eventClockMs,
      eventSource,
      relationInput,
    });
  }
  const synced = structuredClone(previous.neural);
  synced.frustration = total;
  const learned = neuralStep(
    synced,
    neuralContext(delta.context, stableRelations),
    reward,
    delta.driveSatisfaction,
    drives,
  );
  const noisy = neuralThermodynamic(
    learned.state,
    learned.signals,
    total,
    selected.temperatureCoefficient,
    selected.temperatureFloor,
  );

  let version = previous.version;
  let engine = previous.engine;
  if (engineKey != null) {
    version = engineKey.rule;
    if (engineKey.rule === 3) {
      engine = engineKey;
    } else {
      engine = undefined;
    }
  }

  return {
    version,
    updatedAtMs,
    criticContextAtMs: updatedAtMs,
    frustration,
    drives,
    criticContext: {...delta.context},
    behavioralSignals: noisy.signals as BehaviorSignals,
    stableRelations,
    neural: noisy.state,
    lastReward: reward,
    ...(engine === undefined ? {} : {engine}),
    ...(step.eventClockMs == null ? {} : {eventClockMs: step.eventClockMs}),
  };
}

/**
 * Projects a state at finite milliseconds with separate hunger hours and supplied context, without another event.
 * Version, engine, eventClockMs and persisted neural/RNG state are retained. Numeric input errors throw TypeError;
 * existing settings/neural errors propagate. The freshness window and accepted-signal freeze remain historical.
 * A non-null eventClockMs option is rejected with TypeError; only accepted events may replace that metadata.
 */
export function emotionAtWithClock(
  previous: EmotionState,
  nowMs: number,
  options: EmotionClockProjection,
  settings?: unknown,
): EmotionState {
  const step = checkedClockStep(options);
  if (step.eventClockMs != null) throw new TypeError('invalid_emotion_projection_event_clock');
  const selected = emotionSettingsOf(settings);
  const updatedAtMs = Math.max(previous.updatedAtMs, requireFiniteNumber(nowMs, 'nowMs'));
  const hours = (updatedAtMs - previous.updatedAtMs) / 3_600_000;
  const criticContextAtMs = previous.criticContextAtMs ?? previous.updatedAtMs;
  const fresh = updatedAtMs - criticContextAtMs < CRITIC_CONTEXT_FRESH_MS;
  const criticContext = {...(fresh ? previous.criticContext : STALE_CONTEXT), timeOfDay: step.timeOfDay};
  const frustration = clockFrustration(previous.frustration, hours, step.hungerHours, selected);
  const drives = {} as DriveValues;
  for (const drive of DRIVE_NAMES) {
    drives[drive] = clamp(previous.neural.driveBaseline[drive] + frustration[drive] * FRUSTRATION_TO_DRIVE, 0, 1);
  }

  if ((previous.neural.interactionCount > 0 && fresh)
    || (previous.neural.interactionCount === 0 && hours < MIN_METABOLISM_HOURS)) {
    return {
      ...structuredClone(previous),
      updatedAtMs: hours < MIN_METABOLISM_HOURS ? previous.updatedAtMs : updatedAtMs,
      criticContext,
      criticContextAtMs,
      frustration,
      drives,
    };
  }

  // Projection may evaluate a clone, but must never advance persisted recurrent or random state.
  const forward = neuralForward(previous.neural, neuralContext(criticContext, previous.stableRelations), drives);
  const noisy = neuralThermodynamic(
    forward.state,
    forward.signals,
    Object.values(frustration).reduce((sum, value) => sum + value, 0),
    selected.temperatureCoefficient,
    selected.temperatureFloor,
  );
  return {
    ...structuredClone(previous),
    updatedAtMs,
    criticContextAtMs,
    criticContext,
    frustration,
    drives,
    behavioralSignals: noisy.signals as BehaviorSignals,
  };
}

/** Checks version 2 or 3 numeric and neural shape, preserving opaque metadata; existing shape errors propagate. */
export function validateEmotionState(value: unknown): EmotionState {
  const input = requireRecord(value, 'emotionState');
  if (input.version !== 2 && input.version !== 3) throw new Error('invalid_emotion_state_version');
  const thirdRule = input.version === 3 ? ruleThreeMembers(input) : {};
  if (input.version === 3) checkedRelationEma(input.relationEma);
  if (input.version === 3 && !Object.hasOwn(input, 'lastEvent')) {
    throw new Error('invalid_emotion_state_range');
  }
  if (input.version === 3 && input.lastEvent !== null) {
    const pointer = input.lastEvent;
    if (pointer === undefined || typeof pointer !== 'object' || Array.isArray(pointer)
      || Reflect.ownKeys(pointer).length !== 2 || !Object.hasOwn(pointer, 'sourceId')
      || !Object.hasOwn(pointer, 'revision')) {
      throw new Error('invalid_emotion_state_range');
    }
    const event = pointer as Record<string, unknown>;
    if (typeof event.sourceId !== 'string' || event.sourceId.length < 1 || event.sourceId.length > 200
      || !Number.isSafeInteger(event.revision) || (event.revision as number) < 1) {
      throw new Error('invalid_emotion_state_range');
    }
  }
  const checked = (source: unknown, keys: readonly string[], minimum: number, maximum: number) => {
    const record = requireRecord(source, 'emotionState.fields');
    return Object.fromEntries(keys.map(key => {
      const number = requireFiniteNumber(record[key], `emotionState.${key}`);
      if (number < minimum || number > maximum) throw new Error('invalid_emotion_state_range');
      return [key, number];
    }));
  };

  const context = {
    ...checked(input.criticContext, Object.keys(DEFAULT_CONTEXT).filter(key => key !== 'userEmotion'), 0, 1),
    ...checked(input.criticContext, ['userEmotion'], -1, 1),
  } as unknown as CriticContext;
  const relations = {
    ...checked(input.stableRelations, ['depth', 'trust'], 0, 1),
    ...checked(input.stableRelations, ['valence'], -1, 1),
  } as unknown as StableRelations;
  const lastReward = requireFiniteNumber(input.lastReward, 'emotionState.lastReward');
  if (Math.abs(lastReward) > 1) throw new Error('invalid_emotion_state_reward');
  const updatedAtMs = requireFiniteNumber(input.updatedAtMs, 'emotionState.updatedAtMs');
  const criticContextAtMs = input.criticContextAtMs === undefined
    ? updatedAtMs : requireFiniteNumber(input.criticContextAtMs, 'emotionState.criticContextAtMs');
  if (criticContextAtMs > updatedAtMs) throw new Error('invalid_emotion_state_context_time');

  return {
    version: input.version,
    updatedAtMs,
    criticContextAtMs,
    frustration: checked(input.frustration, DRIVE_NAMES, 0, 5) as DriveValues,
    drives: checked(input.drives, DRIVE_NAMES, 0, 1) as DriveValues,
    criticContext: context,
    behavioralSignals: checked(input.behavioralSignals, BEHAVIOR_SIGNAL_NAMES, 0, 1) as BehaviorSignals,
    stableRelations: relations,
    neural: validateNeuralState(input.neural),
    lastReward,
    ...Object.fromEntries(STORED_EMOTION_STATE_MEMBERS
      .filter(member => Object.hasOwn(input, member) && input[member] !== undefined)
      .map(member => [member, input[member]])),
    ...thirdRule,
  };
}

/** Numeric current affect only; no episode text or hidden rationale is emitted. */
export function emotionSummary(state: EmotionState) {
  const criticContextAtMs=state.neural.interactionCount===0?null:state.criticContextAtMs??state.updatedAtMs;
  const criticContextBasis=criticContextAtMs===null?'unobserved'
    :state.updatedAtMs-criticContextAtMs>=CRITIC_CONTEXT_FRESH_MS?'stale_baseline':'recent_observation';
  return {version:state.version,updatedAtMs:state.updatedAtMs,frustration:{...state.frustration},
    drives:{...state.drives},criticContext:{...state.criticContext},criticContextAtMs,criticContextBasis,
    behavioralSignals:{...state.behavioralSignals},
    stableRelations:{...state.stableRelations},lastReward:state.lastReward,
    learning:{interactionCount:state.neural.interactionCount,phaseTransition:state.neural.lastPhaseTransition}};
}

/** Numeric current affect only; no episode text or hidden rationale is emitted. */
export function emotionContext(state: EmotionState): string {
  const line = (label: string, values: object) =>
    `${label}: ${Object.entries(values)
      .map(([key, value]) => `${key}=${value.toFixed(3)}`)
      .join(", ")}`;

  return [
    "[XLDB current emotion]",
    line("drives", state.drives),
    line("frustration", state.frustration),
    line("signals", state.behavioralSignals),
    line("stableRelations", state.stableRelations),
  ].join("\n");
}
