import type { EmotionState } from '../../emotion/openher.ts';
import type { Scope } from '../../memory/access.ts';
import type { TavernWorldSnapshot } from './projection.ts';
import { CODEC_LIMITS, MIN_ACTION_CONFIDENCE } from './types.ts';

/** Addressed-inbox utility points. 暫定, 實驗後由主控定. */
export const W_ADDRESSED = 60;

/** Resumable interrupted-item utility points. 暫定, 實驗後由主控定. */
export const W_INTERRUPTED = 50;

/** Unserved respond opportunity utility points. 暫定, 實驗後由主控定. */
export const W_RESPOND = 40;

/** Unit frustration-proxy utility points. 暫定, 實驗後由主控定. */
export const W_AROUSAL = 10;

/** Unit directional-relation utility points. 暫定, 實驗後由主控定. */
export const W_RELATION = 5;

/** Unit legal-candidate priority utility points. 暫定, 實驗後由主控定. */
export const W_CANDIDATE = 20;

/** Unit recent-dispatch utility penalty. 暫定, 實驗後由主控定. */
export const W_RECENT = 15;

/** Unit repeated-pair utility penalty. 暫定, 實驗後由主控定. */
export const W_PAIR = 10;

/** Close at or below these utility points, except for reserved seats. 暫定, 實驗後由主控定. */
export const CLOSE_UTILITY_THRESHOLD = 0;

/** Fixed policy: formal dispatches per turn, regardless of emitted item count. */
export const MAX_TURN_BEATS = 8;

/** Fixed policy: formal dispatches per respond actor per turn. */
export const MAX_RESPOND_BEATS = 3;

/** Fixed policy: formal dispatches per react actor per turn. */
export const MAX_REACT_BEATS = 2;

/** Fixed policy: each respond contributes this many seats to the turn's total ceiling. */
export const RESPOND_SEAT_FACTOR = 2;

/** Soft turn budget in milliseconds from player arrival, including render. Fixed policy. */
export const SOFT_TURN_MS = 90_000;

/** Hard turn budget in milliseconds from player arrival, including render. Fixed policy. */
export const HARD_TURN_MS = 120_000;

/** Render reserve in milliseconds without valid matching successes. Fixed policy. */
export const DEFAULT_RENDER_RESERVE_MS = 20_000;

/** Cold-start beat estimate in milliseconds. 暫定, 實驗後由主控定. */
export const DEFAULT_BEAT_P90_MS = 10_000;

/** Successful samples retained per host/configuration and stage. 暫定, 實驗後由主控定. */
export const LATENCY_WINDOW_SIZE = 20;

/** Recent dispatches inspected for reciprocal pair pressure. 暫定, 實驗後由主控定. */
export const PAIR_WINDOW_SIZE = 3;

/** The upstream frustration domain is [0, 5]; this is a pressure proxy, not measured arousal. */
export const MAX_OPENHER_FRUSTRATION = 5;

const FRUSTRATION_DRIVES = ['connection', 'novelty', 'expression', 'safety', 'play'] as const;
// Fixed policy: nearest-rank quantiles, not fitted weights or trimmed latency estimates.
const RENDER_PERCENTILE = 0.5;
const BEAT_PERCENTILE = 0.9;
// Fixed policy: all correctable errors share one retry of the same formal dispatch.
const MAX_BEAT_RETRIES = 1;

/** Only the projection's scope and explicit ordered presence are read; prose and roster are not consulted. */
export type SchedulerPresence = Pick<TavernWorldSnapshot, 'scope' | 'presenceKnown' | 'presentIds'>;

/** Source-checked structural targeting; optional null fields mean omission. Confidence is finite in [0, 1]. */
export interface TavernRosterInput {
  projection: SchedulerPresence;
  npcIds: readonly string[];
  directorEnabled: boolean;
  namedActorIds?: readonly string[] | null;
  directActorId?: string | null;
  inferredAddressees?: readonly { actorId: string; confidence: number }[] | null;
  perceivingActorIds?: readonly string[] | null;
  candidateActorIds?: readonly string[] | null;
}

