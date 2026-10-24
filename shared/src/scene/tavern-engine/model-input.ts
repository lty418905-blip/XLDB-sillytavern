/**
 * Actor-scoped model input assembly and injected execution over accepted, source-checked state.
 * SLOT-M1, SLOT-M2 and SLOT-RETRY wording belongs to Claude. Only data and injected runners are assembled here.
 */
import type { MemoryView } from '../../memory/access.ts';
import type { ActionSchedule, CandidateAction } from './actions.ts';
import type { TavernTurnIdentity } from './engine.ts';
import type { filterTavernEngineSnapshot } from './store.ts';
import type { TavernActorWorldProjection } from './projection.ts';
import type { AcceptedMessage } from '../../core/types.ts';
import type { PerspectivePlan } from '../types.ts';
import { decodeInterpretationCandidate, resolveTavernBeatScript, TAVERN_INTERPRETATION_FORMAT } from './codec.ts';
import type { TavernBeatScript } from './codec.ts';
import type {
  TavernAcceptedPlayerInterpretation,
  TavernEnginePorts,
  TavernInterpretationReply,
} from './engine.ts';
import { TavernPerception } from './perception.ts';
import { projectTavernWorld, projectTavernActorWorld } from './projection.ts';
import type { TavernSourceReference } from './store.ts';
import { CODEC_LIMITS } from './types.ts';
import type {
  EventDecodeContext,
  EventReference,
  DecodedBeat,
  EventOrigin,
  TavernActorEventView,
  TavernPerceptionInput,
  TavernPerceptionDispatch,
} from './types.ts';

/** SLOT-M1, 待 Claude. Empty until approved wording is supplied; not a usable production prompt. */
export const SLOT_M1_INSTRUCTIONS = '';

/** SLOT-M2, 待 Claude. Empty wording slot; it is not a production prompt. */
export const SLOT_M2_INSTRUCTIONS = '';

/** SLOT-RETRY, 待 Claude. Empty wording slot; mechanical reason codes are separate data. */
export const SLOT_RETRY_INSTRUCTIONS = '';

/** SLOT-INTENT, 待 Claude. Empty until approved wording exists; it is not a production prompt. */
export const SLOT_INTENT_INSTRUCTIONS = '';

/**
 * One first-dispatch front request: authorized actor data only, with no model settings or credentials.
 * The injected port returns {goal, next}; the engine validates it with the existing beat intent codec.
 * Prefix stays fixed; tail reflects the world immediately before this actor's first beat.
 */
export interface TavernIntentInput {
  instructions: typeof SLOT_INTENT_INSTRUCTIONS;
  identity: TavernInterpretationRequest['identity'];
  actorId: string;
  configurationId: string;
  prefix: TavernBeatPrefix;
  tail: TavernPerceptionDispatch['input'];
}

/**
 * Per-actor M2 contract supplied by preparation. Configuration IDs identify resolved settings, never secrets.
 * Different settings use a precomputed front intent or the engine's first-dispatch intent port.
 * history is newest-first current, authorized player text; null optional fields mean omission.
 */
export interface TavernBeatActorContract {
  actorId: string;
  beatConfigurationId: string;
  frontConfigurationId: string;
  frontIntent?: NonNullable<DecodedBeat['intent']> | null;
  persona?: string | null;
  history?: readonly string[] | null;
  /** Caller-authorized IDs for this actor's beats; never replace these with the global world catalog. */
  references?: TavernInterpretationReferences | null;
  /** Display data captured at turn preparation; null/omission supplies an empty table. */
  names?: TavernNameTable | null;
}

/** Stable per-actor starting data; only the supplied, already filtered materials and history enter this prefix. */
export interface TavernBeatPrefix {
  presetParts?: readonly TavernContextPresetPart[] | null;
  persona: string;
  materials: TavernPerceptionDispatch['input']['materials'];
  turnWindow: TavernPerceptionDispatch['input']['turnWindow'];
  /** Fixed display data, checked against this actor's references at every build. */
  names?: TavernNameTable | null;
}

/**
 * Structured runner input. prefix is fixed at turn start; tail is the current actor-only delivery snapshot.
 * Script/limits are data, not instruction wording. Intent is optional until the first same-setting response.
 */
