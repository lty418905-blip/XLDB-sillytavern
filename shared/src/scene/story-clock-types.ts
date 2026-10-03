/**
 * Unified story clock: frozen type contract (slice SCT; DESIGN-behaviour-layer.md section 17; rulings 24, 24a, 42;
 * semantics finalized 2026-09-30 in the SCT semantics note r2, authoritative where this
 * summary is brief). Types and constants only, no logic. Implemented by SC0 (fold), SC1 (parser), SC2 (extraction),
 * SC3a (authority wiring), SC4 (corrections). Changing this file after SCT lands must be announced to the SC0, SC1,
 * SC2 and SC3a implementers and recorded in the slice note.
 *
 * Time model
 * - Floating local time: no zone, no daylight saving, proleptic Gregorian, every day 86_400_000 ms, years 1..9999.
 *   StoryClockMs counts ms from 0001-01-01T00:00:00.000, a safe integer in [0, STORY_CLOCK_MAX_MS]. It is not Unix
 *   time (offset STORY_CLOCK_UNIX_EPOCH_MS); never build it with Date.UTC for years 0..99.
 * - wall(a) = a mod 1 day; the calendar day of a starts at a - wall(a). Durations are ms unless a name ends in Minutes.
 *   Absent-by-design values are null, never undefined.
 * - Kinds (StoryClockKind): 'relative' (dateKnown=false; day 1 is the opening day; values on a synthetic timeline from
 *   syntheticAnchorMs, only differences matter, never shown as a date), 'month_day' (a year-less date placed in the
 *   non-leap referenceYear; the timeline runs on into later years; only month and day are shown), 'dated'.
 * - Slots: every wall time lies in one StoryClockTimeOfDay slot (timeOfDaySlotStartMinutes); rep(slot) is its
 *   representative time. Floating means timeOfDayKnown=false: the wall time is a stand-in (08:00, or a legacy anchor's
 *   wall time) and is never evidence.
 * - Day boundaries (ruling 42): every displayed day (day N, the date, day differences) rolls at 00:00, for every kind.
 *   The fold also uses a story day starting at storyDayStartMinutes (05:00), only for next_day_at (cue and correction
 *   op) and the slot order of a narrative set_time; it is never displayed or stored. From 00:00 to 04:59 the displayed
 *   day has rolled but the story day has not, so "the next day" said then is the displayed day's own morning.
 *
 * Initial state, the first applicable of: (1) an applied origin correction (basis 'correction'); (2) the origin stored
 * on sources[0] when its input is 'analysis' (basis 'explicit' if any item is explicit, else 'inferred' if any item
 * exists, else 'estimated'; an origin on any other source is ignored); (3) the legacy anchor iff sources[0] is 'legacy'
 * and legacyAnchor is non-null (basis 'legacy'); (4) the relative default: syntheticAnchorMs + 08:00, all flags false,
 * basis 'estimated'. For (1) and (2): wall time = time ?? rep(timeOfDay) ?? 08:00; timeOfDayKnown iff either is present;
 * timeOfDayInferred iff time is null and the timeOfDay item is 'inferred'. originAtMs is the origin instant and
 * dayOneStartMs the 00:00 of its day.
 *
 * Fold order per accepted source (ties by seq, then correctionId): P0 (opening only) initial state; P1 OOC corrections;
 * P2 own movement; P3 adoptions; P4 on the last source of turn t >= 1, the 'now' corrections of turn t. The per-source
 * state is taken after P4. A revoke is not an event: it drops every narrative set_date of its bound source and every
 * narrative relabel or year fill of the sources after it.
 *
 * Own movement (P2). 'analysis': cues in order, then the implicit estimate unless an applied cue moved the clock (wrote
 * an AdvanceRecord) or the category is time_skip and a cue was applied; a zero-movement application and a fold-stage
 * drop do not suppress it. 'degraded': nothing; a turn whose sources are all 'degraded' gets fallbackMinutes at its
 * player source (never turn 0). 'legacy': the +30 user step first (when 'user' and tavernRoleplay), then its effects.
 * 'pending': nothing.
 *
 * Cues never move backwards. advance: + value x unitLengthsMs[unit]. next_day_at: story day of atMs + days + T, plus
 * one day while not after atMs. set_time (slots ordered dawn..late_night within the story day): moves only to a later
 * slot or time of the same story day, or from night or late_night to the coming dawn or morning; anything else is
 * applied with no movement. set_date: the date-setting rule. Implicit: clamp by category; rest_night lands no earlier
 * than rep('morning') of its end day (timeOfDayInferred=true when pushed).
 *
 * Date-setting rule (narrative set_date: mode 'forward'; set_datetime op and full-date adoption: mode 'nearest';
 * year-less adoption: forward without bound), computed first and applied atomically; the first failing check names
 * the drop (value_out_of_range, date_not_narrative, date_partial, date_inference_revoked, date_ambiguous,
 * date_regression).
 * 1. A year-less 29 Feb is value_out_of_range; narrative=false is date_not_narrative.
 * 2. relative: a full date relabels; a year-less date is date_partial for a cue and relabels into referenceYear for a
 *    correction. month_day: a year-less date resolves by mode on the synthetic timeline; a full date first fills the
 *    current position's year (forward: the event's year Y if the current month-day is on or before the event's, else
 *    Y-1; nearest: among Y-1, Y, Y+1 the one putting the event nearest, ties later), then resolves as dated. dated: a
 *    full date is the target; a year-less date resolves by mode. A narrative set_date of a revoked source, and a
 *    narrative relabel or year fill after it, is date_inference_revoked. Forward: the first date on or after the
 *    current date; for a cue more than narrativeDateMaxForwardDays ahead is date_ambiguous; an earlier full date on a
 *    dated clock is date_regression; a later one is unbounded. Nearest: the nearest occurrence, ties later, unbounded.
 * 3. T = time ?? rep(timeOfDay) ?? null. Same target date (always for a relabel): T null keeps the time and flags; a cue
 *    with T re-anchors when floating, else moves forward to T when T is later that day and applies with no movement
 *    otherwise; a correction or adoption with T re-anchors with E = 0 when floating, else sets T (may move backwards).
 *    Different date: date + (T ?? 08:00), timeOfDayKnown iff T; T null opens a floating stretch anchored at the event.
 * 4. The movement (AdvanceRecord if non-zero: 'explicit' for a cue, 'correction' otherwise), then the relabel or fill.
 *
 * Relabel and year fill change labels, not story time: originAtMs, dayOneStartMs and every clock value so far shift by
 * S whole days so that the current position carries the target date or chosen year. Durations, wall times, day numbers
 * and memory ages do not change. Each one ending in a full date appends a StoryClockInferredOrigin whose date is the
 * event's date as stated (never re-shifted). A shift leaving the range drops the event (value_out_of_range).
 * clear_date makes the clock relative; a later relabel shifts the whole timeline, earlier dated stretches included.
 *
 * Time-of-day anchoring. A floating stretch starts at its anchor (the initial state, or the event that left the time of
 * day unknown); its evidence points are the anchor and each event in it that named a date without a time. A re-anchor
 * shifts every clock value recorded from the anchor on by one X that keeps every evidence point on its calendar day
 * (the anchor's movement record absorbs X; dayOneStartMs stays), then moves by E. Narrative next_day_at and rest_night
 * fix the day first: the earliest possible current day + days (rest_night: + 1) at T, with the smallest whole-minute
 * E >= (days - 1) days + estimatedNextDayAtMinutes (rest_night: its clamped minutes) that the window allows. Narrative
 * set_time (E = estimatedSetTimeMinutes) and a same-date set_date with a time (E = 0) take the X with
 * wall(atMs + E + X) = T. A correction that sets only a time or slot on the displayed day re-anchors with E = 0, the
 * current position counted as an evidence point, so the displayed day and every elapsed duration are kept. With no
 * such X a cue resolves as if not floating (basis 'estimated' for next_day_at, set_time and rest_night) and a
 * correction is a plain set.
 */