/** Detached, disjoint turn groups in Presence order; absent respondents remain unserved after later exits. */
export interface TavernScheduleRoster {
  scope: Scope;
  directorEnabled: boolean;
  respondIds: readonly string[];
  reactIds: readonly string[];
}

/**
 * Numeric/boolean signals already checked for knowledge access; OpenHer is the fixed turn-start snapshot.
 * addressed, interrupted and relationToPrevious belong to the current selection, not the initial turn.
 * The engine refreshes them from the unconsumed inbox, service history and optional directional relations.
 */
export interface TavernActorSignals {
  actorId: string;
  addressed: boolean;
  interrupted: boolean;
  openHerStart?: Pick<EmotionState, 'frustration'> | null;
  relationToPrevious?: { targetId: string; depth: number; valence: number } | null;
  /** Authorized directional snapshots keyed by target; null means the single supplied relation above. */
  relations?: readonly { targetId: string; depth: number; valence: number }[] | null;
  candidatePriority?: number | null;
}

/** One formal dispatch, even for empty, action-only or Unknown output; retry never adds another record. */
export interface TavernDispatch {
  actorId: string;
  addressedActorIds?: readonly string[] | null;
  hasSpoken?: boolean | null;
  hasActed?: boolean | null;
}

/** Pure selection input; history is this turn only and contains at most eight formal dispatches. */
export interface TavernScheduleInput {
  roster: TavernScheduleRoster;
  projection: SchedulerPresence;
  actors: readonly TavernActorSignals[];
  dispatches: readonly TavernDispatch[];
  budget: TavernBudgetSnapshot;
}

/** Protocol reasons only; the host owns wording and the turn-deadline Abort transition. */
export type TavernCloseReason =
  | 'turn_deadline' | 'beat_deadline' | 'beat_in_flight' | 'total_limit' | 'presence_unknown'
  | 'no_candidates' | 'actor_limits' | 'solo_complete' | 'consecutive_guard'
  | 'reserved_respond_unavailable' | 'time_budget' | 'low_utility';

/** Unitless finite score, with missing snapshot recorded separately from a valid all-zero snapshot. */
export interface TavernActorScore {
  actorId: string;
  utility: number;
  missingEmotion: boolean;
}

/** One next actor or an explained Close; never a batch, promise, state write or model call. */
export type TavernScheduleDecision = {
  unservedRespondIds: readonly string[];
  scores: readonly TavernActorScore[];
  totalBeatLimit: number;
} & (
  | { kind: 'Beat'; actorId: string; beatIndex: number; maxItems: number; scheduledActorCount: number }
  | { kind: 'Close'; reason: TavernCloseReason }
);

/** Oldest-to-newest latency observation, in milliseconds, keyed to the same host and effective settings. */
export interface TavernLatencySample {
  hostId: string;
  configurationId: string;
  outcome: 'success' | 'failed' | 'cancelled';
  durationMs: number;
}

/** Monotonic millisecond clock and arrival origin; null sample lists mean no observations. */
export interface TavernBudgetInput {
  startedAtMs: number;
  now: () => number;
  hostId: string;
  configurationId: string;
  /** Population-specific effective settings; null/omission uses configurationId. IDs contain no secrets. */
  renderConfigurationId?: string | null;
  beatConfigurationId?: string | null;
  renderSamples?: readonly TavernLatencySample[] | null;
  beatSamples?: readonly TavernLatencySample[] | null;
}

/** Millisecond deadlines remain tied to arrival; activeBeatIndex is null when no request may be running. */
export interface TavernBudgetSnapshot {
  startedAtMs: number;
  nowMs: number;
  renderReserveMs: number;
  beatP90Ms: number;
  beatSoftDeadlineMs: number;
  beatHardDeadlineMs: number;
  turnHardDeadlineMs: number;
  activeBeatIndex: number | null;
}

