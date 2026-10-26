import { CODEC_LIMITS, MAX_EVENT_REFERENCES, MIN_ACTION_CONFIDENCE } from './types.ts';
import { countHanScriptEvidence } from '../../common/han-script.ts';
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
  const itemIds = catalog(input.itemIds);
  const placeIds = catalog(input.placeIds);
  const holderIds = new Set([...entityIds, ...itemIds, ...placeIds]);
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
    itemIds,
    placeIds,
    holderIds,
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
    && action !== 'fulfill' && action !== 'cancel') reject('unknown_kind');
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
  if (kind === 'PhysiologyEvent' || kind === 'CalendarEvent'
    || kind === 'Attempt' || kind === 'Result') reject('phase_disabled');
  if (kind === 'Unknown') return unknown(input, current, 'unknown_kind');

  const supported = ['PlayerUtterance', 'PlayerAction', 'NpcSpeech', 'NpcAction',
    'Enter', 'Exit', 'Transfer', 'ConsumeItem', 'CommitmentEvent', 'TimeAdvance'];
  if (typeof kind !== 'string' || !supported.includes(kind)) reject('unknown_kind');
  const hard = kind === 'Enter' || kind === 'Exit' || kind === 'Transfer'
    || kind === 'ConsumeItem' || kind === 'CommitmentEvent';
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
        fromId: references.entity(input.fromId, current.holderIds),
        toId: references.entity(input.toId, current.holderIds) };
    }
    if (kind === 'ConsumeItem') {
      return { ...common, kind, itemId: references.entity(input.itemId, current.itemIds) };
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
    if (typeof raw === 'string') {
      if (raw.length > MAX_TAVERN_TURN_UNITS) reject('invalid_length');
      raw = JSON.parse(raw);
    }
    const input = record(raw);
    beatKeys(input, ['items', 'effects', 'intent', 'interrupt', 'actorId']);
    const maximum = scheduledActorCount === 1 && current.envelope.beatIndex === 1
      ? CODEC_LIMITS.soloFirstItems : CODEC_LIMITS.items;
    const items = array(input.items, maximum).map<BeatItem>((value, itemIndex) => {
      const item = record(value);
      beatKeys(item, ['kind', 'text', 'addressees', 'whisperTo', 'actorId']);
      if (item.kind !== 'speech' && item.kind !== 'action') reject('unknown_kind');
      return { itemIndex, actorId: current.actorId, kind: item.kind, text: text(item.text),
        ...audience(item, current, new References()) };
    });
    const effects = array(input.effects ?? [], CODEC_LIMITS.effects).map<LinkedBeatEffect>((value, effectIndex) => {
      const entry = record(value);
      beatKeys(entry, ['itemRef', 'phase', 'effect']);
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
      beatKeys(intent, ['goal', 'next']);
      const goal = text(intent.goal, CODEC_LIMITS.goal);
      const next = text(intent.next, CODEC_LIMITS.nextCodePoints * 2);
      // Unicode iteration counts scalar/code-point slots, not UTF-16 surrogate halves. At most 120 units enter.
      if ([...next].length > CODEC_LIMITS.nextCodePoints) reject('invalid_length');
      result.intent = { goal, next };
    }

    if (input.interrupt != null) {
      const interrupt = record(input.interrupt);
      beatKeys(interrupt, ['turnId', 'turnRevision', 'beatIndex', 'itemIndex']);
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

// The closed M2 envelope cannot quietly discard misspelled fields or model-claimed quotation exemptions.
function beatKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const fields = new Set(allowed);
  if (Object.keys(input).some(key => !fields.has(key))) reject('invalid_shape');
}

/** Provisional contract ceiling in serialized UTF-16 units per turn; also bounds one JSON beat response. */
export const MAX_TAVERN_TURN_UNITS = 65_536;

/** A definite output script, selected from player evidence rather than a majority over mixed writing. */
export type TavernBeatScript = 'traditional' | 'simplified';

/** Script selection plus deterministic work counts; sources are visited newest first until one is definite. */
export interface TavernBeatScriptSelection {
  script: TavernBeatScript;
  visited: number;
  sources: number;
}

/**
 * Selects current player text, then newest-first valid chat history, then Simplified as the ruled fallback.
 * Mixed means both kinds of exclusive evidence exist, regardless of majority. O(total visited code points).
 * There is no chat-wide cap. Invalid input/getters throw invalid_beat_script_context without exposing text.
 */
export function resolveTavernBeatScript(
  playerText: string,
  history: readonly string[] | null = [],
): TavernBeatScriptSelection {
  try {
    history ??= [];
    if (typeof playerText !== 'string' || !Array.isArray(history)) throw new Error();
    let visited = 0;
    let sources = 0;
    for (let index = -1; index < history.length; index++) {
      const source = index === -1 ? playerText : history[index];
      if (typeof source !== 'string') throw new Error();
      const count = countHanScriptEvidence(source);
      visited += count.visited;
      sources++;
      if (count.traditional > 0 && count.simplified === 0) return { script: 'traditional', visited, sources };
      if (count.simplified > 0 && count.traditional === 0) return { script: 'simplified', visited, sources };
    }

    return { script: 'simplified', visited, sources };
  } catch {
    throw new Error('invalid_beat_script_context');
  }
}

/**
 * Host-provided quotation evidence for one original item. Offsets are half-open UTF-16 units.
 * sourceText must come from an authorized, current source; the model cannot grant access or provide this list.
 */
export interface TavernBeatQuotation {
  itemRef: number;
  start: number;
  end: number;
  sourceId: string;
  sourceRevision: number;
  sourceText: string;
  sourceStart: number;
  sourceEnd: number;
}

/** Mechanical script result; the counts measure scanned speech code points and checked quotation UTF-16 units. */
export type TavernBeatScriptCheck = {
  visited: number;
  quoteUnits: number;
} & ({ ok: true } | { ok: false; reason: 'script_mismatch' | 'invalid_quotation' | 'invalid_script_context' });

/**
 * Checks speech without modifying any text. Only exact host-sourced spans are exempt; actions are not speech.
 * At most six 800-unit items and 4,800 quotation spans enter. Work is O(speech units + checked quote units).
 * Bad host data/getters return invalid_script_context; mismatched source spans return invalid_quotation.
 */
export function checkTavernBeatScript(
  beat: DecodedBeat,
  script: TavernBeatScript,
  quotations: readonly TavernBeatQuotation[] | null = [],
): TavernBeatScriptCheck {
  let visited = 0;
  let quoteUnits = 0;
  try {
    if (script !== 'traditional' && script !== 'simplified') throw new Error();
    const items = array(beat.items, CODEC_LIMITS.soloFirstItems).map(value => record(value));
    const masks = new Map<number, Uint8Array>();
    const byIndex = new Map<number, Record<string, unknown>>();
    for (const item of items) {
      const index = integer(item.itemIndex);
      const literal = text(item.text);
      if (byIndex.has(index)) throw new Error();
      byIndex.set(index, item);
      masks.set(index, new Uint8Array(literal.length));
    }
    const quotes = array(quotations ?? [], CODEC_LIMITS.soloFirstItems * CODEC_LIMITS.text);
    for (const value of quotes) {
      const quote = record(value);
      const itemRef = integer(quote.itemRef);
      const item = byIndex.get(itemRef);
      const start = integer(quote.start);
      const end = integer(quote.end);
      const sourceStart = integer(quote.sourceStart);
      const sourceEnd = integer(quote.sourceEnd);
      identifier(quote.sourceId);
      integer(quote.sourceRevision, 1);
      if (item?.kind !== 'speech' || typeof quote.sourceText !== 'string'
        || end <= start || end > (item.text as string).length
        || sourceEnd <= sourceStart || sourceEnd > quote.sourceText.length
        || end - start !== sourceEnd - sourceStart) {
        return { ok: false, reason: 'invalid_quotation', visited, quoteUnits };
      }
      quoteUnits += end - start;
      if ((item.text as string).slice(start, end) !== quote.sourceText.slice(sourceStart, sourceEnd)) {
        return { ok: false, reason: 'invalid_quotation', visited, quoteUnits };
      }
      masks.get(itemRef)!.fill(1, start, end);
    }

    let mismatch = false;
    for (const item of items) {
      if (item.kind !== 'speech') continue;
      const literal = item.text as string;
      const mask = masks.get(item.itemIndex as number)!;
      let offset = 0;
      for (const character of literal) {
        visited++;
        // Both surrogate units must be covered before a supplementary code point can be exempted.
        const quoted = mask[offset] === 1 && (character.length === 1 || mask[offset + 1] === 1);
        offset += character.length;
        if (quoted) continue;
        const count = countHanScriptEvidence(character);
        if (script === 'traditional' ? count.simplified > 0 : count.traditional > 0) mismatch = true;
      }
    }

    return mismatch ? { ok: false, reason: 'script_mismatch', visited, quoteUnits } : { ok: true, visited, quoteUnits };
  } catch {
    return { ok: false, reason: 'invalid_script_context', visited, quoteUnits };
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

/** Machine format for M1 envelopes; it is a protocol identifier, not model instruction wording. */
export const TAVERN_INTERPRETATION_FORMAT = 'tavern-interpretation-v1';

/** Provisional per-response event limit, matching the existing perspective stage's 12-observation budget. */
export const MAX_INTERPRETATION_EVENTS = 12;

function interpretationKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(input).some(key => !keys.has(key))) reject('invalid_shape');
}

// KMP counts overlapping matches in O(source units + quote units), with O(quote units) scratch space.
// Stop after the second match: a missing span cannot choose between occurrences, even if they overlap.
function uniqueQuoteOffset(source: string, quote: string): number {
  if (quote.length === 0 || quote.length > source.length) reject('evidence_not_found');
  const prefixes = new Uint32Array(quote.length);
  let matched = 0;
  for (let index = 1; index < quote.length; index++) {
    const unit = quote.charCodeAt(index);
    while (matched > 0 && unit !== quote.charCodeAt(matched)) matched = prefixes[matched - 1];
    if (unit === quote.charCodeAt(matched)) matched++;
    prefixes[index] = matched;
  }

  matched = 0;
  let start = -1;
  for (let index = 0; index < source.length; index++) {
    const unit = source.charCodeAt(index);
    while (matched > 0 && unit !== quote.charCodeAt(matched)) matched = prefixes[matched - 1];
    if (unit === quote.charCodeAt(matched)) matched++;
    if (matched !== quote.length) continue;
    if (start !== -1) reject('evidence_ambiguous');
    start = index - quote.length + 1;
    matched = prefixes[matched - 1];
  }

  if (start === -1) reject('evidence_not_found');
  return start;
}

function interpretationEvidence(value: unknown, current: Context): ObservationSource {
  const input = record(value);
  interpretationKeys(input, ['sourceId', 'revision', 'start', 'end', 'quote']);
  const sourceId = identifier(input.sourceId);
  const revision = integer(input.revision, 1);
  if (sourceId !== current.origin.sourceId || revision !== current.origin.sourceRevision
    || typeof input.quote !== 'string') {
    reject('invalid_reference');
  }

  const quote = input.quote;
  let start: number;
  let end: number;
  if (input.start != null || input.end != null) {
    if (typeof input.start !== 'number' || !Number.isSafeInteger(input.start) || input.start < 0
      || typeof input.end !== 'number' || !Number.isSafeInteger(input.end) || input.end <= input.start
      || input.end > current.messageText.length
      || current.messageText.slice(input.start, input.end) !== quote) {
      reject('evidence_span_mismatch');
    }
    start = input.start;
    end = input.end;
  } else {
    start = uniqueQuoteOffset(current.messageText, quote);
    end = start + quote.length;
  }

  return { channel: 'message', sourceId, revision, start, end };
}

function interpretationPayload(value: unknown, current: Context): EventPayload {
  let candidate: Record<string, unknown> = Object.create(null);
  try {
    const entry = record(value);
    candidate = record(entry.payload);
    interpretationKeys(entry, ['payload', 'confidence', 'evidence', 'temporality']);
    const confidence = finite(entry.confidence, 0, 1);
    const source = interpretationEvidence(entry.evidence, current);
    const temporality = entry.temporality;
    if (temporality !== 'current' && temporality !== 'recollection' && temporality !== 'plan') {
      reject('invalid_shape');
    }
    // Historical/planned acts are not present effects. The existing clock remains the sole time authority.
    if (temporality !== 'current') reject('invalid_source');

    const common = ['kind', 'actorId', 'confidence', 'evidence', 'text'];
    switch (candidate.kind) {
      case 'PlayerUtterance':
        interpretationKeys(candidate, [...common, 'addressees', 'whisperTo']);
        break;
      case 'PlayerAction':
        interpretationKeys(candidate, [...common, 'action', 'targets', 'objects']);
        interpretationKeys(record(candidate.action), ['kind']);
        break;
      case 'Enter':
      case 'Exit':
        interpretationKeys(candidate, [...common, 'entityId', 'placeId']);
        break;
      case 'Transfer':
        interpretationKeys(candidate, [...common, 'itemId', 'fromId', 'toId']);
        break;
      case 'ConsumeItem':
        interpretationKeys(candidate, [...common, 'itemId']);
        break;
      case 'CommitmentEvent':
        interpretationKeys(candidate, [...common, 'operation']);
        const operation = record(candidate.operation);
        interpretationKeys(operation, [
          'operationId', 'action', 'quote', 'evidence', 'commitmentId', 'targetId', 'targetRevision',
          'content', 'participants', 'obligors', 'agreement', 'term',
        ]);
        for (const entry of array(operation.evidence, MAX_EVENT_REFERENCES)) {
          interpretationKeys(record(entry), ['actorId', 'quote']);
        }
        if (operation.term != null) {
          const term = record(operation.term);
          interpretationKeys(term, term.kind === 'deadline'
            ? ['kind', 'clock', 'deadlineQuote', 'reminderQuote', 'dueAtMs', 'remindAtMs']
            : ['kind']);
        }
        break;
      case 'Unknown':
        interpretationKeys(candidate, [...common, 'reason']);
        break;
      default:
        reject('unknown_kind');
    }

    if (candidate.text != null) text(candidate.text);
    // Confidence and evidence on the wrapper override nested model values; actor identity is host-owned.
    return decodePayload({ ...candidate, confidence, evidence: [source] }, current);
  } catch (error) {
    return unknown(candidate, current, issue(error));
  }
}

/**
 * Decodes one M1 response using the existing event vocabulary and host identity; never applies effects.
 * The response is {format, events:[{payload, confidence, evidence, temporality}]}. Evidence is one exact
 * Quote is mandatory; omitted/null offsets resolve only a unique exact match, including overlapping matches.
 * Stored evidence remains a UTF-16 half-open message span. Only current acts pass temporality validation.
 * Invalid envelopes fail for retry. Invalid individual candidates retain their position as Unknown.
 * Work is O(catalog entries + response fields + source text): at most 12 events, each text at most 800 units.
 * Source text/catalogs have no chat-wide cap. Own-property readers reject accessors without invoking them.
 */
export function decodeInterpretationCandidate(
  raw: unknown,
  suppliedContext: EventDecodeContext,
): DecodeResult<readonly EngineEvent[]> {
  try {
    const current = context(suppliedContext);
    if (current.envelope.source !== 'interpret' || current.envelope.status !== 'tentative') {
      reject('invalid_context');
    }
    const input = record(raw);
    interpretationKeys(input, ['format', 'events']);
    if (input.format !== TAVERN_INTERPRETATION_FORMAT) reject('invalid_shape');
    const events = array(input.events, MAX_INTERPRETATION_EVENTS).map((value, index) => ({
      envelope: { ...current.envelope, id: JSON.stringify([current.envelope.id, index]) },
      origin: current.origin,
      payload: interpretationPayload(value, current),
    }));

    return { ok: true, value: events };
  } catch (error) {
    return { ok: false, reason: issue(error) };
  }
}
