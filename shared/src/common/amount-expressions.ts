import {foldForMatch} from './script-fold.ts';

export type AmountUnit = {kind: 'yuan'} | {kind: 'named'; word: string} | null;
/** Units are already folded, without yuan-family spellings, longest first. */
export interface Options {units?: readonly string[]}
export type Reading = {cents: bigint; end: number};
export type AmountExpression = {start: number; end: number; unit: AmountUnit; bare: boolean} & (
  | {kind: 'readings'; readings: Reading[]; approx: boolean}
  | {kind: 'range'; min: bigint | null; max: bigint | null; approx: true});
export type QuantityExpression = {start: number; end: number} & (
  | {kind: 'exact'; count: number}
  | {kind: 'range'; min: number | null; max: number | null; approx: true}
  | {kind: 'unsupported'; reason: 'fraction'});
export type RateExpression = {start: number; end: number} & (
  | {kind: 'exact'; numerator: bigint; denominator: bigint}
  | {kind: 'range'; min: bigint | null; max: bigint | null; denominator: bigint; approx: true});

// Closed spelling tables, built once. No state is retained between calls.
const SMALL = '一二三四五六七八九';
const CAPITAL = '壹贰叁参肆伍陆柒捌玖拾佰仟';
const D = new Set('0123456789零一二三四五六七八九两十百千万亿廿卅卌几' + CAPITAL);
const R = new Set('0123456789零一二三四五六七八九两十百千万亿廿卅卌几半俩仨');
const U: Readonly<Record<string, bigint>> = {十: 10n, 百: 100n, 千: 1000n, 万: 10000n, 亿: 100000000n};
const BIG_SECTIONS = [['亿', 100000000n], ['万', 10000n]] as const;
const MISSING_COEFFICIENT = new Set(['百', '千', '万']);
const YUAN_WORDS = new Set(['元', '圆', '块']);
const CAPITAL_FOLD: Readonly<Record<string, string>> = {
  壹: '一', 贰: '二', 叁: '三', 参: '三', 肆: '四', 伍: '五', 陆: '六', 柒: '七', 捌: '八', 玖: '九', 拾: '十', 佰: '百', 仟: '千',
};
const M = new Set('吧啦喔哦呢了啊呀嘛啰咯');
const Q = new Set('个位名员人口户家头匹条张片页篇份本册卷部套副双件柄根枝支杆颗粒枚锭朵株棵丛座栋幢间扇面堵道辆艘架台盏幅句段节项笔桩宗味帖剂丸瓣滴股缕样种类具处组队些群堆排列串束捆袋盒箱罐桶壶瓶杯碗盘碟锅篮筐坛缸勺匙桌席叠沓餐斤克吨磅尺寸丈里米亩顷斗石度趟遍番阵声步眼拳脚剑枪箭招式圈轮顿倍');
const Q_WORDS = ['公斤', '公里', '公分', '公尺', '公升', '公克', '公吨', '公顷', '公亩', '毫升', '毫米', '毫克', '厘米', '平米'];
const T = new Set('年月日号天周旬季夜世点时分秒刻次级届期版章集档线岁楼层室');
const T_WORDS = ['小时', '星期', '礼拜'];
const EXCEPTIONS = ['本钱', '本金', '本来', '人民币', '人家', '人工', '根本', '台币', '餐费', '套餐', '支付', '支出', '头期', '日元', '日圆', '日币', '月租', '月薪', '月供', '年费', '年薪'];
const PAIRS = new Set(['一二', '一两', '二三', '两三', '三四', '四五', '五六', '六七', '七八', '八九', '三五']);
const UP = new Set(['百', '千', '万', '亿', '十万', '百万', '千万', '十亿', '百亿', '千亿', '万亿']);
type Modifier = 'point' | 'lower' | 'upper' | 'more' | 'head';
const PREFIXES: readonly (readonly [string, Modifier])[] = [
  ['不超过', 'upper'], ['差不多', 'point'], ['大概', 'point'], ['大约', 'point'], ['约莫', 'point'],
  ['将近', 'point'], ['接近', 'point'], ['至少', 'lower'], ['最少', 'lower'], ['起码', 'lower'],
  ['不止', 'lower'], ['超过', 'lower'], ['不到', 'upper'], ['最多', 'upper'], ['至多', 'upper'],
  ['顶多', 'upper'], ['约', 'point'], ['近', 'point'], ['快', 'point'],
];
const SUFFIXES: readonly (readonly [string, Modifier])[] = [
  ['左右', 'point'], ['上下', 'point'], ['以上', 'lower'], ['开外', 'lower'], ['以下', 'upper'],
  ['以内', 'upper'], ['之内', 'upper'], ['有找', 'upper'], ['出头', 'head'],
];
const LETTER = /\p{L}/u;
const LATIN = /[A-Za-z]/;
const TRIM = /[\s\p{Pi}\p{Pf}\p{Ps}\p{Pe}，。！？、；：,;:!?…“”‘’「」『』]/u;
const PUNCT = /[，。！？、；：,;:!?…\p{Pf}\p{Pe}\n\r]/u;
const ARABIC = /^(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?$/;
const CENTS_TAIL = /^[一二三四五六七八九]十[一二三四五六七八九]?$/;
const DECIMAL_RATE = /^[0-9]\.[0-9]$/;
const ARABIC_RATE = /^[1-9]{2}$/;
const SIGNS = new Set(['+', '-', '＋', '－', '−', '负', '$', '＄']);
const AMOUNT_CONNECT = new Set('到至-~～—、');
const QUANTITY_CONNECT = new Set('到至-~～');
const W = (c: string | undefined) => c === ' ' || c === '\t' || c === '　';
const digit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const small = (c: string | undefined): bigint | null => {
  if (!c || c.length !== 1) return null;
  if (c >= '1' && c <= '9') return BigInt(c);
  const at = SMALL.indexOf(c);
  return at < 0 ? null : BigInt(at + 1);
};
const numberChar = (c: string | undefined) => c !== undefined && (D.has(c) || '半俩仨'.includes(c));

interface Field {start: number; end: number; capital: boolean}
interface Context {
  text: string; fields: Field[]; ends: Int32Array; right: Int32Array; left: Int32Array;
  ordinal: Uint8Array; units: readonly string[]; work: number;
}
/** Test/diagnostic instrumentation only, not a product API. Counts character visits and probes per call. */
export interface WorkResult<T> {result: T; work: number}

// O(n): normalization, lexical fields, whitespace jumps and clause flags each visit input once.
function context(input: string, o?: Options): Context {
  const folded = foldForMatch(input), parts: string[] = [];
  for (let i = 0; i < folded.length; i++) {
    const c = folded[i]!;
    parts.push(c === '〇' || c === '○' ? '零' : c === '．' && digit(folded[i - 1]) && digit(folded[i + 1]) ? '.' : c);
  }
  const text = parts.join(''), n = text.length, fields: Field[] = [];
  const ends = new Int32Array(n + 1), right = new Int32Array(n + 1), left = new Int32Array(n + 1), ordinal = new Uint8Array(n + 1);
  let work = n * 4, clauseOrdinal = false;
  for (let i = 0; i < n; i++) {
    if (PUNCT.test(text[i]!) || text[i] === '.' && !digit(text[i + 1])) clauseOrdinal = false;
    if (text[i] === '第' && D.has(text[i + 1]!)) clauseOrdinal = true;
    ordinal[i] = clauseOrdinal ? 1 : 0;
    left[i + 1] = W(text[i]) ? left[i]! : i + 1;
    if (!numberChar(text[i])) continue;
    const start = i;
    let capital = false;
    while (i < n && (numberChar(text[i]) || (text[i] === '.' || text[i] === ',') && digit(text[i - 1]) && digit(text[i + 1]))) {
      capital ||= CAPITAL.includes(text[i]!);
      work++;
      i++;
    }
    fields.push({start, end: i, capital});
    for (let j = start; j < i; j++) {ends[j] = i; work++;}
    // The skipped positions still need whitespace and ordinal metadata.
    for (let j = start + 1; j < i; j++) {left[j + 1] = j + 1; ordinal[j] = clauseOrdinal ? 1 : 0; work++;}
    i--;
  }
  right[n] = n;
  for (let i = n - 1; i >= 0; i--) right[i] = W(text[i]) ? right[i + 1]! : i;
  let units: readonly string[] = [];
  // Options can contain throwing getters/proxies. Invalid options produce no configured units.
  try {
    const candidate = o?.units;
    if (Array.isArray(candidate)) {
      const copy: string[] = [], length = candidate.length;
      if (Number.isSafeInteger(length) && length >= 0 && length <= 0xffffffff) {
        work += length;
        for (let index = 0; index < length; index++) {
          const word: unknown = candidate[index];
          if (typeof word === 'string' && word.length > 0 && !YUAN_WORDS.has(word)) copy.push(word);
        }
      }
      units = copy;
    }
  } catch {units = [];}
  return {text, fields, ends, right, left, ordinal, units, work};
}
function starts(c: Context, at: number, word: string): boolean {c.work += word.length; return c.text.startsWith(word, at);}
function z(c: Context, at: number): boolean {
  const s = c.text;
  c.work++;
  if (at >= s.length || !LETTER.test(String.fromCodePoint(s.codePointAt(at)!)) && !numberChar(s[at])) return true;
  let p = at;
  while (p < at + 2 && M.has(s[p]!)) {p++; c.work++;}
  return p > at && (p === s.length || D.has(s[p]!) || !LETTER.test(String.fromCodePoint(s.codePointAt(p)!)));
}
function prefix(c: Context, at: number): Modifier | null {
  const p = c.left[at] ?? at;
  for (const [word, kind] of PREFIXES) {
    if ((word === '快' || word === '近') && p !== at) continue;
    if (p >= word.length && starts(c, p - word.length, word)) return kind;
  }
  return null;
}
function suffix(c: Context, at: number, single = true): {kind: Modifier; end: number} | null {
  for (const [word, kind] of SUFFIXES) if (starts(c, at, word)) return {kind, end: at + word.length};
  if (single && starts(c, at, '起') && z(c, at + 1)) return {kind: 'lower', end: at + 1};
  if (single && starts(c, at, '多') && !'少谢'.includes(c.text[at + 1] ?? '\0')) return {kind: 'more', end: at + 1};
  return null;
}
const expanded = (s: string) => s.replaceAll('廿', '二十').replaceAll('卅', '三十');
interface Numeric {end: number; raw: string; value: bigint | null; min: bigint | null; max: bigint | null; range: boolean; capital: boolean; decimal: boolean; omitted: boolean; up: boolean}

/** Strict descending units, including section units. O(s.length), with bounded Chinese syntax. */
function chinese(s: string, allowOmission = true, outer = 1n, initial = true, standaloneTwo = true): {value: bigint; omitted: boolean} | null {
  if (!s || s.length > 40) return null;
  s = expanded(s);
  if (s === '零') return {value: 0n, omitted: false};
  if (s.startsWith('零') || s.endsWith('零') || s.includes('零零')) return null;
  for (const [word, unit] of BIG_SECTIONS) {
    const at = s.indexOf(word);
    if (at < 0) continue;
    if (s.indexOf(word, at + 1) >= 0 || at === 0) return null;
    const a = chinese(s.slice(0, at), allowOmission, 1n, initial);
    if (!a || a.omitted || a.value <= 0n || a.value >= 10000n) return null;
    let rest = s.slice(at + 1), zero = false;
    if (rest.startsWith('零')) {zero = true; rest = rest.slice(1);}
    if (!rest) return zero ? null : {value: a.value * unit, omitted: a.omitted};
    const b = chinese(rest, allowOmission, zero ? 1n : unit, false, false);
    if (!b || b.value >= unit) return null;
    return {value: a.value * unit + b.value, omitted: a.omitted || b.omitted};
  }
  let total = 0n, last = outer, pending: bigint | null = null, zero = false, omitted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '零') {
      if (pending !== null || total === 0n || zero) return null;
      zero = true;
      continue;
    }
    const d = ch === '两' ? 2n : small(ch);
    if (d !== null) {
      if (digit(ch) || pending !== null || ch === '两' && (s.length === 1 ? !standaloneTwo : !'百千万亿'.includes(s[i + 1] ?? '\0'))) return null;
      pending = d;
      if (i === s.length - 1) {
        const scale = !zero && last >= 100n ? last / 10n : 1n;
        if (scale > 1n && !allowOmission) return null;
        total += d * scale;
        omitted = scale > 1n;
        pending = null;
        zero = false;
      }
      continue;
    }
    const unit = U[ch];
    if (!unit || unit >= 10000n) return null;
    if (pending === null) {
      if (i !== 0 || ch !== '十' || !initial) return null;
      pending = 1n;
    }
    if (unit >= last && total > 0n || zero && unit >= last) return null;
    total += pending * unit;
    pending = null; last = unit; zero = false;
  }
  if (zero || pending !== null) return null;
  return {value: total, omitted};
}
function arabic(s: string): bigint | null {
  if (!ARABIC.test(s)) return null;
  const [whole, fraction = ''] = s.replaceAll(',', '').split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
}
function exactNumber(s: string, quantity = false): {value: bigint; capital: boolean; decimal: boolean; omitted: boolean} | null {
  if (!s) return null;
  if (digit(s[0])) {
    let p = 0;
    while (p < s.length && (digit(s[p]) || s[p] === '.' || s[p] === ',')) p++;
    const a = arabic(s.slice(0, p));
    if (a === null) return null;
    const decimal = s.slice(0, p).includes('.');
    if (p === s.length) return {value: a, capital: false, decimal, omitted: false};
    if (quantity) return null; // N2 is an amount spelling, not a simple quantity spelling.
    let last = U[s[p]!];
    if (!last || last === 10n) return null;
    let total = a * last, omitted = false;
    p++;
    while (p < s.length) {
      if (!digit(s[p])) return null;
      const d = BigInt(s[p++]!);
      if (p === s.length) {total += d * last / 10n * 100n; omitted = true; break;}
      const next = U[s[p++]!];
      if (!next || next >= last) return null;
      total += d * next * 100n; last = next;
    }
    return {value: total, capital: false, decimal: false, omitted};
  }
  const capital = [...s].some(x => CAPITAL.includes(x));
  if (capital && [...s].some(x => !(CAPITAL.includes(x) || '零万亿'.includes(x)))) return null;
  const plain = capital ? [...s].map(x => CAPITAL_FOLD[x] ?? x).join('') : s;
  const point = plain.indexOf('点');
  if (point >= 0) {
    if (capital) return null;
    const a = chinese(plain.slice(0, point)), fraction = plain.slice(point + 1);
    if (!a || fraction.length < 1 || fraction.length > 2 || [...fraction].some(x => !SMALL.includes(x) && x !== '零')) return null;
    const f = [...fraction].map(x => x === '零' ? '0' : String(SMALL.indexOf(x) + 1)).join('').padEnd(2, '0');
    return {value: a.value * 100n + BigInt(f), capital: false, decimal: true, omitted: a.omitted};
  }
  if (!capital && !quantity && s.length === 2 && '百千万'.includes(s[0]!) && SMALL.slice(1).includes(s[1]!))
    return {value: U[s[0]!]! * (10n + small(s[1])!) * 10n, capital: false, decimal: false, omitted: true};
  const result = chinese(plain, !capital && !quantity);
  return result ? {value: result.value * 100n, capital, decimal: false, omitted: result.omitted} : null;
}
function lowest(v: bigint): bigint {let u = 100n; v /= 100n; while (v > 0n && v % 10n === 0n) {u *= 10n; v /= 10n;} return u;}

