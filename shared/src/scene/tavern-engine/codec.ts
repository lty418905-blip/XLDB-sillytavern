import { CODEC_LIMITS, MAX_EVENT_REFERENCES, MIN_ACTION_CONFIDENCE } from './types.ts';
import type {
  BeatDecodeContext,
  BeatEffect,
  BeatItem,
  DecodeIssue,
  DecodeResult,
  DecodedBeat,
  EngineEvent,
  EngineEventEnvelope,
  EventCommitment,
  EventDecodeContext,
  EventEvidence,
  EventPayload,
  EventReference,
  LinkedBeatEffect,
  ObservationSource,
  PlayerActionKind,
  ProjectedBeatItem,
  UnknownEvent,
} from './types.ts';

class InvalidCandidate extends Error {
  constructor(readonlyReason: DecodeIssue) {
    super(readonlyReason);
    this.reason = readonlyReason;
  }

  readonly reason: DecodeIssue;
}

function reject(reason: DecodeIssue): never {
  throw new InvalidCandidate(reason);
}

// Own data properties are copied once. Accessors are rejected without invoking caller code;
// proxy traps may throw, and each public decoding boundary catches them.
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('invalid_shape');
  const result: Record<string, unknown> = Object.create(null);

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) reject('invalid_shape');
    result[key] = descriptor.value;
  }

  return result;
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value)) reject('invalid_shape');
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) reject('invalid_length');
  const result: unknown[] = [];

  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) reject('invalid_shape');
    result.push(descriptor.value);
  }

  return result;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) reject('invalid_reference');
  return value;
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) reject('invalid_reference');
  return value;
}

function text(value: unknown, maximum: number = CODEC_LIMITS.text): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) reject('invalid_length');
  return value;
}

function finite(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    reject('invalid_confidence');
  }

  return value;
}

function reference(value: unknown): EventReference {
  const input = record(value);
  return {
    turnId: identifier(input.turnId),
    turnRevision: integer(input.turnRevision, 1),
    eventId: identifier(input.eventId),
  };
}

function referenceKey(value: EventReference): string {
  return JSON.stringify([value.turnId, value.turnRevision, value.eventId]);
}

function context(value: EventDecodeContext) {
  const input = record(value);
  const envelope = record(input.envelope);
  const scope = record(input.scope);
  const message = record(input.message);
  const source = envelope.source;
  const status = envelope.status;

  if (source !== 'interpret' && source !== 'beat' && source !== 'engine') reject('invalid_context');
  if (status !== 'tentative' && status !== 'accepted' && status !== 'rejected') reject('invalid_context');
  const beatIndex = integer(envelope.beatIndex);
  if ((source === 'interpret' && beatIndex !== 0) || (source === 'beat' && beatIndex === 0)) {
    reject('invalid_context');
  }

  if (message.role !== 'user' && message.role !== 'assistant') reject('invalid_context');
  if (source === 'interpret' && message.role !== 'user') reject('invalid_context');
  if (typeof message.text !== 'string') reject('invalid_context');
  finite(message.acceptedAtMs, 0, Number.MAX_SAFE_INTEGER);
  const catalog = (values: unknown) => new Set(array(values, Number.MAX_SAFE_INTEGER).map(identifier));
  const entityIds = catalog(input.entityIds);
  const actorId = identifier(input.actorId);
  if (!entityIds.has(actorId)) reject('invalid_context');

  return {
    envelope: {
      id: identifier(envelope.id),
      turnId: identifier(envelope.turnId),
      beatIndex,
      source,
      status,
    } satisfies EngineEventEnvelope,
    origin: {
      scope: {
        worldId: identifier(scope.worldId),
        sessionId: identifier(scope.sessionId),
        branchId: identifier(scope.branchId),
        characterId: identifier(scope.characterId),
      },
      turnRevision: integer(input.turnRevision, 1),
      sourceId: identifier(message.id),
      sourceRevision: integer(message.revision, 1),
      ruleVersion: identifier(input.ruleVersion),
    },
    actorId,
    scheduledActorCount: input.scheduledActorCount,
    messageText: message.text,
    entityIds,
    itemIds: catalog(input.itemIds),
    placeIds: catalog(input.placeIds),
    eventReferences: new Set(array(input.eventReferences, Number.MAX_SAFE_INTEGER).map(reference).map(referenceKey)),
  };
}

type Context = ReturnType<typeof context>;

// One budget is shared by all payload fields. Duplicate reference slots deliberately count again.
class References {
  count = 1;

