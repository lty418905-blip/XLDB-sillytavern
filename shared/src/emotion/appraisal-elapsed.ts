import { ELAPSED_WORDS } from './appraisal-wording.ts';

// Millisecond units and bucket edges belong to the provisional appraisal input scale.
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;
const MONTH_MS = 2_630_016_000;
const YEAR_MS = 31_557_600_000;
const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

/**
 * Writes a positive integer up to 9999 as a Chinese numeral, the supported story-year span.
 * Two is 两 alone and in hundreds/thousands, 二 in tens/ones; invalid input throws RangeError.
 * At most four positions are visited; no user text is scanned.
 */
export function chineseNumber(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 9999) {
    throw new RangeError('invalid_chinese_number');
  }
  if (value === 2) {
    return '两';
  }

  let result = '';
  let pendingZero = false;
  let remaining = value;
  const positions = [[1000, '千'], [100, '百'], [10, '十'], [1, '']] as const;

  for (const [place, unit] of positions) {
    const digit = Math.floor(remaining / place);
    remaining %= place;
    if (digit === 0) {
      pendingZero = result.length > 0 && remaining > 0;
      continue;
    }

    if (pendingZero) {
      result += DIGITS[0];
      pendingZero = false;
    }
    // Only a leading ten omits its one; interior tens retain it.
    if (!(place === 10 && digit === 1 && result.length === 0)) {
      result += digit === 2 && place >= 100 ? '两' : DIGITS[digit];
    }
    result += unit;
  }

  return result;
}

function roundedUnits(milliseconds: number, unit: number): number {
  // BigInt keeps the half-up boundary exact even when doubling a safe integer would exceed its range.
  const duration = BigInt(milliseconds);
  const divisor = BigInt(unit);
  return Math.max(1, Number((2n * duration + divisor) / (2n * divisor)));
}

/**
 * Returns a coarse time phrase for a positive safe-integer millisecond advance, or undefined when absent.
 * Below twelve hours requires an explicit advance; zero and negative advances are always absent.
 * Invalid milliseconds throw TypeError; a rounded year count above 9999 throws RangeError.
 * Pure constant work, independent of chat length; clock availability is checked by the caller.
 */
export function elapsedWording(milliseconds: number, hasExplicitAdvance: boolean): string | undefined {
  if (!Number.isSafeInteger(milliseconds)) {
    throw new TypeError('invalid_elapsed_milliseconds');
  }
  if (milliseconds <= 0 || (!hasExplicitAdvance && milliseconds < 12 * HOUR_MS)) {
    return undefined;
  }
  if (milliseconds < HOUR_MS) {
    return ELAPSED_WORDS[0];
  }
  if (milliseconds < 12 * HOUR_MS) {
    return ELAPSED_WORDS[1];
  }
  if (milliseconds < 36 * HOUR_MS) {
    return ELAPSED_WORDS[2];
  }

  let template: string;
  let unit: number;
  if (milliseconds < 7 * DAY_MS) {
    template = ELAPSED_WORDS[3];
    unit = DAY_MS;
  } else if (milliseconds < 56 * DAY_MS) {
    template = ELAPSED_WORDS[4];
    unit = WEEK_MS;
  } else if (milliseconds < 335 * DAY_MS) {
    template = ELAPSED_WORDS[5];
    unit = MONTH_MS;
  } else {
    template = ELAPSED_WORDS[6];
    unit = YEAR_MS;
  }

  return template.replace('N', chineseNumber(roundedUnits(milliseconds, unit)));
}
