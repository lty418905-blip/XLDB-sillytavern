import { createHash } from 'node:crypto';
import type { GeographyCorrectionOperation, GeographyPosition } from '../../common/geography.ts';
import type { Scope } from '../../memory/access.ts';
import type { SceneRoster } from '../types.ts';
import { projectBeatItems } from './codec.ts';
import type { AcceptedTavernTurn, EmittedTavernBeat } from './store.ts';
import type {
  DecodedBeat,
  EngineEvent,
  EventPayload,
  EventReference,
  LinkedBeatEffect,
} from './types.ts';

/** Local source identity, with positive revision; an event address is present only for ledger-derived state. */
export interface TavernProjectionBasis {
  kind: 'existing' | 'card' | 'scene' | 'correction' | 'event';
  scope: Scope;
  sourceId: string;
  sourceRevision: number;
  event?: EventReference;
}

/** Explicit, source-checked presence, independent of roster membership and of the legacy host envelope. */
export interface TavernPresenceSeed {
  basis: TavernProjectionBasis;
  presentIds: readonly string[];
  positions?: readonly { entityId: string; position: GeographyPosition }[] | null;
}

/** A unique existing item's holder; null means unknown, never an inferred owner or a counted asset balance. */
export interface TavernProjectedPossession {
  itemId: string;
  holderId: string | null;
  basis: TavernProjectionBasis;
}

/** One sourced location using the existing geography union; unknown and transit do not imply presence. */
export interface TavernProjectedPosition {
  entityId: string;
  position: GeographyPosition;
  basis: TavernProjectionBasis;
}

/** Detached fold state with SHA-256 replay fingerprints; rebuild from valid sources after history changes. */
export interface TavernWorldSnapshot {
  scope: Scope;
  entityIds: readonly string[];
  placeIds: readonly string[];
  presenceKnown: boolean;
  presenceSeeds: readonly TavernPresenceSeed[];
  presentIds: readonly string[];
  positions: readonly TavernProjectedPosition[];
  possessions: readonly TavernProjectedPossession[];
  applied: readonly { key: string; fingerprint: string }[];
}

/** Bootstrap catalogs are identities, not presence evidence. Null optional inputs are equivalent to omission. */
export interface TavernWorldBootstrap {
  scope: Scope;
  roster: SceneRoster;
  playerId: string;
  placeIds: readonly string[];
  existing?: TavernPresenceSeed | null;
  settings?: readonly TavernPresenceSeed[] | null;
  possessions?: readonly TavernProjectedPossession[] | null;
}

/**
 * A caller-validated player correction using the existing position operation.
 * basis.sourceId identifies the correction record, not a shared message; source ordering is caller-owned.
 */
export interface TavernPositionCorrection {
  basis: TavernProjectionBasis;
  operation: Extract<GeographyCorrectionOperation, { kind: 'position' }>;
}

/** Ordered inputs from the ledger, actual emission selection, or existing correction path; never raw candidates. */
export type TavernProjectionStep =
  | { kind: 'accepted'; turn: AcceptedTavernTurn }
  | { kind: 'emitted'; selection: EmittedTavernBeat }
  | { kind: 'correction'; correction: TavernPositionCorrection };

/**
 * Pre-effect/item presence for downstream perception, with original structural indices and no prose.
 * presentIds is spatial state, not permission to read an event; the perception consumer must also filter readers.
 */
export interface TavernProjectionPhase {
  reference: EventReference;
  beatIndex: number;
  phase: 'event' | 'beforeItem' | 'item' | 'afterItem';
  itemRef?: number;
  effectIndex?: number;
  presenceKnown: boolean;
  presentIds: readonly string[];
  positions: readonly TavernProjectedPosition[];
}

/** Pure overlay result. Cancel by discarding it and retaining the input baseline; no authority writes occur. */
export interface TavernWorldProjection {
  world: TavernWorldSnapshot;
  phases: readonly TavernProjectionPhase[];
}

function requireIdentity(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('invalid_projection_identity');
  }
}

function requireInteger(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError('invalid_projection_integer');
  }
}

function scopeIdentity(scope: Scope): string {
  const values = [scope.worldId, scope.sessionId, scope.branchId, scope.characterId];
  values.forEach(requireIdentity);
  return JSON.stringify(values);
}

function requireScope(scope: Scope, expected: Scope): void {
  if (scopeIdentity(scope) !== scopeIdentity(expected)) {
    throw new Error('projection_scope_mismatch');
  }
}