/** Opaque request lease; retries replace the lease but keep its signal, beat index and hard deadline. */
export interface TavernBeatLease {
  beatIndex: number;
  attempt: number;
  deadlineMs: number;
  signal: AbortSignal;
}

/**
 * Single-flight bookkeeping only. The engine must wake at the returned deadline and call snapshot().
 * That aborts an outstanding lease; finishBeat also rejects late replies without waiting for that wakeup.
 * No timers, runner, retry prompts or render calls are installed here. Invalid inputs/getters/clocks throw.
 */
export interface TavernTurnBudget {
  snapshot(): TavernBudgetSnapshot;
  beginBeat(beatIndex: number): TavernBeatLease | null;
  retryBeat(lease: TavernBeatLease): TavernBeatLease | null;
  finishBeat(lease: TavernBeatLease, outcome: TavernLatencySample['outcome']): boolean;
}

function requireNumber(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError('invalid_scheduler_number');
  }
  return value;
}

function requireBoolean(value: boolean): boolean {
  if (typeof value !== 'boolean') throw new TypeError('invalid_scheduler_boolean');
  return value;
}

function requireId(value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('invalid_scheduler_id');
  return value;
}

function copyIds(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new TypeError('invalid_scheduler_ids');
  return values.map(requireId);
}

function copyScope(scope: Scope): Scope {
  const { worldId, sessionId, branchId, characterId } = scope;
  return {
    worldId: requireId(worldId),
    sessionId: requireId(sessionId),
    branchId: requireId(branchId),
    characterId: requireId(characterId),
  };
}

function readPresence(projection: SchedulerPresence) {
  const { scope, presenceKnown, presentIds } = projection;
  return {
    scope: copyScope(scope),
    known: requireBoolean(presenceKnown),
    ids: [...new Set(copyIds(presentIds))],
  };
}

/**
 * Builds groups from validated IDs in projected Presence order, in O(all supplied IDs) work.
 * Explicit names/direct targeting take precedence even when their targets are absent; no inferred fallback.
 * Unknown presence produces empty groups. Invalid values or getters throw without changing any input.
 */
export function buildTavernScheduleRoster(input: TavernRosterInput): TavernScheduleRoster {
  const {
    projection, npcIds, directorEnabled, namedActorIds, directActorId,
    inferredAddressees, perceivingActorIds, candidateActorIds,
  } = input;
  const presence = readPresence(projection);
  const enabled = requireBoolean(directorEnabled);
  const npcs = new Set(copyIds(npcIds));
  const named = new Set(copyIds(namedActorIds ?? []));
  if (directActorId != null) named.add(requireId(directActorId));
  const inferred = new Set<string>();

  for (const addressee of inferredAddressees ?? []) {
    const { actorId, confidence } = addressee;
    requireId(actorId);
    requireNumber(confidence, 0, 1);
    // Shared threshold initial value: 暫定, 實驗後由主控定.
    if (confidence >= MIN_ACTION_CONFIDENCE) inferred.add(actorId);
  }

  const addressed = named.size > 0 ? named : inferred;
  const perceiving = new Set(copyIds(perceivingActorIds ?? []));
  const candidates = new Set(enabled ? copyIds(candidateActorIds ?? []) : []);
  const respondIds: string[] = [];
  const reactIds: string[] = [];
  for (const actorId of presence.known ? presence.ids : []) {
    if (!npcs.has(actorId)) continue;
    if (addressed.has(actorId)) {
      respondIds.push(actorId);
    } else if (enabled && (perceiving.has(actorId) || candidates.has(actorId))) {
      reactIds.push(actorId);
    }
  }
  return { scope: presence.scope, directorEnabled: enabled, respondIds, reactIds };
}

