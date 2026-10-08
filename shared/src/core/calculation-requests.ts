import { computeRational, formatRational, normalize, parseDecimal, type Rational } from './arithmetic.ts';

/** Limits apply before loops/conversion. A displayed number has at most 18 digits;
 * hence even an eight-operand mean expression is shorter than 200 characters. */
export const CALCULATION_LIMITS = Object.freeze({
  maxDigits: 18, maxIntermediateDigits: 36, maxOperands: 8, maxTreeNodes: 1023,
  maxTreeDepth: 64, maxResults: 1024, maxRequests: 1024, maxRefLength: 256,
  maxUnitLength: 64, maxReadings: 64, maxSourceNodes: 4096,
  maxSourceDepth: 32, maxSourceStringLength: 16384, maxExpressionLength: 200,
  scalarScale: 12,
});
export type RequestOperation = 'add' | 'subtract' | 'multiply' | 'divide' | 'sum' | 'mean' | 'count';
export type RequestError = 'unknown_ref' | 'arity' | 'unit_mismatch' | 'division_by_zero'
  | 'not_a_number' | 'result_too_large' | 'unsupported_operation' | 'invalid_request';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** key is compared verbatim; display is returned verbatim. No currency vocabulary lives here. */
export interface ValueUnit { key: string; display: string }
type Integer = bigint | number | string;
type Source = { source?: JsonValue };
export type AmountValue = Source & { type: 'amount'; unit: ValueUnit | null; bare: boolean } & (
  | { kind: 'readings'; readings: readonly { cents: Integer }[]; approx: boolean }
  | { kind: 'range'; min: Integer | null; max: Integer | null; approx: true });
export type QuantityValue = Source & { type: 'quantity' } & (
  | { kind: 'exact'; count: Integer }
  | { kind: 'range'; min: Integer | null; max: Integer | null; approx: true }
  | { kind: 'unsupported'; reason: 'fraction' });
export type RateValue = Source & { type: 'rate'; denominator: Integer } & (
  | { kind: 'exact'; numerator: Integer }
  | { kind: 'range'; min: Integer | null; max: Integer | null; approx: true });
export type ReferenceValue = AmountValue | QuantityValue | RateValue
  | (Source & { type: 'number'; value: string })
  | (Source & { type: 'money'; cents: Integer; unit: ValueUnit })
  | (Source & { type: 'integer'; count: Integer })
  | (Source & { type: 'non_numeric' });
/** Values are program-owned data, separate from the model's reference-only request. */
export type ReferenceValues = Readonly<Record<string, ReferenceValue>>;
export interface CalculationRequest { op: RequestOperation; operands: readonly string[] }
export interface ComputeRequest extends CalculationRequest { ref: string }
export interface RequestFailure { ok: false; error: RequestError; operand: number | null }
export interface ToolSuccess {
  ok: true; ref: string; value: string; unit: string | null; money: boolean;
  approx: boolean; exact: boolean; expression: string;
  range?: { min: string | null; max: string | null };
}
export type ToolResult = ToolSuccess | RequestFailure;
type RationalJson = { numerator: string; denominator: string };
type Snapshot = {
  point: RationalJson; unit: ValueUnit | null; approx: boolean; exact: boolean;
  source: JsonValue; range?: { min: RationalJson | null; max: RationalJson | null };
};
type Selection = { reading: number | null; endpoint: 'min' | 'max' | 'midpoint' | null };
export interface CalculationLeaf { kind: 'leaf'; ref: string; selection: Selection; snapshot: Snapshot }
export interface CalculationNode { kind: 'operation'; op: RequestOperation; operands: CalculationTree[]; endpoint?: 'min' | 'max' }
/** JSON-only provenance. c references are expanded; snapshots preserve the accepted
 * inputs for later c use. replayCalculation ignores snapshots and reads fresh values. */
export type CalculationTree = CalculationLeaf | CalculationNode;
export interface CalculationExecution { readonly results: readonly CalculationTree[] }
export interface CalculationWork { nodes: number; references: number; arithmetic: number; sourceNodes: number; sourceKeys: number; listedNodes: number; stateEntries: number }
export interface MoneyAmounts { cents: bigint; range?: { min: bigint | null; max: bigint | null } }
export interface ExecutionStep {
  state: CalculationExecution; result: ToolResult; work: CalculationWork;
  tree?: CalculationTree; amounts?: MoneyAmounts;
}
export interface LeafDescription {
  ref: string; kind: 'amount' | 'quantity' | 'rate' | 'number' | 'entry_amount' | 'entry_quantity' | 'balance' | 'one';
  dimension: 'money' | 'scalar'; unitKey: string | null; unit: string | null;
  reading: number | null; endpoint: Selection['endpoint']; source: JsonValue;
}
type Interval = { min: Rational | null; max: Rational | null };
type Numeric = {
  point: Rational; range?: Interval; money: boolean; unit: ValueUnit | null;
  approx: boolean; exact: boolean; text: string; tree: CalculationTree; expression?: string;
};
type Ref = { base: string; family: 'a' | 'q' | 'r' | 'u' | 'c' | 'e' | 'b' | 'one';
  money: boolean; kind: LeafDescription['kind'] | 'calculation'; reading: number | null;
  endpoint: 'min' | 'max' | null; index: number | null };
