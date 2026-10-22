import { projectTavernWorld } from './projection.ts';
import type {
  TavernProjectedPosition,
  TavernProjectionBasis,
  TavernProjectionPhase,
} from './projection.ts';
import type {
  BeatItem,
  DecodedBeat,
  EngineEvent,
  EventObservation,
  EventPayload,
  TavernActorEventView,
  TavernEventAddress,
  TavernEventPermission,
  TavernPerceptionDispatch,
  TavernPerceptionInput,
  TavernPerceptionMaterial,
  TavernPlayerEventView,
  TavernWhisperMarker,
} from './types.ts';

/** Provisional verbatim window: at most 32 events per dispatch in the requested turn, never a chat limit. */
export const DEFAULT_PERCEPTION_WINDOW = 32;

interface EventContent {
  actorId: string;
  content: EventPayload | BeatItem;
  speech: boolean;
  diagnostic: boolean;
  whisperTo: readonly string[];
}

interface ActorState {
  inbox: EventObservation[];
  authoredEvents: EventObservation[];
  materials: TavernPerceptionMaterial[];
  markers: TavernWhisperMarker[];
  deliveryCursor: number;
}

interface DeliveryReceipt {
  epoch: object;
  actorId: string;
  sequence: number;
}

function requireIdentity(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_perception_identity');
}

function requireInteger(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('invalid_perception_integer');
}

function addressKey(address: TavernEventAddress): string {
  requireIdentity(address.turnId);
  requireIdentity(address.eventId);
  requireInteger(address.turnRevision, 1);
  if (address.phase === 'event' && address.itemRef != null) throw new Error('invalid_perception_phase');
  if ((address.phase === 'event' || address.phase === 'item') && address.effectIndex != null) {
    throw new Error('invalid_perception_phase');
  }
  if (address.phase !== 'event') requireInteger(address.itemRef!, 0);
  if (address.phase === 'beforeItem' || address.phase === 'afterItem') {
    requireInteger(address.effectIndex!, 0);
  } else if (address.phase !== 'event' && address.phase !== 'item') {
    throw new Error('invalid_perception_phase');
  }
  return JSON.stringify([
    address.turnId,
    address.turnRevision,
    address.eventId,
    address.phase,
    address.itemRef ?? null,
    address.effectIndex ?? null,
  ]);
}

function phaseAddress(phase: TavernProjectionPhase): TavernEventAddress {
  return {
    ...phase.reference,
    phase: phase.phase,
    ...(phase.itemRef == null ? {} : { itemRef: phase.itemRef }),
    ...(phase.effectIndex == null ? {} : { effectIndex: phase.effectIndex }),
  };
}

function basisKey(basis: TavernProjectionBasis): string {
  return JSON.stringify([
    basis.kind,
    basis.scope.worldId,
    basis.scope.sessionId,
    basis.scope.branchId,
    basis.scope.characterId,
    basis.sourceId,
    basis.sourceRevision,
    basis.event?.turnId ?? null,
    basis.event?.turnRevision ?? null,
    basis.event?.eventId ?? null,
  ]);
}

