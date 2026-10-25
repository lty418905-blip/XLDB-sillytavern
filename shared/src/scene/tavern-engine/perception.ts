import { projectTavernWorld } from './projection.ts';
import { createHash } from 'node:crypto';
import type { EventSourceObservation, SceneState } from '../types.ts';
import type { AcceptedTavernTurn } from './store.ts';
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

/**
 * One current accepted event for a component. id/revision identify the real accepted message; observation.ref
 * identifies its structural event. Text and attribution come from ledger rows, never from rendered prose.
 * acceptedAtMs is Unix milliseconds. The content is a decoded P1 value, not a new candidate or a prompt.
 */
export interface EventConsumerSource {
  id: string;
  revision: number;
  role: 'user' | 'assistant';
  acceptedAtMs: number;
  observation: EventSourceObservation;
  content: EventPayload | BeatItem;
}

/**
 * Reader-visible events with the ledger's source identities, including sources with no visible events.
 * Source ids retain ownership across revisions; event access still requires the exact current revision.
 * Ownership grants no event access. Rebuilding events must retain the same outer source identities;
 * a bare event array is not a projection. Both fields are ordinary enumerable object properties.
 */
export interface EventConsumerProjection {
  readonly events: readonly EventConsumerSource[];
  readonly ledgerSourceIds: ReadonlySet<string>;
}

/**
 * Stable event-text container identity for existing numeric parsers. Its offsets address only the event quote.
 * The real message and complete address stay on EventConsumerSource; no display offsets are manufactured.
 * Work is O(identity bytes); malformed references/getters throw before hashing.
 */
export function eventConsumerKey(source: EventConsumerSource): string {
  const reference = addressKey(source.observation.ref);
  return 'event:' + createHash('sha256').update(JSON.stringify([source.id, source.revision, reference])).digest('hex');
}

/**
 * Pure reader projection over current turns already selected by the lifecycle-aware consumer entry.
 * Private readers are the author and whisper recipients; public readers are the routes saved by store.commit.
 * Neither caller-supplied quote/author/readers nor B text is read. Missing/stale events produce no source.
 * Rebuild after any lifecycle change; this detached result is for one synchronous consumption pass.
 * Ownership includes same-scope historical ledger sources even when their events are no longer current.
 * Work is O(sources + ledger bytes + references + readers), plus per-source O(events log events) ordering.
 * Getter errors and malformed stored JSON propagate unchanged; this is not an import boundary.
 */