const OPS: readonly string[] = ['add', 'subtract', 'multiply', 'divide', 'sum', 'mean', 'count'];
const REF_PATTERN = /^([aqruc])([1-9]\d*)(?:#([1-9]\d*)|\.(min|max))?$/;
const ENTRY_PATTERN = /^e([1-9]\d*)\.(amount|unitPrice|due|quantity)$/;
const BALANCE_PATTERN = /^b:[^\r\n]+:[^:\r\n]+$/;
const INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/;
const DISPLAY_DIGITS_PATTERN = /[-.]/g;
const INPUT_DIGITS_PATTERN = /[-+.]/g;
const OUTPUT_REF_PATTERN = /^c[1-9]\d*$/;
const ZERO: Rational = { numerator: 0n, denominator: 1n };
const ONE: Rational = { numerator: 1n, denominator: 1n };
const error = (code: RequestError, operand: number | null = null): RequestFailure => ({ ok: false, error: code, operand });
const failed = (value: unknown): value is RequestFailure => record(value) && value.ok === false;
const work = (): CalculationWork => ({ nodes: 0, references: 0, arithmetic: 0, sourceNodes: 0, sourceKeys: 0, listedNodes: 0, stateEntries: 0 });
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const digits = (value: bigint): number => (value < 0n ? -value : value).toString().length;
const compare = (a: Rational, b: Rational): number => {
  const d = a.numerator * b.denominator - b.numerator * a.denominator;
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};

function integer(value: unknown, limit = CALCULATION_LIMITS.maxDigits): bigint | RequestFailure {
  if (typeof value === 'bigint') return digits(value) <= limit ? value : error('result_too_large');
  if (typeof value === 'number') return Number.isSafeInteger(value) ? integer(BigInt(value), limit) : error('not_a_number');
  if (typeof value !== 'string' || value.length > limit + 1) return typeof value === 'string' ? error('result_too_large') : error('not_a_number');
  if (!INTEGER_PATTERN.test(value)) return error('not_a_number');
  return integer(BigInt(value), limit);
}
function unit(value: unknown): ValueUnit | null | RequestFailure {
  if (value === null) return null;
  if (!record(value)) return error('not_a_number');
  const key = value.key, display = value.display;
  if (typeof key !== 'string' || typeof display !== 'string' || !key.length || !display.length) return error('not_a_number');
  if (key.length > CALCULATION_LIMITS.maxUnitLength || display.length > CALCULATION_LIMITS.maxUnitLength) return error('result_too_large');
  return { key, display };
}
/** Visits each JSON node once, preserving key order. Bounds also cover adversarial
 * getters, cyclic sources and nesting; all property reads remain inside API guards. */
function cloneSource(value: unknown, w: CalculationWork, depth = 0, seen = new Set<object>()): { value: JsonValue } | RequestFailure {
  w.sourceNodes++;
  if (w.sourceNodes > CALCULATION_LIMITS.maxSourceNodes || depth > CALCULATION_LIMITS.maxSourceDepth) return error('result_too_large');
  if (value === null || typeof value === 'boolean') return { value };
  if (typeof value === 'string') return value.length <= CALCULATION_LIMITS.maxSourceStringLength ? { value } : error('result_too_large');
  if (typeof value === 'number') return Number.isFinite(value) ? { value } : error('not_a_number');
  if (typeof value !== 'object' || seen.has(value)) return error('not_a_number');
  seen.add(value);
  const out: JsonValue[] | Record<string, JsonValue> = Array.isArray(value) ? [] : {};
  const keys = Object.keys(value);
  w.sourceKeys += keys.length;
  if (keys.length > CALCULATION_LIMITS.maxSourceNodes - w.sourceNodes) return error('result_too_large');
  if (Array.isArray(value) && keys.length !== value.length) return error('not_a_number');
  for (const key of keys) {
    if (Array.isArray(value) && key !== String((out as JsonValue[]).length)) return error('not_a_number');
    if (key.length > CALCULATION_LIMITS.maxSourceStringLength) return error('result_too_large');
    const item = cloneSource((value as Record<string, unknown>)[key], w, depth + 1, seen);
    if (failed(item)) return item;
    Object.defineProperty(out, key, { value: item.value, enumerable: true, writable: true, configurable: true });
  }
  seen.delete(value);
  return { value: out };
}
function parseRef(value: unknown): Ref | RequestFailure {
  if (typeof value !== 'string' || value.length > CALCULATION_LIMITS.maxRefLength) return error('unknown_ref');
  if (value === 'one') return { base: value, family: 'one', money: false, kind: 'one', reading: null, endpoint: null, index: null };
  const m = REF_PATTERN.exec(value);
  if (m) {
    const family = m[1] as Ref['family'], index = Number(m[2]);
    if (!Number.isSafeInteger(index) || (m[3] && family !== 'a') || (m[4] && family === 'u')) return error('unknown_ref');
    const reading = m[3] ? Number(m[3]) : null;
    if (reading !== null && !Number.isSafeInteger(reading)) return error('unknown_ref');
    return { base: `${family}${m[2]}`, family, money: family === 'a', kind: family === 'a' ? 'amount' : family === 'q' ? 'quantity' : family === 'r' ? 'rate' : family === 'u' ? 'number' : 'calculation', reading, endpoint: (m[4] ?? null) as Ref['endpoint'], index };
  }
  const e = ENTRY_PATTERN.exec(value);
  if (e) return { base: value, family: 'e', money: e[2] !== 'quantity', kind: e[2] === 'quantity' ? 'entry_quantity' : 'entry_amount', reading: null, endpoint: null, index: null };
  if (BALANCE_PATTERN.test(value)) return { base: value, family: 'b', money: true, kind: 'balance', reading: null, endpoint: null, index: null };
  return error('unknown_ref');
}
function arithmetic(op: RequestOperation, args: Rational[], w: CalculationWork): Rational | RequestFailure {
  w.arithmetic++;
  const r = computeRational(op, args);
  if ('ok' in r) return error(r.error.code === 'division_by_zero' ? 'division_by_zero' : 'result_too_large');
  if (digits(r.numerator) > CALCULATION_LIMITS.maxIntermediateDigits || digits(r.denominator) > CALCULATION_LIMITS.maxIntermediateDigits) return error('result_too_large');
  return r;
}
const jsonRational = (r: Rational): RationalJson => ({ numerator: r.numerator.toString(), denominator: r.denominator.toString() });
function readRational(value: unknown): Rational | RequestFailure {
  if (!record(value)) return error('invalid_request');
  const n = integer(value.numerator), d = integer(value.denominator);
  if (failed(n)) return n;
  if (failed(d)) return d;
  if (d <= 0n) return error('not_a_number');
  return normalize({ numerator: n, denominator: d });
}
function moneyText(cents: bigint): string {
  const abs = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
function formatted(point: Rational, money: boolean): { point: Rational; text: string; exact: boolean } | RequestFailure {
  const f = formatRational(point, money ? 0 : CALCULATION_LIMITS.scalarScale);
  const parsed = parseDecimal(f.value);
  if ('ok' in parsed) return error('result_too_large');
  const text = money ? moneyText(parsed.numerator) : f.value;
  if (text.replace(DISPLAY_DIGITS_PATTERN, '').length > CALCULATION_LIMITS.maxDigits) return error('result_too_large');
  return { point: parsed, text, exact: f.exact };
}
function selectRange(r: Interval, ref: Ref, money: boolean, w: CalculationWork): { point: Rational; range?: Interval; exact: boolean; selection: Selection } | RequestFailure {
  if (r.min !== null && r.max !== null && compare(r.min, r.max) > 0) return error('not_a_number');
  if (ref.reading !== null) return error('unknown_ref');
  if (ref.endpoint !== null) {
    const p = r[ref.endpoint];
    return p === null ? error('not_a_number') : { point: p, exact: true, selection: { reading: null, endpoint: ref.endpoint } };
  }
  if (r.min === null && r.max === null) return error('not_a_number');
  const p = r.min === null ? r.max! : r.max === null ? r.min : arithmetic('mean', [r.min, r.max], w);
  if (failed(p)) return p;
  if (money) {
    const f = formatted(p, true);
    if (failed(f)) return f;
    return { point: f.point, range: r, exact: f.exact, selection: { reading: null, endpoint: 'midpoint' } };
  }
  return { point: p, range: r, exact: true, selection: { reading: null, endpoint: 'midpoint' } };
}
function leaf(refText: string, ref: Ref, values: unknown, w: CalculationWork): Numeric | RequestFailure {
  w.references++;
  let point: Rational = ONE, range: Interval | undefined, approx = false, exact = true;
  let u: ValueUnit | null = null, source: JsonValue = null;
  let selection: Selection = { reading: null, endpoint: null };
  if (ref.family !== 'one') {
    if (!record(values) || !own(values, ref.base)) return error('unknown_ref');
    const data = values[ref.base];
    if (!record(data)) return error('not_a_number');
    const type = data.type, kind = data.kind;
    if (type === 'non_numeric' || kind === 'unsupported') return error('not_a_number');
    if ((ref.family === 'a' && type !== 'amount') || (ref.family === 'q' && type !== 'quantity')
      || (ref.family === 'r' && type !== 'rate') || (ref.family === 'u' && type !== 'number')
      || ((ref.family === 'b' || ref.kind === 'entry_amount') && type !== 'money')
      || (ref.kind === 'entry_quantity' && type !== 'integer')) return error('not_a_number');
    if (ref.money) {
      const ru = unit(data.unit);
      if (failed(ru)) return ru;
      if (type === 'money' && ru === null) return error('not_a_number');
      if (type === 'amount' && (typeof data.bare !== 'boolean' || (data.bare && ru !== null))) return error('not_a_number');
      u = ru;
    }
    if (type === 'number') {
      if (typeof data.value !== 'string') return error('not_a_number');
      if (data.value.length > CALCULATION_LIMITS.maxDigits + 2 || data.value.replace(INPUT_DIGITS_PATTERN, '').length > CALCULATION_LIMITS.maxDigits) return error('result_too_large');
      const p = parseDecimal(data.value);
      if ('ok' in p) return error('not_a_number');
      point = p;
    } else if (type === 'money' || type === 'integer' || (type === 'quantity' && kind === 'exact')) {
      const p = integer(type === 'money' ? data.cents : data.count);
      if (failed(p)) return p;
      if (type === 'quantity' && p <= 0n) return error('not_a_number');
      if (ref.endpoint !== null) return error('unknown_ref');
      point = { numerator: p, denominator: 1n };
    } else if (type === 'amount' && kind === 'readings') {
      const readings = data.readings, index = ref.reading ?? 1;
      if (ref.endpoint !== null) return error('unknown_ref');
      if (!Array.isArray(readings) || !readings.length || typeof data.approx !== 'boolean') return error('not_a_number');
      if (readings.length > CALCULATION_LIMITS.maxReadings) return error('result_too_large');
      if (index > readings.length) return error('unknown_ref');
      const reading = readings[index - 1];
      if (!record(reading)) return error('not_a_number');
      const p = integer(reading.cents);
      if (failed(p)) return p;
      point = { numerator: p, denominator: 1n }; approx = data.approx;
      selection = { reading: index, endpoint: null };
    } else if (type === 'rate' && kind === 'exact') {
      if (ref.endpoint !== null) return error('unknown_ref');
      const n = integer(data.numerator), d = integer(data.denominator);
      if (failed(n)) return n;
      if (failed(d)) return d;
      if (d <= 0n || n < 0n || n > d) return error('not_a_number');
      point = normalize({ numerator: n, denominator: d });
    } else if (kind === 'range' && (type === 'amount' || type === 'quantity' || type === 'rate')) {
      if (data.approx !== true) return error('not_a_number');
      const d = type === 'rate' ? integer(data.denominator) : 1n;
      if (failed(d)) return d;
      if (d <= 0n) return error('not_a_number');
      const lo = data.min === null ? null : integer(data.min), hi = data.max === null ? null : integer(data.max);
      if (failed(lo)) return lo;
      if (failed(hi)) return hi;
      if (type === 'quantity' && ((lo !== null && lo <= 0n) || (hi !== null && hi <= 0n))) return error('not_a_number');
      if (type === 'rate' && ((lo !== null && (lo < 0n || lo > d)) || (hi !== null && (hi < 0n || hi > d)))) return error('not_a_number');
      const selected = selectRange({ min: lo === null ? null : normalize({ numerator: lo, denominator: d }), max: hi === null ? null : normalize({ numerator: hi, denominator: d }) }, ref, ref.money, w);
      if (failed(selected)) return selected;
      ({ point, range, exact, selection } = selected); approx = true;
    } else return error('not_a_number');
    if (own(data, 'source')) {
      const rawSource = data.source;
      const cloned = rawSource === null ? { value: null } : cloneSource(rawSource, w);
      if (failed(cloned)) return cloned;
      source = cloned.value;
    }
  }
  const f = formatted(point, ref.money);
  if (failed(f)) return f;
  // Scalar leaves (notably rates) retain their exact rational until an operation.
  const snapshot: Snapshot = { point: jsonRational(point), unit: u, approx, exact, source };
  if (range) snapshot.range = { min: range.min === null ? null : jsonRational(range.min), max: range.max === null ? null : jsonRational(range.max) };
  return { point, range, money: ref.money, unit: u, approx, exact, text: f.text,
    tree: { kind: 'leaf', ref: refText, selection, snapshot } };
}
function dimensions(op: RequestOperation, args: Numeric[]): { money: boolean; unit: ValueUnit | null } | RequestFailure {
  if (op === 'count') return { money: false, unit: null };
  let u: ValueUnit | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.money && a.unit !== null) {
      if (u !== null && u.key !== a.unit.key) return error('unit_mismatch', i);
      u ??= a.unit;
    }
    if ((op === 'add' || op === 'subtract' || op === 'sum' || op === 'mean') && a.money !== args[0]!.money) return error('unit_mismatch', i);
  }
  if (op === 'multiply' && args[0]!.money && args[1]!.money) return error('unit_mismatch', 1);
  if (op === 'divide' && !args[0]!.money && args[1]!.money) return error('unit_mismatch', 1);
  const money = op === 'divide' ? args[0]!.money && !args[1]!.money : args.some(a => a.money);
  return { money, unit: money ? u : null };
}
type Extended = { infinity: -1 | 1 } | Rational;
const infinite = (v: Extended): v is { infinity: -1 | 1 } => 'infinity' in v;
const sign = (v: Rational): -1 | 0 | 1 => v.numerator < 0n ? -1 : v.numerator > 0n ? 1 : 0;
function extendedProduct(a: Extended, b: Extended, w: CalculationWork): Extended | RequestFailure {
  if (!infinite(a) && !infinite(b)) return arithmetic('multiply', [a, b], w);
  const sa = infinite(a) ? a.infinity : sign(a), sb = infinite(b) ? b.infinity : sign(b);
  return !sa || !sb ? ZERO : { infinity: sa * sb as -1 | 1 };
}
function extendedCompare(a: Extended, b: Extended): number {
  if (infinite(a)) return infinite(b) ? a.infinity - b.infinity : a.infinity;
  return infinite(b) ? -b.infinity : compare(a, b);
}
function intervalProduct(a: Interval, b: Interval, w: CalculationWork): Interval | RequestFailure {
  const ends = (i: Interval): Extended[] => [i.min ?? { infinity: -1 }, i.max ?? { infinity: 1 }];
  let lo: Extended | undefined, hi: Extended | undefined;
  for (const x of ends(a)) for (const y of ends(b)) {
    const p = extendedProduct(x, y, w);
    if (failed(p)) return p;
    if (!lo || extendedCompare(p, lo) < 0) lo = p;
    if (!hi || extendedCompare(p, hi) > 0) hi = p;
  }
  return { min: infinite(lo!) ? null : lo!, max: infinite(hi!) ? null : hi! };
}
function intervalOperation(op: RequestOperation, args: Numeric[], w: CalculationWork): Interval | RequestFailure {
  const intervals = args.map(a => a.range ?? { min: a.point, max: a.point });
  if (op === 'count') return { min: { numerator: BigInt(args.length), denominator: 1n }, max: { numerator: BigInt(args.length), denominator: 1n } };
  if (op === 'multiply') return intervalProduct(intervals[0]!, intervals[1]!, w);
  if (op === 'divide') {
    const d = intervals[1]!;
    const lo = d.max === null ? ZERO : arithmetic('divide', [ONE, d.max], w);
    const hi = d.min === null ? ZERO : arithmetic('divide', [ONE, d.min], w);
    if (failed(lo)) return lo;
    if (failed(hi)) return hi;
    return intervalProduct(intervals[0]!, { min: lo, max: hi }, w);
  }
  const lower = op === 'subtract' ? [intervals[0]!.min, intervals[1]!.max] : intervals.map(i => i.min);
  const upper = op === 'subtract' ? [intervals[0]!.max, intervals[1]!.min] : intervals.map(i => i.max);
  const bound = (values: (Rational | null)[]): Rational | null | RequestFailure => values.some(v => v === null) ? null : arithmetic(op, values as Rational[], w);
  const min = bound(lower), max = bound(upper);
  if (failed(min)) return min;
  if (failed(max)) return max;
  return { min, max };
}
function expression(op: RequestOperation, args: Numeric[]): string {
  const texts = args.map(a => a.text);
  if (op === 'count') return texts.map(() => '1').join(' + ');
  if (op === 'mean') return `(${texts.join(' + ')}) / ${args.length}`;
  return texts.join(op === 'multiply' ? ' × ' : op === 'divide' ? ' / ' : op === 'subtract' ? ' - ' : ' + ');
}
function operation(op: RequestOperation, args: Numeric[], w: CalculationWork): Numeric | RequestFailure {
  const dim = dimensions(op, args);
  if (failed(dim)) return dim;
  if (op === 'divide') {
    const d = args[1]!, r = d.range;
    if (d.point.numerator === 0n || (r && (r.min === null || compare(r.min, ZERO) <= 0) && (r.max === null || compare(r.max, ZERO) >= 0))) return error('division_by_zero', 1);
  }
  const p = arithmetic(op, args.map(a => a.point), w);
  if (failed(p)) return p;
  const f = formatted(p, dim.money);
  if (failed(f)) return f;
  let exact = args.every(a => a.exact) && f.exact;
  let range: Interval | undefined;
  if (args.some(a => a.range !== undefined)) {
    const r = intervalOperation(op, args, w);
    if (failed(r)) return r;
    const min = r.min === null ? null : formatted(r.min, dim.money), max = r.max === null ? null : formatted(r.max, dim.money);
    if (failed(min)) return min;
    if (failed(max)) return max;
    range = { min: min === null ? null : min.point, max: max === null ? null : max.point };
    exact = exact && (min?.exact ?? true) && (max?.exact ?? true);
  }
  const text = expression(op, args);
  if (text.length > CALCULATION_LIMITS.maxExpressionLength) return error('result_too_large');
  return { point: f.point, range, money: dim.money, unit: dim.unit, approx: args.some(a => a.approx), exact,
    text: f.text, expression: text, tree: { kind: 'operation', op, operands: args.map(a => a.tree) } };
}
function requestShape(request: unknown): { op: RequestOperation; operands: unknown[] } | RequestFailure {
  if (!record(request)) return error('invalid_request');
  const op = request.op, operands = request.operands;
  if (typeof op !== 'string') return error('invalid_request');
  if (!OPS.includes(op)) return error('unsupported_operation');
  if (!Array.isArray(operands)) return error('invalid_request');
  const n = operands.length;
  if (n < 1 || n > CALCULATION_LIMITS.maxOperands || (['add', 'subtract', 'multiply', 'divide'].includes(op) && n !== 2)) return error('arity');
  return { op: op as RequestOperation, operands };
}
function node(w: CalculationWork, depth: number): RequestFailure | null {
  w.nodes++;
  return w.nodes > CALCULATION_LIMITS.maxTreeNodes || depth > CALCULATION_LIMITS.maxTreeDepth ? error('result_too_large') : null;
}
function snapshotLeaf(tree: Record<string, unknown>, ref: Ref, w: CalculationWork): Numeric | RequestFailure {
  const snapshot = tree.snapshot, selection = tree.selection;
  if (!record(snapshot) || !record(selection)) return error('invalid_request');
  if ((ref.family === 'a' && ref.endpoint === null && selection.reading !== (ref.reading ?? 1) && selection.endpoint !== 'midpoint')
    || (ref.family !== 'a' && selection.reading !== null)
    || (ref.endpoint !== null && selection.endpoint !== ref.endpoint)
    || (ref.endpoint === null && selection.endpoint !== null && selection.endpoint !== 'midpoint')
    || (selection.endpoint !== null && selection.reading !== null)) return error('invalid_request');
  if (selection.endpoint === 'midpoint' && (ref.endpoint !== null || ref.reading !== null || !['a', 'q', 'r'].includes(ref.family))) return error('invalid_request');
  if (selection.endpoint === null && ref.family === 'a' && selection.reading !== (ref.reading ?? 1)) return error('invalid_request');
  const p = readRational(snapshot.point), u = unit(snapshot.unit);
  if (failed(p)) return p;
  if (failed(u)) return u;
  if (!ref.money && u !== null) return error('invalid_request');
  if ((ref.family === 'b' || ref.kind === 'entry_amount') && u === null) return error('not_a_number');
  if (ref.money && p.denominator !== 1n) return error('not_a_number');
  if (typeof snapshot.approx !== 'boolean' || typeof snapshot.exact !== 'boolean') return error('invalid_request');
  if (ref.family === 'one' && (compare(p, ONE) !== 0 || snapshot.approx || !snapshot.exact || own(snapshot, 'range'))) return error('invalid_request');
  const rawSource = snapshot.source;
  const source = rawSource === null ? { value: null } : cloneSource(rawSource, w);
  if (failed(source)) return source;
  let range: Interval | undefined;
  if (own(snapshot, 'range')) {
    const r = snapshot.range;
    if (!record(r) || selection.endpoint !== 'midpoint') return error('invalid_request');
    const min = r.min === null ? null : readRational(r.min), max = r.max === null ? null : readRational(r.max);
    if (failed(min)) return min;
    if (failed(max)) return max;
    if ((min && max && compare(min, max) > 0) || (min && compare(p, min) < 0) || (max && compare(p, max) > 0)
      || (ref.money && ((min && min.denominator !== 1n) || (max && max.denominator !== 1n)))) return error('not_a_number');
    range = { min, max };
  }
  if (selection.endpoint === 'midpoint' && !range) return error('invalid_request');
  if ((selection.endpoint !== null || range) && !snapshot.approx) return error('invalid_request');
  const f = formatted(p, ref.money);
  if (failed(f)) return f;
  const s: Snapshot = { point: jsonRational(p), unit: u, approx: snapshot.approx, exact: snapshot.exact, source: source.value };
  if (range) s.range = { min: range.min === null ? null : jsonRational(range.min), max: range.max === null ? null : jsonRational(range.max) };
  return { point: p, range, money: ref.money, unit: u, approx: s.approx, exact: s.exact, text: f.text,
    tree: { kind: 'leaf', ref: tree.ref as string, selection: { reading: selection.reading as number | null, endpoint: selection.endpoint as Selection['endpoint'] }, snapshot: s } };
}
/** One DFS visit per occurrence, including repeated subtrees (no DAG shortcut).
 * O(T + J) work, T <= maxTreeNodes and total source JSON J <= maxSourceNodes.
 * Exact arithmetic uses bounded BigInts; recursion is bounded separately. */