function indexContent(input: TavernPerceptionInput): Map<string, EventContent> {
  const result = new Map<string, EventContent>();

  function add(address: TavernEventAddress, content: EventPayload | BeatItem) {
    const key = addressKey(address);
    const value: EventContent = {
      actorId: content.actorId,
      content,
      speech: content.kind === 'speech' || content.kind === 'NpcSpeech' || content.kind === 'PlayerUtterance',
      diagnostic: content.kind === 'Unknown',
      whisperTo: 'whisperTo' in content ? content.whisperTo ?? [] : [],
    };
    // Duplicate ledger replay is harmless only when the same structural address still means the same event.
    if (result.has(key) && JSON.stringify(result.get(key)) !== JSON.stringify(value)) {
      throw new Error('perception_replay_conflict');
    }
    result.set(key, value);
  }

  function reference(event: EngineEvent | DecodedBeat): TavernEventAddress {
    return {
      turnId: event.envelope.turnId,
      turnRevision: event.origin.turnRevision,
      eventId: event.envelope.id,
      phase: 'event',
    };
  }

  function addBeat(beat: DecodedBeat, selected: readonly number[]) {
    const retained = new Set(selected);
    const source = reference(beat);
    for (const item of beat.items) {
      if (retained.has(item.itemIndex)) {
        add({ ...source, phase: 'item', itemRef: item.itemIndex }, item);
      }
    }
    for (const link of beat.effects) {
      if (retained.has(link.itemRef)) {
        add({
          ...source,
          phase: link.phase,
          itemRef: link.itemRef,
          effectIndex: link.effectIndex,
        }, link.effect);
      }
    }
  }

  for (const step of input.steps) {
    if (step.kind === 'accepted') {
      if (step.turn.kind === 'interpret') {
        for (const event of step.turn.events) add(reference(event), event.payload);
      } else {
        for (const beat of step.turn.beats) addBeat(beat, beat.items.map(item => item.itemIndex));
      }
    } else if (step.kind === 'emitted') {
      addBeat(step.selection.beat, step.selection.emittedItemRefs);
    }
  }
  return result;
}

function buildActors(input: TavernPerceptionInput): Map<string, ActorState> {
  const projection = projectTavernWorld(input.baseline, input.steps);
  const contents = indexContent(input);
  const actors = new Map<string, ActorState>();
  for (const actorId of projection.world.entityIds) {
    actors.set(actorId, { inbox: [], authoredEvents: [], materials: [], markers: [], deliveryCursor: 0 });
  }
  if (!actors.has(input.playerId)) throw new Error('perception_unknown_actor');

  const permissions = new Map<string, TavernEventPermission>();
  for (const permission of input.permissions) {
    const key = addressKey(permission.address);
    if (permissions.has(key)) throw new Error('perception_duplicate_permission');
    permissions.set(key, permission);
  }
  const knowledge = new Map<string, Set<string>>();
  const geography = input.geography;
  const freshPositions = new Set((geography?.freshPositions ?? []).map(entry =>
    JSON.stringify([entry.entityId, basisKey(entry.basis)])));
  const adjacency = new Map<string, Set<string>>();
  for (const edge of geography?.adjacent ?? []) {
    const forward = adjacency.get(edge.fromId) ?? new Set<string>();
    const reverse = adjacency.get(edge.toId) ?? new Set<string>();
    forward.add(edge.toId);
    reverse.add(edge.fromId);
    adjacency.set(edge.fromId, forward);
    adjacency.set(edge.toId, reverse);
  }

  function readableBasis(actorId: string, basis: readonly TavernEventAddress[]): boolean {
    return basis.every(address => knowledge.get(addressKey(address))?.has(actorId) === true);
  }

  function currentPlace(position: TavernProjectedPosition | undefined): string | undefined {
    if (!position || !freshPositions.has(JSON.stringify([position.entityId, basisKey(position.basis)]))) {
      return undefined;
    }
    return position.position.state === 'at' || position.position.state === 'within'
      ? position.position.placeId
      : undefined;
  }

  let sequence = 0;
  for (const phase of projection.phases) {
    const address = phaseAddress(phase);
    const key = addressKey(address);
    const entry = contents.get(key);
    if (!entry) throw new Error('perception_missing_event');
    sequence++;
    const permission = permissions.get(key);
    if (!permission) continue;
    const readers = new Set(permission.readers);
    const witnesses = new Set(permission.observableBy);
    const whisperedReaders = new Set(entry.whisperTo);
    const speakerId = entry.actorId;
    const present = new Set(phase.presentIds);
    const positions = new Map(phase.positions.map(position => [position.entityId, position]));
    const actorPlace = currentPlace(positions.get(entry.actorId));
    const arrivingPlace = entry.content.kind === 'Enter'
      && entry.content.entityId === speakerId
      && !present.has(speakerId)
      ? entry.content.placeId
      : undefined;

    function inRange(actorId: string, sound: boolean): boolean {
      // A self-arrival is observed at its destination by incumbents, before the entrant has a position there.
      // Other events still require a present author, so departure cannot authorize later speech.
      if (arrivingPlace !== undefined) {
        if (!phase.presenceKnown || !present.has(actorId)) return false;
        if (geography == null) return true;
        return currentPlace(positions.get(actorId)) === arrivingPlace;
      }

      if (!phase.presenceKnown || !present.has(speakerId) || !present.has(actorId)) return false;
      if (geography == null) return true;
      const readerPlace = currentPlace(positions.get(actorId));
      if (actorPlace === undefined || readerPlace === undefined) return false;
      return actorPlace === readerPlace || (sound && adjacency.get(actorPlace)?.has(readerPlace) === true);
    }

    const recipients: string[] = [];
    for (const actorId of actors.keys()) {
      if (!readers.has(actorId) || !readableBasis(actorId, permission.basis)) continue;
      if (entry.diagnostic || !inRange(actorId, entry.speech && whisperedReaders.size === 0)) continue;
      if (whisperedReaders.size > 0 && !whisperedReaders.has(actorId)) continue;
      recipients.push(actorId);
    }

    const observation: EventObservation = {
      eventId: key,
      sequence,
      source: { channel: 'event', ...address },
      actorId: entry.actorId,
      perceptionKind: entry.speech ? 'heard' : entry.diagnostic ? 'diagnostic' : 'observed',
      quote: 'text' in entry.content ? entry.content.text : '',
      content: entry.content,
      readers: recipients,
    };
    const knowingActors = new Set(recipients);
    for (const actorId of recipients) actors.get(actorId)!.inbox.push(observation);

    // Authorship is separate from whisper delivery; it must never widen whisperTo or another actor's basis.
    if (actors.has(entry.actorId) && readableBasis(entry.actorId, permission.basis)) {
      actors.get(entry.actorId)!.authoredEvents.push(observation);
      knowingActors.add(entry.actorId);
    }
    knowledge.set(key, knowingActors);

    if (whisperedReaders.size > 0) {
      for (const [actorId, state] of actors) {
        if (knowingActors.has(actorId) || !witnesses.has(actorId) || !inRange(actorId, false)) continue;
        // A visible speaker alone does not establish a visible recipient or license a marker about them.
        const visibleRecipients = entry.whisperTo.filter(recipient => inRange(recipient, false));
        if (visibleRecipients.length === 0) continue;
        state.markers.push({
          source: { channel: 'event', ...address },
          actorId: entry.actorId,
          recipientIds: visibleRecipients,
          kind: 'whisper',
        });
      }
    }
  }

  for (const material of input.materials ?? []) {
    // Every channel uses the same all-bases gate, including error reasons and opaque structured candidates.
    if (material.basis.length === 0) continue;
    for (const actorId of new Set(material.readers)) {
      if (actors.has(actorId) && readableBasis(actorId, material.basis)) actors.get(actorId)!.materials.push(material);
    }
  }
  return actors;
}

