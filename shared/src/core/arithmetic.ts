export const ARITHMETIC_LIMITS = Object.freeze({
  maxSourceLength: 100_000,
  maxOperands: 64,
  maxDecimalDigits: 100,
  maxValueLength: 256,
  maxResultDigits: 1_000,
  maxQuoteLength: 500,
  maxUnitLength: 32,
  maxScale: 18,
  defaultScale: 12,
});

export type CalculationOperation =
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'sum'
  | 'mean'
  | 'count'
  | 'timestamp_difference';

export type CalculationErrorCode =
  | 'invalid_source'
  | 'source_too_large'
  | 'invalid_candidate'
  | 'unsupported_operation'
  | 'invalid_operands'
  | 'operand_limit_exceeded'
  | 'invalid_operand'
  | 'value_too_large'
  | 'invalid_decimal'
  | 'decimal_too_large'
  | 'invalid_timestamp'
  | 'timestamp_timezone_required'
  | 'missing_quote'
  | 'quote_too_large'
  | 'quote_not_found'
  | 'value_not_grounded'
  | 'invalid_unit'
  | 'unit_not_grounded'
  | 'missing_unit'
  | 'unit_conversion_unsupported'
  | 'invalid_scale'
  | 'division_by_zero'
  | 'result_too_large';

export interface CalculationOperand {
  value: string;
  quote: string;
  unit: string | null;
}

export interface CalculationSuccess {
  ok: true;
  operation: CalculationOperation;
  value: string;
  unit: string | null;
  exact: boolean;
  scale: number;
  rounding: 'half_away_from_zero';
  operands: CalculationOperand[];
}

export interface CalculationFailure {
  ok: false;
  error: {
    code: CalculationErrorCode;
    operandIndex?: number;
  };
}

export type CalculationResult = CalculationSuccess | CalculationFailure;

interface Rational {
  numerator: bigint;
  denominator: bigint;
}

interface ParsedOperand extends CalculationOperand {
  rational: Rational;
}

interface ParsedTimestampOperand extends CalculationOperand {
  epochMs: bigint;
}

const OPERATIONS = new Set<CalculationOperation>([
  'add', 'subtract', 'multiply', 'divide', 'sum', 'mean', 'count', 'timestamp_difference',
]);
const DECIMAL_PATTERN = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/;
// Reject fragments of grouped/scientific numbers, dates, paths, and ASCII identifiers.
const DECIMAL_TOKEN_PATTERN = /(?<![\d.A-Za-z_,:/])[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?![\d.A-Za-z_,:/-])/g;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const TIME_UNITS = new Map<string, bigint>([
  ['milliseconds', 1n],
  ['seconds', 1_000n],
  ['minutes', 60_000n],
  ['hours', 3_600_000n],
  ['days', 86_400_000n],
]);

/** Validate a model-proposed calculation against its source text, then compute it deterministically. */
export function calculate(candidate: unknown, source: string): CalculationResult {
  if (typeof source !== 'string') return failure('invalid_source');
  if (source.length > ARITHMETIC_LIMITS.maxSourceLength) return failure('source_too_large');
  if (!isRecord(candidate)) return failure('invalid_candidate');

  const operation = candidate.operation;
  if (typeof operation !== 'string' || !OPERATIONS.has(operation as CalculationOperation)) {
    return failure('unsupported_operation');
  }
  const typedOperation = operation as CalculationOperation;
  if (!Array.isArray(candidate.operands) || candidate.operands.length === 0) {
    return failure('invalid_operands');
  }
  if (candidate.operands.length > ARITHMETIC_LIMITS.maxOperands) {
    return failure('operand_limit_exceeded');
  }

  const scale = readScale(candidate.scale);
  if (scale === null) return failure('invalid_scale');
  const resultUnit = readUnit(candidate.resultUnit);
  if (isFailure(resultUnit)) return resultUnit;

  if (typedOperation === 'timestamp_difference') {
    return calculateTimestampDifference(candidate.operands, source, resultUnit, scale);
  }

  const arityError = validateArity(typedOperation, candidate.operands.length);
  if (arityError) return arityError;
  const parsed = parseDecimalOperands(candidate.operands, source);
  if (isFailure(parsed)) return parsed;

  const outputUnit = resolveUnit(typedOperation, parsed, resultUnit);
  if (isFailure(outputUnit)) return outputUnit;
  const computed = computeRational(typedOperation, parsed.map(operand => operand.rational));
  if (isFailure(computed)) return computed;
  if (!withinResultBounds(computed)) return failure('result_too_large');

  const formatted = formatRational(computed, scale);
  return {
    ok: true,
    operation: typedOperation,
    value: formatted.value,
    unit: outputUnit,
    exact: formatted.exact,
    scale,
    rounding: 'half_away_from_zero',
    operands: parsed.map(({ value, quote, unit }) => ({ value, quote, unit })),
  };
}

