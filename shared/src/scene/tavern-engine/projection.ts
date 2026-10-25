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

/**
 * Source-checked presence independent of roster membership and of the legacy host envelope.
 * Selected seeds source the player unless any explicitly marks absence; null means omission.
 * Explicit true and false together reject the selected set rather than resolving by order.
 */
export interface TavernPresenceSeed {
  basis: TavernProjectionBasis;
  presentIds: readonly string[];
  playerPresent?: boolean | null;
  positions?: readonly { entityId: string; position: GeographyPosition }[] | null;
}

/** Unique-item state; null holder means unknown or, with consumed=true, a sourced consumption tombstone. */
export interface TavernProjectedPossession {
  itemId: string;
  holderId: string | null;
  basis: TavernProjectionBasis;
  /** True is a consumed tombstone with a null holder; null/omission means not consumed. */
  consumed?: boolean | null;
  /** Optional locally sourced visibility restriction; null/omission adds no restriction. */
  readers?: readonly string[] | null;
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

/**
 * Catalogs provide identities only. A supplied presence seed also sources the player's initial presence,
 * unless explicitly marked absent; without any seed presence stays unknown. Null optionals mean omission.
 */
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
  if (result.routeId == null && (result.fromId == null || result.toId == null)) {
    throw new TypeError('invalid_projection_position');
  }
  return result;
}


interface ProjectionState {
  world: TavernWorldSnapshot;
  entities: ReadonlySet<string>;
  places: ReadonlySet<string>;
  present: Set<string>;
  positions: Map<string, TavernProjectedPosition>;
  possessions: Map<string, TavernProjectedPossession>;
  holders: ReadonlySet<string>;
}

// A holder graph has at most one outgoing edge per unique item. Each node is visited once, O(items).
function requireAcyclicPossessions(
  possessions: ReadonlyMap<string, TavernProjectedPossession>,
  terminals: ReadonlySet<string>,
): void {
  const complete = new Set<string>();
  for (const itemId of possessions.keys()) {
    const visiting = new Set<string>();
    let current: string | null = itemId;
    while (current !== null && possessions.has(current) && !complete.has(current)) {
      if (visiting.has(current)) throw new Error('projection_container_cycle');
      visiting.add(current);
      current = possessions.get(current)!.holderId;
      // Existing catalogs permit the same spelling for actor/item IDs; actors and places are terminal holders.
      if (current !== null && terminals.has(current)) break;
    }
    for (const visited of visiting) complete.add(visited);
  }
}

function readable(item: TavernProjectedPossession, actorId: string): boolean {
  return item.readers == null || item.readers.includes(actorId);
}

function requireItemControl(state: ProjectionState, item: TavernProjectedPossession, actorId: string): void {
  requireMember(actorId, state.entities);
  let current = item;
  const visited = new Set<string>();
  while (true) {
    requireScope(current.basis.scope, state.world.scope);
    if (current.consumed === true) throw new Error('projection_item_consumed');
    if (!readable(current, actorId)) throw new Error('projection_item_not_visible');
    if (visited.has(current.itemId)) throw new Error('projection_container_cycle');
    visited.add(current.itemId);
    const holderId = current.holderId;
    if (holderId === actorId) return;
    if (holderId !== null && state.places.has(holderId)) {
      const position = state.positions.get(actorId)?.position;
      if (state.present.has(actorId) && position != null
        && (position.state === 'at' || position.state === 'within') && position.placeId === holderId) return;
      throw new Error('projection_actor_not_allowed');
    }
    if (holderId !== null && state.entities.has(holderId)) throw new Error('projection_actor_not_allowed');
    const container = holderId === null ? undefined : state.possessions.get(holderId);
    if (container == null) throw new Error('projection_actor_not_allowed');
    current = container;
  }
}

