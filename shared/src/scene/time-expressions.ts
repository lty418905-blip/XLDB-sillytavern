import {foldForMatch} from '../common/script-fold.ts';
import type { StoryClockDate, StoryClockFullDate, StoryClockTime, StoryClockTimeOfDay, StoryClockStoredAdvanceUnit, StoryClockQuoteSite, StoryClockExcludedReason, StoryClockNowOp } from './story-clock-types.ts';

export type ClockGuardClass = 'recall' | 'reported' | 'hypothetical' | 'plan' | 'habitual';
export interface ParsedClockTime { hour: number; minute: number; nextDay: boolean }
export interface ParsedDate { date: StoryClockDate; time: StoryClockTime | null; timeOfDay: StoryClockTimeOfDay | null; nextDay: boolean }
export type ParsedDuration =
  | { kind: 'minutes'; minutes: number; fuzzy: boolean }                       // > 0, step 0.5, <= 10 years of minutes
  | { kind: 'calendar'; calendarUnit: 'months' | 'years'; calendarAmount: number; fuzzy: boolean }; // > 0, step 0.5, <= 10 years
export type NarrativeCueParse =
  | { kind: 'advance'; value: number; unit: StoryClockStoredAdvanceUnit; fuzzy: boolean }
  | { kind: 'next_day_at'; days: number; time: StoryClockTime | null; timeOfDay: StoryClockTimeOfDay | null; nextDay: boolean }
  | { kind: 'set_time'; time: StoryClockTime | null; timeOfDay: StoryClockTimeOfDay | null }
  | { kind: 'set_date'; date: StoryClockDate; time: StoryClockTime | null; timeOfDay: StoryClockTimeOfDay | null; nextDay: boolean; narrative: boolean };
export type NarrativeCueResult =
  | { ok: true; cue: NarrativeCueParse }
  | { ok: false; reason: 'guard'; guard: ClockGuardClass }
  | { ok: false; reason: 'unresolved' };
export type RelativeFutureParse =
  | { kind: 'after'; minutes: number }                                          // N units 后/内/之内; in/within N units; N units from now
  | { kind: 'day'; dayOffset: number; time: ParsedClockTime | null; timeOfDay: StoryClockTimeOfDay | null } // 今天/明天/后天/大后天, 今晚/明早, tomorrow at 8 pm, reschedules normalised
  | { kind: 'weekday'; weekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; qualifier: 'next' | 'this' | 'none'; time: ParsedClockTime | null; timeOfDay: StoryClockTimeOfDay | null } // Monday = 1
  | { kind: 'date'; date: StoryClockFullDate; time: ParsedClockTime | null; timeOfDay: StoryClockTimeOfDay | null };
export interface OriginScanEntry { table: string; text: string }
export interface OriginCandidate { site: StoryClockQuoteSite; text: string; hasDate: boolean; hasTime: boolean; hasTimeOfDay: boolean }

// Only this operation is exposed, so callers cannot bypass folding with RegExp methods.
const temporalPattern = /计划|打算|准备(?:要)?|将(?:要|来)|明天(?:要|会)?|下次|如果|假如|回忆|想起|曾经|过去(?!了)|那时|当时|以前|\b(?:plan(?:ned|ning)?|will|would|tomorrow|if|remember(?:ed)?|recall(?:ed)?|ago|formerly)\b/iu;
export const legacyTemporalGuard: {readonly source:string;readonly flags:string;test(text:string):boolean} = {
  source:temporalPattern.source, flags:temporalPattern.flags,
  test(text:string):boolean { return temporalPattern.test(foldForMatch(text)); },
};

type Hit<T> = { start: number; end: number; value: T };
type Use = 'narrative' | 'commitment' | 'ooc';
const colons = /:/gu;
function normal(s: string): string {
  const copy = foldForMatch(s);
  // A prose colon keeps its old date-boundary meaning; numeric clock separators share ASCII syntax.
  return copy.replace(colons, (colon, at: number) => s[at] === '：' && !(asciiDigit(copy[at - 1] ?? '') && asciiDigit(copy[at + 1] ?? '')) ? '：' : colon).replace(/’/gu, "'").replace(/İ/gu, 'i').toLowerCase();
}
function input(s: unknown): s is string { return typeof s === 'string' && s.length > 0 && [...s].length <= 500; }
const latinDigit = /[\p{Script=Latin}\p{Nd}]/u;
function boundary(s: string, a: number, b: number): boolean { return !latinDigit.test(s[a - 1] ?? '') && !latinDigit.test(s[b] ?? ''); }
function ordered<T>(hits: Hit<T>[]): Hit<T>[] {
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Hit<T>[] = [];
  let end = -1;
  for (const hit of hits) if (hit.start >= end) { out.push(hit); end = hit.end; }
  return out;
}
function unique<T>(hits: Hit<T>[]): T | null {
  const values = ordered(hits).map(h => h.value);
  if (!values.length) return null;
  const first = JSON.stringify(values[0]);
  return values.every(v => JSON.stringify(v) === first) ? values[0]! : null;
}
function words<T>(s: string, table: readonly (readonly [string, T])[], startOnly = false, normalized = false, suppressOverlap = true): Hit<T>[] {
  const hits: Hit<T>[] = [];
  for (const [raw, value] of table) {
    const word = normalized ? raw : normal(raw);
    let at = startOnly ? s.startsWith(word) ? 0 : -1 : s.indexOf(word);
    while (at !== -1) {
      if (!/[a-z]/u.test(word) || boundary(s, at, at + word.length)) hits.push({ start: at, end: at + word.length, value });
      at = startOnly ? -1 : s.indexOf(word, at + word.length);
    }
  }
  return suppressOverlap ? ordered(hits) : hits;
}
const todRows: readonly [StoryClockTimeOfDay, string][] = [
  ['dawn', '黎明|拂曉|破曉|天亮|天剛亮|天刚亮|日出|清晨|五更|dawn|daybreak|first light|sunrise|break of day'],
  ['morning', '早上|早晨|一早|一大早|大清早|上午|morning|forenoon'],
  ['noon', '中午|正午|晌午|午時|noon|midday|high noon'],
  ['afternoon', '下午|午後|afternoon'],
  ['dusk', '傍晚|黃昏|黄昏|薄暮|日落|天黑|掌燈時分|掌灯时分|dusk|sunset|nightfall|twilight|sundown'],
  ['evening', '晚上|晚間|入夜|今晚|evening'],
  ['night', '夜裡|夜間|夜晚|今夜|night|at night|tonight|late evening'],
  ['late_night', '深夜|夜深|半夜|午夜|子夜|三更|midnight|the small hours|dead of night|late night'],
];
const todTable = todRows.flatMap(([slot, terms]) => terms.split('|').map(term => [normal(term), slot] as const));
function todHits(s: string, startOnly = false): Hit<StoryClockTimeOfDay>[] { return words(s, todTable, startOnly, true); }
export function parseTimeOfDayWord(text: string): StoryClockTimeOfDay | null { return input(text) ? unique(todHits(normal(text))) : null; }