function calculateTimestampDifference(
  operands: unknown[],
  source: string,
  resultUnit: string | null,
  scale: number,
): CalculationResult {
  if (operands.length !== 2) return failure('invalid_operands');
  if (resultUnit === null) return failure('missing_unit');
  const divisor = TIME_UNITS.get(resultUnit);
  if (divisor === undefined) return failure('unit_conversion_unsupported');

  const parsed: ParsedTimestampOperand[] = [];
  for (let index = 0; index < operands.length; index += 1) {
    const operand = readBaseOperand(operands[index], source, index);
    if (isFailure(operand)) return operand;
    if (operand.unit !== null) return failure('unit_conversion_unsupported', index);
    if (!operand.quote.includes(operand.value)) return failure('value_not_grounded', index);
    const timestamp = parseTimestamp(operand.value);
    if (isFailure(timestamp)) return withOperandIndex(timestamp, index);
    parsed.push({ ...operand, epochMs: timestamp });
  }

  const difference: Rational = normalize({
    numerator: parsed[1]!.epochMs - parsed[0]!.epochMs,
    denominator: divisor,
  });
  const formatted = formatRational(difference, scale);
  return {
    ok: true,
    operation: 'timestamp_difference',
    value: formatted.value,
    unit: resultUnit,
    exact: formatted.exact,
    scale,
    rounding: 'half_away_from_zero',
    operands: parsed.map(({ value, quote, unit }) => ({ value, quote, unit })),
  };
}

function parseDecimalOperands(operands: unknown[], source: string): ParsedOperand[] | CalculationFailure {
  const parsed: ParsedOperand[] = [];
  for (let index = 0; index < operands.length; index += 1) {
    const operand = readBaseOperand(operands[index], source, index);
    if (isFailure(operand)) return operand;
    const rational = parseDecimal(operand.value);
    if (isFailure(rational)) return withOperandIndex(rational, index);
    if (!quoteGroundsDecimal(operand.quote, rational)) return failure('value_not_grounded', index);
    if (operand.unit !== null && !quoteGroundsDecimal(operand.quote, rational, operand.unit)) return failure('unit_not_grounded', index);
    parsed.push({ ...operand, rational });
  }
  return parsed;
}

function readBaseOperand(value: unknown, source: string, index: number): CalculationOperand | CalculationFailure {
  if (!isRecord(value) || typeof value.value !== 'string') return failure('invalid_operand', index);
  if (value.value.length > ARITHMETIC_LIMITS.maxValueLength) return failure('value_too_large', index);
  if (typeof value.quote !== 'string' || value.quote.length === 0) return failure('missing_quote', index);
  if (value.quote.length > ARITHMETIC_LIMITS.maxQuoteLength) return failure('quote_too_large', index);
  if (!source.includes(value.quote)) return failure('quote_not_found', index);
  const unit = readUnit(value.unit);
  if (isFailure(unit)) return withOperandIndex(unit, index);
  if (unit !== null && !quoteGroundsUnit(value.quote, unit)) return failure('unit_not_grounded', index);
  return { value: value.value, quote: value.quote, unit };
}