  add(count = 1): void {
    this.count += count;
    if (this.count > MAX_EVENT_REFERENCES) reject('too_many_references');
  }

  entity(value: unknown, catalog: ReadonlySet<string>): string {
    this.add();
    const result = identifier(value);
    if (!catalog.has(result)) reject('unknown_entity');
    return result;
  }

  entities(value: unknown, catalog: ReadonlySet<string>): string[] {
    return array(value, MAX_EVENT_REFERENCES).map(entry => this.entity(entry, catalog));
  }
}

function observationSource(value: unknown, current: Context): ObservationSource {
  const input = record(value);

  if (input.channel === 'event') {
    const result = reference(input);
    if (!current.eventReferences.has(referenceKey(result))) reject('invalid_reference');
    return { channel: 'event', ...result };
  }

  if (input.channel !== 'message') reject('invalid_reference');
  const sourceId = identifier(input.sourceId);
  const revision = integer(input.revision, 1);
  const start = integer(input.start);
  const end = integer(input.end);
  if (sourceId !== current.origin.sourceId || revision !== current.origin.sourceRevision
    || end <= start || end > current.messageText.length) reject('invalid_reference');

  return { channel: 'message', sourceId, revision, start, end };
}

function evidence(input: Record<string, unknown>, current: Context, references: References): EventEvidence {
  const confidence = finite(input.confidence, 0, 1);
  const result: EventEvidence = { actorId: current.actorId, confidence };

  if (input.evidence != null) {
    result.evidence = array(input.evidence, MAX_EVENT_REFERENCES).map(entry => {
      references.add();
      return observationSource(entry, current);
    });
  }

  return result;
}

function audience(input: Record<string, unknown>, current: Context, references: References) {
  const addressees = references.entities(input.addressees, current.entityIds);
  const result: { addressees: string[]; whisperTo?: string[] } = { addressees };

  if (input.whisperTo != null) {
    const allowed = new Set(addressees);
    const whisperTo = references.entities(input.whisperTo, current.entityIds);
    if (!whisperTo.every(entry => allowed.has(entry))) reject('invalid_reference');
    result.whisperTo = whisperTo;
  }

  return result;
}