/**
 * Returns max of the five finite frustration values divided by five, in [0, 1], in constant work.
 * Missing/null snapshot returns zero; callers record missingness separately. Malformed snapshots/getters throw.
 * Only frustration is accessed; no other emotion field is copied, interpreted, learned or mutated.
 */
export function openHerArousalProxy(state?: Pick<EmotionState, 'frustration'> | null): number {
  if (state == null) return 0;
  const frustration = state.frustration;
  let maximum = 0;
  for (const drive of FRUSTRATION_DRIVES) {
    const value = requireNumber(frustration[drive], 0, MAX_OPENHER_FRUSTRATION);
    maximum = Math.max(maximum, value);
  }
  return maximum / MAX_OPENHER_FRUSTRATION;
}

interface IndexedDispatch {
  actorId: string;
  addressedActorIds: ReadonlySet<string>;
  hasSpoken: boolean;
  hasActed: boolean;
}

function copyDispatches(dispatches: readonly TavernDispatch[]): IndexedDispatch[] {
  if (!Array.isArray(dispatches) || dispatches.length > MAX_TURN_BEATS) {
    throw new TypeError('invalid_scheduler_history');
  }
  return dispatches.map(dispatch => {
    const { actorId, addressedActorIds, hasSpoken, hasActed } = dispatch;
    return {
      actorId: requireId(actorId),
      // One membership index per dispatch avoids rescanning a large broadcast list for every candidate.
      addressedActorIds: new Set(copyIds(addressedActorIds ?? [])),
      hasSpoken: hasSpoken == null ? false : requireBoolean(hasSpoken),
      hasActed: hasActed == null ? false : requireBoolean(hasActed),
    };
  });
}

function actorScore(
  actorId: string,
  signal: TavernActorSignals | undefined,
  unserved: ReadonlySet<string>,
  history: readonly IndexedDispatch[],
  directorEnabled: boolean,
): TavernActorScore {
  const {
    addressed = false, interrupted = false, openHerStart, relationToPrevious, candidatePriority,
  } = signal ?? {};
  const arousal = openHerArousalProxy(openHerStart);
  const candidate = directorEnabled ? requireNumber(candidatePriority ?? 0, 0, 1) : 0;
  const previousActorId = history.at(-1)?.actorId;
  let relation = 0;
  if (relationToPrevious != null) {
    const { targetId, depth, valence } = relationToPrevious;
    requireId(targetId);
    requireNumber(depth, 0, 1);
    requireNumber(valence, -1, 1);
    if (targetId === previousActorId) relation = (depth + Math.abs(valence)) / 2;
  }

  const lastIndex = history.findLastIndex(dispatch => dispatch.actorId === actorId);
  const recent = lastIndex < 0 ? 0 : 1 / (1 + history.length - 1 - lastIndex);
  let pairCount = 0;
  for (const dispatch of history.slice(-PAIR_WINDOW_SIZE)) {
    const targets = dispatch.addressedActorIds;
    const forward = dispatch.actorId === actorId && previousActorId != null && targets.has(previousActorId);
    const reverse = dispatch.actorId === previousActorId && targets.has(actorId);
    if (forward || reverse) pairCount++;
  }
  const pair = Math.min(1, pairCount / PAIR_WINDOW_SIZE);
  const utility = W_ADDRESSED * Number(requireBoolean(addressed))
    + W_INTERRUPTED * Number(requireBoolean(interrupted))
    + W_RESPOND * Number(unserved.has(actorId))
    + W_AROUSAL * arousal
    + W_RELATION * relation
    + W_CANDIDATE * candidate
    - W_RECENT * recent
    - W_PAIR * pair;
  requireNumber(utility, -Number.MAX_VALUE, Number.MAX_VALUE);
  return { actorId, utility, missingEmotion: openHerStart == null };
}