// Number fields are visited a fixed number of times. Range substitution adds at most two parses.
function numeric(c: Context, at: number, quantity = false, stop?: number, consumePost = true): Numeric | null {
  const s = c.text;
  let end = stop ?? c.ends[at] ?? 0;
  if (end <= at) return null;
  // Chinese decimals cross 点, which is not a lexical numeric-field character.
  if (stop === undefined && s[end] === '点' && c.ends[end + 1]! > end + 1) end = c.ends[end + 1]!;
  const raw = s.slice(at, end);
  c.work += raw.length;
  // Every valid non-Arabic spelling fits this bound (including range substitutions).
  if (!digit(raw[0]) && raw.length > 40) return null;
  const base: Numeric = {end, raw, value: null, min: null, max: null, range: false, capital: false, decimal: false, omitted: false, up: false};
  let variants = 0, lo = raw, hi = raw, extra = 0n;
  if (s[at - 1] === '上' && UP.has(raw)) {
    let value = 100n;
    for (const ch of raw) value *= U[ch]!;
    base.range = true; base.min = value; base.up = true; variants++;
  }
  const few = raw.indexOf('几');
  if (few >= 0) {
    if (raw.indexOf('几', few + 1) >= 0) return null;
    variants++;
    if (raw === '几') {base.range = true;}
    else {
      lo = raw.replace('几', few === 0 ? '二' : '一'); hi = raw.replace('几', '九');
      if (few > 0) {
        let u = 100n;
        for (let i = few + 1; i < raw.length && U[raw[i]!]; i++) u *= U[raw[i]!]!;
        extra = u - (quantity ? 100n : 1n);
      }
    }
  }
  if (s[at - 1] === '数' && U[raw[0]!]) {variants++; lo = '二' + raw; hi = '九' + raw;}
  let pairAt = -1;
  for (let i = 0; i + 1 < raw.length; i++) {
    c.work++;
    if (PAIRS.has(raw.slice(i, i + 2))) {
      if (pairAt >= 0 || small(raw[i - 1]) !== null || small(raw[i + 2]) !== null || raw[i - 1] === '两' || raw[i + 2] === '两') return null;
      pairAt = i;
    }
  }
  if (pairAt >= 0) {variants++; lo = raw.slice(0, pairAt) + raw[pairAt] + raw.slice(pairAt + 2); hi = raw.slice(0, pairAt) + raw[pairAt + 1] + raw.slice(pairAt + 2);}
  let post: string | null = null;
  if (consumePost && (s[end] === '多' && !'少谢'.includes(s[end + 1] ?? '\0') || s[end] === '余' || s[end] === '来' || s[end] === '把' && MISSING_COEFFICIENT.has(raw))) post = s[end]!;
  if (post) {variants++; base.end++;}
  if (variants > 1) {base.range = true; base.min = null; base.max = null; return base;}
  if (base.range) return base;
  if (variants === 1 && !post) {
    const a = exactNumber(lo), b = exactNumber(hi);
    if (!a || !b) return null;
    // Replacement difference also captures the omitted place in 一百几 / 一万几.
    if (few > 0) extra = (b.value - a.value) / 8n - (quantity ? 100n : 1n);
    return {...base, range: true, min: a.value, max: b.value + extra};
  }
  let e = exactNumber(raw, post ? false : quantity);
  if (!e && post && MISSING_COEFFICIENT.has(raw)) e = {value: U[raw]! * 100n, capital: false, decimal: false, omitted: false};
  if (!e) return null;
  if (post) {
    if (e.value <= 0n || e.value % 100n !== 0n || e.capital || e.decimal
      || digit(raw[0]) && [...raw].some(ch => U[ch])
      || !digit(raw[0]) && !chinese(raw) && !MISSING_COEFFICIENT.has(raw)) return null;
    return {...base, range: true, min: e.value, max: post === '多' || post === '余' ? e.value + lowest(e.value) - (quantity ? 100n : 1n) : e.value};
  }
  return {...base, ...e};
}
function unitAt(c: Context, at: number): string | null {
  let best: string | null = null;
  for (const word of c.units) if ((!best || word.length > best.length) && starts(c, at, word)) best = word;
  return best;
}
function k(c: Context, at: number): boolean {c.work++; return '元圆块角毛分'.includes(c.text[at] ?? '\0') || unitAt(c, at) !== null;}
function endClass(c: Context, at: number): 'end' | 'unit' | 'word' {
  if (k(c, at)) return 'unit';
  return z(c, at) || SUFFIXES.some(([word]) => starts(c, at, word)) ? 'end' : 'word';
}
interface Core {expression: AmountExpression; number: Numeric; checkedEnd: number; candidate: boolean; major: boolean}
function readings(start: number, unit: AmountUnit, list: Reading[]): AmountExpression {
  const seen = new Set<bigint>(), unique = list.filter(r => {if (seen.has(r.cents)) return false; seen.add(r.cents); return true;});
  return {start, end: Math.max(...unique.map(r => r.end)), unit, bare: unit === null, kind: 'readings', readings: unique, approx: false};
}
function numericAmount(n: Numeric, at: number, end: number, unit: AmountUnit): AmountExpression {
  return n.range ? {start: at, end, unit, bare: unit === null, kind: 'range', min: n.min, max: n.max, approx: true} : readings(at, unit, [{cents: n.value!, end}]);
}

