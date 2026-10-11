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
 */
export type AmountExpression = {
  start: number;
  end: number;
  unit: AmountUnit;
  bare: boolean;
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

const CHINESE_CENTS_TAIL_PATTERN = /^[一二三四五六七八九]十[一二三四五六七八九]?$/;

const DECIMAL_RATE_PATTERN = /^[0-9]\.[0-9]$/;

const TWO_DIGIT_RATE_PATTERN = /^[1-9]{2}$/;

const REJECTED_LEFT_SIGNS = new Set(['+', '-', '＋', '－', '−', '负', '$', '＄']);

const AMOUNT_CONNECTORS = new Set('到至-~～—、');

const QUANTITY_CONNECTORS = new Set('到至-~～');

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
  ordinal: Uint8Array;
  units: readonly string[];
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
 * O(n): folding, numeric fields, inline-whitespace jumps and clause flags each make a bounded pass.
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
  const ordinal = new Uint8Array(textLength + 1);

  // Existing diagnostic baseline; source not recorded for the multiplier 4.
  let work = textLength * 4;
  let clauseOrdinal = false;

  for (let i = 0; i < textLength; i++) {
    if (CLAUSE_END_CHARACTER.test(text[i]!) || text[i] === '.' && !isArabicDigit(text[i + 1])) {
      clauseOrdinal = false;
    }

    // An ordinal suppresses rates throughout its clause, rather than only at the first numeric field.
    // For example, scanRates("第2件8折，甲9折。") keeps only the 90/100 rate after the comma.
    if (text[i] === '第' && NUMERIC_FIELD_CHARACTERS.has(text[i + 1]!)) {
      clauseOrdinal = true;
    }

    ordinal[i] = clauseOrdinal ? 1 : 0;
    previousNonWhitespaceEnd[i + 1] = isInlineWhitespace(text[i]) ? previousNonWhitespaceEnd[i]! : i + 1;

    if (!isNumberCharacter(text[i])) {
      continue;
    }

    const start = i;
    let capital = false;

    // Punctuation belongs to a numeric field only between Arabic digits; other punctuation separates fields.
    while (i < textLength
      && (isNumberCharacter(text[i])
        || (text[i] === '.' || text[i] === ',') && isArabicDigit(text[i - 1])
        && isArabicDigit(text[i + 1]))) {
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

    // The skipped positions still need whitespace and ordinal metadata.
    for (let j = start + 1; j < i; j++) {
      previousNonWhitespaceEnd[j + 1] = j + 1;
      ordinal[j] = clauseOrdinal ? 1 : 0;
      work++;
    }

    i--;
  }

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
    ordinal,
    units,
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
 * Recursion has a fixed number of section levels; character work is O(spelling.length) within the syntax bound.
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
 * 100 hundredths per unit and padding to two digits preserve exact cents; text processing is O(spelling.length).
 */
function readArabicCents(spelling: string): bigint | null {
  if (!ARABIC_NUMBER_PATTERN.test(spelling)) {
    return null;
  }

  const [whole, fraction = ''] = spelling.replaceAll(',', '').split('.');

  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
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
    let position = 0;

    while (position < spelling.length
      && (isArabicDigit(spelling[position]) || spelling[position] === '.'
        || spelling[position] === ',')) {
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

    return {
      value: total,
      capital: false,
      decimal: false,
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

  if (!exactNumber) {
    return null;
  }

  // Approximation suffixes require a positive whole, ordinary-style value.
  // Fractions and mixed coefficients cannot widen.
  if (suffixModifier) {
    if (exactNumber.value <= 0n || exactNumber.value % 100n !== 0n || exactNumber.capital
      || exactNumber.decimal
      || isArabicDigit(raw[0]) && [...raw].some(character => PLACE_VALUES[character])
      || !isArabicDigit(raw[0]) && !readChineseInteger(raw) && !MISSING_COEFFICIENT.has(raw)) {
      return null;
    }

    return {
      ...base,
      range: true,
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
 * Yuan tails have at most two currency levels; all alternatives keep their own endpoints.
 * Written currency levels resolve before implicit tails; ordinary-word endings retain competing readings.
 * The grammar fixes yuan/jiao/fen levels at 100/10/1 hundredths and half a next level at five tenths.
 * At most two subunit levels are followed; O(tail field length) work, with no extra full-text pass.
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
 * O(field length) prefix validity avoids reparsing growing invalid prefixes for numeric unit words.
 * Grouping uses three integer digits per comma group and at most two fraction digits (decimal grammar).
 */
function classifyArabicPrefixes(readerContext: ReaderContext, startPosition: number, end: number): {
  valid: Uint8Array;
  numericEnd: number;
} {
  const valid = new Uint8Array(end - startPosition + 1);
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

    valid[position + 1 - startPosition] = !invalid
      && (decimal ? fraction >= 1 && fraction <= 2 : group > 0 && (!hasComma || group === 3))
      ? 1
      : 0;
  }

  return {
    valid,
    numericEnd: position
  };
}

/**
 * Named units may begin inside numeric fields; the earliest viable split wins before ordinary currency resolution.
 * The extra 10 positions after an Arabic prefix and 40-position other split limit have no recorded derivation.
 * 50 hundredths for half yuan, and 100/10/1 currency levels, are fixed by the half/subunit grammar cases.
 * Character work is O(field length) for a fixed unit list; candidate tail order and counted probes stay intact.
 */
function readAmountCore(readerContext: ReaderContext, start: number): AmountCore | null {
  const text = readerContext.text;
  const symbol = text[start] === '¥' || text[start] === '￥';
  const startPosition = start + (symbol ? 1 : 0);
  let parsedNumber = readNumberAt(readerContext, startPosition);
  let unit: AmountUnit = null;
  let unitEnd = 0;
  const fieldEnd = readerContext.numericFieldEnds[startPosition]!;

  // Numeric named-unit words can begin inside the field; classify prefixes once to avoid reparsing every bad split.
  const prefixes = readerContext.units.length && isArabicDigit(text[startPosition])
    ? classifyArabicPrefixes(readerContext, startPosition, fieldEnd)
    : null;

  // Keep both existing trial bounds (10 extra positions or 40 from the start); source not recorded.
  const splitEnd = prefixes ? Math.min(fieldEnd, prefixes.numericEnd + 10) : Math.min(fieldEnd, startPosition + 40);

  // Configured units can start inside a numeric field; Chinese syntax keeps these split trials bounded.
  for (let position = startPosition + 1; position <= splitEnd; position++) {
    if (!readerContext.units.length) {
      break;
    }

    readerContext.work++;

    if (prefixes && position <= prefixes.numericEnd && !prefixes.valid[position - startPosition]) {
      continue;
    }

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

  // The closed half-yuan spelling is resolved before ordinary numeric failure; "半块钱" reads 50 cents.
  if (!parsedNumber && text[startPosition] === '半'
    && matchesWordAt(readerContext, startPosition + 1, '块钱')) {
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
        end: startPosition + 3
      }]),
      number: parsedNumber,
      checkedEnd: startPosition + 3,
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

    // 钱/厘/毫/文 forbid a numeric monetary tail after a named unit, even when classified as an ordinary word.
    // parseAmount("十二金币五文", {units: ["金币"]}) is null; the 五 is not another named-currency subunit.
    if (numericEnd > unitEnd
      && (classifyNumberEnd(readerContext, numericEnd) !== 'word'
        || '钱厘毫文'.includes(text[numericEnd] ?? '\0'))) {
      return null;
    }

    return {
      expression: buildNumericAmount(parsedNumber, start, unitEnd, unit),
      number: parsedNumber,
      checkedEnd: unitEnd,
      candidate: false,
      major: true
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
  if (parsedNumber.decimal && !isArabicDigit(parsedNumber.raw[0])
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
 * Neighbor checks precede parsing; the isolated zero exception uses the cached inline-whitespace jump.
 */
function allowsAmountLeftNeighbor(readerContext: ReaderContext, start: number): boolean {
  const text = readerContext.text;
  const position = readerContext.previousNonWhitespaceEnd[start]!;
  const previousCharacter = text[position - 1];
  const immediate = text[start - 1];

  // The isolated 零 exception admits change after inline whitespace, while rejecting a zero inside another number.
  // scanAmounts("找零 五块") returns one 500-cent reading at [3, 5).
  if (previousCharacter === '第'
    || previousCharacter !== undefined && NUMERIC_FIELD_CHARACTERS.has(previousCharacter)) {
    if (!(previousCharacter === '零' && !isNumberCharacter(text[position - 2])
      && !isCurrencyAt(readerContext, position - 2))) {
      return false;
    }
  }

  // Adjacent identifiers and rejected signs suppress a numeric suffix; scanning must not turn it into a new amount.
  if (immediate
    && (LATIN_CHARACTER.test(immediate) || immediate === '_' || immediate === '#'
      || REJECTED_LEFT_SIGNS.has(immediate))) {
    return false;
  }

  // ASCII/fullwidth dots, comma and 点 keep the numeric continuation attached to its left side.
  // The additional leading-dot guard keeps parseAmount(".5元") null.
  if (immediate && '.．,点'.includes(immediate) && isNumberCharacter(text[start - 2])) {
    return false;
  }

  if (isArabicDigit(text[start]) && (immediate === '.' || immediate === '．')) {
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
 * A joined right side skips left-neighbor checks and modifier application; outer modifiers apply to the combined range.
 * An unreadable right side rejects a bare left side but keeps a written-unit left side and its modifiers.
 */
function readAmountAt(readerContext: ReaderContext, start: number, joining = false): AmountCore | null {
  if (!joining && !allowsAmountLeftNeighbor(readerContext, start)) {
    return null;
  }

  const core = readAmountCore(readerContext, start);

  if (!core) {
    return null;
  }

  let expression = core.expression;
  let after = expression.end;
  let connected = false;

  // 、 joins only a bare left spelling: "三、四十五块" is a range, but parseAmount("三元、四元") is null.
  // A written left unit keeps those comma-separated amounts separate.
  if (!joining && AMOUNT_CONNECTORS.has(readerContext.text[after]!)
    && (readerContext.text[after] !== '、' || expression.bare)
    && NUMERIC_FIELD_CHARACTERS.has(readerContext.text[after + 1]!)) {
    const secondNumber = readAmountAt(readerContext, after + 1, true);

    // A failed right side invalidates a bare left side, but a written unit still identifies its independent amount.
    // scanAmounts("大概十块到三个") keeps the 1000..1000-cent left estimate.
    if (!secondNumber && expression.bare) {
      return null;
    }

    if (secondNumber) {
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
    checkedEnd: after
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

  if (readerContext.text[startPosition - 1] === '¥' || readerContext.text[startPosition - 1] === '￥') {
    startPosition--;
  }

  const found = readAmountAt(readerContext, startPosition);

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

    if (readerContext.text[startPosition - 1] === '¥'
      || readerContext.text[startPosition - 1] === '￥') {
      startPosition--;
    }

    let found = readAmountAt(readerContext, startPosition);

    // Only 零/俩/仨/半 allow one retry inside a failed field;
    // scanAmounts("半十二块") starts the 1200-cent amount at 1.
    if (!found && '零俩仨半'.includes(readerContext.text[numericField.start]!)
      && numericField.end > numericField.start + 1) {
      found = readAmountAt(readerContext, numericField.start + 1);
    }

    // Capital numerals need a written unit for amounts; accepting a candidate also advances the nonoverlap cursor.
    if (found && !(numericField.capital && found.expression.bare)) {
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
 * Lists amount candidates in source order with nonoverlapping half-open original UTF-16 spans.
 * Values are integer hundredths of the written unit; scans have no text/Arabic-number length cap.
 * Invalid input or no readable candidates returns []; a read does not establish a transaction.
 * O(n) character work for a fixed unit list; bigint arithmetic cost depends on the size of the numeric value.
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
 * Ordinals govern a clause, not only the nearby number; the existing field pointer advances monotonically.
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

      if (body.length === 1 && readSmallDigit(body) !== null) {
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

    // Use the clause flag computed before scanning, so ordinal text cannot turn a later number into a discount.
    if (readerContext.ordinal[start]) {
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
 * Lists whole discount bodies; an ordinal suppresses rates only in its punctuation-delimited clause.
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

    // Punctuation connects only adjacent Arabic digits; this is a lexical span, not numeric validation.
    // scanNumbers("12.3,4") returns [0, 6) even though that spelling is not an exact number.
    while (i < text.length
      && (PLAIN_NUMBER_CHARACTERS.has(text[i]!)
        || (text[i] === '.' || text[i] === ',') && isArabicDigit(text[i - 1])
        && isArabicDigit(text[i + 1]))) {
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
