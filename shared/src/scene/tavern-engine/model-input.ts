/**
 * Ownership handoff: EN-09 creates this file; EN-10 takes ownership after this candidate is accepted.
 * SLOT-M1 wording belongs to Claude. This module only assembles data and adapts injected runners.
 */
import type { AcceptedMessage } from '../../core/types.ts';
import type { PerspectivePlan } from '../types.ts';
import { decodeInterpretationCandidate, TAVERN_INTERPRETATION_FORMAT } from './codec.ts';
import type {
  TavernAcceptedPlayerInterpretation,
  TavernEnginePorts,
  TavernInterpretationReply,
} from './engine.ts';
import { TavernPerception } from './perception.ts';
import { projectTavernWorld } from './projection.ts';
import type { TavernSourceReference } from './store.ts';
import type {
  EventDecodeContext,
  EventOrigin,
  TavernActorEventView,
  TavernPerceptionInput,
} from './types.ts';

/** SLOT-M1, 待 Claude. Empty until approved wording is supplied; not a usable production prompt. */
export const SLOT_M1_INSTRUCTIONS = '';

/** No inferred addressee passes the action threshold; zero represents the exhausted-retry fallback. */
export const M1_FALLBACK_CONFIDENCE = 0;

/** Engine-owned attempt input; attempt is zero-based. The engine owns retries, cancellation and source checks. */
export type TavernInterpretationRequest = Parameters<TavernEnginePorts['interpret']>[0];

/** Authorized identity subsets for the model; membership is checked against the local authority catalogs. */
export interface TavernInterpretationReferences {
  entityIds: readonly string[];
  itemIds: readonly string[];
  placeIds: readonly string[];
}

/**
 * Host-validated current perception and authorized identity references. Build this for the current source,
 * not once for a chat. Existing plan stays detached and is not sent to M1 or reparsed through legacy direct.
 * Null/omitted plan means the existing empty plan. No configuration secret is part of this contract.
 */
export interface TavernInterpretationOptions {
  mode: 'automatic' | 'direct';
  playerId: string;
  ruleVersion: string;
  configurationId: string;
  perception: TavernPerceptionInput;
  references: TavernInterpretationReferences;
  plan?: PerspectivePlan | null;
}

/** Structured M1 data only: accepted user text, scoped identities, sourced presence and EN-06 filtered history. */
export interface TavernInterpretationInput {
  format: typeof TAVERN_INTERPRETATION_FORMAT;
  instructions: typeof SLOT_M1_INSTRUCTIONS;
  mode: 'automatic' | 'direct';
  origin: EventOrigin;
  configurationId: string;
  message: AcceptedMessage;
  references: TavernInterpretationReferences;
  presence: { known: boolean; presentIds: readonly string[] };
  known: TavernActorEventView;
}

/** Detached assembly; only input may be sent to a runner. context and plan remain local. */
export interface TavernPreparedInterpretation {
  input: TavernInterpretationInput;
  context: EventDecodeContext;
  plan: PerspectivePlan;
}

/** Injected runner, called once per engine attempt; sync values and thenables are supported. No service is created. */
export type TavernInterpretationRunner = (
  input: TavernInterpretationInput,
  signal: AbortSignal,
) => unknown | PromiseLike<unknown>;

/**
 * Source-bound fallback delivery, separate from the empty durable interpretation. It is not an accepted
 * hard-effect event. Empty addressees means broadcast; readers come only from reliable sourced presence.
 * Full original text is retained without the per-candidate 800-unit limit or a 16-listener truncation.
 */
export interface TavernInterpretationFallback {
  plan: PerspectivePlan;
  broadcast: {
    kind: 'PlayerUtterance';
    actorId: string;
    text: string;
    confidence: number;
    addressees: readonly string[];
    readers: readonly string[];
    source: TavernSourceReference;
    scope: EventOrigin['scope'];
    turnId: string;
    turnRevision: number;
  };
}