const enNumbers = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'.split(' ');
const tens = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const cnDigits = '零一二三四五六七八九';
const approx: Record<string, number> = { '一两': 1.5, '两三': 2.5, '三四': 3.5, '三五': 4, '四五': 4.5, '五六': 5.5, '七八': 7.5, '十几': 15, '二十几': 25, '几十': 30 };
function numberOf(raw: string): { n: number; fuzzy: boolean } | null {
  let s = normal(raw).replace(/兩/gu, '两').trim();
  if (s in approx) return { n: approx[s]!, fuzzy: true };
  if (/^(?:好几|几|数|數|a few|several)$/u.test(s)) return { n: s === '好几' ? 4 : 3, fuzzy: true };
  let extra = 0, fuzzy = false;
  if (/[多来]$/u.test(s)) { extra = s.endsWith('多') ? 0.5 : 0; fuzzy = true; s = s.slice(0, -1); }
  s = s.replace(/[个個]/gu, '').trim();
  if (s.endsWith('半') && s !== '半') { extra += 0.5; s = s.slice(0, -1); }
  if (s.endsWith(' and a half')) { extra += 0.5; s = s.slice(0, -11).trim(); }
  if (/^\d{1,8}(?:\.\d{1,8})?$/u.test(s)) return { n: Number(s) + extra, fuzzy };
  if (s === '半' || s === 'half' || s === 'half a' || s === 'half an') return { n: 0.5 + extra, fuzzy };
  if (s === 'a' || s === 'an') return { n: 1 + extra, fuzzy };
  if (s === 'a couple' || s === 'a couple of') return { n: 2 + extra, fuzzy };
  const parts = s.split(/[- ]/u);
  const base = enNumbers.indexOf(s);
  if (base > 0) return { n: base + extra, fuzzy };
  const ten = tens.indexOf(parts[0]!);
  if (ten >= 0 && (parts.length === 1 || (parts.length === 2 && enNumbers.indexOf(parts[1]!) > 0 && enNumbers.indexOf(parts[1]!) < 10))) return { n: (ten + 2) * 10 + (parts.length === 2 ? enNumbers.indexOf(parts[1]!) : 0) + extra, fuzzy };
  s = s.replace(/[两〇]/gu, c => c === '两' ? '二' : '零');
  if (!/^[零一二三四五六七八九十百千]{1,12}$/u.test(s)) return null;
  if (s.length > 1 && !/[十百千]/u.test(s)) return null;
  let result = 0, digit = 0, last = 10000;
  for (const c of s) {
    const index = cnDigits.indexOf(c);
    if (index >= 0) digit = index;
    else { const unit = c === '十' ? 10 : c === '百' ? 100 : 1000; if (unit >= last) return null; result += (digit || 1) * unit; digit = 0; last = unit; }
  }
  return { n: result + digit + extra, fuzzy };
}
const enNum = '(?:a couple(?: of)?|a few|several|half(?: an?| a)?|an?|(?:' + [...enNumbers.slice(1), ...tens].join('|') + ')(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|\\d{1,8}(?:\\.\\d{1,8})?)';
const cnNum = '(?:[零〇一二兩两三四五六七八九十百千幾几好數数半]{1,12}|\\d{1,8}(?:\\.\\d{1,8})?)(?:[个個]?[半多來来])?';
const num = '(?:' + enNum + '(?: and a half)?|' + cnNum + ')';
const unitRows: readonly [string, number | 'months' | 'years'][] = [
  ['秒|sec|secs|second|seconds', 1 / 60], ['分鐘|分钟|min|mins|minute|minutes', 1],
  ['小時|小时|鐘頭|钟头|鐘點|钟点|個鐘|个钟|hr|hrs|hour|hours', 60], ['時辰|时辰', 120],
  ['刻鐘|刻钟|刻|quarter of an hour|quarter hour', 15], ['天|日|day|days', 1440],
  ['夜|晚|宿|night|nights', 1440], ['週|周|星期|禮拜|礼拜|week|weeks', 10080], ['fortnight|fortnights', 20160],
  ['個月|个月|月|month|months', 'months'], ['年|year|years', 'years'],
];
const units = unitRows.flatMap(([terms, factor]) => terms.split('|').map(term => [normal(term), factor] as const));
const unitPattern = units.map(([term]) => term).sort((a, b) => b.length - a.length).join('|');
const modifierTerms = ['大約', '大约', '約莫', '约莫', '差不多', '將近', '将近', '近', '整整', '足足', 'about', 'around', 'roughly', 'nearly', 'almost', 'some', 'a good', 'a full', 'just over', 'just under'];
const modifier = '(?:' + modifierTerms.join('|') + ')';
const waitedModifiers = [...modifierTerms].sort((a, b) => b.length - a.length);
// Character loops consume at least one trailing character per step: O(n), n <= 500.
function endsWithWaited(before: string): boolean {
  let end = before.length;
  for (;;) {
    while (end > 0 && before[end - 1]!.trim() === '') end--;
    const term = waitedModifiers.find(word => before.endsWith(word, end) && (word[0]! < 'a' || word[0]! > 'z' || !latinDigit.test(before[end - word.length - 1] ?? '')));
    if (term) { end -= term.length; continue; }
    if (before[end - 1] === '个' || before[end - 1] === '個') { end--; continue; }
    return before.endsWith('等了', end);
  }
}
const bareNumerals = new Set([...enNumbers.slice(1), ...tens, 'hundred', 'thousand', 'dozen', 'dozens', 'couple']);
const bareQuantities = new Set([...bareNumerals, 'a', 'an', 'half', 'several']);
const bareRanges = new Set(['many', 'countless', 'long', 'endless', 'untold', 'numerous']);
const bareDeterminers = new Set(['the', 'these', 'those', 'its', 'his', 'her', 'their', 'my', 'our', 'your', 'of']);
const bareNouns = new Set(['office', 'visiting', 'opening', 'working', 'business', 'school', 'meeting', 'small', 'wee', 'early', 'late', 'peak', 'rush']);
function asciiDigit(c: string): boolean { return c >= '0' && c <= '9'; }
function bareTokenChar(c: string): boolean { return c >= 'a' && c <= 'z' || asciiDigit(c) || c === "'" || c === '-'; }
// Shared inline whitespace: \s minus LF, CR, VT, FF, NEL, LS and PS; O(1) per character.
const inlineSpace = /[^\S\n\r\v\f\u0085\u2028\u2029]/u;
// At most four preceding tokens, separated only by inline whitespace. Every character
// is visited at most four times across bare hits: O(n) total, bounded-entry use only.
function bareBlocked(s: string, unitIndex: number): boolean {
  let end = unitIndex;
  for (let position = 0; position < 4; position++) {
    while (end > 0 && inlineSpace.test(s[end - 1]!)) end--;
    let start = end;
    while (start > 0 && bareTokenChar(s[start - 1]!)) start--;
    if (start === end) return false;
    const token = s.slice(start, end);
    if (token.split('-').filter(part => part.length > 0).some(part => [...part].every(asciiDigit) || bareNumerals.has(part) || position === 0 && (bareQuantities.has(part) || bareRanges.has(part) || bareDeterminers.has(part) || bareNouns.has(part)))) return true;
    end = start;
  }
  return false;
}
// Ranks are years, months, weeks, days, hours, minutes, seconds; other units have no rank.
const compoundRanks = new Map([10, 9, 7, 5, 2, 1, 0].flatMap((row, rank) => unitRows[row]![0].split('|').map(term => [normal(term), rank] as const)));
type DurationValue = {
  parsed: ParsedDuration | null; night: boolean; amount: number; fuzzy: boolean;
  rank?: number; factor?: number | 'months' | 'years'; whole?: boolean;
  modified?: boolean; approximateTail?: boolean; zeroConnector?: boolean;
};
function durationValue(amount: number, factor: number | 'months' | 'years', fuzzy: boolean, night: boolean): DurationValue {
  const rounded = Math.round((typeof factor === 'number' ? amount * factor : amount) * 2) / 2;
  const cap = factor === 'months' ? 120 : factor === 'years' ? 10 : 5_256_000;
  let parsed: ParsedDuration | null = null;
  if (rounded > 0 && rounded <= cap) parsed = typeof factor === 'number' ? { kind: 'minutes', minutes: rounded, fuzzy } : { kind: 'calendar', calendarUnit: factor, calendarAmount: rounded, fuzzy };
  return { parsed, night, amount, fuzzy };
}
type DurationGap = 'adjacent' | 'comma' | 'none';
function compoundGap(s: string, start: number, end: number): DurationGap {
  let left = start, right = end;
  const space = (c: string) => c === ' ' || c === '　';
  while (left < right && space(s[left]!)) left++;
  while (right > left && space(s[right - 1]!)) right--;
  if (left === right) return 'adjacent';
  const connector = s.slice(left, right);
  if (connector === '又' || connector === '零' || connector === '〇') return 'adjacent';
  if (connector === 'and' && left > start && right < end) return 'adjacent';
  if (connector === ',' || connector === '，' || connector === '、') return 'comma';
  return 'none';
}
function compoundValue(a: DurationValue, b: DurationValue): DurationValue {
  const invalid = durationValue(0, 1, false, false);
  if (a.rank === undefined || b.rank === undefined || a.rank >= b.rank) return invalid;
  if (!a.whole || !b.whole || b.modified || a.approximateTail) return invalid;
  if (a.rank === 0 && b.rank === 1) return durationValue(12 * a.amount + b.amount, 'months', false, false);
  if (a.rank < 2 || b.rank < 2) return invalid;
  return durationValue(a.amount * (a.factor as number) + b.amount * (b.factor as number), 1, false, false);
}
// One left-to-right pass after ordering. Each disjoint gap is scanned once, every hit flushed
// once: O(n + hits), n <= 500. Comma-only runs stay separate; a comma neighbor of a compound
// invalidates the whole connected run, including when that neighbor is itself a compound.
function mergeDurations(s: string, hits: Hit<DurationValue>[]): Hit<DurationValue>[] {
  const out: Hit<DurationValue>[] = [];
  let chain: Hit<DurationValue>[] = [], adjacent = false;
  let previous: Hit<DurationValue> | undefined;
  const flush = () => {
    if (!chain.length) return;
    if (!adjacent) out.push(...chain);
    else {
      const value = chain.length === 2 ? compoundValue(chain[0]!.value, chain[1]!.value) : durationValue(0, 1, false, false);
      out.push({ start: chain[0]!.start, end: chain[chain.length - 1]!.end, value });
    }
    chain = []; adjacent = false;
  };
  for (const h of hits) {
    const gap = previous ? compoundGap(s, previous.end, h.start) : 'none';
    if (h.value.zeroConnector && (gap !== 'adjacent' || !chain.length)) { flush(); previous = undefined; continue; }
    if (gap === 'none') flush();
    if (chain.length) adjacent ||= gap === 'adjacent';
    chain.push(h); previous = h;
  }
  flush();
  return out;
}
function durationHits(s: string): Hit<DurationValue>[] {
  const hits: Hit<DurationValue>[] = [];
  // 此正規式在長空白上為平方級，只能由有長度上限的呼叫者使用。
  // Capturing the existing half suffix adds no quantifier or scanning work.
  // The number-to-unit gap (including an optional classifier) stays on one line.
  // Sharing the inline class adds no quantifier; the inherited bound remains O(n²), n <= 500.
  const re = new RegExp('(?:' + modifier + '\\s*)?(' + num + ')' + inlineSpace.source + '*[个個]?' + inlineSpace.source + '*(' + unitPattern + ')(\\s*and a half|半)?(?:左右|上下)?', 'gu');
  for (const m of s.matchAll(re)) {
    const a = m.index, end = a + m[0].length;
    const before = s.slice(Math.max(0, a - 30), a), after = s.slice(end, end + 8);
    if (/[a-z]/u.test(m[0]) && !boundary(s, a, end)) continue;
    if (/\d/u.test(m[1]![0] ?? '') && /[\p{Script=Latin}\d:/.,-]$/u.test(before)) continue;
    if (/^[\d:/-]/u.test(after) || /第\s*$/u.test(before) || /月\s*$/u.test(before) || /(?:hundred|thousand|dozen|long)\s+$/u.test(before)) continue;
    if (m[1] === '半' && m[2] === '天') continue;
    if (m[2] === '晚' && s[end] === '上') continue;
    // Only the fixed two-character form can lend its leading zero to a preceding connector.
    const zeroConnector = /^[零〇][一二三四五六七八九兩两]$/u.test(m[1]!);
    const leadingModifier = modifierTerms.find(term => m[0].startsWith(term));
    const quantityAt = m[0].indexOf(m[1]!, leadingModifier?.length ?? 0);
    const value = numberOf(zeroConnector ? m[1]![1]! : m[1]!); if (!value) continue;
    if (m[1]!.startsWith('half') && m[2] === 'year') continue;
    const halfSuffix = m[3]?.trim();
    const n = value.n + (halfSuffix && !m[1]!.endsWith(halfSuffix) ? 0.5 : 0);
    const factor = units.find(([term]) => term === m[2])![1];
    hits.push({ start: zeroConnector ? a + quantityAt + 1 : a, end, value: {
      ...durationValue(n, factor, value.fuzzy, /^(?:夜|晚|宿|nights?)$/u.test(m[2]!)),
      rank: compoundRanks.get(m[2]!), factor,
      whole: !value.fuzzy && Number.isInteger(n) && n >= 1 && !m[1]!.includes('.') && !m[1]!.includes('半') && !m[1]!.includes('half') && !halfSuffix,
      modified: leadingModifier !== undefined, approximateTail: m[0].endsWith('左右') || m[0].endsWith('上下'), zeroConnector,
    } });
  }
  const fixed: readonly [string, number][] = [['一會兒', 15], ['一会儿', 15], ['一會', 15], ['一会', 15], ['一下', 15], ['片刻', 10], ['少頃', 10], ['少顷', 10], ['須臾', 10], ['须臾', 10], ['半晌', 30], ['一炷香', 30], ['一盞茶', 15], ['一盏茶', 15], ['a short while', 15], ['a little while', 15], ['a while', 30], ['some time', 30], ['a moment', 5], ['moments', 5]];
  for (const h of words(s, fixed)) {
    const term = s.slice(h.start, h.end), before = s.slice(0, h.start), after = s.slice(h.end);
    if (term === '一下' && !( /(?:过了|等了)$/u.test(before) && /^(?:后|了)/u.test(after))) continue;
    if (/^(?:a while|some time|a moment|moments)$/u.test(term) && !(/(?:after)\s+$/u.test(before) || /^\s+later\b/u.test(after))) continue;
    hits.push({ start: h.start, end: h.end, value: durationValue(h.value, 1, true, false) });
  }
  for (const m of s.matchAll(/\b(minutes|hours|days|weeks)\s+later\b/gu)) {
    if (bareBlocked(s, m.index)) continue;
    hits.push({ start: m.index, end: m.index + m[1]!.length, value: durationValue(m[1] === 'minutes' ? 5 : 3, units.find(([term]) => term === m[1])![1], true, false) });
  }
  for (const m of s.matchAll(/(?:一整夜|整晚|一整天)/gu)) hits.push({ start: m.index, end: m.index + m[0].length, value: durationValue(1, 1440, false, m[0] !== '一整天') });
  for (const h of words(s, [['quarter of an hour', 15], ['quarter hour', 15]])) hits.push({ ...h, value: durationValue(h.value, 1, false, false) });
  return mergeDurations(s, ordered(hits));
}
export function parseDuration(text: string): ParsedDuration | null { return input(text) ? unique(durationHits(normal(text)).map(h => ({ ...h, value: h.value.parsed }))) : null; }

