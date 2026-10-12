import { foldForMatch } from './script-fold.ts';

/**
 * Identifies yuan, a configured named currency, or no written unit (null).
 * Named words retain the caller-provided folded spelling; this type carries no numeric value.
 * A null unit marks a bare candidate, not a failed read.
 */
export type AmountUnit = {
  kind: 'yuan';
} | {
  kind: 'named';
  word: string;
} | null;

/**
 * Configures named currency words, already folded by the caller; no text length limit is imposed here.
 * Yuan-family words and empty/non-string entries are ignored; invalid or inaccessible arrays use no named units.
 * Matching checks the existing order and keeps the longest applicable word; no caller array is mutated.
 */
export interface Options {
  units?: readonly string[];
}

/**
 * One possible amount in integer hundredths of yuan or of the configured named unit.
 * end is an exclusive UTF-16 offset in the original input; ambiguity keeps a separate end for each reading.
 * Failed reads are represented by the enclosing parser result, not by an invalid Reading.
 */
export type Reading = {
  cents: bigint;
  end: number;
};

/**
 * An amount candidate with a half-open original UTF-16 span and its written unit, or null for a bare unit.
 * readings retains every alternative in integer hundredths; range uses null for an unknown/open bound.
 * approx describes estimation, not transaction evidence. Parsers return null or omit a failed candidate.
 * setAsideLeftNumerals marks an additional scan-only reading: one/two omit adjacent field characters;
 * acrossWhitespace omits numerals across inline blanks; beforeYenSign omits numerals before a yen sign;
 * beforeFullWidthComma omits the first grouped section; beforeClockPoint omits a clock hour before 点.
 */
export type AmountExpression = {
  start: number;
  end: number;
  unit: AmountUnit;
  bare: boolean;
  setAsideLeftNumerals?: 'one' | 'two' | 'acrossWhitespace' | 'beforeYenSign'
    | 'beforeFullWidthComma' | 'beforeClockPoint';
} & ({
  kind: 'readings';
  readings: Reading[];
  approx: boolean;
} | {
  kind: 'range';
  min: bigint | null;
  max: bigint | null;
  approx: true;
});

/**
 * A quantity candidate with a half-open original UTF-16 span excluding ordinary classifiers.
 * exact counts and non-null range bounds are safe integers in items; null bounds are unknown/open.
 * Fractions return kind unsupported with reason fraction; other failed reads are null or omitted.
 */
export type QuantityExpression = {
  start: number;
  end: number;
} & ({
  kind: 'exact';
  count: number;
} | {
  kind: 'range';
  min: number | null;
  max: number | null;
  approx: true;
} | {
  kind: 'unsupported';
  reason: 'fraction';
});

/**
 * A discount multiplier with a half-open original UTF-16 span, expressed as numerator / denominator.
 * Numerators and range bounds are percentage points; the denominator stays 100 without fraction reduction.
 * null bounds are unknown; unreadable bodies are null or omitted, rather than assigned a guessed rate.
 */
export type RateExpression = {
  start: number;
  end: number;
} & ({
  kind: 'exact';
  numerator: bigint;
  denominator: bigint;
} | {
  kind: 'range';
  min: bigint | null;
  max: bigint | null;
  denominator: bigint;
  approx: true;
});

// Closed spelling tables, built once. No state is retained between calls.
const SMALL_DIGITS = '一二三四五六七八九';

const CAPITAL_NUMERALS = '壹贰叁参肆伍陆柒捌玖拾佰仟';

const NUMERIC_FIELD_CHARACTERS = new Set('0123456789零一二三四五六七八九两十百千万亿廿卅卌几' + CAPITAL_NUMERALS);

const PLAIN_NUMBER_CHARACTERS = new Set('0123456789零一二三四五六七八九两十百千万亿廿卅卌几半俩仨');

const PLACE_VALUES: Readonly<Record<string, bigint>> = {
  十: 10n,
  百: 100n,
  千: 1000n,
  万: 10000n,
  亿: 100000000n
};

const BIG_SECTIONS = [
  ['亿', 100000000n],
  ['万', 10000n]
] as const;

const MISSING_COEFFICIENT = new Set(['百', '千', '万']);

const YUAN_WORDS = new Set(['元', '圆', '块']);

const CAPITAL_FOLD: Readonly<Record<string, string>> = {
  壹: '一',
  贰: '二',
  叁: '三',
  参: '三',
  肆: '四',
  伍: '五',
  陆: '六',
  柒: '七',
  捌: '八',
  玖: '九',
  拾: '十',
  佰: '百',
  仟: '千'
};

const MODAL_PARTICLES = new Set('吧啦喔哦呢了啊呀嘛啰咯');

const QUANTITY_CLASSIFIERS = new Set('个位名员人口户家头匹条张片页篇份本册卷部套副双件柄根枝支杆颗粒枚锭朵株棵丛座栋幢间扇面堵道辆艘架台盏幅句段节项笔桩宗味帖剂丸瓣滴股缕样种类具处组队些群堆排列串束捆袋盒箱罐桶壶瓶杯碗盘碟锅篮筐坛缸勺匙桌席叠沓餐斤克吨磅尺寸丈里米亩顷斗石度趟遍番阵声步眼拳脚剑枪箭招式圈轮顿倍');

const QUANTITY_CLASSIFIER_WORDS = ['公斤', '公里', '公分', '公尺', '公升', '公克', '公吨', '公顷', '公亩', '毫升', '毫米', '毫克', '厘米', '平米'];

const TIME_CLASSIFIERS = new Set('年月日号天周旬季夜世点时分秒刻次级届期版章集档线岁楼层室');

const TIME_CLASSIFIER_WORDS = ['小时', '星期', '礼拜'];

const EXCEPTIONS = [
  '本钱',
  '本金',
  '本来',
  '人民币',
  '人家',
  '人工',
  '根本',
  '台币',
  '餐费',
  '套餐',
  '支付',
  '支出',
  '头期',
  '日元',
  '日圆',
  '日币',
  '月租',
  '月薪',
  '月供',
  '年费',
  '年薪'
];

const ADJACENT_DIGIT_PAIRS = new Set(['一二', '一两', '二三', '两三', '三四', '四五', '五六', '六七', '七八', '八九', '三五']);

const UPWARD_MAGNITUDES = new Set(['百', '千', '万', '亿', '十万', '百万', '千万', '十亿', '百亿', '千亿', '万亿']);

type ApproximationModifier = 'point' | 'lower' | 'upper' | 'more' | 'head';

const PREFIXES: readonly (readonly [
  string,
  ApproximationModifier
])[] = [
  ['不超过', 'upper'],
  ['差不多', 'point'],
  ['大概', 'point'],
  ['大约', 'point'],
  ['约莫', 'point'],
  ['将近', 'point'],
  ['接近', 'point'],
  ['至少', 'lower'],
  ['最少', 'lower'],
  ['起码', 'lower'],
  ['不止', 'lower'],
  ['超过', 'lower'],
  ['不到', 'upper'],
  ['最多', 'upper'],
  ['至多', 'upper'],
  ['顶多', 'upper'],
  ['约', 'point'],
  ['近', 'point'],
  ['快', 'point']
];

const SUFFIXES: readonly (readonly [
  string,
  ApproximationModifier
])[] = [
  ['左右', 'point'],
  ['上下', 'point'],
  ['以上', 'lower'],
  ['开外', 'lower'],
  ['以下', 'upper'],
  ['以内', 'upper'],
  ['之内', 'upper'],
  ['有找', 'upper'],
  ['出头', 'head']
];

const LETTER_CHARACTER = /\p{L}/u;

const LATIN_CHARACTER = /[A-Za-z]/;

const FRAGMENT_EDGE_CHARACTER = /[\s\p{Pi}\p{Pf}\p{Ps}\p{Pe}，。！？、；：,;:!?…“”‘’「」『』]/u;

const CLAUSE_END_CHARACTER = /[，。！？、；：,;:!?…\p{Pf}\p{Pe}\n\r]/u;