/** Yuan tails have at most two currency levels; all alternatives keep their own endpoints. */
function tail(c: Context, value: bigint, end: number, level: 10n | 1n | 100n, capital = false): {list: Reading[]; candidate: boolean} | null {
  const s = c.text, main = {cents: value, end};
  if (s[end] === '钱') {
    const paid = {cents: value, end: end + 1}, se = c.ends[end + 1]!;
    if (se > end + 1 && endClass(c, se) !== 'word') return null;
    return {list: [paid], candidate: false};
  }
  const se = c.ends[end]!;
  if (se <= end) return {list: [main], candidate: false};
  const body = s.slice(end, se), x = endClass(c, se);
  c.work += body.length;
  if (capital) {
    const d = CAPITAL_FOLD[body[0]!] ? small(CAPITAL_FOLD[body[0]!]!) : null;
    const zeroD = body.length === 2 && body[0] === '零' ? small(CAPITAL_FOLD[body[1]!] ?? '') : null;
    if (level === 100n && body.length === 1 && d !== null && '角毛'.includes(s[se] ?? '\0')) {
      const after = se + 1, nextEnd = c.ends[after]!;
      if (nextEnd > after) {
        const t = s.slice(after, nextEnd), fd = t.length === 1 ? small(CAPITAL_FOLD[t] ?? '') : null;
        if (fd !== null && s[nextEnd] === '分') return tail(c, value + d * 10n + fd, nextEnd + 1, 1n, true);
        return endClass(c, nextEnd) === 'word' ? {list: [{cents: value + d * 10n, end: after}], candidate: false} : null;
      }
      return tail(c, value + d * 10n, after, 1n, true);
    }
    if (level === 100n && s[se] === '分' && (body.length === 1 && d !== null || zeroD !== null)) return tail(c, value + (zeroD ?? d)!, se + 1, 1n, true);
    return x === 'word' ? {list: [main], candidate: false} : null;
  }
  if (level === 1n) return x === 'word' ? {list: [main], candidate: false} : null;
  const d = small(body[0]), zd = body.length === 2 && body[0] === '零' ? small(body[1]) : null;
  if (body.length === 1 && (d !== null || body === '两') && '角毛'.includes(s[se] ?? '\0') && level === 100n || zd !== null && '角毛'.includes(s[se] ?? '\0') && level === 100n) {
    const a = zd ?? (body === '两' ? 2n : d!);
    return tail(c, value + a * 10n, se + 1, 10n);
  }
  if (s[se] === '分' && (body.length === 1 && d !== null || zd !== null && level === 100n)) return tail(c, value + (zd ?? d)!, se + 1, 1n);
  if (x === 'unit') return null;
  let list: Reading[] | null = null, candidate = false;
  const factor = level === 100n ? 10n : 1n;
  if (body.length === 1 && (d !== null || body === '半')) {
    const extra = (body === '半' ? 5n : d!) * factor, withTail = {cents: value + extra, end: se};
    // Single-word suffixes after candidate tails are ordinary words.
    const ending = z(c, se) || SUFFIXES.some(([word]) => starts(c, se, word));
    list = ending ? [withTail] : [main, withTail]; candidate = true;
  } else if (level === 100n && zd !== null) list = [{cents: value + zd, end: se}];
  else if (level === 100n && body.length === 2 && digit(body[0]) && digit(body[1])) {
    const withTail = {cents: value + BigInt(body), end: se};
    list = x === 'end' ? [withTail] : [main, withTail, ...(body[0] !== '0' && body[1] !== '0' ? [{cents: value + BigInt(body[0]!) * 10n, end: end + 1}] : [])];
  } else if (level === 100n && CENTS_TAIL.test(body)) {
    const a = chinese(body)!, withTail = {cents: value + a.value, end: se};
    list = x === 'end' ? [withTail] : [main, withTail];
  } else if (body.length > 1) {
    let consumed = 0, extra = 0n, pair = false;
    if ((d !== null || body[0] === '半') && !U[body[1]!] && !(digit(body[0]) && digit(body[1]))) {
      consumed = 1; extra = (body[0] === '半' ? 5n : d!) * factor; pair = PAIRS.has(body.slice(0, 2));
    } else if (level === 100n && body[0] === '零' && small(body[1]) !== null && body.length > 2 && !U[body[2]!]) {
      consumed = 2; extra = small(body[1])!;
    } else if (level === 100n && body.length > 2 && digit(body[0]) && digit(body[1]) && !digit(body[2]) && !U[body[2]!]) {
      consumed = 2; extra = BigInt(body.slice(0, 2));
    }
    if (consumed) {
      if (x === 'end') return null;
      const withTail = {cents: value + extra, end: end + consumed};
      list = pair ? [main, withTail] : [withTail]; candidate = true;
    }
  }
  if (!list) return x === 'end' ? null : {list: [main], candidate: false};
  if (s[se] === '的' && list.length > 1) list = [list[1]!, list[0]!, ...list.slice(2)];
  return {list, candidate};
}