export function projectEventConsumerSources(
  state: SceneState,
  turns: readonly AcceptedTavernTurn[],
  readerId: string,
  ledgerTurns: readonly AcceptedTavernTurn[] = turns,
): EventConsumerProjection {
  const expectedScope = state.scope;
  const scopeKey = JSON.stringify([
    expectedScope.worldId,
    expectedScope.sessionId,
    expectedScope.branchId,
    expectedScope.characterId,
  ]);
  const ledgerSourceIds = new Set<string>();
  for (const turn of ledgerTurns) {
    const scope = turn.scope;
    if (JSON.stringify([scope.worldId, scope.sessionId, scope.branchId, scope.characterId]) === scopeKey) {
      ledgerSourceIds.add(turn.source.id);
    }
  }

  const events = new Map<string, {
    sourceId: string;
    revision: number;
    content: EventPayload | BeatItem;
    readers: string[];
  }>();

  for (const turn of turns) {
    const stored = turn as typeof turn & {
      memoryReaders?: {address: string; actorId: string; quote: string; readers: string[]}[];
    };
    const routes = new Map((stored.memoryReaders ?? []).map(route => [route.address, route]));
    const add = (
      reference: TavernEventAddress,
      content: EventPayload | BeatItem,
    ): void => {
      if (content.kind === 'Unknown') return;
      const {eventId, phase, itemRef, effectIndex} = reference;
      const route = routes.get(JSON.stringify([eventId, phase, itemRef ?? null, effectIndex ?? null]));
      const quote = 'text' in content ? content.text : '';
      const whisperTo = 'whisperTo' in content ? content.whisperTo ?? [] : [];
      const readers = whisperTo.length > 0
        ? [...new Set([content.actorId, ...whisperTo])]
        : route?.actorId === content.actorId && route.quote === quote ? [...route.readers] : [];
      events.set(addressKey(reference), {
        sourceId: turn.source.id,
        revision: turn.source.revision,
        content,
        readers,
      });
    };

    for (const event of turn.kind === 'interpret' ? turn.events : turn.beats) {
      if (event.envelope.status !== 'accepted' || event.envelope.turnId !== turn.turnId
        || event.origin.turnRevision !== turn.turnRevision) continue;
      const reference = {turnId: turn.turnId, turnRevision: turn.turnRevision, eventId: event.envelope.id};
      if ('payload' in event) {
        add({...reference, phase: 'event'}, event.payload);
      } else {
        const emitted = new Set(event.items.map(item => item.itemIndex));
        for (const item of event.items) add({...reference, phase: 'item', itemRef: item.itemIndex}, item);
        for (const link of event.effects) {
          if (!emitted.has(link.itemRef)) continue;
          add({...reference, phase: link.phase, itemRef: link.itemRef, effectIndex: link.effectIndex}, link.effect);
        }
      }
    }
  }

  const result: EventConsumerSource[] = [];
  const seen = new Set<string>();
  for (const source of state.sources) {
    if (source.status !== 'accepted' || source.processing !== 'ready') continue;
    const selected: EventConsumerSource[] = [];
    for (const observation of source.analysis?.plan?.observations ?? []) {
      if (!Object.hasOwn(observation, 'ref')) continue;
      const {ref, id, kind, sequence} = observation as EventSourceObservation;
      const key = addressKey(ref);
      const event = events.get(key);
      if (!event || event.sourceId !== source.id || event.revision !== source.revision
        || !event.readers.includes(readerId) || seen.has(key)) continue;
      if (!['heard', 'observed'].includes(kind) || !Number.isSafeInteger(sequence) || sequence < 1) continue;
      seen.add(key);
      const quote = 'text' in event.content ? event.content.text : '';
      selected.push({
        id: source.id,
        revision: source.revision,
        role: source.role,
        acceptedAtMs: source.acceptedAtMs,
        observation: {
          channel: 'event',
          ref: {...ref},
          id,
          kind,
          sequence,
          quote,
          evidence: quote,
          actorId: event.content.actorId,
          attributed: true,
          readers: [...event.readers],
          recipients: event.readers.filter(reader => reader !== event.content.actorId),
        },
        content: structuredClone(event.content),
      });
    }
    selected.sort((left, right) => left.observation.sequence - right.observation.sequence);
    result.push(...selected);
  }
  return {events: result, ledgerSourceIds};
}

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

