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

export interface EmotionDelta {
  context: CriticContext;
  frustrationDelta: Partial<DriveValues>;
  driveSatisfaction?: Partial<DriveValues>;
  stableRelationDelta?: Partial<StableRelations>;
}

export interface EmotionState {
  version: 2;
  updatedAtMs: number;
  /** Last accepted Critic observation; older saved states use updatedAtMs. */
  criticContextAtMs?: number;
  frustration: DriveValues;
  drives: DriveValues;
  criticContext: CriticContext;
  behavioralSignals: BehaviorSignals;
  stableRelations: StableRelations;
  neural: NeuralState;
  lastReward: number;
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

const MIN_METABOLISM_HOURS = 0.001;
// A single interaction's appraisal is no longer treated as the current scene
// after half a day. This is a product heuristic, not an empirically fitted rate.
const CRITIC_CONTEXT_FRESH_MS = 12 * 3_600_000;

// OpenHer sync_to_agent uses baseline + frustration * 0.15. The upstream
// baseline is seeded per persona; this bounded MVP takes a validated baseline
// from the owning character's explicit settings.
const FRUSTRATION_TO_DRIVE = 0.15;

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
    if (key === 'timeOfDay') continue;
    strictValue(context, key, key === 'userEmotion' ? -1 : 0, 1, 'emotionDelta.context');
  }
  // Older model templates can still send this field, but it never sets time.
  if (context.timeOfDay !== undefined) strictValue(context, 'timeOfDay', 0, 1, 'emotionDelta.context');
  for (const drive of DRIVE_NAMES) strictValue(frustration, drive, -3, 3, 'emotionDelta.frustrationDelta');
  if (candidate.driveSatisfaction !== undefined) {
    const satisfaction = requireRecord(candidate.driveSatisfaction, 'emotionDelta.driveSatisfaction');
    for (const drive of DRIVE_NAMES) if (satisfaction[drive] !== undefined) {
      strictValue(satisfaction, drive, 0, 0.3, 'emotionDelta.driveSatisfaction');
    }
  }
  if (candidate.stableRelationDelta !== undefined) {
    const relations = requireRecord(candidate.stableRelationDelta, 'emotionDelta.stableRelationDelta');
    for (const key of ['depth', 'trust', 'valence']) if (relations[key] !== undefined) {
      strictValue(relations, key, -1, 1, 'emotionDelta.stableRelationDelta');
    }
  }
  return validateEmotionDelta({
    ...candidate,
    context: { ...context, timeOfDay: timeOfDayAt(clockTimeMs, timeZone) },
  });
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

export function createEmotion(nowMs: number, settings?: unknown, identity = 'xldb-default'): EmotionState {
  const timestamp = requireFiniteNumber(nowMs, "nowMs");
  const selected = emotionSettingsOf(settings);
  const neural=createNeural(identitySeed(identity),{hebbianLr:selected.hebbianLearningRate,phaseThreshold:selected.phaseThreshold});
  if (!selected.randomizedBaseline) {
    neural.driveBaseline={...selected.driveBaseline};
    neural.driveState={...selected.driveBaseline};
  }
  return {
    version: 2,
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
  };
}

/** Read-time projection: elapsed time changes drives, never applies another event. */
export function emotionAt(previous: EmotionState, nowMs: number, settings?: unknown, timeZone: string | null = 'UTC'): EmotionState {
  const selected = emotionSettingsOf(settings);
  const updatedAtMs = Math.max(previous.updatedAtMs, requireFiniteNumber(nowMs, 'nowMs'));
  const hours = (updatedAtMs - previous.updatedAtMs) / 3_600_000;
  const criticContextAtMs = previous.criticContextAtMs ?? previous.updatedAtMs;
  const criticContext = updatedAtMs - criticContextAtMs >= CRITIC_CONTEXT_FRESH_MS
    ? { ...STALE_CONTEXT }
    : { ...previous.criticContext };
  criticContext.timeOfDay = timeOfDayAt(timeZone === null ? null : updatedAtMs, timeZone ?? 'UTC');
  if (hours < MIN_METABOLISM_HOURS) return { ...structuredClone(previous), criticContext, criticContextAtMs };
  const frustration = { ...previous.frustration };
  const drives = { ...previous.drives };
  for (const drive of DRIVE_NAMES) {
    const hunger = drive === 'connection' ? selected.connectionHungerPerHour : drive === 'novelty' ? selected.noveltyHungerPerHour : 0;
    frustration[drive] = clamp(previous.frustration[drive] * Math.exp(-selected.frustrationDecayPerHour * hours) + hunger * hours, 0, 5);
    drives[drive] = clamp(previous.drives[drive] + (frustration[drive] - previous.frustration[drive]) * FRUSTRATION_TO_DRIVE, 0, 1);
  }
  // Forward evaluation occurs on a clone. Discard its recurrent/RNG/history changes:
  // time-only reads cannot train or advance the persisted random trajectory.
  const forward=neuralForward(previous.neural,neuralContext(criticContext,previous.stableRelations),drives);
  const noisy=neuralThermodynamic(forward.state,forward.signals,Object.values(frustration).reduce((a,b)=>a+b,0),selected.temperatureCoefficient,selected.temperatureFloor);
  return { ...structuredClone(previous), updatedAtMs, criticContextAtMs, criticContext, frustration, drives,
    behavioralSignals: noisy.signals as BehaviorSignals };
}

