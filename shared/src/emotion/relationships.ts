import {foldForMatch,includesForMatch,sourceQuote} from '../common/script-fold.ts';
import type { StableRelations } from './openher.ts';

export type RelationshipDelta = Partial<Pick<StableRelations, 'depth' | 'trust' | 'valence'>>;

/** A source-local, directional candidate; it has no authority outside an accepted source analysis. */
export interface DirectionalRelationship {
  id: string;
  subjectId: string;
  targetId: string;
  evidenceObservationIds: string[];
  evidenceQuotes: string[];
  delta: RelationshipDelta;
}

/** Literal evidence visible to readers; attributed actorId identifies its speaker or actor, not a reader. */
export interface RelationshipObservation {
  /** Missing means legacy data; an attributed observation without actorId has no single known speaker. */
  attributed?: true;
  id: string;
  quote: string;
  evidence: string;
  readers: readonly string[];
  actorId?: string;
  recipients?: readonly string[];
  playerVisible?: boolean;
  playerEvidence?: string;
}

export interface RelationshipActor { id: string; name: string; aliases: readonly string[] }

export interface SceneRelationshipContext {
  subjectId: string;
  /** Every real NPC id in this scene. The user actor is deliberately separate. */
  actorIds: readonly string[];
  userActorId: string;
  actors: readonly RelationshipActor[];
  observations: readonly RelationshipObservation[];
  messageRole: 'user' | 'assistant';
}

/** The minimal structural portion of an accepted scene source required for replay. */
export interface RelationshipSource {
  id: string;
  revision: number;
  status?: string;
  processing?: string;
  analysis?: { characters?: Record<string, { relationships?: readonly DirectionalRelationship[] }> } | null;
}

export interface FoldedRelationship {
  subjectId: string;
  targetId: string;
  relations: StableRelations;
  sourceId: string;
  revision: number;
}

/** Only pass relationships already projected for the current speaker. */
export function relationshipContext(relationships:readonly FoldedRelationship[]):string {
  if(!relationships.length)return '';
  return '\n[XLDB 方向性关系] 以下只表示当前角色对指定对象的长期关系，不代表反向关系、客观事实或对方同意。用于表达、边界与回应取舍，不向用户展示数值或字段：'+JSON.stringify(relationships);
}

const MAX_RELATIONSHIPS = 6;
// Product contract: each relationship candidate may cite at most three observations and three quotes.
const MAX_EVIDENCE = 3;
const MAX_ID_LENGTH = 200;
const MAX_QUOTE_LENGTH = 4_000;

/**
 * Validate at most six candidates against already-filtered perspective observations.
 * Returns detached evidence arrays and source-spelled quotes, or throws an invalid_relationship* error.
 * Each candidate checks at most three pairs; quote matching is linear in the paired text lengths.
 * Context observations and actor aliases have no count cap and are visited once during context validation.
 * A roster entry or bare name mention cannot establish a relationship.
 */
