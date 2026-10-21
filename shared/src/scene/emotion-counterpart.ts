import type {EmotionDelta} from '../emotion/openher.ts';
import type {PerspectivePlan, SceneCharacter, SceneMessage, SceneRoster} from './types.ts';

/**
 * Selects one other emotional person from validated source observations, or null when none is available.
 * Readable recipients take precedence, then user authorship, then the first readable speaker.
 * Runs in O(roster + observations + reader/recipient entries); getters and predicate errors propagate unchanged.
 */
export function selectEmotionCounterpart(
  source: Pick<SceneMessage, 'role' | 'automatic' | 'speakerId' | 'envelope'>,
  plan: Pick<PerspectivePlan, 'observations'> | null | undefined,
  subjectId: string,
  roster: SceneRoster,
  hasEmotion: (actor: SceneCharacter) => boolean,
): string | null {
  const allowed = new Set(roster.characters.filter(hasEmotion).map(actor => actor.id));
  allowed.add('player');
  allowed.delete(subjectId);
  let first: string | null = null;
  for (const observation of plan?.observations ?? []) {
    if (!observation.readers.includes(subjectId)) continue;
    const speaker = source.role === 'user' ? 'player'
      : source.automatic !== true ? source.speakerId
      : observation.kind === 'heard' ? observation.actorId : undefined;
    if (typeof speaker !== 'string' || !allowed.has(speaker)) continue;
    first ??= speaker;
    if (observation.recipients?.includes(subjectId)) return speaker;
  }
  if (source.role === 'user' && allowed.has('player')) return 'player';
  return first;
}

/**
 * Reads a stored resolved person, including explicit null, without applying today's selection again.
 * Missing or corrupt own members use selection. A corrupt value calls onInvalid once before selection.
 * Null means resolved absence; strings of 1 through 200 UTF-16 units are accepted without roster checks.
 * A saved id may refer to a person no longer in the roster. Selection and callback errors propagate unchanged.
 */
export function storedEmotionCounterpart(
  delta: Pick<EmotionDelta, 'relation'>,
  source: Pick<SceneMessage, 'role' | 'automatic' | 'speakerId' | 'envelope'>,
  plan: Pick<PerspectivePlan, 'observations'> | null | undefined,
  subjectId: string,
  roster: SceneRoster,
  hasEmotion: (actor: SceneCharacter) => boolean,
  onInvalid?: () => void,
): string | null {
  const relation = delta.relation;
  if (relation !== null && typeof relation === 'object' && Object.hasOwn(relation, 'counterpartId')) {
    const value = (relation as {counterpartId: unknown}).counterpartId;
    if (value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 200)) return value;
    onInvalid?.();
  }
  return selectEmotionCounterpart(source, plan, subjectId, roster, hasEmotion);
}

/** Returns a detached appraisal carrying its resolved person; no other appraisal values are changed or inferred. */
export function withEmotionCounterpart(delta: EmotionDelta, counterpartId: string | null): EmotionDelta {
  return {...delta, relation: {...delta.relation as object, counterpartId}};
}

/**
 * Returns the historical appraisal identity without the newly stored resolved person.
 * Only that own member is removed; every other value and its property order remain intact.
 * Unannotated inputs are returned unchanged. Property getter failures propagate.
 */
export function withoutEmotionCounterpart(delta: EmotionDelta): EmotionDelta {
  const relation = delta.relation;
  if (relation === null || typeof relation !== 'object' || !Object.hasOwn(relation, 'counterpartId')) return delta;
  const {counterpartId, ...retained} = relation as Record<string, unknown>;
  return {...delta, relation: retained};
}