export function advanceEmotion(
  previous: EmotionState,
  candidate: EmotionDelta,
  nowMs: number,
  settings?: unknown,
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

  const relationDelta = delta.stableRelationDelta ?? {};
  const stableRelations: StableRelations = {
    depth: clamp(
      previous.stableRelations.depth + (relationDelta.depth ?? 0) * selected.stableRelationRate,
      0,
      1,
    ),
    trust: clamp(
      previous.stableRelations.trust + (relationDelta.trust ?? 0) * selected.stableRelationRate,
      0,
      1,
    ),
    valence: clamp(
      previous.stableRelations.valence + (relationDelta.valence ?? 0) * selected.stableRelationRate,
      -1,
      1,
    ),
  };

  const total=Object.values(frustration).reduce((a,b)=>a+b,0);
  // Upstream reward is reduction in metabolism frustration, never a model's
  // direct weight update. One accepted event performs one full learning cycle.
  const reward=clamp(beforeEventTotal-total,-1,1);
  const synced=structuredClone(previous.neural);
  synced.frustration=total;
  const learned=neuralStep(synced,neuralContext(delta.context,stableRelations),reward,delta.driveSatisfaction,drives);
  const noisy=neuralThermodynamic(learned.state,learned.signals,total,selected.temperatureCoefficient,selected.temperatureFloor);

  return {
    version: 2,
    updatedAtMs,
    criticContextAtMs: updatedAtMs,
    frustration,
    drives: {...noisy.state.driveState} as DriveValues,
    criticContext: { ...delta.context },
    behavioralSignals: noisy.signals as BehaviorSignals,
    stableRelations,
    neural:noisy.state,
    lastReward:reward,
  };
}

/** Restored state is trusted only after full numeric and neural shape checks. */
export function validateEmotionState(value: unknown): EmotionState {
  const input=requireRecord(value,'emotionState');
  if(input.version!==2)throw new Error('invalid_emotion_state_version');
  const checked=(source:unknown,keys:readonly string[],min:number,max:number)=>{
    const record=requireRecord(source,'emotionState.fields');
    return Object.fromEntries(keys.map(key=>{
      const n=requireFiniteNumber(record[key],`emotionState.${key}`);
      if(n<min||n>max)throw new Error('invalid_emotion_state_range');
      return [key,n];
    }));
  };
  const context={...checked(input.criticContext,Object.keys(DEFAULT_CONTEXT).filter(key=>key!=='userEmotion'),0,1),
    ...checked(input.criticContext,['userEmotion'],-1,1)} as unknown as CriticContext;
  const relations={...checked(input.stableRelations,['depth','trust'],0,1),...checked(input.stableRelations,['valence'],-1,1)} as unknown as StableRelations;
  const lastReward=requireFiniteNumber(input.lastReward,'emotionState.lastReward');
  if(Math.abs(lastReward)>1)throw new Error('invalid_emotion_state_reward');
  const updatedAtMs=requireFiniteNumber(input.updatedAtMs,'emotionState.updatedAtMs');
  const criticContextAtMs=input.criticContextAtMs===undefined ? updatedAtMs
    : requireFiniteNumber(input.criticContextAtMs,'emotionState.criticContextAtMs');
  if (criticContextAtMs > updatedAtMs) throw new Error('invalid_emotion_state_context_time');
  return {version:2,updatedAtMs,criticContextAtMs,
    frustration:checked(input.frustration,DRIVE_NAMES,0,5) as DriveValues,
    drives:checked(input.drives,DRIVE_NAMES,0,1) as DriveValues,criticContext:context,
    behavioralSignals:checked(input.behavioralSignals,BEHAVIOR_SIGNAL_NAMES,0,1) as BehaviorSignals,
    stableRelations:relations,neural:validateNeuralState(input.neural),lastReward};
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
