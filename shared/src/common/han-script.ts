import {SCRIPT_FOLD_PAIRS} from './script-fold-data.ts';
import {TRADITIONAL_EXCLUSIONS, SIMPLIFIED_EXCLUSIONS} from './han-script-exclusions.ts';

/** Script evidence classification; ties, missing evidence, and non-string inputs are unknown. */
export type HanScript = 'traditional' | 'simplified' | 'unknown';

const leftCharacters = new Set(SCRIPT_FOLD_PAIRS.map(([left]) => left));
const rightCharacters = new Set(SCRIPT_FOLD_PAIRS.map(([, right]) => right));
const traditionalExcluded = new Set(TRADITIONAL_EXCLUSIONS);
const simplifiedExcluded = new Set(SIMPLIFIED_EXCLUSIONS);
const traditionalEvidence = new Set<string>();
const simplifiedEvidence = new Set<string>();

// The left side of each pair is Traditional; the right side is Simplified.
// A left-side character is Traditional evidence only if it differs from its paired right-side character,
// appears on no right side, and is absent from GB2312 level one.
// A right-side character is Simplified evidence only if it differs from its paired left-side character,
// appears on no left side, and is absent from Big5 common characters.
// Full-width folding and lexical replacements do not establish script evidence.
for (const [left, right] of SCRIPT_FOLD_PAIRS) {
  if (left !== right && !rightCharacters.has(left) && !traditionalExcluded.has(left)) {
    traditionalEvidence.add(left);
  }

  if (left !== right && !leftCharacters.has(right) && !simplifiedExcluded.has(right)) {
    simplifiedEvidence.add(right);
  }
}

/**
 * Counts each occurrence of exclusive script evidence and each visited code point, including lone surrogates.
 * Only primitive strings are scanned; other inputs return three zero counts without conversion or property reads.
 * O(n) time for n input code points, O(1) additional space, and no input length limit.
 */
export function countHanScriptEvidence(text: unknown): {
  traditional: number;
  simplified: number;
  visited: number;
} {
  let traditional = 0;
  let simplified = 0;
  let visited = 0;

  if (typeof text !== 'string') {
    return {traditional, simplified, visited};
  }

  for (const character of text) {
    visited += 1;

    if (traditionalEvidence.has(character)) {
      traditional += 1;
    } else if (simplifiedEvidence.has(character)) {
      simplified += 1;
    }
  }

  return {traditional, simplified, visited};
}

/**
 * Classifies a primitive string by the greater occurrence count, with no ratio or minimum count threshold.
 * Equal counts, including zero evidence and non-string inputs, return unknown without throwing.
 * Delegates to the counter: O(n) time, O(1) additional space, and no input length limit.
 */
export function detectHanScript(text: unknown): HanScript {
  const {traditional, simplified} = countHanScriptEvidence(text);

  if (traditional > simplified) {
    return 'traditional';
  }

  if (simplified > traditional) {
    return 'simplified';
  }

  return 'unknown';
}
