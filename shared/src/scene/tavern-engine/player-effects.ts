import type { Scope } from '../../memory/access.ts';
import type { TavernWorldSnapshot } from './projection.ts';
import type { DecodeIssue, EngineEvent, EventPayload } from './types.ts';

/** Current authority projection before player acceptance; firstTurn means no accepted turn in this scope. */
export interface TavernPlayerWorld {
  world: TavernWorldSnapshot;
  firstTurn: boolean;
}

function requireShape(condition: boolean): asserts condition {
  if (!condition) throw new TypeError('world_unavailable');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sameScope(value: unknown, expected: Scope): boolean {
  return object(value) && ['worldId', 'sessionId', 'branchId', 'characterId'].every(field =>
    Object.hasOwn(value, field) && identity(value[field]) && value[field] === expected[field as keyof Scope]);
}

function identities(values: unknown): Set<string> {
  requireShape(Array.isArray(values));
  const result = new Set<string>();
  for (const value of values) {
    requireShape(identity(value) && !result.has(value));
    result.add(value);
  }
  return result;
}

function checkBasis(basis: unknown, scope: Scope): void {
  requireShape(object(basis) && sameScope(basis.scope, scope)
    && typeof basis.kind === 'string' && ['existing', 'card', 'scene', 'correction', 'event'].includes(basis.kind)
    && identity(basis.sourceId) && typeof basis.sourceRevision === 'number'
    && Number.isSafeInteger(basis.sourceRevision) && basis.sourceRevision >= 1);
  if (basis.event != null) {
    requireShape(object(basis.event) && identity(basis.event.turnId) && identity(basis.event.eventId)
      && typeof basis.event.turnRevision === 'number'
      && Number.isSafeInteger(basis.event.turnRevision) && basis.event.turnRevision >= 1);
  }
}

function checkPosition(value: unknown, places: ReadonlySet<string>): void {
  requireShape(object(value));
  if (value.state === 'at' || value.state === 'within') {
    requireShape(identity(value.placeId) && places.has(value.placeId));
  } else if (value.state === 'in_transit') {
    for (const field of ['routeId', 'fromId', 'toId']) {
      if (value[field] == null) continue;
      requireShape(identity(value[field]) && (field === 'routeId' || places.has(value[field])));
    }
    requireShape(value.routeId != null || (value.fromId != null && value.toId != null));
  } else {
    requireShape(value.state === 'unknown');
  }
}

/**
 * Detaches and checks the synchronous world port result against this scope and player. Invalid values,
 * missing fields, accessors/proxies that throw, or non-cloneable data return null; no authority writes occur.
 * Work and memory are O(snapshot bytes), with no chat-wide limit. All required snapshot arrays are checked.
 */
export function checkTavernPlayerWorld(
  input: TavernPlayerWorld,
  scope: Scope,
  playerId: string,
): TavernPlayerWorld | null {
  try {
    const result = structuredClone(input);
    requireShape(object(result) && typeof result.firstTurn === 'boolean' && object(result.world));
    const world = result.world;
    requireShape(sameScope(world.scope, scope) && typeof world.presenceKnown === 'boolean');
    const entities = identities(world.entityIds);
    const places = identities(world.placeIds);
    requireShape(entities.has(playerId));
    for (const entityId of identities(world.presentIds)) requireShape(entities.has(entityId));
    requireShape(Array.isArray(world.positions) && Array.isArray(world.possessions)
      && Array.isArray(world.presenceSeeds) && Array.isArray(world.applied));

    const positioned = new Set<string>();
    for (const entry of world.positions) {
      requireShape(object(entry) && identity(entry.entityId)
        && entities.has(entry.entityId) && !positioned.has(entry.entityId));
      positioned.add(entry.entityId);
      checkPosition(entry.position, places);
      checkBasis(entry.basis, scope);
    }

    const items = new Set<string>();
    for (const entry of world.possessions) {
      requireShape(object(entry) && identity(entry.itemId) && !items.has(entry.itemId));
      items.add(entry.itemId);
      checkBasis(entry.basis, scope);
    }
    const holders = new Set([...entities, ...places, ...items]);
    for (const entry of world.possessions) {
      requireShape(entry.holderId === null || (identity(entry.holderId) && holders.has(entry.holderId)));
    }

    for (const seed of world.presenceSeeds) {
      requireShape(object(seed));
      checkBasis(seed.basis, scope);
      for (const entityId of identities(seed.presentIds)) requireShape(entities.has(entityId));
      requireShape(seed.playerPresent == null || typeof seed.playerPresent === 'boolean');
      if (seed.positions == null) continue;
      requireShape(Array.isArray(seed.positions));
      for (const entry of seed.positions) {
        requireShape(object(entry) && identity(entry.entityId) && entities.has(entry.entityId));
        checkPosition(entry.position, places);
      }
    }

    const applied = new Set<string>();
    for (const entry of world.applied) {
      requireShape(object(entry) && identity(entry.key) && identity(entry.fingerprint) && !applied.has(entry.key));
      applied.add(entry.key);
    }
    return result;
  } catch {
    return null;
  }
}

function hardEffect(payload: EventPayload): boolean {
  return payload.kind === 'Enter' || payload.kind === 'Exit' || payload.kind === 'Transfer';
}

function downgraded(event: EngineEvent, reason: DecodeIssue): EngineEvent {
  return {
    ...event,
    payload: {
      kind: 'Unknown',
      actorId: event.payload.actorId,
      text: 'text' in event.payload ? event.payload.text : '',
      reason,
    },
  };
}

/**
 * Checks decoded M1 spatial/ownership effects in ledger order without mutating events or the snapshot.
 * Only the player may author effects or move themselves; firstTurn also permits an NPC Enter destination.
 * Transfers must give a currently player-held item. Rejected effects retain their envelope/origin as Unknown.
 * Null world rejects every hard effect as world_unavailable; other payloads and old Unknown records survive.
 * Work is O(snapshot entries + events); Maps/Sets avoid prototype-key lookup and repeated snapshot scans.
 */
export function checkTavernPlayerEffects(
  events: readonly EngineEvent[],
  playerId: string,
  state: TavernPlayerWorld | null,
): readonly EngineEvent[] {
  if (state === null) {
    return events.map(event => hardEffect(event.payload) ? downgraded(event, 'world_unavailable') : event);
  }

  const { world, firstTurn } = state;
  const entities = new Set(world.entityIds);
  const places = new Set(world.placeIds);
  const present = new Set(world.presentIds);
  const positions = new Map(world.positions.map(entry => [entry.entityId, entry.position]));
  const possessions = new Map(world.possessions.map(entry => [entry.itemId, entry.holderId]));
  const holders = new Set([...entities, ...places, ...possessions.keys()]);

  return events.map(event => {
    const payload = event.payload;
    if (!hardEffect(payload)) return event;
    if (payload.actorId !== playerId) return downgraded(event, 'effect_actor_not_allowed');

    if (payload.kind === 'Enter' || payload.kind === 'Exit') {
      if (payload.entityId !== playerId && !(firstTurn && payload.kind === 'Enter')) {
        return downgraded(event, 'effect_actor_not_allowed');
      }
      if (!entities.has(payload.entityId) || !places.has(payload.placeId)) {
        return downgraded(event, 'effect_world_mismatch');
      }
      const previous = positions.get(payload.entityId);
      if (payload.kind === 'Exit' && (!present.has(payload.entityId)
        || (previous && (previous.state === 'at' || previous.state === 'within')
          && previous.placeId !== payload.placeId))) {
        return downgraded(event, 'effect_world_mismatch');
      }

      if (payload.kind === 'Enter') {
        present.add(payload.entityId);
        positions.set(payload.entityId, { state: 'at', placeId: payload.placeId });
      } else {
        present.delete(payload.entityId);
        positions.set(payload.entityId, { state: 'unknown' });
      }
    } else if (payload.kind === 'Transfer') {
      if (payload.fromId !== playerId) return downgraded(event, 'effect_actor_not_allowed');
      if (!possessions.has(payload.itemId) || possessions.get(payload.itemId) !== payload.fromId
        || !holders.has(payload.toId)) {
        return downgraded(event, 'effect_world_mismatch');
      }
      possessions.set(payload.itemId, payload.toId);
    }
    return event;
  });
}