// Rebuild the closed decoded variants instead of forwarding unknown routing fields to an observer.
// Content identities such as a transfer's endpoints describe the event; routing identities use one visibility rule.
function observedContent(
  content: EventPayload | BeatItem,
  visibleRecipient: (recipientId: string) => boolean,
): EventPayload | BeatItem {
  if ('itemIndex' in content) {
    return {
      kind: content.kind,
      itemIndex: content.itemIndex,
      actorId: content.actorId,
      text: content.text,
      addressees: content.addressees.filter(visibleRecipient),
      ...(content.whisperTo == null ? {} : { whisperTo: content.whisperTo.filter(visibleRecipient) }),
    };
  }

  if (content.kind === 'Unknown') {
    return { kind: content.kind, actorId: content.actorId, text: content.text, reason: content.reason };
  }

  const evidence = {
    actorId: content.actorId,
    confidence: content.confidence,
    ...(content.evidence == null ? {} : {
      evidence: content.evidence.map(source => source.channel === 'message'
        ? {
          channel: source.channel,
          sourceId: source.sourceId,
          revision: source.revision,
          start: source.start,
          end: source.end,
        }
        : {
          channel: source.channel,
          turnId: source.turnId,
          turnRevision: source.turnRevision,
          eventId: source.eventId,
        }),
    }),
  };

  switch (content.kind) {
    case 'PlayerUtterance':
    case 'NpcSpeech':
      return {
        ...evidence,
        kind: content.kind,
        text: content.text,
        addressees: content.addressees.filter(visibleRecipient),
        ...(content.whisperTo == null ? {} : { whisperTo: content.whisperTo.filter(visibleRecipient) }),
      };
    case 'PlayerAction':
      return {
        ...evidence,
        kind: content.kind,
        text: content.text,
        action: { kind: content.action.kind },
        targets: content.targets,
        objects: content.objects,
      };
    case 'NpcAction':
      return { ...evidence, kind: content.kind, text: content.text, targets: content.targets };
    case 'TimeAdvance':
      return { ...evidence, kind: content.kind, minutes: content.minutes, temporality: content.temporality };
    case 'Enter':
    case 'Exit':
      return { ...evidence, kind: content.kind, entityId: content.entityId, placeId: content.placeId };
    case 'Transfer':
      return { ...evidence, kind: content.kind, itemId: content.itemId, fromId: content.fromId, toId: content.toId };
    case 'ConsumeItem':
      return { ...evidence, kind: content.kind, itemId: content.itemId };
    case 'CommitmentEvent': {
      const operation = content.operation;
      const term = operation.term;
      return {
        ...evidence,
        kind: content.kind,
        operation: {
          operationId: operation.operationId,
          action: operation.action,
          quote: operation.quote,
          evidence: operation.evidence.map(entry => ({ actorId: entry.actorId, quote: entry.quote })),
          ...(operation.commitmentId == null ? {} : { commitmentId: operation.commitmentId }),
          ...(operation.targetId == null ? {} : { targetId: operation.targetId }),
          ...(operation.targetRevision == null ? {} : { targetRevision: operation.targetRevision }),
          ...(operation.content == null ? {} : { content: operation.content }),
          ...(operation.participants == null ? {} : { participants: operation.participants }),
          ...(operation.obligors == null ? {} : { obligors: operation.obligors }),
          ...(operation.agreement == null ? {} : { agreement: operation.agreement }),
          ...(term == null ? {} : { term: term.kind === 'deadline' ? {
            kind: term.kind,
            clock: term.clock,
            deadlineQuote: term.deadlineQuote,
            ...(term.reminderQuote == null ? {} : { reminderQuote: term.reminderQuote }),
            ...(term.dueAtMs == null ? {} : { dueAtMs: term.dueAtMs }),
            ...(term.remindAtMs == null ? {} : { remindAtMs: term.remindAtMs }),
          } : { kind: term.kind } }),
        },
      };
    }
  }
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
  // Only arrivals actually folded from these steps establish fresh event-derived positions.
  // A pre-history event position still needs the caller's explicit freshness evidence.
  const arrivalPositions = new Set<string>();
  for (const phase of projection.phases) {
    const entry = contents.get(addressKey(phaseAddress(phase)));
    if (entry?.content.kind !== 'Enter') continue;
    arrivalPositions.add(JSON.stringify([
      entry.content.entityId,
      phase.reference.turnId,
      phase.reference.turnRevision,
      phase.reference.eventId,
    ]));
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
    if (!position) return undefined;
    const reference = position.basis.event;
    const arrived = position.basis.kind === 'event' && reference != null && arrivalPositions.has(JSON.stringify([
      position.entityId,
      reference.turnId,
      reference.turnRevision,
      reference.eventId,
    ]));
    if (!arrived && !freshPositions.has(JSON.stringify([position.entityId, basisKey(position.basis)]))) {
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
      ? entry.content.placeId
      : undefined;

    function inRange(actorId: string, sound: boolean): boolean {
      if (!phase.presenceKnown || !present.has(actorId)) return false;
      // Destination incumbents see a self-arrival using their pre-effect positions. A present mover is
      // also visible at the origin; neither set authorizes earlier content or post-departure speech.
      if (arrivingPlace !== undefined) {
        if (geography == null) return true;
        if (currentPlace(positions.get(actorId)) === arrivingPlace) return true;
      }

      if (!present.has(speakerId)) return false;
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
    function observationFor(viewerId: string): EventObservation {
      const viewerPlace = currentPlace(positions.get(viewerId));
      function visibleRecipient(recipientId: string): boolean {
        if (recipientId === viewerId) return true;
        // Authorship establishes the chosen addressees, but does not reveal unobserved eavesdroppers.
        const addressees = 'addressees' in observation.content ? observation.content.addressees : [];
        if (viewerId === speakerId
          && (addressees.includes(recipientId) || whisperedReaders.has(recipientId))) return true;
        if (!phase.presenceKnown || !present.has(viewerId) || !present.has(recipientId)) return false;
        if (geography == null) return true;
        return viewerPlace !== undefined && viewerPlace === currentPlace(positions.get(recipientId));
      }

      const visibleReaders = recipients.filter(visibleRecipient);
      return {
        eventId: observation.eventId,
        sequence: observation.sequence,
        source: observation.source,
        actorId: observation.actorId,
        perceptionKind: observation.perceptionKind,
        quote: observation.quote,
        content: observedContent(observation.content, visibleRecipient),
        readers: visibleReaders,
      };
    }

    for (const actorId of recipients) actors.get(actorId)!.inbox.push(observationFor(actorId));

    // Authorship is separate from whisper delivery; it must never widen whisperTo or another actor's basis.
    if (actors.has(entry.actorId) && readableBasis(entry.actorId, permission.basis)) {
      actors.get(entry.actorId)!.authoredEvents.push(observationFor(entry.actorId));
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
      if (actors.has(actorId) && readableBasis(actorId, material.basis)) {
        // A material's permission list is routing metadata, not evidence that its readers know one another.
        actors.get(actorId)!.materials.push({ ...material, readers: [actorId] });
      }
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
  #acceptedTurns: { turnId: string; turnRevision: number; version: number }[] = [];
  #turnStarts = new Map<string, number>();
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
      const turnStarts = new Map<string, number>();
      const acceptedTurns = new Map<string, { turnId: string; turnRevision: number; version: number }>();
      for (const step of copied.steps) {
        // Only a committed NPC phase completes a turn; its interpretation is not another round.
        if (step.kind !== 'accepted') continue;
        const { turnId, turnRevision, version } = step.turn;
        if (step.turn.kind === 'interpret') {
          turnStarts.set(JSON.stringify([turnId, turnRevision]), version);
          continue;
        }
        const previous = acceptedTurns.get(turnId);
        if (!previous || version > previous.version) acceptedTurns.set(turnId, { turnId, turnRevision, version });
      }
      this.#turnStarts = turnStarts;
      this.#acceptedTurns = [...acceptedTurns.values()].sort((left, right) => left.version - right.version);
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

  /**
   * Returns this actor's verbatim observations from the preceding three committed, valid ledger turns.
   * Three is the provisional contract window, counted globally even when an actor perceived no event.
   * Source validity is the caller's existing ledger filter; emitted/current turns never consume a slot.
   * O(accepted turns + actor observations log observations); no message-array length or model text is used.
   */
  recentTurnWindow(actorId: string, currentTurnId: string, currentTurnRevision: number): readonly EventObservation[] {
    const state = this.#actor(actorId);
    const start = this.#turnStarts.get(JSON.stringify([currentTurnId, currentTurnRevision]));
    if (start === undefined) throw new Error('perception_missing_turn');
    // Regeneration of an earlier turn must not see later accepted rounds still present in a source snapshot.
    const turns = this.#acceptedTurns.filter(turn => turn.turnId !== currentTurnId && turn.version < start).slice(-3);
    const selected = new Set(turns.map(turn => JSON.stringify([turn.turnId, turn.turnRevision])));
    const events = new Map([...state.inbox, ...state.authoredEvents].map(event => [event.eventId, event]));
    return structuredClone([...events.values()]
      .filter(event => selected.has(JSON.stringify([event.source.turnId, event.source.turnRevision])))
      .sort((left, right) => left.sequence - right.sequence));
  }

  /**
   * Returns detached final content readers, including authorized authorship, for this exact scope.
   * One pass over routed entries costs O(routed bytes); it changes no delivery cursor or route.
   * A different scope throws. Unknown/denied events are absent, rather than granting roster-wide access.
   */
  memoryReaders(scope: import('../../memory/access.ts').Scope): readonly {
    source: EventObservation['source'];
    actorId: string;
    quote: string;
    readers: readonly string[];
  }[] {
    const key = JSON.stringify([scope.worldId, scope.sessionId, scope.branchId, scope.characterId]);
    if (key !== this.#scopeKey) throw new Error('perception_scope_mismatch');
    const routes = new Map<string, {
      source: EventObservation['source'];
      actorId: string;
      quote: string;
      readers: Set<string>;
    }>();

    for (const [actorId, state] of this.#actors) {
      for (const event of [...state.inbox, ...state.authoredEvents]) {
        if (event.perceptionKind === 'diagnostic') continue;
        let route = routes.get(event.eventId);
        if (!route) {
          route = {source: event.source, actorId: event.actorId, quote: event.quote, readers: new Set()};
          routes.set(event.eventId, route);
        }
        route.readers.add(actorId);
      }
    }

    return [...routes.values()].map(route => ({
      source: {...route.source},
      actorId: route.actorId,
      quote: route.quote,
      readers: [...route.readers],
    }));
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
   * Prepares new inbox/authored events of turnId plus its last windowSize visible events (count, default 32).
   * Earlier turns remain available through view for recall, but are never redelivered after a cursor reset.
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
      // Only this turn's delivered inbox, authorship or repeat window may acknowledge a sequence.
      sequence: turnEvents.at(-1)?.sequence ?? state.deliveryCursor,
    });
    return {
      input: structuredClone({
        actorId,
        deliveryCursor: state.deliveryCursor,
        inbox: state.inbox.filter(event => event.source.turnId === turnId && event.sequence > state.deliveryCursor),
        authoredEvents: state.authoredEvents.filter(event =>
          event.source.turnId === turnId && event.sequence > state.deliveryCursor),
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
