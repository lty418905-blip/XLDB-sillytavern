export interface UserActivityEvent {
  id: string;
  revision: number;
  role: string;
  status: string;
  acceptedAtMs: number;
  kind?: 'message' | 'summary';
}

export interface UserActivitySummary {
  schema: 'xldb-user-activity-v1';
  timeZone: string;
  window: {fromMs: number; toMs: number; windowDays: number};
  sampleSize: number;
  weekdays: {sampleSize: number; hourCounts: number[]};
  weekends: {sampleSize: number; hourCounts: number[]};
  localDates: string[];
  sources: {id: string; revision: number}[];
}

export interface UserActivityOptions {
  timeZone: string;
  nowMs?: number;
  windowDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 100_000;
const MIN_DATE_MS = -8_640_000_000_000_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

type NormalizedEvent = Required<UserActivityEvent>;

/**
 * Summarize accepted real-user message timestamps without interpreting them as
 * a schedule, preference, psychological trait, or permission to contact.
 */
export function summarizeUserActivity(
  events: readonly UserActivityEvent[],
  options: UserActivityOptions,
): UserActivitySummary {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  if (events.length > MAX_EVENTS) throw new RangeError(`events must contain at most ${MAX_EVENTS} items`);
  if (!options || typeof options !== 'object') throw new TypeError('options are required');
  if (typeof options.timeZone !== 'string' || options.timeZone.length === 0) {
    throw new TypeError('timeZone must be a non-empty IANA time zone');
  }

  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < MIN_DATE_MS || nowMs > MAX_DATE_MS) {
    throw new RangeError('nowMs must be an integer within the JavaScript date range');
  }
  const windowDays = options.windowDays ?? 30;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) {
    throw new RangeError('windowDays must be an integer from 1 to 366');
  }
  const fromMs = nowMs - windowDays * DAY_MS;
  if (fromMs < MIN_DATE_MS) throw new RangeError('activity window falls outside the JavaScript date range');

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: options.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new RangeError(`invalid IANA time zone: ${options.timeZone}`);
  }

  const latestById = new Map<string, NormalizedEvent[]>();
  for (const rawEvent of events) {
    const event = normalizeEvent(rawEvent);
    const revisions = latestById.get(event.id);
    if (!revisions || event.revision > revisions[0].revision) {
      latestById.set(event.id, [event]);
    } else if (event.revision === revisions[0].revision) {
      revisions.push(event);
    }
  }

  const weekdayHours = Array<number>(24).fill(0);
  const weekendHours = Array<number>(24).fill(0);
  const dates = new Set<string>();
  const sources: {id: string; revision: number}[] = [];
  let weekdaySampleSize = 0;
  let weekendSampleSize = 0;

  for (const [id, latest] of latestById) {
    if (!hasOneUnambiguousRevision(latest)) continue;
    const event = latest[0];

    // Resolve revisions before this filter so a deletion or summary revision
    // cannot expose an older accepted message again.
    if (event.role !== 'user' || event.status !== 'accepted' || event.kind !== 'message') continue;
    if (event.acceptedAtMs < fromMs || event.acceptedAtMs > nowMs) continue;

    const parts = formatter.formatToParts(new Date(event.acceptedAtMs));
    const value = (type: Intl.DateTimeFormatPartTypes): string => {
      const part = parts.find(candidate => candidate.type === type);
      if (!part) throw new Error(`time-zone formatter omitted ${type}`);
      return part.value;
    };
    const date = `${value('year')}-${value('month')}-${value('day')}`;
    const weekday = value('weekday');
    const hour = Number(value('hour'));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('invalid local hour from time-zone formatter');

    dates.add(date);
    if (weekday === 'Sat' || weekday === 'Sun') {
      weekendHours[hour]++;
      weekendSampleSize++;
    } else {
      weekdayHours[hour]++;
      weekdaySampleSize++;
    }
    sources.push({id, revision: event.revision});
  }

  sources.sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
  return {
    schema: 'xldb-user-activity-v1',
    timeZone: options.timeZone,
    window: {fromMs, toMs: nowMs, windowDays},
    sampleSize: weekdaySampleSize + weekendSampleSize,
    weekdays: {sampleSize: weekdaySampleSize, hourCounts: weekdayHours},
    weekends: {sampleSize: weekendSampleSize, hourCounts: weekendHours},
    localDates: [...dates].sort(),
    sources,
  };
}

function normalizeEvent(event: UserActivityEvent): NormalizedEvent {
  if (!event || typeof event !== 'object') throw new TypeError('each event must be an object');
  if (typeof event.id !== 'string' || event.id.length === 0 || event.id.length > 512) {
    throw new TypeError('event id must be a non-empty string of at most 512 characters');
  }
  if (!Number.isSafeInteger(event.revision) || event.revision < 0) {
    throw new TypeError('event revision must be a non-negative safe integer');
  }
  if (typeof event.role !== 'string' || typeof event.status !== 'string') {
    throw new TypeError('event role and status must be strings');
  }
  if (!Number.isSafeInteger(event.acceptedAtMs) || event.acceptedAtMs < MIN_DATE_MS || event.acceptedAtMs > MAX_DATE_MS) {
    throw new TypeError('event acceptedAtMs must be an integer within the JavaScript date range');
  }
  const kind = event.kind ?? 'message';
  if (kind !== 'message' && kind !== 'summary') throw new TypeError('event kind must be message or summary');
  return {
    id: event.id,
    revision: event.revision,
    role: event.role,
    status: event.status,
    acceptedAtMs: event.acceptedAtMs,
    kind,
  };
}

function hasOneUnambiguousRevision(revisions: NormalizedEvent[]): boolean {
  const first = revisions[0];
  return revisions.every(event => event.role === first.role
    && event.status === first.status
    && event.acceptedAtMs === first.acceptedAtMs
    && event.kind === first.kind);
}
