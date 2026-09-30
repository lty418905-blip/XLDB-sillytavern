import type { EpisodeMemory, MemoryKind, Scope } from '../memory/access.ts';
import type { EmotionDelta } from '../emotion/openher.ts';
import type { DirectionalRelationship } from '../emotion/relationships.ts';

export interface AcceptedMessage {
  id: string;
  revision: number;
  role: 'user' | 'assistant';
  text: string;
  acceptedAtMs: number;
}

export interface ModelConfig {
  baseUrl: string;
  key: string;
  model: string;
  /** Omitted lets the provider keep its own default reasoning behavior. */
  thinking?: 'enabled' | 'disabled';
}
export const stages = ['identity', 'inputPerspective', 'perspective', 'outward', 'world', 'memory', 'emotion', 'preference', 'rewrite', 'calculation', 'front', 'embedding', 'reranker', 'director', 'commitment', 'initialization', 'profile', 'strategy', 'proactiveDecision', 'proactive', 'physiology', 'geography'] as const;
export type Configurations = Record<typeof stages[number], ModelConfig>;
export type TextStage = Exclude<typeof stages[number], 'embedding' | 'reranker'>;
export const textStages = stages.filter((stage): stage is TextStage => stage !== 'embedding' && stage !== 'reranker');
export interface ConfigProfile {
  version: 2;
  /** Monotonic server revision; zero denotes a profile not yet saved as v2. */
  revision: number;
  defaultText: ModelConfig;
  overrides: Partial<Record<TextStage, ModelConfig>>;
  embedding: ModelConfig;
  reranker: ModelConfig;
}

export interface MemoryCandidate {
  retention?:import('../memory/retention.ts').Retention;
  /** Optional only for compatibility with pre-dual-memory custom model hosts. */
  kind?: MemoryKind;
  detail: string;
  gist: string;
  feeling: string;
  anchor: string;
  protectedFacts: string[];
  episode?: EpisodeMemory;
}
export interface PreferenceCandidate { category: string; text: string; quote: string; duration?:'turn'|'persistent' }
export interface Analysis {
  memories: MemoryCandidate[];
  preferences: PreferenceCandidate[];
  emotion: EmotionDelta;
  /** Scene-only, source-backed directional relationship candidates. */
  relationships?: DirectionalRelationship[];
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_object');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 2000, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new Error('invalid_text');
  return value;
}
export function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error('invalid_integer');
  return value as number;
}
export function scopeOf(value: unknown): Scope {
  const input = object(value);
  return { worldId: text(input.worldId, 200), sessionId: text(input.sessionId, 300),
    branchId: text(input.branchId, 200), characterId: text(input.characterId, 300) };
}
export function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.worldId, scope.sessionId, scope.branchId, scope.characterId]);
}
export function messageOf(value: unknown): AcceptedMessage {
  const input = object(value);
  if (input.role !== 'user' && input.role !== 'assistant') throw new Error('invalid_role');
  return { id: text(input.id, 200), revision: integer(input.revision, 1), role: input.role,
    text: text(input.text, 20000), acceptedAtMs: integer(input.acceptedAtMs) };
}
export function configOf(value: unknown): ModelConfig {
  const input = object(value);
  const thinking = thinkingOf(input.thinking);
  if (input.baseUrl === '' && input.model === '' && (input.key === '' || input.key === undefined)) {
    return {baseUrl:'',key:'',model:'',...(thinking===undefined?{}:{thinking})};
  }
  const baseUrl = text(input.baseUrl, 2000).replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_api_url');
  return { baseUrl, key: text(input.key, 4000, true), model: text(input.model, 200),
    ...(thinking===undefined?{}:{thinking}) };
}
function thinkingOf(value: unknown): ModelConfig['thinking'] {
  if (value === undefined || value === '') return undefined;
  if (value !== 'enabled' && value !== 'disabled') throw new Error('invalid_thinking');
  return value;
}
export function configsOf(value: unknown): Configurations {
  const input = object(value);
  return Object.fromEntries(stages.map(stage => [stage, configOf(input[stage] ?? {baseUrl:'',key:'',model:''})])) as Configurations;
}

const emptyModel = (): ModelConfig => ({baseUrl:'',key:'',model:''});

export function configProfileOf(value: unknown): ConfigProfile {
  const input = object(value);
  if (input.version !== 2) throw new Error('invalid_config_version');
  const revision = input.revision === undefined ? 0 : integer(input.revision);
  const overridesInput = object(input.overrides);
  if (Object.keys(overridesInput).some(stage => !textStages.includes(stage as TextStage))) throw new Error('invalid_config_stage');
  const overrides: ConfigProfile['overrides'] = {};
  for (const stage of textStages) if (Object.hasOwn(overridesInput, stage)) overrides[stage] = configOf(overridesInput[stage]);
  return {version:2,revision,defaultText:configOf(input.defaultText),overrides,
    embedding:configOf(input.embedding ?? emptyModel()),reranker:configOf(input.reranker ?? emptyModel())};
}

export function profileFromLegacy(value: unknown): ConfigProfile {
  const legacy = configsOf(value);
  const candidates = textStages.filter(stage => stage !== 'inputPerspective');
  const counts = new Map<string, number>();
  for (const stage of candidates) {
    const key = JSON.stringify(legacy[stage]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const winner = candidates.reduce((best, stage) => {
    const count = counts.get(JSON.stringify(legacy[stage])) ?? 0;
    return count > best.count ? {value:legacy[stage],count} : best;
  }, {value:emptyModel(),count:0});
  const defaultText = winner.value;
  const overrides: ConfigProfile['overrides'] = {};
  for (const stage of textStages) {
    if (stage === 'inputPerspective' && !legacy[stage].model) overrides[stage] = legacy[stage];
    else if (JSON.stringify(legacy[stage]) !== JSON.stringify(defaultText)) overrides[stage] = legacy[stage];
  }
  return {version:2,revision:0,defaultText,overrides,embedding:legacy.embedding,reranker:legacy.reranker};
}

export function resolveConfigProfile(profile: ConfigProfile): Configurations {
  return Object.fromEntries(stages.map(stage => [stage,
    stage === 'embedding' || stage === 'reranker' ? profile[stage]
      : profile.overrides[stage] ?? profile.defaultText])) as Configurations;
}