function evaluateTree(tree: unknown, values: unknown, fresh: boolean, w: CalculationWork, depth = 1): Numeric | RequestFailure {
  const limit = node(w, depth);
  if (limit) return limit;
  if (!record(tree)) return error('invalid_request');
  if (tree.kind === 'leaf') {
    const ref = parseRef(tree.ref);
    if (failed(ref)) return ref;
    if (ref.family === 'c') return error('unknown_ref');
    if (!fresh) return snapshotLeaf(tree, ref, w);
    if (!record(tree.snapshot) || !record(tree.selection)) return error('invalid_request');
    const current = leaf(tree.ref as string, ref, values, w);
    if (failed(current)) return current;
    const a = (current.tree as CalculationLeaf).selection, b = tree.selection;
    if (a.reading !== b.reading || a.endpoint !== b.endpoint) return error('unknown_ref');
    return current;
  }
  if (tree.kind !== 'operation') return error('invalid_request');
  const shaped = requestShape(tree);
  if (failed(shaped)) return shaped;
  const args: Numeric[] = [];
  for (let i = 0; i < shaped.operands.length; i++) {
    let a: Numeric | RequestFailure;
    try { a = evaluateTree(shaped.operands[i], values, fresh, w, depth + 1); }
    catch { a = error('invalid_request'); }
    if (failed(a)) return a.operand === null ? error(a.error, i) : a;
    args.push(a);
  }
  const computed = operation(shaped.op, args, w);
  if (failed(computed)) return computed;
  if (own(tree, 'endpoint')) {
    if (tree.endpoint !== 'min' && tree.endpoint !== 'max') return error('invalid_request');
    const selected = selectResult(computed, { endpoint: tree.endpoint } as Ref);
    if (failed(selected)) return selected;
    return selected;
  }
  return computed;
}
function selectResult(a: Numeric, ref: Ref): Numeric | RequestFailure {
  if (!ref.endpoint) return a;
  if (!a.range) return error('unknown_ref');
  const point = a.range[ref.endpoint];
  if (point === null) return error('not_a_number');
  const f = formatted(point, a.money);
  if (failed(f)) return f;
  // An endpoint of a c annotates the expanded operation node. Replaying first
  // computes that operation (and its rounding), then selects the saved endpoint.
  return { ...a, point, range: undefined, text: f.text, expression: f.text,
    tree: { ...a.tree, endpoint: ref.endpoint } as CalculationTree };
}
function tool(a: Numeric, ref: string): ToolSuccess {
  const result: ToolSuccess = { ok: true, ref, value: a.text, unit: a.unit?.display ?? null,
    money: a.money, approx: a.approx, exact: a.exact,
    expression: a.expression ?? a.text };
  if (a.range) result.range = { min: a.range.min === null ? null : a.money ? moneyText(a.range.min.numerator) : formatRational(a.range.min, CALCULATION_LIMITS.scalarScale).value,
    max: a.range.max === null ? null : a.money ? moneyText(a.range.max.numerator) : formatRational(a.range.max, CALCULATION_LIMITS.scalarScale).value };
  return result;
}
function amounts(a: Numeric): MoneyAmounts | undefined {
  if (!a.money) return undefined;
  const out: MoneyAmounts = { cents: a.point.numerator };
  if (a.range) out.range = { min: a.range.min?.numerator ?? null, max: a.range.max?.numerator ?? null };
  return out;
}
export function createCalculationExecution(): CalculationExecution { return { results: [] }; }