function applyWorldPayload(state: ProjectionState, payload: EventPayload, basis: TavernProjectionBasis): void {
  const { world, entities, places, present, positions, possessions, holders } = state;
  requireScope(basis.scope, world.scope);
  if (payload.kind === 'Enter' || payload.kind === 'Exit') {
    requireMember(payload.entityId, entities);
    requireMember(payload.placeId, places);
    const previous = positions.get(payload.entityId)?.position;
    // Arrivals set destinations; departures must match the location being left.
    if (payload.kind === 'Exit' && previous && (previous.state === 'at' || previous.state === 'within')
      && previous.placeId !== payload.placeId) throw new Error('projection_location_mismatch');
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
    return;
  }
  if (payload.kind !== 'Transfer' && payload.kind !== 'ConsumeItem') return;
  const item = possessions.get(payload.itemId);
  if (item == null) throw new Error('projection_holder_mismatch');
  if (item.consumed === true) throw new Error('projection_item_consumed');
  if (payload.kind === 'Transfer' && item.holderId !== payload.fromId) {
    throw new Error('projection_holder_mismatch');
  }
  requireItemControl(state, item, payload.actorId);
  if (payload.kind === 'ConsumeItem') {
    possessions.set(payload.itemId, { ...item, holderId: null, consumed: true, basis });
    return;
  }
  requireMember(payload.toId, holders);
  const actorPosition = positions.get(payload.actorId)?.position;
  const actorPlaceId = present.has(payload.actorId) && actorPosition != null
    && (actorPosition.state === 'at' || actorPosition.state === 'within')
    ? actorPosition.placeId : null;
  let destination: string | null = payload.toId;
  // A move can create a cycle only on the new destination's ancestor chain, O(container depth).
  while (destination !== null) {
    if (entities.has(destination)) {
      const recipientPosition = positions.get(destination)?.position;
      if (actorPlaceId === null || !present.has(destination) || recipientPosition == null
        || (recipientPosition.state !== 'at' && recipientPosition.state !== 'within')
        || recipientPosition.placeId !== actorPlaceId) {
        throw new Error('projection_destination_not_accessible');
      }
      break;
    }
    if (places.has(destination)) {
      if (actorPlaceId !== destination) throw new Error('projection_destination_not_accessible');
      break;
    }
    if (destination === payload.itemId) throw new Error('projection_container_cycle');
    const container = possessions.get(destination);
    if (container == null) break;
    requireScope(container.basis.scope, world.scope);
    if (container.consumed === true) throw new Error('projection_item_consumed');
    if (!readable(container, payload.actorId)) throw new Error('projection_item_not_visible');
    destination = container.holderId;
  }
  // A known container with an unknown ultimate holder does not establish physical reachability.
  if (destination === null) throw new Error('projection_destination_not_accessible');
  possessions.set(payload.itemId, { ...item, holderId: payload.toId, basis });
}

function projectionState(world: TavernWorldSnapshot): ProjectionState {
  const entities = new Set(world.entityIds);
  const places = new Set(world.placeIds);
  const possessions = new Map<string, TavernProjectedPossession>();
  for (const entry of world.possessions) {
    if (possessions.has(entry.itemId)) throw new Error('projection_duplicate_item');
    requireScope(entry.basis.scope, world.scope);
    if (entry.consumed != null && typeof entry.consumed !== 'boolean') {
      throw new TypeError('invalid_projection_consumed');
    }
    if (entry.consumed === true && entry.holderId !== null) throw new Error('projection_consumed_holder');
    if (entry.readers != null && !Array.isArray(entry.readers)) throw new TypeError('invalid_projection_readers');
    for (const reader of entry.readers ?? []) requireMember(reader, entities);
    possessions.set(entry.itemId, entry);
  }
  return {
    world,
    entities,
    places,
    present: new Set(world.presentIds),
    positions: new Map(world.positions.map(entry => [entry.entityId, entry])),
    possessions,
    holders: new Set([...entities, ...places, ...possessions.keys()]),
  };
}

/**
 * Detaches only ownership inputs, reading each needed caller field once; live Proxy arrays are supported.
 * Scope, presence, location and possession data are retained. Replay history and source metadata are not read.
 * Work/memory are O(catalog + positions + possessions + reader entries), with no chat-length limit.
 * Getter failures propagate unchanged; this helper performs no authority writes or full-world clone.
 */