function parseDecimal(value: string): Rational | CalculationFailure {
  if (!DECIMAL_PATTERN.test(value)) return failure('invalid_decimal');
  const unsigned = value[0] === '+' || value[0] === '-' ? value.slice(1) : value;
  const digits = unsigned.replace('.', '');
  if (digits.length > ARITHMETIC_LIMITS.maxDecimalDigits) return failure('decimal_too_large');
  const fractionalDigits = unsigned.includes('.') ? unsigned.length - unsigned.indexOf('.') - 1 : 0;
  const sign = value.startsWith('-') ? -1n : 1n;
  return normalize({ numerator: sign * BigInt(digits), denominator: 10n ** BigInt(fractionalDigits) });
}

function quoteGroundsDecimal(quote: string, expected: Rational, unit?: string): boolean {
  for (const match of quote.matchAll(DECIMAL_TOKEN_PATTERN)) {
    const parsed = parseDecimal(match[0]);
    if (!isFailure(parsed) && rationalsEqual(parsed, expected)) {
      if (unit === undefined) return true;
      const suffix = quote.slice(match.index! + match[0].length).trimStart();
      if (suffix.startsWith(unit) && (!/^[A-Za-z]/.test(unit) || !/[A-Za-z_]/.test(suffix[unit.length] ?? ''))) return true;
    }
  }
  return false;
}

function quoteGroundsUnit(quote: string, unit: string): boolean {
  let position = quote.indexOf(unit);
  while (position !== -1) {
    const before = quote[position - 1] ?? '';
    const after = quote[position + unit.length] ?? '';
    // ASCII word units must not be a substring of another word. Numeric adjacency
    // is left to the stricter decimal-token check.
    if (!/^[A-Za-z]/.test(unit) || (!/[A-Za-z_]/.test(before) && !/[A-Za-z_]/.test(after))) return true;
    position = quote.indexOf(unit, position + 1);
  }
  return false;
}

function parseTimestamp(value: string): bigint | CalculationFailure {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    const withoutZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value);
    return failure(withoutZone ? 'timestamp_timezone_required' : 'invalid_timestamp');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)
    || hour > 23 || minute > 59 || second > 59) return failure('invalid_timestamp');

  let offsetMinutes = 0;
  const zone = match[8]!;
  if (zone !== 'Z') {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return failure('invalid_timestamp');
    }
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (zone[0] === '-' ? -1 : 1);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  const epochMs = date.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(epochMs) ? BigInt(epochMs) : failure('invalid_timestamp');
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validateArity(operation: CalculationOperation, length: number): CalculationFailure | null {
  if (operation === 'add' || operation === 'subtract' || operation === 'multiply' || operation === 'divide') {
    return length === 2 ? null : failure('invalid_operands');
  }
  return null;
}

function computeRational(operation: CalculationOperation, values: Rational[]): Rational | CalculationFailure {
  if (operation === 'count') return { numerator: BigInt(values.length), denominator: 1n };
  if (operation === 'add' || operation === 'sum') return fold(values, addRational);
  if (operation === 'subtract') return addRational(values[0]!, negate(values[1]!));
  if (operation === 'multiply') return multiplyRational(values[0]!, values[1]!);
  if (operation === 'divide') return divideRational(values[0]!, values[1]!);
  if (operation === 'mean') {
    const total = fold(values, addRational);
    if (isFailure(total)) return total;
    return divideRational(total, { numerator: BigInt(values.length), denominator: 1n });
  }
  return failure('unsupported_operation');
}

function fold(values: Rational[], operation: (left: Rational, right: Rational) => Rational): Rational | CalculationFailure {
  let result: Rational = { numerator: 0n, denominator: 1n };
  for (const value of values) {
    result = operation(result, value);
    if (!withinResultBounds(result)) return failure('result_too_large');
  }
  return result;
}