/** O(n) prefix DFA avoids reparsing every invalid prefix when a unit itself contains digits. */
function arabicPrefixes(c: Context, at: number, end: number): {valid: Uint8Array; numericEnd: number} {
  const valid = new Uint8Array(end - at + 1), s = c.text;
  let group = 0, comma = false, decimal = false, fraction = 0, invalid = false, p = at;
  for (; p < end; p++) {
    const ch = s[p]!;
    c.work++;
    if (digit(ch)) {
      if (decimal) {fraction++; if (fraction > 2) invalid = true;}
      else {group++; if (!comma && s[at] === '0' && group > 1 || comma && group > 3) invalid = true;}
    } else if (ch === ',') {
      if (decimal || comma && group !== 3 || !comma && (group < 1 || group > 3 || s[at] === '0')) invalid = true;
      comma = true; group = 0;
    } else if (ch === '.') {
      if (decimal || comma && group !== 3 || group === 0) invalid = true;
      decimal = true;
    } else break;
    valid[p + 1 - at] = !invalid && (decimal ? fraction >= 1 && fraction <= 2 : group > 0 && (!comma || group === 3)) ? 1 : 0;
  }
  return {valid, numericEnd: p};
}
function coreAmount(c: Context, start: number): Core | null {
  const s = c.text, symbol = s[start] === '¥' || s[start] === '￥', at = start + (symbol ? 1 : 0);
  let n = numeric(c, at), unit: AmountUnit = null, unitEnd = 0;
  const fieldEnd = c.ends[at]!;
  const prefixes = c.units.length && digit(s[at]) ? arabicPrefixes(c, at, fieldEnd) : null;
  const splitEnd = prefixes ? Math.min(fieldEnd, prefixes.numericEnd + 10) : Math.min(fieldEnd, at + 40);
  // Configured units may start inside a numeric field (e.g. 两). Chinese syntax is bounded.
  for (let p = at + 1; p <= splitEnd; p++) {
    if (!c.units.length) break;
    c.work++;
    if (prefixes && p <= prefixes.numericEnd && !prefixes.valid[p - at]) continue;
    const pos = c.right[p]!, direct = unitAt(c, pos), counted = '个枚块颗两'.includes(s[pos] ?? '\0') ? unitAt(c, pos + 1) : null;
    const word = direct ?? counted;
    if (!word) continue;
    const candidate = numeric(c, at, false, p, false);
    if (candidate) {n = candidate; unit = {kind: 'named', word}; unitEnd = pos + (direct ? 0 : 1) + word.length; break;}
  }
  if (!n && s[at] === '半' && starts(c, at + 1, '块钱')) {
    n = {end: at + 1, raw: '半', value: 50n, min: null, max: null, range: false, capital: false, decimal: false, omitted: false, up: false};
    return {expression: readings(start, {kind: 'yuan'}, [{cents: 50n, end: at + 3}]), number: n, checkedEnd: at + 3, candidate: false, major: true};
  }
  if (!n) return null;
  let pos = c.right[n.end]!;
  if (unit === null) {
    const direct = unitAt(c, pos), counted = '个枚块颗两'.includes(s[pos] ?? '\0') ? unitAt(c, pos + 1) : null;
    if (direct || counted) {const word = (direct ?? counted)!; unit = {kind: 'named', word}; unitEnd = pos + (direct ? 0 : 1) + word.length;}
  }
  if (unit !== null) {
    const se = c.ends[unitEnd]!;
    if (se > unitEnd && (endClass(c, se) !== 'word' || '钱厘毫文'.includes(s[se] ?? '\0'))) return null;
    return {expression: numericAmount(n, start, unitEnd, unit), number: n, checkedEnd: unitEnd, candidate: false, major: true};
  }
  // 来/把 between the number and its currency belong to the numeric range.
  if (n.end > at && (s[n.end - 1] === '来' || s[n.end - 1] === '把') && !k(c, pos)) {
    n = numeric(c, at, false, n.end - 1, false);
    if (!n) return null;
    pos = c.right[n.end]!;
  }
  if ('元圆块'.includes(s[pos] ?? '\0')) {
    if (s[pos] === '元' && '旦宵'.includes(s[pos + 1] ?? '\0')) return null;
    const e = pos + 1;
    if (n.range) {
      if (c.ends[e]! > e && endClass(c, c.ends[e]!) !== 'word') return null;
      const paidEnd = s[e] === '钱' ? e + 1 : e;
      return {expression: numericAmount(n, start, paidEnd, {kind: 'yuan'}), number: n, checkedEnd: paidEnd, candidate: false, major: true};
    }
    const t = tail(c, n.value!, e, 100n, n.capital);
    return t ? {expression: readings(start, {kind: 'yuan'}, t.list), number: n, checkedEnd: Math.max(...t.list.map(r => r.end)), candidate: t.candidate, major: t.list.every(r => r.end === e || s[r.end - 1] === '钱')} : null;
  }
  if ('角毛分'.includes(s[pos] ?? '\0')) {
    const value = n.raw === '两' ? 2n : small(n.raw);
    if (n.raw.length !== 1 || value === null || n.range || s[pos] === '分' && s[pos + 1] !== '钱') return null;
    const level = s[pos] === '分' ? 1n : 10n, t = tail(c, value * level, pos + 1, level);
    return t ? {expression: readings(start, {kind: 'yuan'}, t.list), number: n, checkedEnd: Math.max(...t.list.map(r => r.end)), candidate: t.candidate, major: false} : null;
  }
  if (symbol) return {expression: numericAmount(n, start, n.end, {kind: 'yuan'}), number: n, checkedEnd: n.end, candidate: false, major: true};
  if (n.decimal && !digit(n.raw[0]) || k(c, pos)) return null;
  return {expression: numericAmount(n, start, n.end, null), number: n, checkedEnd: n.end, candidate: false, major: false};
}
function leftAmount(c: Context, start: number): boolean {
  const s = c.text, p = c.left[start]!, prev = s[p - 1], immediate = s[start - 1];
  if (prev === '第' || prev !== undefined && D.has(prev)) {
    if (!(prev === '零' && !numberChar(s[p - 2]) && !k(c, p - 2))) return false;
  }
  if (immediate && (LATIN.test(immediate) || immediate === '_' || immediate === '#' || SIGNS.has(immediate))) return false;
  if (immediate && '.．,点'.includes(immediate) && numberChar(s[start - 2])) return false;
  if (digit(s[start]) && (immediate === '.' || immediate === '．')) return false;
  let uend = start;
  if (s[uend - 1] === '钱') uend--;
  if (uend > 0 && k(c, uend - 1) && numberChar(s[uend - 2])) return false;
  for (const word of c.units) if (uend >= word.length && starts(c, uend - word.length, word) && numberChar(s[uend - word.length - 1])) return false;
  return true;
}
function blockedRight(c: Context, at: number): boolean {
  if (EXCEPTIONS.some(word => starts(c, at, word))) return false;
  return Q.has(c.text[at]!) || T.has(c.text[at]!) || Q_WORDS.some(w => starts(c, at, w)) || T_WORDS.some(w => starts(c, at, w));
}
function bareOK(c: Context, core: Core, after: number, connected: boolean): boolean {
  const e = core.expression, n = core.number, s = c.text;
  if (!e.bare) return true;
  if (!n.range && n.value! <= 0n || n.raw === '几') return false;
  const p = c.right[after]!, gap = p > after;
  if (!connected && (e.end - e.start === 1 && !digit(n.raw[0]) || n.up) && !z(c, p)) return false;
  if (blockedRight(c, p) || s[p] === '折' || s[p] === '%' || s[p] === '％') return false;
  if (!gap && (LATIN.test(s[p] ?? '') || s[p] === '_')) return false;
  if (gap && numberChar(s[p])) return false;
  if ('.．,，:：'.includes(s[p] ?? '\0') && numberChar(s[p + 1])) return false;
  if (s[p] === '来' && blockedRight(c, p + 1)) return false;
  const pre = s.slice(Math.max(0, e.start - 2), e.start);
  if (pre.endsWith('分之')) return false;
  if (n.raw.length === 1 && SMALL.slice(0, 6).includes(n.raw) && (pre.endsWith('周') || pre.endsWith('星期') || pre.endsWith('礼拜'))) return false;
  if (s[e.start - 1] === '初' && !digit(n.raw[0]) && n.value !== null && n.value <= 1000n) return false;
  // A newline before a currency is not the permitted inline whitespace.
  if ((s[after] === '\n' || s[after] === '\r') && k(c, after + 1)) return false;
  return true;
}
function sameUnit(a: AmountUnit, b: AmountUnit): boolean {return a === null || b === null || a.kind === b.kind && (a.kind === 'yuan' || b.kind === 'named' && a.word === b.word);}