export interface TavernBeatInput {
  instructions: typeof SLOT_M2_INSTRUCTIONS;
  retryInstructions: typeof SLOT_RETRY_INSTRUCTIONS;
  actorId: string;
  identity: TavernInterpretationRequest['identity'];
  beatIndex: number;
  maxItems: number;
  firstForActor: boolean;
  intentRequired: boolean;
  script: TavernBeatScript;
  prefix: TavernBeatPrefix;
  tail: TavernPerceptionDispatch['input'];
  intent?: NonNullable<DecodedBeat['intent']>;
  retryReasons: readonly string[];
  /** Non-enumerable local diagnostics; cloning for a model never sends discarded-preset metadata. */
  readonly presetDiagnostics?: TavernContextPreset['diagnostics'];
}

/** Injected M2 call; supports synchronous values/thenables. Retries and cancellation belong to the engine. */
export type TavernBeatRunner = (input: TavernBeatInput, signal: AbortSignal) => unknown | PromiseLike<unknown>;

function intentTriggered(input: TavernPerceptionDispatch['input']): boolean {
  // Only newly delivered, already authorized structural events count. No free-text topic inference occurs.
  return input.inbox.some(({ content }) => {
    if (content.kind === 'Enter' || content.kind === 'Exit' || content.kind === 'Transfer'
      || content.kind === 'CommitmentEvent') return true;
    return 'addressees' in content && content.addressees.includes(input.actorId);
  });
}

/**
 * Assembles one detached M2 snapshot from a prepared prefix and current filtered tail; never reads the world.
 * Throws invalid_m2_context on bad caller data/getters. Text work is linear in input bytes and visited history.
 * Retry takes the same snapshot; only the engine's mechanical retryReasons change between attempts.
 */
export function buildTavernBeatInput(
  request: Omit<Parameters<TavernEnginePorts['beat']>[0], 'signal' | 'modelInput'>,
  contract: TavernBeatActorContract,
  prefix: TavernBeatPrefix,
  playerText: string,
): TavernBeatInput {
  try {
    const data = structuredClone({ request, contract, prefix });
    const current = data.request;
    if (current.actorId !== data.contract.actorId || current.input.actorId !== current.actorId
      || typeof current.firstForActor !== 'boolean'
      || !Number.isSafeInteger(current.beatIndex) || current.beatIndex < 1
      || (current.maxItems !== CODEC_LIMITS.items && current.maxItems !== CODEC_LIMITS.soloFirstItems)
      || ![0, 1].includes(current.attempt)) {
      throw new Error();
    }
    for (const value of [current.actorId, data.contract.beatConfigurationId, data.contract.frontConfigurationId]) {
      requireId(value);
    }
    const script = resolveTavernBeatScript(playerText, data.contract.history ?? []).script;
    const preset = boundTavernPresetParts(data.prefix.presetParts);
    const names = checkedNames(data.prefix.names, data.contract.references);
    const result: TavernBeatInput = {
      identity: current.identity,
      actorId: current.actorId,
      beatIndex: current.beatIndex,
      maxItems: current.maxItems,
      firstForActor: current.firstForActor,
      intentRequired: current.firstForActor
        ? data.contract.beatConfigurationId === data.contract.frontConfigurationId
        : intentTriggered(current.input),
      script,
      prefix: {
        persona: data.prefix.persona,
        ...(preset.parts.length === 0 ? {} : { presetParts: preset.parts }),
        materials: data.prefix.materials,
        turnWindow: data.prefix.turnWindow,
        names,
      },
      tail: current.input,
      ...(current.intent == null ? {} : { intent: current.intent }),
      retryReasons: current.retryReasons,
      retryInstructions: SLOT_RETRY_INSTRUCTIONS,
      instructions: SLOT_M2_INSTRUCTIONS,
    };
    if (preset.diagnostics.length > 0) {
      Object.defineProperty(result, 'presetDiagnostics', { value: preset.diagnostics });
    }
    return result;
  } catch {
    throw new Error('invalid_m2_context');
  }
}

/**
 * Runs exactly one injected attempt, without rewriting/parsing speech or adding a retry loop.
 * Missing input and pre-cancellation throw machine codes. Runner/thenable errors propagate to engine Abort.
 */