/**
 * In-memory, ready-inert event routing over validated records. Rebuild from a pre-history baseline and the
 * current valid source set after deletion, correction or regeneration; never supply removed history.
 * All spatial decisions use the world's pre-phase projection. Work is O(input/output bytes + phases * actors
 * + reader/basis checks); history is folded once, not once per prefix. Text is copied without interpretation.
 * No persistence, callbacks, model, host or clock is used. Invalid structure/getters throw a constant code,
 * never private input or an underlying error; a failed rebuild preserves the previous complete state.
 */
export class TavernPerception {
  #actors = new Map<string, ActorState>();
  #playerId = '';
  #scopeKey = '';
  #epoch = {};
  #receipts = new WeakMap<object, DeliveryReceipt>();

  /** Builds the initial isolated route. Input arrays and returned views never share mutable state. */
  constructor(input: TavernPerceptionInput) {
    this.replaceSources(input);
  }

  /**
   * Atomically rebuilds from the full current source set, invalidating all outstanding receipts.
   * Appended or identical history preserves each cursor only while its delivered prefix is unchanged.
   * Changed/deleted/re-scoped history resets that cursor. Discard previously returned caller-owned snapshots.
   */
  replaceSources(input: TavernPerceptionInput): void {
    try {
      const copied = structuredClone(input);
      const actors = buildActors(copied);
      const scope = copied.baseline.scope;
      const scopeKey = JSON.stringify([scope.worldId, scope.sessionId, scope.branchId, scope.characterId]);
      if (scopeKey === this.#scopeKey) {
        for (const [actorId, next] of actors) {
          const previous = this.#actors.get(actorId);
          if (!previous) continue;
          const delivered = (events: readonly EventObservation[]) =>
            events.filter(event => event.sequence <= previous.deliveryCursor);
          const sameInbox = JSON.stringify(delivered(previous.inbox)) === JSON.stringify(delivered(next.inbox));
          const sameAuthorship = JSON.stringify(delivered(previous.authoredEvents))
            === JSON.stringify(delivered(next.authoredEvents));
          if (sameInbox && sameAuthorship) next.deliveryCursor = previous.deliveryCursor;
        }
      }
      this.#actors = actors;
      this.#playerId = copied.playerId;
      this.#scopeKey = scopeKey;
      this.#epoch = {};
    } catch {
      throw new Error('invalid_perception_input');
    }
  }