function commitment(value: unknown, current: Context, references: References): EventCommitment {
  const input = record(value);
  const action = input.action;
  if (action !== 'propose' && action !== 'confirm' && action !== 'establish' && action !== 'revise'
    && action !== 'fulfill' && action !== 'cancel' && action !== 'harden') reject('unknown_kind');
  const result: EventCommitment = {
    operationId: identifier(input.operationId),
    action,
    quote: text(input.quote),
    evidence: array(input.evidence, MAX_EVENT_REFERENCES).map(value => {
      const entry = record(value);
      return { actorId: references.entity(entry.actorId, current.entityIds), quote: text(entry.quote) };
    }),
  };

  if (result.evidence.length === 0) reject('missing_evidence');
  for (const key of ['commitmentId', 'targetId'] as const) {
    if (input[key] == null) continue;
    references.add();
    result[key] = identifier(input[key]);
  }

  if (input.targetRevision != null) result.targetRevision = integer(input.targetRevision, 1);
  if (input.content != null) result.content = text(input.content);
  for (const key of ['participants', 'obligors'] as const) {
    if (input[key] != null) result[key] = references.entities(input[key], current.entityIds);
  }

  if (input.agreement != null) {
    if (input.agreement !== 'unilateral' && input.agreement !== 'mutual') reject('invalid_shape');
    result.agreement = input.agreement;
  }

  if (input.term != null) {
    const term = record(input.term);
    if (term.kind === 'unknown' || term.kind === 'persistent') {
      result.term = { kind: term.kind };
    } else if (term.kind === 'deadline') {
      if (term.clock !== 'real' && term.clock !== 'story') reject('invalid_shape');
      const decoded: Extract<NonNullable<EventCommitment['term']>, { kind: 'deadline' }> = {
        kind: 'deadline',
        clock: term.clock,
        deadlineQuote: text(term.deadlineQuote),
      };
      if (term.reminderQuote != null) decoded.reminderQuote = text(term.reminderQuote);
      for (const key of ['dueAtMs', 'remindAtMs'] as const) {
        if (term[key] != null) decoded[key] = finite(term[key], -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
      }
      result.term = decoded;
    } else {
      reject('unknown_kind');
    }
  }

  return result;
}

function hardEvidence(value: EventEvidence): void {
  if (value.confidence < MIN_ACTION_CONFIDENCE) reject('low_confidence');
  if (!value.evidence?.length) reject('missing_evidence');
}

function decodePayload(input: Record<string, unknown>, current: Context, effectOnly = false): EventPayload {
  const references = new References();
  const kind = input.kind;
  // Dropping a deferred phase would turn an attempt into an ordinary effect. Keep it diagnostic instead.
  if (input.phase != null || input.attemptRef != null) reject('phase_disabled');
  if (kind === 'PhysiologyEvent' || kind === 'CalendarEvent' || kind === 'ConsumeItem'
    || kind === 'Attempt' || kind === 'Result') reject('phase_disabled');
  if (kind === 'Unknown') return unknown(input, current, 'unknown_kind');

  const supported = ['PlayerUtterance', 'PlayerAction', 'NpcSpeech', 'NpcAction',
    'Enter', 'Exit', 'Transfer', 'CommitmentEvent', 'TimeAdvance'];
  if (typeof kind !== 'string' || !supported.includes(kind)) reject('unknown_kind');
  const hard = kind === 'Enter' || kind === 'Exit' || kind === 'Transfer' || kind === 'CommitmentEvent';
  if (effectOnly && !hard) reject('unknown_kind');
  const common = evidence(input, current, references);

  if (hard) {
    hardEvidence(common);
    if (kind === 'Enter' || kind === 'Exit') {
      return { ...common, kind,
        entityId: references.entity(input.entityId, current.entityIds),
        placeId: references.entity(input.placeId, current.placeIds) };
    }
    if (kind === 'Transfer') {
      return { ...common, kind,
        itemId: references.entity(input.itemId, current.itemIds),
        fromId: references.entity(input.fromId, current.entityIds),
        toId: references.entity(input.toId, current.entityIds) };
    }
    return { ...common, kind: 'CommitmentEvent', operation: commitment(input.operation, current, references) };
  }

  if (kind === 'TimeAdvance') {
    if (current.envelope.source !== 'engine') reject('invalid_source');
    hardEvidence(common);
    const minutes = finite(input.minutes, 0, Number.MAX_VALUE);
    const temporality = input.temporality;
    if (temporality !== 'current' && temporality !== 'recollection' && temporality !== 'plan') {
      reject('invalid_shape');
    }
    return { ...common, kind, minutes, temporality };
  }

  const player = kind === 'PlayerUtterance' || kind === 'PlayerAction';
  if (current.envelope.source !== (player ? 'interpret' : 'beat')) reject('invalid_source');
  const literal = text(input.text);
  if (kind === 'PlayerUtterance' && !current.messageText.includes(literal)) reject('invalid_source');
  if (kind === 'PlayerUtterance' || kind === 'NpcSpeech') {
    return { ...common, kind, text: literal, ...audience(input, current, references) };
  }

  const targets = references.entities(input.targets, current.entityIds);
  if (kind === 'NpcAction') return { ...common, kind, targets, text: literal };
  const actionInput = record(input.action);
  if (actionInput.phase != null || actionInput.attemptRef != null) reject('phase_disabled');
  const action = actionInput.kind;
  if (action !== 'move' && action !== 'give' && action !== 'take' && action !== 'attack'
    && action !== 'use' && action !== 'touch' && action !== 'other') reject('unknown_kind');
  return { ...common, kind: 'PlayerAction', action: { kind: action as PlayerActionKind }, targets,
    objects: references.entities(input.objects, current.itemIds), text: literal };
}

function issue(error: unknown): DecodeIssue {
  return error instanceof InvalidCandidate ? error.reason : 'invalid_shape';
}

function unknown(input: Record<string, unknown>, current: Context, reason: DecodeIssue): UnknownEvent {
  return { kind: 'Unknown', actorId: current.actorId, text: typeof input.text === 'string' ? input.text : '', reason };
}

function payload(value: unknown, current: Context, effectOnly = false): EventPayload {
  let input: Record<string, unknown> = Object.create(null);
  try {
    input = record(value);
    return decodePayload(input, current, effectOnly);
  } catch (error) {
    return unknown(input, current, issue(error));
  }
}

/**
 * Decodes one object candidate in O(c + r + n), where c is catalog size, r is reference slots and n is text length.
 * Host identity errors return a failure; malformed payloads become source-bound Unknown records, never effects.
 * Payload text is limited to 800 UTF-16 units; the accepted source text and host catalogs have no chat-wide cap.
 */
export function decodeEngineEvent(raw: unknown, suppliedContext: EventDecodeContext): DecodeResult<EngineEvent> {
  try {
    const current = context(suppliedContext);
    return { ok: true, value: {
      envelope: current.envelope,
      origin: current.origin,
      payload: payload(raw, current),
    } };
  } catch {
    return { ok: false, reason: 'invalid_context' };
  }
}

/**
 * Decodes a beat without emitting it. Work is O(c + r + n); all per-beat arrays and text are contract-bounded.
 * Structural item/link errors reject the whole beat; inadmissible effect payloads retain their slot as Unknown.
 * Null optional intent, interrupt, effects, whisperTo and evidence are treated as omitted, never written undefined.
 */
export function decodeBeatCandidate(raw: unknown, suppliedContext: BeatDecodeContext): DecodeResult<DecodedBeat> {
  try {
    const current = context(suppliedContext);
    if (current.envelope.source !== 'beat') reject('invalid_context');
    const scheduledActorCount = integer(current.scheduledActorCount, 1);
    const input = record(raw);
    const maximum = scheduledActorCount === 1 && current.envelope.beatIndex === 1
      ? CODEC_LIMITS.soloFirstItems : CODEC_LIMITS.items;
    const items = array(input.items, maximum).map<BeatItem>((value, itemIndex) => {
      const item = record(value);
      if (item.kind !== 'speech' && item.kind !== 'action') reject('unknown_kind');
      return { itemIndex, actorId: current.actorId, kind: item.kind, text: text(item.text),
        ...audience(item, current, new References()) };
    });
    const effects = array(input.effects ?? [], CODEC_LIMITS.effects).map<LinkedBeatEffect>((value, effectIndex) => {
      const entry = record(value);
      const itemRef = integer(entry.itemRef);
      if (itemRef >= items.length) reject('invalid_item_ref');
      const phase = entry.phase;
      if (phase !== 'beforeItem' && phase !== 'afterItem') reject('invalid_phase');
      const effect = payload(entry.effect, current, true) as BeatEffect | UnknownEvent;
      return { itemRef, phase, effectIndex, effect };
    });
    const result: DecodedBeat = {
      envelope: current.envelope, origin: current.origin, actorId: current.actorId, items, effects,
    };

    if (input.intent != null) {
      const intent = record(input.intent);
      const goal = text(intent.goal, CODEC_LIMITS.goal);
      const next = text(intent.next, CODEC_LIMITS.nextCodePoints * 2);
      // Unicode iteration counts scalar/code-point slots, not UTF-16 surrogate halves. At most 120 units enter.
      if ([...next].length > CODEC_LIMITS.nextCodePoints) reject('invalid_length');
      result.intent = { goal, next };
    }

    if (input.interrupt != null) {
      const interrupt = record(input.interrupt);
      result.interrupt = {
        turnId: identifier(interrupt.turnId), turnRevision: integer(interrupt.turnRevision, 1),
        beatIndex: integer(interrupt.beatIndex, 1), itemIndex: integer(interrupt.itemIndex),
      };
    }

    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, reason: issue(error) };
  }
}