/** Connection arithmetic is bounded by Chinese syntax; Arabic spellings never infer unwritten units. */
function connectRange(a: Numeric, b: Numeric, av: bigint | null, bv: bigint | null, bareA: boolean, comma: boolean, quantum: bigint): [bigint | null, bigint | null] {
  const ar = expanded(a.raw), br = expanded(b.raw);
  if (av === null || bv === null || a.range || b.range) return [null, null];
  if (comma && bareA && ar.length === 1 && (SMALL.includes(ar) || ar === '两') && PAIRS.has(ar + br[0]) && U[br[1]!]) {
    const lo = exactNumber(ar + br.slice(1)), hi = exactNumber(br);
    if (lo && hi) return [lo.value, hi.value];
  }
  if (bareA) {
    let length = 0;
    for (let i = br.length - 1; i >= 0 && U[br[i]!]; i--) length++;
    for (let count = length; count > 0; count--) {
      const coefficient = br.slice(0, -count);
      if (!coefficient) continue;
      const v = arabic(coefficient) ?? (chinese(coefficient)?.value ?? -1n) * 100n;
      if (v < 0n) continue;
      let m = 1n;
      for (const ch of br.slice(-count)) m *= U[ch]!;
      if (v * m === b.value && av < v && av < m * 100n) return [av * m, bv];
    }
    let largest = 0n;
    for (const ch of br) if (U[ch] && U[ch]! > largest) largest = U[ch]!;
    if (av < 1000n && av % 100n === 0n && largest > 0n && av * largest < b.value!) return [null, null];
  }
  return av < bv ? [av, bv] : [null, null];
}
function modify(e: AmountExpression, first: Modifier | null, second: Modifier | null, major: boolean, quantum = 1n): AmountExpression {
  const range = (min: bigint | null, max: bigint | null): AmountExpression => ({start: e.start, end: e.end, unit: e.unit, bare: e.bare, kind: 'range', min, max, approx: true});
  if (!first && !second) return e;
  // A point estimate preserves the intrinsic range supplied by 多 or 出头.
  if (first === 'point' && (second === 'more' || second === 'head')) return modify(e, null, second, major, quantum);
  if (first && second && first !== second) return range(null, null);
  const kind = first ?? second;
  if (e.kind === 'range') return kind === 'point' ? e : range(null, null);
  if (e.readings.length > 1) return kind === 'point' ? {...e, approx: true} : range(null, null);
  const v = e.readings[0]!.cents;
  if (kind === 'point') return range(v, v);
  if (kind === 'lower') return range(v, null);
  if (kind === 'upper') return range(null, v);
  if (kind === 'more') return major ? range(v, v + 100n - quantum) : range(null, null);
  return v > 0n && v % 100n === 0n ? range(v, v + lowest(v) - quantum) : range(null, null);
}
function amountAt(c: Context, start: number, joining = false): Core | null {
  if (!joining && !leftAmount(c, start)) return null;
  const core = coreAmount(c, start);
  if (!core) return null;
  let e = core.expression, after = e.end, connected = false;
  if (!joining && AMOUNT_CONNECT.has(c.text[after]!) && (c.text[after] !== '、' || e.bare) && D.has(c.text[after + 1]!)) {
    const b = amountAt(c, after + 1, true);
    if (!b && e.bare) return null;
    if (b) {
      const av = e.kind === 'readings' && e.readings.length === 1 ? e.readings[0]!.cents : null;
      const be = b.expression, bv = be.kind === 'readings' && be.readings.length === 1 ? be.readings[0]!.cents : null;
      const [min, max] = sameUnit(e.unit, be.unit) ? connectRange(core.number, b.number, av, bv, e.bare, c.text[after] === '、', 1n) : [null, null];
      const unit = e.unit ?? be.unit;
      e = {start, end: be.end, unit, bare: unit === null, kind: 'range', min, max, approx: true};
      after = be.end; connected = true;
    }
  }
  const post = suffix(c, after, !core.candidate);
  if (post) after = post.end;
  const pre = joining ? null : prefix(c, start);
  const checked = {...core, expression: e};
  if (!bareOK(c, checked, after, connected || joining)) return null;
  if (c.text[e.end] === '%' || c.text[e.end] === '％') return null;
  if (!joining) e = modify(e, pre, post?.kind ?? null, core.major);
  return {...core, expression: e, checkedEnd: after};
}