function readBudget(snapshot: TavernBudgetSnapshot): TavernBudgetSnapshot {
  const {
    startedAtMs, nowMs, renderReserveMs, beatP90Ms, beatSoftDeadlineMs,
    beatHardDeadlineMs, turnHardDeadlineMs, activeBeatIndex,
  } = snapshot;
  requireNumber(startedAtMs, 0, Number.MAX_SAFE_INTEGER - HARD_TURN_MS);
  requireNumber(nowMs, startedAtMs, Number.MAX_SAFE_INTEGER);
  requireNumber(renderReserveMs, 0, Number.MAX_SAFE_INTEGER);
  requireNumber(beatP90Ms, 0, Number.MAX_SAFE_INTEGER);
  if (beatSoftDeadlineMs !== startedAtMs + SOFT_TURN_MS - renderReserveMs
    || beatHardDeadlineMs !== startedAtMs + HARD_TURN_MS - renderReserveMs
    || turnHardDeadlineMs !== startedAtMs + HARD_TURN_MS) {
    throw new TypeError('invalid_scheduler_deadline');
  }
  if (activeBeatIndex != null && (!Number.isInteger(activeBeatIndex)
    || activeBeatIndex < 1 || activeBeatIndex > MAX_TURN_BEATS)) {
    throw new TypeError('invalid_scheduler_beat_index');
  }
  return {
    startedAtMs, nowMs, renderReserveMs, beatP90Ms, beatSoftDeadlineMs,
    beatHardDeadlineMs, turnHardDeadlineMs, activeBeatIndex: activeBeatIndex ?? null,
  };
}

/**
 * Selects one actor without writes, in O(presence + signals + group IDs + bounded turn history) work.
 * Hard guards precede utility. Reserved opportunities survive low utility, never hard limits/deadlines.
 * Invalid structural/numeric input or a getter throws before any dispatch; valid unsatisfiable input returns Close.
 */