function sameScope(left: EventOrigin['scope'], right: EventOrigin['scope']): boolean {
  return left.worldId === right.worldId && left.sessionId === right.sessionId
    && left.branchId === right.branchId && left.characterId === right.characterId;
}

function requireId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_m1_context');
}

function referenceSubset(values: readonly string[], catalog: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new Error('invalid_m1_reference');
  const allowed = new Set(catalog);
  const result = new Set<string>();
  for (const value of values) {
    requireId(value);
    if (!allowed.has(value)) throw new Error('invalid_m1_reference');
    result.add(value);
  }

  return [...result];
}

/**
 * Builds detached input from the engine's current user source and existing perception projection.
 * Throws invalid_m1_context on bad host data/getters, never source text. No model or authority write occurs.
 * Work is linear in source/input bytes and catalog slots, plus the existing perception fold's documented work.
 * There is no chat-wide truncation. References are caller-authorized subsets, checked against local catalogs.
 */
export function buildTavernInterpretationInput(
  request: TavernInterpretationRequest,
  options: TavernInterpretationOptions,
): TavernPreparedInterpretation {
  try {
    const identity = structuredClone(request.identity);
    const message = structuredClone(request.message);
    const supplied = structuredClone(options);
    // The existing engine gives this adapter attempts 0 through 3, sharing its four-attempt retry budget.
    if (message.role !== 'user' || message.id !== identity.playerSource.id
      || message.revision !== identity.playerSource.revision
      || !Number.isSafeInteger(request.attempt) || request.attempt < 0 || request.attempt > 3) {
      throw new Error('invalid_m1_source');
    }
    if (supplied.mode !== 'automatic' && supplied.mode !== 'direct') throw new Error('invalid_m1_mode');
    requireId(supplied.playerId);
    requireId(supplied.ruleVersion);
    requireId(supplied.configurationId);
    if (supplied.perception.playerId !== supplied.playerId
      || !sameScope(identity.scope, supplied.perception.baseline.scope)) {
      throw new Error('invalid_m1_scope');
    }
    const world = projectTavernWorld(supplied.perception.baseline, supplied.perception.steps).world;
    const known = new TavernPerception(supplied.perception).view(supplied.playerId);
    const references = {
      entityIds: referenceSubset(supplied.references.entityIds, world.entityIds),
      itemIds: referenceSubset(supplied.references.itemIds, world.possessions.map(item => item.itemId)),
      placeIds: referenceSubset(supplied.references.placeIds, world.placeIds),
    };
    if (!references.entityIds.includes(supplied.playerId)) throw new Error('invalid_m1_player');
    const context: EventDecodeContext = {
      envelope: {
        id: JSON.stringify([identity.turnId, identity.turnRevision, message.id, message.revision, 'interpret']),
        turnId: identity.turnId,
        beatIndex: 0,
        source: 'interpret',
        status: 'tentative',
      },
      scope: identity.scope,
      turnRevision: identity.turnRevision,
      ruleVersion: supplied.ruleVersion,
      message,
      actorId: supplied.playerId,
      ...references,
      eventReferences: [],
    };
    // The same decoder validates host identity even for a successful empty response, before invoking a runner.
    const checked = decodeInterpretationCandidate({ format: TAVERN_INTERPRETATION_FORMAT, events: [] }, context);
    if (!checked.ok) throw new Error('invalid_m1_context');
    const visibleEntities = new Set(references.entityIds);
    const input: TavernInterpretationInput = {
      format: TAVERN_INTERPRETATION_FORMAT,
      instructions: SLOT_M1_INSTRUCTIONS,
      mode: supplied.mode,
      origin: {
        scope: identity.scope,
        turnRevision: identity.turnRevision,
        sourceId: message.id,
        sourceRevision: message.revision,
        ruleVersion: supplied.ruleVersion,
      },
      configurationId: supplied.configurationId,
      message,
      references,
      presence: {
        known: world.presenceKnown,
        presentIds: world.presentIds.filter(actorId => visibleEntities.has(actorId)),
      },
      known,
    };

    return {
      input: structuredClone(input),
      context: structuredClone(context),
      plan: supplied.plan ?? { observations: [], unresolved: [] },
    };
  } catch {
    throw new Error('invalid_m1_context');
  }
}

