import {STORY_CLOCK_MAX_MS} from '../scene/story-clock-types.ts';

// The user-defined twelve-hour cap applies to each ordinary step and separately to each jump, never to decay.
const HUNGER_INTERVAL_LIMIT_MS = 12 * 3_600_000;

/** One accepted source in final folded order; clockMs is a safe local story-clock millisecond value. */
export interface EmotionClockSource {
  sourceId: string;
  revision: number;
  clockMs: number;
  /** True iff a folded advance has cueKind !== null and deltaMs > 0, including estimated-basis explicit cues. */
  explicitAdvance: boolean;
}

/** One applied judgement at a source index; raw relation metadata is optional, with null equivalent to omission. */
export interface EmotionClockEvent {
  sourceIndex: number;
  relation?: unknown;
}

/** A source-indexed time step, with nonnegative decay and hunger durations measured in hours. */
export interface EmotionClockDuration {
  sourceIndex: number;
  elapsedHours: number;
  hungerHours: number;
}

/** Closed reasons for excluding a jump from hunger; an apart jump's capped remainder is not a diagnostic. */
export type OmittedJumpReason = 'together' | 'unstated' | 'no_member' | 'awaiting_judgement';

/** Recomputed, nonpersistent exclusion for one character/source revision; advanceMs is the positive net movement. */
export interface OmittedEmotionJump {
  sourceId: string;
  revision: number;
  characterId: string;
  advanceMs: number;
  reason: OmittedJumpReason;
}

/** Counts visited sources/events/anchors and resolved jumps, without timing measurements. */
export interface EmotionClockWork {
  sourceVisits: number;
  eventVisits: number;
  anchorVisits: number;
  jumpVisits: number;
}

/**
 * A single character's folded timeline. Events and anchor indices are strictly increasing, disjoint, zero-based.
 * Null/omitted readIndex selects the last source; future events are not evaluated. Null anchors mean none.
 * The earliest event or anchor establishes the origin; an earlier anchor includes later jumps in the first judgement.
 * The caller excludes actors without emotion before invoking this calculation; no actor predicate runs here.
 */
export interface EmotionClockInput {
  characterId: string;
  sources: readonly EmotionClockSource[];
  events: readonly EmotionClockEvent[];
  readIndex?: number | null;
  anchorIndices?: readonly number[] | null;
}

/**
 * Pure durations and diagnostics through the read index. No read member exists before a character's first step.
 * Work is O(sources + events + anchors), storage O(events + anchors + jumps); no history-size limit is imposed.
 */
export interface EmotionClockPlan {
  events: EmotionClockDuration[];
  anchors: EmotionClockDuration[];
  read?: EmotionClockDuration;
  diagnostics: OmittedEmotionJump[];
  work: EmotionClockWork;
}

function separationOf(relation: unknown): 'apart' | 'together' | 'unstated' | 'no_member' {
  if (relation === null || typeof relation !== 'object' || Array.isArray(relation)
    || !Object.hasOwn(relation, 'skipSeparation')) return 'no_member';

  const value = (relation as Record<string, unknown>).skipSeparation;
  return value === 'apart' || value === 'together' || value === 'unstated' ? value : 'no_member';
}

function checkedIndex(value: number, length: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) {
    throw new TypeError('invalid_emotion_source_index');
  }
  return value;
}

/**
 * Computes story-domain hunger hours through one read position without changing clocks or stored data.
 * Each event, anchor and read caps ordinary elapsed time (excluding jumps) at twelve hours; decay stays uncapped.
 * Positive explicit advances or net advances above twelve hours are jumps. Only strict apart judgements add
 * min(jump, twelve hours); reads and anchors defer those additions. The added jump credit is bounded by actual
 * forward movement since the previous judgement (or origin), minus ordinary hunger credited across that whole
 * interval, including intervening anchors and the current step. Anchors end a step without resetting this budget.
 * Backward clocks never reduce state time. Hunger removed by either cap adds no omitted-jump diagnostic.
 * Hunger is calculated in integer milliseconds before one conversion to hours, keeping the 3,600 ms gate exact.
 * Malformed clocks, identities or unordered positions throw TypeError. Input getters propagate unchanged.
 */
