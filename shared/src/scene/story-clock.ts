import {
  STORY_CLOCK_BASES, STORY_CLOCK_CORRECTION_KINDS, STORY_CLOCK_CUE_KINDS,
  STORY_CLOCK_DEGRADE_REASONS, STORY_CLOCK_ELAPSED_CATEGORIES, STORY_CLOCK_EXCLUDED_REASONS,
  STORY_CLOCK_ISSUE_CODES, STORY_CLOCK_MAX_MS, STORY_CLOCK_RULE_VERSION,
  STORY_CLOCK_STORED_ADVANCE_UNITS, STORY_CLOCK_TIMES_OF_DAY, STORY_CLOCK_UNIX_EPOCH_MS,
  type StoryClockAdvanceRecord, type StoryClockAdoptableDate, type StoryClockBasis,
  type StoryClockCorrection, type StoryClockCorrectionStatus, type StoryClockCue,
  type StoryClockDate, type StoryClockDegradeReason, type StoryClockElapsedCategory,
  type StoryClockFoldInput, type StoryClockFoldResult, type StoryClockFullDate,
  type StoryClockIgnoredRecord, type StoryClockInferredOrigin, type StoryClockIssue,
  type StoryClockIssueCode, type StoryClockMs, type StoryClockNowOp, type StoryClockOrigin,
  type StoryClockRuleConstants, type StoryClockSourceClock, type StoryClockSourceInput,
  type StoryClockSourceRef, type StoryClockState, type StoryClockTime,
  type StoryClockTimeOfDay, type StoryClockView,
} from './story-clock-types.ts';

const DAY = 86_400_000;
const MIN = 60_000;
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const STORY_CLOCK_RULE_V1: StoryClockRuleConstants = freeze({
  syntheticAnchorMs: 66_143_433_600_000, referenceYear: 2097,
  defaultDayTime: {hour: 8, minute: 0},
  timeOfDayRepresentativeTimes: {
    dawn: {hour: 5, minute: 30}, morning: {hour: 8, minute: 0}, noon: {hour: 12, minute: 0},
    afternoon: {hour: 15, minute: 0}, dusk: {hour: 18, minute: 0}, evening: {hour: 20, minute: 30},
    night: {hour: 22, minute: 0}, late_night: {hour: 23, minute: 30},
  },
  timeOfDaySlotStartMinutes: {dawn: 300, morning: 420, noon: 660, afternoon: 780,
    dusk: 1020, evening: 1140, night: 1290, late_night: 1380},
  elapsedClampMinutes: {none: [0, 0], exchange: [1, 15], short_action: [1, 30], meal: [15, 90],
    travel: [5, 240], work_session: [30, 480], rest_night: [360, 720], time_skip: [5, 240]},
  fallbackMinutes: 30, legacyUserStepMinutes: 30, estimatedNextDayAtMinutes: 480,
  estimatedSetTimeMinutes: 60, unitLengthsMs: {minutes: MIN, months: 30 * DAY, years: 365 * DAY},
  narrativeDateMaxForwardDays: 62, storyDayStartMinutes: 300,
});

type Obj = Record<string, unknown>;
const obj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);
const positive = (x: unknown): x is number => integer(x) && x > 0;
const clockValue = (x: unknown): x is number => integer(x) && x >= 0 && x <= STORY_CLOCK_MAX_MS;
const text = (x: unknown): x is string => typeof x === 'string';
const nonempty = (x: unknown): x is string => text(x) && x.length > 0;
const member = <T extends string>(x: unknown, values: readonly T[]): x is T => text(x) && values.includes(x as T);
const nullable = (x: unknown, check: (x: unknown) => boolean) => x === null || check(x);
const mod = (x: number, unit: number) => ((x % unit) + unit) % unit;
const wall = (x: number) => mod(x, DAY);
const midnight = (x: number) => x - wall(x);
const timeMs = (t: StoryClockTime) => (t.hour * 60 + t.minute) * MIN;
const rep = (s: StoryClockTimeOfDay) => timeMs(STORY_CLOCK_RULE_V1.timeOfDayRepresentativeTimes[s]);
const slotValid = (x: unknown): x is StoryClockTimeOfDay => member(x, STORY_CLOCK_TIMES_OF_DAY);
const leap = (year: number) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
function dateValid(x: unknown): x is StoryClockDate {
  if (!obj(x) || !(x.year === null || (integer(x.year) && x.year >= 1 && x.year <= 9999)) ||
    !integer(x.month) || x.month < 1 || x.month > 12 || !integer(x.day)) return false;
  const limit = x.month === 2 ? (x.year === null || leap(x.year) ? 29 : 28)
    : ([4, 6, 9, 11].includes(x.month) ? 30 : 31);
  return x.day >= 1 && x.day <= limit;
}
const fullValid = (x: unknown): x is StoryClockFullDate => dateValid(x) && x.year !== null;
function timeValid(x: unknown): x is StoryClockTime {
  return obj(x) && integer(x.hour) && x.hour >= 0 && x.hour < 24 &&
    integer(x.minute) && x.minute >= 0 && x.minute < 60;
}
const pairValid = (x: Obj, required: boolean) => nullable(x.time, timeValid) &&
  nullable(x.timeOfDay, slotValid) && (!required || x.time !== null || x.timeOfDay !== null);
const pickTime = (time: StoryClockTime | null, slot: StoryClockTimeOfDay | null) =>
  time !== null ? timeMs(time) : slot !== null ? rep(slot) : null;