function normalizeBasis(basis: TavernProjectionBasis, scope: Scope): TavernProjectionBasis {
  requireScope(basis.scope, scope);
  requireIdentity(basis.sourceId);
  requireInteger(basis.sourceRevision, 1);
  return {
    kind: basis.kind,
    scope: basis.scope,
    sourceId: basis.sourceId,
    sourceRevision: basis.sourceRevision,
    ...(basis.event == null ? {} : { event: basis.event }),
  };
}

function requireMember(value: string, catalog: ReadonlySet<string>): void {
  requireIdentity(value);
  if (!catalog.has(value)) {
    throw new Error('projection_unknown_identity');
  }
}

function normalizePosition(position: GeographyPosition, places: ReadonlySet<string>): GeographyPosition {
  if (position.state === 'at' || position.state === 'within') {
    requireMember(position.placeId, places);
    return { state: position.state, placeId: position.placeId };
  }

  if (position.state === 'unknown') {
    return { state: 'unknown' };
  }

  if (position.state !== 'in_transit') {
    throw new TypeError('invalid_projection_position');
  }

  const result: GeographyPosition = { state: 'in_transit' };
  for (const field of ['routeId', 'fromId', 'toId'] as const) {
    const value = position[field];
    if (value == null) continue;
    requireIdentity(value);
    if (field !== 'routeId') requireMember(value, places);
    result[field] = value;
  }
  return result;
}

/**
 * Builds a detached baseline from locally verified sources in O(catalog + seed + possession bytes).
 * Existing presence, including an explicitly empty set, takes precedence over all opening settings.
 * Missing presence stays unknown. Invalid scope, identities, revisions or getter failures throw without writes.
 */
export function bootstrapTavernWorld(input: TavernWorldBootstrap): TavernWorldSnapshot {
  const copied = structuredClone(input);
  scopeIdentity(copied.scope);
  requireIdentity(copied.playerId);
  const entities = new Set([copied.playerId, ...copied.roster.characters.map(character => character.id)]);
  entities.forEach(requireIdentity);
  const places = new Set(copied.placeIds);
  places.forEach(requireIdentity);
  const present = new Set<string>();
  const positions = new Map<string, TavernProjectedPosition>();
  const possessions = new Map<string, TavernProjectedPossession>();
  const seeds = copied.existing != null ? [copied.existing] : copied.settings ?? [];
  const presenceSeeds: TavernPresenceSeed[] = [];

  for (const seed of seeds) {
    const basis = normalizeBasis(seed.basis, copied.scope);
    const allowed = copied.existing != null
      ? seed.basis.kind === 'existing'
      : seed.basis.kind === 'card' || seed.basis.kind === 'scene';
    if (!allowed) throw new Error('invalid_projection_seed');

    for (const entityId of seed.presentIds) {
      requireMember(entityId, entities);
      present.add(entityId);
    }

    const seedPositions = [];
    for (const entry of seed.positions ?? []) {
      requireMember(entry.entityId, entities);
      const position = normalizePosition(entry.position, places);
      seedPositions.push({ entityId: entry.entityId, position });
      positions.set(entry.entityId, {
        entityId: entry.entityId,
        position,
        basis,
      });
    }
    presenceSeeds.push({
      basis,
      presentIds: seed.presentIds,
      ...(seed.positions == null ? {} : { positions: seedPositions }),
    });
  }

  for (const entry of copied.possessions ?? []) {
    requireIdentity(entry.itemId);
    const basis = normalizeBasis(entry.basis, copied.scope);
    if (possessions.has(entry.itemId)) throw new Error('projection_duplicate_item');
    // Holders may be actors, places, or another catalogued unique item; null remains unknown.
    possessions.set(entry.itemId, { itemId: entry.itemId, holderId: entry.holderId, basis });
  }
  const holders = new Set([...entities, ...places, ...possessions.keys()]);
  for (const entry of possessions.values()) {
    if (entry.holderId !== null) requireMember(entry.holderId, holders);
  }

  return {
    scope: copied.scope,
    entityIds: [...entities],
    placeIds: [...places],
    presenceKnown: seeds.length > 0,
    presenceSeeds,
    presentIds: [...present],
    positions: [...positions.values()],
    possessions: [...possessions.values()],
    applied: [],
  };
}