/**
 * Projects retained original item indices in O(items + effects + references), without applying world effects.
 * An empty selection has zero effects. Invalid, duplicate or absent references return invalid_item_ref.
 */
export function projectBeatItems(
  beat: DecodedBeat,
  retainedItemRefs: readonly number[],
): DecodeResult<ProjectedBeatItem[]> {
  try {
    const retained = new Set(array(retainedItemRefs, CODEC_LIMITS.soloFirstItems).map(value => integer(value)));
    if (retained.size !== retainedItemRefs.length) reject('invalid_item_ref');
    const result: ProjectedBeatItem[] = [];
    const byIndex = new Map<number, ProjectedBeatItem>();

    for (const item of beat.items) {
      if (!retained.has(item.itemIndex)) continue;
      const projection = { item, beforeItem: [] as typeof beat.effects[number][],
        afterItem: [] as typeof beat.effects[number][] };
      byIndex.set(item.itemIndex, projection);
      result.push(projection);
    }

    if (byIndex.size !== retained.size) reject('invalid_item_ref');
    for (const effect of beat.effects) {
      const projection = byIndex.get(effect.itemRef);
      if (projection) (projection[effect.phase] as typeof beat.effects[number][]).push(effect);
    }

    return { ok: true, value: result };
  } catch (error) {
    return { ok: false, reason: issue(error) };
  }
}
