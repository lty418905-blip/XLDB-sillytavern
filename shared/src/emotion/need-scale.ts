import { DRIVE_NAMES } from './openher.ts';
import type { DriveValues } from './openher.ts';
import { NEED_WORDS, NEED_LEVEL_WORDS } from './appraisal-wording.ts';

/** Need strength on the shared reading scale; none has no displayed wording. */
export type NeedLevel = 'none' | 'slight' | 'clear' | 'strong';

// Provisional reading thresholds for frustration units, pending model and engine calibration.
const NEED_THRESHOLDS = [0.5, 1.5, 3.0] as const;

/**
 * Classifies one finite frustration value, normally 0..5, with inclusive lower bounds.
 * Finite values outside that normal range use the outer levels; nonfinite or nonnumeric inputs throw TypeError.
 */
export function needLevel(frustration: number): NeedLevel {
  if (!Number.isFinite(frustration)) {
    throw new TypeError('invalid_frustration');
  }

  if (frustration < NEED_THRESHOLDS[0]) {
    return 'none';
  }
  if (frustration < NEED_THRESHOLDS[1]) {
    return 'slight';
  }
  if (frustration < NEED_THRESHOLDS[2]) {
    return 'clear';
  }
  return 'strong';
}

/**
 * Renders the five already-projected frustration values in drive order, omitting none; all-none returns [].
 * Work is constant in chat length. Invalid values and throwing state getters propagate without mutation.
 */
export function needsNow(frustration: DriveValues): string[] {
  const result: string[] = [];

  for (const drive of DRIVE_NAMES) {
    const level = needLevel(frustration[drive]);
    if (level !== 'none') {
      result.push(`${NEED_WORDS[drive]}：${NEED_LEVEL_WORDS[level]}`);
    }
  }

  return result;
}
