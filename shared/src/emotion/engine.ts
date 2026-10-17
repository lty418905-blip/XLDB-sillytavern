import {STORY_CLOCK_RULE_VERSION} from '../scene/story-clock-types.ts';
import {RELATIONSHIP_FOLD_RULE_VERSION} from './relationships.ts';

/** Supported numerical rule identities; the temporary test selector accepts only these two integer values. */
export type EmotionEngineRule = 2 | 3;

/**
 * Product replay still uses historical rule 2. Switch this to 3 at the product upgrade and remove the test selector.
 * This value names a replay rule, not a database format.
 */
export const EMOTION_ENGINE_RULE: EmotionEngineRule = 2;

/**
 * Replay identity, without timestamps or actor data. Real clocks have no story-clock rule; own-action credit is disabled.
 * The fold version starts at 1 for the existing relationship fold and the disabled credit bit is fixed at 0.
 */
export interface EmotionEngineKey {
  rule: EmotionEngineRule;
  clockRule: number | null;
  foldRule: number;
  clockDomain: 'story' | 'real';
  ownActCredit: 0;
}

/** Test-only constructor selection; omission selects the product rule, and every other value throws before storage opens. */
export function emotionEngineRuleOf(emotionEngineRule: unknown): EmotionEngineRule {
  if (emotionEngineRule === undefined) return EMOTION_ENGINE_RULE;
  if (emotionEngineRule === 2 || emotionEngineRule === 3) return emotionEngineRule;
  throw new Error('invalid_emotion_engine_rule');
}

/** Builds a dimensionless five-member key; supported rule/domain inputs require no storage and cannot fail. */
export function createEmotionEngineKey(rule: EmotionEngineRule, clockDomain: 'story' | 'real'): EmotionEngineKey {
  return {
    rule,
    clockRule: clockDomain === 'story' ? STORY_CLOCK_RULE_VERSION : null,
    foldRule: RELATIONSHIP_FOLD_RULE_VERSION,
    clockDomain,
    ownActCredit: 0,
  };
}

/**
 * Compares exactly five own members by value, independent of order. Non-records, extra members and throwing getters
 * return false; a stored key is never interpreted as executable input. Work is bounded by the stored member count.
 */
export function emotionEngineKeysEqual(value: unknown, expected: EmotionEngineKey): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const stored = value as Record<string, unknown>;
    const members = ['rule', 'clockRule', 'foldRule', 'clockDomain', 'ownActCredit'] as const;
    return Object.keys(stored).length === members.length
      && members.every(member => Object.hasOwn(stored, member) && stored[member] === expected[member]);
  } catch {
    return false;
  }
}

/**
 * Trust decision only: shape validation remains the caller's job. Rule 2 accepts an untagged version 2 snapshot;
 * otherwise the version and all engine members must match. A null engine is present and mismatches.
 * The lazy key resolver runs only for a present engine on the selected version; its clock errors propagate unchanged.
 */
export function recognizesEmotionSnapshot(
  value: unknown,
  rule: EmotionEngineRule,
  currentKey: () => EmotionEngineKey,
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.version !== rule) return false;
  if (!Object.hasOwn(snapshot, 'engine')) return rule === 2;
  return emotionEngineKeysEqual(snapshot.engine, currentKey());
}