const guardRows: readonly [ClockGuardClass, string][] = [
  ['recall', '回忆|回憶|想起|曾经|那时|当时|以前|記得|记得|還記得|还记得|曾|從前|从前|当年|想当年|那年|那天|那晚|那天晚上|那次|上次|上回|早先|早在|之前|小时候|年輕时|年轻时|昨天|昨晚|昨夜|前天|上週|上周|上個月|上个月|去年|前年|ago|back then|back when|back in|used to|once upon|last time|the last time|yesterday|last night|last week|last month|last year|the previous|earlier that|previously|formerly|remember|remembered|recall|recalled|recollect|reminisce|the year i was|the year we was|the year he was|the year she was'],
  ['reported', "等了你|这里待了|i've been waiting|i waited|we've been here for|it's been|it took me"],
  ['hypothetical', '如果|假如|要是|萬一|万一|假設|假设|假使|倘若|若是|就算|即使|除非|否則|否则|本来會|本来会|差点|if|unless|suppose|supposing|in case|what if|had it|were it|otherwise|would have|could have'],
  ['plan', "计划|計劃|計畫|打算|准备|準備|将要|将来|將要|將来|明天|下次|約好|约好|說好|说好|答應|答应|預計|预计|預定|预定|將會|将会|會在|会在|待會|待会|等一下|等會|等会|稍后|之后再|明早|明晚|后天|下週|下周|下個月|下个月|明年|到时|屆时|届时|plan|plans|planned|planning|will|would|shall|going to|gonna|about to|intend|intends|intended|mean to|promise|promised|agreed to|arranged|expect to|expected to|due at|due on|due in|scheduled|tomorrow|tonight|next week|next month|next year"],
  ['habitual', '每天|每日|每晚|每年|每次|每当|總是|总是|常常|经常|往往|平时|平常|習慣|习惯|一向|向来|從不|从不|every day|every night|every morning|every week|every year|each day|always|usually|often|whenever|habitually|tends to|never'],
];
function guard(s: string): ClockGuardClass | null {
  const found = new Set<ClockGuardClass>();
  for (const [kind, terms] of guardRows) if (words(s, terms.split('|').map(w => [w, kind] as const)).length) found.add(kind);
  const ds = durationHits(s);
  for (const m of s.matchAll(/过去(?!了)/gu)) {
    const prefix = s.slice(0, m.index);
    // Fixed alternatives plus one trailing whitespace run: O(prefix length), n <= 500.
    if (!ds.some(h => h.end <= m.index && /^\s*$/u.test(s.slice(h.end, m.index))) && !/(?:許久|许久|良久|很久|好久|半天(?:左右|上下)?)\s*$/u.test(prefix)) found.add('recall');
  }
  for (const h of ds) {
    const before = s.slice(0, h.start), after = s.slice(h.end);
    if (/^\s*(?:之前|以前|前|before\b|earlier\b|prior\b|previously\b)/u.test(after)) found.add('recall');
    if (/^\s*了/u.test(after) && (/(?:已经|来了)[\s\S]*$/u.test(before) || endsWithWaited(before)) && s.slice(h.start, h.end) !== '一下') found.add('reported');
  }
  if (/'ll\b/u.test(s)) found.add('plan');
  for (const m of s.matchAll(/\blater\b/gu)) {
    const before = s.slice(0, m.index), after = s.slice(m.index + 5);
    if (!/(?<![\p{Script=Latin}\p{Nd}])(?:secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|nights?|weeks?|fortnights?|months?|years?|while|time|moments?)\s+$/u.test(before) && !/^\s+that\b/u.test(after) && !(/(?:^|[.!?])\s*$/u.test(before) && /^\s*,/u.test(after)) && !ds.some(h => h.value.parsed !== null && h.end <= m.index && /^\s+$/u.test(s.slice(h.end, m.index)))) found.add('plan');
  }
  for (const m of s.matchAll(/\balmost\b/gu)) if (!(new RegExp('^\\s+' + enNum + '(?![a-z0-9])', 'u')).test(s.slice(m.index + 6))) found.add('hypothetical');
  for (const kind of ['recall', 'reported', 'hypothetical', 'plan', 'habitual'] as const) if (found.has(kind)) return kind;
  return null;
}
export function clockGuardClass(quote: string): ClockGuardClass | null { return input(quote) ? guard(normal(quote)) : null; }
export function excludedReasonForGuard(guard: ClockGuardClass): StoryClockExcludedReason {
  return guard === 'reported' || guard === 'hypothetical' || guard === 'plan' || guard === 'recall' ? guard : 'recall';
}

const conversion = '清晨|早上|早晨|上午|凌晨|中午|下午|傍晚|晚上|黃昏|黄昏|深夜|半夜|午夜|正午';
// Clock tokens have fixed lexical bounds, including the two-character minute form: O(1).
function clockNumber(raw: string): number {
  const value = numberOf(raw);
  return !value || value.fuzzy ? NaN : value.n;
}
function localClock(hour: number, minute: number, period: string): ParsedClockTime | null {
  let nextDay = false;
  if (period === 'am') { if (hour < 1 || hour > 12) return null; hour %= 12; }
  else if (period === 'pm' || period === 'at night' || /in the (?:afternoon|evening)/u.test(period)) { if (hour < 1 || hour > 12) return null; hour = hour % 12 + 12; }
  else if (/^(?:清晨|早上|早晨|上午|凌晨|in the morning)$/u.test(period)) { if (hour >= 12) return null; }
  else if (period === '中午') { if (hour !== 11 && hour !== 12) return null; }
  else if (period === '正午') { if (hour !== 12) return null; }
  else if (/^(?:傍晚|黃昏|黄昏)$/u.test(period)) { if (hour >= 5 && hour <= 7) hour += 12; if (hour < 17 || hour > 19) return null; }
  else if (period === '晚上') { if (hour === 0 || hour === 12) { hour = 0; nextDay = true; } else if (hour < 12) hour += 12; }
  else if (period === '下午') { if (!hour) return null; if (hour < 12) hour += 12; }
  else if (period === '午夜') { if (hour !== 12 && hour !== 0) return null; hour = 0; nextDay = true; }
  else if (/^(?:深夜|半夜)$/u.test(period)) { if (hour > 3 && hour < 21) return null; nextDay = hour < 3; }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute, nextDay };
}
function isoBefore(before: string): boolean {
  let head = before.trimEnd(); let ok = /[ 　]/u.test(before.slice(head.length));
  if (head.endsWith('t')) { head = head.slice(0, -1).trimEnd(); ok = true; }
  return ok && /\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}$/u.test(head);
}
function rawClockHits(s: string, use: Use, isoStart = false, startOnly = false): Hit<ParsedClockTime | null>[] {
  const candidates: Hit<ParsedClockTime | null>[] = [];
  const suffix = "(?:\\s*(a\\.?m\\.?|p\\.?m\\.?|in the morning|in the afternoon|in the evening|at night))?";
  const englishHour = '(?:' + enNumbers.slice(1, 20).join('|') + '|twenty(?:[- ](?:one|two|three))?|\\d{1,2})';
  const bareSuffix = use === 'narrative' ? '(?=\\s*(?:a\\.?m\\.?|p\\.?m\\.?|in the morning|in the afternoon|in the evening|at night)(?![a-z]))' : '';
  const re = new RegExp('(?:at\\s+)?(?:(' + normal(conversion) + ')\\s*)?(?:([0-9]{1,2})([:.])([0-9]{2})(?::[0-9]{2})?|' + '(' + cnNum + ')\\s*(?:点|时(?!辰|间|候|刻))(半|一刻|三刻|整|鐘|钟|(?:' + cnNum + ')分?)?|' + '(half past|quarter past|quarter to)\\s+(' + englishHour + ')|' + '(' + englishHour + ")(?:\\s+o'clock)?" + bareSuffix + ')(' + suffix + ')', startOnly ? 'uy' : 'gu');
  const matches = startOnly ? [re.exec(s)].filter((m): m is RegExpExecArray => m !== null) : s.matchAll(re);
  for (const m of matches) {
    const start = m.index, end = start + m[0].length, before = s.slice(prefixStart(s, start), start), after = s.slice(end);
    const period = m[1] ?? (m[10] ?? '').replace(/\./gu, '').trim();
    let hour = 0, minute = 0, bare = false;
    if (m[2]) { hour = Number(m[2]); minute = Number(m[4]); const iso = isoStart && start === 0 || isoBefore(before); bare = !period && !iso && hour !== 0 && hour <= 12 && !m[2].startsWith('0'); if (m[3] === '.' && !period) { candidates.push({ start, end, value: null }); continue; } }
    else if (m[5]) {
      hour = clockNumber(m[5]);
      const tail = m[6] ?? '', minuteToken = tail.replace(/分$/u, '');
      minute = tail === '半' ? 30 : tail === '一刻' ? 15 : tail === '三刻' ? 45 : /^(?:整|鐘|钟)?$/u.test(tail) ? 0 : /^[零〇][一二三四五六七八九]$/u.test(minuteToken) ? cnDigits.indexOf(minuteToken[1]!) : clockNumber(minuteToken);
      bare = !period;
    }
    else if (m[7]) { hour = clockNumber(m[8]!); minute = m[7] === 'half past' ? 30 : m[7] === 'quarter past' ? 15 : 45; if (m[7] === 'quarter to') hour = (hour + 23) % 24; bare = !period; }
    else { hour = clockNumber(m[9]!); bare = !period; }
    const english = /[a-z]/u.test(m[0]);
    const invalidBoundary = english ? !boundary(s, start, end) || /[a-z]-$/u.test(before) : /[\d:/.-]$/u.test(before) || /^\d/u.test(after);
    const blocked = /差(?:一刻|三刻|[零一二三四五六七八九十百千\d]{1,12}分(?:钟|鐘)?)?\s*$/u.test(before) || /(?:今晚|今夜|明晚|明夜|今早|今晨|明早|明晨|tonight|tomorrow night|this morning|tomorrow morning)\s*(?:at\s*)?$/u.test(before) || (english && new RegExp('^[\\s-]*(?:' + enNum + '|' + unitPattern + ')(?![a-z])', 'u').test(after));
    candidates.push({ start, end, value: invalidBoundary || blocked || use === 'narrative' && bare ? null : localClock(hour, minute, period) });
  }
  for (const h of words(s, [['midnight', 0], ['noon', 12]], startOnly)) candidates.push({ start: h.start, end: h.end, value: { hour: h.value, minute: 0, nextDay: h.value === 0 } });
  return ordered(candidates);
}
function clockHits(s: string, use: Use, startOnly = false): Hit<ParsedClockTime | null>[] { return rawClockHits(s, use, false, startOnly).filter(h => h.value !== null); }
export function parseClockTime(text: string, use: Use): ParsedClockTime | null { return input(text) && ['narrative', 'commitment', 'ooc'].includes(use) ? unique(clockHits(normal(text), use)) : null; }