/** Trimming is O(n); returned offsets always refer to the untrimmed original UTF-16 string. */
function fragment(input: string): {text: string; offset: number} | null {
  if (typeof input !== 'string') return null;
  let a = 0, b = input.length;
  while (a < b && TRIM.test(input[a]!)) a++;
  while (b > a && (TRIM.test(input[b - 1]!) || input[b - 1] === '.')) b--;
  if (a === b) return null;
  const text = input.slice(a, b);
  let count = 0;
  for (const ch of text) {if (++count > 40) return null;}
  return {text, offset: a};
}
function shiftAmount(e: AmountExpression, by: number): AmountExpression {
  return e.kind === 'readings' ? {...e, start: e.start + by, end: e.end + by, readings: e.readings.map(r => ({cents: r.cents, end: r.end + by}))} : {...e, start: e.start + by, end: e.end + by};
}
function parseAmountWork(input: string, o?: Options): WorkResult<AmountExpression | null> {
  const f = fragment(input);
  if (!f) return {result: null, work: typeof input === 'string' ? input.length : 0};
  const c = context(f.text, o), first = c.fields[0];
  if (!first) return {result: null, work: c.work};
  let at = first.start;
  if (c.text[at] === '零' && first.end > at + 1) at++;
  if (c.text[at - 1] === '¥' || c.text[at - 1] === '￥') at--;
  const found = amountAt(c, at);
  if (!found) return {result: null, work: c.work};
  const e = found.expression;
  let consumed = e.end;
  if (c.ends[consumed]! > consumed) consumed = c.ends[consumed]!;
  for (let i = consumed; i < c.text.length; i++) {c.work++; if (numberChar(c.text[i])) return {result: null, work: c.work};}
  return {result: shiftAmount(e, f.offset), work: c.work};
}
/** Reads the first numeric field; rejects an unrelated second number. Never selects an ambiguous reading. */
export function parseAmount(fragment: string, o?: Options): AmountExpression | null {return parseAmountWork(fragment, o).result;}