// March-based Gregorian arithmetic, with the epoch translated to January of year one.
function daysFromParts(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400), yo = y - era * 400;
  const mp = month + (month > 2 ? -3 : 9);
  return era * 146097 + yo * 365 + Math.floor(yo / 4) - Math.floor(yo / 100)
    + Math.floor((153 * mp + 2) / 5) + day - 1 - 306;
}
export function storyClockFromParts(date: StoryClockFullDate, time: StoryClockTime): StoryClockMs | null {
  if (!fullValid(date) || !timeValid(time)) return null;
  return daysFromParts(date.year, date.month, date.day) * DAY + timeMs(time);
}
export function storyClockParts(atMs: StoryClockMs):
  {date: StoryClockFullDate; time: StoryClockTime; msOfDay: number} | null {
  if (!clockValue(atMs)) return null;
  const z = Math.floor(atMs / DAY) + 306, era = Math.floor(z / 146097), doe = z - era * 146097;
  const yo = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yo + Math.floor(yo / 4) - Math.floor(yo / 100));
  const mp = Math.floor((5 * doy + 2) / 153), month = mp + (mp < 10 ? 3 : -9);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1, year = era * 400 + yo + (month <= 2 ? 1 : 0);
  const msOfDay = wall(atMs);
  return {date: {year, month, day}, time: {hour: Math.floor(msOfDay / (60 * MIN)),
    minute: Math.floor(msOfDay / MIN) % 60}, msOfDay};
}
export function storyClockSlot(atMs: StoryClockMs): StoryClockTimeOfDay | null {
  if (!clockValue(atMs)) return null;
  const minute = wall(atMs) / MIN;
  for (let i = STORY_CLOCK_TIMES_OF_DAY.length - 1; i >= 0; i--) {
    const slot = STORY_CLOCK_TIMES_OF_DAY[i]!;
    if (minute >= STORY_CLOCK_RULE_V1.timeOfDaySlotStartMinutes[slot]) return slot;
  }
  return 'late_night';
}
export function storyClockDayNumber(atMs: StoryClockMs, dayOneStartMs: StoryClockMs): number | null {
  return clockValue(atMs) && clockValue(dayOneStartMs) ? Math.floor((atMs - dayOneStartMs) / DAY) + 1 : null;
}
export function storyClockDayDifference(fromMs: StoryClockMs, toMs: StoryClockMs): number | null {
  return clockValue(fromMs) && clockValue(toMs) ? (midnight(toMs) - midnight(fromMs)) / DAY : null;
}
export function storyClockElapsedParts(fromMs: StoryClockMs, toMs: StoryClockMs):
  {totalMinutes: number; days: number; hours: number; minutes: number} | null {
  if (!clockValue(fromMs) || !clockValue(toMs) || toMs < fromMs) return null;
  const totalMinutes = Math.floor((toMs - fromMs) / MIN), days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes - days * 1440) / 60);
  return {totalMinutes, days, hours, minutes: totalMinutes - days * 1440 - hours * 60};
}
export function storyClockView(state: StoryClockState, dayOneStartMs: StoryClockMs): StoryClockView | null {
  if (!obj(state) || !clockValue(state.atMs) || !clockValue(dayOneStartMs) ||
    ![state.dateKnown, state.yearKnown, state.timeOfDayKnown, state.timeOfDayInferred].every(x => typeof x === 'boolean') ||
    (state.yearKnown && !state.dateKnown) || (state.timeOfDayInferred && !state.timeOfDayKnown) ||
    !member(state.basis, STORY_CLOCK_BASES)) return null;
  const parts = storyClockParts(state.atMs)!;
  return {kind: !state.dateKnown ? 'relative' : !state.yearKnown ? 'month_day' : 'dated',
    date: !state.dateKnown ? null : {...parts.date, year: state.yearKnown ? parts.date.year : null},
    dayNumber: storyClockDayNumber(state.atMs, dayOneStartMs)!,
    time: state.timeOfDayKnown ? parts.time : null,
    timeOfDay: state.timeOfDayKnown ? storyClockSlot(state.atMs) : null,
    timeOfDayInferred: state.timeOfDayInferred, basis: state.basis};
}
export function legacyStoryClockShiftMs(startTimeMs: number, timeZone: string): number | null {
  if (!integer(startTimeMs) || Math.abs(startTimeMs) > 8.64e15 || !text(timeZone)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {timeZone, calendar: 'gregory', numberingSystem: 'latn',
      hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric'}).formatToParts(startTimeMs);
    const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const year = Number(fields.year);
    if (fields.era !== 'AD' || year < 1 || year > 9999) return null;
    const at = storyClockFromParts({year, month: Number(fields.month), day: Number(fields.day)},
      {hour: Number(fields.hour), minute: Number(fields.minute)});
    return at === null ? null : at + Number(fields.second) * 1000 + mod(startTimeMs, 1000) - startTimeMs;
  } catch { return null; }
}

function refValid(x: unknown): x is StoryClockSourceRef {
  return obj(x) && nonempty(x.sourceId) && positive(x.revision);
}
function issueValid(x: unknown): x is StoryClockIssue {
  return obj(x) && member(x.code, STORY_CLOCK_ISSUE_CODES) && text(x.sourceId) && integer(x.revision) &&
    (x.cueIndex === null || (integer(x.cueIndex) && x.cueIndex >= 0)) &&
    nullable(x.quote, text) && nullable(x.correctionId, text);
}
function originValid(x: unknown): x is StoryClockOrigin {
  if (!obj(x) || !member(x.kind, ['relative', 'absolute'])) return false;
  const item = (v: unknown, validate: (x: unknown) => boolean, inferred: boolean) => v === null ||
    (obj(v) && validate(v.value) && (v.basis === 'explicit' || (inferred && v.basis === 'inferred')) &&
      text(v.quote) && obj(v.site) && member(v.site.location, ['opening', 'initialization']) && nullable(v.site.table, text));
  if (!item(x.date, dateValid, false) || !item(x.time, timeValid, false) || !item(x.timeOfDay, slotValid, true)) return false;
  return (x.kind === 'absolute') === (x.date !== null) &&
    !(obj(x.date) && dateValid(x.date.value) && x.date.value.year === null && x.date.value.month === 2 && x.date.value.day === 29);
}
function cueValid(x: unknown): x is StoryClockCue {
  if (!obj(x) || !member(x.kind, STORY_CLOCK_CUE_KINDS) || !text(x.quote)) return false;
  if (x.kind === 'advance') return typeof x.value === 'number' && Number.isFinite(x.value) && x.value > 0 && member(x.unit, STORY_CLOCK_STORED_ADVANCE_UNITS);
  if (x.kind === 'next_day_at') return positive(x.days) && pairValid(x, true);
  if (x.kind === 'set_time') return pairValid(x, true);
  return dateValid(x.date) && pairValid(x, false) && typeof x.narrative === 'boolean';
}
function opValid(x: unknown): x is StoryClockNowOp {
  if (!obj(x)) return false;
  switch (x.op) {
    case 'clear_date': return true;
    case 'set_datetime': return dateValid(x.date) && pairValid(x, false);
    case 'set_time_of_day': return slotValid(x.timeOfDay);
    case 'set_time': return timeValid(x.time);
    case 'set_day_time': return positive(x.dayNumber) && pairValid(x, true);
    case 'next_day_at': return positive(x.days) && pairValid(x, true);
    case 'advance': return positive(x.amount) && member(x.unit, ['minutes', 'hours', 'days']);
    default: return false;
  }
}
function correctionValid(x: unknown): x is StoryClockCorrection {
  if (!obj(x) || !nonempty(x.correctionId) || !positive(x.seq) || !integer(x.createdAtMs) ||
    x.createdAtMs < 0 || !refValid(x.binding) || !member(x.kind, STORY_CLOCK_CORRECTION_KINDS)) return false;
  switch (x.kind) {
    case 'origin': return nullable(x.date, dateValid) && pairValid(x, false);
    case 'now': return opValid(x.op) && Array.isArray(x.replySources) && x.replySources.every(refValid);
    case 'ooc': return text(x.quote) && opValid(x.op);
    case 'adoption': return x.action === 'revoke' || (x.action === 'adopt' && text(x.quote) && dateValid(x.date) && pairValid(x, false));
  }
}
interface Source extends StoryClockSourceRef {
  role: 'user' | 'assistant'; clock: StoryClockSourceInput; origin: StoryClockOrigin | null;
  decode: StoryClockIssue[]; errors: StoryClockIssue[]; turn: number; inputIndex: number;
}
interface Correction {
  raw: unknown; value: StoryClockCorrection | null; seq: number; id: string;
  status: StoryClockCorrectionStatus; malformed: boolean;
}
interface Floating { start: number; initial: boolean; advance: number | null; lo: number; hi: number }
interface Event {
  ref: StoryClockSourceRef; issueRef: StoryClockSourceRef; turn: number; index: number;
  quote: string | null; correctionId: string | null; cueIndex: number | null;
  basis: StoryClockBasis; cueKind: StoryClockCue['kind'] | null;
  category: StoryClockElapsedCategory | null; degradeReason: StoryClockDegradeReason | null;
}
const safeRef = (x: unknown): StoryClockSourceRef => ({sourceId: obj(x) && text(x.sourceId) ? x.sourceId : '',
  revision: obj(x) && integer(x.revision) ? x.revision : 0});
const correctionRef = (x: unknown) => obj(x) && obj(x.binding) && text(x.binding.sourceId) && integer(x.binding.revision)
  ? {sourceId: x.binding.sourceId, revision: x.binding.revision} : {sourceId: '', revision: 0};
const issue = (ref: StoryClockSourceRef, code: StoryClockIssueCode = 'input_invalid', quote: string | null = null,
  correctionId: string | null = null, cueIndex: number | null = null): StoryClockIssue =>
  ({sourceId: ref.sourceId, revision: ref.revision, code, cueIndex, quote, correctionId});
const keyCompare = (a: Correction, b: Correction) => a.seq === b.seq ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a.seq < b.seq ? -1 : 1);
function malformedKey(c: Correction): string {
  const raw = obj(c.raw) ? c.raw : {};
  const r = correctionRef(raw);
  return JSON.stringify([r.sourceId, r.revision, text(raw.quote) ? raw.quote : null,
    text(raw.correctionId) ? raw.correctionId : null]);
}