/** Version of the clock constant table (30-minute fallback, clamp ranges, representative times); bump on any change. */
export type StoryClockRuleVersion = number;
/** clockRule v1: part of every clock cache key and, from OH3 on, of the OpenHer engine version key. */
export const STORY_CLOCK_RULE_VERSION: StoryClockRuleVersion = 1;

/**
 * Names of the SC0 constants that belong to clockRule. Values live in SC0's STORY_CLOCK_RULE_V1 (typed by
 * StoryClockRuleConstants; v1 values in SEMANTICS.md section 1). Changing any value bumps STORY_CLOCK_RULE_VERSION.
 */
export const STORY_CLOCK_RULE_CONSTANT_NAMES = [
  'syntheticAnchorMs', 'referenceYear', 'defaultDayTime', 'timeOfDayRepresentativeTimes', 'elapsedClampMinutes',
  'fallbackMinutes', 'legacyUserStepMinutes', 'estimatedNextDayAtMinutes', 'estimatedSetTimeMinutes', 'unitLengthsMs',
  'narrativeDateMaxForwardDays', 'timeOfDaySlotStartMinutes', 'storyDayStartMinutes',
] as const;
/** One name of an SC0 rule constant. */
export type StoryClockRuleConstantName = (typeof STORY_CLOCK_RULE_CONSTANT_NAMES)[number];

/**
 * Typed shape of the clockRule table (SC0 exports STORY_CLOCK_RULE_V1); its keys equal STORY_CLOCK_RULE_CONSTANT_NAMES.
 * Table invariants SC0 asserts: slot starts strictly increase in STORY_CLOCK_TIMES_OF_DAY order within [0, 1440), each
 * representative time lies in its own slot, and storyDayStartMinutes equals the dawn slot start.
 */
export interface StoryClockRuleConstants {
  syntheticAnchorMs: StoryClockMs;
  referenceYear: number;
  defaultDayTime: StoryClockTime;
  timeOfDayRepresentativeTimes: Readonly<Record<StoryClockTimeOfDay, StoryClockTime>>;
  /** Minutes after 00:00 where each slot starts; a slot runs to the next start, late_night wraps past midnight to dawn. */
  timeOfDaySlotStartMinutes: Readonly<Record<StoryClockTimeOfDay, number>>;
  /** Inclusive [min, max] whole minutes per implicit category. */
  elapsedClampMinutes: Readonly<Record<StoryClockElapsedCategory, readonly [number, number]>>;
  fallbackMinutes: number;
  legacyUserStepMinutes: number;
  /** Floating next_day_at: the minimum E is (days - 1) days plus this. */
  estimatedNextDayAtMinutes: number;
  /** Floating set_time: E. */
  estimatedSetTimeMinutes: number;
  unitLengthsMs: Readonly<Record<StoryClockStoredAdvanceUnit, number>>;
  narrativeDateMaxForwardDays: number;
  /** Start of the fold's story day, minutes after 00:00 (next_day_at and the set_time slot order); never displayed (ruling 42). */
  storyDayStartMinutes: number;
}

/** Smallest year a story clock can hold. */
export const STORY_CLOCK_MIN_YEAR = 1;
/** Largest year a story clock can hold. */
export const STORY_CLOCK_MAX_YEAR = 9999;
/** Story-clock value of 1970-01-01T00:00 (719162 days), for legacy Unix-domain conversion only. */
export const STORY_CLOCK_UNIX_EPOCH_MS = 62_135_596_800_000;
/** Largest story-clock value: 9999-12-31T23:59:59.999 (3_652_059 days minus 1 ms). */
export const STORY_CLOCK_MAX_MS = 315_537_897_599_999;

/** Milliseconds since 0001-01-01T00:00:00.000 floating local time; a non-negative safe integer. */
export type StoryClockMs = number;

export const STORY_CLOCK_TIMES_OF_DAY = ['dawn', 'morning', 'noon', 'afternoon', 'dusk', 'evening', 'night', 'late_night'] as const;
/** Coarse part of the day, listed in story-day order (dawn first, late_night last; SC0 relies on this order); each has one SC0 slot range and representative time. */
export type StoryClockTimeOfDay = (typeof STORY_CLOCK_TIMES_OF_DAY)[number];

/** A calendar date; `year` is null when the source gave only month and day (a reference year is used, not shown). */
export interface StoryClockDate {
  year: number | null;
  /** 1..12 */
  month: number;
  /** 1..31, valid for the month (and year when known). */
  day: number;
}
/**
 * A calendar date whose year is stated. Needed wherever a year must be known: SC0 conversions, a relabel or year-fill
 * target, and StoryClockInferredOrigin.date. Origins, set_date cues, set_datetime and adoptions also accept a year-less
 * StoryClockDate.
 */
export interface StoryClockFullDate {
  year: number;
  month: number;
  day: number;
}
/** A wall-clock time of day. */
export interface StoryClockTime {
  /** 0..23 */
  hour: number;
  /** 0..59 */
  minute: number;
}

