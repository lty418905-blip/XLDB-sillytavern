import { createPairCapture, installPairCapture } from './pair-capture.ts';
import { currentModelAddress } from './runtime-log.ts';

export interface PairCaptureStart {
  state: 'off' | 'on' | 'invalid';
  file: string | null;
  notice: string | null;
}

/**
 * Pair capture is a test and evaluation aid and is off by default. A host calls this once at start with the
 * value of its XLDB_PAIR_CAPTURE environment variable (the run id) and its root directory. Nothing reads the
 * switch again: a model call only looks at the installed capture. An unset or empty value changes nothing; an
 * invalid value changes nothing and returns a notice for the host to print.
 */
export function startPairCapture(value: unknown, root: unknown): PairCaptureStart {
  if (value === undefined || value === null || value === '') return { state: 'off', file: null, notice: null };
  try {
    const capture = createPairCapture({ root: root as string, runId: value as string, address: currentModelAddress });
    installPairCapture(capture);
    const file = capture.status().file;
    return { state: 'on', file, notice: `XLDB pair capture on: ${file}` };
  } catch {
    return { state: 'invalid', file: null, notice: 'XLDB pair capture: invalid run id or root, capture is off' };
  }
}