export async function runTavernBeat(
  request: Parameters<TavernEnginePorts['beat']>[0],
  runner: TavernBeatRunner,
): Promise<unknown> {
  if (request.signal.aborted) throw new Error('m2_cancelled');
  if (request.modelInput == null) throw new Error('invalid_m2_context');
  const result = await runner(structuredClone(request.modelInput), request.signal);
  if (request.signal.aborted) throw new Error('m2_cancelled');
  return result;
}

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

/** Display-only person entry; name/aliases use 1..80 UTF-16 units, with at most eight aliases per person. */
export interface TavernPersonName {
  id: string;
  name: string;
  aliases: readonly string[];
}

/** Display-only item or place entry; the name uses 1..80 UTF-16 units and never grants authority. */
export interface TavernEntityName {
  id: string;
  name: string;
}

/** Caller-supplied display table shared by M1/M2; IDs are unique across all rows, including the player. */
export interface TavernNameTable {
  people: readonly TavernPersonName[];
  items: readonly TavernEntityName[];
  places: readonly TavernEntityName[];
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
  names?: TavernNameTable | null;
  /** Required in direct mode and checked against entityIds; null in automatic mode means omission. */
  directTargetId?: string | null;
  plan?: PerspectivePlan | null;
  /** Already classified permissions note; null/omission adds no note. */
  contentPermissions?: string | null;
}

/** Structured M1 data only: accepted user text, scoped identities, sourced presence and EN-06 filtered history. */
export interface TavernInterpretationInput {
  format: typeof TAVERN_INTERPRETATION_FORMAT;
  instructions: typeof SLOT_M1_INSTRUCTIONS;
  mode: 'automatic' | 'direct';
  origin: EventOrigin;
  configurationId: string;
  contentPermissions?: string;
  message: AcceptedMessage;
  references: TavernInterpretationReferences;
  names: TavernNameTable;
  directTargetId?: string;
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

function checkedNames(
  supplied: TavernNameTable | null | undefined,
  references: TavernInterpretationReferences | null | undefined,
): TavernNameTable {
  const table = supplied ?? { people: [], items: [], places: [] };
  const allowed = references ?? { entityIds: [], itemIds: [], placeIds: [] };
  if (typeof table !== 'object' || Array.isArray(table)
    || !Array.isArray(table.people) || !Array.isArray(table.items) || !Array.isArray(table.places)) {
    throw new Error('invalid_name_table');
  }
  const people = new Set(referenceSubset(allowed.entityIds, allowed.entityIds));
  const items = new Set(referenceSubset(allowed.itemIds, allowed.itemIds));
  const places = new Set(referenceSubset(allowed.placeIds, allowed.placeIds));
  const seen = new Set<string>();

  // Product bounds apply per name and per person, never to the number of known identities in a chat.
  function name(value: unknown): string {
    // Provisional slice choice: 80 UTF-16 units per name, pending calibration; the contract sets no numeric value.
    if (typeof value !== 'string' || value.length < 1 || value.length > 80) {
      throw new Error('invalid_name_table');
    }
    return value;
  }

  function row(value: TavernEntityName, catalog: ReadonlySet<string>): TavernEntityName {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('invalid_name_table');
    }
    const id = value.id;
    requireId(id);
    if (!catalog.has(id) || seen.has(id)) throw new Error('invalid_name_table');
    seen.add(id);
    return { id, name: name(value.name) };
  }