  #actor(actorId: string): ActorState {
    const state = this.#actors.get(actorId);
    if (!state) throw new Error('perception_unknown_actor');
    return state;
  }

  /** Returns only this actor's routed events, own authorship and basis-filtered material; unknown IDs throw. */
  view(actorId: string): TavernActorEventView {
    const state = this.#actor(actorId);
    return structuredClone({
      actorId,
      inbox: state.inbox,
      authoredEvents: state.authoredEvents,
      materials: state.materials,
    });
  }

  /** Returns player-readable event content and content-free whisper markers; never the unfiltered beat. */
  playerView(): TavernPlayerEventView {
    const state = this.#actor(this.#playerId);
    const events = new Map([...state.inbox, ...state.authoredEvents].map(event => [event.eventId, event]));
    return structuredClone({
      playerRenderableEvents: [...events.values()].sort((left, right) => left.sequence - right.sequence),
      whisperMarkers: state.markers,
    });
  }

  /**
   * Prepares new inbox/authored events plus the last windowSize visible events of turnId (count, default 32).
   * Zero disables only the repeat window. Preparation and retries do not advance the cursor; acknowledge the
   * opaque receipt only after a legal dispatch has consumed this exact input. Invalid IDs/counts throw codes.
   */
  prepareDispatch(actorId: string, turnId: string, windowSize = DEFAULT_PERCEPTION_WINDOW): TavernPerceptionDispatch {
    requireIdentity(turnId);
    requireInteger(windowSize, 0);
    const state = this.#actor(actorId);
    const events = new Map([...state.inbox, ...state.authoredEvents].map(event => [event.eventId, event]));
    const ordered = [...events.values()].sort((left, right) => left.sequence - right.sequence);
    const turnEvents = ordered.filter(event => event.source.turnId === turnId);
    const receipt = {};
    this.#receipts.set(receipt, {
      epoch: this.#epoch,
      actorId,
      sequence: ordered.at(-1)?.sequence ?? state.deliveryCursor,
    });
    return {
      input: structuredClone({
        actorId,
        deliveryCursor: state.deliveryCursor,
        inbox: state.inbox.filter(event => event.sequence > state.deliveryCursor),
        authoredEvents: state.authoredEvents.filter(event => event.sequence > state.deliveryCursor),
        turnWindow: windowSize === 0 ? [] : turnEvents.slice(-windowSize),
        materials: state.materials,
      }),
      receipt,
    };
  }

  /** Confirms a consumed dispatch. Foreign/stale receipts return false; repeated/late receipts never regress. */
  acknowledgeDispatch(receipt: object): boolean {
    const delivery = this.#receipts.get(receipt);
    if (!delivery || delivery.epoch !== this.#epoch) return false;
    const state = this.#actor(delivery.actorId);
    state.deliveryCursor = Math.max(state.deliveryCursor, delivery.sequence);
    return true;
  }
}