function addRational(left: Rational, right: Rational): Rational {
  return normalize({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

function multiplyRational(left: Rational, right: Rational): Rational {
  return normalize({ numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator });
}

function divideRational(left: Rational, right: Rational): Rational | CalculationFailure {
  if (right.numerator === 0n) return failure('division_by_zero');
  return normalize({ numerator: left.numerator * right.denominator, denominator: left.denominator * right.numerator });
}

function negate(value: Rational): Rational {
  return { numerator: -value.numerator, denominator: value.denominator };
}

function normalize(value: Rational): Rational {
  if (value.numerator === 0n) return { numerator: 0n, denominator: 1n };
  const sign = value.denominator < 0n ? -1n : 1n;
  const numerator = value.numerator * sign;
  const denominator = value.denominator * sign;
  const divisor = greatestCommonDivisor(abs(numerator), denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function formatRational(value: Rational, scale: number): { value: string; exact: boolean } {
  const negative = value.numerator < 0n;
  const multiplier = 10n ** BigInt(scale);
  const scaled = abs(value.numerator) * multiplier;
  let rounded = scaled / value.denominator;
  const remainder = scaled % value.denominator;
  if (remainder * 2n >= value.denominator) rounded += 1n;

  let text = rounded.toString();
  if (scale > 0) {
    text = text.padStart(scale + 1, '0');
    const split = text.length - scale;
    text = `${text.slice(0, split)}.${text.slice(split)}`.replace(/\.?0+$/, '');
  }
  if (negative && rounded !== 0n) text = `-${text}`;
  return { value: text, exact: remainder === 0n };
}

function resolveUnit(
  operation: CalculationOperation,
  operands: CalculationOperand[],
  requested: string | null,
): string | null | CalculationFailure {
  if (operation === 'count') return requested ?? 'count';
  const units = operands.map(operand => operand.unit);
  let inferred: string | null;

  if (operation === 'add' || operation === 'subtract' || operation === 'sum' || operation === 'mean') {
    const present = units.filter((unit): unit is string => unit !== null);
    if (present.length > 0 && present.length !== units.length) return failure('missing_unit');
    if (present.some(unit => unit !== present[0])) return failure('unit_conversion_unsupported');
    inferred = present[0] ?? null;
  } else if (operation === 'multiply') {
    const present = units.filter((unit): unit is string => unit !== null);
    if (present.length > 1) return failure('unit_conversion_unsupported');
    inferred = present[0] ?? null;
  } else {
    const numeratorUnit = units[0] ?? null;
    const denominatorUnit = units[1] ?? null;
    if (denominatorUnit === null) inferred = numeratorUnit;
    else if (numeratorUnit !== null && numeratorUnit === denominatorUnit) inferred = null;
    else return failure('unit_conversion_unsupported');
  }

  if (requested !== null && inferred === null) return failure('missing_unit');
  if (requested !== null && requested !== inferred) return failure('unit_conversion_unsupported');
  return inferred;
}

function readScale(value: unknown): number | null {
  if (value === undefined) return ARITHMETIC_LIMITS.defaultScale;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= ARITHMETIC_LIMITS.maxScale
    ? value : null;
}

function readUnit(value: unknown): string | null | CalculationFailure {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return failure('invalid_unit');
  const unit = value.trim();
  if (unit.length === 0 || unit.length > ARITHMETIC_LIMITS.maxUnitLength || /[\u0000-\u001f\u007f]/.test(unit)) {
    return failure('invalid_unit');
  }
  return unit;
}

function rationalsEqual(left: Rational, right: Rational): boolean {
  return left.numerator === right.numerator && left.denominator === right.denominator;
}

function withinResultBounds(value: Rational): boolean {
  return abs(value.numerator).toString().length <= ARITHMETIC_LIMITS.maxResultDigits
    && value.denominator.toString().length <= ARITHMETIC_LIMITS.maxResultDigits;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: CalculationErrorCode, operandIndex?: number): CalculationFailure {
  return operandIndex === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, operandIndex } };
}

function isFailure(value: unknown): value is CalculationFailure {
  return isRecord(value) && value.ok === false && isRecord(value.error) && typeof value.error.code === 'string';
}

function withOperandIndex(error: CalculationFailure, operandIndex: number): CalculationFailure {
  return failure(error.error.code, operandIndex);
}