/** All errors are values; on failure the exact input state object is returned.
 * O(S + T + J): copies S existing result pointers and expands at most T tree nodes.
 * Only successful calls consume a c number. No caller object is mutated. */
export function executeCalculation(request: unknown, values: unknown, state: CalculationExecution = createCalculationExecution()): ExecutionStep {
  const w = work();
  const stop = (result: RequestFailure): ExecutionStep => ({ state, result, work: w });
  try {
    const shaped = requestShape(request);
    if (failed(shaped)) return stop(shaped);
    if (!record(state) || !Array.isArray(state.results)) return stop(error('invalid_request'));
    const results = state.results;
    if (results.length >= CALCULATION_LIMITS.maxResults) return stop(error('result_too_large'));
    node(w, 1);
    const args: Numeric[] = [];
    for (let i = 0; i < shaped.operands.length; i++) {
      let a: Numeric | RequestFailure;
      try {
        const text = shaped.operands[i], ref = parseRef(text);
        if (failed(ref)) a = ref;
        else if (ref.family === 'c') {
          w.references++;
          if (ref.index! >= results.length + 1 || !own(results, String(ref.index! - 1))) a = error('unknown_ref');
          else {
            a = evaluateTree(results[ref.index! - 1], null, false, w, 2);
            if (!failed(a)) a = selectResult(a, ref);
          }
        } else {
          const limit = node(w, 2);
          a = limit ?? leaf(text as string, ref, values, w);
        }
      } catch { a = error('not_a_number'); }
      if (failed(a)) return stop(error(a.error, i));
      args.push(a);
    }
    const a = operation(shaped.op, args, w);
    if (failed(a)) return stop(a);
    const result = tool(a, `c${results.length + 1}`);
    const next: CalculationTree[] = [];
    for (let i = 0; i < results.length; i++) { next.push(results[i]!); w.stateEntries++; }
    next.push(a.tree);
    return { state: { results: next }, result, work: w, tree: a.tree, ...(a.money ? { amounts: amounts(a) } : {}) };
  } catch { return stop(error('invalid_request')); }
}