/**
 * Folds ordered, already locally validated ledger/emission/correction records into an isolated overlay.
 * Supply the event suffix after the baseline; continuing from a returned snapshot retains replay identities.
 * Work is O(input bytes + events + items + effects + output snapshot bytes); there is no chat-wide cap.
 * No text, model, director switch, database, clock or callback is consulted. Non-position components remain
 * owned by their existing consumers. Invalid provenance, replay conflicts or state preconditions throw;
 * the baseline and all inputs remain unchanged, including when getters throw during the initial copy.
 */
export function projectTavernWorld(
  baseline: TavernWorldSnapshot,
  steps: readonly TavernProjectionStep[],
): TavernWorldProjection {
  const world = structuredClone(baseline);
  const copiedSteps = structuredClone(steps);
  scopeIdentity(world.scope);
  const entities = new Set(world.entityIds);
  const places = new Set(world.placeIds);
  const present = new Set(world.presentIds);
  const positions = new Map(world.positions.map(entry => [entry.entityId, entry]));
  const possessions = new Map(world.possessions.map(entry => [entry.itemId, entry]));
  const holders = new Set([...entities, ...places, ...possessions.keys()]);
  const applied = new Map(world.applied.map(entry => [entry.key, entry.fingerprint]));
  const phases: TavernProjectionPhase[] = [];

  function remember(keyParts: readonly unknown[], value: unknown): boolean {
    const key = JSON.stringify(keyParts);
    // Replay checking must not copy private speech into the downstream world projection.
    const fingerprint = createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
    const previous = applied.get(key);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error('projection_replay_conflict');
      return false;
    }
    applied.set(key, fingerprint);
    return true;
  }

  function eventBasis(event: EngineEvent | DecodedBeat): TavernProjectionBasis {
    requireScope(event.origin.scope, world.scope);
    requireIdentity(event.envelope.id);
    requireIdentity(event.envelope.turnId);
    requireIdentity(event.origin.sourceId);
    requireIdentity(event.origin.ruleVersion);
    requireInteger(event.origin.turnRevision, 1);
    requireInteger(event.origin.sourceRevision, 1);
    requireInteger(event.envelope.beatIndex, event.envelope.source === 'interpret' ? 0 : 1);
    if (event.envelope.source === 'interpret' && event.envelope.beatIndex !== 0) {
      throw new Error('projection_turn_mismatch');
    }
    return {
      kind: 'event',
      scope: event.origin.scope,
      sourceId: event.origin.sourceId,
      sourceRevision: event.origin.sourceRevision,
      event: {
        turnId: event.envelope.turnId,
        turnRevision: event.origin.turnRevision,
        eventId: event.envelope.id,
      },
    };
  }

  function recordPhase(
    event: EngineEvent | DecodedBeat,
    basis: TavernProjectionBasis,
    phase: TavernProjectionPhase['phase'],
    itemRef?: number,
    effectIndex?: number,
  ): void {
    phases.push({
      reference: { ...basis.event! },
      beatIndex: event.envelope.beatIndex,
      phase,
      ...(itemRef == null ? {} : { itemRef }),
      ...(effectIndex == null ? {} : { effectIndex }),
      presenceKnown: world.presenceKnown,
      presentIds: [...present],
      positions: structuredClone([...positions.values()]),
    });
  }

  function applyPayload(payload: EventPayload, basis: TavernProjectionBasis): void {
    if (payload.kind === 'Enter' || payload.kind === 'Exit') {
      requireMember(payload.entityId, entities);
      requireMember(payload.placeId, places);
      const previous = positions.get(payload.entityId)?.position;
      // An accepted arrival sets its destination; only a departure must match the location it leaves.
      if (payload.kind === 'Exit' && previous && (previous.state === 'at' || previous.state === 'within')
        && previous.placeId !== payload.placeId) {
        throw new Error('projection_location_mismatch');
      }
      if (payload.kind === 'Enter') {
        present.add(payload.entityId);
        positions.set(payload.entityId, {
          entityId: payload.entityId,
          position: { state: 'at', placeId: payload.placeId },
          basis,
        });
      } else {
        if (!present.has(payload.entityId)) throw new Error('projection_absent_entity');
        present.delete(payload.entityId);
        positions.set(payload.entityId, { entityId: payload.entityId, position: { state: 'unknown' }, basis });
      }
      world.presenceKnown = true;
    } else if (payload.kind === 'Transfer') {
      const item = possessions.get(payload.itemId);
      if (!item || item.holderId !== payload.fromId) throw new Error('projection_holder_mismatch');
      requireMember(payload.toId, holders);
      possessions.set(payload.itemId, { itemId: payload.itemId, holderId: payload.toId, basis });
    }
  }

  function applyBeat(beat: DecodedBeat, emittedItemRefs: readonly number[]): void {
    const basis = eventBasis(beat);
    const projected = projectBeatItems(beat, emittedItemRefs);
    if (!projected.ok) throw new Error(projected.reason);
    const address = [beat.envelope.turnId, beat.origin.turnRevision, beat.envelope.id];

    function applyEffect(link: LinkedBeatEffect): void {
      const fresh = remember([...address, 'effect', link.effectIndex], {
        origin: beat.origin,
        beatIndex: beat.envelope.beatIndex,
        link,
      });
      if (!fresh) return;
      // Observers are determined from the pre-effect state, especially for exits and arrivals.
      recordPhase(beat, basis, link.phase, link.itemRef, link.effectIndex);
      applyPayload(link.effect, basis);
    }

    for (const entry of projected.value) {
      // Record the entire linked item before any effect so changed replay content cannot partly apply.
      const fresh = remember([...address, 'item', entry.item.itemIndex], {
        origin: beat.origin,
        beatIndex: beat.envelope.beatIndex,
        entry,
      });
      if (!fresh) continue;
      for (const effect of entry.beforeItem) applyEffect(effect);
      recordPhase(beat, basis, 'item', entry.item.itemIndex);
      for (const effect of entry.afterItem) applyEffect(effect);
    }
  }

  function requireTurnEvent(turn: AcceptedTavernTurn, event: EngineEvent | DecodedBeat): void {
    if (event.envelope.status !== 'accepted'
      || event.envelope.turnId !== turn.turnId
      || event.origin.turnRevision !== turn.turnRevision
      || event.envelope.source !== (turn.kind === 'interpret' ? 'interpret' : 'beat')) {
      throw new Error('projection_turn_mismatch');
    }
    if (turn.kind === 'interpret' && (event.origin.sourceId !== turn.source.id
      || event.origin.sourceRevision !== turn.source.revision)) {
      throw new Error('projection_source_mismatch');
    }
  }

  for (const step of copiedSteps) {
    if (step.kind === 'accepted') {
      const turn = step.turn;
      requireScope(turn.scope, world.scope);
      requireInteger(turn.version, 1);
      requireInteger(turn.turnRevision, 1);
      requireIdentity(turn.turnId);
      requireIdentity(turn.source.id);
      requireInteger(turn.source.revision, 1);
      if (turn.kind === 'interpret') {
        for (const event of turn.events) {
          requireTurnEvent(turn, event);
          const basis = eventBasis(event);
          const fresh = remember(
            [turn.turnId, turn.turnRevision, event.envelope.id, 'event'],
            { origin: event.origin, beatIndex: event.envelope.beatIndex, payload: event.payload },
          );
          if (!fresh) continue;
          recordPhase(event, basis, 'event');
          applyPayload(event.payload, basis);
        }
      } else {
        for (const beat of turn.beats) {
          requireTurnEvent(turn, beat);
          applyBeat(beat, beat.items.map(item => item.itemIndex));
        }
      }
    } else if (step.kind === 'emitted') {
      const { beat, emittedItemRefs } = step.selection;
      if (beat.envelope.status !== 'tentative' || beat.envelope.source !== 'beat') {
        throw new Error('projection_emission_mismatch');
      }
      applyBeat(beat, emittedItemRefs);
    } else if (step.kind === 'correction') {
      const { operation } = step.correction;
      const basis = normalizeBasis(step.correction.basis, world.scope);
      if (basis.kind !== 'correction' || operation.kind !== 'position' || operation.action !== 'set') {
        throw new Error('invalid_projection_correction');
      }
      requireMember(operation.actorId, entities);
      const position = normalizePosition(operation.position, places);
      const fresh = remember(
        ['correction', basis.sourceId, basis.sourceRevision],
        { basis, operation: { ...operation, position } },
      );
      if (!fresh) {
        continue;
      }
      positions.set(operation.actorId, { entityId: operation.actorId, position, basis });
      if (position.state === 'at' || position.state === 'within') {
        present.add(operation.actorId);
      } else {
        present.delete(operation.actorId);
      }
      world.presenceKnown = true;
    } else {
      throw new TypeError('invalid_projection_step');
    }
  }

  world.presentIds = [...present];
  world.positions = [...positions.values()];
  world.possessions = [...possessions.values()];
  world.applied = [...applied].map(([key, fingerprint]) => ({ key, fingerprint }));
  return { world, phases };
}