/** A reference to one immutable accepted source revision (same shape as world-state.ts PurchaseReference minus the effect). */
export interface StoryClockSourceRef {
  sourceId: string;
  revision: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Origin record (DESIGN 17.2): stored in the opening source's analysis; player corrections may replace it.
// ---------------------------------------------------------------------------------------------------------------

/** Where an origin quote was found: the opening prose, or an initialization entry (card or world book). */
export interface StoryClockQuoteSite {
  location: 'opening' | 'initialization';
  /** Source table or entry-kind name of an initialization entry; null for the opening prose. */
  table: string | null;
}

export const STORY_CLOCK_ORIGIN_BASES = ['explicit', 'inferred'] as const;
/** Whether the origin value is written in the text (explicit) or inferred from description (inferred; time of day only). */
export type StoryClockOriginBasis = (typeof STORY_CLOCK_ORIGIN_BASES)[number];

/** One origin value with its verbatim evidence; SC1 must re-derive the value from `quote` (date, time) before it is stored. */
export interface StoryClockOriginItem<T> {
  value: T;
  basis: StoryClockOriginBasis;
  /** Verbatim text of the site it came from. */
  quote: string;
  site: StoryClockQuoteSite;
}

export const STORY_CLOCK_ORIGIN_KINDS = ['absolute', 'relative'] as const;
/** Absolute: a story-now date is known. Relative: day 1 is the opening day, dateKnown=false. */
export type StoryClockOriginKind = (typeof STORY_CLOCK_ORIGIN_KINDS)[number];

/**
 * The origin record of a chat scope. Always exists on the opening source once analysed (absolute or relative).
 * Invariants: kind 'absolute' iff `date` non-null; `date` and `time` are 'explicit' only; `timeOfDay` may be
 * 'inferred'; when both `time` and `timeOfDay` are present `time` wins (the initial-state rule of the file header);
 * `time` and `timeOfDay` both null means time of day unknown. Several contradictory story-now dates give kind
 * 'relative', a null date and an 'origin_conflict' issue; a time or timeOfDay item survives only when SC1
 * parseStoryDate finds no date in its quote (independent evidence), and is dropped otherwise. The fold reads an origin
 * only from sources[0].
 */
export interface StoryClockOrigin {
  kind: StoryClockOriginKind;
  date: StoryClockOriginItem<StoryClockDate> | null;
  time: StoryClockOriginItem<StoryClockTime> | null;
  timeOfDay: StoryClockOriginItem<StoryClockTimeOfDay> | null;
}

/**
 * Fold input for chats processed before SC (no origin record): the old start anchor, translated once (DESIGN 17.1).
 * Shift rule: shiftMs = (local wall clock of startTimeMs in `timeZone`, counted from 0001-01-01) - startTimeMs; a
 * Unix-domain value u becomes u + shiftMs.
 * Two uses. (1) As the origin: only when the opening source's clock input is kind 'legacy' and no origin correction
 * exists (an origin correction replaces it); a new chat never reads it, even if its opening analysis failed or is
 * pending and WorldSettings.startTimeMs exists (that chat starts from the missing-origin relative default). (2) Its
 * shiftMs converts legacy 'absolute' effects whenever the anchor is present. SC3a passes the anchor only for a scope
 * whose opening source is legacy, and null otherwise.
 * Resulting origin (use 1): datedByRule=true gives dateKnown=true, yearKnown=true, atMs = shifted startTimeMs, and
 * timeOfDayKnown = timeKnown; datedByRule=false gives a relative clock (dateKnown=false, timeOfDayKnown=false),
 * atMs = shifted startTimeMs, and day 1 is the local calendar day of startTimeMs (dayOneStartMs = its 00:00).
 * timeOfDayInferred is false in both cases and the basis is 'legacy'. An invalid timeZone or startTimeMs makes SC0 use
 * the UTC shift (STORY_CLOCK_UNIX_EPOCH_MS) with an 'input_invalid' issue on sources[0].
 */
export interface StoryClockLegacyAnchor {
  /** WorldSettings.startTimeMs, a Unix instant. */
  startTimeMs: number;
  /** IANA zone whose local wall clock at startTimeMs is used for the one-time constant shift. */
  timeZone: string;
  /** True when the old rule (story-initial-clock.ts) found a date, so the origin is absolute; false means relative. */
  datedByRule: boolean;
  /** True iff the old rule matched an explicit time; false means its 00:00 default stood in (then timeOfDayKnown=false). Ignored when datedByRule=false. */
  timeKnown: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-source clock analysis (DESIGN 17.3): what the world stage emits for every accepted source.
// ---------------------------------------------------------------------------------------------------------------

export const STORY_CLOCK_ELAPSED_CATEGORIES = ['none', 'exchange', 'short_action', 'meal', 'travel', 'work_session', 'rest_night', 'time_skip'] as const;
/** Kind of implicit elapsed time; the clamp range per category lives in the SC0 constant table. */
export type StoryClockElapsedCategory = (typeof STORY_CLOCK_ELAPSED_CATEGORIES)[number];

/**
 * The model's implicit estimate of narrative time in this source, clamped by category. SC0 applies it after the cues
 * unless an applied cue moved the clock (wrote an AdvanceRecord), or the category is 'time_skip' and any cue was
 * applied; a zero-movement application and a fold-stage drop do not suppress it. rest_night lands no earlier than
 * rep('morning') of its end day; when the time of day is unknown it fixes the next day first (file header).
 */
export interface StoryClockElapsed {
  category: StoryClockElapsedCategory;
  /** Whole minutes, >= 0, stored as estimated (unclamped); SC0 clamps by category at fold time. */
  minutes: number;
  basis: 'implicit';
  /** Text the estimate rests on, or null when it is only a general impression. */
  quote: string | null;
}

export const STORY_CLOCK_CUE_KINDS = ['advance', 'next_day_at', 'set_time', 'set_date'] as const;
/** The four explicit cue kinds. */
export type StoryClockCueKind = (typeof STORY_CLOCK_CUE_KINDS)[number];

export const STORY_CLOCK_ADVANCE_UNITS = ['minutes', 'hours', 'days', 'weeks', 'months', 'years'] as const;
/** Model-facing unit in the raw world-stage output (SC2 decode only); never stored, see StoryClockStoredAdvanceUnit. */
export type StoryClockAdvanceUnit = (typeof STORY_CLOCK_ADVANCE_UNITS)[number];
export const STORY_CLOCK_STORED_ADVANCE_UNITS = ['minutes', 'months', 'years'] as const;
/** Unit of a stored advance cue: SC1 minutes (steps of 0.5), or SC1 calendar months or years (fixed lengths, applied by SC0). */
export type StoryClockStoredAdvanceUnit = (typeof STORY_CLOCK_STORED_ADVANCE_UNITS)[number];

/** Shared by all cues: a verbatim quote from this source revision's text. */
interface StoryClockCueBase {
  quote: string;
}
/** "Three hours later": move forward by an amount. */
export interface StoryClockAdvanceCue extends StoryClockCueBase {
  kind: 'advance';
  /**
   * Finite number > 0 taken from SC1, never the model's raw pair: minutes in steps of 0.5 for every non-calendar
   * duration (traditional units already folded: 半個時辰 is 60, 一刻鐘 is 15; vague amounts carry SC1's table value:
   * 幾天 is 4320), or SC1's calendarAmount for unit 'months' or 'years'. SC0 multiplies by unitLengthsMs and rounds to
   * a whole ms. Night phrases (一夜, 一宿, 整晚, "N nights later") are never advance cues; SC1 returns
   * next_day_at(N, morning).
   */
  value: number;
  unit: StoryClockStoredAdvanceUnit;
}
/**
 * "The next morning": move to T (time, else rep(timeOfDay)) `days` story days later. Story days start at
 * storyDayStartMinutes (05:00), so 「第二天一早」 said at 01:30 is the same calendar day's morning; the result moves one
 * more day while it is not after atMs. When the time of day is unknown it fixes the day first (earliest possible current
 * day + days) with E >= (days - 1) days + estimatedNextDayAtMinutes, basis 'estimated' (file header).
 */
export interface StoryClockNextDayAtCue extends StoryClockCueBase {
  kind: 'next_day_at';
  /** Day offset, integer >= 1. */
  days: number;
  /** At least one of `time` and `timeOfDay` is non-null; `time` wins when both are. */
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
}
/**
 * "By dawn": a time or slot of the current story day. Slots are ordered dawn..late_night within a story day that
 * starts at storyDayStartMinutes, so late_night after midnight belongs to the day before. It moves forward only to a
 * later slot (to its representative time) or a later time of the same story day, or, when the clock is in 'night' or
 * 'late_night' and the target slot (of `time` when given) is 'dawn' or 'morning', to the coming occurrence. Anything
 * else is applied with no movement (the same slot, Q10, or a slot or time already passed). Never backwards. When the
 * time of day is unknown it re-anchors with E = estimatedSetTimeMinutes, basis 'estimated'.
 */
export interface StoryClockSetTimeCue extends StoryClockCueBase {
  kind: 'set_time';
  /** At least one of `time` and `timeOfDay` is non-null; `time` wins when both are. */
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
}
/**
 * A stated date, optionally with a time or slot, applied by the date-setting rule of the file header in mode 'forward'
 * when `narrative` is true. Adoptable when not applied (StoryClockAdoptableDate): a full date whatever the drop
 * (date_not_narrative, date_regression, date_ambiguous, date_inference_revoked); a year-less date only when narrative
 * and dropped as date_ambiguous or date_inference_revoked on a month_day or dated clock (its only reading is forward).
 * Never adoptable: date_partial, value_out_of_range, input_invalid, and a year-less date_not_narrative.
 */
export interface StoryClockSetDateCue extends StoryClockCueBase {
  kind: 'set_date';
  date: StoryClockDate;
  /** Null: no wall time stated; with timeOfDay also null, the date-setting rule step 3 decides. */
  time: StoryClockTime | null;
  /** Slot stated with the date (「1887年10月14日晚上」, "the evening of 14 October 1887"); `time` wins when both are non-null. */
  timeOfDay: StoryClockTimeOfDay | null;
  /** Set by SC2 at decode: true iff SC1 isNarrativeDateQuote(quote) accepts the quote. SC0 never reads text. */
  narrative: boolean;
}
/** An explicit time cue that passed SC1 verification. */
export type StoryClockCue = StoryClockAdvanceCue | StoryClockNextDayAtCue | StoryClockSetTimeCue | StoryClockSetDateCue;

export const STORY_CLOCK_EXCLUDED_REASONS = ['recall', 'plan', 'hypothetical', 'reported', 'dialogue_mention', 'document'] as const;
/** Why a time expression does not move the clock; diagnostics and acceptance only, never folded. */
export type StoryClockExcludedReason = (typeof STORY_CLOCK_EXCLUDED_REASONS)[number];

/** A time expression the model saw and excluded, with the reason. */
export interface StoryClockExcluded {
  quote: string;
  reason: StoryClockExcludedReason;
  /** Filled by SC2 with SC1 only for reason 'document' when SC1 parses a full date (with year) from the quote; else null. Recalled dates are never filled. */
  date: StoryClockFullDate | null;
  /** Time parsed together with `date`; null when `date` is null or the quote has no time. */
  time: StoryClockTime | null;
  /** Slot parsed together with `date`; null when `date` is null or no slot is stated. */
  timeOfDay: StoryClockTimeOfDay | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Issues (fold and validation never throw; problems become records).
// ---------------------------------------------------------------------------------------------------------------

export const STORY_CLOCK_ISSUE_CODES = [
  // Decode/validation stage (SC2 with SC1); the affected item is dropped and the fallback applies.
  'analysis_invalid', 'quote_not_found', 'value_unresolved', 'value_mismatch', 'guard_hit', 'value_out_of_range',
  // Origin conflict (decode stage): several contradictory "story now" dates, so the origin is relative.
  'origin_conflict',
  // Fold stage (SC0): a stated date that is not applied, or a legacy value that cannot be anchored.
  'date_regression', 'date_partial', 'date_ambiguous', 'date_not_narrative', 'date_inference_revoked', 'legacy_set_unanchored',
  // Fold stage defence: a stored value violates this contract (NaN, negative, unknown enum, duplicate).
  'input_invalid',
] as const;
/**
 * quote_not_found: quote is not verbatim in the source; value_unresolved: SC1 cannot parse the quote;
 * value_mismatch: parsed value differs from the model's; guard_hit: quote matches an SC1 guard class;
 * value_out_of_range: outside years 1..9999 or not representable, or a year-less 29 Feb (decode stage); the fold also
 *   raises it when a movement, relabel, year fill or re-anchor would push a clock value outside
 *   [0, STORY_CLOCK_MAX_MS] (the event is dropped; a correction gets status 'invalid_value');
 * origin_conflict: contradictory story-now dates;
 * analysis_invalid: the whole storyClock output could not be decoded (including a missing or invalid `elapsed`, which
 *   is required; explicit cues are then dropped too); then NO StoryClockAnalysis is stored for the source, the fold
 *   input is a 'degraded' clock with reason 'failed' and this issue in its `issues` (a later successful
 *   re-extraction replaces it);
 * date_regression (fold stage): a narrative full date earlier than the current date on a dated clock; not applied,
 *   adoptable. A same-date time already passed is not a regression (applied with no movement), a year-less date
 *   resolves forward, and corrections and adoptions never raise it;
 * date_partial (fold stage): a narrative set_date without a year on a relative clock; not applied, not adoptable;
 * date_ambiguous (fold stage): a narrative set_date whose forward resolution (after year fill first on a month_day
 *   clock) is more than narrativeDateMaxForwardDays ahead; not applied; adoptable (a year-less one adopts forward);
 * date_not_narrative (fold stage): set_date whose `narrative` is false; not applied; adoptable iff its date is full;
 * date_inference_revoked (fold stage): a narrative set_date of a source bound by an applied revoke, or a narrative
 *   relabel or year fill of a later source; not applied; adoptable (a year-less one only on a month_day or dated
 *   clock);
 * legacy_set_unanchored (fold stage): a legacy absolute-set effect in a fold whose `legacyAnchor` is null, ignored;
 * input_invalid (fold stage): a stored value violates this contract; the item is skipped (a malformed cue alone, a
 *   malformed source input as degraded 'failed', a malformed correction as invalid_value).
 */
export type StoryClockIssueCode = (typeof STORY_CLOCK_ISSUE_CODES)[number];

/**
 * One problem found while validating or folding; shaped like world-state.ts WorldIssue. Source ref: the source
 * concerned; for a correction, its binding; for a scope-level issue without sources, {sourceId: '', revision: 0}.
 */
export interface StoryClockIssue extends StoryClockSourceRef {
  code: StoryClockIssueCode;
  /** Decode-stage codes: index in the model's raw cue list. Fold-stage codes: index into analysis.cues. Null when the issue is not about one cue. */
  cueIndex: number | null;
  /** The quote involved, or null. */
  quote: string | null;
  /** The correction involved (fold-stage issues about a dropped correction); null otherwise and always null in stored decode-stage issues. */
  correctionId: string | null;
}

/**
 * The stored world-stage clock output of one accepted source revision (SceneAnalysis field `storyClock`).
 * Stored after decode-stage validation: every cue is verified and resolved, dropped items are only in `issues`,
 * and `elapsed.minutes` is not clamped. Contains no times taken from other sources.
 */
export interface StoryClockAnalysis {
  /** Non-null only on the opening source (the first accepted source). */
  origin: StoryClockOrigin | null;
  /** Required: a missing or invalid estimate makes the whole output 'analysis_invalid' (category 'none', 0 minutes is the valid "nothing elapsed"). */
  elapsed: StoryClockElapsed;
  /** Verified explicit cues in original text order. */
  cues: readonly StoryClockCue[];
  excluded: readonly StoryClockExcluded[];
  /** Decode-stage issues (see StoryClockIssueCode) except analysis_invalid, which stores no analysis; fold-stage issues are not stored. */
  issues: readonly StoryClockIssue[];
}

// ---------------------------------------------------------------------------------------------------------------
// Player corrections (DESIGN 17.5): the only way the clock can move backwards.
// ---------------------------------------------------------------------------------------------------------------

export const STORY_CLOCK_CORRECTION_KINDS = ['origin', 'now', 'ooc', 'adoption'] as const;
/**
 * The four correction kinds. Phase order per accepted source (ties by seq, then correctionId): P0 origin (opening
 * source only), P1 ooc, P2 the source's own movement, P3 adopt, P4 the turn's 'now' (on the last source of the turn).
 * origin: bound to sources[0]; replaces the origin.
 * now: bound to the 'user' source of the current turn (latest accepted player source), applied at P4 of the turn's
 *   last accepted source, after the turn's assistant sources; its result belongs to that last source's state, so the
 *   next turn starts from it. A chat with no accepted player source (turn 0, greeting only) cannot take a 'now'
 *   correction: the store refuses it and the panel writes an 'origin' correction instead (labelled 設定起點);
 * ooc: bound to the 'user' source holding the OOC text, applied at P1 of that source, before its own movement; the
 *   source's narrative advance and the same turn's assistant advances stack on top;
 * adoption 'adopt': P3 of the source carrying the date, after its own movement. 'revoke' is not an event: it drops
 *   every narrative set_date of its bound source and every narrative relabel or year fill of later sources.
 */
export type StoryClockCorrectionKind = (typeof STORY_CLOCK_CORRECTION_KINDS)[number];

export const STORY_CLOCK_NOW_OPS = ['set_datetime', 'set_time_of_day', 'set_time', 'set_day_time', 'next_day_at', 'advance', 'clear_date'] as const;
/**
 * Operation names of a now or OOC correction. OOC mapping (SC1 parseOocTimeStatement; SC4 uses it):
 * 「現在是第二天早上八點」 → next_day_at {days 1, time 08:00, timeOfDay morning}; 「現在是晚上」 → set_time_of_day
 * {evening}; "(OOC: it's 9 pm now)" → set_time {21:00}; 「跳到三天後」 and "skip ahead three days" → advance {3,
 * days}; 「現在是1887年10月14日」 and "set the date to 14 October 1887" → set_datetime. 第 N 天 is never parsed from OOC
 * (Q4); set_day_time comes only from the panel. Every op has basis 'correction' and, unlike cues, may move the clock
 * backwards. Ops act on the displayed (calendar) day, except next_day_at, which counts story days (05:00) like the
 * narrative cue. On a floating clock an op that sets only a time or slot on the displayed day (set_time,
 * set_time_of_day, set_day_time of the displayed day, a same-date set_datetime with a time) re-anchors with E = 0,
 * keeping the displayed day and every elapsed duration; with no valid shift it is a plain set. Every other op is a
 * plain set or move; set_datetime is the only op that names a date; clear_date changes the kind.
 */
export type StoryClockNowOpKind = (typeof STORY_CLOCK_NOW_OPS)[number];

/**
 * Set the date and time: the date-setting rule of the file header in mode 'nearest'; may move backwards. By clock kind:
 * - dated clock: a plain set (a year-less date takes the occurrence nearest the current date); it may jump years, that
 *   is real story time;
 * - month_day clock: a full date first fills the year of the current position (mode 'nearest', StoryClockInferredOrigin
 *   source 'correction'), then sets the date as on a dated clock; a year-less date moves to the nearest month-day and
 *   leaves yearKnown=false;
 * - relative clock: no jump, the timeline is relabelled so the clock's current date becomes the target date (a
 *   year-less date relabels into the reference year and gives a month_day clock); only the time part is a movement.
 * `time` non-null: that wall time, timeOfDayKnown=true, timeOfDayInferred=false. `timeOfDay` alone: that slot's
 * representative time, same flags. On the same date and a floating clock the time part re-anchors with E = 0 instead.
 * Both null: step 3 of the header rule (the wall time and flags are kept when the target date equals the current date,
 * always true for a relabel and after a year fill only when the month-day is the same; else 08:00 with time of day
 * unknown).
 */
export interface StoryClockSetDatetimeOp {
  op: 'set_datetime';
  date: StoryClockDate;
  /** Null with `timeOfDay` null: header step 3 decides (same date: time and flags kept; different date: 08:00 with the time of day unknown); `time` wins over `timeOfDay` when both are given. */
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
}
/** Set only the time of day: the slot's representative time on the displayed (calendar) day; may move backwards. When the time of day is unknown it re-anchors with E = 0 instead. */
export interface StoryClockSetTimeOfDayOp {
  op: 'set_time_of_day';
  timeOfDay: StoryClockTimeOfDay;
}
/** Set a wall-clock time on the displayed (calendar) day, the day of the clock's atMs; may move backwards. When the time of day is unknown it re-anchors with E = 0 instead (the displayed day and every elapsed duration are kept). */
export interface StoryClockSetTimeOp {
  op: 'set_time';
  time: StoryClockTime;
}
/** Move to `time` (else the slot's representative time) n story days later, story days starting at 05:00 as for the narrative cue: said while the panel shows 00:00-04:59, n=1 is the displayed day's own morning. One more day while the result is not after atMs; never backwards, never a re-anchor. */
export interface StoryClockNextDayAtOp {
  op: 'next_day_at';
  /** Integer >= 1. */
  days: number;
  /** At least one of `time` and `timeOfDay` is non-null; `time` wins when both are. */
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
}
/** Set "day N at time" (N counts displayed days from the opening day = 1): atMs = dayOneStartMs + (N - 1) days + the time; valid for every clock kind; when N is the displayed day and the time of day is unknown it re-anchors with E = 0 instead. */
export interface StoryClockSetDayTimeOp {
  op: 'set_day_time';
  /** Integer >= 1. */
  dayNumber: number;
  /** At least one of `time` and `timeOfDay` is non-null; `time` wins when both are. */
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
}
/**
 * Move forward by an amount. SC1 converts weeks x7, months x30 and years x365 (fixed, as Q7) to days, and uses the
 * largest of days, hours and minutes in which the amount is an integer >= 1 (半年 is 4380 hours). A fuzzy amount (幾天,
 * a few days) or an inexact fraction is unresolved: no op is emitted and the plugin points to the panel. A floating
 * clock stays floating.
 */
export interface StoryClockAdvanceOp {
  op: 'advance';
  /** Integer >= 1. */
  amount: number;
  unit: 'minutes' | 'hours' | 'days';
}
/**
 * Forget the date and continue as a relative clock (day numbering stays anchored on the opening day). atMs,
 * dayOneStartMs, originAtMs and every earlier state are unchanged (only the labels dateKnown and yearKnown become
 * false, timeOfDayKnown, timeOfDayInferred and state.basis are kept); it writes no AdvanceRecord and does not disable
 * later relabelling: the next event that names a date on the now-relative clock relabels the whole timeline again.
 */
export interface StoryClockClearDateOp {
  op: 'clear_date';
}
/** The operation a now or OOC correction performs. */
export type StoryClockNowOp =
  | StoryClockSetDatetimeOp
  | StoryClockSetTimeOfDayOp
  | StoryClockSetTimeOp
  | StoryClockSetDayTimeOp
  | StoryClockNextDayAtOp
  | StoryClockAdvanceOp
  | StoryClockClearDateOp;

/** Fields every stored correction row has. */
interface StoryClockCorrectionBase {
  correctionId: string;
  /** Scope-wide positive integer assigned by the store; orders corrections that share a fold position. */
  seq: number;
  /** Real (Unix) creation time in milliseconds. */
  createdAtMs: number;
  /**
   * Bound source revision; the correction takes part in the fold only while it is accepted at that revision.
   * Status precedence against StoryClockFoldInput.sources: sourceId absent gives source_not_accepted; sourceId present
   * with a different revision gives revision_changed; then the kind check (invalid_binding), then the value check
   * (invalid_value), else applied.
   */
  binding: StoryClockSourceRef;
}
/**
 * Replaces the origin instead of being resolved against a clock (there is no prior clock): the initial-state rule of the
 * file header applies with basis 'correction'. date null gives a relative origin (the relative default's anchor day);
 * a year-less date is placed in the reference year and gives a month-day clock (dateKnown=true, yearKnown=false), the
 * same as a decoded StoryClockOrigin; a year-less 29 Feb is 'value_out_of_range'. time and timeOfDay both null give
 * time of day unknown; `time` wins when both are present.
 */
export interface StoryClockOriginCorrection extends StoryClockCorrectionBase {
  kind: 'origin';
  date: StoryClockDate | null;
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
}
/** A panel "it is now ..." correction, bound to the current turn's player source. */
export interface StoryClockNowCorrection extends StoryClockCorrectionBase {
  kind: 'now';
  op: StoryClockNowOp;
  /** The turn's accepted assistant source revisions when the correction was made; a later difference means "reply replaced". */
  replySources: readonly StoryClockSourceRef[];
}
/** A time statement found in an OOC segment of the bound player source. */
export interface StoryClockOocCorrection extends StoryClockCorrectionBase {
  kind: 'ooc';
  /** Verbatim OOC text, present in the bound source. */
  quote: string;
  op: StoryClockNowOp;
}
/**
 * Adopts a date listed in StoryClockFoldResult.adoptable, bound to the source that carries it, at P3 of that source.
 * SC4 copies quote, date, time and timeOfDay from the entry as stated. A full date follows the header rule in mode
 * 'nearest'; a year-less date (adoptable only from a month_day or dated clock) resolves forward from the clock at P3,
 * without the narrativeDateMaxForwardDays bound. By clock kind: a relative clock is relabelled (StoryClockInferredOrigin
 * source 'adoption'; a year-less date relabels into the reference year); a month_day clock has its year filled first,
 * then is set as a dated clock; a dated clock is set. Basis 'correction'; it may move backwards and never raises
 * 'date_regression'. Undone by deleting the row.
 */
export interface StoryClockAdoptCorrection extends StoryClockCorrectionBase {
  kind: 'adoption';
  action: 'adopt';
  quote: string;
  date: StoryClockDate;
  /** Null with timeOfDay null: date-setting rule step 3 (same date: time and flags kept; different date: 08:00 with the time of day unknown). */
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
}
/**
 * Revokes the narrative dates of the bound source and disables narrative derivation after it. Every narrative set_date
 * of the bound source is dropped as 'date_inference_revoked', whatever it did (relabel, year fill, a date movement
 * such as a jump of years on a dated clock, or a same-date restatement), and is listed as adoptable; the source's
 * implicit estimate then applies unless another cue moved the clock. Every later source's narrative relabel or year
 * fill is dropped the same way; later date movements on a dated clock are unaffected, and earlier sources stand. An
 * adoption is undone by deleting its row, and a correction's relabel by deleting that correction. A revoke with
 * nothing to drop is still 'applied' and still disables. SC4 offers it on narrative InferredOrigin lines and on
 * highlighted date jumps.
 */
export interface StoryClockRevokeCorrection extends StoryClockCorrectionBase {
  kind: 'adoption';
  action: 'revoke';
}
/** One stored player correction. */
export type StoryClockCorrection =
  | StoryClockOriginCorrection
  | StoryClockNowCorrection
  | StoryClockOocCorrection
  | StoryClockAdoptCorrection
  | StoryClockRevokeCorrection;

// ---------------------------------------------------------------------------------------------------------------
// Fold input (DESIGN 17.1, 17.3 step 6, 17.4): everything SC0 needs, so it never reads source text or the store.
// ---------------------------------------------------------------------------------------------------------------

/**
 * One old-semantics world effect that moved the clock (pre-SC source); only effects with applied=true are listed.
 * Legacy parity (I2 memoryClockMs = world time + 30 min per accepted player source): an 'absolute' effect sets the
 * WORLD part, so after it atMs = shifted setUnixMs + 30 min x (legacy 'user' sources accepted up to and including
 * the current source, when tavernRoleplay), not the bare set value; 'advance' effects add to atMs. An absolute
 * effect makes dateKnown=true, yearKnown=true, timeOfDayKnown=true, timeOfDayInferred=false, basis 'legacy' (also on
 * a relative legacy clock, from that source on; earlier per-source states stay relative and dayOneStartMs is kept).
 */
export type StoryClockLegacyEffect =
  /** From a clock_advance receipt (world-state.ts clockDeltaMs): a non-negative forward movement in ms. */
  | { kind: 'advance'; deltaMs: number; quote: string }
  /** From a clock_absolute receipt (world-state.ts clockSetMs): a Unix-domain instant, shifted by the legacy anchor rule. */
  | { kind: 'absolute'; setUnixMs: number; quote: string };

/**
 * The clock input of one accepted source. 'analysis': a post-SC stored StoryClockAnalysis. 'degraded': a post-SC
 * source with no usable analysis (reason model_unset, failed or skipped; `issues` carries analysis_invalid when
 * the output could not be decoded, else is empty). 'legacy': a source processed before SC (no storyClock field);
 * `effects` are its old clock effects in effect order, possibly empty. 'pending': the source is accepted but its
 * world stage has not finished (SceneSource.processing 'pending'); it is waiting, not failed: it adds no movement,
 * keeps its turn membership and its correction binding, is not 'degraded' (so it suppresses the 30-minute fallback of
 * its turn until it resolves), and is reported through the `pending` flags of the result so the UI can show it.
 * Pending 'user' sources also add no legacy 30-minute step.
 */
export type StoryClockSourceInput =
  | { kind: 'analysis'; analysis: StoryClockAnalysis }
  | { kind: 'degraded'; reason: StoryClockDegradeReason; issues: readonly StoryClockIssue[] }
  | { kind: 'legacy'; effects: readonly StoryClockLegacyEffect[] }
  | { kind: 'pending' };

/** One currently accepted source (revision) in accepted order; only accepted sources are in the fold input. */
export interface StoryClockFoldSource extends StoryClockSourceRef {
  /** 'user' is a player source and starts a turn (DESIGN 17.3 step 6); same values as SceneSource.role. */
  role: 'user' | 'assistant';
  clock: StoryClockSourceInput;
}

/**
 * The complete, text-free input of the fold. Degrade rules (DESIGN 17.4), applied per turn:
 * - A turn (a 'user' source plus the assistant sources up to the next 'user' source) gets fallbackMinutes (basis
 *   'fallback'), applied at P2 of its player source and attached to it, with degradeReason = the reason of that player
 *   source, iff every source of the turn is 'degraded' (any 'analysis', 'legacy' or 'pending' source in the turn
 *   suppresses it, and a partly successful turn adds only the successful parts). Sources before the first 'user'
 *   source are turn 0 and never get the fallback. The fallback applies to every scope kind.
 * - 'legacy' sources fold with pre-SC (I2) semantics: when `tavernRoleplay` is true each accepted 'user' legacy source
 *   first adds legacyUserStepMinutes (basis 'legacy'), then its effects apply as recorded; when false, nothing is
 *   added. `tavernRoleplay` is read by no other rule.
 */
export interface StoryClockFoldInput {
  /** True for a SillyTavern roleplay scope (as the former memoryClockMs rule); only affects 'legacy' sources. */
  tavernRoleplay: boolean;
  /** Old anchor of a chat whose opening source is legacy, or null (new chats, or an old chat with no world settings); see StoryClockLegacyAnchor. */
  legacyAnchor: StoryClockLegacyAnchor | null;
  /** Accepted sources in accepted order; the first is the opening source. */
  sources: readonly StoryClockFoldSource[];
  /** All stored corrections of the scope, in any order; SC0 orders them by fold position, then `seq`. */
  corrections: readonly StoryClockCorrection[];
}

// ---------------------------------------------------------------------------------------------------------------
// Clock state and fold result (derived values; never stored, cache key = origin + analyses + corrections + rule).
// ---------------------------------------------------------------------------------------------------------------

export const STORY_CLOCK_BASES = ['explicit', 'inferred', 'estimated', 'fallback', 'correction', 'legacy'] as const;
/**
 * How the clock state was last determined: explicit text or cue, inferred from description (time of day only),
 * implicit estimate, 30-minute degrade, player correction, or old pre-SC semantics. Set by every applied correction or
 * adoption except clear_date ('correction', even with no movement) and by the last other event, in fold order, that
 * moved `atMs` or made the time of day known; a relabel, a year fill, clear_date and a cue applied with no movement
 * leave it unchanged.
 */
export type StoryClockBasis = (typeof STORY_CLOCK_BASES)[number];

/** The clock at one point of the fold. */
export interface StoryClockState {
  atMs: StoryClockMs;
  /** False for a relative clock (day 1 is the opening day). */
  dateKnown: boolean;
  /** False when only a month-day was given (reference year in `atMs`) and always false when dateKnown is false; true otherwise. */
  yearKnown: boolean;
  /**
   * False while the clock is floating: the wall time is then a stand-in (08:00, or a legacy anchor's wall time) that is
   * never evidence and never shown. It becomes true when a time or slot is explicit, inferred or set, and false again
   * when an event sets another date without a time.
   */
  timeOfDayKnown: boolean;
  /**
   * True iff timeOfDayKnown and the known time of day still rests on an inference: an origin timeOfDay with basis
   * 'inferred', or a rest_night estimate that chose the morning (pushed to it, or fixed it on a floating clock). It
   * persists across later movements (so the "(推斷)" marker of DESIGN 17.5 survives) and is cleared by any explicit
   * time or slot event (cue, origin or correction), including a set_time applied with no movement, and whenever
   * timeOfDayKnown becomes false.
   */
  timeOfDayInferred: boolean;
  basis: StoryClockBasis;
}

export const STORY_CLOCK_DEGRADE_REASONS = ['model_unset', 'failed', 'skipped'] as const;
/** Why a turn has no usable clock analysis and gets the 30-minute fallback. */
export type StoryClockDegradeReason = (typeof STORY_CLOCK_DEGRADE_REASONS)[number];

/**
 * One movement of the clock, for the admin view ("+3 hours: quote"). A relabel or year fill (see the file header) is
 * not a movement and has no record; only the time part or the month-day move of the same event does. Source ref: the
 * source whose event moved the clock; a 'now' movement carries the last source of its turn, a fallback movement the
 * turn's player source. A re-anchor adjusts the anchor movement's deltaMs by its shift. SC4 highlights a narrative
 * set_date movement longer than its jump threshold and offers a revoke of its source.
 */
export interface StoryClockAdvanceRecord extends StoryClockSourceRef {
  /** 0 for sources before the first accepted player source, else the 1-based turn number. */
  turn: number;
  /**
   * Signed clock movement in ms. A re-anchor adds its shift X, which may be negative, to the anchor movement's deltaMs.
   * The total is negative only for basis 'correction'.
   */
  deltaMs: number;
  basis: StoryClockBasis;
  /** Cue kind, or null for an implicit, fallback, legacy or correction movement. */
  cueKind: StoryClockCueKind | null;
  /** The elapsed category behind an implicit movement: non-null only for basis 'estimated' movements that come from StoryClockElapsed. */
  category: StoryClockElapsedCategory | null;
  /** The correction that produced the movement: non-null only for basis 'correction'. */
  correctionId: string | null;
  /** Evidence text, or null. */
  quote: string | null;
  /** Non-null only for basis 'fallback'; the record is attached to the turn's player source. */
  degradeReason: StoryClockDegradeReason | null;
}

/** A time expression that did not move the clock, for the admin view ("ignored: quote (recall)"). */
export interface StoryClockIgnoredRecord extends StoryClockSourceRef {
  turn: number;
  quote: string;
  reason: StoryClockExcludedReason;
}

/**
 * The clock state after one accepted source and every fold event positioned at or before its end: origin and OOC
 * corrections at that source, its own movement, adoptions at that source, and, for the last source of a turn, that
 * turn's 'now' correction (see StoryClockCorrectionKind).
 */
export interface StoryClockSourceClock extends StoryClockSourceRef {
  turn: number;
  state: StoryClockState;
  /** True iff this source's input was 'pending'; its state then equals the state after the previous source (plus any correction positioned at it). */
  pending: boolean;
}

/**
 * A mid-story date that was not applied and can be adopted with one click (StoryClockAdoptCorrection). Listed in fold
 * order, deduplicated by (source, quote, date, time, timeOfDay) keeping the cue: every unapplied full date (set_date
 * cues dropped as date_not_narrative, date_regression, date_ambiguous or date_inference_revoked, and excluded
 * 'document' items with a full date), and every narrative year-less set_date dropped as date_ambiguous or
 * date_inference_revoked on a month_day or dated clock (its only reading is forward). Never listed: date_partial,
 * value_out_of_range, input_invalid, a year-less date_not_narrative. An adopted entry stays listed with `adoptedBy`.
 */
export interface StoryClockAdoptableDate extends StoryClockSourceRef {
  turn: number;
  quote: string;
  /** As stated; year null only for a narrative year-less date (see above). */
  date: StoryClockDate;
  time: StoryClockTime | null;
  timeOfDay: StoryClockTimeOfDay | null;
  /** From an unapplied set_date cue, or from an excluded 'document' expression SC1 could fully parse. */
  from: 'set_date' | 'document';
  /** Display only: for a year-less date on a dated clock, the year of its forward resolution at the cue's fold position; null otherwise. */
  resolvedYear: number | null;
  /** correctionId of the first applied adopt bound to the same source with the same quote and date; null while not adopted. */
  adoptedBy: string | null;
}

export const STORY_CLOCK_INFERRED_ORIGIN_SOURCES = ['narrative', 'adoption', 'correction'] as const;
/** What caused a relabel or year fill: a narrative set_date cue, a player adoption, or a set_datetime correction (now or OOC). */
export type StoryClockInferredOriginSource = (typeof STORY_CLOCK_INFERRED_ORIGIN_SOURCES)[number];

/**
 * The record of one relabel or year fill (DESIGN 17.3 step 5; mechanics in the file header): the timeline was shifted,
 * not the story advanced, so that the clock at this source carries `date` (a full date; a year-less correction that
 * relabels into the reference year leaves no record, nothing was inferred). Earlier entries are shown as dates
 * (derived). `date` is the event's date as stated; it is never re-shifted when a later relabel after clear_date moves
 * the timeline. A year fill into a leap year may move the month-day label of earlier states by one day; durations
 * never change. A revoke drops a record whose `source` is 'narrative' (StoryClockRevokeCorrection); one with source
 * 'adoption' or 'correction' disappears with its row.
 */
export interface StoryClockInferredOrigin extends StoryClockSourceRef {
  turn: number;
  /** Evidence text; null only for a panel 'now' correction, which has none. */
  quote: string | null;
  date: StoryClockFullDate;
  source: StoryClockInferredOriginSource;
  /** The correction behind source 'adoption' or 'correction'; null for source 'narrative'. */
  correctionId: string | null;
}

export const STORY_CLOCK_CORRECTION_STATUSES = ['applied', 'source_not_accepted', 'revision_changed', 'invalid_binding', 'invalid_value'] as const;
/**
 * Whether a correction takes part in the fold, and if not why (offer "reapply"). Precedence: source_not_accepted,
 * revision_changed, invalid_binding, invalid_value, applied. 'invalid_binding': the bound source is accepted at that
 * revision but of the wrong kind (a 'now' or 'ooc' correction on a source whose role is not 'user', an 'origin'
 * correction on a source other than sources[0]); it does not take part and cannot be reapplied to the same source.
 * 'invalid_value': the bound source is right but the correction's values cannot be applied (a year-less 29 Feb, a
 * year outside 1..9999, a movement or shift that would leave the range, a malformed row); it has no effect and the
 * fold adds a 'value_out_of_range' or 'input_invalid' issue carrying its correctionId. The store validates on write;
 * this is the fold's defence.
 */
export type StoryClockCorrectionStatusKind = (typeof STORY_CLOCK_CORRECTION_STATUSES)[number];

/** Fold verdict for one stored correction. */
export interface StoryClockCorrectionStatus {
  correctionId: string;
  status: StoryClockCorrectionStatusKind;
  /** True for an applied 'now' correction whose turn now has different accepted assistant sources. */
  replyReplaced: boolean;
}

/** The complete derived result of one fold; the fold never throws. */
export interface StoryClockFoldResult {
  clockRule: StoryClockRuleVersion;
  /** Clock after the last accepted source and all applicable corrections. */
  state: StoryClockState;
  /** Clock value of the origin instant (after any origin correction, every relabel or year fill, and a re-anchor of a floating stretch that starts at the initial state). */
  originAtMs: StoryClockMs;
  /** Clock value at 00:00 of day 1 (the opening day); "day N" = floor((atMs - dayOneStartMs) / 86_400_000) + 1, rolling at midnight for every clock kind (ruling 42). */
  dayOneStartMs: StoryClockMs;
  /** Per accepted source in order, on the final timeline (a relabel, year fill or re-anchor also shifts earlier entries). */
  sources: readonly StoryClockSourceClock[];
  advances: readonly StoryClockAdvanceRecord[];
  ignored: readonly StoryClockIgnoredRecord[];
  adoptable: readonly StoryClockAdoptableDate[];
  /** Every relabel or year fill that was applied, in fold order (empty on a dated clock throughout; several are possible only after a clear_date). */
  inferredOrigins: readonly StoryClockInferredOrigin[];
  corrections: readonly StoryClockCorrectionStatus[];
  /** True iff any accepted source is 'pending'; the UI shows the waiting state instead of a settled clock. */
  pending: boolean;
  /** Fold-stage issues plus the stored decode-stage issues of participating sources. */
  issues: readonly StoryClockIssue[];
}

export const STORY_CLOCK_KINDS = ['relative', 'month_day', 'dated'] as const;
/** relative: dateKnown=false; month_day: dateKnown and !yearKnown; dated: both. */
export type StoryClockKind = (typeof STORY_CLOCK_KINDS)[number];

/** Text-free display structure of one clock state (SC0 storyClockView); the only way consumers read dates, days and slots. */
export interface StoryClockView {
  kind: StoryClockKind;
  /** dated: full date; month_day: year null; relative: null. */
  date: StoryClockDate | null;
  /** Day N counted from the opening day (day 1), rolling at 00:00 for every clock kind (ruling 42; the fold's 05:00 story day is never shown); <= 0 only when a correction moved the clock before the opening day. */
  dayNumber: number;
  /** Null while timeOfDayKnown is false (the stand-in is never shown). */
  time: StoryClockTime | null;
  /** Slot of `time`; null while timeOfDayKnown is false. */
  timeOfDay: StoryClockTimeOfDay | null;
  timeOfDayInferred: boolean;
  basis: StoryClockBasis;
}