/** Declared refs are checked before execution. A failed item does not shift any
 * later declared name to another result. The list is bounded and evaluated in order. */
export function computeCalculations(requests: unknown, values: unknown, state: CalculationExecution = createCalculationExecution()): { state: CalculationExecution; steps: ExecutionStep[]; error?: RequestFailure } {
  const steps: ExecutionStep[] = [];
  try {
    if (!Array.isArray(requests)) return { state, steps, error: error('invalid_request') };
    if (requests.length > CALCULATION_LIMITS.maxRequests) return { state, steps, error: error('result_too_large') };
    for (let i = 0; i < requests.length; i++) {
      let step: ExecutionStep;
      try {
        const request = requests[i];
        if (!record(request)) step = { state, result: error('invalid_request'), work: work() };
        else if (request.ref !== `c${state.results.length + 1}`) step = { state, result: error('unknown_ref'), work: work() };
        else step = executeCalculation(request, values, state);
      } catch { step = { state, result: error('invalid_request'), work: work() }; }
      steps.push(step); state = step.state;
    }
    return { state, steps };
  } catch { return { state, steps, error: error('invalid_request') }; }
}

/** Recompute an untrusted JSON tree from fresh program values, preserving selection
 * and operation boundaries (including each c's rounding). ref is only an output label. */
