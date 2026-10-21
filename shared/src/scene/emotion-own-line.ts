import type {PerspectivePlan, SceneCharacter, SceneRoster, SceneSource} from './types.ts';

/** Accepted authorship fields; malformed historical speaker values are treated as unknown authorship. */
export interface EmotionLineSource {
  role: string;
  automatic?: unknown;
  speakerId?: unknown;
  replyTo?: {id: string; revision: number} | null;
}

/** Resolves an exact antecedent to its active roster ids, or null when it cannot establish authorship. */
export type EmotionLineResolver = (reference: {id: string; revision: number}) => readonly string[] | null;

/**
 * Returns whether accepted speech belongs to this actor, including single-actor automatic replies.
 * A missing resolver/reference never guesses from adjacency; callback and property getter errors propagate.
 * Direct speech takes constant work; automatic speech uses the caller's memoized antecedent resolver.
 */
export function isOwnEmotionLine(
  source: EmotionLineSource,
  characterId: string,
  resolve?: EmotionLineResolver | null,
): boolean {
  if (source.role !== 'assistant') return false;
  if (source.automatic !== true) {
    return typeof source.speakerId === 'string' && source.speakerId.length > 0 && source.speakerId === characterId;
  }
  if (!source.replyTo || !resolve) return false;
  const active = resolve(source.replyTo);
  return active?.length === 1 && active[0] === characterId;
}

/**
 * Selects generation's active actors in roster order: visible observation readers plus explicit generation requests.
 * Work is O(roster + readers + requests); source getters propagate. Unknown ids grant no activity.
 */
export function activeEmotionCharacters(plan: PerspectivePlan, roster: SceneRoster): SceneCharacter[] {
  const active = new Set<string>();
  for (const observation of plan.observations) {
    if (observation.playerVisible) {
      for (const id of observation.readers) active.add(id);
    }
  }
  for (const id of Object.keys(plan.generationRequests ?? {})) active.add(id);
  return roster.characters.filter(character => active.has(character.id));
}

/**
 * Indexes accepted-source identities once and memoizes active plans per source object for linear history traversal.
 * Same-job overrides take precedence even when their revision is different, so stale stored revisions never win.
 * Only ready automatic user sources with an unskipped plan resolve; getters propagate without swallowing failures.
 */
export function createEmotionLineResolver(
  sources: readonly SceneSource[],
  roster: SceneRoster,
  processed?: ReadonlyMap<string, SceneSource>,
): EmotionLineResolver {
  const indexed = new Map(sources.map(source => [source.id, source]));
  const activeBySource = new WeakMap<SceneSource, readonly string[]>();
  return reference => {
    const source = processed?.has(reference.id) ? processed.get(reference.id) : indexed.get(reference.id);
    if (!source || source.revision !== reference.revision || source.status !== 'accepted'
      || source.processing !== 'ready' || source.role !== 'user' || source.automatic !== true
      || !source.analysis?.plan || source.analysis.skippedStages?.some(stage => stage.stage === 'perspective')) {
      return null;
    }
    let active = activeBySource.get(source);
    if (active === undefined) {
      active = activeEmotionCharacters(source.analysis.plan, roster).map(character => character.id);
      activeBySource.set(source, active);
    }
    return active;
  };
}

/** Legacy single-actor sources have no speaker field; assistant authorship alone identifies their own speech. */
export function isCoreOwnEmotionLine(source: {role: string}): boolean {
  return source.role === 'assistant';
}