export function selectNextTavernBeat(input: TavernScheduleInput): TavernScheduleDecision {
  const { roster, projection, actors, dispatches, budget } = input;
  const { scope, directorEnabled, respondIds, reactIds } = roster;
  const rosterScope = copyScope(scope);
  const presence = readPresence(projection);
  if (JSON.stringify(rosterScope) !== JSON.stringify(presence.scope)) {
    throw new TypeError('scheduler_scope_mismatch');
  }
  const enabled = requireBoolean(directorEnabled);
  const respond = new Set(copyIds(respondIds));
  const react = new Set(copyIds(reactIds));
  if ([...react].some(actorId => respond.has(actorId))) throw new TypeError('scheduler_groups_overlap');
  const history = copyDispatches(dispatches);
  const counts = new Map<string, number>();
  for (const dispatch of history) counts.set(dispatch.actorId, (counts.get(dispatch.actorId) ?? 0) + 1);
  const unservedRespondIds = [...respond].filter(actorId => !counts.has(actorId));
  const unserved = new Set(unservedRespondIds);
  const totalBeatLimit = Math.min(MAX_TURN_BEATS, RESPOND_SEAT_FACTOR * respond.size + (enabled ? react.size : 0));
  const time = readBudget(budget);
  const scores: TavernActorScore[] = [];
  const close = (reason: TavernCloseReason): TavernScheduleDecision => ({
    kind: 'Close', reason, unservedRespondIds, totalBeatLimit, scores,
  });

  if (time.nowMs >= time.turnHardDeadlineMs) return close('turn_deadline');
  if (time.nowMs >= time.beatHardDeadlineMs) return close('beat_deadline');
  if (time.activeBeatIndex != null) return close('beat_in_flight');
  const remainingSeats = totalBeatLimit - history.length;
  if (remainingSeats <= 0) return close('total_limit');
  if (!presence.known) return close('presence_unknown');
  const presentCandidates = presence.ids.filter(actorId => respond.has(actorId) || (enabled && react.has(actorId)));
  if (presentCandidates.length === 0) return close('no_candidates');
  const belowLimit = presentCandidates.filter(actorId => (counts.get(actorId) ?? 0)
    < (respond.has(actorId) ? MAX_RESPOND_BEATS : MAX_REACT_BEATS));
  if (belowLimit.length === 0) return close('actor_limits');
  if (belowLimit.length === 1 && counts.has(belowLimit[0])) return close('solo_complete');
  const previousActorId = history.at(-1)?.actorId;
  let eligible = belowLimit.filter(actorId => actorId !== previousActorId);
  if (eligible.length === 0) return close('consecutive_guard');

  // Equality matters: using one seat for anybody else here would steal the last reserved opportunity.
  const reservedOnly = remainingSeats <= unserved.size;
  const timePressure = time.beatSoftDeadlineMs - time.nowMs < time.beatP90Ms;
  if (reservedOnly || timePressure) {
    eligible = eligible.filter(actorId => unserved.has(actorId));
    if (eligible.length === 0) return close(timePressure ? 'time_budget' : 'reserved_respond_unavailable');
  }
  const signals = new Map<string, TavernActorSignals>();
  for (const signal of actors) {
    const actorId = requireId(signal.actorId);
    if (signals.has(actorId)) throw new TypeError('duplicate_scheduler_actor');
    signals.set(actorId, signal);
  }
  for (const actorId of eligible) scores.push(actorScore(actorId, signals.get(actorId), unserved, history, enabled));

  let best: TavernActorScore | undefined;
  for (const score of scores) {
    // Iteration is Presence ordered; strict comparison preserves its tie order without a locale sort.
    if (best == null || score.utility > best.utility) best = score;
  }
  if (best == null) return close('no_candidates');
  if (best.utility <= CLOSE_UTILITY_THRESHOLD && !unserved.has(best.actorId)) {
    best = undefined;
    for (const score of scores) {
      if (unserved.has(score.actorId) && (best == null || score.utility > best.utility)) best = score;
    }
    if (best == null) return close(unserved.size > 0 ? 'reserved_respond_unavailable' : 'low_utility');
  }
  const soloFirst = history.length === 0 && presentCandidates.length === 1;
  return {
    kind: 'Beat',
    actorId: best.actorId,
    beatIndex: history.length + 1,
    maxItems: soloFirst ? CODEC_LIMITS.soloFirstItems : CODEC_LIMITS.items,
    scheduledActorCount: presentCandidates.length,
    unservedRespondIds,
    totalBeatLimit,
    scores,
  };
}

function successfulDurations(samples: readonly TavernLatencySample[], hostId: string, configurationId: string) {
  if (!Array.isArray(samples)) throw new TypeError('invalid_scheduler_samples');
  const durations: number[] = [];
  for (let index = samples.length - 1; index >= 0 && durations.length < LATENCY_WINDOW_SIZE; index--) {
    const sample = samples[index];
    const { hostId: sampleHost, configurationId: sampleConfiguration, outcome } = sample;
    if (sampleHost !== hostId || sampleConfiguration !== configurationId || outcome !== 'success') continue;
    const duration = sample.durationMs;
    // Slow successes remain in the population. Invalid observations are not fast successes.
    if (Number.isFinite(duration) && duration >= 0 && duration <= Number.MAX_SAFE_INTEGER) durations.push(duration);
  }
  return durations.reverse();
}