export function foldStoryClock(input: StoryClockFoldInput): StoryClockFoldResult {
  const rule = STORY_CLOCK_RULE_V1;
  const scopeIssues: StoryClockIssue[] = [], slots: StoryClockIssue[][] = [];
  const root: Obj = obj(input) ? input : {};
  const emptyRef = {sourceId: '', revision: 0};
  if (!obj(input)) scopeIssues.push(issue(emptyRef));
  const rawSources: unknown[] = Array.isArray(root.sources) ? root.sources : [];
  const rawCorrections: unknown[] = Array.isArray(root.corrections) ? root.corrections : [];
  if (!Array.isArray(root.sources)) scopeIssues.push(issue(emptyRef));
  if (!Array.isArray(root.corrections)) scopeIssues.push(issue(emptyRef));
  if (typeof root.tavernRoleplay !== 'boolean') scopeIssues.push(issue(emptyRef));
  const tavern = root.tavernRoleplay === true;
  const sources: Source[] = [], byId = new Map<string, number>();
  let turn = 0;
  for (const [inputIndex, raw] of rawSources.entries()) {
    slots.push([]);
    if (!refValid(raw) || byId.has(raw.sourceId)) { slots[inputIndex]!.push(issue(safeRef(raw))); continue; }
    const fields = raw as unknown as Obj, errors: StoryClockIssue[] = [], decode: StoryClockIssue[] = [];
    const ref = {sourceId: raw.sourceId, revision: raw.revision};
    const role = fields.role === 'user' ? 'user' : 'assistant';
    if (role === 'user') turn++;
    const c: Obj = obj(fields.clock) ? fields.clock : {};
    const a: Obj = obj(c.analysis) ? c.analysis : {};
    const unknown = !member(fields.role, ['user', 'assistant']) || !member(c.kind, ['analysis', 'degraded', 'legacy', 'pending']);
    const stored = c.kind === 'analysis' ? a.issues : c.kind === 'degraded' ? c.issues : [];
    const badIssues = !Array.isArray(stored) || !stored.every(issueValid);
    if (!badIssues) for (const v of stored as StoryClockIssue[]) decode.push(issue(v, v.code, v.quote, v.correctionId, v.cueIndex));
    if (unknown) errors.push(issue(ref));
    const badAnalysis = c.kind === 'analysis' && (!obj(a.elapsed) || !member(a.elapsed.category, STORY_CLOCK_ELAPSED_CATEGORIES) ||
      !integer(a.elapsed.minutes) || a.elapsed.minutes < 0 || !Array.isArray(a.cues) || !Array.isArray(a.excluded));
    if (badAnalysis || badIssues) errors.push(issue(ref));
    let origin: StoryClockOrigin | null = null;
    if (sources.length === 0 && c.kind === 'analysis') {
      if (a.origin !== null && !originValid(a.origin)) errors.push(issue(ref));
      else if (originValid(a.origin)) origin = a.origin;
    }
    let clock: StoryClockSourceInput;
    if (unknown || badAnalysis) clock = {kind: 'degraded', reason: 'failed', issues: []};
    else if (c.kind === 'degraded') {
      const reason = member(c.reason, STORY_CLOCK_DEGRADE_REASONS) ? c.reason : 'failed';
      if (!member(c.reason, STORY_CLOCK_DEGRADE_REASONS)) errors.push(issue(ref));
      clock = {kind: 'degraded', reason, issues: []};
    } else if (c.kind === 'legacy') {
      if (!Array.isArray(c.effects)) { errors.push(issue(ref)); clock = {kind: 'degraded', reason: 'failed', issues: []}; }
      else clock = {kind: 'legacy', effects: c.effects as never};
    } else if (c.kind === 'pending') clock = {kind: 'pending'};
    else clock = {kind: 'analysis', analysis: a as unknown as Extract<StoryClockSourceInput, {kind: 'analysis'}>['analysis']};
    byId.set(ref.sourceId, sources.length);
    sources.push({...ref, role, clock, origin, decode, errors, turn, inputIndex});
  }
  let anchor: Obj | null = null, shift: number | null = null, anchorError = false;
  if (root.legacyAnchor !== null) {
    const a = root.legacyAnchor;
    if (!obj(a) || typeof a.startTimeMs !== 'number' || !text(a.timeZone) ||
      typeof a.datedByRule !== 'boolean' || typeof a.timeKnown !== 'boolean') anchorError = true;
    else {
      anchor = a; shift = legacyStoryClockShiftMs(a.startTimeMs, a.timeZone);
      if (shift === null) { shift = STORY_CLOCK_UNIX_EPOCH_MS; anchorError = true; }
      if (!clockValue(a.startTimeMs + shift)) anchorError = true;
    }
  }
  if (anchorError) {
    if (sources.length) sources[0]!.errors.unshift(issue(safeRef(sources[0]!)));
    else scopeIssues.push(issue(emptyRef));
  }
  const corrections: Correction[] = rawCorrections.map((raw): Correction => {
    const r = obj(raw) ? raw : {};
    return {raw, value: correctionValid(raw) ? raw : null, seq: positive(r.seq) ? r.seq : Infinity,
      id: text(r.correctionId) ? r.correctionId : '', malformed: !correctionValid(raw),
      status: {correctionId: text(r.correctionId) ? r.correctionId : '', status: 'invalid_value', replyReplaced: false}};
  }).sort((a, b) => keyCompare(a, b) || (malformedKey(a) < malformedKey(b) ? -1 : malformedKey(a) > malformedKey(b) ? 1 : 0));
  const firstIds = new Map<string, Correction>();
  for (const c of corrections) {
    const first = firstIds.get(c.id);
    if (first) {
      c.malformed = true;
      if (keyCompare(first, c) === 0) first.malformed = true;
    } else firstIds.set(c.id, c);
  }
  const phases = sources.map(() => ({origin: [] as Correction[], ooc: [] as Correction[], adopt: [] as Correction[], now: [] as Correction[]}));
  const revoked = new Set<number>(); let disabledFrom = Infinity;
  const turnEnds = new Map<number, number>(), players = new Map<number, number>(), allDegraded = new Map<number, boolean>();
  const replies = new Map<number, StoryClockSourceRef[]>();
  for (const [i, s] of sources.entries()) {
    turnEnds.set(s.turn, i);
    if (s.role === 'user') players.set(s.turn, i);
    allDegraded.set(s.turn, (allDegraded.get(s.turn) ?? true) && s.clock.kind === 'degraded');
    if (s.role === 'assistant') { const list = replies.get(s.turn) ?? []; list.push({sourceId: s.sourceId, revision: s.revision}); replies.set(s.turn, list); }
  }
  for (const c of corrections) {
    if (c.malformed || !c.value) continue;
    const v = c.value, i = byId.get(v.binding.sourceId);
    if (i === undefined) { c.status.status = 'source_not_accepted'; continue; }
    const s = sources[i]!;
    if (s.revision !== v.binding.revision) { c.status.status = 'revision_changed'; continue; }
    if ((v.kind === 'origin' && i !== 0) || ((v.kind === 'now' || v.kind === 'ooc') && s.role !== 'user')) {
      c.status.status = 'invalid_binding'; continue;
    }
    c.status.status = 'applied';
    if (v.kind === 'adoption' && v.action === 'revoke') { revoked.add(i); disabledFrom = Math.min(disabledFrom, i); }
    else if (v.kind === 'now') phases[turnEnds.get(s.turn)!]!.now.push(c);
    else if (v.kind === 'origin') phases[i]!.origin.push(c);
    else if (v.kind === 'ooc') phases[i]!.ooc.push(c);
    else phases[i]!.adopt.push(c);
  }

  const advances: StoryClockAdvanceRecord[] = [], snapshots: StoryClockSourceClock[] = [];
  // A whole-day relabel is lazy. Extrema are relative coordinates, not clock values.
  const snapshotLabels: number[] = [];
  let timelineShift = 0, snapshotMin = Infinity, snapshotMax = -Infinity;
  const snapshotAt = (j: number) => snapshots[j]!.state.atMs + timelineShift - snapshotLabels[j]!;
  const ignored: StoryClockIgnoredRecord[] = [], adoptable: StoryClockAdoptableDate[] = [], inferredOrigins: StoryClockInferredOrigin[] = [];
  const adoptKeys = new Map<string, number>();
  let state: StoryClockState = {atMs: rule.syntheticAnchorMs + timeMs(rule.defaultDayTime), dateKnown: false,
    yearKnown: false, timeOfDayKnown: false, timeOfDayInferred: false, basis: 'estimated'};
  let originAtMs = state.atMs, dayOneStartMs = midnight(state.atMs), floating: Floating | null = null;
  const openFloat = (initial: boolean, advance: number | null) => {
    floating = {start: snapshots.length, initial, advance, lo: -wall(state.atMs), hi: DAY - wall(state.atMs)};
  };
  const pushIssue = (e: Event, code: StoryClockIssueCode) => slots[sources[e.index]!.inputIndex]!.push(issue(e.issueRef, code, e.quote, e.correctionId, e.cueIndex));
  const move = (target: number, e: Event) => {
    const deltaMs = target - state.atMs;
    if (deltaMs !== 0) { advances.push({...e.ref, turn: e.turn, deltaMs, basis: e.basis, cueKind: e.cueKind,
      category: e.category, correctionId: e.correctionId, quote: e.quote, degradeReason: e.degradeReason}); state.basis = e.basis; }
    state.atMs = target;
  };
  const ordinary = (target: number, e: Event) => {
    if (!clockValue(target)) { pushIssue(e, 'value_out_of_range'); return false; }
    move(target, e); return true;
  };
  const known = (basis: StoryClockBasis, inferred = false) => {
    if (!state.timeOfDayKnown) state.basis = basis;
    state.timeOfDayKnown = true; state.timeOfDayInferred = inferred; floating = null;
  };
  const storyStart = (at: number) => at - mod(wall(at) - rule.storyDayStartMinutes * MIN, DAY);
  const nextDayTarget = (at: number, n: number, t: number) => {
    let target = midnight(at - rule.storyDayStartMinutes * MIN) + n * DAY + t;
    if (target <= at) target += (Math.floor((at - target) / DAY) + 1) * DAY;
    return target;
  };
  const setTimeTarget = (at: number, time: StoryClockTime | null, slot: StoryClockTimeOfDay | null) => {
    const current = storyClockSlot(at)!, overnight = current === 'night' || current === 'late_night';
    const t = pickTime(time, slot)!;
    const s = time !== null ? storyClockSlot(t)! : slot!;
    const q = storyStart(at) + mod(t - rule.storyDayStartMinutes * MIN, DAY);
    if (time !== null ? q > at : STORY_CLOCK_TIMES_OF_DAY.indexOf(s) > STORY_CLOCK_TIMES_OF_DAY.indexOf(current)) return q;
    if (overnight && (s === 'dawn' || s === 'morning')) return q + DAY;
    return at;
  };
  const reanchorPlan = (variant: 'A' | 'B' | 'C', t: number, elapsed: number, n = 1): {x: number; elapsed: number} | null => {
    if (!floating) return null;
    let {lo, hi} = floating, x: number, e = elapsed;
    if (variant === 'C') { lo = Math.max(lo, -wall(state.atMs)); hi = Math.min(hi, DAY - wall(state.atMs)); }
    if (variant === 'B') {
      const d = midnight(state.atMs + lo) + n * DAY;
      x = d + t - state.atMs - e;
      if (x < lo) x += Math.ceil((lo - x) / DAY) * DAY;
      if (x >= hi) { const k = Math.floor((x - hi) / MIN) + 1; x -= k * MIN; e += k * MIN; }
    } else { const x0 = mod(t - wall(state.atMs + e), DAY); x = x0 + Math.ceil((lo - x0) / DAY) * DAY; }
    if (!integer(x) || !integer(e) || x < lo || x >= hi || !clockValue(state.atMs + x) || !clockValue(state.atMs + x + e) ||
      (floating.initial && !clockValue(originAtMs + x)) || snapshots.slice(floating.start).some((_, j) => !clockValue(snapshotAt(floating!.start + j) + x))) return null;
    return {x, elapsed: e};
  };
  const applyReanchor = (plan: {x: number; elapsed: number}, e: Event, inferred = false) => {
    const f = floating!;
    for (let j = 0; j < snapshots.length; j++) {
      snapshots[j]!.state.atMs = snapshotAt(j); snapshotLabels[j] = timelineShift;
    }
    for (let j = f.start; j < snapshots.length; j++) snapshots[j]!.state.atMs += plan.x;
    snapshotMin = Infinity; snapshotMax = -Infinity;
    for (const p of snapshots) {
      snapshotMin = Math.min(snapshotMin, p.state.atMs - timelineShift);
      snapshotMax = Math.max(snapshotMax, p.state.atMs - timelineShift);
    }
    if (f.initial) originAtMs += plan.x;
    if (f.advance !== null) advances[f.advance]!.deltaMs += plan.x;
    state.atMs += plan.x;
    move(state.atMs + plan.elapsed, e); known(e.basis, inferred);
  };
  const reanchor = (variant: 'A' | 'B' | 'C', t: number, elapsed: number, e: Event, n = 1, inferred = false) => {
    const plan = reanchorPlan(variant, t, elapsed, n);
    if (!plan) return false;
    applyReanchor(plan, e, inferred); return true;
  };
  const resolveYearless = (d: StoryClockDate, current: StoryClockFullDate, mode: 'forward' | 'nearest') => {
    const at = daysFromParts(current.year, current.month, current.day);
    const candidates = [current.year - 1, current.year, current.year + 1]
      .map(year => ({year, month: d.month, day: d.day})).filter(fullValid)
      .map(date => ({date, delta: daysFromParts(date.year, date.month, date.day) - at}));
    const valid = mode === 'forward' ? candidates.filter(c => c.delta >= 0) : candidates;
    valid.sort((a, b) => mode === 'forward' ? a.delta - b.delta : Math.abs(a.delta) - Math.abs(b.delta) || b.delta - a.delta);
    return valid[0]?.date ?? null;
  };
  const addAdoptable = (date: StoryClockDate, time: StoryClockTime | null, slot: StoryClockTimeOfDay | null,
    quote: string, e: Event, from: 'set_date' | 'document') => {
    const resolved = date.year === null && state.yearKnown ? resolveYearless(date, storyClockParts(state.atMs)!.date, 'forward') : null;
    const key = JSON.stringify([e.ref.sourceId, e.ref.revision, quote, date.year, date.month, date.day, time?.hour ?? null, time?.minute ?? null, slot]);
    if (adoptKeys.has(key)) return;
    adoptKeys.set(key, adoptable.length);
    adoptable.push({...e.ref, turn: e.turn, quote, date: {year: date.year, month: date.month, day: date.day},
      time: time && {hour: time.hour, minute: time.minute}, timeOfDay: slot,
      from, resolvedYear: resolved?.year ?? null, adoptedBy: null});
  };
  const setDate = (date: StoryClockDate, time: StoryClockTime | null, slot: StoryClockTimeOfDay | null,
    e: Event, narrative: boolean | null, adoption: boolean): boolean => {
    const cue = narrative !== null, relative = !state.dateKnown, filling = state.dateKnown && !state.yearKnown && date.year !== null;
    const drop = (code: StoryClockIssueCode) => {
      pushIssue(e, code);
      if (cue && ((date.year !== null && ['date_not_narrative', 'date_regression', 'date_ambiguous', 'date_inference_revoked'].includes(code)) ||
        (date.year === null && narrative && state.dateKnown && ['date_ambiguous', 'date_inference_revoked'].includes(code))))
        addAdoptable(date, time, slot, e.quote!, e, 'set_date');
      return false;
    };
    if (date.year === null && date.month === 2 && date.day === 29) return drop('value_out_of_range');
    let semanticDrop: StoryClockIssueCode | null = narrative === false ? 'date_not_narrative'
      : relative && date.year === null && cue ? 'date_partial' : null;
    const mode = cue || (adoption && date.year === null) ? 'forward' : 'nearest';
    const oldDate = storyClockParts(state.atMs)!.date;
    let current = oldDate, target: StoryClockFullDate, shiftDays = 0;
    if (relative) {
      target = {year: date.year ?? rule.referenceYear, month: date.month, day: date.day};
      shiftDays = daysFromParts(target.year, target.month, target.day) - daysFromParts(oldDate.year, oldDate.month, oldDate.day);
      current = target;
    } else {
      if (filling) {
        const y = date.year!;
        const candidates = [y - 1, y, y + 1].map(year => ({year, month: oldDate.month, day: oldDate.day})).filter(fullValid);
        const eventDay = daysFromParts(y, date.month, date.day);
        if (mode === 'forward') current = candidates.filter(d => daysFromParts(d.year, d.month, d.day) <= eventDay)
          .sort((a, b) => b.year - a.year)[0]!;
        else current = candidates.sort((a, b) => Math.abs(eventDay - daysFromParts(a.year, a.month, a.day)) -
          Math.abs(eventDay - daysFromParts(b.year, b.month, b.day)) || a.year - b.year)[0]!;
        if (!current) return drop('value_out_of_range');
        shiftDays = daysFromParts(current.year, current.month, current.day) - daysFromParts(oldDate.year, oldDate.month, oldDate.day);
      }
      const resolved = date.year === null ? resolveYearless(date, current, mode) : date as StoryClockFullDate;
      if (!resolved) return drop('value_out_of_range');
      target = resolved;
    }
    const s = shiftDays * DAY;
    const distance = daysFromParts(target.year, target.month, target.day) - daysFromParts(current.year, current.month, current.day);
    if (!semanticDrop && cue && (revoked.has(e.index) || ((relative || filling) && e.index >= disabledFrom))) semanticDrop = 'date_inference_revoked';
    if (!semanticDrop && cue && !relative && (filling || date.year === null) && distance > rule.narrativeDateMaxForwardDays) semanticDrop = 'date_ambiguous';
    if (!semanticDrop && cue && !relative && !filling && date.year !== null && distance < 0) semanticDrop = 'date_regression';
    const t = pickTime(time, slot), same = distance === 0;
    let next = state.atMs, plan: {x: number; elapsed: number} | null = null;
    let timeKnown = state.timeOfDayKnown, inferred = state.timeOfDayInferred;
    if (same && t !== null) {
      plan = floating ? reanchorPlan(cue ? 'A' : 'C', t, 0) : null;
      next = plan ? state.atMs + plan.x : cue ? Math.max(state.atMs, midnight(state.atMs) + t) : midnight(state.atMs) + t;
      timeKnown = true; inferred = false;
    } else if (!same) {
      next = daysFromParts(target.year, target.month, target.day) * DAY - s + (t ?? timeMs(rule.defaultDayTime));
      timeKnown = t !== null; inferred = false;
    }
    // Check every affected value before writing either the movement or the relabel.
    const x = plan?.x ?? 0;
    if (!clockValue(next) || !clockValue(next + s) || !clockValue(originAtMs + (plan && floating?.initial ? x : 0) + s) ||
      !clockValue(dayOneStartMs + s) || (s !== 0 && snapshots.length > 0 &&
        (plan ? snapshots.some((_, j) => !clockValue(snapshotAt(j) + (j >= floating!.start ? x : 0) + s))
          : !clockValue(snapshotMin + timelineShift + s) || !clockValue(snapshotMax + timelineShift + s)))) return drop('value_out_of_range');
    if (semanticDrop) return drop(semanticDrop);
    const movementIndex = next !== state.atMs && !plan ? advances.length : null;
    if (plan) applyReanchor(plan, e);
    else move(next, e);
    if (s !== 0) {
      state.atMs += s; originAtMs += s; dayOneStartMs += s;
      timelineShift += s;
    }
    if ((relative || filling) && date.year !== null) inferredOrigins.push({...e.ref, turn: e.turn, quote: e.quote,
      date: {year: date.year, month: date.month, day: date.day}, source: cue ? 'narrative' : adoption ? 'adoption' : 'correction', correctionId: e.correctionId});
    state.dateKnown = true; state.yearKnown = relative ? date.year !== null : state.yearKnown || filling;
    if (timeKnown && !state.timeOfDayKnown) state.basis = e.basis;
    state.timeOfDayKnown = timeKnown; state.timeOfDayInferred = inferred;
    if (timeKnown) floating = null;
    else if (!same) openFloat(false, movementIndex);
    else if (floating && t === null) { floating.lo = Math.max(floating.lo, -wall(state.atMs)); floating.hi = Math.min(floating.hi, DAY - wall(state.atMs)); }
    if (!cue) state.basis = 'correction';
    return true;
  };
  const event = (i: number, basis: StoryClockBasis, quote: string | null = null): Event => ({ref: safeRef(sources[i]),
    issueRef: safeRef(sources[i]), turn: sources[i]!.turn, index: i, quote, correctionId: null, cueIndex: null,
    basis, cueKind: null, category: null, degradeReason: null});
  const runCorrection = (c: Correction, i: number) => {
    const v = c.value!;
    if (v.kind !== 'now' && v.kind !== 'ooc' && !(v.kind === 'adoption' && v.action === 'adopt')) return;
    const e = event(i, 'correction', 'quote' in v ? v.quote : null);
    e.issueRef = safeRef(v.binding); e.correctionId = v.correctionId;
    let ok = true;
    if (v.kind === 'adoption') ok = setDate(v.date, v.time, v.timeOfDay, e, null, true);
    else {
      const op = v.op;
      switch (op.op) {
        case 'clear_date': state.dateKnown = false; state.yearKnown = false; break;
        case 'set_datetime': ok = setDate(op.date, op.time, op.timeOfDay, e, null, false); break;
        case 'advance': ok = ordinary(state.atMs + op.amount * (op.unit === 'days' ? DAY : op.unit === 'hours' ? 60 * MIN : MIN), e); break;
        default: {
          const t = op.op === 'set_time_of_day' ? rep(op.timeOfDay) : op.op === 'set_time' ? timeMs(op.time) : pickTime(op.time, op.timeOfDay)!;
          const day = op.op === 'set_day_time' ? dayOneStartMs + (op.dayNumber - 1) * DAY : midnight(state.atMs);
          const canAnchor = op.op !== 'next_day_at' && day === midnight(state.atMs);
          if (!(floating && canAnchor && reanchor('C', t, 0, e))) {
            const target = op.op === 'next_day_at' ? nextDayTarget(state.atMs, op.days, t) : day + t;
            ok = ordinary(target, e); if (ok) known('correction');
          }
        }
      }
      if (ok && op.op !== 'clear_date') state.basis = 'correction';
    }
    if (!ok) c.status.status = 'invalid_value';
    else if (v.kind === 'now') c.status.replyReplaced = JSON.stringify(v.replySources.map(r => [r.sourceId, r.revision])) !==
      JSON.stringify((replies.get(sources[i]!.turn) ?? []).map(r => [r.sourceId, r.revision]));
  };

  let originWinner: StoryClockState | null = null;
  const makeOrigin = (d: StoryClockDate | null, time: StoryClockTime | null, slot: StoryClockTimeOfDay | null,
    basis: StoryClockBasis, inferred: boolean): StoryClockState | null => {
    if (d?.year === null && d.month === 2 && d.day === 29) return null;
    const t = pickTime(time, slot), date = d ? {...d, year: d.year ?? rule.referenceYear} : null;
    const at = date ? storyClockFromParts(date, time ?? (slot ? rule.timeOfDayRepresentativeTimes[slot] : rule.defaultDayTime))
      : rule.syntheticAnchorMs + (t ?? timeMs(rule.defaultDayTime));
    return at === null ? null : {atMs: at, dateKnown: d !== null, yearKnown: d !== null && d.year !== null,
      timeOfDayKnown: t !== null, timeOfDayInferred: t !== null && inferred, basis};
  };
  for (const c of phases[0]?.origin ?? []) {
    const v = c.value!;
    if (v.kind !== 'origin') continue;
    const candidate = makeOrigin(v.date, v.time, v.timeOfDay, 'correction', false);
    if (candidate) originWinner = candidate;
    else { c.status.status = 'invalid_value'; const e = event(0, 'correction'); e.issueRef = safeRef(v.binding); e.correctionId = v.correctionId; pushIssue(e, 'value_out_of_range'); }
  }
  if (originWinner) state = originWinner;
  else if (sources[0]?.clock.kind === 'analysis' && sources[0].origin) {
    const o = sources[0].origin, items = [o.date, o.time, o.timeOfDay];
    const basis = items.some(v => v?.basis === 'explicit') ? 'explicit' : items.some(v => v?.basis === 'inferred') ? 'inferred' : 'estimated';
    state = makeOrigin(o.date?.value ?? null, o.time?.value ?? null, o.timeOfDay?.value ?? null, basis,
      o.time === null && o.timeOfDay?.basis === 'inferred')!;
  } else if (sources[0]?.clock.kind === 'legacy' && anchor && integer(anchor.startTimeMs) && shift !== null && clockValue(anchor.startTimeMs + shift)) {
    state = {atMs: anchor.startTimeMs + shift, dateKnown: anchor.datedByRule === true, yearKnown: anchor.datedByRule === true,
      timeOfDayKnown: anchor.datedByRule === true && anchor.timeKnown === true, timeOfDayInferred: false, basis: 'legacy'};
  }
  originAtMs = state.atMs; dayOneStartMs = midnight(state.atMs);
  if (!state.timeOfDayKnown) openFloat(true, null);
  let legacyUsers = 0;
  for (const [i, s] of sources.entries()) {
    const bucket = slots[s.inputIndex]!;
    bucket.unshift(...s.decode, ...s.errors);
    for (const c of phases[i]!.ooc) runCorrection(c, i);
    if (s.role === 'user' && s.turn > 0 && allDegraded.get(s.turn)) {
      const e = event(i, 'fallback'); e.degradeReason = s.clock.kind === 'degraded' ? s.clock.reason : 'failed';
      ordinary(state.atMs + rule.fallbackMinutes * MIN, e);
    }
    if (s.clock.kind === 'legacy') {
      if (s.role === 'user' && tavern) { legacyUsers++; ordinary(state.atMs + rule.legacyUserStepMinutes * MIN, event(i, 'legacy')); }
      for (const raw of s.clock.effects) {
        const e = event(i, 'legacy', obj(raw) && text(raw.quote) ? raw.quote : null);
        if (!obj(raw) || !text(raw.quote) || (raw.kind === 'advance' ? !integer(raw.deltaMs) || raw.deltaMs < 0 : raw.kind !== 'absolute' || !integer(raw.setUnixMs))) {
          pushIssue(e, 'input_invalid'); continue;
        }
        if (raw.kind === 'advance') ordinary(state.atMs + (raw.deltaMs as number), e);
        else if (!anchor || shift === null) pushIssue(e, 'legacy_set_unanchored');
        else {
          const target = (raw.setUnixMs as number) + shift + rule.legacyUserStepMinutes * MIN * legacyUsers;
          if (target < state.atMs) pushIssue(e, 'input_invalid');
          else if (ordinary(target, e)) { state.dateKnown = true; state.yearKnown = true; known('legacy'); }
        }
      }
    } else if (s.clock.kind === 'analysis') {
      const a = s.clock.analysis; let moved = false, applied = false;
      for (const [cueIndex, raw] of a.cues.entries()) {
        const e = event(i, 'explicit', obj(raw) && text(raw.quote) ? raw.quote : null); e.cueIndex = cueIndex;
        if (!cueValid(raw)) { pushIssue(e, 'input_invalid'); continue; }
        e.cueKind = raw.kind; const before = advances.length; let ok = false;
        switch (raw.kind) {
          case 'advance': ok = ordinary(state.atMs + Math.round(raw.value * rule.unitLengthsMs[raw.unit]), e); break;
          case 'set_date': ok = setDate(raw.date, raw.time, raw.timeOfDay, e, raw.narrative, false); break;
          case 'next_day_at': {
            const t = pickTime(raw.time, raw.timeOfDay)!;
            if (floating) e.basis = 'estimated';
            ok = !!floating && reanchor('B', t, (raw.days - 1) * DAY + rule.estimatedNextDayAtMinutes * MIN, e, raw.days);
            if (!ok) { ok = ordinary(nextDayTarget(state.atMs, raw.days, t), e); if (ok) known(e.basis); }
            break;
          }
          case 'set_time': {
            const t = pickTime(raw.time, raw.timeOfDay)!;
            if (floating) e.basis = 'estimated';
            ok = !!floating && reanchor('A', t, rule.estimatedSetTimeMinutes * MIN, e);
            if (!ok) { ok = ordinary(setTimeTarget(state.atMs, raw.time, raw.timeOfDay), e); if (ok) known(e.basis); }
          }
        }
        applied ||= ok; moved ||= ok && advances.length > before;
      }
      if (!moved && !(a.elapsed.category === 'time_skip' && applied)) {
        const category = a.elapsed.category, [lo, hi] = rule.elapsedClampMinutes[category];
        const m = Math.min(hi, Math.max(lo, a.elapsed.minutes)) * MIN;
        const e = event(i, 'estimated', text(a.elapsed.quote) ? a.elapsed.quote : null); e.category = category;
        if (category === 'rest_night') {
          if (!(floating && reanchor('B', rep('morning'), m, e, 1, true))) {
            const r = state.atMs + m, push = wall(r) < rep('morning');
            if (ordinary(push ? midnight(r) + rep('morning') : r, e) && push) known('estimated', true);
          }
        } else ordinary(state.atMs + m, e);
      }
      for (const raw of a.excluded) {
        const e = event(i, 'explicit', obj(raw) && text(raw.quote) ? raw.quote : null);
        if (!obj(raw) || !member(raw.reason, STORY_CLOCK_EXCLUDED_REASONS) || !text(raw.quote) ||
          !nullable(raw.date, fullValid) || !pairValid(raw, false)) { pushIssue(e, 'input_invalid'); continue; }
        ignored.push({...e.ref, turn: e.turn, quote: raw.quote, reason: raw.reason});
        if (raw.reason === 'document' && fullValid(raw.date)) addAdoptable(raw.date, raw.time as StoryClockTime | null,
          raw.timeOfDay as StoryClockTimeOfDay | null, raw.quote, e, 'document');
      }
    }
    for (const c of phases[i]!.adopt) runCorrection(c, i);
    for (const c of phases[i]!.now) runCorrection(c, i);
    snapshots.push({sourceId: s.sourceId, revision: s.revision, turn: s.turn, state: {...state}, pending: s.clock.kind === 'pending'});
    snapshotLabels.push(timelineShift);
    snapshotMin = Math.min(snapshotMin, state.atMs - timelineShift);
    snapshotMax = Math.max(snapshotMax, state.atMs - timelineShift);
  }
  const adopted = new Map<string, string>();
  for (const c of corrections) {
    const v = c.value;
    if (c.status.status === 'applied' && v?.kind === 'adoption' && v.action === 'adopt') {
      const key = JSON.stringify([v.binding.sourceId, v.binding.revision, v.quote, v.date.year, v.date.month, v.date.day]);
      if (!adopted.has(key)) adopted.set(key, v.correctionId);
    }
  }
  for (const a of adoptable) a.adoptedBy = adopted.get(JSON.stringify([a.sourceId, a.revision, a.quote, a.date.year, a.date.month, a.date.day])) ?? null;
  const tail = corrections.filter(c => c.malformed).map(c => {
    const r = obj(c.raw) ? c.raw : {};
    return issue(correctionRef(c.raw), 'input_invalid', text(r.quote) ? r.quote : null, text(r.correctionId) ? r.correctionId : null);
  });
  return {clockRule: STORY_CLOCK_RULE_VERSION, state: {...state}, originAtMs, dayOneStartMs,
    sources: snapshots.map((s, j) => ({...s, state: {...s.state, atMs: snapshotAt(j)}})),
    advances, ignored, adoptable, inferredOrigins, corrections: corrections.map(c => ({...c.status})),
    pending: sources.some(s => s.clock.kind === 'pending'), issues: [...scopeIssues, ...slots.flat(), ...tail]};
}
