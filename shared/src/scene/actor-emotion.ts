import type {SceneCharacter} from './types.ts';

let testPredicate: ((actor: SceneCharacter) => boolean) | undefined;

/** All current roster members have emotion; future actor kinds must share this one eligibility decision. */
export function actorHasEmotion(actor: SceneCharacter): boolean {
  return testPredicate ? testPredicate(actor) : true;
}

/**
 * Installs a synchronous test-only predicate and returns a restoration function. Product inputs cannot select it.
 * Tests must restore it in finally; callback errors propagate unchanged so the enclosing write can roll back.
 */
export function setActorEmotionPredicateForTests(predicate: (actor: SceneCharacter) => boolean): () => void {
  const previous = testPredicate;
  testPredicate = predicate;
  return () => {
    testPredicate = previous;
  };
}