export function validateRelationships(
  value: unknown,
  context: SceneRelationshipContext,
  options: {ignoreValidatedZeroDelta?: boolean} = {},
): DirectionalRelationship[] {
  const checked = checkedContext(context);

  if (!Array.isArray(value) || value.length > MAX_RELATIONSHIPS) {
    throw new Error('invalid_relationships');
  }

  const observations = new Map(checked.observations.map(observation => [observation.id, observation]));
  const result: DirectionalRelationship[] = [];
  const ids = new Set<string>();
  const targets = new Set<string>();

  for (const item of value) {
    const input = record(item, 'invalid_relationship');
    const allowedKeys = ['id', 'subjectId', 'targetId', 'evidenceObservationIds', 'evidenceQuotes', 'delta'];

    if (Object.keys(input).some(key => !allowedKeys.includes(key))) {
      throw new Error('invalid_relationship');
    }

    const id = requiredText(input.id, MAX_ID_LENGTH, 'invalid_relationship');
    const subjectId = requiredText(input.subjectId, MAX_ID_LENGTH, 'invalid_relationship');
    const targetId = requiredText(input.targetId, MAX_ID_LENGTH, 'invalid_relationship');

    if (subjectId !== checked.subjectId || targetId === subjectId ||
      (targetId !== checked.userActorId && !checked.actors.has(targetId)) || ids.has(id) || targets.has(targetId)) {
      throw new Error('invalid_relationship_target');
    }

    const evidenceIds = textList(input.evidenceObservationIds, MAX_EVIDENCE, MAX_ID_LENGTH, 'invalid_relationship_evidence');
    const evidenceQuotes = textList(
      input.evidenceQuotes,
      MAX_EVIDENCE,
      MAX_QUOTE_LENGTH,
      'invalid_relationship_evidence',
    );
    const sharedObservation = evidenceIds.length === 1 && evidenceQuotes.length > 1;

    if (!evidenceIds.length || (!sharedObservation && evidenceIds.length !== evidenceQuotes.length) ||
      new Set(evidenceIds).size !== evidenceIds.length) {
      throw new Error('invalid_relationship_evidence');
    }

    // Direct replies can be one observation containing several relevant passages. Check every passage against
    // that observation, but keep the supplied ID array so storing and revalidating do not rewrite its shape.
    // The existing three-quote cap bounds this mapping; no cross product of IDs and quotes is constructed.
    const pairs = evidenceQuotes.map((quote, index) => ({
      observation: observations.get(evidenceIds[sharedObservation ? 0 : index]!),
      quote,
    }));

    if (pairs.some(pair => !pair.observation || !pair.observation.readers.includes(checked.subjectId) ||
      !includesForMatch(pair.observation.quote, pair.quote))) {
      throw new Error('invalid_relationship_evidence');
    }

    if (!pairs.every(pair => targetHasGroundedParticipation(pair.observation!, pair.quote, targetId, checked))) {
      throw new Error('invalid_relationship_target');
    }

    const delta = relationshipDelta(input.delta, options.ignoreValidatedZeroDelta === true);
    ids.add(id);
    targets.add(targetId);

    if (options.ignoreValidatedZeroDelta === true && Object.values(delta).every(value => value === 0)) continue;

    result.push({
      id,
      subjectId,
      targetId,
      evidenceObservationIds: evidenceIds,
      evidenceQuotes: pairs.map(pair => sourceQuote(pair.observation!.quote, pair.quote)!),
      delta,
    });
  }

  return result;
}

/**
 * Version 1 identifies the existing fold. Increment whenever foldRelationships results change: this value enters
 * emotion engine keys, so changing it replays every story-domain actor once from accepted records.
 */
export const RELATIONSHIP_FOLD_RULE_VERSION = 1;

/** A caller-owned prefix fold; append visits one source and reads return detached provenance-bearing values. */
export interface RelationshipFold {
  append(source: RelationshipSource): void;
  get(targetId: string): FoldedRelationship | undefined;
  values(): FoldedRelationship[];
}

/**
 * Creates the existing directional fold as an incremental prefix reader, with rate in [0, 0.1].
 * Invalid subject/rate throws invalid_relationship_fold; source getter errors propagate as in the whole-history fold.
 * Appending N sources visits O(N + candidates), including pending emotion candidates on ready accepted sources.
 * Duplicate candidate identities remain suppressed for this fold's entire lifetime, without limiting history length.
 */
export function createRelationshipFold(subjectId: string, rate: number): RelationshipFold {
  if (!validId(subjectId) || !Number.isFinite(rate) || rate < 0 || rate > 0.1) {
    throw new Error('invalid_relationship_fold');
  }
  const states = new Map<string, FoldedRelationship>();
  const applied = new Set<string>();
  const detached = (value: FoldedRelationship): FoldedRelationship => ({...value, relations: {...value.relations}});
  return {
    append(source) {
      if (!usableSource(source)) return;
      const characters = source.analysis?.characters;
      const candidates = characters && Object.hasOwn(characters, subjectId)
        ? characters[subjectId]?.relationships ?? [] : [];
      for (const relationship of candidates) {
        if (!validStoredRelationship(relationship, subjectId)) continue;
        const key = `${source.id}:${source.revision}:${relationship.id}`;
        if (applied.has(key)) continue;
        applied.add(key);
        const previous = states.get(relationship.targetId)?.relations ?? {depth: 0, trust: 0, valence: 0};
        const relations: StableRelations = {
          depth: clamp(previous.depth + (relationship.delta.depth ?? 0) * rate, 0, 1),
          trust: clamp(previous.trust + (relationship.delta.trust ?? 0) * rate, 0, 1),
          valence: clamp(previous.valence + (relationship.delta.valence ?? 0) * rate, -1, 1),
        };
        states.set(relationship.targetId, {
          subjectId, targetId: relationship.targetId, relations, sourceId: source.id, revision: source.revision,
        });
      }
    },
    get(targetId) {
      const value = states.get(targetId);
      return value === undefined ? undefined : detached(value);
    },
    values() {
      return [...states.values()].map(detached);
    },
  };
}