const ARABIC_NUMBER_PATTERN = /^(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?$/;

// A fullwidth comma groups whole sections exactly like its ASCII twin; one spelling never mixes the two.
const FULL_WIDTH_GROUPED_PATTERN = /^[1-9][0-9]{0,2}(?:，[0-9]{3})+(?:\.[0-9]{1,2})?$/;

const CHINESE_CENTS_TAIL_PATTERN = /^[一二三四五六七八九]十[一二三四五六七八九]?$/;

const DECIMAL_RATE_PATTERN = /^[0-9]\.[0-9]$/;

const TWO_DIGIT_RATE_PATTERN = /^[1-9]{2}$/;

// Period words identify clock hours only in rates; blanks break their adjacency to the hour.
const TIME_OF_DAY_WORDS = new Set([
  '上午',
  '下午',
  '早上',
  '晚上',
  '凌晨',
  '中午',
  '傍晚',
  '今晚',
  '今早',
  '明早',
  '明晚',
  '昨晚',
  '每晚',
  '当晚',
  '半夜',
  '清晨',
  '早晨',
  '深夜',
  '午夜'
]);

// Day words identify clock hours in rates and in scan-only monetary alternatives.
const DAY_WORDS = new Set([
  '今天',
  '明天',
  '昨天',
  '后天',
  '每天',
  '每日',
  '当天',
  '今日',
  '明日',
  '昨日'
]);

const REJECTED_LEFT_SIGNS = new Set(['+', '-', '＋', '－', '−', '负', '$', '＄']);

// The fullwidth hyphen and the minus sign join a range exactly like the ASCII hyphen; the en dash stays out.
const AMOUNT_CONNECTORS = new Set('到至-~～—、－−');

const QUANTITY_CONNECTORS = new Set('到至-~～－−');

// These five capital numerals can also end ordinary words such as 人参, 收拾, 大陆, 队伍 and 放肆;
// an ordinary letter directly before one of them releases the numeric field in the closed
// word-ending cases below.
const WORD_ENDING_CAPITALS = '参拾陆伍肆';

// A place value releases a following Arabic number only without its own written coefficient.
const RELEASING_PLACE_VALUES = '百千万亿';

const isInlineWhitespace = (character: string | undefined) =>
  character === ' ' || character === '\t' || character === '　';

const isArabicDigit = (character: string | undefined) =>
  character !== undefined && character >= '0' && character <= '9';

const readSmallDigit = (character: string | undefined): bigint | null => {
  if (!character || character.length !== 1) {
    return null;
  }

  if (character >= '1' && character <= '9') {
    return BigInt(character);
  }

  const digitIndex = SMALL_DIGITS.indexOf(character);

  return digitIndex < 0 ? null : BigInt(digitIndex + 1);
};

const isNumberCharacter = (character: string | undefined) =>
  // 半/俩/仨 are lexical numeric starts even when a particular value reader cannot accept them.
  // For example, scanNumbers("半俩仨") returns the single span [0, 3).
  character !== undefined && (NUMERIC_FIELD_CHARACTERS.has(character) || '半俩仨'.includes(character));

/**
 * Returns the exclusive end of a fullwidth-comma grouped number at startPosition, or -1 when the text
 * there does not form one. A grouped number is one to three Arabic digits that do not start with 0
 * followed by one or more groups of a fullwidth comma and exactly three digits, read as the same
 * digits grouped with ASCII commas. startPosition is the index of the first digit in the folded text
 * and the result is a UTF-16 position. The character directly before the first digit, the grouping
 * itself and the character directly after the run decide, so 1，2345, 1，23, 1，234，56 and 1，234,567
 * are not one number. probe.work counts every probed character; one call visits the number's own
 * characters plus a fixed lookahead, so all calls together stay linear in the text length.
 */
function fullWidthGroupedNumberEnd(text: string, startPosition: number, probe: { work: number }): number {
  probe.work += 2;

  const first = text[startPosition];
  const before = text[startPosition - 1];

  // A leading zero or a continuing character directly before the first digit keeps the ordinary reading.
  if (!isArabicDigit(first) || first === '0'
    || before !== undefined && (isArabicDigit(before) || '.,，'.includes(before))) {
    return -1;
  }

  let position = startPosition;
  let digits = 0;

  while (digits < 3 && isArabicDigit(text[position])) {
    digits++;
    position++;
    probe.work++;
  }

  // A fourth digit directly after the first run already breaks the grouping.
  probe.work++;

  if (isArabicDigit(text[position])) {
    return -1;
  }

  let groups = 0;

  while (text[position] === '，') {
    probe.work += 4;

    // Each group is exactly three digits; a missing digit or a fourth one breaks the grouping.
    if (!isArabicDigit(text[position + 1]) || !isArabicDigit(text[position + 2])
      || !isArabicDigit(text[position + 3]) || isArabicDigit(text[position + 4])) {
      break;
    }

    groups++;
    position += 4;
  }

  // Charge the comma lookahead that ends the group loop.
  probe.work++;

  if (!groups) {
    return -1;
  }

  // A comma directly before a digit belongs to the number and invalidates the whole grouping;
  // 1，234，56 and 1，234,567 keep their ordinary reading.
  probe.work++;

  if ((text[position] === '，' || text[position] === ',') && isArabicDigit(text[position + 1])) {
    return -1;
  }

  return position;
}

interface NumericField {
  start: number;
  end: number;
  capital: boolean;
}

interface ReaderContext {
  text: string;
  fields: NumericField[];
  numericFieldEnds: Int32Array;
  nextNonWhitespace: Int32Array;
  previousNonWhitespaceEnd: Int32Array;
  units: readonly string[];
  unitInitials: ReadonlySet<string>;

  // Continuation reads for written-unit chains, keyed by start position; see the chained-read helper.
  chainedAmounts: Map<number, AmountCore | null>;
  work: number;
}

/**
 * Returns the ordinary result and deterministic character/probe work for one call; no state is retained.
 * work is a count, not milliseconds, and includes configured-unit probes; empty/failed results retain their count.
 * Diagnostic instrumentation shares the public implementations and their failure behavior.
 */
export interface WorkResult<Result> {
  result: Result;
  work: number;
}

/**
 * Normalization preserves UTF-16 width so every cached jump remains an original-input offset.
 * O(n): folding, numeric fields and inline-whitespace jumps each make a bounded pass.
 * The initial 4 * length work baseline is retained diagnostic accounting; its derivation is not recorded.
 */
function createReaderContext(input: string, options?: Options): ReaderContext {
  const folded = foldForMatch(input);

  // Folding and digit normalization keep UTF-16 width, so cached offsets still address the original input.
  const parts: string[] = [];

  for (let i = 0; i < folded.length; i++) {
    const character = folded[i]!;
    parts.push(
      character === '〇' || character === '○'
        ? '零'
        : character === '．' && isArabicDigit(folded[i - 1]) && isArabicDigit(folded[i + 1])
          ? '.'
          : character
    );
  }

  const text = parts.join('');
  const textLength = text.length;
  const fields: NumericField[] = [];
  const numericFieldEnds = new Int32Array(textLength + 1);
  const nextNonWhitespace = new Int32Array(textLength + 1);
  const previousNonWhitespaceEnd = new Int32Array(textLength + 1);

  // Existing diagnostic baseline; source not recorded for the multiplier 4.
  let work = textLength * 4;
  const groupingProbe = { work: 0 };

  for (let i = 0; i < textLength; i++) {
    previousNonWhitespaceEnd[i + 1] = isInlineWhitespace(text[i]) ? previousNonWhitespaceEnd[i]! : i + 1;

    if (!isNumberCharacter(text[i])) {
      continue;
    }

    const start = i;
    let capital = false;

    // A complete fullwidth-comma grouped number is one field, so its probe runs before the field loop.
    let groupedNumberEnd = fullWidthGroupedNumberEnd(text, start, groupingProbe);

    // Punctuation belongs to a numeric field only between Arabic digits or inside that grouped number;
    // other punctuation separates fields.
    while (i < textLength
      && (isNumberCharacter(text[i])
        || (text[i] === '.' || text[i] === ',') && isArabicDigit(text[i - 1])
        && isArabicDigit(text[i + 1])
        || i < groupedNumberEnd)) {
      // A released Arabic run can begin after a Chinese numeral inside the same field.
      // Each probe visits only its own Arabic run, so these interior starts add one bounded pass.
      if (i > start && isArabicDigit(text[i]) && !isArabicDigit(text[i - 1])) {
        groupedNumberEnd = Math.max(groupedNumberEnd, fullWidthGroupedNumberEnd(text, i, groupingProbe));
      }

      capital ||= CAPITAL_NUMERALS.includes(text[i]!);
      work++;
      i++;
    }

    fields.push({
      start,
      end: i,
      capital
    });

    for (let j = start; j < i; j++) {
      numericFieldEnds[j] = i;
      work++;
    }

    // The skipped positions still need their whitespace metadata.
    for (let j = start + 1; j < i; j++) {
      previousNonWhitespaceEnd[j + 1] = j + 1;
      work++;
    }

    i--;
  }

  // Charge every fullwidth-grouping probe once, after all field starts have been examined.
  work += groupingProbe.work;

  nextNonWhitespace[textLength] = textLength;

  for (let i = textLength - 1; i >= 0; i--) {
    nextNonWhitespace[i] = isInlineWhitespace(text[i]) ? nextNonWhitespace[i + 1]! : i;
  }

  let units: readonly string[] = [];

  // Options can contain throwing getters/proxies. Invalid options produce no configured units.
  try {
    const candidate = options?.units;

    if (Array.isArray(candidate)) {
      const copy: string[] = [];
      const length = candidate.length;

      // 0xffffffff is the JavaScript array-length boundary, pinned by invalid-length tests.
      if (Number.isSafeInteger(length) && length >= 0 && length <= 0xffffffff) {
        work += length;

        for (let index = 0; index < length; index++) {
          const word: unknown = candidate[index];

          if (typeof word === 'string' && word.length > 0 && !YUAN_WORDS.has(word)) {
            copy.push(word);
          }
        }
      }

      units = copy;
    }
  } catch {
    units = [];
  }

  return {
    text,
    fields,
    numericFieldEnds,
    nextNonWhitespace,
    previousNonWhitespaceEnd,
    units,
    unitInitials: new Set(units.map(word => word[0]!)),
    chainedAmounts: new Map(),
    work
  };
}

function matchesWordAt(readerContext: ReaderContext, startPosition: number, word: string): boolean {
  readerContext.work += word.length;

  return readerContext.text.startsWith(word, startPosition);
}

/**
 * Punctuation ends a tail immediately; particles end it only when followed by an end, numeral or nonletter.
 * The two-particle limit is a grammar decision covered by the closed-particle boundary tests.
 */
function isSentenceEnd(readerContext: ReaderContext, startPosition: number): boolean {
  const text = readerContext.text;
  readerContext.work++;

  if (startPosition >= text.length
    || !LETTER_CHARACTER.test(String.fromCodePoint(text.codePointAt(startPosition)!))
    && !isNumberCharacter(text[startPosition])) {
    return true;
  }

  // Particles are accepted only at a real boundary; a following word cannot silently resolve a candidate tail.
  let position = startPosition;

  // The closed-particle grammar permits at most two consecutive modal particles.
  while (position < startPosition + 2 && MODAL_PARTICLES.has(text[position]!)) {
    position++;
    readerContext.work++;
  }

  return position > startPosition
    && (position === text.length || NUMERIC_FIELD_CHARACTERS.has(text[position]!)
      || !LETTER_CHARACTER.test(String.fromCodePoint(text.codePointAt(position)!)));
}

/**
 * Prefix order is significant: the first match wins. The short near/fast forms require direct adjacency.
 */
function readPrefixModifier(readerContext: ReaderContext, startPosition: number): ApproximationModifier | null {
  const position = readerContext.previousNonWhitespaceEnd[startPosition] ?? startPosition;

  for (const [word, kind] of PREFIXES) {
    // These short prefixes must touch the number; parseAmount("快 十二块") remains an exact 1200 cents.
    if ((word === '快' || word === '近') && position !== startPosition) {
      continue;
    }

    if (position >= word.length && matchesWordAt(readerContext, position - word.length, word)) {
      return kind;
    }
  }

  return null;
}

/**
 * Two-character suffixes are checked before single characters; candidate tails disable the single forms.
 */
function readSuffixModifier(readerContext: ReaderContext, startPosition: number, allowSingleCharacter = true): {
  kind: ApproximationModifier;
  end: number;
} | null {
  for (const [word, kind] of SUFFIXES) {
    if (matchesWordAt(readerContext, startPosition, word)) {
      return {
        kind,
        end: startPosition + word.length
      };
    }
  }

  if (allowSingleCharacter && matchesWordAt(readerContext, startPosition, '起')
    && isSentenceEnd(readerContext, startPosition + 1)) {
    return {
      kind: 'lower',
      end: startPosition + 1
    };
  }

  // Exclude 少 and 谢 after 多 so ordinary words do not become a more-than range.
  // For example, parseAmount("十二块多少") keeps only 1200 cents.
  if (allowSingleCharacter && matchesWordAt(readerContext, startPosition, '多')
    && !'少谢'.includes(readerContext.text[startPosition + 1] ?? '\0')) {
    return {
      kind: 'more',
      end: startPosition + 1
    };
  }

  return null;
}

const expandContractedTens = (spelling: string) => spelling.replaceAll('廿', '二十').replaceAll('卅', '三十');

interface ParsedNumber {
  end: number;
  raw: string;
  value: bigint | null;

  // Lower bound in hundredths: cents for amounts, item count multiplied by 100 for quantities.
  minimumHundredths: bigint | null;

  // Upper bound in hundredths: cents for amounts, item count multiplied by 100 for quantities.
  maximumHundredths: bigint | null;
  range: boolean;
  capital: boolean;
  decimal: boolean;
  omitted: boolean;
  upwardMagnitude: boolean;
}

/**
 * Strict descending units, including section units. O(s.length), with bounded Chinese syntax.
 * Largest sections are tried before local descending place values.
 * Missing zeros retain the existing omission rules.
 * The 40 UTF-16-unit syntax bound has no recorded derivation; it is preserved independently of fragment length.
 * A section coefficient must be below 10000 (four decimal places), matching the finite-number grammar boundaries.
 * Every recursive spelling is shorter than its parent, whose syntax bound is 40 UTF-16 units.
 * Thus at most 40 frames can be active, independently of input length; character work within that bound is O(1).
 */
function readChineseInteger(
  spelling: string,
  allowOmission = true,
  outerPlaceValue = 1n,
  allowInitialTen = true,
  allowStandaloneTwo = true
): {
  value: bigint;
  omitted: boolean;
} | null {
  // Preserve the syntax bound of 40 UTF-16 units; source not recorded.
  if (!spelling || spelling.length > 40) {
    return null;
  }

  spelling = expandContractedTens(spelling);

  if (spelling === '零') {
    return {
      value: 0n,
      omitted: false
    };
  }

  // A zero must mark an internal gap, not an empty leading/trailing place or repeated gap.
  if (spelling.startsWith('零') || spelling.endsWith('零') || spelling.includes('零零')) {
    return null;
  }

  // Resolve the largest section first so its coefficient and remainder cannot cross section boundaries.
  for (const [word, unit] of BIG_SECTIONS) {
    const sectionIndex = spelling.indexOf(word);

    if (sectionIndex < 0) {
      continue;
    }

    if (spelling.indexOf(word, sectionIndex + 1) >= 0 || sectionIndex === 0) {
      return null;
    }

    const sectionCoefficient = readChineseInteger(
      spelling.slice(0, sectionIndex),
      allowOmission,
      1n,
      allowInitialTen
    );

    // A section coefficient cannot contain an inferred trailing place; otherwise multiplication compounds that guess.
    if (!sectionCoefficient || sectionCoefficient.omitted || sectionCoefficient.value <= 0n
      || sectionCoefficient.value >= 10000n) {
      return null;
    }

    let rest = spelling.slice(sectionIndex + 1);
    let zero = false;

    if (rest.startsWith('零')) {
      zero = true;
      rest = rest.slice(1);
    }

    if (!rest) {
      return zero ? null : {
        value: sectionCoefficient.value * unit,
        omitted: sectionCoefficient.omitted
      };
    }

    // A written zero suppresses the omitted next place: "三万五元" is 3500000 cents,
    // whereas "三万零五元" is 3000500 cents through parseAmount.
    const sectionRemainder = readChineseInteger(rest, allowOmission, zero ? 1n : unit, false, false);

    if (!sectionRemainder || sectionRemainder.value >= unit) {
      return null;
    }

    return {
      value: sectionCoefficient.value * unit + sectionRemainder.value,
      omitted: sectionCoefficient.omitted || sectionRemainder.omitted
    };
  }

  let total = 0n;
  let lastPlaceValue = outerPlaceValue;
  let pending: bigint | null = null;
  let zero = false;
  let omitted = false;

  for (let i = 0; i < spelling.length; i++) {
    const character = spelling[i]!;

    if (character === '零') {
      if (pending !== null || total === 0n || zero) {
        return null;
      }

      zero = true;

      continue;
    }

    const digitValue = character === '两' ? 2n : readSmallDigit(character);

    if (digitValue !== null) {
      // Only 百/千/万/亿 may follow a non-standalone 两; parseAmount("两十元") is null.
      // Adjacent plain digits are not a positional Chinese integer.
      if (isArabicDigit(character) || pending !== null
        || character === '两'
        && (spelling.length === 1 ? !allowStandaloneTwo : !'百千万亿'.includes(spelling[i + 1] ?? '\0'))) {
        return null;
      }

      pending = digitValue;

      if (i === spelling.length - 1) {
        // Without a zero, a final digit fills the next unwritten place: "三百五元" is 35000 cents.
        // A zero makes "三百零五元" 30500 cents; strict quantity/capital reads disable omission.
        const scale = !zero && lastPlaceValue >= 100n ? lastPlaceValue / 10n : 1n;

        if (scale > 1n && !allowOmission) {
          return null;
        }

        total += digitValue * scale;
        omitted = scale > 1n;
        pending = null;
        zero = false;
      }

      continue;
    }

    const unit = PLACE_VALUES[character];

    if (!unit || unit >= 10000n) {
      return null;
    }

    // Only an initial 十 can supply an unwritten coefficient of one; later units need their own digit.
    if (pending === null) {
      if (i !== 0 || character !== '十' || !allowInitialTen) {
        return null;
      }

      pending = 1n;
    }

    // Place values must descend, including after a zero, to avoid counting one place twice.
    if (unit >= lastPlaceValue && total > 0n || zero && unit >= lastPlaceValue) {
      return null;
    }

    total += pending * unit;
    pending = null;
    lastPlaceValue = unit;
    zero = false;
  }

  if (zero || pending !== null) {
    return null;
  }

  return {
    value: total,
    omitted
  };
}

/**
 * Strict three-digit grouping and one/two fractional digits come from the frozen decimal/grouping grammar cases.
 * A fullwidth grouping comma reads like its ASCII twin; the two separator styles are never mixed.
 * 100 hundredths per unit and padding to two digits preserve exact cents; text processing is O(spelling.length).
 */
function readArabicCents(spelling: string): bigint | null {
  if (!ARABIC_NUMBER_PATTERN.test(spelling) && !FULL_WIDTH_GROUPED_PATTERN.test(spelling)) {
    return null;
  }

  const [whole, fraction = ''] = spelling.replaceAll(',', '').replaceAll('，', '').split('.');

  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
}

/**
 * Reads the fraction of a Chinese decimal standing directly before one 万/亿 and returns the whole
 * decimal in integer hundredths, that is the decimal value times the section. fraction is the
 * folded characters after 点, and integerYuan is the whole-yuan part before 点, below 10000.
 * Returns null when fraction is not one or two digits from 零一二三四五六七八九 followed by exactly
 * one 万 or 亿, so callers keep their ordinary fraction checks.
 */
function readSectionedDecimalFraction(fraction: string, integerYuan: bigint): bigint | null {
  if (!/^[零一二三四五六七八九]{1,2}[万亿]$/.test(fraction)) {
    return null;
  }

  const digits = [...fraction.slice(0, -1)]
    .map(character => character === '零' ? '0' : String(SMALL_DIGITS.indexOf(character) + 1))
    .join('')
    .padEnd(2, '0');
  const sectionCharacter = fraction[fraction.length - 1]!;

  return (integerYuan * 100n + BigInt(digits)) * PLACE_VALUES[sectionCharacter]!;
}

/**
 * True when raw is a Chinese decimal whose fraction after 点 is one or two digits from
 * 零一二三四五六七八九 directly before exactly one 万 or 亿. raw is one folded numeric field; the
 * check is bounded by its length, and any other spelling returns false.
 */
function isSectionedDecimalRaw(raw: string): boolean {
  const point = raw.indexOf('点');

  return point > 0 && /^[零一二三四五六七八九]{1,2}[万亿]$/.test(raw.slice(point + 1));
}

/**
 * Arabic coefficients and omitted places are amount spellings; quantity parsing deliberately excludes that branch.
 * Decimal fractions use one or two digits, and 100 hundredths per unit; both are fixed grammar decisions.
 * Character passes remain O(spelling.length); the existing capital-fold arrays are retained, not consolidated.
 */
function readExactNumber(spelling: string, isQuantity = false): {
  value: bigint;
  capital: boolean;
  decimal: boolean;
  omitted: boolean;
} | null {
  if (!spelling) {
    return null;
  }

  if (isArabicDigit(spelling[0])) {
    // 点 stands for the decimal dot between Arabic digits; one or two digits directly after it are
    // the fraction. Amount callers require a following currency for this spelling, and quantities
    // reject it, so the substituted dot never widens the closed reading by itself.
    const decimalPoint = spelling.indexOf('点');

    if (decimalPoint >= 0) {
      let fractionDigits = 0;

      while (isArabicDigit(spelling[decimalPoint + 1 + fractionDigits])) {
        fractionDigits++;
      }

      if (isQuantity || !/^(?:0|[1-9][0-9]*)$/.test(spelling.slice(0, decimalPoint))
        || fractionDigits < 1 || fractionDigits > 2) {
        return null;
      }

      spelling = spelling.slice(0, decimalPoint) + '.' + spelling.slice(decimalPoint + 1);
    }

    let position = 0;

    // Either grouping comma is scanned so readArabicCents can validate the complete spelling.
    while (position < spelling.length
      && (isArabicDigit(spelling[position]) || spelling[position] === '.'
        || spelling[position] === ',' || spelling[position] === '，')) {
      position++;
    }

    // Validate the entire Arabic prefix before multiplying by a place value; malformed grouping cannot be salvaged.
    const arabicValue = readArabicCents(spelling.slice(0, position));

    if (arabicValue === null) {
      return null;
    }

    const decimal = spelling.slice(0, position).includes('.');

    if (position === spelling.length) {
      return {
        value: arabicValue,
        capital: false,
        decimal,
        omitted: false
      };
    }

    if (isQuantity) {
      return null;
    }

    // Arabic coefficients followed by place values are amount syntax only: "3万5千2百元" is 3520000 cents,
    // but parseQuantity("3万个") is null.
    let lastPlaceValue = PLACE_VALUES[spelling[position]!];

    if (!lastPlaceValue || lastPlaceValue === 10n) {
      return null;
    }

    let total = arabicValue * lastPlaceValue;
    let omitted = false;
    position++;

    while (position < spelling.length) {
      if (!isArabicDigit(spelling[position])) {
        return null;
      }

      const digitValue = BigInt(spelling[position++]!);

      // The final coefficient inherits the next lower place; it is marked omitted so strict readers can reject it.
      if (position === spelling.length) {
        total += digitValue * lastPlaceValue / 10n * 100n;
        omitted = true;

        break;
      }

      const next = PLACE_VALUES[spelling[position++]!];

      if (!next || next >= lastPlaceValue) {
        return null;
      }

      total += digitValue * next * 100n;
      lastPlaceValue = next;
    }

    // The fraction flag follows the multiplied value, so a caller can still see that the spelling
    // carried a decimal point.
    return {
      value: total,
      capital: false,
      decimal,
      omitted
    };
  }

  const capital = [...spelling].some(character => CAPITAL_NUMERALS.includes(character));

  // Capital spelling permits only capital numerals plus 零/万/亿; "叁十五元" is not a mixed-style escape.
  // parseAmount returns null for that input.
  if (capital
    && [...spelling].some(
      character => !(CAPITAL_NUMERALS.includes(character) || '零万亿'.includes(character))
    )) {
    return null;
  }

  const plain = capital ? [...spelling].map(character => CAPITAL_FOLD[character] ?? character).join('') : spelling;
  const point = plain.indexOf('点');

  // A written decimal is separate from omitted-place arithmetic; "三点五元" is 350 cents.
  // Capital decimals such as "贰点伍元" remain unreadable through parseAmount.
  if (point >= 0) {
    if (capital) {
      return null;
    }

    const integerPart = readChineseInteger(plain.slice(0, point));
    const fraction = plain.slice(point + 1);

    // A Chinese decimal standing directly before exactly one 万/亿 multiplies by that section: the
    // whole part stays below 10000 yuan, and the fraction is one or two digits plus the section word.
    if (!isQuantity && integerPart && integerPart.value < 10000n) {
      const sectionedValue = readSectionedDecimalFraction(fraction, integerPart.value);

      if (sectionedValue !== null) {
        return {
          value: sectionedValue,
          capital: false,
          decimal: true,
          omitted: integerPart.omitted
        };
      }
    }

    if (!integerPart || fraction.length < 1 || fraction.length > 2
      || [...fraction].some(character => !SMALL_DIGITS.includes(character) && character !== '零')) {
      return null;
    }

    const fractionDigits = [...fraction]
      .map(character => character === '零' ? '0' : String(SMALL_DIGITS.indexOf(character) + 1))
      .join('')
      .padEnd(2, '0');

    return {
      value: integerPart.value * 100n + BigInt(fractionDigits),
      capital: false,
      decimal: true,
      omitted: integerPart.omitted
    };
  }

  // Colloquial 百/千/万 shorthand omits the leading coefficient 一; a trailing 一 is excluded.
  // The remaining ordinary digits are two through nine; parseAmount("百二元") returns 12000 cents.
  if (!capital && !isQuantity && spelling.length === 2 && '百千万'.includes(spelling[0]!)
    && SMALL_DIGITS.slice(1).includes(spelling[1]!)) {
    return {
      value: PLACE_VALUES[spelling[0]!]! * (10n + readSmallDigit(spelling[1])!) * 10n,
      capital: false,
      decimal: false,
      omitted: true
    };
  }

  const result = readChineseInteger(plain, !capital && !isQuantity);

  return result ? {
    value: result.value * 100n,
    capital,
    decimal: false,
    omitted: result.omitted
  } : null;
}

/**
 * Reads one spelling with 亿 and/or 万 whose coefficients may use different scripts.
 * spelling is one numeric field of folded text; the result is integer cents, or null when the
 * spelling is not a closed sectioned form, so callers keep the ordinary grammar results.
 * The first coefficient keeps the ordinary Arabic limits; later coefficients count 1 to 9999,
 * and the rest stays below the place of the section word before it. O(spelling.length).
 */
function readSectionedNumber(spelling: string): bigint | null {
  const yiIndex = spelling.indexOf('亿');
  const wanIndex = spelling.indexOf('万');

  if (yiIndex < 0 && wanIndex < 0) {
    return null;
  }

  // 亿 occurs at most once, 万 occurs at most once, and 亿 stands before 万.
  if (yiIndex >= 0 && spelling.indexOf('亿', yiIndex + 1) >= 0) {
    return null;
  }

  if (wanIndex >= 0 && spelling.indexOf('万', wanIndex + 1) >= 0) {
    return null;
  }

  if (yiIndex >= 0 && wanIndex >= 0 && yiIndex > wanIndex) {
    return null;
  }

  const yiCoefficientSpelling = yiIndex >= 0 ? spelling.slice(0, yiIndex) : '';
  const wanCoefficientSpelling = wanIndex < 0
    ? ''
    : spelling.slice(yiIndex >= 0 ? yiIndex + 1 : 0, wanIndex);
  const restSpelling = spelling.slice((wanIndex >= 0 ? wanIndex : yiIndex) + 1);
  const firstCoefficientSpelling = yiIndex >= 0 ? yiCoefficientSpelling : wanCoefficientSpelling;

  // A decimal point or a grouping comma in the first coefficient keeps the ordinary Arabic result;
  // the sectioned forms read whole coefficients only, and either comma style counts as grouping.
  if (firstCoefficientSpelling.includes('.') || firstCoefficientSpelling.includes(',')
    || firstCoefficientSpelling.includes('，')) {
    return null;
  }

  let total = 0n;

  if (yiIndex >= 0) {
    const yiCoefficient = readSectionCoefficient(yiCoefficientSpelling, true, true);

    if (yiCoefficient === null) {
      return null;
    }

    total += yiCoefficient * 100000000n;
  }

  if (wanIndex >= 0) {
    // A 万 coefficient that follows 亿 keeps the narrower acceptance of that place: an opening
    // 十 cannot supply one there, and only a first coefficient may be an unlimited Arabic number.
    const wanIsFirst = yiIndex < 0;
    const wanCoefficient = readSectionCoefficient(wanCoefficientSpelling, wanIsFirst, wanIsFirst);

    if (wanCoefficient === null) {
      return null;
    }

    total += wanCoefficient * 10000n;
  }

  const restCents = readSectionRest(restSpelling, wanIndex >= 0 ? 10000n : 100000000n, wanIndex >= 0);

  if (restCents === null) {
    return null;
  }

  return total + restCents;
}

/**
 * Reads one coefficient before 亿 or before 万 and returns it in integer cents, or null.
 * A Chinese coefficient counts 1 to 9999 whole units; the closed shorthand is one Arabic digit
 * from 1 to 9 directly before 千 or 百 (5千 is 5000, 5百 is 500); a plain Arabic integer counts
 * 1 to 9999. allowArabicAny adds the unlimited first-coefficient Arabic form with its ordinary
 * limits. allowInitialTen marks a first coefficient, where an opening 十 may supply one.
 */
function readSectionCoefficient(
  spelling: string,
  allowInitialTen: boolean,
  allowArabicAny: boolean
): bigint | null {
  const chinese = readChineseInteger(spelling, true, 1n, allowInitialTen);

  if (chinese && !chinese.omitted && chinese.value > 0n && chinese.value < 10000n) {
    return chinese.value * 100n;
  }

  if (/^[1-9]千$/.test(spelling)) {
    return BigInt(spelling[0]!) * 100000n;
  }

  if (/^[1-9]百$/.test(spelling)) {
    return BigInt(spelling[0]!) * 10000n;
  }

  if (/^[1-9][0-9]{0,3}$/.test(spelling)) {
    return BigInt(spelling) * 100n;
  }

  if (allowArabicAny) {
    return readArabicCents(spelling);
  }

  return null;
}

/**
 * Reads the part after the last 万 or 亿: empty, a Chinese rest, an Arabic rest, or one of the
 * two literal Arabic rests that stand only directly after 万. The result is integer cents, or
 * null when the part is not one of the closed rest forms.
 * unitInYuan is the place of the section word before the rest (10000 or 100000000); the rest
 * must stay below it. afterWan admits the literal three/four-digit and 零-prefixed forms.
 */
function readSectionRest(spelling: string, unitInYuan: bigint, afterWan: boolean): bigint | null {
  if (!spelling) {
    return 0n;
  }

  const chineseRest = readChineseSectionRest(spelling, unitInYuan);

  if (chineseRest !== null) {
    return chineseRest;
  }

  const arabicRest = readArabicSectionRest(spelling, unitInYuan);

  if (arabicRest !== null) {
    return arabicRest;
  }

  // Directly after 万, three or four Arabic digits stand for themselves: 1万500 is 10500.
  if (afterWan && /^[1-9][0-9]{2,3}$/.test(spelling)) {
    return BigInt(spelling) * 100n;
  }

  // Also directly after 万, 零 plus one to three Arabic digits stands for itself: 1万零50 is 10050.
  if (afterWan && /^零[1-9][0-9]{0,2}$/.test(spelling)) {
    return BigInt(spelling.slice(1)) * 100n;
  }

  return null;
}

/**
 * Reads a Chinese rest after a section word and returns integer cents, or null.
 * A leading 零 marks an internal gap, so the remainder cannot omit its final place; the rest
 * must still stay below one whole section unit, as in the ordinary section grammar.
 */
function readChineseSectionRest(spelling: string, unitInYuan: bigint): bigint | null {
  let rest = spelling;
  let zero = false;

  if (rest.startsWith('零')) {
    zero = true;
    rest = rest.slice(1);
  }

  if (!rest) {
    return null;
  }

  const remainder = readChineseInteger(rest, true, zero ? 1n : unitInYuan, false, false);

  if (!remainder || remainder.value >= unitInYuan) {
    return null;
  }

  return remainder.value * 100n;
}

/**
 * Reads an Arabic rest below a section place and returns integer cents, or null.
 * Places must strictly descend; the final digit may stand without one and fills the next lower
 * place, so a 万 rest of 5千2百 counts 5200 whole units and a bare 5 counts 5000.
 */
function readArabicSectionRest(spelling: string, unitInYuan: bigint): bigint | null {
  let position = 0;
  let lastPlaceValue = unitInYuan;
  let total = 0n;

  while (position < spelling.length) {
    if (!isArabicDigit(spelling[position])) {
      return null;
    }

    const digitValue = BigInt(spelling[position++]!);

    if (position === spelling.length) {
      total += digitValue * lastPlaceValue / 10n * 100n;

      return total;
    }

    const next = PLACE_VALUES[spelling[position++]!];

    if (!next || next >= lastPlaceValue) {
      return null;
    }

    total += digitValue * next * 100n;
    lastPlaceValue = next;
  }

  return total;
}

/**
 * Starts at one whole unit (100 hundredths) and advances by decimal places (factor 10).
 * This identifies the uncertainty quantum used by more/head ranges; work is O(decimal places in value).
 */
function lowestPlaceValueCents(value: bigint): bigint {
  let placeValue = 100n;
  value /= 100n;

  while (value > 0n && value % 10n === 0n) {
    placeValue *= 10n;
    value /= 10n;
  }

  return placeValue;
}

/**
 * Reads a number, one 多/余/来 particle and exactly one 万/亿 as a single approximate number.
 * base.end stands on the section word right after the consumed particle; spelling is base.raw, the
 * folded number before the particle, which stays below 10000 whole units and holds neither 万 nor 亿.
 * Values are hundredths: cents for amounts, item count times 100 for quantities; quantum is one cent
 * or one whole item. Returns the sectioned range with the section word consumed, or null when the
 * number spelling, its bounds or the character after the section word cannot support that reading.
 */
function readSectionedParticleRange(
  readerContext: ReaderContext,
  base: ParsedNumber,
  modifier: string,
  isQuantity: boolean
): ParsedNumber | null {
  const text = readerContext.text;
  const spelling = base.raw;
  const sectionWord = text[base.end];
  const afterSection = text[base.end + 1];

  if (sectionWord !== '万' && sectionWord !== '亿'
    || spelling.includes('万') || spelling.includes('亿')
    || afterSection !== undefined
    && (isNumberCharacter(afterSection) || '多余来'.includes(afterSection))) {
    return null;
  }

  readerContext.work += spelling.length;

  let exactNumber = readExactNumber(spelling, false);

  // The closed shorthand 百/千 stands for itself after a particle, as in the ordinary suffix path.
  if (!exactNumber && MISSING_COEFFICIENT.has(spelling)) {
    exactNumber = {
      value: PLACE_VALUES[spelling]! * 100n,
      capital: false,
      decimal: false,
      omitted: false
    };
  }

  const arabic = isArabicDigit(spelling[0]);
  const arabicPlaced = arabic && [...spelling].some(character => PLACE_VALUES[character]);
  const quantum = isQuantity ? 100n : 1n;

  if (!exactNumber || exactNumber.value <= 0n || exactNumber.value % 100n !== 0n
    || exactNumber.capital || exactNumber.value >= 1000000n
    || (isQuantity ? exactNumber.decimal || arabicPlaced : exactNumber.decimal && !arabicPlaced)
    || !arabic && !readChineseInteger(spelling) && !MISSING_COEFFICIENT.has(spelling)) {
    return null;
  }

  const lower = exactNumber.value;
  const upper = modifier === '多' || modifier === '余'
    ? lower + lowestPlaceValueCents(lower) - quantum
    : lower;
  const section = PLACE_VALUES[sectionWord]!;

  return {
    ...base,
    end: base.end + 1,
    range: true,
    decimal: exactNumber.decimal,
    minimumHundredths: lower * section,
    maximumHundredths: modifier === '来'
      ? lower * section
      : (upper + quantum) * section - quantum
  };
}

/**
 * Number fields are visited a fixed number of times. Range substitution adds at most two parses.
 * Range substitutions preserve the original field span; multiple independent range markers erase both bounds.
 * The 40-unit non-Arabic field bound has no recorded derivation. Arabic fields remain unbounded.
 * The eight-step difference divisor follows the replacement digits one and nine; 100/1 selects item/cent quantum.
 * O(field length) character work: a fixed number of parses and at most two range substitutions.
 */
function readNumberAt(
  readerContext: ReaderContext,
  startPosition: number,
  isQuantity = false,
  forcedEnd?: number,
  consumePostNumberModifier = true
): ParsedNumber | null {
  const text = readerContext.text;
  let end = forcedEnd ?? readerContext.numericFieldEnds[startPosition] ?? 0;

  if (end <= startPosition) {
    return null;
  }

  // Chinese decimals cross 点, which is not a lexical numeric-field character.
  if (forcedEnd === undefined && text[end] === '点'
    && readerContext.numericFieldEnds[end + 1]! > end + 1) {
    end = readerContext.numericFieldEnds[end + 1]!;
  }

  const raw = text.slice(startPosition, end);
  readerContext.work += raw.length;

  // Every valid non-Arabic spelling fits this bound (including range substitutions).
  // This field bound is separate from the public 40-code-point fragment limit; source not recorded.
  if (!isArabicDigit(raw[0]) && raw.length > 40) {
    return null;
  }

  const base: ParsedNumber = {
    end,
    raw,
    value: null,
    minimumHundredths: null,
    maximumHundredths: null,
    range: false,
    capital: false,
    decimal: false,
    omitted: false,
    upwardMagnitude: false
  };
  let variants = 0;
  let lowerSpelling = raw;
  let upperSpelling = raw;
  let extra = 0n;

  // An upward magnitude has only a lower bound; additional independent uncertainty must not guess an upper bound.
  if (text[startPosition - 1] === '上' && UPWARD_MAGNITUDES.has(raw)) {
    let value = 100n;

    for (const character of raw) {
      value *= PLACE_VALUES[character]!;
    }

    base.range = true;
    base.minimumHundredths = value;
    base.upwardMagnitude = true;
    variants++;
  }

  const few = raw.indexOf('几');

  // Replace one 几 with lower/upper digit spellings, then widen only its own place.
  // parseAmount("一百几块") spans 11000..19999 cents; parseQuantity("一百几个") spans 110..199 items.
  if (few >= 0) {
    if (raw.indexOf('几', few + 1) >= 0) {
      return null;
    }

    variants++;

    if (raw === '几') {
      base.range = true;
    } else {
      lowerSpelling = raw.replace('几', few === 0 ? '二' : '一');
      upperSpelling = raw.replace('几', '九');

      if (few > 0) {
        let placeValue = 100n;

        for (let i = few + 1; i < raw.length && PLACE_VALUES[raw[i]!]; i++) {
          placeValue *= PLACE_VALUES[raw[i]!]!;
        }

        extra = placeValue - (isQuantity ? 100n : 1n);
      }
    }
  }

  // 数 before a written magnitude substitutes coefficients two through nine, without adding a finer upper tail.
  // For example, parseQuantity("数百个") spans 200..900 items.
  if (text[startPosition - 1] === '数' && PLACE_VALUES[raw[0]!]) {
    variants++;
    lowerSpelling = '二' + raw;
    upperSpelling = '九' + raw;
  }

  let pairAt = -1;

  // An adjacent digit pair must stand alone inside the spelling; overlapping pairs would invent multiple bounds.
  for (let i = 0; i + 1 < raw.length; i++) {
    readerContext.work++;

    if (ADJACENT_DIGIT_PAIRS.has(raw.slice(i, i + 2))) {
      if (pairAt >= 0 || readSmallDigit(raw[i - 1]) !== null
        || readSmallDigit(raw[i + 2]) !== null
        || raw[i - 1] === '两'
        || raw[i + 2] === '两') {
        return null;
      }

      pairAt = i;
    }
  }

  if (pairAt >= 0) {
    variants++;
    lowerSpelling = raw.slice(0, pairAt) + raw[pairAt] + raw.slice(pairAt + 2);
    upperSpelling = raw.slice(0, pairAt) + raw[pairAt + 1] + raw.slice(pairAt + 2);
  }

  let suffixModifier: string | null = null;

  // 少/谢 keep 多 inside an ordinary word, while 来/余/把 have their separate closed numeric rules.
  // parseAmount("二十多谢") is exact 2000 cents; "百把块" is a 10000..10000-cent range.
  if (consumePostNumberModifier
    && (text[end] === '多' && !'少谢'.includes(text[end + 1] ?? '\0') || text[end] === '余'
      || text[end] === '来'
      || text[end] === '把' && MISSING_COEFFICIENT.has(raw))) {
    suffixModifier = text[end]!;
  }

  if (suffixModifier) {
    variants++;
    base.end++;
  }

  // After one 多/余/来 particle, exactly one 万/亿 makes the particle part of a single sectioned
  // approximate number; the same particle read without its section word must never be returned.
  if ((suffixModifier === '多' || suffixModifier === '余' || suffixModifier === '来')
    && (text[base.end] === '万' || text[base.end] === '亿')) {
    return variants > 1 ? null : readSectionedParticleRange(readerContext, base, suffixModifier, isQuantity);
  }

  // Do not combine independent uncertainty into precise endpoints; "上千多块" has two null bounds.
  if (variants > 1) {
    base.range = true;
    base.minimumHundredths = null;
    base.maximumHundredths = null;

    return base;
  }

  if (base.range) {
    return base;
  }

  if (variants === 1 && !suffixModifier) {
    // Quantity substitutions retain the ordinary omission rules, but cannot acquire amount-only decimals.
    if (isQuantity && (isSectionedDecimalRaw(lowerSpelling) || isSectionedDecimalRaw(upperSpelling))) {
      return null;
    }

    const lowerNumber = readExactNumber(lowerSpelling);
    const upperNumber = readExactNumber(upperSpelling);

    if (!lowerNumber || !upperNumber) {
      return null;
    }

    // Replacement difference also includes any omitted place, so the uncertainty width follows the parsed value.
    if (few > 0) {
      extra = (upperNumber.value - lowerNumber.value) / 8n - (isQuantity ? 100n : 1n);
    }

    return {
      ...base,
      range: true,
      minimumHundredths: lowerNumber.value,
      maximumHundredths: upperNumber.value + extra
    };
  }

  // Post-number modifiers use amount-style omission before quantity endpoints are quantized to whole items.
  let exactNumber = readExactNumber(raw, suffixModifier ? false : isQuantity);

  if (!exactNumber && suffixModifier && MISSING_COEFFICIENT.has(raw)) {
    exactNumber = {
      value: PLACE_VALUES[raw]! * 100n,
      capital: false,
      decimal: false,
      omitted: false
    };
  }

  // A number with 亿 and/or 万 may carry its coefficients in different scripts; this fallback
  // runs only where the ordinary grammars above found nothing, so their results stay primary.
  if (!exactNumber && !isQuantity && !suffixModifier) {
    readerContext.work += raw.length;
    const sectionedValue = readSectionedNumber(raw);

    if (sectionedValue !== null) {
      exactNumber = {
        value: sectionedValue,
        capital: false,
        decimal: false,
        omitted: false
      };
    }
  }

  if (!exactNumber) {
    return null;
  }

  // Approximation suffixes require a positive whole, ordinary-style value. In amounts an Arabic
  // spelling before a place value keeps the reading of the same Chinese value; quantity reads keep
  // rejecting those Arabic places, and a fraction without a place cannot carry the particle.
  if (suffixModifier) {
    const arabic = isArabicDigit(raw[0]);
    const arabicPlaced = arabic && [...raw].some(character => PLACE_VALUES[character]);
    const unsupportedValue = isQuantity ? exactNumber.decimal || arabicPlaced
      : exactNumber.decimal && !arabicPlaced;

    if (exactNumber.value <= 0n || exactNumber.value % 100n !== 0n || exactNumber.capital
      || unsupportedValue
      || !arabic && !readChineseInteger(raw) && !MISSING_COEFFICIENT.has(raw)) {
      return null;
    }

    return {
      ...base,
      range: true,
      decimal: exactNumber.decimal,
      minimumHundredths: exactNumber.value,
      maximumHundredths: suffixModifier === '多' || suffixModifier === '余'
        ? exactNumber.value + lowestPlaceValueCents(exactNumber.value) - (isQuantity ? 100n : 1n)
        : exactNumber.value
    };
  }

  return {
    ...base,
    ...exactNumber
  };
}

/**
 * Longer words are probed before they can replace a match; equal-length matches keep the existing first winner.
 * Work is bounded by the configured word list and is charged only for the probes actually executed.
 */
function readNamedUnitAt(readerContext: ReaderContext, startPosition: number): string | null {
  let best: string | null = null;

  for (const word of readerContext.units) {
    if ((!best || word.length > best.length) && matchesWordAt(readerContext, startPosition, word)) {
      best = word;
    }
  }

  return best;
}

function isCurrencyAt(readerContext: ReaderContext, startPosition: number): boolean {
  readerContext.work++;

  // All three yuan spellings and their written subunits count as currency boundaries.
  // For example, parseAmount("两分钱") reads 2 cents rather than a bare count.
  return '元圆块角毛分'.includes(readerContext.text[startPosition] ?? '\0')
    || readNamedUnitAt(readerContext, startPosition) !== null;
}

/**
 * Currency recognition comes first because a currency cannot also terminate a monetary tail as ordinary punctuation.
 */
function classifyNumberEnd(readerContext: ReaderContext, startPosition: number): 'end' | 'unit' | 'word' {
  if (isCurrencyAt(readerContext, startPosition)) {
    return 'unit';
  }

  return isSentenceEnd(readerContext, startPosition)
    || SUFFIXES.some(([word]) => matchesWordAt(readerContext, startPosition, word))
    ? 'end'
    : 'word';
}

interface AmountCore {
  expression: AmountExpression;
  number: ParsedNumber;
  checkedEnd: number;
  candidate: boolean;
  major: boolean;

  // Set while a deferred read of a chain member leaves its continuation to the chain walk; every
  // read that decides the continuation on the spot, and every complete amount, leaves it unset.
  chainPending?: boolean;
}

/**
 * Deduplicate by cents while keeping the first reference/end and the original alternative order.
 * The enclosing end is the furthest retained alternative, not the last alternative. Work is O(readings.length).
 */
function buildAmountReadings(start: number, unit: AmountUnit, list: Reading[]): AmountExpression {
  const seen = new Set<bigint>();
  const unique = list.filter(reading => {
    if (seen.has(reading.cents)) {
      return false;
    }

    seen.add(reading.cents);

    return true;
  });

  return {
    start,
    end: Math.max(...unique.map(reading => reading.end)),
    unit,
    bare: unit === null,
    kind: 'readings',
    readings: unique,
    approx: false
  };
}

function buildNumericAmount(
  parsedNumber: ParsedNumber,
  startPosition: number,
  end: number,
  unit: AmountUnit
): AmountExpression {
  return parsedNumber.range ? {
    start: startPosition,
    end,
    unit,
    bare: unit === null,
    kind: 'range',
    min: parsedNumber.minimumHundredths,
    max: parsedNumber.maximumHundredths,
    approx: true
  } : buildAmountReadings(startPosition, unit, [{
    cents: parsedNumber.value!,
    end
  }]);
}

/**
 * Reads the closed colloquial fen tail of an amount, such as 二五 in 一块二五.
 * body is the folded numeric field directly after a yuan word; the result is the first digit times ten
 * plus five cents, that is d1 jiao and five fen, or null when body is not exactly two ordinary digits
 * whose second digit is 五. 两, 零, capital digits, Arabic digits and every other second digit are not
 * this spelling; the caller checks that the tail stands directly before a sentence end.
 */
function readColloquialFenTail(body: string): bigint | null {
  if (body.length !== 2 || body[1] !== '五' || !SMALL_DIGITS.includes(body[0]!)) {
    return null;
  }

  return readSmallDigit(body[0])! * 10n + 5n;
}

/**
 * Yuan tails have at most two currency levels; all alternatives keep their own endpoints.
 * Written currency levels resolve before implicit tails; ordinary-word endings retain competing readings.
 * The grammar fixes yuan/jiao/fen levels at 100/10/1 hundredths and half a next level at five tenths.
 * Two ordinary digits ending in 五 are read as jiao and five fen only directly before a sentence end.
 * Every recursive call lowers the level along 100 -> 10 -> 1, so at most three frames are active.
 * O(tail field length) work, with no extra full-text pass.
 */
function readCurrencyTail(
  readerContext: ReaderContext,
  value: bigint,
  end: number,
  level: 10n | 1n | 100n,
  capital = false
): {
  list: Reading[];
  candidate: boolean;
} | null {
  const text = readerContext.text;
  const main = {
    cents: value,
    end
  };

  // 钱 finishes the written currency without appending the next numeric field.
  // A currency, suffix modifier or sentence end after that field rejects the fragment; a word leaves it unused.
  // parseAmount("十二块钱五左右") is null; "十二块钱五本" keeps 1200 cents.
  if (text[end] === '钱') {
    const paid = {
      cents: value,
      end: end + 1
    };
    const numericEnd = readerContext.numericFieldEnds[end + 1]!;

    if (numericEnd > end + 1 && classifyNumberEnd(readerContext, numericEnd) !== 'word') {
      return null;
    }

    return {
      list: [paid],
      candidate: false
    };
  }

  const numericEnd = readerContext.numericFieldEnds[end]!;

  if (numericEnd <= end) {
    return {
      list: [main],
      candidate: false
    };
  }

  const body = text.slice(end, numericEnd);
  const endCategory = classifyNumberEnd(readerContext, numericEnd);
  readerContext.work += body.length;

  // Capital tails require written subunits instead of implicit digits; "壹拾元伍" is null.
  // parseAmount("壹佰零伍元伍角贰分") reads the explicit levels as 10552 cents.
  if (capital) {
    const digitValue = CAPITAL_FOLD[body[0]!] ? readSmallDigit(CAPITAL_FOLD[body[0]!]!) : null;
    const capitalZeroDigit = body.length === 2 && body[0] === '零'
      ? readSmallDigit(CAPITAL_FOLD[body[1]!] ?? '')
      : null;

    // This two-level path writes 角/毛 after its capital jiao digit before consuming a written 分.
    // "壹佰零伍元伍角贰分" uses this path; the separate branch below accepts 分 directly after 元.
    if (level === 100n && body.length === 1 && digitValue !== null
      && '角毛'.includes(text[numericEnd] ?? '\0')) {
      const after = numericEnd + 1;
      const nextEnd = readerContext.numericFieldEnds[after]!;

      if (nextEnd > after) {
        const fractionSpelling = text.slice(after, nextEnd);
        const fractionDigit = fractionSpelling.length === 1
          ? readSmallDigit(CAPITAL_FOLD[fractionSpelling] ?? '')
          : null;

        if (fractionDigit !== null && text[nextEnd] === '分') {
          return readCurrencyTail(
            readerContext,
            value + digitValue * 10n + fractionDigit,
            nextEnd + 1,
            1n,
            true
          );
        }

        return classifyNumberEnd(readerContext, nextEnd) === 'word' ? {
          list: [{
            cents: value + digitValue * 10n,
            end: after
          }],
          candidate: false
        } : null;
      }

      return readCurrencyTail(readerContext, value + digitValue * 10n, after, 1n, true);
    }

    // A capital fen digit, optionally after 零, can follow 元 without an intervening 角/毛.
    // parseAmount("壹拾元伍分") and "壹拾元零伍分" both return 1005 cents.
    if (level === 100n && text[numericEnd] === '分'
      && (body.length === 1 && digitValue !== null || capitalZeroDigit !== null)) {
      return readCurrencyTail(
        readerContext,
        value + (capitalZeroDigit ?? digitValue)!,
        numericEnd + 1,
        1n,
        true
      );
    }

    return endCategory === 'word' ? {
      list: [main],
      candidate: false
    } : null;
  }

  // There is no smaller implicit currency level after fen; an ordinary word can still leave the main reading intact.
  if (level === 1n) {
    return endCategory === 'word' ? {
      list: [main],
      candidate: false
    } : null;
  }

  const digitValue = readSmallDigit(body[0]);
  const zeroPrefixedDigit = body.length === 2 && body[0] === '零' ? readSmallDigit(body[1]) : null;

  // 角/毛 allow one digit or 零 plus a digit only directly below yuan.
  // parseAmount("十二块零五毛三分") is 1253 cents; without this path the explicit jiao tail would be rejected.
  if (body.length === 1 && (digitValue !== null || body === '两')
    && '角毛'.includes(text[numericEnd] ?? '\0')
    && level === 100n
    || zeroPrefixedDigit !== null && '角毛'.includes(text[numericEnd] ?? '\0') && level === 100n) {
    const tailDigit = zeroPrefixedDigit ?? (body === '两' ? 2n : digitValue!);

    return readCurrencyTail(readerContext, value + tailDigit * 10n, numericEnd + 1, 10n);
  }

  // Fen accepts one ordinary digit after yuan or jiao, but 零 plus a digit only after yuan.
  // parseAmount("十二块零三分") is 1203 cents; "十二块五毛零三分" and "十二块两分" are null.
  if (text[numericEnd] === '分'
    && (body.length === 1 && digitValue !== null || zeroPrefixedDigit !== null && level === 100n)) {
    return readCurrencyTail(readerContext, value + (zeroPrefixedDigit ?? digitValue)!, numericEnd + 1, 1n);
  }

  // An unmatched written currency tail invalidates the chain before any implicit-tail alternatives are considered.
  if (endCategory === 'unit') {
    return null;
  }

  let list: Reading[] | null = null;
  let candidate = false;
  const factor = level === 100n ? 10n : 1n;

  // The two-digit colloquial fen tail is complete only directly before a sentence end; after an ordinary
  // word the older implicit-tail readings stay in force. parseAmount("一块二五本") keeps 120 cents.
  const colloquialFenTail = level === 100n && endCategory === 'end'
    ? readColloquialFenTail(body)
    : null;

  // An ordinary word leaves both the main amount and one implicit subunit possible;
  // parseAmount("三元五本") retains 300 cents at end 2 and 350 cents at end 3.
  if (body.length === 1 && (digitValue !== null || body === '半')) {
    const extra = (body === '半' ? 5n : digitValue!) * factor;
    const withTail = {
      cents: value + extra,
      end: numericEnd
    };

    // Single-word suffixes after candidate tails are ordinary words.
    const ending = isSentenceEnd(readerContext, numericEnd)
      || SUFFIXES.some(([word]) => matchesWordAt(readerContext, numericEnd, word));
    list = ending ? [withTail] : [
      main,
      withTail
    ];
    candidate = true;
  } else if (level === 100n && zeroPrefixedDigit !== null) {
    list = [{
      cents: value + zeroPrefixedDigit,
      end: numericEnd
    }];
  } else if (level === 100n && body.length === 2 && isArabicDigit(body[0]) && isArabicDigit(body[1])) {
    // Before a word, two Arabic digits leave main, two-digit fen, and first-digit jiao readings.
    // parseAmount("5块12本") returns (500, end 2), (512, end 4), (510, end 3); end + 1 leaves digit 2 outside.
    const withTail = {
      cents: value + BigInt(body),
      end: numericEnd
    };
    list = endCategory === 'end' ? [withTail] : [
      main,
      withTail,
      ...(body[0] !== '0' && body[1] !== '0' ? [{
        cents: value + BigInt(body[0]!) * 10n,
        end: end + 1
      }] : [])
    ];
  } else if (level === 100n && CHINESE_CENTS_TAIL_PATTERN.test(body)) {
    const tailDigit = readChineseInteger(body)!;
    const withTail = {
      cents: value + tailDigit.value,
      end: numericEnd
    };
    list = endCategory === 'end' ? [withTail] : [
      main,
      withTail
    ];
  } else if (colloquialFenTail !== null) {
    // Two ordinary digits after a yuan word, the second one being 五, directly before a sentence end
    // spell a complete colloquial amount: the first digit counts jiao and the second a written five fen.
    // parseAmount("一块二五") is 125 cents at end 4; "五块三五" is 535 cents although 三五 is an adjacent pair.
    list = [{
      cents: value + colloquialFenTail,
      end: numericEnd
    }];
    candidate = true;
  } else if (body.length > 1) {
    // A longer field may begin with a monetary tail and continue with a separate count; only that prefix is consumed.
    let consumed = 0;
    let extra = 0n;
    let pair = false;

    // One implicit digit stops before the remaining count; an adjacent pair retains the main alternative.
    // parseAmount("五块五六本") returns 500 cents at end 2 and 550 cents at end 3.
    if ((digitValue !== null || body[0] === '半') && !PLACE_VALUES[body[1]!]
      && !(isArabicDigit(body[0]) && isArabicDigit(body[1]))) {
      consumed = 1;
      extra = (body[0] === '半' ? 5n : digitValue!) * factor;
      pair = ADJACENT_DIGIT_PAIRS.has(body.slice(0, 2));
    } else if (level === 100n && body[0] === '零' && readSmallDigit(body[1]) !== null && body.length > 2
      && !PLACE_VALUES[body[2]!]) {
      // A zero-prefixed fen digit consumes two characters, not a jiao digit;
      // parseAmount("五块零五一本") returns only 505 cents at end 4.
      consumed = 2;
      extra = readSmallDigit(body[1])!;
    } else if (level === 100n && body.length > 2 && isArabicDigit(body[0]) && isArabicDigit(body[1])
      && !isArabicDigit(body[2])
      && !PLACE_VALUES[body[2]!]) {
      // Two Arabic fen digits consume two characters before a non-Arabic count;
      // parseAmount("五块12一本") returns only 512 cents at end 4.
      consumed = 2;
      extra = BigInt(body.slice(0, 2));
    }

    // A partial tail needs a following word; punctuation cannot validate an unfinished numeric body.
    // For example, parseAmount("五块五一。") is null.
    if (consumed) {
      if (endCategory === 'end') {
        return null;
      }

      const withTail = {
        cents: value + extra,
        end: end + consumed
      };
      list = pair ? [
        main,
        withTail
      ] : [withTail];
      candidate = true;
    }
  }

  // An ordinary-word ending can preserve the main amount even when its apparent tail is invalid;
  // parseAmount("五块五百本") returns only 500 cents at end 2.
  if (!list) {
    return endCategory === 'end' ? null : {
      list: [main],
      candidate: false
    };
  }

  // A deliberate grammar rule moves the full-tail reading before the main reading when followed by 的.
  // Why this ordering was chosen is not recorded; neither reading is discarded.
  // parseAmount("十二块五的书") returns 1250 then 1200 cents.
  // parseAmount("5块12的本") returns cents/end pairs (512, 4), (500, 2), (510, 3).
  if (text[numericEnd] === '的' && list.length > 1) {
    list = [
      list[1]!,
      list[0]!,
      ...list.slice(2)
    ];
  }

  return {
    list,
    candidate
  };
}

/**
 * Lazily yields valid split positions without reading or allocating the unconsumed suffix of a numeric unit chain.
 * Each consumed prefix character is classified once, in O(consumed prefix length) work and O(1) extra space.
 * Grouping uses three integer digits per comma group and at most two fraction digits (decimal grammar).
 */
function* classifyArabicPrefixes(
  readerContext: ReaderContext,
  startPosition: number,
  end: number
): Generator<number> {
  const text = readerContext.text;
  let group = 0;
  let hasComma = false;
  let decimal = false;
  let fraction = 0;

  // Invalidity is sticky: a later digit cannot repair malformed grouping; each prefix is classified only once.
  let invalid = false;
  let position = startPosition;

  for (; position < end; position++) {
    const character = text[position]!;
    readerContext.work++;

    if (isArabicDigit(character)) {
      if (decimal) {
        fraction++;

        if (fraction > 2) {
          invalid = true;
        }
      } else {
        group++;

        if (!hasComma && text[startPosition] === '0' && group > 1 || hasComma && group > 3) {
          invalid = true;
        }
      }
    } else if (character === ',') {
      // Only completed groups of three may follow the first comma; the same prefix grammar guards named-unit splits.
      if (decimal || hasComma && group !== 3
        || !hasComma && (group < 1 || group > 3 || text[startPosition] === '0')) {
        invalid = true;
      }

      hasComma = true;
      group = 0;
    } else if (character === '.') {
      if (decimal || hasComma && group !== 3 || group === 0) {
        invalid = true;
      }

      decimal = true;
    } else {
      break;
    }

    if (!invalid && (decimal ? fraction >= 1 && fraction <= 2 : group > 0 && (!hasComma || group === 3))) {
      yield position + 1;
    }
  }

  // The retained split grammar probes at most ten positions beyond the Arabic run.
  // Yielding lazily stops both classification and allocation when the earliest unit split succeeds.
  for (let split = position + 1; split <= Math.min(end, position + 10); split++) {
    yield split;
  }
}

/**
 * Returns the exclusive end of a closed half-yuan spelling at startPosition, or 0 when the text there
 * is not one. startPosition is the index of 半 in the folded text; the spellings are the three
 * characters 块钱 and the two characters 半元. The result is a position in the
 * folded text, which is also an original UTF-16 offset.
 * 元 is rejected before 旦, 宵 and 音, and either unit
 * spelling is rejected when a numeral character follows it directly, because a further digit would be
 * part of the same number rather than of a half yuan.
 */
function readHalfYuanEnd(readerContext: ReaderContext, startPosition: number): number {
  const text = readerContext.text;

  if (text[startPosition] !== '半') {
    return 0;
  }

  // 块钱 writes the yuan and its 钱 tail, so nothing else is needed after it; the two unit spellings
  // below leave the number open, which the numeral check at the end closes.
  if (matchesWordAt(readerContext, startPosition + 1, '块钱')) {
    return startPosition + 3;
  }

  if (text[startPosition + 1] !== '元') {
    return 0;
  }

  // Holiday words and the phonetic term 元音 cannot identify money.
  if ('旦宵音'.includes(text[startPosition + 2] ?? '\0')) {
    return 0;
  }

  if (isNumberCharacter(text[startPosition + 2])) {
    return 0;
  }

  return startPosition + 2;
}

/**
 * Returns the registered unit word carried by an amount expression, or null when the expression has
 * a yuan unit or no written unit at all.
 * expression is one completed reading; the result is the caller-provided folded word, never a
 * converted value. Both readings and range forms answer through their unit field, so a range over one
 * named unit reports that word and a bare candidate reports null.
 */
function namedUnitWord(expression: AmountExpression): string | null {
  return expression.unit?.kind === 'named' ? expression.unit.word : null;
}

// One provisional member and the dependency flag that the reverse pass resolves against its cached successor.
interface ChainMember {
  startPosition: number;
  amount: AmountCore | null;
  pending: boolean;
}

/**
 * Reads one provisional member of a written-unit chain at startPosition without deciding whether the
 * member's own continuation keeps it readable. startPosition is a folded-text position; the result is
 * the amount read with standalone fragment semantics, retaining connectors and modifiers while
 * ignoring the preceding member's unit, or null when the text there is
 * no readable amount. A non-null result carries chainPending true while its continuation is still
 * open; the chain walk below resolves that flag.
 */
function readProvisionalChainAmount(readerContext: ReaderContext, startPosition: number): AmountCore | null {
  // Ignore only the preceding member's unit. Standalone semantics still read connectors and modifiers;
  // using a range endpoint read here would discard both parts of those ordinary fragment semantics.
  return readAmountAt(readerContext, startPosition, false, false, true, true);
}

/**
 * Reads the amount standing directly after a named unit as the next member of a written-unit chain.
 * startPosition is the first folded-text position of that amount; the result is the amount read with
 * the ordinary fragment semantics, or, when the preceding unit blocks that read, with the standalone
 * joining semantics used for a range's right side, or null when no readable chain stands there.
 * The chain is followed with a loop over its members and then decided with a second loop. All member
 * reads and their single connector endpoints set deferChain. A reverse pass resolves each member
 * against its already cached continuation, including the failure semantics of a range endpoint.
 * Cached reads return before entering the walker, so the call stack stays bounded independently of chain length.
 * Each position has at most one provisional read and one resolved read, so k members cost O(k) reads instead
 * of re-reading its whole suffix once per member; the map probes and reads are charged to work.
 */
function readChainedAmountCore(readerContext: ReaderContext, startPosition: number): AmountCore | null {
  const cached = readerContext.chainedAmounts.get(startPosition);

  if (cached !== undefined) {
    readerContext.work++;

    return cached;
  }

  readerContext.work++;

  const members: ChainMember[] = [];
  let position = startPosition;

  // Follow the chain forward with a loop: a member whose continuation is still open leads to the
  // amount directly after its own unit, which is its next member.
  for (;;) {
    readerContext.work++;

    const known = readerContext.chainedAmounts.get(position);

    // A cached position is already decided, so it ends the walk; its word still joins the decision.
    if (known !== undefined) {
      members.push({
        startPosition: position,
        amount: known,
        pending: false
      });

      break;
    }

    const amount = readProvisionalChainAmount(readerContext, position);
    const pending = amount !== null && amount.chainPending === true;

    members.push({
      startPosition: position,
      amount,
      pending
    });

    // A member standing alone ends the chain; only an open continuation leads to a next member.
    if (!pending) {
      break;
    }

    position = (amount!).expression.end;
  }

  // Resolve dependencies from the end. Ordinary reads now consult only cached continuations,
  // preserving an unreadable right endpoint's fallback to its written left amount without recursion.
  for (let index = members.length - 1; index >= 0; index--) {
    const member = members[index]!;
    const resolved = member.pending
      ? readAmountAt(readerContext, member.startPosition, false, false, false, true)
      : member.amount;

    readerContext.chainedAmounts.set(member.startPosition, resolved);
  }

  return readerContext.chainedAmounts.get(startPosition) ?? null;
}

/**
 * True when the text directly after a named unit reads as a further amount with a different
 * registered unit, so one written unit directly follows another.
 * unitEnd is the folded-text position directly after the amount's own unit and unit is that unit;
 * the answer is a boolean. A follower without a named unit (bare or yuan), one carrying the same
 * word, and unreadable text all answer false and leave the existing rejection in force.
 */
function continuesWithChainedUnit(readerContext: ReaderContext, unitEnd: number, unit: AmountUnit): boolean {
  if (unit === null || unit.kind !== 'named') {
    return false;
  }

  const continuation = readChainedAmountCore(readerContext, unitEnd);
  const continuedWord = continuation ? namedUnitWord(continuation.expression) : null;

  return continuedWord !== null && continuedWord !== unit.word;
}

/**
 * True when a numeric field directly after a named unit closes with a written sub-unit from 钱厘毫文
 * that does not begin a registered unit, so the named amount ends at its own unit.
 * unitEnd is the position directly after the amount's own unit and numericEnd is the end of the
 * numeric run that reaches unitEnd; the answer is a boolean. A missing numeric character at unitEnd,
 * any other following character, and a position where a registered unit begins all answer false, so
 * those spellings keep the existing rejection of the whole amount.
 */
function closesWithUnregisteredSubunit(readerContext: ReaderContext, unitEnd: number, numericEnd: number): boolean {
  return isNumberCharacter(readerContext.text[unitEnd])
    && '钱厘毫文'.includes(readerContext.text[numericEnd] ?? '\0')
    && readNamedUnitAt(readerContext, numericEnd) === null;
}

/**
 * Named units may begin inside numeric fields; the earliest viable split wins before ordinary currency resolution.
 * The extra 10 positions after an Arabic prefix and 40-position other split limit have no recorded derivation.
 * 50 hundredths for half yuan, and 100/10/1 currency levels, are fixed by the half/subunit grammar cases.
 * Character work is O(field length) for a fixed unit list; candidate tail order and counted probes stay intact.
 * deferChain marks a provisional chain member whose continuation the chain walk decides after every
 * member has been read; every read outside that walk decides the continuation on the spot.
 */
function readAmountCore(readerContext: ReaderContext, start: number, deferChain = false): AmountCore | null {
  const text = readerContext.text;
  const symbol = text[start] === '¥' || text[start] === '￥';
  const startPosition = start + (symbol ? 1 : 0);
  let parsedNumber: ParsedNumber | null = null;
  let unit: AmountUnit = null;
  let unitEnd = 0;
  const fieldEnd = readerContext.numericFieldEnds[startPosition]!;

  // Numeric named-unit words can begin inside the field; classify prefixes once to avoid reparsing every bad split.
  const splitPositions = !readerContext.units.length ? [] : isArabicDigit(text[startPosition])
    ? classifyArabicPrefixes(readerContext, startPosition, fieldEnd)
    : Array.from({length: Math.min(fieldEnd - startPosition, 40)}, (_, index) => startPosition + index + 1);

  // Configured units can start inside a numeric field; Chinese syntax keeps these split trials bounded.
  for (const position of splitPositions) {
    readerContext.work++;

    const unitPosition = readerContext.nextNonWhitespace[position]!;
    const direct = readNamedUnitAt(readerContext, unitPosition);

    // Only 个/枚/块/颗/两 may sit between a number and a configured unit; direct unit matches take precedence.
    // parseAmount("三两银子", {units: ["银子"]}) reads 300 hundredths of 银子.
    const counted = '个枚块颗两'.includes(text[unitPosition] ?? '\0')
      ? readNamedUnitAt(readerContext, unitPosition + 1)
      : null;
    const word = direct ?? counted;

    if (!word) {
      continue;
    }

    const candidate = readNumberAt(readerContext, startPosition, false, position, false);

    // Keep the earliest viable split, then stop; changing the trial order would change the chosen named unit.
    if (candidate) {
      parsedNumber = candidate;
      unit = {
        kind: 'named',
        word
      };
      unitEnd = unitPosition + (direct ? 0 : 1) + word.length;

      break;
    }
  }

  // Numeric unit words can keep an entire chain inside one lexical field. Read only the chosen
  // member's prefix before trying the full field, so successive members never reparse growing suffixes.
  parsedNumber ??= readNumberAt(readerContext, startPosition);

  // The closed half-yuan spellings are resolved before ordinary numeric failure; 半块钱 and 半元
  // read 50 cents, while 半块 without 钱 and the shape 半圆 stay unreadable.
  const halfYuanEnd = parsedNumber ? 0 : readHalfYuanEnd(readerContext, startPosition);

  if (halfYuanEnd > 0) {
    parsedNumber = {
      end: startPosition + 1,
      raw: '半',
      value: 50n,
      minimumHundredths: null,
      maximumHundredths: null,
      range: false,
      capital: false,
      decimal: false,
      omitted: false,
      upwardMagnitude: false
    };

    return {
      expression: buildAmountReadings(start, {
        kind: 'yuan'
      }, [{
        cents: 50n,
        end: halfYuanEnd
      }]),
      number: parsedNumber,
      checkedEnd: halfYuanEnd,
      candidate: false,
      major: true
    };
  }

  if (!parsedNumber) {
    return null;
  }

  let unitPosition = readerContext.nextNonWhitespace[parsedNumber.end]!;

  // The same 个/枚/块/颗/两 classifier list also applies after a normally parsed number.
  // For example, parseAmount("三枚金币", {units: ["金币"]}) reads 300 hundredths of 金币.
  if (unit === null) {
    const direct = readNamedUnitAt(readerContext, unitPosition);
    const counted = '个枚块颗两'.includes(text[unitPosition] ?? '\0')
      ? readNamedUnitAt(readerContext, unitPosition + 1)
      : null;

    if (direct || counted) {
      const word = (direct ?? counted)!;
      unit = {
        kind: 'named',
        word
      };
      unitEnd = unitPosition + (direct ? 0 : 1) + word.length;
    }
  }

  if (unit !== null) {
    const numericEnd = readerContext.numericFieldEnds[unitEnd]!;
    let chainPending = false;

    // A numeric field directly after a named unit keeps the named amount readable only when a closed
    // continuation stands there: a second amount carrying a different registered unit (3金币5银币),
    // or a following 钱/厘/毫/文 that does not begin a registered unit (十二两五钱). A sentence end,
    // a bare number, a yuan word and the same unit twice still reject the whole named amount.
    if (numericEnd > unitEnd
      && (classifyNumberEnd(readerContext, numericEnd) !== 'word'
        || '钱厘毫文'.includes(text[numericEnd] ?? '\0'))) {
      if (deferChain) {
        // A provisional member only records that its continuation is still open; a written sub-unit
        // already closes the amount here, and the chain walk decides the rest.
        chainPending = !closesWithUnregisteredSubunit(readerContext, unitEnd, numericEnd);
      } else if (!continuesWithChainedUnit(readerContext, unitEnd, unit)
        && !closesWithUnregisteredSubunit(readerContext, unitEnd, numericEnd)) {
        return null;
      }
    }

    return {
      expression: buildNumericAmount(parsedNumber, start, unitEnd, unit),
      number: parsedNumber,
      checkedEnd: unitEnd,
      candidate: false,
      major: true,
      chainPending
    };
  }

  // 来/把 between the number and its currency belong to the numeric range.
  if (parsedNumber.end > startPosition
    && (text[parsedNumber.end - 1] === '来' || text[parsedNumber.end - 1] === '把')
    && !isCurrencyAt(readerContext, unitPosition)) {
    parsedNumber = readNumberAt(readerContext, startPosition, false, parsedNumber.end - 1, false);

    if (!parsedNumber) {
      return null;
    }

    unitPosition = readerContext.nextNonWhitespace[parsedNumber.end]!;
  }

  // 元/圆/块 select the yuan tail grammar, rather than returning a bare numeric amount.
  // For example, parseAmount("十二块五毛三分") reads 1253 cents.
  if ('元圆块'.includes(text[unitPosition] ?? '\0')) {
    // 旦/宵 exclude holiday words after 元; parseAmount("十二元旦") is null.
    if (text[unitPosition] === '元' && '旦宵'.includes(text[unitPosition + 1] ?? '\0')) {
      return null;
    }

    const currencyEnd = unitPosition + 1;

    // A numeric range has no single base for subunit arithmetic; trailing numeric currency levels invalidate it.
    if (parsedNumber.range) {
      if (readerContext.numericFieldEnds[currencyEnd]! > currencyEnd
        && classifyNumberEnd(readerContext, readerContext.numericFieldEnds[currencyEnd]!) !== 'word') {
        return null;
      }

      const paidEnd = text[currencyEnd] === '钱' ? currencyEnd + 1 : currencyEnd;

      return {
        expression: buildNumericAmount(parsedNumber, start, paidEnd, {
          kind: 'yuan'
        }),
        number: parsedNumber,
        checkedEnd: paidEnd,
        candidate: false,
        major: true
      };
    }

    const tailResult = readCurrencyTail(
      readerContext,
      parsedNumber.value!,
      currencyEnd,
      100n,
      parsedNumber.capital
    );

    return tailResult ? {
      expression: buildAmountReadings(start, {
        kind: 'yuan'
      }, tailResult.list),
      number: parsedNumber,
      checkedEnd: Math.max(...tailResult.list.map(reading => reading.end)),
      candidate: tailResult.candidate,
      major: tailResult.list.every(reading => reading.end === currencyEnd || text[reading.end - 1] === '钱')
    } : null;
  }

  // Standalone 角/毛/分 each require a single digit; 角/毛 are tenths, and 分 additionally needs 钱.
  // parseAmount("两分钱") reads 2 cents, although "十二块两分" remains null.
  if ('角毛分'.includes(text[unitPosition] ?? '\0')) {
    const value = parsedNumber.raw === '两' ? 2n : readSmallDigit(parsedNumber.raw);

    if (parsedNumber.raw.length !== 1 || value === null || parsedNumber.range
      || text[unitPosition] === '分' && text[unitPosition + 1] !== '钱') {
      return null;
    }

    const level = text[unitPosition] === '分' ? 1n : 10n;
    const tailResult = readCurrencyTail(readerContext, value * level, unitPosition + 1, level);

    return tailResult ? {
      expression: buildAmountReadings(start, {
        kind: 'yuan'
      }, tailResult.list),
      number: parsedNumber,
      checkedEnd: Math.max(...tailResult.list.map(reading => reading.end)),
      candidate: tailResult.candidate,
      major: false
    } : null;
  }

  // A leading yuan symbol supplies the unit even without a currency word; parseAmount("¥十二") is 1200 cents.
  if (symbol) {
    return {
      expression: buildNumericAmount(parsedNumber, start, parsedNumber.end, {
        kind: 'yuan'
      }),
      number: parsedNumber,
      checkedEnd: parsedNumber.end,
      candidate: false,
      major: true
    };
  }

  // A Chinese decimal needs a monetary unit; failed currency spellings cannot fall back to a bare amount.
  // A sectioned 万/亿 decimal reads bare by its own rule, and so does an Arabic decimal whose point is
  // the dot; an Arabic 点 spelling keeps the unit requirement.
  const bareDecimal = parsedNumber.decimal
    && (isSectionedDecimalRaw(parsedNumber.raw)
      || isArabicDigit(parsedNumber.raw[0]) && !parsedNumber.raw.includes('点'));

  if (parsedNumber.decimal && !bareDecimal
    || isCurrencyAt(readerContext, unitPosition)) {
    return null;
  }

  return {
    expression: buildNumericAmount(parsedNumber, start, parsedNumber.end, null),
    number: parsedNumber,
    checkedEnd: parsedNumber.end,
    candidate: false,
    major: false
  };
}

/**
 * Tests whether the single UTF-16 position directly before position holds an ordinary letter.
 * position is a folded-text position; the answer is a boolean and one character is visited.
 * A blank, a punctuation character, a numeral character, a missing position and the text start
 * answer false; the word-ending checks use this direct neighbor only, never a whitespace jump.
 */
function isOrdinaryLetterBefore(readerContext: ReaderContext, position: number): boolean {
  const character = readerContext.text[position - 1];
  readerContext.work++;

  return character !== undefined && !isNumberCharacter(character) && LETTER_CHARACTER.test(character);
}

/**
 * Decides whether a Chinese digit or a coefficient-less place value directly left of an Arabic
 * number is an ordinary letter, so that number is read on its own from its first Arabic digit.
 * start is the position of that first Arabic digit in the folded text; the answer is a boolean.
 * Inline blanks are crossed through cached jumps. After 十 the following Arabic spelling is visited
 * a fixed number of times, including punctuation and uncertainty particles, in O(spelling length) work.
 * 一..九 always release; 十 releases only without a following place value. 百/千/万/亿 release when their left neighbor across
 * blanks is absent or is not a numeral character; every other character answers false.
 */
function releasesArabicAfterChineseDigit(readerContext: ReaderContext, start: number): boolean {
  const text = readerContext.text;
  const boundary = readerContext.previousNonWhitespaceEnd[start]!;
  const previousCharacter = text[boundary - 1];
  readerContext.work += 2;

  if (previousCharacter === undefined) {
    return false;
  }

  if (previousCharacter === '十') {
    let end = start;

    while (isArabicDigit(text[end])
      || text[end] !== undefined && '.,，点多余来'.includes(text[end]!)) {
      end++;
      readerContext.work++;
    }

    // A following written place belongs to the mixed spelling, rather than to a released bare digit.
    return !'百千万亿佰仟'.includes(text[end] ?? '\0');
  }

  if (SMALL_DIGITS.includes(previousCharacter)) {
    return true;
  }

  if (!RELEASING_PLACE_VALUES.includes(previousCharacter)) {
    return false;
  }

  const coefficient = text[readerContext.previousNonWhitespaceEnd[boundary - 1]! - 1];

  return coefficient === undefined || !isNumberCharacter(coefficient);
}

/**
 * Applies the word-ending release to a numeric field starting with one of the five word-ending
 * capitals directly after an ordinary letter.
 * fieldStart is the first folded-text position of that field; the answer is a boolean.
 * The field is examined once, position by position, and every visited position is counted.
 * Registered unit words do not supply the further ordinary numeral, but their capital numerals still
 * protect the entire field. A field holding another capital numeral,
 * or only 零/万/亿 outside those words after its first character, answers
 * false and keeps the numeral reading; otherwise true releases the field's second character.
 */
function startsReleasedCapitalField(readerContext: ReaderContext, fieldStart: number): boolean {
  const text = readerContext.text;

  if (!WORD_ENDING_CAPITALS.includes(text[fieldStart]!)
    || !isOrdinaryLetterBefore(readerContext, fieldStart)) {
    return false;
  }

  const fieldEnd = readerContext.numericFieldEnds[fieldStart]!;
  let hasOtherCharacter = false;
  let unitEnd = fieldStart + 1;

  for (let position = fieldStart + 1; position < fieldEnd; position++) {
    readerContext.work++;
    const character = text[position]!;

    // Capital numerals protect the field even inside a registered unit; only the ordinary-digit test skips words.
    if (CAPITAL_NUMERALS.includes(character)) {
      return false;
    }

    if (position >= unitEnd && readerContext.unitInitials.has(character)) {
      const unitWord = readNamedUnitAt(readerContext, position);

      if (unitWord !== null) {
        unitEnd = position + unitWord.length;
      }
    }

    if (position < unitEnd) {
      continue;
    }

    if (!'零万亿'.includes(character)) {
      hasOtherCharacter = true;
    }
  }

  return hasOtherCharacter;
}

/**
 * Finds the first Arabic run inside one numeric field whose left side is a released Chinese digit
 * or coefficient-less place value, so that run is read on its own from its first digit.
 * fieldStart and fieldEnd bound the field in the folded text; the answer is that UTF-16 position,
 * or -1 when no released run exists. The field is examined once and each position is counted.
 */
function releasedArabicStartInField(readerContext: ReaderContext, fieldStart: number, fieldEnd: number): number {
  const text = readerContext.text;

  for (let position = fieldStart + 1; position < fieldEnd; position++) {
    readerContext.work++;

    if (isArabicDigit(text[position]) && !isArabicDigit(text[position - 1])
      && releasesArabicAfterChineseDigit(readerContext, position)) {
      return position;
    }
  }

  return -1;
}

/**
 * A capital numeral released by a preceding ordinary letter never becomes the left side of a range
 * connection while it stands alone and bare.
 * core is one successful amount read; the answer is a boolean and at most one character is visited.
 * True only for a bare single-character spelling from the five word-ending capitals directly after
 * a letter; every other left side keeps its connection.
 */
function blocksReleasedCapitalConnection(readerContext: ReaderContext, core: AmountCore): boolean {
  return core.expression.bare
    && core.number.raw.length === 1
    && WORD_ENDING_CAPITALS.includes(core.number.raw)
    && isOrdinaryLetterBefore(readerContext, core.expression.start);
}

/**
 * Neighbor checks precede parsing; the isolated zero exception uses the cached inline-whitespace jump.
 * releasedStart marks a start whose left numeral character was already released as an ordinary letter;
 * the numeral check below is skipped there, while the sign and currency-chain checks still apply.
 * afterClockPoint releases only a directly preceding 点 after a numeral, without releasing other punctuation.
 */
function allowsAmountLeftNeighbor(
  readerContext: ReaderContext,
  start: number,
  releasedStart = false,
  afterClockPoint = false
): boolean {
  const text = readerContext.text;
  const position = readerContext.previousNonWhitespaceEnd[start]!;
  const previousCharacter = text[position - 1];
  const immediate = text[start - 1];

  // A released Arabic number is read on its own even though a Chinese digit or a coefficient-less
  // place value stands left of it; every other numeral keeps blocking its right side.
  const released = releasedStart
    || isArabicDigit(text[start]) && releasesArabicAfterChineseDigit(readerContext, start);

  // The isolated 零 exception admits change after inline whitespace, while rejecting a zero inside another number.
  // scanAmounts("找零 五块") returns one 500-cent reading at [3, 5).
  if (!released && (previousCharacter === '第'
    || previousCharacter !== undefined && NUMERIC_FIELD_CHARACTERS.has(previousCharacter))) {
    if (!isIsolatedZero(readerContext, position)) {
      return false;
    }
  }

  // Underscores, hashes and the blocking signs suppress a numeric suffix; scanning must not turn it
  // into a new amount. A plus sign never blocks, and a minus sign blocks only directly after another
  // numeral, where it is a hyphen between two numbers. A Latin letter is judged after parsing, where
  // a written currency or configured unit can still allow the amount.
  if (immediate && (immediate === '_' || immediate === '#' || immediate === '负'
    || immediate === '$' || immediate === '＄')) {
    return false;
  }

  if (immediate && '－-−'.includes(immediate) && isNumberCharacter(text[start - 2])) {
    return false;
  }

  // ASCII/fullwidth dots, comma and 点 keep the numeric continuation attached to its left side.
  // The additional leading-dot guard keeps parseAmount(".5元") null.
  if (immediate && '.．,点'.includes(immediate) && isNumberCharacter(text[start - 2])
    && !(afterClockPoint && immediate === '点')) {
    return false;
  }

  if (isArabicDigit(text[start]) && (immediate === '.'
    || immediate === '．' && fullWidthGroupedNumberEnd(text, start, readerContext) < 0)) {
    return false;
  }

  // Do not restart a new amount in a contiguous currency chain; scanAmounts("十块八块") returns no candidates.
  let unitEnd = start;

  if (text[unitEnd - 1] === '钱') {
    unitEnd--;
  }

  if (unitEnd > 0 && isCurrencyAt(readerContext, unitEnd - 1) && isNumberCharacter(text[unitEnd - 2])) {
    return false;
  }

  for (const word of readerContext.units) {
    if (unitEnd >= word.length && matchesWordAt(readerContext, unitEnd - word.length, word)
      && isNumberCharacter(text[unitEnd - word.length - 1])) {
      return false;
    }
  }

  return true;
}

/**
 * Exception words are checked before classifier prefixes; reversing them would reject the intended exceptions.
 */
function blocksBareAmountRightNeighbor(readerContext: ReaderContext, startPosition: number): boolean {
  // Exception words win before classifier prefixes; parseAmount("12本来") is 1200 cents, but "12本" is null.
  if (EXCEPTIONS.some(word => matchesWordAt(readerContext, startPosition, word))) {
    return false;
  }

  return QUANTITY_CLASSIFIERS.has(readerContext.text[startPosition]!)
    || TIME_CLASSIFIERS.has(readerContext.text[startPosition]!)
    || QUANTITY_CLASSIFIER_WORDS.some(word => matchesWordAt(readerContext, startPosition, word))
    || TIME_CLASSIFIER_WORDS.some(word => matchesWordAt(readerContext, startPosition, word));
}

/**
 * True when text[position - 1] is a colon and text[position - 2] an Arabic digit, the digit-colon of
 * a clock time, so the number at position is a minute rather than a standalone amount.
 * position is a folded-text index; at most two characters are visited and charged to work.
 * A missing position, a colon after anything else and every other character answer false.
 */
function followsDigitColon(readerContext: ReaderContext, position: number): boolean {
  readerContext.work += 2;

  return readerContext.text[position - 1] === ':'
    && isArabicDigit(readerContext.text[position - 2]);
}

/**
 * True when the number spanning start to end touches a slash that separates two Arabic digits: a
 * slash directly after the number followed by a digit, or a slash directly before it preceded by a
 * digit. That context marks a date or a ratio. start and end are half-open UTF-16 positions in the
 * folded text; at most four characters are visited and charged to work, and every other slash
 * context answers false, so 50元/个 and "3/ 5" keep their ordinary reading.
 */
function touchesNumericSlash(readerContext: ReaderContext, start: number, end: number): boolean {
  const text = readerContext.text;
  readerContext.work += 4;

  const before = text[start - 1];
  const after = text[end];

  return ((before === '/' || before === '／') && isArabicDigit(text[start - 2]))
    || ((after === '/' || after === '／') && isArabicDigit(text[end + 1]));
}

/**
 * Bare candidates need right-neighbor checks after modifiers/connections; written-unit candidates bypass them.
 * The six weekday digits and initial-day threshold 1000 hundredths retain the closed date grammar.
 * The two-character preceding slice is retained; its derivation is not recorded.
 */
function allowsBareAmount(
  readerContext: ReaderContext,
  core: AmountCore,
  after: number,
  connected: boolean
): boolean {
  const expression = core.expression;
  const parsedNumber = core.number;
  const text = readerContext.text;

  if (!expression.bare) {
    return true;
  }

  if (!parsedNumber.range && parsedNumber.value! <= 0n || parsedNumber.raw === '几') {
    return false;
  }

  const position = readerContext.nextNonWhitespace[after]!;
  const gap = position > after;

  // An isolated Chinese digit or upward magnitude needs a real end unless joined to another amount.
  if (!connected
    && (expression.end - expression.start === 1 && !isArabicDigit(parsedNumber.raw[0])
      || parsedNumber.upwardMagnitude)
    && !isSentenceEnd(readerContext, position)) {
    return false;
  }

  if (blocksBareAmountRightNeighbor(readerContext, position) || text[position] === '折'
    || text[position] === '%'
    || text[position] === '％') {
    return false;
  }

  if (!gap && (LATIN_CHARACTER.test(text[position] ?? '') || text[position] === '_')) {
    return false;
  }

  if (gap && isNumberCharacter(text[position])) {
    return false;
  }

  // Dots, commas and colons before another number prevent a date/time or malformed decimal suffix becoming money.
  // For example, parseAmount("12:30") is null.
  if ('.．,，:：'.includes(text[position] ?? '\0') && isNumberCharacter(text[position + 1])) {
    return false;
  }

  // A bare Arabic number directly after a digit-colon or next to a numeric slash is a clock minute,
  // a date or a ratio, not an amount. A written currency keeps those numbers: "3:30元" still lists
  // 30元, while "2024/3/5 收到100元" lists only the later 100元.
  readerContext.work += parsedNumber.raw.length;

  if (/^[0-9.,，]+$/.test(parsedNumber.raw)
    && (followsDigitColon(readerContext, expression.start)
      || touchesNumericSlash(readerContext, expression.start, expression.end))) {
    return false;
  }

  if (text[position] === '来' && blocksBareAmountRightNeighbor(readerContext, position + 1)) {
    return false;
  }

  const precedingText = text.slice(Math.max(0, expression.start - 2), expression.start);

  if (precedingText.endsWith('分之')) {
    return false;
  }

  // Only the first six small digits are suppressed after weekday prefixes; "星期五" is null through parseAmount.
  if (parsedNumber.raw.length === 1 && SMALL_DIGITS.slice(0, 6).includes(parsedNumber.raw)
    && (precedingText.endsWith('周') || precedingText.endsWith('星期') || precedingText.endsWith('礼拜'))) {
    return false;
  }

  // The initial-day exclusion stops at ten; parseAmount("初十二") remains a bare 1200-cent candidate.
  if (text[expression.start - 1] === '初' && !isArabicDigit(parsedNumber.raw[0])
    && parsedNumber.value !== null
    && parsedNumber.value <= 1000n) {
    return false;
  }

  // A newline before a currency is not the permitted inline whitespace.
  if ((text[after] === '\n' || text[after] === '\r') && isCurrencyAt(readerContext, after + 1)) {
    return false;
  }

  return true;
}

function haveCompatibleUnits(firstUnit: AmountUnit, secondUnit: AmountUnit): boolean {
  return firstUnit === null || secondUnit === null
    || firstUnit.kind === secondUnit.kind
    && (firstUnit.kind === 'yuan'
      || secondUnit.kind === 'named' && firstUnit.word === secondUnit.word);
}

/**
 * Connection arithmetic is bounded by Chinese syntax; Arabic spellings never infer unwritten units.
 * Borrow only a written suffix magnitude when the first value is below both coefficient and magnitude.
 * The comma-pair case precedes general borrowing; ambiguity is preserved as two unknown bounds.
 * 1000 hundredths means ten whole units in the ambiguity guard.
 * Chinese syntax bounds the suffix trials; Arabic coefficients retain their existing character work.
 */
function connectNumberRange(
  firstNumber: ParsedNumber,
  secondNumber: ParsedNumber,
  firstValue: bigint | null,
  secondValue: bigint | null,
  firstIsBare: boolean,
  hasComma: boolean,
  quantum: bigint
): [
  bigint | null,
  bigint | null
] {
  const firstSpelling = expandContractedTens(firstNumber.raw);
  const secondSpelling = expandContractedTens(secondNumber.raw);

  // Existing uncertainty cannot provide exact connected endpoints; keep both bounds unknown.
  if (firstValue === null || secondValue === null || firstNumber.range || secondNumber.range) {
    return [
      null,
      null
    ];
  }

  // The closed adjacent-pair shorthand is resolved before general suffix borrowing;
  // parseAmount("三、四十五块") spans 3500..4500 cents.
  if (hasComma && firstIsBare && firstSpelling.length === 1
    && (SMALL_DIGITS.includes(firstSpelling) || firstSpelling === '两')
    && ADJACENT_DIGIT_PAIRS.has(firstSpelling + secondSpelling[0])
    && PLACE_VALUES[secondSpelling[1]!]) {
    const lowerNumber = readExactNumber(firstSpelling + secondSpelling.slice(1));
    const upperNumber = readExactNumber(secondSpelling);

    if (lowerNumber && upperNumber) {
      return [
        lowerNumber.value,
        upperNumber.value
      ];
    }
  }

  if (firstIsBare) {
    let length = 0;

    for (let i = secondSpelling.length - 1; i >= 0 && PLACE_VALUES[secondSpelling[i]!]; i--) {
      length++;
    }

    // Try the longest written suffix first; a successful borrow must reproduce the right value from its coefficient.
    for (let count = length; count > 0; count--) {
      const coefficient = secondSpelling.slice(0, -count);

      if (!coefficient) {
        continue;
      }

      const coefficientValue = readArabicCents(coefficient)
        ?? (readChineseInteger(coefficient)?.value ?? -1n) * 100n;

      if (coefficientValue < 0n) {
        continue;
      }

      let magnitude = 1n;

      for (const character of secondSpelling.slice(-count)) {
        magnitude *= PLACE_VALUES[character]!;
      }

      // Borrow only when the bare left value is below both the coefficient and written magnitude;
      // parseAmount("三到五百万块") spans 300000000..500000000 cents.
      if (coefficientValue * magnitude === secondNumber.value && firstValue < coefficientValue
        && firstValue < magnitude * 100n) {
        return [
          firstValue * magnitude,
          secondValue
        ];
      }
    }

    // Only after borrowing fails, check whether a small whole left value could imply an unstated magnitude.
    // "三到十二万五千块" has null bounds; the fractional left value in "2.5到三十五块"
    // keeps 250..3500 cents.
    let largest = 0n;

    for (const character of secondSpelling) {
      if (PLACE_VALUES[character] && PLACE_VALUES[character]! > largest) {
        largest = PLACE_VALUES[character]!;
      }
    }

    if (firstValue < 1000n && firstValue % 100n === 0n && largest > 0n
      && firstValue * largest < secondNumber.value!) {
      return [
        null,
        null
      ];
    }
  }

  // Unborrowed endpoints must increase; equal or descending connections keep unknown bounds instead of reversing them.
  return firstValue < secondValue ? [
    firstValue,
    secondValue
  ] : [
    null,
    null
  ];
}

/**
 * Point estimates preserve an intrinsic more/head range before conflict handling; incompatible modifiers erase bounds.
 * 100 hundredths per unit and a 1-cent or 100-hundredth item quantum preserve the closed range endpoints.
 * The only recursive branch clears first, so recursion has at most two frames regardless of input length.
 */
function applyAmountModifiers(
  expression: AmountExpression,
  first: ApproximationModifier | null,
  second: ApproximationModifier | null,
  major: boolean,
  quantum = 1n
): AmountExpression {
  const range = (minimumCents: bigint | null, maximumCents: bigint | null): AmountExpression => ({
    start: expression.start,
    end: expression.end,
    unit: expression.unit,
    bare: expression.bare,
    kind: 'range',
    min: minimumCents,
    max: maximumCents,
    approx: true
  });

  if (!first && !second) {
    return expression;
  }

  // A point estimate preserves the intrinsic range supplied by 多 or 出头.
  if (first === 'point' && (second === 'more' || second === 'head')) {
    return applyAmountModifiers(expression, null, second, major, quantum);
  }

  // Conflicting lower/upper/estimate requests cannot select one interpretation; preserve uncertainty.
  if (first && second && first !== second) {
    return range(null, null);
  }

  const kind = first ?? second;

  // A point estimate preserves an existing interval, while another bound cannot refine it without evidence.
  // parseAmount("三到五块以上") therefore has null bounds.
  if (expression.kind === 'range') {
    return kind === 'point' ? expression : range(null, null);
  }

  if (expression.readings.length > 1) {
    return kind === 'point' ? {
      ...expression,
      approx: true
    } : range(null, null);
  }

  const value = expression.readings[0]!.cents;

  if (kind === 'point') {
    return range(value, value);
  }

  if (kind === 'lower') {
    return range(value, null);
  }

  if (kind === 'upper') {
    return range(null, value);
  }

  if (kind === 'more') {
    return major ? range(value, value + 100n - quantum) : range(null, null);
  }

  return value > 0n && value % 100n === 0n
    ? range(value, value + lowestPlaceValueCents(value) - quantum)
    : range(null, null);
}

/**
 * Tests whether a Latin-adjacent numeric field could carry a written unit before parsing it.
 * start is a folded UTF-16 offset. A unit initial inside the field or at its ordinary unit positions,
 * or a yuan/subunit word there, returns true; false proves the candidate would remain bare and be rejected.
 * This conservative scan costs O(field length), independent of the configured unit lengths and count.
 */
function mayCarryWrittenUnit(readerContext: ReaderContext, start: number): boolean {
  const text = readerContext.text;

  if (text[start] === '¥' || text[start] === '￥') {
    return true;
  }

  let end = readerContext.numericFieldEnds[start]!;

  if (text[end] === '点' && readerContext.numericFieldEnds[end + 1]! > end + 1) {
    end = readerContext.numericFieldEnds[end + 1]!;
  }

  // Sectioned particle ranges carry their unit after the following 万/亿 field, not after the initial coefficient.
  if ('多余来'.includes(text[end] ?? '\0') && '万亿'.includes(text[end + 1] ?? '\0')) {
    end = readerContext.numericFieldEnds[end + 1]!;
  }

  for (let position = start + 1; position < end; position++) {
    readerContext.work++;

    if (readerContext.unitInitials.has(text[position]!)) {
      return true;
    }
  }

  // A suffix particle can stand between the number and its unit, and a classifier can precede a named unit.
  for (const boundary of [end, end + 1]) {
    const position = readerContext.nextNonWhitespace[boundary];
    readerContext.work += 2;

    if (position !== undefined && ('元圆块角毛分'.includes(text[position] ?? '\0')
      || readerContext.unitInitials.has(text[position]!)
      || '个枚块颗两'.includes(text[position] ?? '\0')
      && readerContext.unitInitials.has(text[position + 1]!))) {
      return true;
    }
  }

  return false;
}

/**
 * A joined right side skips left-neighbor checks and modifier application; outer modifiers apply to the combined range.
 * An unreadable right side rejects a bare left side but keeps a written-unit left side and its modifiers.
 * releasedCapitalStart marks the shifted start of a word-released capital field, where the left-neighbor
 * numeral check must be skipped; a bare spelling directly after a Latin letter is rejected after parsing.
 * deferChain leaves a chain member's continuation to the chain walk, exactly as readAmountCore explains.
 * standalone ignores only left context for a chain member. joining reads at most one right endpoint;
 * that endpoint retains deferChain, so the chain walk cannot re-enter itself through a connector.
 * afterClockPoint changes only the numeric-point left-neighbor check for a scan-only alternative.
 */
function readAmountAt(
  readerContext: ReaderContext,
  start: number,
  joining = false,
  releasedCapitalStart = false,
  deferChain = false,
  standalone = false,
  afterClockPoint = false
): AmountCore | null {
  if (!joining && !standalone && LATIN_CHARACTER.test(readerContext.text[start - 1] ?? '')
    && !mayCarryWrittenUnit(readerContext, start)) {
    return null;
  }

  if (!joining && !standalone
    && !allowsAmountLeftNeighbor(readerContext, start, releasedCapitalStart, afterClockPoint)) {
    return null;
  }

  const core = readAmountCore(readerContext, start, deferChain);

  if (!core) {
    return null;
  }

  // A Latin letter directly before a spelling without a written unit keeps the digits out of a scan;
  // a yuan word or a configured unit still identifies the amount. parseAmount("A12") is null.
  if (!joining && !standalone && core.expression.unit === null
    && LATIN_CHARACTER.test(readerContext.text[start - 1] ?? '')) {
    return null;
  }

  let expression = core.expression;
  let after = expression.end;
  let connected = false;
  let endpointPending = false;

  // 、 joins only a bare left spelling whose sides both start with Chinese numerals: "三、四十五块"
  // is a range, but parseAmount("三元、四元") is null. An Arabic digit directly on either side of
  // 、 marks a numbered list such as "1、200元押金", where each side is read on its own.
  if (!joining && AMOUNT_CONNECTORS.has(readerContext.text[after]!)
    && !blocksReleasedCapitalConnection(readerContext, core)
    && (readerContext.text[after] !== '、' || expression.bare
      && !isArabicDigit(core.number.raw[0])
      && !isArabicDigit(readerContext.text[after + 1]))
    && NUMERIC_FIELD_CHARACTERS.has(readerContext.text[after + 1]!)) {
    const secondNumber = readAmountAt(readerContext, after + 1, true, false, deferChain);

    // A failed right side invalidates a bare left side, but a written unit still identifies its independent amount.
    // scanAmounts("大概十块到三个") keeps the 1000..1000-cent left estimate.
    if (!secondNumber && expression.bare) {
      return null;
    }

    if (secondNumber) {
      endpointPending = secondNumber.chainPending === true;
      const firstValue = expression.kind === 'readings' && expression.readings.length === 1
        ? expression.readings[0]!.cents
        : null;
      const secondExpression = secondNumber.expression;
      const secondValue = secondExpression.kind === 'readings' && secondExpression.readings.length === 1
        ? secondExpression.readings[0]!.cents
        : null;
      const [minimumCents, maximumCents] = haveCompatibleUnits(
        expression.unit,
        secondExpression.unit
      ) ? connectNumberRange(
        core.number,
        secondNumber.number,
        firstValue,
        secondValue,
        expression.bare,
        readerContext.text[after] === '、',
        1n
      ) : [
        null,
        null
      ];
      const unit = expression.unit ?? secondExpression.unit;
      expression = {
        start,
        end: secondExpression.end,
        unit,
        bare: unit === null,
        kind: 'range',
        min: minimumCents,
        max: maximumCents,
        approx: true
      };
      after = secondExpression.end;
      connected = true;
    }
  }

  // Apply outer modifiers after joining so a right-side suffix modifies the whole range rather than just its endpoint.
  const suffixModifier = readSuffixModifier(readerContext, after, !core.candidate);

  if (suffixModifier) {
    after = suffixModifier.end;
  }

  const prefixModifier = joining ? null : readPrefixModifier(readerContext, start);
  const checked = {
    ...core,
    expression
  };

  if (!allowsBareAmount(readerContext, checked, after, connected || joining)) {
    return null;
  }

  // A percent sign prevents monetary interpretation even after a written currency; parseAmount("12元%") is null.
  if (readerContext.text[expression.end] === '%' || readerContext.text[expression.end] === '％') {
    return null;
  }

  if (!joining) {
    expression = applyAmountModifiers(expression, prefixModifier, suffixModifier?.kind ?? null, core.major);
  }

  return {
    ...core,
    expression,
    checkedEnd: after,
    chainPending: core.chainPending === true || endpointPending
  };
}

/**
 * Trimming is O(n); returned offsets always refer to the untrimmed original UTF-16 string.
 * Trim first, then enforce 40 code points (the frozen fragment-limit decision); offsets still count UTF-16 units.
 * O(input length) trimming does not impose a raw-input cap or change surrogate-pair coordinates.
 */
function trimFragment(input: string): {
  text: string;
  offset: number;
} | null {
  if (typeof input !== 'string') {
    return null;
  }

  let start = 0;
  let end = input.length;

  while (start < end && FRAGMENT_EDGE_CHARACTER.test(input[start]!)) {
    start++;
  }

  // Only the right edge also trims an ASCII dot; leading dots must reach the numeric-neighbor rejection.
  while (end > start && (FRAGMENT_EDGE_CHARACTER.test(input[end - 1]!) || input[end - 1] === '.')) {
    end--;
  }

  if (start === end) {
    return null;
  }

  const text = input.slice(start, end);
  let count = 0;

  for (const character of text) {
    // Frozen fragment grammar: at most 40 code points after trimming, not 40 UTF-16 units.
    if (++count > 40) {
      return null;
    }
  }

  return {
    text,
    offset: start
  };
}

function shiftAmountOffsets(expression: AmountExpression, offset: number): AmountExpression {
  return expression.kind === 'readings' ? {
    ...expression,
    start: expression.start + offset,
    end: expression.end + offset,
    readings: expression.readings.map(reading => ({
      cents: reading.cents,
      end: reading.end + offset
    }))
  } : {
    ...expression,
    start: expression.start + offset,
    end: expression.end + offset
  };
}

function parseAmountWithWork(input: string, options?: Options): WorkResult<AmountExpression | null> {
  const trimmedFragment = trimFragment(input);

  if (!trimmedFragment) {
    return {
      result: null,
      work: typeof input === 'string' ? input.length : 0
    };
  }

  const readerContext = createReaderContext(trimmedFragment.text, options);
  const first = readerContext.fields[0];

  if (!first) {
    return {
      result: null,
      work: readerContext.work
    };
  }

  let startPosition = first.start;

  // A leading 零 can belong to 找零 rather than the following amount; skip it in a longer numeric field.
  // For example, parseAmount("找零五块") returns 500 cents at [2, 4).
  if (readerContext.text[startPosition] === '零' && first.end > startPosition + 1) {
    startPosition++;
  }

  // A word-ending capital directly after an ordinary letter loses the numeral reading; the field is
  // read from its second character instead. parseAmount("人参50元") returns 5000 cents at [2, 5).
  const releasedCapitalStart = startsReleasedCapitalField(readerContext, first.start);

  if (releasedCapitalStart) {
    startPosition = first.start + 1;

    if (readerContext.text[startPosition] === '零' && first.end > startPosition + 1) {
      startPosition++;
    }
  }

  if (readerContext.text[startPosition - 1] === '¥' || readerContext.text[startPosition - 1] === '￥') {
    startPosition--;
  }

  let found = readAmountAt(readerContext, startPosition, false, releasedCapitalStart);

  // A failed first read retries once, from the field's first released Arabic digit.
  // parseAmount("初十200元") returns 20000 cents at [2, 6).
  if (!found) {
    const releasedPosition = releasedArabicStartInField(readerContext, first.start, first.end);

    if (releasedPosition >= 0) {
      found = readAmountAt(readerContext, releasedPosition);
    }
  }

  if (!found) {
    return {
      result: null,
      work: readerContext.work
    };
  }

  const expression = found.expression;
  let consumed = expression.end;

  // A candidate tail can end inside its original field; skip the rest of that same field before finding another number.
  // parseAmount("五块五六本") keeps 500 and 550 cents, skipping the unconsumed 六 in that field.
  if (readerContext.numericFieldEnds[consumed]! > consumed) {
    consumed = readerContext.numericFieldEnds[consumed]!;
  }

  for (let i = consumed; i < readerContext.text.length; i++) {
    readerContext.work++;

    if (isNumberCharacter(readerContext.text[i])) {
      return {
        result: null,
        work: readerContext.work
      };
    }
  }

  return {
    result: shiftAmountOffsets(expression, trimmedFragment.offset),
    work: readerContext.work
  };
}

/**
 * Reads the first numeric field of a trimmed fragment and rejects an unrelated second number.
 * The retained fragment is limited to 40 code points; values are integer hundredths, offsets original UTF-16.
 * Returns null for invalid/unreadable input; preserves all ambiguous readings instead of selecting one.
 * Trimming visits the input in O(n); bounded fragment parsing uses the same configured-unit probes as scanning.
 */
export function parseAmount(fragment: string, options?: Options): AmountExpression | null {
  return parseAmountWithWork(fragment, options).result;
}

/**
 * Makes one full read with a fresh chain cache while sharing immutable lexical and position tables.
 * The two releases affect only their specified left-neighbor checks; null retains the charged work.
 * No cache entry from the ordinary scan or another alternative can influence this read.
 */
function readMarkedAmount(
  readerContext: ReaderContext,
  start: number,
  releasedNumerals: boolean,
  afterClockPoint = false
): AmountCore | null {
  const independentContext = {
    ...readerContext,
    chainedAmounts: new Map<number, AmountCore | null>(),
    work: 0
  };

  const found = readAmountAt(independentContext, start, false, releasedNumerals, false, false, afterClockPoint);
  // Charge the independent parser's visits plus one call to the alternative reader.
  readerContext.work += independentContext.work + 1;

  return found;
}

/**
 * Tests the isolated-zero exception at an exclusive UTF-16 left boundary.
 * Alternative reads charge two boundary probes; ordinary reads retain their existing accounting.
 */
function isIsolatedZero(readerContext: ReaderContext, boundary: number, accountForBoundary = false): boolean {
  if (accountForBoundary) {
    // Count the zero and preceding-character probes; currency probes charge their own work.
    readerContext.work += 2;
  }

  return readerContext.text[boundary - 1] === '零'
    && !isNumberCharacter(readerContext.text[boundary - 2])
    && !isCurrencyAt(readerContext, boundary - 2);
}

/** Holds the ordinary-span indexes and accumulating alternatives for one scan, using UTF-16 positions. */
type MarkedAmountContext = {
  readerContext: ReaderContext;
  ordinary: AmountExpression[];
  covering: Int32Array;
  starting: Int32Array;
  startPrefix: Int32Array;
  candidates: Map<number, AmountExpression>;
  blockedTails: Set<number>;
};

/** Records currency tails that must not become the omitted numeral of a later whitespace alternative. */
function recordMarkedAmountTail(context: MarkedAmountContext, expression: AmountExpression): void {
  const {readerContext, blockedTails} = context;

  // Count one candidate's eligibility for the later numeric-tail exclusion.
  readerContext.work++;

  if (expression.bare) {
    return;
  }

  const word = namedUnitWord(expression);
  const registeredEnding = word !== null
    && matchesWordAt(readerContext, expression.end - word.length, word);

  // A registered unit is an indivisible word, so its final numeral is not an amount's numeric tail.
  if (!registeredEnding) {
    blockedTails.add(expression.end);
  }
}

/** Offers one currency-bearing alternative; returns false for unreadable, bare or duplicate-start results. */
function offerMarkedAmount(
  context: MarkedAmountContext,
  core: AmountCore | null,
  mark: NonNullable<AmountExpression['setAsideLeftNumerals']>
): boolean {
  const {readerContext, candidates} = context;

  // Count one candidate admission check, including unsuccessful reads.
  readerContext.work++;

  if (core === null || core.expression.bare || candidates.has(core.expression.start)) {
    return false;
  }

  const expression = {...core.expression, setAsideLeftNumerals: mark};
  candidates.set(expression.start, expression);

  // Grouped-number and clock alternatives do not establish numeric tails for later whitespace fields.
  if (mark !== 'beforeFullWidthComma' && mark !== 'beforeClockPoint') {
    recordMarkedAmountTail(context, expression);
  }

  return true;
}

/** Offers a whitespace-separated amount without falling back to an in-field omission when excluded. */
function addWhitespaceAmount(
  context: MarkedAmountContext,
  start: number,
  candidateStart: number,
  leftBoundary: number,
  leftCharacter: string | undefined,
  signStart: boolean
): void {
  const {readerContext, covering, blockedTails} = context;
  const text = readerContext.text;

  // A leading sign supplies the currency boundary, so only an isolated zero blocks that form.
  const zeroExcluded = leftCharacter === '零'
    && (!signStart || isIsolatedZero(readerContext, leftBoundary, true));
  const coefficient = text[readerContext.previousNonWhitespaceEnd[leftBoundary - 1]! - 1];

  // A coefficient and place value belong to the preceding number; a sign explicitly separates them.
  const placedLeft = !signStart && '百千万亿佰仟'.includes(leftCharacter ?? '\0')
    && isNumberCharacter(coefficient);

  // The ordinary reader already admits this Arabic start, so an alternative would repeat that reading.
  const alreadyReleased = isArabicDigit(text[candidateStart])
    && releasesArabicAfterChineseDigit(readerContext, candidateStart);

  // Currency tails stay attached to the prior amount; a sign supplies an independent currency start.
  const numericTail = !signStart && blockedTails.has(leftBoundary);

  // A leading place value has no coefficient from which to read an independent amount.
  const placedStart = '百千万亿佰仟'.includes(text[start] ?? '\0');

  // These starts depend on the ordinary scanner's retries, which alternatives deliberately do not perform.
  const unsupportedStart = '零半俩仨'.includes(text[start] ?? '\0');

  // Count six exclusions, the coefficient lookup and the ordinary-span coverage check.
  readerContext.work += 8;

  if (covering[candidateStart] === 0 && !zeroExcluded && !placedLeft && !alreadyReleased
    && !numericTail && !placedStart && !unsupportedStart) {
    offerMarkedAmount(context, readMarkedAmount(readerContext, candidateStart, true), 'acrossWhitespace');
  }
}

/** Offers a directly attached yen-sign amount, using only the sign variant's three exclusions. */
function addYenSignAmount(context: MarkedAmountContext, start: number, candidateStart: number): void {
  const {readerContext, covering} = context;
  const text = readerContext.text;

  // An isolated change marker is already handled by the ordinary reader.
  const isolatedZero = isIsolatedZero(readerContext, candidateStart, true);

  // The independent read cannot supply a missing coefficient for a leading place value.
  const placedStart = '百千万亿佰仟'.includes(text[start] ?? '\0');

  // Alternatives make one full read and cannot use the ordinary scanner's zero/half retries.
  const unsupportedStart = '零半俩仨'.includes(text[start] ?? '\0');

  // Count three exclusions and the ordinary-span coverage check.
  readerContext.work += 4;

  if (covering[candidateStart] === 0 && !isolatedZero && !placedStart && !unsupportedStart) {
    offerMarkedAmount(context, readMarkedAmount(readerContext, candidateStart, true), 'beforeYenSign');
  }
}

/** Offers the shortest successful omission of one or two leading characters within a numeric field. */
function addInFieldAmount(context: MarkedAmountContext, start: number, end: number): void {
  const {readerContext, ordinary, covering, starting, startPrefix} = context;
  const text = readerContext.text;
  const coveringIndex = covering[start]!;
  const coveredInside = coveringIndex > 0 && ordinary[coveringIndex - 1]!.start < start;
  const possibleOmission = end - start > 1 && (SMALL_DIGITS.includes(text[start] ?? '\0')
    || text[start] === '十' || text.slice(start, start + 2) === '万一');

  // Count the coverage lookup, strict-inside check and closed omission-prefix check.
  readerContext.work += 3;

  // Reject impossible prefixes before probing long registered-unit tables.
  if (possibleOmission && !coveredInside && allowsAmountLeftNeighbor(readerContext, start)) {
    const pair = text.slice(start, start + 2);
    const adjacentPair = ADJACENT_DIGIT_PAIRS.has(pair)
      && (pair !== '一两' || '百千万亿'.includes(text[start + 2] ?? '\0'));
    const hasOrdinaryStart = startPrefix[end]! !== startPrefix[start]!;
    const unreadableWhole = !hasOrdinaryStart && readNumberAt(readerContext, start) === null;

    // Count the pair, its place-value proviso, the start-index query and unreadable-whole condition.
    readerContext.work += 4;

    if (unreadableWhole || adjacentPair) {
      // The shorter omission wins; these are two closed grammar choices, never an arbitrary search.
      for (const omittedLength of [1, 2]) {
        const dropped = text.slice(start, start + omittedLength);
        const next = text[start + omittedLength];
        const allowedDrop = omittedLength === 1
          ? SMALL_DIGITS.includes(dropped) || dropped === '十'
          : SMALL_DIGITS.includes(dropped[0] ?? '\0') && SMALL_DIGITS.includes(dropped[1] ?? '\0')
            || dropped[0] === '十' && SMALL_DIGITS.includes(dropped[1] ?? '\0') || dropped === '万一';

        // Count the dropped prefix, remaining length, Arabic start, unsupported start and duplicate start checks.
        readerContext.work += 5;

        // An omission must leave a readable Chinese start and preserve every ordinary candidate's start.
        if (!allowedDrop || end - start <= omittedLength || isArabicDigit(next)
          || '零半俩仨'.includes(next ?? '\0') || starting[start + omittedLength] !== 0) {
          continue;
        }

        const found = readMarkedAmount(readerContext, start + omittedLength, true);

        if (offerMarkedAmount(context, found, omittedLength === 1 ? 'one' : 'two')) {
          break;
        }
      }
    }
  }
}

/** Offers the complete suffix after the first full-width comma inside an already grouped numeric field. */
function addGroupedAmount(context: MarkedAmountContext, start: number, end: number): void {
  const {readerContext, candidates} = context;
  const text = readerContext.text;
  let firstComma = -1;

  // Only a comma inside the cached field represents a complete grouped spelling.
  for (let position = start; position < end; position++) {
    // Count each visited character, including the first comma when one is found.
    readerContext.work++;

    if (text[position] === '，') {
      firstComma = position;
      break;
    }
  }

  if (firstComma >= 0 && !candidates.has(firstComma + 1)) {
    offerMarkedAmount(context, readMarkedAmount(readerContext, firstComma + 1, false), 'beforeFullWidthComma');
  }
}

/** Offers an amount after a time word's numeric hour and point, excluding the two minute-unit spellings. */
function addClockAmount(context: MarkedAmountContext, start: number, end: number): void {
  const {readerContext, candidates} = context;
  const text = readerContext.text;
  const timeWord = text.slice(start - 2, start);

  // Count the preceding-word lookup and membership condition, even when no time word matches.
  readerContext.work += 2;

  // Requiring an adjacent time word distinguishes this interpretation from an arbitrary decimal point.
  if (start >= 2 && (TIME_OF_DAY_WORDS.has(timeWord) || DAY_WORDS.has(timeWord))) {
    let allNumerals = true;

    for (let position = start; position < end; position++) {
      // Count each hour-field character checked against the closed numeral alphabet.
      readerContext.work++;

      if (!NUMERIC_FIELD_CHARACTERS.has(text[position]!)) {
        allNumerals = false;
        break;
      }
    }

    const target = end + 1;

    // Count the clock-point boundary and duplicate-start checks.
    readerContext.work += 2;

    if (allNumerals && text[end] === '点' && !candidates.has(target)) {
      const found = readMarkedAmount(readerContext, target, false, true);
      const unit = found?.expression.unit;
      const minuteUnit = unit?.kind === 'named' && foldForMatch(unit.word) === '分'
        || unit?.kind === 'yuan' && text[found!.number.end] === '分';

      // Count the registered-unit and built-in-unit minute exclusions.
      readerContext.work += 2;

      // Minutes are a common clock spelling; inspect the unit and the first number's own boundary.
      if (!minuteUnit) {
        offerMarkedAmount(context, found, 'beforeClockPoint');
      }
    }
  }
}

/**
 * Adds scan-only alternatives in O(n) character work for a fixed unit list.
 * Position indexes replace per-field list searches; each field makes a bounded number of independent reads.
 * Ordinary objects are retained verbatim. Alternative reads never extend the scan cursor or its unit chain.
 */
function addMarkedAmounts(readerContext: ReaderContext, ordinary: AmountExpression[]): AmountExpression[] {
  const text = readerContext.text;
  const covering = new Int32Array(text.length + 1);
  const starting = new Int32Array(text.length + 1);
  const startPrefix = new Int32Array(text.length + 1);
  const candidates = new Map<number, AmountExpression>();
  const blockedTails = new Set<number>();
  const context: MarkedAmountContext = {
    readerContext,
    ordinary,
    covering,
    starting,
    startPrefix,
    candidates,
    blockedTails
  };

  for (let index = 0; index < ordinary.length; index++) {
    const expression = ordinary[index]!;
    candidates.set(expression.start, expression);
    starting[expression.start] = 1;
    recordMarkedAmountTail(context, expression);

    for (let position = expression.start; position < expression.end; position++) {
      covering[position] = index + 1;

      // Count one ordinary-span position entered into the coverage index.
      readerContext.work++;
    }
  }

  for (let position = 0; position < text.length; position++) {
    startPrefix[position + 1] = startPrefix[position]! + starting[position]!;

    // Count one position in the ordinary-start prefix index.
    readerContext.work++;
  }

  for (const field of readerContext.fields) {
    const start = field.start;
    const end = field.end;
    const signStart = text[start - 1] === '¥' || text[start - 1] === '￥';
    const candidateStart = signStart ? start - 1 : start;
    const leftBoundary = readerContext.previousNonWhitespaceEnd[candidateStart]!;
    const leftCharacter = text[leftBoundary - 1];
    const whitespaceVariant = isInlineWhitespace(text[candidateStart - 1])
      && leftCharacter !== undefined && NUMERIC_FIELD_CHARACTERS.has(leftCharacter)
      && (signStart || !isIsolatedZero(readerContext, leftBoundary, true));

    // Count sign detection, start selection, boundary lookup, left character, whitespace and variant selection.
    readerContext.work += 6;

    if (whitespaceVariant) {
      addWhitespaceAmount(context, start, candidateStart, leftBoundary, leftCharacter, signStart);
    } else if (signStart && NUMERIC_FIELD_CHARACTERS.has(text[candidateStart - 1] ?? '\0')) {
      addYenSignAmount(context, start, candidateStart);
    } else if (!signStart) {
      addInFieldAmount(context, start, end);
    }

    // These interpretations inspect each field independently, after the mutually exclusive first three variants.
    addGroupedAmount(context, start, end);
    addClockAmount(context, start, end);
  }

  const merged: AmountExpression[] = [];

  // A position walk gives source order in linear time even when alternatives overlap ordinary spans.
  for (let position = 0; position < text.length; position++) {
    const expression = candidates.get(position);
    // Count one source position visited to merge ordinary and alternative starts.
    readerContext.work++;

    if (expression !== undefined) {
      merged.push(expression);
    }
  }

  return merged;
}

/** Reads the original nonoverlapping list first, then merges additional readings without moving its cursor. */
function scanAmountsWithWork(input: string, options?: Options): WorkResult<AmountExpression[]> {
  if (typeof input !== 'string') {
    return {
      result: [],
      work: 0
    };
  }

  const readerContext = createReaderContext(input, options);
  const result: AmountExpression[] = [];
  let cursor = 0;

  for (const numericField of readerContext.fields) {
    readerContext.work++;

    if (numericField.start < cursor) {
      continue;
    }

    let startPosition = numericField.start;

    // A word-ending capital directly after an ordinary letter loses the numeral reading; the field
    // is read from its second character instead. scanAmounts("收拾五块") starts the 500-cent reading at 2.
    const releasedCapitalStart = startsReleasedCapitalField(readerContext, numericField.start);

    if (releasedCapitalStart) {
      startPosition = numericField.start + 1;

      if (readerContext.text[startPosition] === '零' && numericField.end > startPosition + 1) {
        startPosition++;
      }
    }

    if (readerContext.text[startPosition - 1] === '¥'
      || readerContext.text[startPosition - 1] === '￥') {
      startPosition--;
    }

    let found = readAmountAt(readerContext, startPosition, false, releasedCapitalStart);

    // Only 零/俩/仨/半 allow one retry inside a failed field;
    // scanAmounts("半十二块") starts the 1200-cent amount at 1.
    if (!found && '零俩仨半'.includes(readerContext.text[numericField.start]!)
      && numericField.end > numericField.start + 1) {
      found = readAmountAt(readerContext, numericField.start + 1);
    }

    // A still-failed field retries once, from its first released Arabic digit.
    // scanAmounts("三十四50元") starts the 5000-cent reading at 3.
    if (!found) {
      const releasedPosition = releasedArabicStartInField(readerContext, numericField.start, numericField.end);

      if (releasedPosition >= 0) {
        found = readAmountAt(readerContext, releasedPosition);
      }
    }

    // Capital numerals need a written unit for amounts; accepting a candidate also advances the nonoverlap cursor.
    if (found && !(!releasedCapitalStart && numericField.capital && found.expression.bare)) {
      result.push(found.expression);
      cursor = found.expression.end;

      // A named readings amount directly followed by a numeric field continues as a chain of further
      // amounts, each carrying a different registered unit; see the chained-read helper for the rule.
      let chainEnd = found.expression.end;
      let chainWord = namedUnitWord(found.expression);

      // A word-ending capital released by a preceding letter is not a chain member; the field loop
      // above reads such a field from its second character instead.
      while (chainWord !== null && isNumberCharacter(readerContext.text[chainEnd])
        && !startsReleasedCapitalField(readerContext, chainEnd)) {
        const continuation = readChainedAmountCore(readerContext, chainEnd);

        if (!continuation) {
          break;
        }

        const continuedWord = namedUnitWord(continuation.expression);

        if (continuedWord === null || continuedWord === chainWord) {
          break;
        }

        result.push(continuation.expression);
        chainEnd = continuation.expression.end;
        chainWord = continuedWord;
        cursor = continuation.expression.end;
      }
    }
  }

  return {
    result: addMarkedAmounts(readerContext, result),
    work: readerContext.work
  };
}

/**
 * Lists amount candidates with strictly increasing starts in original UTF-16 coordinates.
 * Unmarked spans remain nonoverlapping; marked, written-unit alternatives may overlap any span.
 * Values are integer hundredths of the written unit; scans have no text/Arabic-number length cap.
 * Invalid input or no readable candidates returns []; a read does not establish a transaction.
 * O(n) character work for a fixed unit list; bigint arithmetic cost depends on the size of the numeric value.
 * Character work also grows with the number of registered units.
 */
export function scanAmounts(text: string, options?: Options): AmountExpression[] {
  return scanAmountsWithWork(text, options).result;
}

/**
 * Fractions are reported before range/modifier conversion so they are never rounded to an integer count.
 * Up to two intervening UTF-16 units before half or a suffix are fixed by the classifier/fraction boundary cases.
 * A dozen is 12 items; internal counts use 100 hundredths and final counts are bounded by MAX_SAFE_INTEGER.
 * Character work is O(field length); gap trials and classifier lookahead have fixed grammar bounds.
 */
function readQuantityAt(readerContext: ReaderContext, startPosition: number): {
  expression: QuantityExpression;
  after: number;
} | null {
  const text = readerContext.text;

  if (matchesWordAt(readerContext, startPosition, '一些')
    || matchesWordAt(readerContext, startPosition, '一点')
    || matchesWordAt(readerContext, startPosition, '若干')) {
    return {
      expression: {
        start: startPosition,
        end: startPosition + 2,
        kind: 'range',
        min: null,
        max: null,
        approx: true
      },
      after: startPosition + 2
    };
  }

  // Half a normal item is unsupported, but half a dozen can become an integer count.
  // parseQuantity("半瓶") is unsupported; parseQuantity("半打") is exactly 6 items.
  if (text[startPosition] === '半' && text[startPosition + 1] !== '打') {
    return {
      expression: {
        start: startPosition,
        end: startPosition + 1,
        kind: 'unsupported',
        reason: 'fraction'
      },
      after: startPosition + 1
    };
  }

  let parsedNumber = readNumberAt(readerContext, startPosition, true);

  if (text[startPosition] === '俩' || text[startPosition] === '仨'
    || text[startPosition] === '半' && text[startPosition + 1] === '打') {
    const count = text[startPosition] === '俩' ? 200n : text[startPosition] === '仨' ? 300n : 50n;
    parsedNumber = {
      end: startPosition + 1,
      raw: text[startPosition]!,
      value: count,
      minimumHundredths: null,
      maximumHundredths: null,
      range: false,
      capital: false,
      decimal: false,
      omitted: false,
      upwardMagnitude: false
    };
  }

  if (!parsedNumber) {
    return null;
  }

  // Report fractions before range/modifier conversion; an approximate prefix must not round them to an integer.
  if (parsedNumber.decimal) {
    return {
      expression: {
        start: startPosition,
        end: parsedNumber.end,
        kind: 'unsupported',
        reason: 'fraction'
      },
      after: parsedNumber.end
    };
  }

  let end = parsedNumber.end;

  // Fraction/classifier cases permit one or two intervening UTF-16 units, never a third.
  // 元/圆/块/角/毛 cannot be intervening classifiers before 半,
  // keeping monetary tails out of a quantity fraction.
  // scanQuantities("两元个半") starts with the exact count 2 at [0, 1), not one combined fraction.
  for (let gap = 1; gap <= 2; gap++) {
    const between = text.slice(end, end + gap);
    readerContext.work += gap;

    if (between.length === gap
      && [...between].every(
        character => !isNumberCharacter(character) && !isInlineWhitespace(character)
          && !CLAUSE_END_CHARACTER.test(character)
          && !'元圆块角毛'.includes(character)
      )
      && text[end + gap] === '半') {
      return {
        expression: {
          start: startPosition,
          end: end + gap + 1,
          kind: 'unsupported',
          reason: 'fraction'
        },
        after: end + gap + 1
      };
    }
  }

  let range = parsedNumber.range;
  let minimumHundredths = parsedNumber.minimumHundredths;
  let maximumHundredths = parsedNumber.maximumHundredths;
  let value = parsedNumber.value;

  // The quantity path uses whole-item uncertainty; it does not accept the amount-only comma-pair connection.
  if (QUANTITY_CONNECTORS.has(text[end]!) && NUMERIC_FIELD_CHARACTERS.has(text[end + 1]!)) {
    const secondNumber = readNumberAt(readerContext, end + 1, true);

    if (secondNumber && !secondNumber.decimal) {
      [
        minimumHundredths,
        maximumHundredths
      ] = connectNumberRange(parsedNumber, secondNumber, value, secondNumber.value, true, false, 100n);
      range = true;
      value = null;
      end = secondNumber.end;
    }
  }

  // Convert every bound of a dozen range, not just an exact count; parseQuantity("两三打") spans 24..36 items.
  if (text[end] === '打') {
    end++;

    if (range) {
      minimumHundredths = minimumHundredths === null ? null : minimumHundredths * 12n;
      maximumHundredths = maximumHundredths === null ? null : maximumHundredths * 12n;
    } else {
      value = value! * 12n;
    }
  }

  // Check safe integer item values before Number conversion, so precision loss cannot manufacture a count.
  // For example, parseQuantity("9007199254740992个") is null.
  if (!range
    && (value! <= 0n || value! % 100n !== 0n || (value!) / 100n > BigInt(Number.MAX_SAFE_INTEGER))) {
    return null;
  }

  if (range && [
    minimumHundredths,
    maximumHundredths
  ].some(value => value !== null
    && (value < 0n || value % 100n !== 0n || value / 100n > BigInt(Number.MAX_SAFE_INTEGER)))) {
    return null;
  }

  let amountExpression: AmountExpression = range ? {
    start: startPosition,
    end,
    unit: null,
    bare: true,
    kind: 'range',
    min: minimumHundredths,
    max: maximumHundredths,
    approx: true
  } : buildAmountReadings(startPosition, null, [{
    cents: value!,
    end
  }]);
  let suffixModifier: {
    kind: ApproximationModifier;
    end: number;
  } | null = null;

  // Quantity modifiers cross at most two nonnumeric, nonspace, non-clause UTF-16 units; 有找 is amount-only.
  // parseQuantity("三本书左右") spans 3..3 items; "三本书籍左右" and "三本有找" stay exact.
  for (let gap = 0; gap <= 2; gap++) {
    const between = text.slice(end, end + gap);

    if (gap
      && (between.length !== gap
        || [...between].some(
          character => isNumberCharacter(character) || isInlineWhitespace(character)
            || CLAUSE_END_CHARACTER.test(character)
        ))) {
      break;
    }

    suffixModifier = matchesWordAt(readerContext, end + gap, '有找')
      ? null
      : readSuffixModifier(readerContext, end + gap, false);

    if (suffixModifier) {
      break;
    }
  }

  amountExpression = applyAmountModifiers(
    amountExpression,
    readPrefixModifier(readerContext, startPosition),
    suffixModifier?.kind ?? null,
    false,
    100n
  );
  const expression: QuantityExpression = amountExpression.kind === 'range' ? {
    start: startPosition,
    end,
    kind: 'range',
    min: amountExpression.min === null ? null : Number(amountExpression.min / 100n),
    max: amountExpression.max === null ? null : Number(amountExpression.max / 100n),
    approx: true
  } : {
    start: startPosition,
    end,
    kind: 'exact',
    count: Number(amountExpression.readings[0]!.cents / 100n)
  };

  return {
    expression,
    after: suffixModifier?.end ?? end
  };
}

function parseQuantityWithWork(input: string): WorkResult<QuantityExpression | null> {
  const trimmedFragment = trimFragment(input);

  if (!trimmedFragment) {
    return {
      result: null,
      work: typeof input === 'string' ? input.length : 0
    };
  }

  const readerContext = createReaderContext(trimmedFragment.text);
  let startPosition = 0;

  for (const [word] of PREFIXES) {
    if (matchesWordAt(readerContext, 0, word)) {
      startPosition = readerContext.nextNonWhitespace[word.length]!;

      break;
    }
  }

  // 好/数/上 may precede a place-value character; only 好 may precede 几.
  // parseQuantity("好几个") has null bounds; "数百个" spans 200..900 items and "上千个" has lower bound 1000.
  if ('好数上'.includes(readerContext.text[startPosition] ?? '\0')
    && (readerContext.text[startPosition] === '好' && readerContext.text[startPosition + 1] === '几'
      || PLACE_VALUES[readerContext.text[startPosition + 1]!])) {
    startPosition++;
  }

  const found = readQuantityAt(readerContext, startPosition);

  if (!found) {
    return {
      result: null,
      work: readerContext.work
    };
  }

  // After consuming a classifier/modifier, another numeric field invalidates a single-fragment result.
  for (let i = found.after; i < readerContext.text.length; i++) {
    readerContext.work++;

    if (isNumberCharacter(readerContext.text[i])) {
      return {
        result: null,
        work: readerContext.work
      };
    }
  }

  return {
    result: {
      ...found.expression,
      start: found.expression.start + trimmedFragment.offset,
      end: found.expression.end + trimmedFragment.offset
    },
    work: readerContext.work
  };
}

/**
 * Reads a quantity at the trimmed beginning, excluding classifiers from the original UTF-16 span.
 * The fragment limit is 40 code points; counts are safe integer items, while fractions are unsupported.
 * Returns null for invalid/unreadable input or a second unrelated number. Trimming is O(n).
 */
export function parseQuantity(fragment: string): QuantityExpression | null {
  return parseQuantityWithWork(fragment).result;
}

/**
 * The cached leftmost amount is reused across a contiguous currency chain even when the amount parse failed.
 * Indefinite starts are merged with numeric starts without sorting; total character/probe work is O(input length).
 */
function scanQuantitiesWithWork(input: string): WorkResult<QuantityExpression[]> {
  if (typeof input !== 'string') {
    return {
      result: [],
      work: 0
    };
  }

  const readerContext = createReaderContext(input);
  const result: QuantityExpression[] = [];
  const candidates = [...readerContext.fields];

  // 若干 has no numeric field, so add its start to the same ordered traversal;
  // scanQuantities("若干本") returns one range with null bounds.
  for (let i = 0; i < readerContext.text.length; i++) {
    readerContext.work++;

    if (matchesWordAt(readerContext, i, '若干')) {
      candidates.push({
        start: i,
        end: i + 2,
        capital: false
      });
    }
  }

  // Merge already ordered lexical fields with the few nonnumeric indefinite starts in O(n).
  const fieldsByStart = new Map(candidates.map(numericField => [
    numericField.start,
    numericField
  ]));
  let cursor = 0;
  let previousAmountStart = -1;
  let previousField: NumericField | undefined;
  let previousAmount: AmountCore | null = null;

  for (let i = 0; i < readerContext.text.length; i++) {
    readerContext.work++;
    const numericField = fieldsByStart.get(i);

    if (!numericField) {
      continue;
    }

    let startPosition = numericField.start;
    let tailStart = false;

    if (previousField) {
      const position = readerContext.nextNonWhitespace[previousField.end]!;

      // 元/圆/块/角/毛 link a contiguous currency chain so later tails share the leftmost amount parse.
      // scanQuantities("十二块零五毛三。") returns only the exact count 12 at [0, 2).
      const currency = '元圆块角毛'.includes(readerContext.text[position] ?? '\0')
        && position + 1 === numericField.start;

      if (currency) {
        // Include every chain/cache visit in the linear-work diagnostic.
        readerContext.work++;
        const amountStart = previousAmountStart < 0 ? previousField.start : previousAmountStart;

        // O(n): parse the leftmost amount once per chain, even when that parse fails.
        if (previousAmountStart < 0) {
          const symbolStart = readerContext.text[amountStart - 1] === '¥'
            || readerContext.text[amountStart - 1] === '￥'
            ? amountStart - 1
            : amountStart;
          previousAmount = readAmountCore(readerContext, symbolStart);
          previousAmountStart = amountStart;
        }

        const amount = previousAmount;

        // Resume after the earliest monetary alternative.
        // Preserve a quantity only when some reading leaves it available.
        if (amount?.expression.kind === 'readings') {
          startPosition = Math.max(
            startPosition,
            Math.min(...amount.expression.readings.map(reading => reading.end))
          );
          tailStart = startPosition < numericField.end;
        }
      } else {
        previousAmountStart = -1;
      }
    }

    previousField = numericField;

    if (numericField.start < cursor || startPosition >= numericField.end) {
      continue;
    }

    const position = readerContext.previousNonWhitespaceEnd[startPosition]!;
    const previousCharacter = readerContext.text[position - 1];

    // Ordinal, distributive and signed prefixes block standalone counts; scanQuantities("各两瓶") returns [].
    if (!tailStart && previousCharacter
      && (NUMERIC_FIELD_CHARACTERS.has(previousCharacter) || previousCharacter === '第'
        || previousCharacter === '各'
        || REJECTED_LEFT_SIGNS.has(previousCharacter))) {
      continue;
    }

    // Dots, comma and 点 keep continuations in the preceding numeric spelling, except at an already resolved tail.
    if (!tailStart && previousCharacter && '.．,点'.includes(previousCharacter)
      && isNumberCharacter(readerContext.text[position - 2])) {
      continue;
    }

    const found = readQuantityAt(readerContext, startPosition);

    if (found) {
      result.push(found.expression);
      cursor = found.expression.end;
    }
  }

  return {
    result,
    work: readerContext.work
  };
}

/**
 * Lists quantity candidates in source order, including dates and ordinary nouns; callers choose relevance.
 * No input length cap; half-open spans use original UTF-16 offsets, counts safe integer items.
 * Returns [] for invalid input or no candidates, and explicit unsupported entries for fractions.
 * O(n) character work: currency chains reuse the leftmost amount parse, including a failed parse.
 */
export function scanQuantities(text: string): QuantityExpression[] {
  return scanQuantitiesWithWork(text).result;
}

/**
 * True when character is one Chinese digit of a rate body, namely 零 or a digit from 一 to 九.
 * character is one character of the folded text; the answer is a boolean and no character is visited.
 * 两, 十, the place values and the capital numerals answer false, so they never join a 点 rate body.
 */
function isChineseRateDigit(character: string | undefined): boolean {
  return character !== undefined && (character === '零' || SMALL_DIGITS.includes(character));
}

/**
 * Reads one digit of a rate body and returns its value from 0 to 9, or null when the character is not
 * a digit of either rate script. character is one character of the folded text; 零 and 0 count zero,
 * and 一 to 九 and 1 to 9 count one to nine. Every other character gives null, so 两, 十 and the
 * capital numerals never supply a 点 rate digit.
 */
function readRateDigit(character: string | undefined): bigint | null {
  if (character === '零' || character === '0') {
    return 0n;
  }

  return readSmallDigit(character);
}

/**
 * True when two rate digits are written in the same script: both Arabic, or both Chinese from 零 to 九.
 * first and second are two characters of the folded text; the answer is a boolean and no character is
 * visited. A mixed spelling such as 九点5折 answers false.
 */
function sameRateScript(first: string | undefined, second: string | undefined): boolean {
  return isArabicDigit(first) && isArabicDigit(second)
    || isChineseRateDigit(first) && isChineseRateDigit(second);
}

/**
 * True when a closed period word, or an allowed day word, stands directly before position with nothing in
 * between, not even an inline blank. position is a UTF-16 index into the folded text; the answer is a
 * boolean and at most two characters are visited and charged to work. includeDayWords is true only for rates.
 * A word held away by a blank and
 * every other text before position answer false, so 下午 三点五折 is no clock time.
 */
function followsTimeOfDayWord(readerContext: ReaderContext, position: number, includeDayWords = false): boolean {
  readerContext.work += 2;

  if (position < 2) {
    return false;
  }

  const word = readerContext.text.slice(position - 2, position);

  return TIME_OF_DAY_WORDS.has(word) || includeDayWords && DAY_WORDS.has(word);
}

// The closed range spelling distinguishes two adjacent clock hours from an ordinary decimal rate.
const CLOCK_RANGE_CONNECTORS = new Set(['到', '至', '-', '－', '−', '~', '～', '—']);

/**
 * Reads the two digits of a rate body joined by 点, such as the 九点五 of 九点五折, and returns the
 * start of the body and its numerator in percentage points, or null when the text at 折 is not that
 * shape. foldPosition is the position of 折 in the folded text and fieldIndex is the index in
 * readerContext.fields of the field ending there; the shape needs that field to be exactly one digit
 * directly before 折, a 点 directly before it, and a field of exactly one digit directly before the
 * 点, both digits in the same script. The digit before 点 counts tens of percentage points, so
 * 九点五折 is 95/100. A time-of-day word directly before the first digit makes 点 a clock hour, where
 * only the digit after 点 is the rate, so the answer is null there. The same holds when the first digit
 * is exactly one in either script, preserving that colloquial reading. A preceding hour followed by 点
 * and a range connector also makes the first digit a clock hour. Three cached fields and their adjacent
 * characters are inspected in O(1) work; the returned start is a folded UTF-16 position.
 */
function readPointRate(readerContext: ReaderContext, fieldIndex: number, foldPosition: number): {
  start: number;
  numerator: bigint;
} | null {
  const text = readerContext.text;
  const secondField = readerContext.fields[fieldIndex];
  readerContext.work += 8;

  // The body field is exactly the one digit directly before 折, with 点 directly before that digit.
  if (!secondField || secondField.end !== foldPosition || secondField.start !== foldPosition - 1
    || text[foldPosition - 2] !== '点') {
    return null;
  }

  const firstField = readerContext.fields[fieldIndex - 1];

  // The field directly before 点 is exactly one digit; 十二点五折 and 一百点五折 answer null here.
  if (!firstField || firstField.end !== foldPosition - 2 || firstField.end - firstField.start !== 1) {
    return null;
  }

  // Both digits must be digits of one script; 九点5折 and 9点五折 keep the ordinary body reading,
  // which is the value of the digit after 点 alone. The check also guarantees both values below.
  if (!sameRateScript(text[firstField.start], text[secondField.start])) {
    return null;
  }

  const firstDigit = readRateDigit(text[firstField.start])!;
  const secondDigit = readRateDigit(text[secondField.start])!;
  const precedingHour = readerContext.fields[fieldIndex - 2];
  const followsHourRange = precedingHour !== undefined
    && precedingHour.end === firstField.start - 2
    && text[precedingHour.end] === '点'
    && CLOCK_RANGE_CONNECTORS.has(text[firstField.start - 1]!);

  // A written hour range needs no time word; 三点到五点五折 keeps only the trailing 五折.
  if (firstDigit === 1n || followsTimeOfDayWord(readerContext, firstField.start, true) || followsHourRange) {
    return null;
  }

  // The numerator is in percentage points, so the digit before 点 counts tens and the digit after it units.
  return {
    start: firstField.start,
    numerator: firstDigit * 10n + secondDigit
  };
}

/**
 * A rate body is the numeric field touching 折, or two single digits joined by 点; the field pointer
 * advances monotonically.
 * One digit denotes tenths, two digits percentage points, and half price is 50/100 (frozen rate cases).
 * O(input length) character work: each numeric field and the output span are consumed in source order.
 */
function scanRatesWithWork(input: string): WorkResult<RateExpression[]> {
  if (typeof input !== 'string') {
    return {
      result: [],
      work: 0
    };
  }

  const readerContext = createReaderContext(input);
  const text = readerContext.text;
  const result: RateExpression[] = [];
  let field = 0;

  for (let i = 0; i < text.length; i++) {
    readerContext.work++;
    let start = i;
    let end = i + 2;
    let minimumPercent: bigint | null = null;
    let maximumPercent: bigint | null = null;
    let numerator: bigint | null = null;
    let range = false;

    // Fixed half-price words cannot restart after another numeral or 半; parseDiscountRate("三对折") is null.
    if (matchesWordAt(readerContext, i, '对折') || matchesWordAt(readerContext, i, '半价')) {
      if (NUMERIC_FIELD_CHARACTERS.has(text[i - 1]!) || text[i - 1] === '半') {
        continue;
      }

      numerator = 50n;
    } else if (text[i] === '折') {
      while (field < readerContext.fields.length && readerContext.fields[field]!.end < i) {
        field++;
        readerContext.work++;
      }

      const numericField = readerContext.fields[field];

      // The whole field must touch 折; reading only its final digit would admit malformed rate bodies.
      if (!numericField || numericField.end !== i) {
        continue;
      }

      start = numericField.start;
      end = i + 1;
      const body = text.slice(start, i);
      readerContext.work += body.length;

      // A body joined by 点 carries both of its digits: 九点五折 is 95/100, read from the field before 点.
      const pointRate = readPointRate(readerContext, field, i);

      if (pointRate) {
        start = pointRate.start;
        numerator = pointRate.numerator;
      } else if (body.length === 1 && readSmallDigit(body) !== null) {
        numerator = readSmallDigit(body)! * 10n;
      } else if (DECIMAL_RATE_PATTERN.test(body)) {
        numerator = BigInt(body[0]!) * 10n + BigInt(body[2]!);
      } else if (TWO_DIGIT_RATE_PATTERN.test(body)) {
        // Both Arabic rate digits must be nonzero; parseDiscountRate("80折") is null rather than a 80/100 rate.
        numerator = BigInt(body);
      } else if (body.length === 2 && [...body].every(character => SMALL_DIGITS.includes(character))) {
        // A closed adjacent Chinese pair denotes tenths bounds; other two-digit spellings denote percentage points.
        // parseDiscountRate("七八折") spans 70..80/100, while "七五折" is exactly 75/100.
        if (ADJACENT_DIGIT_PAIRS.has(body)) {
          range = true;
          minimumPercent = readSmallDigit(body[0])! * 10n;
          maximumPercent = readSmallDigit(body[1])! * 10n;
        } else {
          numerator = readSmallDigit(body[0])! * 10n + readSmallDigit(body[1])!;
        }
      } else {
        continue;
      }
    } else {
      continue;
    }

    // A 第 directly before the body makes the body the ordinal number itself, so 第八折, 第三四折 and
    // 第二八折 stay unreadable. An ordinal earlier in the clause does not hide a rate: 第二件八折 lists 八折.
    if (text[start - 1] === '第' && text[start] !== '半' && isNumberCharacter(text[start])) {
      continue;
    }

    // A prefix may sit before 打; parseDiscountRate("大概打八折") is an 80..80/100 estimate.
    const prefixModifier = readPrefixModifier(readerContext, start)
      ?? (text[start - 1] === '打' ? readPrefixModifier(readerContext, start - 1) : null);
    const foundPost = readSuffixModifier(readerContext, end)?.kind ?? null;

    // Rate suffixes do not reuse monetary 多/出头 uncertainty; "八折出头" stays exact 80/100.
    // An upper/lower modifier such as "至少八折" instead gives null bounds through parseDiscountRate.
    const suffixModifier = foundPost === 'more' || foundPost === 'head' ? null : foundPost;

    if (prefixModifier || suffixModifier) {
      if (prefixModifier && prefixModifier !== 'point'
        || suffixModifier && suffixModifier !== 'point') {
        range = true;
        minimumPercent = null;
        maximumPercent = null;
      } else if (!range) {
        range = true;
        minimumPercent = numerator;
        maximumPercent = numerator;
      }
    }

    result.push(range ? {
      start,
      end,
      kind: 'range',
      min: minimumPercent,
      max: maximumPercent,
      denominator: 100n,
      approx: true
    } : {
      start,
      end,
      kind: 'exact',
      numerator: numerator!,
      denominator: 100n
    });
    i = end - 1;
  }

  return {
    result,
    work: readerContext.work
  };
}

/**
 * Lists whole discount bodies; only a 第 directly before a body hides it, as that body is the ordinal number.
 * No input length cap; half-open spans use original UTF-16 offsets and values are percentage points over 100.
 * Invalid input or no readable bodies returns []. Character/probe work is O(n).
 */
export function scanRates(text: string): RateExpression[] {
  return scanRatesWithWork(text).result;
}

function parseRateWithWork(input: string): WorkResult<RateExpression | null> {
  const trimmedFragment = trimFragment(input);

  if (!trimmedFragment) {
    return {
      result: null,
      work: typeof input === 'string' ? input.length : 0
    };
  }

  const work = scanRatesWithWork(trimmedFragment.text);

  if (work.result.length !== 1) {
    return {
      result: null,
      work: work.work
    };
  }

  const expression = work.result[0]!;
  const text = foldForMatch(trimmedFragment.text).replaceAll('〇', '零').replaceAll('○', '零');

  // A fragment must contain exactly one rate and no numeric spelling outside it; scanning alone can return several.
  for (let i = 0; i < text.length; i++) {
    work.work++;

    if ((i < expression.start || i >= expression.end) && isNumberCharacter(text[i])) {
      return {
        result: null,
        work: work.work
      };
    }
  }

  return {
    result: {
      ...expression,
      start: expression.start + trimmedFragment.offset,
      end: expression.end + trimmedFragment.offset
    },
    work: work.work
  };
}

/**
 * Reads exactly one complete discount rate in a trimmed fragment of at most 40 code points.
 * Offsets remain original UTF-16; values are percentage points over denominator 100, without reduction.
 * Returns null for invalid input, absent/multiple rates or another numeric field. Trimming is O(n).
 */
export function parseDiscountRate(fragment: string): RateExpression | null {
  return parseRateWithWork(fragment).result;
}

function scanNumbersWithWork(input: string): WorkResult<{
  start: number;
  end: number;
}[]> {
  if (typeof input !== 'string') {
    return {
      result: [],
      work: 0
    };
  }

  const readerContext = createReaderContext(input);
  const text = readerContext.text;
  const result: {
    start: number;
    end: number;
  }[] = [];

  for (let i = 0; i < text.length; i++) {
    readerContext.work++;

    // This lexical scan intentionally excludes capital numerals; scanNumbers("壹佰三") returns only [2, 3).
    if (!PLAIN_NUMBER_CHARACTERS.has(text[i]!)) {
      continue;
    }

    const start = i;
    const groupedNumberEnd = fullWidthGroupedNumberEnd(text, i, readerContext);

    // Punctuation connects only adjacent Arabic digits, and a complete fullwidth-comma grouped number
    // stays in one span; this is a lexical span, not numeric validation.
    // scanNumbers("12.3,4") returns [0, 6) even though that spelling is not an exact number.
    while (i < text.length
      && (PLAIN_NUMBER_CHARACTERS.has(text[i]!)
        || (text[i] === '.' || text[i] === ',') && isArabicDigit(text[i - 1])
        && isArabicDigit(text[i + 1])
        || i < groupedNumberEnd)) {
      i++;
      readerContext.work++;
    }

    result.push({
      start,
      end: i
    });
    i--;
  }

  return {
    result,
    work: readerContext.work
  };
}

/**
 * Lists lexical numeric fields, including unsupported spellings but excluding capital numerals.
 * No input length cap; results contain only half-open original UTF-16 spans, not numeric values.
 * Invalid input or no fields returns []. Each field is visited in O(n) total character/probe work.
 */
export function scanNumbers(text: string): {
  start: number;
  end: number;
}[] {
  return scanNumbersWithWork(text).result;
}

/** O(expressions.length), preserves references/order; empty or merely touching spans do not overlap. */
function overlappingWithWork<Result extends {
  start: number;
  end: number;
}>(expressions: readonly Result[], start: number, end: number): WorkResult<Result[]> {
  const result: Result[] = [];
  let work = 0;

  // Reject invalid or empty query bounds before touching caller objects; negative starts still allow intersection.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) {
    return {
      result,
      work
    };
  }

  try {
    if (!Array.isArray(expressions)) {
      return {
        result,
        work
      };
    }

    const length = expressions.length;

    for (let i = 0; i < length; i++) {
      work++;

      try {
        const expression = expressions[i]!;
        const expressionStart = expression.start;
        const expressionEnd = expression.end;

        // Both spans must be nonempty and strictly intersect; touching at one endpoint is not overlap.
        if (Number.isSafeInteger(expressionStart) && Number.isSafeInteger(expressionEnd)
          && expressionStart >= 0
          && expressionStart < expressionEnd
          && expressionStart < end
          && start < expressionEnd) {
          result.push(expression);
        }
      } catch {
        // One inaccessible item cannot hide accessible expressions.
      }
    }
  } catch {
    return {
      result: [],
      work
    };
  }

  return {
    result,
    work
  };
}

/**
 * Filters expression references in their original order by strict intersection with [start, end).
 * Bounds are safe-integer UTF-16 offsets; negative query starts are allowed, empty/touching spans do not overlap.
 * Invalid bounds/arrays return []; inaccessible items are skipped, inaccessible arrays discard partial output.
 * O(expressions.length) probes with no list length cap; returned objects keep their original identities.
 */
export function overlapping<Result extends {
  start: number;
  end: number;
}>(expressions: readonly Result[], start: number, end: number): Result[] {
  return overlappingWithWork(expressions, start, end).result;
}

/**
 * Frozen diagnostic entry points for all eight public functions, preserving their arguments and result shapes.
 * Each call also returns deterministic character/probe work, not elapsed time, including failure/empty results.
 * Counters are local to the call; this object adds no parser rule and has no persistent state.
 */
export const amountExpressionWork = Object.freeze({
  parseAmount: parseAmountWithWork,
  parseQuantity: parseQuantityWithWork,
  parseDiscountRate: parseRateWithWork,
  scanAmounts: scanAmountsWithWork,
  scanQuantities: scanQuantitiesWithWork,
  scanRates: scanRatesWithWork,
  scanNumbers: scanNumbersWithWork,
  overlapping: overlappingWithWork
});