export function snapshotTavernPossessionWorld(world: TavernWorldSnapshot): TavernWorldSnapshot {
  const scopes = new Map<Scope, Scope>();
  const basisScopes = new Map<TavernProjectionBasis, Scope>();
  const readerLists = new Map<readonly string[], readonly string[]>();
  const positionValues = new Map<GeographyPosition, GeographyPosition>();

  function snapshotScope(value: Scope): Scope {
    let snapshot = scopes.get(value);
    if (snapshot === undefined) {
      const { worldId, sessionId, branchId, characterId } = value;
      snapshot = { worldId, sessionId, branchId, characterId };
      scopes.set(value, snapshot);
    }
    return snapshot;
  }

  const scope = snapshotScope(world.scope);
  const entityIds = [...world.entityIds];
  const placeIds = [...world.placeIds];
  const presentIds = [...world.presentIds];
  const positions = world.positions.map(entry => {
    const { entityId, position } = entry;
    let snapshot = positionValues.get(position);
    if (snapshot === undefined) {
      const positionState = position.state;
      const positionSnapshot: GeographyPosition = positionState === 'at' || positionState === 'within'
        ? { state: positionState, placeId: position.placeId }
        : { state: positionState };
      positionValues.set(position, positionSnapshot);
      snapshot = positionSnapshot;
    }
    return {
      entityId,
      position: snapshot,
      basis: { kind: 'existing' as const, scope, sourceId: 'ownership-check', sourceRevision: 1 },
    };
  });
  const possessions = world.possessions.map(entry => {
    const { itemId, holderId, basis, consumed, readers } = entry;
    let itemScope = basisScopes.get(basis);
    if (itemScope === undefined) {
      itemScope = snapshotScope(basis.scope);
      basisScopes.set(basis, itemScope);
    }
    let readerSnapshot: readonly string[] | undefined;
    if (readers != null) {
      if (!Array.isArray(readers)) throw new TypeError('invalid_projection_readers');
      readerSnapshot = readerLists.get(readers);
      if (readerSnapshot === undefined) {
        readerSnapshot = [...readers];
        readerLists.set(readers, readerSnapshot);
      }
    }
    return {
      itemId,
      holderId,
      basis: { kind: 'existing' as const, scope: itemScope, sourceId: 'ownership-check', sourceRevision: 1 },
      ...(consumed == null ? {} : { consumed }),
      ...(readerSnapshot === undefined ? {} : { readers: readerSnapshot }),
    };
  });

  // Presence provenance and replay fingerprints do not participate in an ownership precheck.
  return {
    scope,
    entityIds,
    placeIds,
    presenceKnown: true,
    presenceSeeds: [],
    presentIds,
    positions,
    possessions,
    applied: [],
  };
}

/**
 * Checks one decoded ownership effect against the exact sourced snapshot without writes.
 * Null means valid; failures return a content-free projection reason. Getter/payload-clone failures propagate.
 * O(ownership input bytes + container depth); no source-text scan or chat-length limit is introduced.
 */
export function checkTavernPossessionEffect(world: TavernWorldSnapshot, payload: EventPayload): string | null {
  const copied = { world: snapshotTavernPossessionWorld(world), payload: structuredClone(payload) };
  const state = projectionState(copied.world);
  requireAcyclicPossessions(state.possessions, new Set([...state.entities, ...state.places]));
  try {
    applyWorldPayload(state, copied.payload, {
      kind: 'existing',
      scope: copied.world.scope,
      sourceId: 'ownership-check',
      sourceRevision: 1,
    });
    return null;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('projection_')) throw error;
    return error.message;
  }
}

/** Local checkBeat result, using original item/effect indices and content-free reasons; no renderable text. */
export type TavernPossessionBeatCheck =
  | { kind: 'valid' }
  | { kind: 'invalid_actions'; actions: readonly { itemRef: number; reason: string }[] }
  | {
    kind: 'invalid_effects';
    effects: readonly { effectIndex: number; reason: string }[];
    actions: readonly { itemRef: number; reason: string }[];
  };

/** Already validated engine exclusions, using original zero-based indices and content-free reason codes. */
export interface TavernPossessionExclusions {
  actions: readonly { itemRef: number; reason: string }[];
  effects: readonly { effectIndex: number; reason: string }[];
}

/**
 * Checks a decoded beat in item/phase order, including dependencies lost when an action is excluded.
 * Null exclusions mean none; supplied exclusions must already be validated against this beat.
 * The existing engine owns the single retry and Unknown diagnostics. No prompts or model calls occur.
 * At most six items/effects enter from the codec: O(snapshot bytes * 7 + 42 * container depth).
 * Scope/clone errors propagate. Invalid effects return their original indices without private state values.
 */
