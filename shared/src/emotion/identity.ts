/**
 * Actor identity seeds are defined only here. Their historical prefix identifies existing actors;
 * changing it creates a different actor. Future card-level identity seeding must change this one definition.
 */

/** Identity tuple inputs keep their JSON value types; omitted members serialize as null in the tuple. */
export interface EmotionIdentityScope {
  worldId?: unknown;
  sessionId?: unknown;
  characterId?: unknown;
}

/**
 * Returns the historical five-element JSON identity, without coercion or defaults for scope members.
 * An omitted or null NPC id becomes null; an empty string stays empty. Non-JSON inputs retain JSON.stringify errors.
 */
export function emotionIdentitySeed(scope: EmotionIdentityScope, npcId?: unknown): string {
  return JSON.stringify(['xldb-emotion-v2', scope.worldId, scope.sessionId, scope.characterId, npcId ?? null]);
}