/**
 * Adapts exactly one injected M1 attempt for the existing engine port in both automatic and direct modes.
 * Malformed responses/runner failures return retryable; invalid host input or cancellation returns fatal.
 * No cache, retry loop, clock update or acceptance is duplicated here: those belong to the engine/ledger.
 */
export async function interpretTavernPlayer(
  request: TavernInterpretationRequest,
  options: TavernInterpretationOptions,
  runner: TavernInterpretationRunner,
): Promise<TavernInterpretationReply> {
  let prepared: TavernPreparedInterpretation;
  let signal: AbortSignal;
  try {
    signal = request.signal;
    if (signal.aborted) return { kind: 'fatal' };
    prepared = buildTavernInterpretationInput(request, options);
  } catch {
    return { kind: 'fatal' };
  }

  try {
    const raw = await runner(structuredClone(prepared.input), signal);
    if (signal.aborted) return { kind: 'fatal' };
    const decoded = decodeInterpretationCandidate(raw, prepared.context);
    return decoded.ok ? { kind: 'plan', events: decoded.value } : { kind: 'retryable' };
  } catch {
    try {
      return { kind: signal.aborted ? 'fatal' : 'retryable' };
    } catch {
      return { kind: 'fatal' };
    }
  }
}

/**
 * Adapts a durable fallback outcome for prepare; a successful empty interpretation returns null.
 * Validates source/revision/scope before returning the empty plan and low-confidence presence broadcast.
 * Throws invalid_m1_fallback for mismatches/getters. Clock fallback is deliberately untouched.
 * Work is linear in original text/input bytes plus the existing world projection; no text is reinterpreted.
 */
export function buildTavernInterpretationFallback(
  accepted: TavernAcceptedPlayerInterpretation,
  message: AcceptedMessage,
  perception: TavernPerceptionInput,
): TavernInterpretationFallback | null {
  try {
    const current = structuredClone({ accepted, message, perception });
    const turn = current.accepted;
    const metadata = turn.interpretation;
    requireId(turn.turnId);
    requireId(turn.source.id);
    if (!Number.isSafeInteger(turn.turnRevision) || turn.turnRevision < 1
      || !Number.isSafeInteger(turn.source.revision) || turn.source.revision < 1
      || typeof current.message.text !== 'string'
      || !Number.isFinite(current.message.acceptedAtMs) || current.message.acceptedAtMs < 0
      || current.message.acceptedAtMs > Number.MAX_SAFE_INTEGER) {
      throw new Error('invalid_m1_fallback');
    }
    if (turn.kind !== 'interpret' || current.message.role !== 'user'
      || turn.source.id !== current.message.id || turn.source.revision !== current.message.revision
      || metadata.source.id !== turn.source.id || metadata.source.revision !== turn.source.revision
      || metadata.turnRevision !== turn.turnRevision
      || !sameScope(turn.scope, current.perception.baseline.scope)) {
      throw new Error('invalid_m1_fallback');
    }
    if (metadata.outcome === 'success') return null;
    if (metadata.outcome !== 'fallback' || turn.events.length !== 0) throw new Error('invalid_m1_fallback');
    const world = projectTavernWorld(current.perception.baseline, current.perception.steps).world;
    if (!world.entityIds.includes(current.perception.playerId)) throw new Error('invalid_m1_fallback');

    return {
      plan: { observations: [], unresolved: [] },
      broadcast: {
        kind: 'PlayerUtterance',
        actorId: current.perception.playerId,
        text: current.message.text,
        confidence: M1_FALLBACK_CONFIDENCE,
        addressees: [],
        readers: world.presenceKnown ? world.presentIds.filter(id => id !== current.perception.playerId) : [],
        source: turn.source,
        scope: turn.scope,
        turnId: turn.turnId,
        turnRevision: turn.turnRevision,
      },
    };
  } catch {
    throw new Error('invalid_m1_fallback');
  }
}