export function checkTavernPossessionBeat(
  world: TavernWorldSnapshot,
  beat: DecodedBeat,
  excluded: TavernPossessionExclusions | null = null,
): TavernPossessionBeatCheck {
  const input = { world: snapshotTavernPossessionWorld(world), beat: structuredClone(beat) };
  requireScope(input.beat.origin.scope, input.world.scope);
  const actions = new Map((excluded?.actions ?? []).map(entry => [entry.itemRef, entry.reason]));
  const effects = new Map((excluded?.effects ?? []).map(entry => [entry.effectIndex, entry.reason]));
  // Unknown invalidates its action before any earlier link can supply a prerequisite to another item.
  // Engine exclusions also include non-ownership checks; each pass must start from the same removed set.
  for (const link of input.beat.effects) {
    if (link.effect.kind !== 'Unknown') continue;
    const item = input.beat.items.find(entry => entry.itemIndex === link.itemRef);
    if (item?.kind === 'action') {
      if (!actions.has(link.itemRef)) actions.set(link.itemRef, link.effect.reason);
    } else {
      effects.set(link.effectIndex, link.effect.reason);
    }
  }
  let changed: boolean;
  do {
    changed = false;
    const state = projectionState(structuredClone(input.world));
    requireAcyclicPossessions(state.possessions, new Set([...state.entities, ...state.places]));
    const selected = projectBeatItems(input.beat, input.beat.items
      .filter(item => !actions.has(item.itemIndex)).map(item => item.itemIndex));
    if (!selected.ok) throw new Error(selected.reason);
    for (const entry of selected.value) {
      for (const link of [...entry.beforeItem, ...entry.afterItem]) {
        if (effects.has(link.effectIndex)) continue;
        try {
          if (link.effect.actorId !== input.beat.actorId) throw new Error('projection_actor_not_allowed');
          applyWorldPayload(state, link.effect, {
            kind: 'event',
            scope: input.beat.origin.scope,
            sourceId: input.beat.origin.sourceId,
            sourceRevision: input.beat.origin.sourceRevision,
          });
        } catch (error) {
          if (!(error instanceof Error) || !error.message.startsWith('projection_')) throw error;
          effects.set(link.effectIndex, error.message);
          if (entry.item.kind === 'action' && !actions.has(entry.item.itemIndex)) {
            actions.set(entry.item.itemIndex, error.message);
            changed = true;
          }
        }
      }
    }
  } while (changed);
  if (effects.size === 0) {
    return actions.size === 0 ? { kind: 'valid' } : {
      kind: 'invalid_actions',
      actions: [...actions].map(([itemRef, reason]) => ({ itemRef, reason })),
    };
  }
  return {
    kind: 'invalid_effects',
    effects: [...effects].map(([effectIndex, reason]) => ({ effectIndex, reason })),
    actions: [...actions].map(([itemRef, reason]) => ({ itemRef, reason })),
  };
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
  const explicitPresence = seeds.some(seed => seed.playerPresent === true);
  const explicitAbsence = seeds.some(seed => seed.playerPresent === false);
  if (explicitPresence && explicitAbsence) throw new Error('invalid_projection_seed');

  for (const seed of seeds) {
    const basis = normalizeBasis(seed.basis, copied.scope);
    const allowed = copied.existing != null
      ? seed.basis.kind === 'existing'
      : seed.basis.kind === 'card' || seed.basis.kind === 'scene';
    if (!allowed) throw new Error('invalid_projection_seed');

    if (seed.playerPresent != null && typeof seed.playerPresent !== 'boolean') {
      throw new Error('invalid_projection_seed');
    }
    // An explicit absence applies to the selected scene, including seeds with an omitted default.
    // Every retained seed uses the same decision so its provenance cannot reintroduce the player.
    const seedPresentIds = [...new Set(explicitAbsence
      ? seed.presentIds.filter(entityId => entityId !== copied.playerId)
      : [...seed.presentIds, copied.playerId])];
    for (const entityId of seed.presentIds) {
      requireMember(entityId, entities);
    }
    for (const entityId of seedPresentIds) {
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
      presentIds: seedPresentIds,
      ...(seed.playerPresent == null ? {} : { playerPresent: seed.playerPresent }),
      ...(seed.positions == null ? {} : { positions: seedPositions }),
    });
  }

  for (const entry of copied.possessions ?? []) {
    // Counted inventory belongs to the ledger and never acquires a second unique-item authority.
    if (Object.hasOwn(entry, 'count')) continue;
    requireIdentity(entry.itemId);
    const basis = normalizeBasis(entry.basis, copied.scope);
    if (possessions.has(entry.itemId)) throw new Error('projection_duplicate_item');
    // Holders may be actors, places, or another catalogued unique item; null remains unknown.
    if (entry.consumed != null && typeof entry.consumed !== 'boolean') {
      throw new TypeError('invalid_projection_consumed');
    }
    if (entry.consumed === true && entry.holderId !== null) throw new Error('projection_consumed_holder');
    if (entry.readers != null && !Array.isArray(entry.readers)) throw new TypeError('invalid_projection_readers');
    for (const reader of entry.readers ?? []) requireMember(reader, entities);
    possessions.set(entry.itemId, {
      itemId: entry.itemId,
      holderId: entry.holderId,
      basis,
      ...(entry.consumed == null ? {} : { consumed: entry.consumed }),
      ...(entry.readers == null ? {} : { readers: [...new Set(entry.readers)] }),
    });
  }
  const holders = new Set([...entities, ...places, ...possessions.keys()]);
  for (const entry of possessions.values()) {
    if (entry.holderId !== null) requireMember(entry.holderId, holders);
  }

  requireAcyclicPossessions(possessions, new Set([...entities, ...places]));

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
 * Work is O(input/output bytes + events + items + effects * container depth); there is no chat-wide cap.
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
  const state = projectionState(world);
  const { entities, places, present, positions, possessions } = state;
  requireAcyclicPossessions(possessions, new Set([...entities, ...places]));
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
    applyWorldPayload(state, payload, basis);
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