export function replayCalculation(tree: unknown, values: unknown, ref = 'c1'): Omit<ExecutionStep, 'state'> {
  const w = work();
  try {
    if (typeof ref !== 'string' || ref.length > CALCULATION_LIMITS.maxRefLength || !OUTPUT_REF_PATTERN.test(ref)) return { result: error('unknown_ref'), work: w };
    const a = evaluateTree(tree, values, true, w);
    if (failed(a)) return { result: a, work: w };
    return { result: tool(a, ref), work: w, tree: a.tree, ...(a.money ? { amounts: amounts(a) } : {}) };
  } catch { return { result: error('invalid_request'), work: w }; }
}

/** Validate and list every leaf occurrence in DFS order. O(T + J), with the same
 * bounds as replay. Source JSON is detached and its bytes/key order are preserved. */
export function listCalculationLeaves(tree: unknown): { ok: true; leaves: LeafDescription[]; work: CalculationWork } | (RequestFailure & { work: CalculationWork }) {
  const w = work();
  try {
    const a = evaluateTree(tree, null, false, w);
    if (failed(a)) return { ...a, work: w };
    const leaves: LeafDescription[] = [];
    const visit = (t: CalculationTree): void => {
      w.listedNodes++;
      if (t.kind === 'operation') { for (const child of t.operands) visit(child); return; }
      const r = parseRef(t.ref) as Ref;
      leaves.push({ ref: t.ref, kind: r.kind as LeafDescription['kind'], dimension: r.money ? 'money' : 'scalar',
        unitKey: t.snapshot.unit?.key ?? null, unit: t.snapshot.unit?.display ?? null,
        reading: t.selection.reading, endpoint: t.selection.endpoint, source: t.snapshot.source });
    };
    visit(a.tree);
    return { ok: true, leaves, work: w };
  } catch { return { ...error('invalid_request'), work: w }; }
}