function percentile(durations: readonly number[], quantile: number, fallback: number): number {
  if (durations.length === 0) return fallback;
  const sorted = [...durations].sort((left, right) => left - right);
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

/**
 * Creates a detached single-flight budget, with a caller-owned monotonic millisecond clock.
 * Sample filtering is O(sample count); each later read uses at most twenty samples. No chat history is retained.
 * Clock/getter failure throws before mutation. Stale/overlapping/late leases return null or false, never reopen time.
 */
export function createTavernTurnBudget(input: TavernBudgetInput): TavernTurnBudget {
  const { startedAtMs, now, hostId, configurationId, renderSamples, beatSamples } = input;
  requireNumber(startedAtMs, 0, Number.MAX_SAFE_INTEGER - HARD_TURN_MS);
  requireId(hostId);
  requireId(configurationId);
  if (typeof now !== 'function') throw new TypeError('invalid_scheduler_clock');
  const renderConfigurationId = requireId(input.renderConfigurationId ?? configurationId);
  const beatConfigurationId = requireId(input.beatConfigurationId ?? configurationId);
  const renderDurations = successfulDurations(renderSamples ?? [], hostId, renderConfigurationId);
  const beatDurations = successfulDurations(beatSamples ?? [], hostId, beatConfigurationId);
  const renderReserveMs = percentile(renderDurations, RENDER_PERCENTILE, DEFAULT_RENDER_RESERVE_MS);
  const beatSoftDeadlineMs = startedAtMs + SOFT_TURN_MS - renderReserveMs;
  const beatHardDeadlineMs = startedAtMs + HARD_TURN_MS - renderReserveMs;
  const turnHardDeadlineMs = startedAtMs + HARD_TURN_MS;
  let lastNowMs = startedAtMs;
  let lastBeatIndex = 0;
  let active: { lease: TavernBeatLease; startedAtMs: number; controller: AbortController } | null = null;

  function readNow(): number {
    const current = requireNumber(now(), lastNowMs, Number.MAX_SAFE_INTEGER);
    lastNowMs = current;
    if (current >= beatHardDeadlineMs && active != null) {
      const expired = active;
      active = null;
      expired.controller.abort();
    }
    return current;
  }

  function snapshot(): TavernBudgetSnapshot {
    const nowMs = readNow();
    return {
      startedAtMs, nowMs, renderReserveMs,
      beatP90Ms: percentile(beatDurations, BEAT_PERCENTILE, DEFAULT_BEAT_P90_MS),
      beatSoftDeadlineMs, beatHardDeadlineMs, turnHardDeadlineMs,
      activeBeatIndex: active?.lease.beatIndex ?? null,
    };
  }

  function beginBeat(beatIndex: number): TavernBeatLease | null {
    if (!Number.isInteger(beatIndex) || beatIndex < 1 || beatIndex > MAX_TURN_BEATS) {
      throw new TypeError('invalid_scheduler_beat_index');
    }
    const nowMs = readNow();
    if (active != null || nowMs >= beatHardDeadlineMs || beatIndex !== lastBeatIndex + 1) return null;
    const controller = new AbortController();
    const lease = Object.freeze({ beatIndex, attempt: 0, deadlineMs: beatHardDeadlineMs, signal: controller.signal });
    active = { lease, startedAtMs: nowMs, controller };
    lastBeatIndex = beatIndex;
    return lease;
  }

  function retryBeat(lease: TavernBeatLease): TavernBeatLease | null {
    readNow();
    if (active == null || active.lease !== lease || lease.attempt >= MAX_BEAT_RETRIES) return null;
    const retried = Object.freeze({ ...lease, attempt: lease.attempt + 1 });
    active.lease = retried;
    return retried;
  }

  function finishBeat(lease: TavernBeatLease, outcome: TavernLatencySample['outcome']): boolean {
    if (outcome !== 'success' && outcome !== 'failed' && outcome !== 'cancelled') {
      throw new TypeError('invalid_scheduler_outcome');
    }
    const nowMs = readNow();
    if (active == null || active.lease !== lease) return false;
    const completed = active;
    active = null;
    if (outcome !== 'success') {
      completed.controller.abort();
      return false;
    }
    beatDurations.push(nowMs - completed.startedAtMs);
    if (beatDurations.length > LATENCY_WINDOW_SIZE) beatDurations.shift();
    return true;
  }

  return Object.freeze({ snapshot, beginBeat, retryBeat, finishBeat });
}