/** Actor-visible mutable holdings and locations only; every entry retains its authority basis. */
export interface TavernActorWorldProjection {
  actorId: string;
  positions: readonly TavernProjectedPosition[];
  possessions: readonly TavernProjectedPossession[];
}

/**
 * Projects the current world through this actor's observation copies. Existing self-state is known;
 * event-derived changes require the matching observed effect, not merely another item in the same beat.
 * Other actors' seed state stays private. O(world entries + observations); no history is folded here.
 * Unknown actors/scope mismatches throw; inputs and returned values never share mutable objects.
 */
export function projectTavernActorWorld(
  world: TavernWorldSnapshot,
  view: import('./types.ts').TavernActorEventView,
): TavernActorWorldProjection {
  if (!world.entityIds.includes(view.actorId)) throw new Error('projection_unknown_actor');
  const knownPositions = new Set<string>();
  const knownHolders = new Set<string>();
  const key = (reference: EventReference, entityId: string, value: unknown): string => JSON.stringify([
    reference.turnId,
    reference.turnRevision,
    reference.eventId,
    entityId,
    value,
  ]);

  for (const event of [...view.inbox, ...view.authoredEvents]) {
    const content = event.content;
    if (content.kind === 'Enter' || content.kind === 'Exit') {
      knownPositions.add(key(event.source, content.entityId, content.kind === 'Enter'
        ? { state: 'at', placeId: content.placeId }
        : { state: 'unknown' }));
    } else if (content.kind === 'Transfer') {
      knownHolders.add(key(event.source, content.itemId, content.toId));
    } else if (content.kind === 'ConsumeItem') {
      knownHolders.add(key(event.source, content.itemId, null));
    }
  }

  function sourced(basis: TavernProjectionBasis): void {
    requireScope(basis.scope, world.scope);
  }

  return structuredClone({
    actorId: view.actorId,
    positions: world.positions.filter(entry => {
      sourced(entry.basis);
      if (entry.basis.kind !== 'event') return entry.entityId === view.actorId;
      return entry.basis.event != null
        && knownPositions.has(key(entry.basis.event, entry.entityId, entry.position));
    }),
    possessions: world.possessions.filter(entry => {
      sourced(entry.basis);
      if (!readable(entry, view.actorId)) return false;
      if (entry.basis.kind !== 'event') return entry.holderId === view.actorId;
      return entry.basis.event != null
        && knownHolders.has(key(entry.basis.event, entry.itemId, entry.holderId));
    }),
  });
}