/**
 * Fold only ready, accepted source analyses. The source/candidate key makes a
 * repeated replay entry harmless, without adding a cache or second authority.
 */
export function foldRelationships(orderedAcceptedSources: readonly RelationshipSource[], subjectId: string, rate: number): FoldedRelationship[] {
  if (!validId(subjectId) || !Number.isFinite(rate) || rate < 0 || rate > 0.1) throw new Error('invalid_relationship_fold');
  const states = new Map<string, FoldedRelationship>();
  const applied = new Set<string>();
  for (const source of orderedAcceptedSources) {
    if (!usableSource(source)) continue;
    for (const relationship of source.analysis?.characters?.[subjectId]?.relationships ?? []) {
      if (!validStoredRelationship(relationship, subjectId)) continue;
      const key = `${source.id}:${source.revision}:${relationship.id}`;
      if (applied.has(key)) continue;
      applied.add(key);
      const previous = states.get(relationship.targetId)?.relations ?? {depth:0,trust:0,valence:0};
      const relations:StableRelations = {
        depth: clamp(previous.depth + (relationship.delta.depth ?? 0) * rate, 0, 1),
        trust: clamp(previous.trust + (relationship.delta.trust ?? 0) * rate, 0, 1),
        valence: clamp(previous.valence + (relationship.delta.valence ?? 0) * rate, -1, 1),
      };
      states.set(relationship.targetId,{subjectId,targetId:relationship.targetId,relations,sourceId:source.id,revision:source.revision});
    }
  }
  return [...states.values()];
}

/** Returns the current provenance-bearing state for one directed pair, if any. */
export function relationshipAnchor(orderedAcceptedSources: readonly RelationshipSource[], subjectId: string, targetId: string, rate: number): FoldedRelationship | undefined {
  if (!validId(targetId)) throw new Error('invalid_relationship_fold');
  return foldRelationships(orderedAcceptedSources,subjectId,rate).find(relationship => relationship.targetId === targetId);
}

function checkedContext(context: SceneRelationshipContext) {
  if (!context || !validId(context.subjectId) || !validId(context.userActorId) || context.subjectId === context.userActorId ||
    !Array.isArray(context.actorIds) || !Array.isArray(context.actors) || !Array.isArray(context.observations) ||
    (context.messageRole !== 'user' && context.messageRole !== 'assistant')) throw new Error('invalid_relationship_context');
  const actorIds = new Set(context.actorIds);
  if (!actorIds.size || actorIds.size !== context.actorIds.length || !actorIds.has(context.subjectId) || actorIds.has(context.userActorId) ||
    [...actorIds].some((id:string) => !validId(id))) throw new Error('invalid_relationship_context');
  const actors = new Map<string, RelationshipActor>();
  for (const actor of context.actors) {
    if (!actor || !actorIds.has(actor.id) || actors.has(actor.id) || !validId(actor.id) || !validLabel(actor.name) ||
      !Array.isArray(actor.aliases) || actor.aliases.some((alias:string) => !validLabel(alias))) throw new Error('invalid_relationship_context');
    actors.set(actor.id,actor);
  }
  if (!actors.has(context.subjectId)) throw new Error('invalid_relationship_context');
  const observationIds = new Set<string>();
  for (const observation of context.observations) {
    if (!observation || !validId(observation.id) || observationIds.has(observation.id) || !validQuote(observation.quote) ||
      !validQuote(observation.evidence) || !Array.isArray(observation.readers) || observation.readers.some((id:string) => !actorIds.has(id)) ||
      (observation.actorId !== undefined && !actorIds.has(observation.actorId) &&
        !(context.messageRole==='user'&&observation.actorId===context.userActorId)) ||
      (observation.recipients !== undefined && (!Array.isArray(observation.recipients) || observation.recipients.some((id:string) => !actorIds.has(id)))) ||
      (observation.playerVisible !== undefined && typeof observation.playerVisible !== 'boolean') ||
      (observation.playerEvidence !== undefined && !validQuote(observation.playerEvidence))) throw new Error('invalid_relationship_context');
    observationIds.add(observation.id);
  }
  return {subjectId:context.subjectId,actorIds,userActorId:context.userActorId,actors,observations:[...context.observations],messageRole:context.messageRole};
}