  // Linear in reference/name rows and copied text; each person has at most eight bounded aliases.
  const result: { people: TavernPersonName[]; items: TavernEntityName[]; places: TavernEntityName[] } = {
    people: [],
    items: [],
    places: [],
  };
  for (const person of table.people) {
    const entry = row(person, people);
    // Provisional slice choice: eight aliases per person, pending calibration; the contract sets no numeric value.
    if (!Array.isArray(person.aliases) || person.aliases.length > 8) throw new Error('invalid_name_table');
    const aliases: string[] = [];
    for (const alias of person.aliases) aliases.push(name(alias));
    result.people.push({ ...entry, aliases });
  }
  for (const item of table.items) result.items.push(row(item, items));
  for (const place of table.places) result.places.push(row(place, places));
  return result;
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
    const names = checkedNames(supplied.names, references);
    const directTargetId = supplied.directTargetId;
    if (supplied.mode === 'direct' && !references.entityIds.includes(directTargetId!)) {
      throw new Error('invalid_m1_target');
    }
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
    const contentPermissions = supplied.contentPermissions;
    if (contentPermissions != null && typeof contentPermissions !== 'string') {
      throw new Error('invalid_m1_context');
    }
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
      ...(contentPermissions == null ? {} : { contentPermissions }),
      message,
      references,
      names,
      ...(supplied.mode === 'direct' ? { directTargetId: directTargetId! } : {}),
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

/** SLOT-CANDIDATE, 待 Claude. Empty wording slot; candidate actions remain structured data. */
export const SLOT_CANDIDATE_INSTRUCTIONS = '';

/** Ruled per-turn M2 preset text budget, in UTF-16 code units; whole longest parts are dropped first. */
export const TAVERN_PRESET_UNITS = 8_000;

/** Classified caller data, not a preset parser. order is a nonnegative host order; ties retain input order. */
export interface TavernContextPresetPart {
  label: 'content_permissions' | 'character_voice' | 'world_lore' | 'player_proxy'
    | 'format_addon' | 'reasoning_scaffold' | 'prose_style' | 'unknown';
  role: 'system' | 'user' | 'assistant';
  content: string;
  order: number;
}

/** Data-only preset boundary; diagnostics contain indices and counts, never discarded text. */
export interface TavernContextPreset {
  parts: readonly TavernContextPresetPart[];
  diagnostics: readonly { code: 'preset_part_dropped'; index: number; units: number }[];
  visited: number;
}

/**
 * Selects the two M2 labels, orders by host order, then bounds their total text to 8,000 UTF-16 units.
 * Null means no parts. Equal-length removals drop the later input first, preserving earlier precedence.
 * O(parts log parts + retained text); each supplied part is visited once, excluded content is never read.
 * Invalid allowed parts throw invalid_context_preset; caller getter errors propagate unchanged.
 */
export function boundTavernPresetParts(
  parts?: readonly TavernContextPresetPart[] | null,
): TavernContextPreset {
  if (parts == null) return { parts: [], diagnostics: [], visited: 0 };
  if (!Array.isArray(parts)) throw new TypeError('invalid_context_preset');
  const selected: { part: TavernContextPresetPart; index: number }[] = [];
  let units = 0;
  let visited = 0;

  for (const [index, supplied] of parts.entries()) {
    visited++;
    if (supplied == null || typeof supplied !== 'object') throw new TypeError('invalid_context_preset');
    const label = Object.hasOwn(supplied, 'label') ? supplied.label : undefined;
    if (label !== 'content_permissions' && label !== 'character_voice') continue;
    const content = Object.hasOwn(supplied, 'content') ? supplied.content : undefined;
    const role = Object.hasOwn(supplied, 'role') ? supplied.role : undefined;
    const order = Object.hasOwn(supplied, 'order') ? supplied.order : undefined;
    if (typeof content !== 'string' || !['system', 'user', 'assistant'].includes(role!)
      || !Number.isSafeInteger(order) || order! < 0) {
      throw new TypeError('invalid_context_preset');
    }
    units += content.length;
    selected.push({ part: { label, role: role!, content, order: order! }, index });
  }

  const dropped = new Set<number>();
  const diagnostics: TavernContextPreset['diagnostics'][number][] = [];
  const longest = [...selected].sort((left, right) =>
    right.part.content.length - left.part.content.length || right.index - left.index);
  for (const entry of longest) {
    if (units <= TAVERN_PRESET_UNITS) break;
    dropped.add(entry.index);
    units -= entry.part.content.length;
    diagnostics.push({ code: 'preset_part_dropped', index: entry.index, units: entry.part.content.length });
  }

  return {
    parts: selected.filter(entry => !dropped.has(entry.index))
      .sort((left, right) => left.part.order - right.part.order || left.index - right.index)
      .map(entry => entry.part),
    diagnostics,
    visited,
  };
}

/**
 * Current authority read plus the in-process emitted overlay. Source records are ledger validity inputs,
 * never a host message array used to count turns. version is the scene authority revision.
 */
export interface TavernContextState {
  version: number;
  perception: TavernPerceptionInput;
  /** Existing sourced schedule projection; absent/null means no additional known schedules. */
  schedules?: readonly ActionSchedule[] | null;
  sources: readonly {
    id: string;
    revision: number;
    status: string;
    message?: string | null;
    /** Original accepted source text for script selection; an event excerpt cannot establish a pure script. */
    text?: string | null;
  }[];
}

/**
 * Server recall result after actor filtering and forgetting rewrite. Only selected MemoryViews are public;
 * context is the already rewritten text. Internal rehearsal/snapshot fields are deliberately not part of it.
 */
export interface TavernContextRecall {
  actorId: string;
  version: number;
  memories: readonly MemoryView[];
  context: string;
  constraints: readonly string[];
  emotion: unknown;
  relationships: unknown;
}

/**
 * Server-only preparation ports. Barriers finish before any authority read or recall. Foreground includes
 * prior required foreground work and this player's state; it must not join the roster's background jobs.
 * recall is called once per unique actor for this context. Callback/thenable failures propagate unchanged.
 */
export interface TavernContextPorts {
  waitForPlayer(identity: TavernTurnIdentity, signal: AbortSignal): unknown | PromiseLike<unknown>;
  waitForForeground(identity: TavernTurnIdentity, signal: AbortSignal): unknown | PromiseLike<unknown>;
  readState(identity: TavernTurnIdentity): TavernContextState;
  /** Inject the existing ledger filter; importing its store would give the inert engine persistence capabilities. */
  filterLedger: typeof filterTavernEngineSnapshot;
  recall(input: {
    identity: TavernTurnIdentity;
    actorId: string;
    version: number;
    known: TavernActorEventView;
  }, signal: AbortSignal): TavernContextRecall | PromiseLike<TavernContextRecall>;
}

/** Immutable actor starting data in serialization order: identity/persona/script, preset, then recall/history. */
export interface TavernContextPrefix extends TavernBeatPrefix {
  actorId: string;
  identity: TavernTurnIdentity;
  script: TavernBeatScript;
  recall: Pick<TavernContextRecall, 'memories' | 'context' | 'constraints' | 'emotion' | 'relationships'>;
}

/** One beat's local scheduling data; counts are nonnegative integers, intent remains a private suggestion. */
export interface TavernContextBeatPosition {
  actorId: string;
  beatIndex: number;
  maxItems: number;
  firstForActor: boolean;
  remainingSlots: number;
  interruptible?: readonly EventReference[] | null;
  intent?: NonNullable<DecodedBeat['intent']> | null;
}

/** Fully segmented data; the two Claude-owned slots are last and empty. No token/cache benefit is asserted. */
export interface TavernContextBeatInput {
  prefix: TavernContextPrefix;
  tail: {
    delivery: TavernPerceptionDispatch['input'];
    world: TavernActorWorldProjection;
    schedules: readonly ActionSchedule[];
    candidates: readonly CandidateAction[];
    intent?: NonNullable<DecodedBeat['intent']>;
    intentRequired: boolean;
    triggerEventIds: readonly string[];
    position: Omit<TavernContextBeatPosition, 'intent'>;
    limits: typeof CODEC_LIMITS;
  };
  candidateInstructions: typeof SLOT_CANDIDATE_INSTRUCTIONS;
  instructions: typeof SLOT_M2_INSTRUCTIONS;
}

/**
 * Server-owned context. JSON cannot recreate its methods or replace its captured recall. Returned values
 * are detached; acknowledgement advances only the matching perception receipt after legal consumption.
 */
export interface TavernPreparedContext {
  prefix(actorId: string): TavernContextPrefix;
  diagnostics: TavernContextPreset['diagnostics'];
  prepareBeat(position: TavernContextBeatPosition): {
    input: TavernContextBeatInput;
    prefixJson: string;
    receipt: object;
  };
  acknowledgeDispatch(receipt: object): boolean;
}

function validContextPerception(
  state: TavernContextState,
  filterLedger: TavernContextPorts['filterLedger'],
): TavernPerceptionInput {
  const accepted = state.perception.steps.filter(step => step.kind === 'accepted');
  const rows = accepted.map(({ turn }) => ({
    turn_id: turn.turnId,
    turn_revision: turn.turnRevision,
    kind: turn.kind,
    body: JSON.stringify(turn),
  }));
  // Reuse the ledger's transitive source/evidence invalidation, including edited and deleted revisions.
  const valid = filterLedger({ turns: rows, receipts: [] }, state.sources)!;
  const retained = new Set(valid.turns);
  let index = 0;
  return {
    ...state.perception,
    steps: state.perception.steps.filter(step => step.kind !== 'accepted' || retained.has(rows[index++]!)),
  };
}

function currentContextState(
  supplied: TavernContextState,
  identity: TavernTurnIdentity,
  filterLedger: TavernContextPorts['filterLedger'],
  version?: number,
): TavernContextState {
  const state = structuredClone(supplied);
  if (!Number.isSafeInteger(state.version) || state.version < 0
    || (version !== undefined && state.version !== version)
    || !sameScope(state.perception.baseline.scope, identity.scope)) {
    throw new Error('stale_tavern_context');
  }
  state.perception = validContextPerception(state, filterLedger);
  const player = state.perception.steps.some(step => step.kind === 'accepted'
    && step.turn.kind === 'interpret' && step.turn.turnId === identity.turnId
    && step.turn.turnRevision === identity.turnRevision
    && step.turn.source.id === identity.playerSource.id
    && step.turn.source.revision === identity.playerSource.revision);
  if (!player) throw new Error('context_player_not_ready');
  return state;
}

function contextMemory(memory: MemoryView): MemoryView {
  const { id, source, access, kind, protectedFacts } = memory;
  const { messageId, revision, occurredAtMs, knownAtMs, author, reference, knowledge } = source;
  const result: MemoryView = {
    id,
    source: {
      messageId,
      revision,
      occurredAtMs,
      knownAtMs,
      ...(author == null ? {} : { author }),
      ...(reference == null ? {} : { reference }),
      ...(knowledge == null ? {} : { knowledge }),
    },
    access,
    kind,
    protectedFacts,
  };
  if (!['clear', 'gist', 'feeling', 'anchor', 'hidden'].includes(access)) {
    throw new TypeError('invalid_context_recall');
  }
  // Copy the already rewritten visible layers only. This does not perform another recall or rewrite.
  const fields: (keyof MemoryView)[] = [
    'reactivated', 'reactivation', 'feelingBasis', 'emotionalReaction', 'rememberedFragments', 'forgottenMarker',
  ];
  if (access === 'clear') fields.push('detail', 'episode');
  if (access === 'clear' || access === 'gist') fields.push('gist');
  if (access === 'clear' || access === 'gist' || access === 'feeling') fields.push('feeling');
  if (access !== 'hidden') fields.push('anchor');
  if (access === 'gist') fields.push('recalledDetails', 'strayDetail');
  for (const field of fields) {
    const value = Object.hasOwn(memory, field) ? memory[field] : undefined;
    if (value != null) Object.assign(result, { [field]: value });
  }
  return result;
}

function contextRecall(value: TavernContextRecall, actorId: string, version: number): TavernContextPrefix['recall'] {
  const {
    actorId: returnedActor,
    version: returnedVersion,
    memories,
    context,
    constraints,
    emotion,
    relationships,
  } = value;
  if (returnedActor !== actorId || returnedVersion !== version || !Array.isArray(memories)
    || typeof context !== 'string' || !Array.isArray(constraints)
    || !constraints.every(constraint => typeof constraint === 'string')
    || emotion === undefined || relationships === undefined) {
    throw new TypeError('invalid_context_recall');
  }

  // The server port supplies completed MemoryViews, not Memory records. Never inspect its private rehearsal.
  return structuredClone({ memories: memories.map(contextMemory), context, constraints, emotion, relationships });
}

/**
 * Prepares one turn after both required barriers, then recalls each actor exactly once, before any beat.
 * Reads only server ports; request-supplied recall JSON and unknown fields are ignored. No model/store is imported.
 * History validity is folded once per state, not once per actor prefix. Work is O(ledger bytes + routed bytes
 * + actors * visible history + preset sorting), with no chat-wide cap. Errors/getters propagate unchanged.
 * A changed authority revision cancels reuse; callers discard this context on edits, rollback or cancellation.
 */
export async function prepareTavernTurnContext(
  request: {
    identity: TavernTurnIdentity;
    actors: readonly TavernBeatActorContract[];
    playerText: string;
    presetParts?: readonly TavernContextPresetPart[] | null;
    signal: AbortSignal;
  },
  ports: TavernContextPorts,
): Promise<TavernPreparedContext> {
  const { identity: suppliedIdentity, actors: suppliedActors, playerText, signal } = request;
  const identity = structuredClone(suppliedIdentity);
  const actors = structuredClone(suppliedActors);
  const preset = boundTavernPresetParts(Object.hasOwn(request, 'presetParts') ? request.presetParts : undefined);
  const { waitForPlayer, waitForForeground, readState, filterLedger, recall } = ports;
  const checkCancelled = (): void => {
    if (signal.aborted) throw new Error('context_cancelled');
  };
  const actorSet = new Set<string>();
  for (const actor of actors) {
    if (typeof actor.actorId !== 'string' || actor.actorId.length === 0 || actorSet.has(actor.actorId)
      || typeof actor.beatConfigurationId !== 'string' || actor.beatConfigurationId.length === 0
      || typeof actor.frontConfigurationId !== 'string' || actor.frontConfigurationId.length === 0) {
      throw new Error('invalid_context_actor');
    }
    actorSet.add(actor.actorId);
  }
  checkCancelled();
  await waitForPlayer(structuredClone(identity), signal);
  checkCancelled();
  await waitForForeground(structuredClone(identity), signal);
  checkCancelled();
  const start = currentContextState(readState(structuredClone(identity)), identity, filterLedger);
  const perception = new TavernPerception(start.perception);
  const prefixes = new Map<string, { prefix: TavernContextPrefix; json: string; contract: TavernBeatActorContract }>();

  const sources = new Map(start.sources.map(source => [source.id, source]));
  const playerTurns = start.perception.steps.filter(step => step.kind === 'accepted')
    .filter(step => step.turn.kind === 'interpret');
  const current = playerTurns.find(step => step.turn.turnId === identity.turnId
    && step.turn.turnRevision === identity.turnRevision)!;
  const playerHistory = playerTurns.filter(step => step.turn.version < current.turn.version)
    .sort((left, right) => right.turn.version - left.turn.version)
    .flatMap(step => {
      const text = sources.get(step.turn.source.id)?.text;
      return text == null ? [] : [text];
    });
  const currentText = sources.get(identity.playerSource.id)?.text ?? playerText;
  const script = resolveTavernBeatScript(currentText, playerHistory).script;

  for (const contract of actors) {
    const actorId = contract.actorId;
    if (prefixes.has(actorId) || actorId === start.perception.playerId) {
      throw new Error('invalid_context_actor');
    }
    const known = perception.view(actorId);
    const history = perception.recentTurnWindow(actorId, identity.turnId, identity.turnRevision);
    const recalled = contextRecall(await recall({
      identity: structuredClone(identity),
      actorId,
      version: start.version,
      known,
    }, signal), actorId, start.version);
    checkCancelled();
    if (contract.persona != null && typeof contract.persona !== 'string') throw new Error('invalid_context_actor');
    const prefix: TavernContextPrefix = {
      actorId,
      identity: structuredClone(identity),
      persona: contract.persona ?? '',
      script,
      ...(preset.parts.length === 0 ? {} : { presetParts: preset.parts }),
      recall: recalled,
      materials: [],
      turnWindow: history,
      names: checkedNames(contract.names, contract.references),
    };
    prefixes.set(actorId, { prefix, json: JSON.stringify(prefix), contract });
  }

  currentContextState(readState(structuredClone(identity)), identity, filterLedger, start.version);

  function entryFor(actorId: string) {
    const entry = prefixes.get(actorId);
    if (!entry) throw new Error('invalid_context_actor');
    return entry;
  }

  return {
    diagnostics: structuredClone(preset.diagnostics),
    prefix(actorId) {
      checkCancelled();
      return structuredClone(entryFor(actorId).prefix);
    },
    prepareBeat(suppliedPosition) {
      checkCancelled();
      const position = structuredClone(suppliedPosition);
      const entry = entryFor(position.actorId);
      if (!Number.isSafeInteger(position.beatIndex) || position.beatIndex < 1
        || !Number.isSafeInteger(position.remainingSlots) || position.remainingSlots < 0
        || typeof position.firstForActor !== 'boolean'
        || (position.maxItems !== CODEC_LIMITS.items && position.maxItems !== CODEC_LIMITS.soloFirstItems)) {
        throw new Error('invalid_context_beat');
      }
      const state = currentContextState(readState(structuredClone(identity)), identity, filterLedger, start.version);
      perception.replaceSources(state.perception);
      const known = perception.view(position.actorId);
      const delivery = perception.prepareDispatch(position.actorId, identity.turnId);
      const world = projectTavernActorWorld(
        projectTavernWorld(state.perception.baseline, state.perception.steps).world,
        known,
      );
      const candidates = known.materials.filter(material => material.channel === 'candidate')
        .flatMap(material => Array.isArray(material.value) ? material.value as CandidateAction[] : [])
        .filter(candidate => candidate.actorId === position.actorId)
        .map(candidate => ({
          actorId: candidate.actorId,
          kind: candidate.kind,
          priority: candidate.priority,
          constraints: candidate.constraints,
          ...(candidate.targetId == null ? {} : { targetId: candidate.targetId }),
          ...(candidate.objectId == null ? {} : { objectId: candidate.objectId }),
        }));
      const triggerEventIds = delivery.input.inbox.filter(event => intentTriggered({
        ...delivery.input,
        inbox: [event],
      })).map(event => event.eventId);
      const { intent, interruptible } = position;
      const referenceKey = (reference: EventReference): string => JSON.stringify([
        reference.turnId, reference.turnRevision, reference.eventId,
      ]);
      const visibleReferences = new Set(
        [...known.inbox, ...known.authoredEvents].map(event => referenceKey(event.source)),
      );
      const schedules = (state.schedules ?? []).filter(schedule =>
        sameScope(schedule.basis.scope, identity.scope) && schedule.readers.includes(position.actorId)
        && (schedule.basis.kind !== 'event' || (schedule.basis.event != null
          && visibleReferences.has(referenceKey(schedule.basis.event)))))
        .map(schedule => ({
          id: schedule.id,
          actorId: schedule.actorId,
          authority: schedule.authority,
          confirmedByUser: schedule.confirmedByUser,
          startAtMs: schedule.startAtMs,
          basis: schedule.basis,
          readers: [position.actorId],
          ...(schedule.endAtMs == null ? {} : { endAtMs: schedule.endAtMs }),
          ...(schedule.placeId == null ? {} : { placeId: schedule.placeId }),
        }));
      const visibleInterrupts = interruptible?.filter(reference => visibleReferences.has(referenceKey(reference)))
        .map(({ turnId, turnRevision, eventId }) => ({ turnId, turnRevision, eventId }));
      // Recall/emotion/diagnostics belong to the fixed prefix or local diagnostics, never a mutable tail.
      delivery.input.materials = known.materials.filter(material =>
        material.channel === 'commitment' || material.channel === 'physiology');
      return {
        input: {
          prefix: structuredClone(entry.prefix),
          tail: {
            delivery: delivery.input,
            world,
            schedules,
            candidates: structuredClone(candidates),
            ...(intent == null ? {} : { intent: { goal: intent.goal, next: intent.next } }),
            intentRequired: position.firstForActor
              ? entry.contract.beatConfigurationId === entry.contract.frontConfigurationId
              : triggerEventIds.length > 0,
            triggerEventIds,
            position: {
              actorId: position.actorId,
              beatIndex: position.beatIndex,
              maxItems: position.maxItems,
              firstForActor: position.firstForActor,
              remainingSlots: position.remainingSlots,
              ...(visibleInterrupts == null ? {} : { interruptible: visibleInterrupts }),
            },
            limits: structuredClone(CODEC_LIMITS),
          },
          candidateInstructions: SLOT_CANDIDATE_INSTRUCTIONS,
          instructions: SLOT_M2_INSTRUCTIONS,
        },
        prefixJson: entry.json,
        receipt: delivery.receipt,
      };
    },
    acknowledgeDispatch(receipt) {
      checkCancelled();
      return perception.acknowledgeDispatch(receipt);
    },
  };
}