function scanAmountsWork(input: string, o?: Options): WorkResult<AmountExpression[]> {
  if (typeof input !== 'string') return {result: [], work: 0};
  const c = context(input, o), result: AmountExpression[] = [];
  let cursor = 0;
  for (const f of c.fields) {
    c.work++;
    if (f.start < cursor) continue;
    let at = f.start;
    if (c.text[at - 1] === '¥' || c.text[at - 1] === '￥') at--;
    let found = amountAt(c, at);
    if (!found && '零俩仨半'.includes(c.text[f.start]!) && f.end > f.start + 1) found = amountAt(c, f.start + 1);
    if (found && !(f.capital && found.expression.bare)) {result.push(found.expression); cursor = found.expression.end;}
  }
  return {result, work: c.work};
}
/** O(n) lexical scans; expressions are ordered, nonoverlapping, and are not evidence of a transaction. */
export function scanAmounts(text: string, o?: Options): AmountExpression[] {return scanAmountsWork(text, o).result;}

function quantityAt(c: Context, at: number): {expression: QuantityExpression; after: number} | null {
  const s = c.text;
  if (starts(c, at, '一些') || starts(c, at, '一点') || starts(c, at, '若干')) return {expression: {start: at, end: at + 2, kind: 'range', min: null, max: null, approx: true}, after: at + 2};
  if (s[at] === '半' && s[at + 1] !== '打') return {expression: {start: at, end: at + 1, kind: 'unsupported', reason: 'fraction'}, after: at + 1};
  let n = numeric(c, at, true);
  if (s[at] === '俩' || s[at] === '仨' || s[at] === '半' && s[at + 1] === '打') {
    const count = s[at] === '俩' ? 200n : s[at] === '仨' ? 300n : 50n;
    n = {end: at + 1, raw: s[at]!, value: count, min: null, max: null, range: false, capital: false, decimal: false, omitted: false, up: false};
  }
  if (!n) return null;
  if (n.decimal) return {expression: {start: at, end: n.end, kind: 'unsupported', reason: 'fraction'}, after: n.end};
  let end = n.end;
  for (let gap = 1; gap <= 2; gap++) {
    const between = s.slice(end, end + gap);
    c.work += gap;
    if (between.length === gap && [...between].every(ch => !numberChar(ch) && !W(ch) && !PUNCT.test(ch) && !'元圆块角毛'.includes(ch)) && s[end + gap] === '半')
      return {expression: {start: at, end: end + gap + 1, kind: 'unsupported', reason: 'fraction'}, after: end + gap + 1};
  }
  let range = n.range, min = n.min, max = n.max, value = n.value;
  if (QUANTITY_CONNECT.has(s[end]!) && D.has(s[end + 1]!)) {
    const b = numeric(c, end + 1, true);
    if (b && !b.decimal) {
      [min, max] = connectRange(n, b, value, b.value, true, false, 100n);
      range = true; value = null; end = b.end;
    }
  }
  if (s[end] === '打') {end++; if (range) {min = min === null ? null : min * 12n; max = max === null ? null : max * 12n;} else value = value! * 12n;}
  if (!range && (value! <= 0n || value! % 100n !== 0n || (value!) / 100n > BigInt(Number.MAX_SAFE_INTEGER))) return null;
  if (range && [min, max].some(v => v !== null && (v < 0n || v % 100n !== 0n || v / 100n > BigInt(Number.MAX_SAFE_INTEGER)))) return null;
  let e: AmountExpression = range ? {start: at, end, unit: null, bare: true, kind: 'range', min, max, approx: true} : readings(at, null, [{cents: value!, end}]);
  let post: {kind: Modifier; end: number} | null = null;
  for (let gap = 0; gap <= 2; gap++) {
    const between = s.slice(end, end + gap);
    if (gap && (between.length !== gap || [...between].some(ch => numberChar(ch) || W(ch) || PUNCT.test(ch)))) break;
    post = starts(c, end + gap, '有找') ? null : suffix(c, end + gap, false);
    if (post) break;
  }
  e = modify(e, prefix(c, at), post?.kind ?? null, false, 100n);
  const expression: QuantityExpression = e.kind === 'range' ? {start: at, end, kind: 'range', min: e.min === null ? null : Number(e.min / 100n), max: e.max === null ? null : Number(e.max / 100n), approx: true} : {start: at, end, kind: 'exact', count: Number(e.readings[0]!.cents / 100n)};
  return {expression, after: post?.end ?? end};
}
function parseQuantityWork(input: string): WorkResult<QuantityExpression | null> {
  const f = fragment(input);
  if (!f) return {result: null, work: typeof input === 'string' ? input.length : 0};
  const c = context(f.text);
  let at = 0;
  for (const [word] of PREFIXES) if (starts(c, 0, word)) {at = c.right[word.length]!; break;}
  if ('好数上'.includes(c.text[at] ?? '\0') && (c.text[at] === '好' && c.text[at + 1] === '几' || U[c.text[at + 1]!])) at++;
  const found = quantityAt(c, at);
  if (!found) return {result: null, work: c.work};
  for (let i = found.after; i < c.text.length; i++) {c.work++; if (numberChar(c.text[i])) return {result: null, work: c.work};}
  return {result: {...found.expression, start: found.expression.start + f.offset, end: found.expression.end + f.offset}, work: c.work};
}
/** Parses a quantity at the trimmed beginning, excluding classifiers from its span. Fractions are explicit. */
export function parseQuantity(fragment: string): QuantityExpression | null {return parseQuantityWork(fragment).result;}

