import type { ModelRunner, Prompt } from '../core/models.ts';
import type { ModelConfig } from '../core/types.ts';
import type { AppraisalDecodeContext, AppraisalEmotionDelta } from './appraisal.ts';
import type { AppraisalInput, AppraisalSourcePointer } from './appraisal-input.ts';
import type { DirectionalRelationship } from './relationships.ts';
import type { EmotionDelta } from './openher.ts';
import { decodeAppraisal, buildAppraisalReask } from './appraisal.ts';
import { APPRAISAL_SYSTEM_PROMPT } from './appraisal-wording.ts';
import { recordStage, withModelAddress } from '../core/runtime-log.ts';

/** Accepted mapped result; reception references are replaced with durable source pointers before returning. */
export interface AppraisalCallResult {
  emotion: EmotionDelta;
  relationships: DirectionalRelationship[];
}

/**
 * Makes at most two calls for one appraisal attempt. An optional raw first answer comes from an outer bundle.
 * Invalid reader-relevant data throws invalid_emotion_delta; runner, clock, and relationship failures propagate.
 * Parsing work is linear in the two answers and happened text. Private text appears only in its own reask assistant turn.
 * A valid supplied first answer returns synchronously; model execution and reasks return a promise.
 */
export function callAppraisal(
  config: ModelConfig,
  input: AppraisalInput,
  context: AppraisalDecodeContext,
  run: ModelRunner,
  ownLineSource?: AppraisalSourcePointer,
  firstRaw?: string,
): AppraisalCallResult | Promise<AppraisalCallResult> {
  const prompts: Prompt[] = [
    { role: 'system', content: APPRAISAL_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(input) },
  ];
  const decode = (raw: string, attempt: 1 | 2) => {
    const decoded = decodeAppraisal(raw, { ...context, attempt });
    for (const diagnostic of decoded.diagnostics) {
      recordStage(diagnostic.code, { stage: 'emotion', parts: [diagnostic.path] });
    }
    return decoded;
  };
  const finish = (decoded: ReturnType<typeof decodeAppraisal>): AppraisalCallResult => {
    if (!decoded.accepted) throw new Error('invalid_emotion_delta');
    const emotion: EmotionDelta = storedAppraisal(decoded.emotion, ownLineSource);
    emotion.stableRelationDelta = {};
    return { emotion, relationships: decoded.relationships ?? [] };
  };
  const checkFirst = (first: string): AppraisalCallResult | Promise<AppraisalCallResult> => {
    const decoded = decode(first, 1);
    if (decoded.accepted) return finish(decoded);
    recordStage('appraisal_invalid', { stage: 'emotion', parts: decoded.problems.map(problem => problem.kind) });
    const reask = buildAppraisalReask(decoded.problems)!;
    return Promise.resolve(withModelAddress({ stage: 'emotion' }, () => run(config, [
      ...prompts,
      { role: 'assistant', content: first },
      { role: 'user', content: reask },
    ], true))).then(second => finish(decode(second, 2)));
  };

  // Valid bundled parts stay synchronous so unrelated completed parts keep their existing completion order.
  if (firstRaw !== undefined) return checkFirst(firstRaw);
  try {
    return Promise.resolve(run(config, prompts, true)).then(checkFirst);
  } catch (error) {
    return Promise.reject(error);
  }
}

function storedAppraisal(emotion: AppraisalEmotionDelta, ownLineSource?: AppraisalSourcePointer): EmotionDelta {
  const reception = emotion.appraisal.reception;
  if (!reception || !ownLineSource) return emotion;
  return {
    ...emotion,
    appraisal: {
      ...emotion.appraisal,
      reception: {
        sourceId: ownLineSource.sourceId,
        revision: ownLineSource.revision,
        answered: reception.answered,
        level: reception.level,
        quote: reception.quote,
      },
    },
  };
}