export function planEmotionClock(input: EmotionClockInput): EmotionClockPlan {
  const {sources, events, characterId} = input;
  if (typeof characterId !== 'string') throw new TypeError('invalid_emotion_character_id');
  const anchors = input.anchorIndices ?? [];
  const readIndex = input.readIndex == null ? sources.length - 1 : checkedIndex(input.readIndex, sources.length);
  const work: EmotionClockWork = {sourceVisits: 0, eventVisits: 0, anchorVisits: 0, jumpVisits: 0};
  const result: EmotionClockPlan = {events: [], anchors: [], diagnostics: [], work};
  let lastIndex = -1;
  for (const event of events) {
    const index = checkedIndex(event.sourceIndex, sources.length);
    if (index <= lastIndex) throw new TypeError('invalid_emotion_event_order');
    lastIndex = index;
    work.eventVisits += 1;
  }
  lastIndex = -1;
  for (const index of anchors) {
    checkedIndex(index, sources.length);
    if (index <= lastIndex) throw new TypeError('invalid_emotion_anchor_order');
    lastIndex = index;
    work.anchorVisits += 1;
  }

  let eventIndex = 0;
  let anchorIndex = 0;
  let stateClockMs: number | undefined;
  let judgementClockMs: number | undefined;
  let ordinarySinceJudgementMs = 0;
  let previousClockMs: number | undefined;
  let intervalJumpMs = 0;
  let pendingCapMs = 0;
  let pending: {source: EmotionClockSource; advanceMs: number}[] = [];

  const diagnose = (reason: OmittedJumpReason): void => {
    for (const jump of pending) {
      work.jumpVisits += 1;
      result.diagnostics.push({
        sourceId: jump.source.sourceId,
        revision: jump.source.revision,
        characterId,
        advanceMs: jump.advanceMs,
        reason,
      });
    }
  };

  // One forward source pass plus one final visit per pending jump; anchors never rescan pending history.
  for (let sourceIndex = 0; sourceIndex <= readIndex; sourceIndex++) {
    const source = sources[sourceIndex]!;
    work.sourceVisits += 1;
    const clockMs = source.clockMs;
    if (!Number.isSafeInteger(clockMs) || clockMs < 0 || clockMs > STORY_CLOCK_MAX_MS
      || typeof source.explicitAdvance !== 'boolean' || typeof source.sourceId !== 'string'
      || !Number.isSafeInteger(source.revision) || source.revision < 0) {
      throw new TypeError('invalid_emotion_clock_source');
    }
    const advanceMs = previousClockMs === undefined ? 0 : clockMs - previousClockMs;
    previousClockMs = clockMs;

    if (stateClockMs !== undefined && advanceMs > 0
      && (source.explicitAdvance || advanceMs > HUNGER_INTERVAL_LIMIT_MS)) {
      intervalJumpMs += advanceMs;
      pendingCapMs += Math.min(advanceMs, HUNGER_INTERVAL_LIMIT_MS);
      pending.push({source, advanceMs});
    }

    const event = events[eventIndex];
    const isEvent = event?.sourceIndex === sourceIndex;
    const isAnchor = anchors[anchorIndex] === sourceIndex;
    if (isEvent && isAnchor) throw new TypeError('invalid_emotion_overlapping_step');
    if (!isEvent && !isAnchor) continue;

    // The first applied source establishes the character's origin; earlier jumps belong to no state.
    stateClockMs ??= clockMs;
    judgementClockMs ??= stateClockMs;
    const elapsedMs = Math.max(0, clockMs - stateClockMs);
    const elapsedHours = elapsedMs / 3_600_000;
    const ordinaryMs = Math.min(Math.max(0, elapsedMs - intervalJumpMs), HUNGER_INTERVAL_LIMIT_MS);
    const answer = isEvent ? separationOf(event!.relation) : 'awaiting_judgement';
    ordinarySinceJudgementMs += ordinaryMs;
    // Corrected sources can retrace time. Anchors retain both the deferred jumps and ordinary credit already used.
    const judgementForwardMs = Math.max(0, clockMs - judgementClockMs);
    const jumpBudgetMs = Math.max(0, judgementForwardMs - ordinarySinceJudgementMs);
    const creditedJumpMs = answer === 'apart' ? Math.min(pendingCapMs, jumpBudgetMs) : 0;
    const hungerMs = ordinaryMs + creditedJumpMs;
    const hungerHours = hungerMs / 3_600_000;
    const duration = {sourceIndex, elapsedHours, hungerHours};
    stateClockMs = Math.max(stateClockMs, clockMs);
    intervalJumpMs = 0;

    if (isEvent) {
      result.events.push(duration);
      eventIndex += 1;
      if (answer !== 'apart') diagnose(answer);
      else work.jumpVisits += pending.length;
      pending = [];
      pendingCapMs = 0;
      judgementClockMs = stateClockMs;
      ordinarySinceJudgementMs = 0;
    } else {
      result.anchors.push(duration);
      anchorIndex += 1;
      // Only the time step ends here. Each deferred jump still belongs to the next judgement's answer.
    }
  }

  if (stateClockMs !== undefined) {
    const elapsedMs = Math.max(0, previousClockMs! - stateClockMs);
    const elapsedHours = elapsedMs / 3_600_000;
    const ordinaryMs = Math.min(Math.max(0, elapsedMs - intervalJumpMs), HUNGER_INTERVAL_LIMIT_MS);
    result.read = {
      sourceIndex: readIndex,
      elapsedHours,
      hungerHours: ordinaryMs / 3_600_000,
    };
    diagnose('awaiting_judgement');
  }
  return result;
}