function scanQuantitiesWork(input: string): WorkResult<QuantityExpression[]> {
  if (typeof input !== 'string') return {result: [], work: 0};
  const c = context(input), result: QuantityExpression[] = [], candidates = [...c.fields];
  for (let i = 0; i < c.text.length; i++) {c.work++; if (starts(c, i, '若干')) candidates.push({start: i, end: i + 2, capital: false});}
  // Merge already ordered lexical fields with the few nonnumeric indefinite starts in O(n).
  const atFields = new Map(candidates.map(f => [f.start, f]));
  let cursor = 0, previousAmountStart = -1, previousField: Field | undefined, previousAmount: Core | null = null;
  for (let i = 0; i < c.text.length; i++) {
    c.work++;
    const f = atFields.get(i);
    if (!f) continue;
    let at = f.start, tailStart = false;
    if (previousField) {
      const p = c.right[previousField.end]!, currency = '元圆块角毛'.includes(c.text[p] ?? '\0') && p + 1 === f.start;
      if (currency) {
        c.work++; // Include every chain/cache visit in the linear-work diagnostic.
        const amountStart = previousAmountStart < 0 ? previousField.start : previousAmountStart;
        // O(n): parse the leftmost amount once per chain, even when that parse fails.
        if (previousAmountStart < 0) {
          const symbolStart = c.text[amountStart - 1] === '¥' || c.text[amountStart - 1] === '￥' ? amountStart - 1 : amountStart;
          previousAmount = coreAmount(c, symbolStart);
          previousAmountStart = amountStart;
        }
        const amount = previousAmount;
        if (amount?.expression.kind === 'readings') {at = Math.max(at, Math.min(...amount.expression.readings.map(r => r.end))); tailStart = at < f.end;}
      } else previousAmountStart = -1;
    }
    previousField = f;
    if (f.start < cursor || at >= f.end) continue;
    const p = c.left[at]!, prev = c.text[p - 1];
    if (!tailStart && prev && (D.has(prev) || prev === '第' || prev === '各' || SIGNS.has(prev))) continue;
    if (!tailStart && prev && '.．,点'.includes(prev) && numberChar(c.text[p - 2])) continue;
    const found = quantityAt(c, at);
    if (found) {result.push(found.expression); cursor = found.expression.end;}
  }
  return {result, work: c.work};
}
/** O(n); scans dates and ordinary nouns too. The caller chooses the relevant quoted quantity. */
export function scanQuantities(text: string): QuantityExpression[] {return scanQuantitiesWork(text).result;}

function ratesWork(input: string): WorkResult<RateExpression[]> {
  if (typeof input !== 'string') return {result: [], work: 0};
  const c = context(input), s = c.text, result: RateExpression[] = [];
  let field = 0;
  for (let i = 0; i < s.length; i++) {
    c.work++;
    let start = i, end = i + 2, min: bigint | null = null, max: bigint | null = null, numerator: bigint | null = null, range = false;
    if (starts(c, i, '对折') || starts(c, i, '半价')) {
      if (D.has(s[i - 1]!) || s[i - 1] === '半') continue;
      numerator = 50n;
    } else if (s[i] === '折') {
      while (field < c.fields.length && c.fields[field]!.end < i) {field++; c.work++;}
      const f = c.fields[field];
      if (!f || f.end !== i) continue;
      start = f.start; end = i + 1;
      const body = s.slice(start, i);
      c.work += body.length;
      if (body.length === 1 && small(body) !== null) numerator = small(body)! * 10n;
      else if (DECIMAL_RATE.test(body)) numerator = BigInt(body[0]!) * 10n + BigInt(body[2]!);
      else if (ARABIC_RATE.test(body)) numerator = BigInt(body);
      else if (body.length === 2 && [...body].every(ch => SMALL.includes(ch))) {
        if (PAIRS.has(body)) {range = true; min = small(body[0])! * 10n; max = small(body[1])! * 10n;}
        else numerator = small(body[0])! * 10n + small(body[1])!;
      } else continue;
    } else continue;
    if (c.ordinal[start]) continue;
    const pre = prefix(c, start) ?? (s[start - 1] === '打' ? prefix(c, start - 1) : null);
    const foundPost = suffix(c, end)?.kind ?? null;
    const post = foundPost === 'more' || foundPost === 'head' ? null : foundPost;
    if (pre || post) {
      if (pre && pre !== 'point' || post && post !== 'point') {range = true; min = null; max = null;}
      else if (!range) {range = true; min = numerator; max = numerator;}
    }
    result.push(range ? {start, end, kind: 'range', min, max, denominator: 100n, approx: true} : {start, end, kind: 'exact', numerator: numerator!, denominator: 100n});
    i = end - 1;
  }
  return {result, work: c.work};
}
/** O(n); whole rate bodies are checked, and an ordinal affects only its own punctuation-delimited clause. */
export function scanRates(text: string): RateExpression[] {return ratesWork(text).result;}
function parseRateWork(input: string): WorkResult<RateExpression | null> {
  const f = fragment(input);
  if (!f) return {result: null, work: typeof input === 'string' ? input.length : 0};
  const work = ratesWork(f.text);
  if (work.result.length !== 1) return {result: null, work: work.work};
  const e = work.result[0]!, text = foldForMatch(f.text).replaceAll('〇', '零').replaceAll('○', '零');
  for (let i = 0; i < text.length; i++) {
    work.work++;
    if ((i < e.start || i >= e.end) && numberChar(text[i])) return {result: null, work: work.work};
  }
  return {result: {...e, start: e.start + f.offset, end: e.end + f.offset}, work: work.work};
}
/** Finds exactly one complete rate, retaining denominator 100 without reducing the fraction. */
export function parseDiscountRate(fragment: string): RateExpression | null {return parseRateWork(fragment).result;}
function numbersWork(input: string): WorkResult<{start: number; end: number}[]> {
  if (typeof input !== 'string') return {result: [], work: 0};
  const c = context(input), s = c.text, result: {start: number; end: number}[] = [];
  for (let i = 0; i < s.length; i++) {
    c.work++;
    if (!R.has(s[i]!)) continue;
    const start = i;
    while (i < s.length && (R.has(s[i]!) || (s[i] === '.' || s[i] === ',') && digit(s[i - 1]) && digit(s[i + 1]))) {i++; c.work++;}
    result.push({start, end: i}); i--;
  }
  return {result, work: c.work};
}
/** O(n); lexical numeric fields include unsupported spellings and exclude capital digits. */
export function scanNumbers(text: string): {start: number; end: number}[] {return numbersWork(text).result;}

/** O(expressions.length), preserves references/order; empty or merely touching spans do not overlap. */
function overlappingWork<T extends {start: number; end: number}>(expressions: readonly T[], start: number, end: number): WorkResult<T[]> {
  const result: T[] = [];
  let work = 0;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) return {result, work};
  try {
    if (!Array.isArray(expressions)) return {result, work};
    const length = expressions.length;
    for (let i = 0; i < length; i++) {
      work++;
      try {
        const e = expressions[i]!, a = e.start, b = e.end;
        if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && a < b && a < end && start < b) result.push(e);
      } catch { /* One inaccessible item cannot hide accessible expressions. */ }
    }
  } catch {return {result: [], work};}
  return {result, work};
}
export function overlapping<T extends {start: number; end: number}>(expressions: readonly T[], start: number, end: number): T[] {return overlappingWork(expressions, start, end).result;}

/** Test/diagnostic instrumentation only, not a product API. Uses the public implementations with per-call counters. */
export const amountExpressionWork = Object.freeze({
  parseAmount: parseAmountWork, parseQuantity: parseQuantityWork, parseDiscountRate: parseRateWork,
  scanAmounts: scanAmountsWork, scanQuantities: scanQuantitiesWork, scanRates: ratesWork, scanNumbers: numbersWork,
  overlapping: overlappingWork,
});