function targetHasGroundedParticipation(
  observation: RelationshipObservation,
  quote: string,
  targetId: string,
  context: ReturnType<typeof checkedContext>,
): boolean {
  if (targetId === context.userActorId) {
    if (context.messageRole === 'assistant') {
      return observation.playerVisible === true && Boolean(observation.playerEvidence);
    }

    // An explicit player actor grounds the player's speech without needing a separate narrative reference.
    if (observation.actorId === context.userActorId) return true;

    // Legacy views carry no speaker attribution. Their public visibility retains the historical tradeoff
    // that also accepts NPC dialogue. Newly attributed narration must instead ground an unquoted player reference.
    if (observation.attributed !== true && observation.actorId === undefined
      && observation.playerVisible === true && Boolean(observation.playerEvidence)) {
      return true;
    }

    // Outside the explicit actor and visibility paths, require an unquoted player reference so an NPC's
    // quotation alone cannot establish player participation.
    const narrative = foldForMatch(quote).replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/g, '');
    return /你|您|我|玩家|用户|使用者/.test(narrative);
  }

  if (observation.actorId !== targetId && !observation.recipients?.includes(targetId)) return false;

  const target = context.actors.get(targetId)!;
  return [target.name, ...target.aliases].some(label => includesForMatch(quote, label));
}

function relationshipDelta(value: unknown,allowZero=false): RelationshipDelta {
  const input = record(value,'invalid_relationship_delta');
  if (Object.keys(input).some(key => !['depth','trust','valence'].includes(key))) throw new Error('invalid_relationship_delta');
  const delta:RelationshipDelta = {};
  for (const key of ['depth','trust','valence'] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < -1 || input[key] > 1) {
      throw new Error('invalid_relationship_delta');
    }
    delta[key] = input[key];
  }
  if (!Object.keys(delta).length || (!allowZero&&!Object.values(delta).some(value => value !== 0))) throw new Error('invalid_relationship_delta');
  return delta;
}

function validStoredRelationship(value: unknown, subjectId: string): value is DirectionalRelationship {
  try {
    const relationship = value as DirectionalRelationship;
    if (relationship.subjectId !== subjectId || !validId(relationship.targetId) || relationship.targetId === subjectId ||
      !validId(relationship.id) || !Array.isArray(relationship.evidenceObservationIds) || !Array.isArray(relationship.evidenceQuotes)) return false;
    relationshipDelta(relationship.delta);
    return true;
  } catch { return false; }
}

function usableSource(source: RelationshipSource): boolean {
  return !!source && validId(source.id) && Number.isSafeInteger(source.revision) && source.revision > 0 &&
    (source.status === undefined || source.status === 'accepted') && (source.processing === undefined || source.processing === 'ready');
}
function textList(value: unknown, maximum:number, textMaximum:number, error:string): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(error);
  return value.map(item => requiredText(item,textMaximum,error));
}
function record(value: unknown, error:string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, maximum:number, error:string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(error);
  return value;
}
function validId(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= MAX_ID_LENGTH; }
function validLabel(value: unknown): value is string { return validId(value); }
function validQuote(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= MAX_QUOTE_LENGTH; }
function clamp(value:number, minimum:number, maximum:number):number { return Math.max(minimum,Math.min(maximum,value)); }