const months = ['january|jan', 'february|feb', 'march|mar', 'april|apr', 'may', 'june|jun', 'july|jul', 'august|aug', 'september|sept|sep', 'october|oct', 'november|nov', 'december|dec'];
const monthPattern = '(?:' + months.join('|') + ')\\.?';
const ordinals = 'first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth'.split(' ');
const ordinal = '(?:thirty[- ]first|thirtieth|twenty[- ](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|' + ordinals.join('|') + '|\\d{1,2}(?:st|nd|rd|th)?)';
function dayNumber(s: string): number {
  if (/^\d/u.test(s)) return Number(s.replace(/(?:st|nd|rd|th)$/u, ''));
  if (s === 'thirtieth') return 30; if (s === 'thirty-first' || s === 'thirty first') return 31;
  if (/^twenty[- ]/u.test(s)) return 20 + ordinals.indexOf(s.slice(7)) + 1;
  return ordinals.indexOf(s) + 1;
}
function validDay(year: number | null, month: number, day: number): boolean {
  if (year !== null && (year < 1 || year > 9999) || month < 1 || month > 12 || day < 1) return false;
  const leap = year !== null && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
type BaseDay = { date: StoryClockDate; english: boolean };
// Each backward scan consumes only the preceding token/whitespace run: O(n) over matches.
function precedingTens(s: string, start: number): boolean {
  let end = start;
  while (end > 0 && (s[end - 1]!.trim() === '' || s[end - 1] === '-')) end--;
  let at = end;
  while (at > 0 && s[at - 1]! >= 'a' && s[at - 1]! <= 'z') at--;
  return tens.includes(s.slice(at, end));
}
function precededByOn(s: string, start: number): boolean {
  const floor = prefixStart(s, start);
  let end = start;
  while (end > floor && s[end - 1]!.trim() === '') end--;
  return end - floor >= 2 && s.slice(end - 2, end) === 'on' && !latinDigit.test(s[end - 3] ?? '');
}
function baseDates(s: string): Hit<BaseDay | null>[] {
  const out: Hit<BaseDay | null>[] = [];
  const push = (m: RegExpMatchArray, year: number | null, month: number, day: number, english = false) => {
    const start = m.index!, end = start + m[0].length, before = s.slice(Math.max(0, start - 35), start), after = s.slice(end);
    // Anchored test scans at most two whitespace runs separated by a comma;
    // following runs are disjoint between date hits: O(n) total, including unlimited input.
    const bad = /(?:民國|民国|光緒|光绪|西元前|bc|bce)\s*$/u.test(before) || /^\s*(?:bc|bce)\b/u.test(after) || /[\d零〇一二三四五六七八九十百千:/.-]$/u.test(before) || english && (!boundary(s, start, end) || /^\s*(?:,\s*)?['‘]\d\d(?!\d)/u.test(after));
    out.push({ start, end, value: !bad && validDay(year, month, day) ? { date: { year, month, day }, english } : null });
  };
  for (const m of s.matchAll(/(\d{4})\s*([-/.])\s*(\d{1,2})\s*\2\s*(\d{1,2})/gu)) push(m, Number(m[1]), Number(m[3]), Number(m[4]));
  const digitYear = '[零〇一二三四五六七八九]{4}';
  const md = '(?:\\d{1,2}|[一二三四五六七八九十]{1,3}|兩|两)';
  // At most 12 numeral characters/backtracks per start; whitespace runs have bounded starts: O(n).
  const re = new RegExp('(?:(\\d{1,5}|' + digitYear + '|[零〇一二三四五六七八九十百千]{1,12})\\s*年\\s*)?(' + md + ')\\s*月\\s*(' + md + ')\\s*[日号]', 'gu');
  for (const m of s.matchAll(re)) {
    const yr = m[1]; let y: number | null = null;
    if (yr) y = /^\d{4}$/u.test(yr) ? Number(yr) : new RegExp('^' + digitYear + '$', 'u').test(yr) ? Number([...yr].map(c => c === '〇' ? 0 : cnDigits.indexOf(c)).join('')) : -1;
    const cnMd = (v: string): number => /^[两兩]/u.test(v) || !/^\d{1,2}$|^[一二三四五六七八九]$|^十[一二三四五六七八九]?$|^[二三]十[一二三四五六七八九]?$/u.test(v) ? -1 : numberOf(v)?.n ?? -1;
    push(m, y, cnMd(m[2]!), cnMd(m[3]!));
  }
  const weekday = '(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\s*(?:,\\s*)?)?';
  // Captures retain the quantifier structure. Only a two-digit year tests the fixed lookahead
  // branches; each branch scans one disjoint whitespace run per match, for O(n) total work.
  const yearClock = "\\d|:|\\.\\d|\\s*(?:a\\.?m\\.?|p\\.?m\\.?)(?![a-z])|\\s*o'clock|\\s+in the (?:morning|afternoon|evening)|\\s+at night";
  const englishYear = '\\d{3,5}|\\d{2}(?!' + yearClock + ')';
  const enRe = new RegExp(weekday + '(?:(' + monthPattern + ')\\s+(the\\s+)?(' + ordinal + ')|(the\\s+)?(' + ordinal + ')\\s+(of\\s+)?(' + monthPattern + '))(?:(?:\\s*,\\s+|\\s+)(' + englishYear + '))?', 'gu');
  for (const m of s.matchAll(enRe)) {
    const monthToken = m[1] ?? m[7]!, ordinalToken = m[3] ?? m[5]!;
    const monthName = monthToken.replace(/\.$/u, '');
    const month = months.findIndex(names => names.split('|').includes(monthName)) + 1;
    const spelled = !/^\d/u.test(ordinalToken);
    if (spelled) {
      if (precedingTens(s, m.index + m[0].indexOf(ordinalToken))) continue;
      if (m[1]) {
        if (!m[2]) {
          if (monthToken !== months[month - 1]!.split('|')[0]) continue;
        }
        // Both month-first spelled shapes reuse the bounded-prefix scan: O(n) total.
        if ((monthName === 'may' || monthName === 'march') && !(precededByOn(s, m.index) || m[8]?.length === 4)) continue;
      } else if (!m[6]) continue;
    }
    const y = m[8] ? m[8].length === 4 ? Number(m[8]) : -1 : null;
    push(m, y, month, dayNumber(ordinalToken), true);
  }
  return ordered(out);
}
function plainTime(t: ParsedClockTime | null): StoryClockTime | null { return t ? { hour: t.hour, minute: t.minute } : null; }
type Attached = { time: ParsedClockTime | null; slot: StoryClockTimeOfDay | null; end: number; invalid: boolean };
function attach(s: string, end: number, use: Use, isoDate = false, limit = s.length): Attached {
  s = s.slice(0, limit);
  if (!s.slice(end).trim()) return { time: null, slot: null, end, invalid: false };
  const rest = s.slice(end), connector = /^(?:[ \u3000]*[,，、]?[ \u3000]*(?:at\s+|in the\s+|的)?)/u.exec(rest)![0];
  let at = end + connector.length;
  const separator = isoDate && /^[ \u3000]*$/u.test(connector) ? /^t(?=\s*\d)\s*/u.exec(s.slice(at))?.[0] ?? '' : '';
  at += separator.length;
  const slots = todHits(s.slice(at), true); const sh = slots.find(h => h.start === 0);
  const isoStart = isoDate && /^[ \u3000]*$/u.test(connector) && (separator.length > 0 || /[ \u3000]/u.test(connector));
  const clocks = rawClockHits(s.slice(at), use, isoStart, true); let ch = clocks.find(h => h.start === 0);
  if (ch && !ch.value) {
    if (use === 'narrative') { const bare = rawClockHits(s.slice(at), 'commitment', isoStart, true).find(h => h.start === 0); if (bare?.value) return { time: null, slot: null, end: at + ch.end, invalid: false }; }
    return { time: null, slot: null, end: at + ch.end, invalid: true };
  }
  let slot: StoryClockTimeOfDay | null = null;
  if (sh) {
    slot = sh.value;
    if (!ch || ch.end < sh.end) { const next = at + sh.end; const space = /^\s*/u.exec(s.slice(next))![0].length; const following = clockHits(s.slice(next + space), use, true).find(h => h.start === 0); if (following) ch = { ...following, start: 0, end: sh.end + space + following.end }; }
  }
  if (ch) { if (!slot) slot = unique(todHits(s.slice(at, at + ch.end))); return { time: ch.value, slot, end: at + ch.end, invalid: false }; }
  if (sh) return { time: null, slot, end: at + sh.end, invalid: false };
  // In a narrative combination a bare clock is consumed but does not supply a time.
  if (use === 'narrative') { const bare = clockHits(s.slice(at), 'commitment', true).find(h => h.start === 0); if (bare) return { time: null, slot: null, end: at + bare.end, invalid: false }; }
  return { time: null, slot: null, end, invalid: false };
}
// Bound meaningful prefix characters without limiting the allowed whitespace.
function prefixStart(s: string, end: number): number {
  let at = end, count = 0;
  while (at > 0 && count < 40) { at--; if (!/\s/u.test(s[at]!)) count++; }
  return at;
}
const dateSlotPrefix = new RegExp('(?:^|\\b)(?:on\\s+)?the\\s+(' + todTable.map(([term]) => term).join('|') + ')\\s+of\\s*$', 'u');
function dateHits(s: string, use: Use = 'narrative'): Hit<ParsedDate>[] {
  const hits: Hit<ParsedDate>[] = [];
  const bases = baseDates(s);
  for (let i = 0; i < bases.length; i++) {
    const h = bases[i]!;
    if (!h.value) continue;
    let start = h.start;
    const offset = prefixStart(s, start), before = s.slice(offset, start);
    const prefix = dateSlotPrefix.exec(before);
    const slot = prefix ? todTable.find(([term]) => term === prefix[1])![1] : null;
    if (prefix) start = offset + prefix.index;
    const attached = attach(s, h.end, use, /^\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}$/u.test(s.slice(h.start, h.end)), bases[i + 1]?.start ?? s.length);
    if (attached.invalid) continue;
    hits.push({ start, end: attached.end, value: { date: h.value.date, time: plainTime(attached.time), timeOfDay: attached.slot ?? slot, nextDay: attached.time?.nextDay ?? false } });
  }
  return ordered(hits);
}
export function parseStoryDate(text: string): ParsedDate | null { return input(text) ? unique(dateHits(normal(text))) : null; }
const narrativeTerms = ['今天是', '今日是', '这天是', '此时已是', '轉眼已是', '转眼已是', '这一天是', '现在是', '此刻是', '已经是', '日子来到', '时间来到', 'today is', 'today was', 'it is now', 'it was now', 'it was the morning of', 'it was the evening of', 'it was the afternoon of', 'it was the night of', 'the date was', 'the day was', 'it was now the', 'by now it was'];
function narrativeDate(s: string): boolean {
  // Fixed vocabulary collection is O(n); preserve overlapping markers only for this caller.
  const dates = dateHits(s), bases = baseDates(s), markers = words(s, narrativeTerms.map(w => [w, true] as const), false, false, false);
  for (const h of dates) {
    const before = s.slice(0, h.start), after = s.slice(h.end);
    const base = bases.find(b => b.value && b.start >= h.start && b.end <= h.end)!;
    const plain = base.start === h.start;
    if (/(?:^|[.!?])\s*$/u.test(before) && (!/^on\s/u.test(s.slice(h.start)) && /^\s+(?:had\s+)?dawned\b/u.test(after) || plain && /^\s+had arrived\b/u.test(after))) return true;
    const zh = /^的/u.test(s.slice(base.end)) && todHits(s.slice(base.end + 1), true).some(t => t.start === 0 && !/[a-z]/u.test(s.slice(base.end + 1, base.end + 1 + t.end)));
    const special = zh ? words(s.slice(0, base.start), [['这是', true]]) : [];
    let near: Hit<boolean> | null = null;
    for (const w of [...markers, ...special]) if (w.end <= base.start && (!near || w.end > near.end)) near = w;
    for (const w of near ? [near] : []) {
      const gap = s.slice(w.end, base.start);
      const tokens = unitTokens(gap);
      if (!/[。！？；;!?\n]/u.test(gap) && tokens.filter(t => t.u === 1 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(gap.slice(t.start, t.end))).length <= 6 && tokens.filter(t => t.u === 1.5 || t.u === 1 && /\p{Nd}/u.test(gap.slice(t.start, t.end))).length <= 3) return true;
    }
  }
  return false;
}
export function isNarrativeDateQuote(quote: string): boolean { return input(quote) && narrativeDate(normal(quote)); }

const setRows: readonly [StoryClockTimeOfDay, string][] = [
  ['evening', '当晚|当天晚上|入夜后|到了晚上|that evening|later that evening|by evening'], ['night', '当夜|that night|later that night'],
  ['afternoon', '当天下午|that afternoon|later that afternoon'], ['dusk', '当天傍晚|天黑后|傍晚时分|at dusk|by nightfall|at nightfall|as night fell|when night fell'],
  ['dawn', '天亮时|天亮后|天一亮|破晓时|黎明时分|at dawn|by dawn|when dawn broke|as the sun rose'], ['noon', '到了中午|by noon|at noon'],
  ['late_night', '夜深了|午夜时分|by midnight|at midnight'], ['morning', 'by morning|when morning came|come morning'],
];
function nextHits(s: string, use: Use): Hit<Extract<NarrativeCueParse, { kind: 'next_day_at' }>>[] {
  const terms = '第二天|次日|翌日|隔天|隔日|the next day|next day|the following day|the day after|the morrow|the next morning|next morning|the following morning|the morning after|next afternoon|next evening|next night'.split('|');
  const hits: Hit<Extract<NarrativeCueParse, { kind: 'next_day_at' }>>[] = [];
  for (const h of words(s, terms.map(w => [w, 1] as const))) {
    const a = attach(s, h.end, use);
    if (a.invalid && use !== 'narrative') continue;
    const term = s.slice(h.start, h.end), slot = unique(todHits(term));
    hits.push({ start: h.start, end: a.end, value: { kind: 'next_day_at', days: 1, time: plainTime(a.time), timeOfDay: a.slot ?? slot ?? (a.time ? null : 'morning'), nextDay: a.time?.nextDay ?? false } });
  }
  return hits;
}
function advances(s: string): Hit<NarrativeCueParse>[] {
  const out: Hit<NarrativeCueParse>[] = [];
  for (const h of durationHits(s)) {
    const before = s.slice(0, h.start), after = s.slice(h.end);
    const pre = /(?:又过了|过了|经过|再过|轉眼|转眼|一晃|等了)(?:\s*)$/u.exec(before) ?? /after\s+$/u.exec(before);
    const post = /^(?:\s*)(?:之后|过后|以后|过去了|过去|后|了|later\b|after that\b|afterwards\b|had passed\b|passed\b|had gone by\b|went by\b|elapsed\b|on\b)/u.exec(after);
    if (!pre && !post || pre?.[0].trim() === '等了' && s.slice(h.start, h.end) !== '一下' && !post) continue;
    if (/(?:\bin|\bfor|\bwithin)\s+$/u.test(before)) continue;
    const d = h.value.parsed; if (!d) continue;
    const start = pre ? h.start - pre[0].length : h.start, end = h.end + (post?.[0].length ?? 0);
    if (h.value.night) { if (h.value.fuzzy || !Number.isInteger(h.value.amount) || h.value.amount < 1) continue; out.push({ start, end, value: { kind: 'next_day_at', days: h.value.amount, time: null, timeOfDay: 'morning', nextDay: false } }); }
    else if (/^的早上/u.test(s.slice(end)) && d.kind === 'minutes' && d.minutes % 1440 === 0 && !d.fuzzy && /天/u.test(s.slice(h.start, h.end))) out.push({ start, end: end + 3, value: { kind: 'next_day_at', days: d.minutes / 1440, time: null, timeOfDay: 'morning', nextDay: false } });
    else out.push({ start, end, value: { kind: 'advance', value: d.kind === 'minutes' ? d.minutes : d.calendarAmount, unit: d.kind === 'minutes' ? 'minutes' : d.calendarUnit, fuzzy: d.fuzzy } });
  }
  return out;
}
export function parseNarrativeCue(quote: string): NarrativeCueResult {
  if (!input(quote)) return { ok: false, reason: 'unresolved' };
  const s = normal(quote), g = guard(s);
  if (g) return { ok: false, reason: 'guard', guard: g };
  const hits: Hit<NarrativeCueParse>[] = [...advances(s), ...nextHits(s, 'narrative')];
  const dated = dateHits(s), narrative = dated.length > 0 && narrativeDate(s);
  for (const h of dated) hits.push({ ...h, value: { kind: 'set_date', ...h.value, narrative } });
  for (const h of words(s, setRows.flatMap(([slot, list]) => list.split('|').map(w => [w, slot] as const)))) hits.push({ ...h, value: { kind: 'set_time', time: /(?:at|by) noon$/u.test(s.slice(h.start, h.end)) ? { hour: 12, minute: 0 } : /(?:at|by) midnight$/u.test(s.slice(h.start, h.end)) ? { hour: 0, minute: 0 } : null, timeOfDay: h.value } });
  for (const h of clockHits(s, 'narrative')) hits.push({ ...h, value: { kind: 'set_time', time: plainTime(h.value), timeOfDay: unique(todHits(s.slice(h.start, h.end))) } });
  const cue = unique(hits);
  return cue ? { ok: true, cue } : { ok: false, reason: 'unresolved' };
}

function fullAttachment(s: string, end: number, fallback: StoryClockTimeOfDay | null = null): Attached | null {
  const a = attach(s, end, 'commitment');
  if (a.invalid) return null;
  if (s.slice(a.end).trim()) return null;
  return { ...a, slot: a.slot ?? fallback };
}
function dayClock(t: ParsedClockTime | null, slot: StoryClockTimeOfDay | null, special: boolean): ParsedClockTime | null {
  if (!t || !special) return t;
  if (slot === 'morning') return t.hour < 12 ? t : null;
  if (slot === 'night' || slot === 'evening') { if (t.hour === 0 || t.hour === 12) return { hour: 0, minute: t.minute, nextDay: true }; if (t.hour >= 5 && t.hour <= 11) return { ...t, hour: t.hour + 12 }; if (t.hour < 17) return null; }
  return t;
}
export function parseRelativeFuture(text: string): RelativeFutureParse | null {
  if (!input(text)) return null;
  const s = normal(text).trim();
  if (guard(s) === 'recall') return null;
  // Character-class substitutions add no quantifiers; these entry points remain capped at 500.
  const reschedule = /^(今天|明天)([\s\S]+?)(?:改[为為]|改到|改成|[調调]整[为為]|[調调]整到|換成|换成)([\s\S]+)$/u.exec(s);
  if (reschedule) {
    const old = fullAttachment(reschedule[2]!, 0); if (!old?.time) return null;
    let tail = reschedule[3]!;
    if (!todHits(tail).length && old.slot) { const period = old.slot === 'afternoon' ? '下午' : old.slot === 'evening' ? '晚上' : old.slot === 'morning' ? '上午' : ''; tail = period + tail; }
    const next = fullAttachment(tail, 0); if (!next?.time) return null;
    return { kind: 'day', dayOffset: reschedule[1] === '明天' ? 1 : 0, time: next.time, timeOfDay: next.slot ?? old.slot };
  }
  const dayWords: readonly [string, readonly [number, StoryClockTimeOfDay | null, boolean]][] = [
    ['今天', [0, null, false]], ['今日', [0, null, false]], ['明天', [1, null, false]], ['明日', [1, null, false]], ['后天', [2, null, false]], ['大后天', [3, null, false]],
    ['今晚', [0, 'evening', true]], ['今夜', [0, 'night', true]], ['明晚', [1, 'evening', true]], ['明夜', [1, 'night', true]], ['今早', [0, 'morning', true]], ['今晨', [0, 'morning', true]], ['明早', [1, 'morning', true]], ['明晨', [1, 'morning', true]],
    ['today', [0, null, false]], ['tonight', [0, 'night', true]], ['this evening', [0, 'evening', false]], ['this afternoon', [0, 'afternoon', false]], ['this morning', [0, 'morning', true]], ['tomorrow', [1, null, false]], ['the day after tomorrow', [2, null, false]], ['tomorrow morning', [1, 'morning', true]], ['tomorrow afternoon', [1, 'afternoon', false]], ['tomorrow evening', [1, 'evening', false]], ['tomorrow night', [1, 'night', true]],
  ];
  const dh = words(s, dayWords).find(h => h.start === 0);
  if (dh) { const a = fullAttachment(s, dh.end, dh.value[1]); if (!a) return null; const time = dayClock(a.time, dh.value[1], dh.value[2]); if (a.time && !time) return null; return { kind: 'day', dayOffset: dh.value[0], time, timeOfDay: a.slot }; }
  const weekday = /^(?:(下|本|这)?(?:周|週|星期|禮拜|礼拜)([一二三四五六日天])|(?:(next|this|on)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday))/u;
  // Chinese weekday endings do not use the Latin boundary assertion.
  const wm = weekday.exec(s);
  if (wm) { const a = fullAttachment(s, wm[0].length); if (!a) return null; const day = wm[2] ? '一二三四五六日天'.indexOf(wm[2]) + 1 : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].indexOf(wm[4]!) + 1; return { kind: 'weekday', weekday: (day === 8 ? 7 : day) as 1|2|3|4|5|6|7, qualifier: wm[1] === '下' || wm[3] === 'next' ? 'next' : wm[1] === '本' || wm[1] === '这' || wm[3] === 'this' ? 'this' : 'none', time: a.time, timeOfDay: a.slot }; }
  const dates = dateHits(s, 'commitment');
  const date = dates.find(h => (h.start === 0 || /^on\s+$/u.test(s.slice(0, h.start))) && !s.slice(h.end).trim());
  if (date && date.value.date.year !== null) return { kind: 'date', date: date.value.date as StoryClockFullDate, time: date.value.time ? { ...date.value.time, nextDay: date.value.nextDay } : null, timeOfDay: date.value.timeOfDay };
  const ds = durationHits(s); const h = ds.length === 1 ? ds[0] : null;
  if (h?.value.parsed?.kind === 'minutes' && !h.value.fuzzy && !h.value.night) {
    const before = s.slice(0, h.start), after = s.slice(h.end);
    if (/^(?:in|within)\s+$/u.test(before) && !after.trim() || !before.trim() && /^(?:后|[内內]|之[内內]|以[内內]|\s+from now)$/u.test(after)) return { kind: 'after', minutes: h.value.parsed.minutes };
  }
  return null;
}
export function parseOocTimeStatement(text: string): StoryClockNowOp | null {
  if (!input(text)) return null;
  const s = normal(text).trim().replace(/[。！？!?.]+\s*$/u, '').trim();
  const advance = /^(?:跳到|跳过|快进|skip ahead\s+|skip\s+|fast forward\s+)([\s\S]+)$/u.exec(s);
  if (advance) {
    const body = advance[1]!.replace(/后$/u, '').trim(), hs = durationHits(body), h = hs.length === 1 ? hs[0] : null;
    const d = h?.value.parsed; if (!h || h.start !== 0 || h.end !== body.length || !d || d.fuzzy || h.value.night) return null;
    const minutes = d.kind === 'minutes' ? d.minutes : d.calendarAmount * (d.calendarUnit === 'months' ? 43200 : 525600);
    for (const [unit, factor] of [['days', 1440], ['hours', 60], ['minutes', 1]] as const) if (Number.isInteger(minutes / factor) && minutes / factor >= 1) return { op: 'advance', amount: minutes / factor, unit };
    return null;
  }
  const statement = /^(?:现在是|it's (?:now )?|it is (?:now )?|set the date to )([\s\S]+?)(?:\s+now)?$/u.exec(s);
  if (!statement) return null;
  const body = statement[1]!.trim(), dates = dateHits(body, 'ooc');
  const date = dates.find(h => h.start === 0 && h.end === body.length);
  if (date) return { op: 'set_datetime', date: date.value.date, time: date.value.time, timeOfDay: date.value.timeOfDay };
  if (s.startsWith('set the date to ')) return null;
  const next = nextHits(body, 'ooc').find(h => h.start === 0 && h.end === body.length);
  if (next) return { op: 'next_day_at', days: next.value.days, time: next.value.time, timeOfDay: next.value.timeOfDay };
  const clock = clockHits(body, 'ooc').find(h => h.start === 0 && h.end === body.length);
  if (clock?.value) return { op: 'set_time', time: plainTime(clock.value)! };
  const slot = todHits(body).find(h => h.start === 0 && h.end === body.length);
  return slot ? { op: 'set_time_of_day', timeOfDay: slot.value } : null;
}
export function isOocTimeQuestion(text: string): boolean { return input(text) && words(normal(text), ['几点', '什么时候', '甚么时候', '第几天', '现在时间', '现在几号', 'what time', 'what day', 'how long', "what's the date"].map(w => [w, true] as const)).length > 0; }

type UnitToken = { start: number; end: number; u: number };
function unitTokens(s: string): UnitToken[] {
  const tokens: UnitToken[] = [];
  const re = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['’\-]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*|\p{Nd}+|[\s\S]/gu;
  for (const m of s.matchAll(re)) tokens.push({ start: m.index, end: m.index + m[0].length, u: /\p{Script=Latin}/u.test(m[0][0]!) ? 1.5 : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Nd}]/u.test(m[0]) ? 1 : 0 });
  return tokens;
}
export function measureUnits(text: string): number { return typeof text === 'string' ? unitTokens(text).reduce((sum, t) => sum + t.u, 0) : 0; }
function windowText(text: string, firstDate?: Hit<ParsedDate>): string {
  const tokens = unitTokens(text);
  if (tokens.reduce((sum, t) => sum + t.u, 0) <= 300) return text;
  const s = normal(text), center = firstDate ?? clockHits(s, 'narrative')[0] ?? todHits(s)[0];
  if (!center) return text;
  let l = tokens.findIndex(t => t.end > center.start), r = tokens.findIndex(t => t.end >= center.end);
  let total = tokens.slice(l, r + 1).reduce((sum, t) => sum + t.u, 0), left = true, right = true;
  while (left || right) {
    if (left) { if (l === 0 || total + tokens[l - 1]!.u > 300) left = false; else { l--; total += tokens[l]!.u; } }
    if (right) { if (r === tokens.length - 1 || total + tokens[r + 1]!.u > 300) right = false; else { r++; total += tokens[r]!.u; } }
  }
  return text.slice(tokens[l]!.start, tokens[r]!.end);
}
export function scanOriginCandidates(opening: string | null, entries: readonly OriginScanEntry[]): readonly OriginCandidate[] {
  const sites: { text: string; site: StoryClockQuoteSite }[] = [];
  if (typeof opening === 'string') sites.push({ text: opening, site: { location: 'opening', table: null } });
  if (Array.isArray(entries)) for (const entry of entries) {
    if (!entry) continue;
    const table = entry.table, text = entry.text;
    if (typeof table === 'string' && typeof text === 'string' && !/^initialization\/(example_dialogue|future_idea)(\/|$)/u.test(table)) sites.push({ text, site: { location: 'initialization', table } });
  }
  const out: OriginCandidate[] = [];
  for (const item of sites) {
    const s = normal(item.text), englishDates = baseDates(s).filter(h => h.value?.english);
    let begin = 0, dateIndex = 0;
    for (let i = 0; i <= item.text.length; i++) {
      while (dateIndex < englishDates.length && englishDates[dateIndex]!.end <= i) dateIndex++;
      const commaInDate = item.text[i] === ',' && englishDates[dateIndex] && englishDates[dateIndex]!.start < i && i < englishDates[dateIndex]!.end;
      if (i !== item.text.length && (!/[。！？\n；;，,!?]/u.test(item.text[i]!) || commaInDate)) continue;
      const segment = item.text.slice(begin, i).trim(); begin = i + 1; if (!segment) continue;
      const ns = normal(segment), dates = dateHits(ns);
      if (!dates.length && !clockHits(ns, 'narrative').length && !todHits(ns).length) continue;
      const text = windowText(segment, dates[0]), norm = normal(text);
      out.push({ site: { location: item.site.location, table: item.site.table }, text, hasDate: dateHits(norm).length > 0, hasTime: clockHits(norm, 'narrative').length > 0, hasTimeOfDay: todHits(norm).length > 0 });
      if (out.length >= 20) return out;
    }
  }
  return out;
}
