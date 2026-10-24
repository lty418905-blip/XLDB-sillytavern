import type { CommitmentRecord } from '../../commitments/types.ts';
import type { PhysiologyCorrectionPatch } from '../../common/physiology.ts';
import type { ScheduleSlot } from '../schedule-conflicts.ts';
import type { TavernProjectionBasis, TavernWorldSnapshot } from './projection.ts';
import type { EventReference } from './types.ts';

/** Closed suggestions, never dialogue or accepted events. A model may ignore every suggestion. */
export type CandidateActionKind =
  | 'seek_help' | 'drink' | 'eat' | 'rest' | 'request'
  | 'fulfill' | 'ask_fulfillment' | 'attend' | 'leave' | 'request_reschedule'
  | 'give' | 'request_item' | 'pick_up' | 'move' | 'enter' | 'exit' | 'ask_route'
  | 'respond' | 'observe' | 'wait';

/** Concrete, precondition-checked steps that can support fulfillment; no prose or arbitrary effects. */
export interface ActionStep {
  kind: 'give' | 'pick_up' | 'move' | 'enter' | 'exit' | 'drink' | 'eat' | 'rest' | 'seek_help';
  targetId?: string | null;
  objectId?: string | null;
}

/** Machine-readable preconditions, not permissions to write; source revisions are positive integers. */
export type ActionConstraint =
  | { kind: 'not_player_decision' }
  | { kind: 'known_to'; actorId: string; sourceRef: TavernProjectionBasis }
  | { kind: 'must_hold'; itemId: string; holderId: string }
  | { kind: 'must_be_present'; targetId: string }
  | { kind: 'at_place'; placeId: string }
  | { kind: 'route_open'; routeId: string }
  | { kind: 'commitment_active'; id: string; revision: number }
  | { kind: 'perform_action'; action: ActionStep }
  | { kind: 'schedule_due'; id: string; atMs: number }
  | { kind: 'need'; need: ActionNeed['need'] }
  | { kind: 'unanswered'; event: EventReference }
  | { kind: 'plan_active'; id: string };

/** Detached, optional recommendations. Priority is dimensionless; higher comes first, ties retain input order. */
export interface CandidateAction {
  actorId: string;
  kind: CandidateActionKind;
  targetId?: string;
  objectId?: string;
  priority: number;
  constraints: readonly ActionConstraint[];
}

/** One rejected component. key is its input array index or root field, never an unvalidated identity. */
export interface ActionDiagnostic {
  component: string;
  key: string;
  reason: 'invalid_action_identity' | 'invalid_action_enum' | 'invalid_action_boolean'
    | 'invalid_action_revision' | 'invalid_action_time' | 'invalid_action_container'
    | 'duplicate_action_item' | 'duplicate_action_position';
}

/** Candidate array with a non-enumerable diagnostics list; array iteration and candidate JSON stay unchanged. */
export interface TavernActionResult extends Array<CandidateAction> {
  readonly diagnostics: readonly ActionDiagnostic[];
}

interface KnownActionPossession {
  itemId: string;
  holderId?: string;
  basis: TavernProjectionBasis;
}

// Only locally detected invalid values use this class. Caller getter errors must escape unchanged.
class InvalidActionValue extends TypeError {
  readonly reason: ActionDiagnostic['reason'];

  constructor(reason: ActionDiagnostic['reason']) {
    super(reason);
    this.reason = reason;
  }
}

/** Host-validated source permission in the world's exact scope. Empty readers grant no access. */
export interface ActionEvidence {
  basis: TavernProjectionBasis;
  readers: readonly string[];
}

/** Existing physiology enums only. Unknown/settled/noticeable needs and non-severe effects produce nothing. */
export type ActionNeed = ActionEvidence & { actorId: string } & (
  | {
    need: 'hydration' | 'nutrition' | 'sleep' | 'energy';
    stage: Extract<PhysiologyCorrectionPatch, { kind: 'need' }>['state'];
  }
  | {
    need: 'injury' | 'pain';
    severity: NonNullable<Extract<PhysiologyCorrectionPatch, { kind: 'effect' }>['severity']>;
  }
);

/** Structured resource capability. Available never overrides a holder, location, presence or reader check. */
export type ActionResource = ActionEvidence & { available: boolean } & (
  | { kind: 'item'; itemId: string; need: 'hydration' | 'nutrition' }
  | { kind: 'rest'; placeId: string; need: 'sleep' | 'energy' }
  | { kind: 'helper'; actorId: string; need: 'injury' | 'pain' }
);

/** Existing commitment state without content/quotes. Persistent matching is supplied structurally by the host. */
export type ActionCommitment = ActionEvidence & Pick<CommitmentRecord,
  'id' | 'revision' | 'mode' | 'status' | 'participants' | 'obligors'
> & {
  term:
    | { kind: 'unknown' }
    | { kind: 'persistent'; matched: boolean }
    | { kind: 'deadline'; clock: 'real' | 'story'; dueAtMs: number | null };
  step?: ActionStep | null;
};

/** Resolved story-clock milliseconds, not date/title strings. Unknown times and unconfirmed slots are inert. */
export interface ActionSchedule extends ActionEvidence {
  id: string;
  actorId: string;
  authority: ScheduleSlot['authority'];
  confirmedByUser: boolean;
  startAtMs: number | null;
  endAtMs?: number | null;
  placeId?: string | null;
}

/** Existing unique-item task, not a Transfer. Only the designated actor may receive its suggestions. */
export interface ActionTransferTask extends ActionEvidence {
  actorId: string;
  itemId: string;
  desiredHolderId: string;
}

/** Caller-resolved route enums; no passability text or map description is interpreted here. */
export interface ActionRoute extends ActionEvidence {
  id: string;
  fromId: string;
  toId: string;
  passability: 'open' | 'blocked' | 'unknown';
  movement: 'move' | 'enter' | 'exit';
}

/** A known existing destination for this actor. A missing route permits asking, never fabricated arrival. */
export interface ActionDestination extends ActionEvidence {
  actorId: string;
  placeId: string;
}

/** Unanswered event identity with no quote/content. Responded entries and inaccessible sources are ignored. */
export interface ActionInboxEntry extends ActionEvidence {
  senderId: string;
  event: EventReference;
  responded: boolean;
}

/** Private, structured continuation only; goal/next text is deliberately absent from this contract. */
export interface ActionPlan extends ActionEvidence {
  id: string;
  actorId: string;
  status: 'active' | 'complete' | 'cancelled';
  continuation: 'observe' | 'wait';
}

/**
 * Per-actor, read-only inputs. The world is the existing overlay; knowledge grants access to its sourced rows.
 * perceivedIds is the host's reader-filtered visible actor set, intersected with actual Presence below.
 * Arrays contain current components, not chat history. Null optional arrays mean empty; storyNowMs is nullable.
 */
export interface TavernActionInput {
  directorEnabled: boolean;
  actorId: string;
  playerId: string;
  storyNowMs: number | null;
  world: TavernWorldSnapshot;
  perceivedIds: readonly string[];
  knowledge: readonly ActionEvidence[];
  needs?: readonly ActionNeed[] | null;
  resources?: readonly ActionResource[] | null;
  commitments?: readonly ActionCommitment[] | null;
  schedules?: readonly ActionSchedule[] | null;
  transfers?: readonly ActionTransferTask[] | null;
  routes?: readonly ActionRoute[] | null;
  destinations?: readonly ActionDestination[] | null;
  inbox?: readonly ActionInboxEntry[] | null;
  plans?: readonly ActionPlan[] | null;
}

// Provisional utility bands preserve subtree precedence; they are not calibrated character preferences.
const priorities = {
  severe: 630,
  strained: 620,
  urgent: 610,
  commitment: 500,
  schedule: 400,
  transfer: 300,
  movement: 200,
  interaction: 100,
} as const;

function validTime(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidActionValue('invalid_action_revision');
  }
}

function componentTime(value: unknown): number | null {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'number' || !validTime(value)) {
    throw new InvalidActionValue('invalid_action_time');
  }

  return value;
}

function record(value: unknown): object {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidActionValue('invalid_action_container');
  }

  return value;
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new InvalidActionValue('invalid_action_container');
  }

  return value;
}

function own(value: unknown, key: string): unknown {
  const fields = record(value);
  return Object.hasOwn(fields, key) ? Reflect.get(fields, key) : undefined;
}

function identities(value: unknown): string[] {
  const values = array(value);
  const result: string[] = [];

  for (let index = 0; index < values.length; index++) {
    result.push(identity(Object.hasOwn(values, index) ? values[index] : undefined));
  }

  return result;
}

function identity(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new InvalidActionValue('invalid_action_identity');
  return value;
}

function optionalIdentity(value: unknown): string | undefined {
  return value == null ? undefined : identity(value);
}

function choice<Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== 'string' || !allowed.includes(value as Value)) {
    throw new InvalidActionValue('invalid_action_enum');
  }
  return value as Value;
}

function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new InvalidActionValue('invalid_action_boolean');
  return value;
}

function sourceKey(value: TavernProjectionBasis): string {
  // Copy and validate each identity before JSON can invoke any caller-supplied toJSON method.
  const basis = copySource(value);
  const event = basis.event;
  return JSON.stringify([
    basis.scope.worldId,
    basis.scope.sessionId,
    basis.scope.branchId,
    basis.scope.characterId,
    basis.kind,
    basis.sourceId,
    basis.sourceRevision,
    event == null ? null : [event.turnId, event.turnRevision, event.eventId],
  ]);
}

function copyScope(value: unknown): TavernProjectionBasis['scope'] {
  return {
    worldId: identity(own(value, 'worldId')),
    sessionId: identity(own(value, 'sessionId')),
    branchId: identity(own(value, 'branchId')),
    characterId: identity(own(value, 'characterId')),
  };
}

function copySource(basis: unknown): TavernProjectionBasis {
  const scope = copyScope(own(basis, 'scope'));
  const event = own(basis, 'event');
  const sourceId = identity(own(basis, 'sourceId'));
  const sourceRevision = own(basis, 'sourceRevision');
  positiveRevision(sourceRevision);

  return {
    kind: choice(own(basis, 'kind'), ['existing', 'card', 'scene', 'correction', 'event']),
    scope,
    sourceId,
    sourceRevision,
    ...(event == null ? {} : { event: copyEvent(event) }),
  };
}

function copyEvent(event: unknown): EventReference {
  const turnId = identity(own(event, 'turnId'));
  const turnRevision = own(event, 'turnRevision');
  const eventId = identity(own(event, 'eventId'));
  positiveRevision(turnRevision);

  return { turnId, turnRevision, eventId };
}

function evidence(value: ActionEvidence): ActionEvidence {
  return {
    basis: copySource(own(value, 'basis')),
    readers: identities(own(value, 'readers')),
  };
}

function readNeed(value: ActionNeed): ActionNeed {
  const need = choice(own(value, 'need'), ['hydration', 'nutrition', 'sleep', 'energy', 'injury', 'pain']);
  const common = { ...evidence(value), actorId: identity(own(value, 'actorId')) };
  // Only the discriminator's own applicable field participates; unrelated metadata is never read.
  if (need === 'injury' || need === 'pain') {
    return { ...common, need, severity: choice(own(value, 'severity'), ['mild', 'moderate', 'severe']) };
  }
  return { ...common, need, stage: choice(own(value, 'stage'), [
    'unknown', 'settled', 'noticeable', 'urgent', 'strained',
  ]) };
}

function readResource(value: ActionResource): ActionResource {
  const common = { ...evidence(value), available: flag(own(value, 'available')) };
  const kind = choice(own(value, 'kind'), ['item', 'rest', 'helper']);
  if (kind === 'item') return {
    ...common, kind, itemId: identity(own(value, 'itemId')),
    need: choice(own(value, 'need'), ['hydration', 'nutrition']),
  };
  if (kind === 'rest') return {
    ...common, kind, placeId: identity(own(value, 'placeId')),
    need: choice(own(value, 'need'), ['sleep', 'energy']),
  };
  return {
    ...common, kind, actorId: identity(own(value, 'actorId')),
    need: choice(own(value, 'need'), ['injury', 'pain']),
  };
}

function needPriority(need: ActionNeed): number {
  switch (need.need) {
    case 'injury':
    case 'pain':
      return need.severity === 'severe' ? priorities.severe : 0;
    case 'hydration':
    case 'nutrition':
    case 'sleep':
    case 'energy':
      return need.stage === 'strained' ? priorities.strained : need.stage === 'urgent' ? priorities.urgent : 0;
  }
}

function readRoute(value: ActionRoute): ActionRoute {
  return {
    ...evidence(value),
    id: identity(own(value, 'id')),
    fromId: identity(own(value, 'fromId')),
    toId: identity(own(value, 'toId')),
    passability: choice(own(value, 'passability'), ['open', 'blocked', 'unknown']),
    movement: choice(own(value, 'movement'), ['move', 'enter', 'exit']),
  };
}

function readStep(value: ActionStep): ActionStep {
  const kind = choice(own(value, 'kind'), [
    'give', 'pick_up', 'move', 'enter', 'exit', 'drink', 'eat', 'rest', 'seek_help',
  ]);
  const targetId = optionalIdentity(own(value, 'targetId'));
  const objectId = optionalIdentity(own(value, 'objectId'));
  return { kind, ...(targetId == null ? {} : { targetId }), ...(objectId == null ? {} : { objectId }) };
}

function readCommitmentTerm(term: unknown): ActionCommitment['term'] {
  const kind = choice(own(term, 'kind'), ['unknown', 'persistent', 'deadline']);

  if (kind === 'unknown') {
    return { kind };
  }

  if (kind === 'persistent') {
    return { kind, matched: flag(own(term, 'matched')) };
  }

  return {
    kind,
    clock: choice(own(term, 'clock'), ['real', 'story']),
    dueAtMs: componentTime(own(term, 'dueAtMs')),
  };
}

function commitmentIsDue(term: ActionCommitment['term'], now: number | null | undefined): boolean {
  if (term.kind === 'persistent') {
    return term.matched;
  }

  if (term.kind !== 'deadline' || term.clock !== 'story') {
    return false;
  }

  return validTime(now) && validTime(term.dueAtMs) && term.dueAtMs <= now;
}

function readCommitment(value: ActionCommitment): ActionCommitment {
  const revision = own(value, 'revision');
  positiveRevision(revision);
  const term = readCommitmentTerm(own(value, 'term'));
  const step = own(value, 'step') as ActionStep | null | undefined;

  return {
    ...evidence(value),
    id: identity(own(value, 'id')),
    revision,
    mode: choice(own(value, 'mode'), ['roleplay', 'companion']),
    status: choice(own(value, 'status'), ['proposed', 'active', 'fulfilled', 'cancelled', 'superseded']),
    participants: identities(own(value, 'participants')),
    obligors: identities(own(value, 'obligors')),
    term,
    ...(step == null ? {} : { step: readStep(step) }),
  };
}

function readSchedule(value: ActionSchedule): ActionSchedule {
  const placeId = optionalIdentity(own(value, 'placeId'));
  const suppliedEndAtMs = own(value, 'endAtMs');
  const endAtMs = suppliedEndAtMs == null ? null : componentTime(suppliedEndAtMs);
  const startAtMs = componentTime(own(value, 'startAtMs'));
  if (startAtMs != null && endAtMs != null && endAtMs < startAtMs) {
    throw new InvalidActionValue('invalid_action_time');
  }
  return {
    ...evidence(value),
    id: identity(own(value, 'id')),
    actorId: identity(own(value, 'actorId')),
    authority: choice(own(value, 'authority'), ['accepted', 'candidate', 'provisional']),
    confirmedByUser: flag(own(value, 'confirmedByUser')),
    startAtMs,
    ...(endAtMs == null ? {} : { endAtMs }),
    ...(placeId == null ? {} : { placeId }),
  };
}

function readTransfer(value: ActionTransferTask): ActionTransferTask {
  return {
    ...evidence(value),
    actorId: identity(own(value, 'actorId')),
    itemId: identity(own(value, 'itemId')),
    desiredHolderId: identity(own(value, 'desiredHolderId')),
  };
}

function readDestination(value: ActionDestination): ActionDestination {
  return {
    ...evidence(value),
    actorId: identity(own(value, 'actorId')),
    placeId: identity(own(value, 'placeId')),
  };
}

function readInbox(value: ActionInboxEntry): ActionInboxEntry {
  return {
    ...evidence(value),
    senderId: identity(own(value, 'senderId')),
    event: copyEvent(own(value, 'event')),
    responded: flag(own(value, 'responded')),
  };
}

function readPlan(value: ActionPlan): ActionPlan {
  return {
    ...evidence(value),
    id: identity(own(value, 'id')),
    actorId: identity(own(value, 'actorId')),
    status: choice(own(value, 'status'), ['active', 'complete', 'cancelled']),
    continuation: choice(own(value, 'continuation'), ['observe', 'wait']),
  };
}

// Both collectors share the same value diagnostics, lazy holder reads and reader/scope checks.
// Other actors' positions are needed only for a spatial plan; the one-step tree reads only its actor's position.
// Each authorized position state is read once and used as a snapshot, including in the one-step tree.
// Unlike the old collector's repeated getter reads, this does not trigger an error from a second state read.
function readActionContext(
  input: TavernActionInput,
  diagnostics: ActionDiagnostic[],
  includeOtherPositions = false,
) {
  const read = <Value>(component: string, key: string, reader: () => Value): Value | undefined => {
    try {
      return reader();
    } catch (error) {
      if (!(error instanceof InvalidActionValue)) {
        throw error;
      }

      diagnostics.push({ component, key, reason: error.reason });
      return undefined;
    }
  };
  const directorEnabled = read('input', 'directorEnabled', () => flag(own(input, 'directorEnabled')));

  if (directorEnabled !== true) {
    return undefined;
  }

  const components = <Input, Output>(
    component: string,
    supplied: unknown,
    reader: (value: Input) => Output,
  ): Output[] => {
    const result: Output[] = [];
    const values = read(component, 'values', () => array(supplied));

    if (values === undefined) {
      return result;
    }

    for (let index = 0; index < values.length; index++) {
      const parsed = read(component, String(index), () => {
        const value = Object.hasOwn(values, index) ? values[index] : undefined;
        return reader(value as Input);
      });

      if (parsed !== undefined) {
        result.push(parsed);
      }
    }

    return result;
  };
  const actorId = read('input', 'actorId', () => identity(own(input, 'actorId')));
  const playerId = read('input', 'playerId', () => identity(own(input, 'playerId')));

  if (actorId === undefined || playerId === undefined) {
    return undefined;
  }

  const world = read('input', 'world', () => record(own(input, 'world')));

  if (world === undefined) {
    return undefined;
  }

  const entities = new Set(components('entity', own(world, 'entityIds'), identity));
  const present = new Set(components('presence', own(world, 'presentIds'), identity));
  const presenceKnown = read('world', 'presenceKnown', () => flag(own(world, 'presenceKnown')));

  if (actorId === playerId || !entities.has(actorId) || !presenceKnown || !present.has(actorId)) {
    return undefined;
  }

  const now = read('clock', 'storyNowMs', () => componentTime(own(input, 'storyNowMs')));
  const places = new Set(components('place', own(world, 'placeIds'), identity));
  const visible = new Set(components('perceived', own(input, 'perceivedIds'), identity)
    .filter(id => entities.has(id) && present.has(id)));
  const scope = read('world', 'scope', () => copyScope(own(world, 'scope')));

  if (scope === undefined) {
    return undefined;
  }

  const sameScope = (basis: TavernProjectionBasis): boolean =>
    basis.scope.worldId === scope.worldId && basis.scope.sessionId === scope.sessionId
    && basis.scope.branchId === scope.branchId && basis.scope.characterId === scope.characterId;
  const readable = (entry: ActionEvidence): boolean => {
    if (!sameScope(entry.basis) || !entry.readers.includes(actorId)) {
      return false;
    }

    sourceKey(entry.basis);
    return true;
  };
  const knowledge = new Set(components('knowledge', own(input, 'knowledge'), evidence)
    .filter(readable).map(entry => sourceKey(entry.basis)));
  const known = (basis: TavernProjectionBasis): boolean => knowledge.has(sourceKey(basis));
  const uniqueRows = (
    component: string,
    supplied: unknown,
    identityField: string,
    reason: 'duplicate_action_item' | 'duplicate_action_position',
  ) => {
    const values = read(component, 'values', () => array(supplied));
    const groups = new Map<string, { value: unknown; index: number }[]>();

    if (values !== undefined) {
      for (let index = 0; index < values.length; index++) {
        const row = read(component, String(index), () => {
          const value = Object.hasOwn(values, index) ? values[index] : undefined;
          return { id: identity(own(value, identityField)), value, index };
        });

        if (row !== undefined) {
          const rows = groups.get(row.id) ?? [];
          rows.push(row);
          groups.set(row.id, rows);
        }
      }
    }

    const unique = new Map<string, { value: unknown; index: number }>();

    for (const [id, rows] of groups) {
      if (rows.length === 1) {
        unique.set(id, rows[0]);
        continue;
      }

      // No row is authoritative when identities collide, even if a later row agrees with an earlier one.
      for (const row of rows) {
        diagnostics.push({ component, key: String(row.index), reason });
      }
    }

    return unique;
  };
  const positions = new Map<string, { entityId: string; basis: TavernProjectionBasis; placeId?: string }>();
  const positionRows = uniqueRows('position', own(world, 'positions'), 'entityId', 'duplicate_action_position');

  for (const [entityId, row] of positionRows) {
    const parsed = read('position', String(row.index), () => {
      const basis = copySource(own(row.value, 'basis'));
      let placeId: string | undefined;

      if ((includeOtherPositions || entityId === actorId) && known(basis)) {
        const position = own(row.value, 'position');
        const state = choice(own(position, 'state'), ['at', 'within', 'in_transit', 'unknown']);

        if (state === 'at' || state === 'within') {
          placeId = identity(own(position, 'placeId'));
        }
      }

      return { entityId, basis, ...(placeId == null ? {} : { placeId }) };
    });

    if (parsed !== undefined) {
      positions.set(entityId, parsed);
    }
  }

  const possessions = new Map<string, () => KnownActionPossession | undefined>();
  const possessionRows = uniqueRows('possession', own(world, 'possessions'), 'itemId', 'duplicate_action_item');

  for (const [itemId, row] of possessionRows) {
    let loaded = false;
    let parsed: KnownActionPossession | undefined;

    possessions.set(itemId, () => {
      if (!loaded) {
        // Keep private holders unread, and diagnose a shared invalid row only once per collection.
        parsed = read('possession', String(row.index), () => {
          const basis = copySource(own(row.value, 'basis'));

          if (!known(basis)) {
            return undefined;
          }

          const holderId = optionalIdentity(own(row.value, 'holderId'));
          return { itemId, basis, ...(holderId == null ? {} : { holderId }) };
        });
        loaded = true;
      }

      return parsed;
    });
  }

  const actorPosition = positions.get(actorId);
  const current = actorPosition && known(actorPosition.basis) ? actorPosition.placeId : undefined;
  const knownConstraint = (basis: TavernProjectionBasis): ActionConstraint => ({
    kind: 'known_to', actorId, sourceRef: copySource(basis),
  });
  const locationConstraints = (): ActionConstraint[] => current && actorPosition
    ? [knownConstraint(actorPosition.basis), { kind: 'at_place', placeId: current }] : [];
  return {
    read,
    components,
    actorId,
    entities,
    now,
    places,
    present,
    visible,
    readable,
    known,
    positions,
    possessions,
    current,
    knownConstraint,
    locationConstraints,
  };
}

/**
 * Collects six finite subtrees without executing any action. Off, ineligible actors and no matches return [].
 * Invalid values (including container shapes) discard only the affected component
 * and append one diagnostic with component kind, input key and reason code. Other components still run.
 * Duplicate item/position identities discard every colliding row and diagnose each input index.
 * Invalid root identities/scope prevent collection; an invalid clock disables only timed suggestions.
 * Getter errors propagate unchanged, including TypeError; they are never treated as invalid values.
 * Only own structured fields are read; extra prose is ignored. Null times remain unknown, not invalid.
 * Whitelisted structural fields are copied before use; no caller object is serialized or enumerated.
 * Indexing is linear in component/reader counts;
 * producing/sorting c candidates is O(c log c). No history cap, search expansion, model call or hidden clock.
 */
export function collectTavernActions(input: TavernActionInput): TavernActionResult {
  const diagnostics: ActionDiagnostic[] = [];
  const candidates = Object.assign([] as CandidateAction[], { diagnostics });
  Object.defineProperty(candidates, 'diagnostics', { enumerable: false });
  const context = readActionContext(input, diagnostics);

  if (context === undefined) {
    return candidates;
  }

  const {
    components,
    actorId,
    now,
    places,
    visible,
    readable,
    known,
    possessions,
    current,
    knownConstraint,
    locationConstraints,
  } = context;
  const add = (
    kind: CandidateActionKind,
    priority: number,
    evidence: ActionEvidence,
    constraints: readonly ActionConstraint[] = [],
    targetId?: string | null,
    objectId?: string | null,
  ): void => {
    candidates.push({
      actorId,
      kind,
      ...(targetId == null ? {} : { targetId }),
      ...(objectId == null ? {} : { objectId }),
      priority,
      constraints: [
        { kind: 'not_player_decision' },
        knownConstraint(evidence.basis),
        ...constraints.map(constraint => structuredClone(constraint)),
      ],
    });
  };

  // Direct holders only: contained items need a separately validated accessibility projection in a later caller.
  // Refusing indirect holders also prevents a container cycle from creating a spurious reachable resource.
  const held = (itemId: string): ActionConstraint[] | undefined => {
    const item = possessions.get(itemId)?.();

    if (!item || !known(item.basis) || item.holderId !== actorId) {
      return undefined;
    }

    return [knownConstraint(item.basis), { kind: 'must_hold', itemId, holderId: actorId }];
  };
  const routes = new Map<string, ActionRoute[]>();

  for (const route of components('route', own(input, 'routes') ?? [], readRoute)) {
    if (!readable(route) || route.fromId !== current || !places.has(route.toId)
      || route.passability !== 'open') {
      continue;
    }

    const options = routes.get(route.toId) ?? [];

    // At most three movement kinds; preserve the first open route for each, in caller order.
    if (!options.some(option => option.movement === route.movement)) {
      options.push(route);
      routes.set(route.toId, options);
    }
  }

  const openRoute = (placeId: string, movement?: ActionRoute['movement']): ActionRoute | undefined => {
    const options = routes.get(placeId);

    if (movement === undefined) {
      return options?.[0];
    }

    return options?.find(option => option.movement === movement);
  };
  const routeConstraints = (route: ActionRoute): ActionConstraint[] => [
    ...locationConstraints(),
    knownConstraint(route.basis),
    { kind: 'route_open', routeId: route.id },
  ];

  const resourceSteps = new Map<string, ActionConstraint[]>();
  const stepKey = (kind: string, targetId?: string | null, objectId?: string | null): string =>
    JSON.stringify([kind, targetId ?? null, objectId ?? null]);
  type ResourceOption = {
    kind: CandidateActionKind;
    targetId?: string;
    objectId?: string;
    constraints: ActionConstraint[];
  };
  const resources = new Map<string, ResourceOption[]>();

  for (const resource of components('resource', own(input, 'resources') ?? [], readResource)) {
    if (!readable(resource) || !resource.available) {
      continue;
    }

    let option: ResourceOption | undefined;

    if (resource.kind === 'item') {
      const constraints = held(resource.itemId);

      if (constraints) {
        option = {
          kind: resource.need === 'hydration' ? 'drink' : 'eat',
          objectId: resource.itemId,
          constraints,
        };
      }
    } else if (resource.kind === 'rest' && resource.placeId === current) {
      option = { kind: 'rest', targetId: resource.placeId, constraints: locationConstraints() };
    } else if (resource.kind === 'helper' && resource.actorId !== actorId && visible.has(resource.actorId)) {
      option = {
        kind: 'seek_help',
        targetId: resource.actorId,
        constraints: [{ kind: 'must_be_present', targetId: resource.actorId }],
      };
    }

    if (!option) {
      continue;
    }

    option.constraints.push(knownConstraint(resource.basis));
    resourceSteps.set(stepKey(option.kind, option.targetId, option.objectId), option.constraints);
    const list = resources.get(resource.need) ?? [];
    list.push(option);
    resources.set(resource.need, list);
  }

  for (const need of components('need', own(input, 'needs') ?? [], readNeed)) {
    if (!readable(need) || need.actorId !== actorId) {
      continue;
    }

    const priority = needPriority(need);

    if (priority === 0) {
      continue;
    }

    const options = resources.get(need.need) ?? [];
    const constraint: ActionConstraint = { kind: 'need', need: need.need };

    if (options.length === 0) {
      add('request', priority, need, [constraint]);
    }

    for (const option of options) {
      add(option.kind, priority, need, [constraint, ...option.constraints], option.targetId, option.objectId);
    }
  }

  const stepConstraints = (step: ActionStep): ActionConstraint[] | undefined => {
    const targetId = step.targetId;
    const objectId = step.objectId;

    if (step.kind === 'give' && targetId != null && objectId != null && targetId !== actorId
      && visible.has(targetId)) {
      const constraints = held(objectId);
      return constraints && [...constraints, { kind: 'must_be_present', targetId }];
    }

    if (step.kind === 'pick_up' && objectId != null && current != null) {
      const item = possessions.get(objectId)?.();

      if (item && known(item.basis) && item.holderId === current) {
        return [
          ...locationConstraints(),
          knownConstraint(item.basis),
          { kind: 'must_hold', itemId: objectId, holderId: current },
        ];
      }
    }

    if ((step.kind === 'move' || step.kind === 'enter' || step.kind === 'exit') && targetId != null) {
      const route = openRoute(targetId, step.kind);

      if (route && targetId !== current) {
        return routeConstraints(route);
      }
    }

    return resourceSteps.get(stepKey(step.kind, targetId, objectId));
  };

  for (const commitment of components('commitment', own(input, 'commitments') ?? [], readCommitment)) {
    if (!readable(commitment) || commitment.mode !== 'roleplay' || commitment.status !== 'active'
      || !commitmentIsDue(commitment.term, now)) {
      continue;
    }

    const constraints: ActionConstraint[] = [
      { kind: 'commitment_active', id: commitment.id, revision: commitment.revision },
    ];

    if (commitment.obligors.includes(actorId)) {
      const step = commitment.step;

      if (step == null) {
        continue;
      }

      const preconditions = stepConstraints(step);

      if (!preconditions) {
        continue;
      }

      const action: ActionStep = {
        kind: step.kind,
        ...(step.targetId == null ? {} : { targetId: step.targetId }),
        ...(step.objectId == null ? {} : { objectId: step.objectId }),
      };

      add(
        'fulfill',
        priorities.commitment,
        commitment,
        [...constraints, ...preconditions, { kind: 'perform_action', action }],
        action.targetId,
        action.objectId,
      );
    } else if (commitment.participants.includes(actorId)) {
      for (const obligor of commitment.obligors) {
        if (!visible.has(obligor)) {
          continue;
        }

        add(
          'ask_fulfillment',
          priorities.commitment,
          commitment,
          [...constraints, { kind: 'must_be_present', targetId: obligor }],
          obligor,
        );
      }
    }
  }

  for (const slot of components('schedule', own(input, 'schedules') ?? [], readSchedule)) {
    if (!readable(slot) || slot.actorId !== actorId
      || (slot.authority !== 'accepted' && slot.confirmedByUser !== true)) {
      continue;
    }

    if (!validTime(now) || !validTime(slot.startAtMs) || slot.startAtMs > now) {
      continue;
    }

    const end = slot.endAtMs;
    const placeId = slot.placeId;

    if (placeId == null || !places.has(placeId) || current == null) {
      continue;
    }

    if (end != null && end <= now) {
      if (current === placeId) {
        add(
          'leave',
          priorities.schedule,
          slot,
          [...locationConstraints(), { kind: 'schedule_due', id: slot.id, atMs: end }],
          placeId,
        );
      }

      continue;
    }

    const due: ActionConstraint = { kind: 'schedule_due', id: slot.id, atMs: slot.startAtMs };

    if (placeId === current) {
      add('attend', priorities.schedule, slot, [...locationConstraints(), due], placeId);
    } else {
      const route = openRoute(placeId);

      add(
        route ? 'attend' : 'request_reschedule',
        priorities.schedule,
        slot,
        [due, ...(route ? routeConstraints(route) : locationConstraints())],
        placeId,
      );
    }
  }

  for (const task of components('transfer', own(input, 'transfers') ?? [], readTransfer)) {
    if (!readable(task) || task.actorId !== actorId) {
      continue;
    }

    const item = possessions.get(task.itemId)?.();

    if (!item || !known(item.basis)) {
      continue;
    }

    const holderId = item.holderId;

    if (holderId == null || holderId === task.desiredHolderId) {
      continue;
    }

    const constraints: ActionConstraint[] = [
      knownConstraint(item.basis),
      { kind: 'must_hold', itemId: task.itemId, holderId },
    ];

    if (holderId === actorId && visible.has(task.desiredHolderId)) {
      add(
        'give',
        priorities.transfer,
        task,
        [...constraints, { kind: 'must_be_present', targetId: task.desiredHolderId }],
        task.desiredHolderId,
        task.itemId,
      );
    } else if (task.desiredHolderId === actorId) {
      if (visible.has(holderId)) {
        add(
          'request_item',
          priorities.transfer,
          task,
          [...constraints, { kind: 'must_be_present', targetId: holderId }],
          holderId,
          task.itemId,
        );
      } else if (current != null && holderId === current) {
        add('pick_up', priorities.transfer, task, [...constraints, ...locationConstraints()], null, task.itemId);
      }
    }
  }

  for (const destination of components('destination', own(input, 'destinations') ?? [], readDestination)) {
    if (!readable(destination) || destination.actorId !== actorId || current == null
      || !places.has(destination.placeId) || destination.placeId === current) {
      continue;
    }

    const route = openRoute(destination.placeId);

    add(
      route?.movement ?? 'ask_route',
      priorities.movement,
      destination,
      route ? routeConstraints(route) : locationConstraints(),
      destination.placeId,
    );
  }

  for (const entry of components('inbox', own(input, 'inbox') ?? [], readInbox)) {
    if (!readable(entry) || entry.responded || entry.senderId === actorId || !visible.has(entry.senderId)) {
      continue;
    }

    add('respond', priorities.interaction, entry, [
      { kind: 'unanswered', event: copyEvent(entry.event) },
      { kind: 'must_be_present', targetId: entry.senderId },
    ], entry.senderId);
  }

  for (const plan of components('plan', own(input, 'plans') ?? [], readPlan)) {
    if (!readable(plan) || plan.actorId !== actorId || plan.status !== 'active') {
      continue;
    }

    add(plan.continuation, priorities.interaction, plan, [{ kind: 'plan_active', id: plan.id }]);
  }

  return candidates.sort((left, right) => right.priority - left.priority);
}

/** Per actor and selected goal: at most three proposed operations; a provisional limit awaiting measurement. */
export const GOAP_MAX_DEPTH = 3;

/** Per call: at most 64 expanded states including root and goal checks; provisional, awaiting measurement. */
export const GOAP_MAX_EXPANDED_STATES = 64;

/** Dimensionless cost per legal operation, provisionally one; routes currently project no numeric travel cost. */
export const GOAP_OPERATION_COST = 1;

/** Closed operation order, matching CandidateActionKind; used before existing Presence/place order on cost ties. */
export const GOAP_OPERATION_ORDER: readonly ActionStep['kind'][] = Object.freeze([
  'seek_help',
  'drink',
  'eat',
  'rest',
  'give',
  'pick_up',
  'move',
  'enter',
  'exit',
]);

/** A tree-selected structural goal, backed by a current component below; never Plan.goal or Plan.next text. */
export type TavernGoapGoal =
  | { kind: 'satisfy_need'; need: ActionNeed['need'] }
  | { kind: 'fulfill_commitment'; id: string }
  | { kind: 'attend_schedule'; id: string }
  | { kind: 'deliver_item'; itemId: string; targetId: string }
  | { kind: 'reach_place'; placeId: string };

/** Machine reasons only. No result asserts completion: accepted legal operations remain the sole authority. */
export type TavernGoapReason =
  | 'first_step'
  | 'no_selected_goal'
  | 'disabled_or_ineligible'
  | 'invalid_input'
  | 'goal_not_applicable'
  | 'no_action_required'
  | 'single_step'
  | 'unknown_position'
  | 'no_legal_plan'
  | 'depth_limit'
  | 'expansion_limit';

/**
 * A single optional first-step suggestion, plus deterministic search counts, never a plan or a completed flag.
 * planLength counts proposed operations; totalCost is dimensionless. Both exist only when a plan was found.
 * A bounded or unreachable search has no candidate. diagnostics follows the behavior tree's component policy.
 */
export interface TavernGoapResult {
  status: 'candidate' | 'not_needed' | 'unreachable';
  reason: TavernGoapReason;
  candidate?: CandidateAction;
  planLength?: number;
  totalCost?: number;
  expandedStates: number;
  generatedStates: number;
  maxDepthReached: number;
  diagnostics: readonly ActionDiagnostic[];
}

type ActionContext = NonNullable<ReturnType<typeof readActionContext>>;

interface GoapObjective {
  goal: TavernGoapGoal;
  evidence: ActionEvidence;
  priority: number;
  constraints: ActionConstraint[];
  step?: ActionStep;
}

// One selected goal can need at most one newly acquired item. Other inventory stays in the read-only projection.
// predicted is only a search predicate; it is never copied into any component, Plan or accepted-operation store.
interface GoapState {
  placeId: string | null;
  pickedItemId: string | null;
  predicted: boolean;
}

interface GoapEdge {
  state: GoapState;
  candidate: CandidateAction;
  rank: readonly number[];
}

interface GoapNode {
  state: GoapState;
  depth: number;
  cost: number;
  order: readonly (readonly number[])[];
  first?: CandidateAction;
}

function readGoapGoal(value: TavernGoapGoal): TavernGoapGoal {
  const kind = choice(own(value, 'kind'), [
    'satisfy_need', 'fulfill_commitment', 'attend_schedule', 'deliver_item', 'reach_place',
  ]);
  if (kind === 'satisfy_need') {
    const need = choice(own(value, 'need'), ['hydration', 'nutrition', 'sleep', 'energy', 'injury', 'pain']);
    return { kind, need };
  }
  if (kind === 'fulfill_commitment' || kind === 'attend_schedule') {
    return { kind, id: identity(own(value, 'id')) };
  }
  if (kind === 'deliver_item') {
    return { kind, itemId: identity(own(value, 'itemId')), targetId: identity(own(value, 'targetId')) };
  }
  return { kind, placeId: identity(own(value, 'placeId')) };
}

function selectGoapObjective(
  input: TavernActionInput,
  context: ActionContext,
  goal: TavernGoapGoal,
): GoapObjective | undefined {
  const { components, actorId, readable, now, places } = context;
  if (goal.kind === 'satisfy_need') {
    const need = components('need', own(input, 'needs') ?? [], readNeed).find(entry =>
      readable(entry) && entry.actorId === actorId && entry.need === goal.need && needPriority(entry) > 0);
    if (!need) return undefined;
    return {
      goal,
      evidence: need,
      priority: needPriority(need),
      constraints: [{ kind: 'need', need: need.need }],
    };
  }

  if (goal.kind === 'fulfill_commitment') {
    const commitment = components('commitment', own(input, 'commitments') ?? [], readCommitment).find(entry =>
      readable(entry) && entry.id === goal.id && entry.mode === 'roleplay'
      && entry.status === 'active' && entry.obligors.includes(actorId));
    if (!commitment || !commitment.step) return undefined;
    const term = commitment.term;
    const due = term.kind === 'persistent' ? term.matched
      : term.kind === 'deadline' && term.clock === 'story'
        && validTime(now) && validTime(term.dueAtMs) && term.dueAtMs <= now;
    if (!due) return undefined;
    return {
      goal,
      evidence: commitment,
      priority: priorities.commitment,
      constraints: [{ kind: 'commitment_active', id: commitment.id, revision: commitment.revision }],
      step: commitment.step,
    };
  }

  if (goal.kind === 'attend_schedule') {
    const slot = components('schedule', own(input, 'schedules') ?? [], readSchedule).find(entry =>
      readable(entry) && entry.id === goal.id && entry.actorId === actorId
      && (entry.authority === 'accepted' || entry.confirmedByUser));
    if (!slot || !validTime(now) || !validTime(slot.startAtMs) || slot.startAtMs > now
      || (slot.endAtMs != null && now >= slot.endAtMs) || slot.placeId == null || !places.has(slot.placeId)) {
      return undefined;
    }
    return {
      goal,
      evidence: slot,
      priority: priorities.schedule,
      constraints: [{ kind: 'schedule_due', id: slot.id, atMs: slot.startAtMs }],
      step: { kind: 'enter', targetId: slot.placeId },
    };
  }

  if (goal.kind === 'deliver_item') {
    const task = components('transfer', own(input, 'transfers') ?? [], readTransfer).find(entry =>
      readable(entry) && entry.actorId === actorId
      && entry.itemId === goal.itemId && entry.desiredHolderId === goal.targetId);
    if (!task || !context.entities.has(goal.targetId)) return undefined;
    return { goal, evidence: task, priority: priorities.transfer, constraints: [] };
  }

  const destination = components('destination', own(input, 'destinations') ?? [], readDestination).find(entry =>
    readable(entry) && entry.actorId === actorId && entry.placeId === goal.placeId);
  if (!destination || !places.has(goal.placeId)) return undefined;
  return { goal, evidence: destination, priority: priorities.movement, constraints: [] };
}

function goapStateKey(state: GoapState): string {
  return JSON.stringify([state.placeId, state.pickedItemId, state.predicted]);
}

function compareGoapNodes(left: GoapNode, right: GoapNode): number {
  if (left.cost !== right.cost) return left.cost - right.cost;
  for (let step = 0; step < Math.min(left.order.length, right.order.length); step++) {
    for (let field = 0; field < left.order[step].length; field++) {
      const difference = left.order[step][field] - right.order[step][field];
      if (difference !== 0) return difference;
    }
  }
  return left.order.length - right.order.length;
}

function goapAlreadyHolds(context: ActionContext, objective: GoapObjective): boolean {
  const goal = objective.goal;
  if (goal.kind === 'reach_place') return context.current === goal.placeId;
  if (goal.kind === 'attend_schedule') return context.current === objective.step?.targetId;
  if (goal.kind === 'deliver_item') return context.possessions.get(goal.itemId)?.()?.holderId === goal.targetId;
  // Needs and commitments are never fulfilled by intention. Their accepted components decide applicability.
  return false;
}

function goapEdges(
  context: ActionContext,
  objective: GoapObjective,
  routes: readonly ActionRoute[],
  resources: readonly ActionResource[],
  state: GoapState,
  ranks: {
    places: ReadonlyMap<string, number>;
    actors: ReadonlyMap<string, number>;
    items: ReadonlyMap<string, number>;
  },
): GoapEdge[] {
  const { actorId, knownConstraint, possessions, visible, positions, places } = context;
  const goal = objective.goal;
  const edges: GoapEdge[] = [];
  const actorPosition = positions.get(actorId);
  const location: ActionConstraint[] = state.placeId == null || !actorPosition ? [] : [
    knownConstraint(actorPosition.basis),
    { kind: 'at_place', placeId: state.placeId },
  ];
  const held = (itemId: string): KnownActionPossession | undefined => {
    const item = possessions.get(itemId)?.();
    return item && (item.holderId === actorId || state.pickedItemId === itemId) ? item : undefined;
  };
  const atTarget = (targetId: string): ActionConstraint[] | undefined => {
    const position = positions.get(targetId);
    if (targetId === actorId || !visible.has(targetId) || state.placeId == null
      || position?.placeId !== state.placeId) return undefined;
    return [
      ...location,
      knownConstraint(position.basis),
      { kind: 'must_be_present', targetId },
    ];
  };
  const matches = (step: ActionStep): boolean => objective.step != null
    && objective.step.kind === step.kind
    && (objective.step.targetId ?? null) === (step.targetId ?? null)
    && (objective.step.objectId ?? null) === (step.objectId ?? null);
  const add = (
    step: ActionStep,
    constraints: ActionConstraint[],
    next: GoapState,
    routeOrder = 0,
  ): void => {
    const fulfillment = goal.kind === 'fulfill_commitment' && next.predicted;
    const targetOrder = step.targetId == null ? -1
      : (step.kind === 'give' || step.kind === 'seek_help' ? ranks.actors : ranks.places).get(step.targetId) ?? -1;
    edges.push({
      state: next,
      rank: [
        GOAP_OPERATION_ORDER.indexOf(step.kind),
        targetOrder,
        step.objectId == null ? -1 : ranks.items.get(step.objectId) ?? -1,
        routeOrder,
      ],
      candidate: {
        actorId,
        kind: fulfillment ? 'fulfill' : step.kind,
        ...(step.targetId == null ? {} : { targetId: step.targetId }),
        ...(step.objectId == null ? {} : { objectId: step.objectId }),
        priority: objective.priority,
        constraints: [
          { kind: 'not_player_decision' },
          knownConstraint(objective.evidence.basis),
          ...objective.constraints,
          ...constraints,
          ...(fulfillment ? [{ kind: 'perform_action' as const, action: { ...step } }] : []),
        ],
      },
    });
  };

  // Relevant items only: one goal never needs the world's full inventory in its search key.
  const items = new Set<string>();
  if (goal.kind === 'deliver_item') items.add(goal.itemId);
  if (goal.kind === 'fulfill_commitment' && objective.step?.objectId != null) items.add(objective.step.objectId);
  for (const resource of resources) {
    let step: ActionStep;
    let constraints: ActionConstraint[] | undefined;
    if (resource.kind === 'item') {
      step = { kind: resource.need === 'hydration' ? 'drink' : 'eat', objectId: resource.itemId };
      if (goal.kind === 'fulfill_commitment' && !matches(step)) continue;
      items.add(resource.itemId);
      const item = held(resource.itemId);
      if (item) {
        constraints = [
          knownConstraint(item.basis),
          { kind: 'must_hold', itemId: resource.itemId, holderId: actorId },
        ];
      }
    } else if (resource.kind === 'rest') {
      step = { kind: 'rest', targetId: resource.placeId };
      if (resource.placeId === state.placeId) constraints = location;
    } else {
      step = { kind: 'seek_help', targetId: resource.actorId };
      constraints = atTarget(resource.actorId);
    }
    if (!constraints || (goal.kind === 'fulfill_commitment' && !matches(step))) continue;
    add(step, [...constraints, knownConstraint(resource.basis)], { ...state, predicted: true });
  }

  const transferItemId = goal.kind === 'deliver_item' ? goal.itemId
    : objective.step?.kind === 'give' ? objective.step.objectId : undefined;
  const recipientId = goal.kind === 'deliver_item' ? goal.targetId
    : objective.step?.kind === 'give' ? objective.step.targetId : undefined;
  if (transferItemId != null && recipientId != null) {
    const item = held(transferItemId);
    const target = atTarget(recipientId);
    if (item && target) {
      add({ kind: 'give', targetId: recipientId, objectId: transferItemId }, [
        knownConstraint(item.basis),
        { kind: 'must_hold', itemId: transferItemId, holderId: actorId },
        ...target,
      ], { ...state, predicted: true });
    }
  }

  for (const itemId of items) {
    const item = possessions.get(itemId)?.();
    if (!item || state.pickedItemId != null || state.placeId == null
      || item.holderId !== state.placeId || !places.has(item.holderId)) continue;
    const step: ActionStep = { kind: 'pick_up', objectId: itemId };
    const predicted = goal.kind === 'deliver_item' ? goal.targetId === actorId
      : goal.kind === 'fulfill_commitment' && matches(step);
    add(step, [
      ...location,
      knownConstraint(item.basis),
      { kind: 'must_hold', itemId, holderId: state.placeId },
    ], { ...state, pickedItemId: itemId, predicted });
  }

  routes.forEach((route, routeOrder) => {
    if (route.fromId !== state.placeId || route.toId === state.placeId) return;
    const step: ActionStep = { kind: route.movement, targetId: route.toId };
    const predicted = goal.kind === 'reach_place' ? route.toId === goal.placeId
      : goal.kind === 'attend_schedule' ? route.toId === objective.step?.targetId
        : goal.kind === 'fulfill_commitment' && matches(step);
    add(step, [
      ...location,
      knownConstraint(route.basis),
      { kind: 'route_open', routeId: route.id },
    ], { ...state, placeId: route.toId, predicted }, routeOrder);
  });
  return edges;
}

/**
 * Plans for one tree-selected goal using only existing structured components. Not wired to any runtime caller.
 * A direct legal step returns single_step with zero expansions so the behavior tree remains its owner.
 * Uniform-cost search chooses the cheapest bounded plan, then operation/Presence/place order, and returns only
 * its first CandidateAction. It does not execute effects, advance time, establish consent or mark completion.
 * Invalid component values follow collectTavernActions diagnostics; caller getter errors propagate unchanged.
 * Current component arrays are not chat history. Reading/indexing is O(n); with bounds B=64 and D=3, search
 * retains at most O(B*n*D) data and costs O(B*(B*n)*log(B*n)*D), independent of chat length. No prose is read.
 */
export function planTavernAction(
  input: TavernActionInput,
  selectedGoal?: TavernGoapGoal | null,
): TavernGoapResult {
  const diagnostics: ActionDiagnostic[] = [];
  const result: TavernGoapResult = {
    status: 'not_needed',
    reason: 'no_selected_goal',
    expandedStates: 0,
    generatedStates: 0,
    maxDepthReached: 0,
    diagnostics,
  };
  if (selectedGoal == null) return result;
  const context = readActionContext(input, diagnostics, true);
  if (!context) {
    result.reason = diagnostics.length === 0 ? 'disabled_or_ineligible' : 'invalid_input';
    if (diagnostics.length !== 0) result.status = 'unreachable';
    return result;
  }
  const goal = context.read('goal', 'selectedGoal', () => readGoapGoal(selectedGoal));
  if (!goal) return { ...result, status: 'unreachable', reason: 'invalid_input' };
  const objective = selectGoapObjective(input, context, goal);
  if (!objective) return { ...result, reason: 'goal_not_applicable' };
  if (goapAlreadyHolds(context, objective)) return { ...result, reason: 'no_action_required' };

  const routes = context.components('route', own(input, 'routes') ?? [], readRoute).filter(route =>
    context.readable(route) && route.passability === 'open'
    && context.places.has(route.fromId) && context.places.has(route.toId));
  const usesResource = goal.kind === 'satisfy_need' || (goal.kind === 'fulfill_commitment'
    && ['drink', 'eat', 'rest', 'seek_help'].includes(objective.step?.kind ?? ''));
  const resources = usesResource
    ? context.components('resource', own(input, 'resources') ?? [], readResource).filter(resource =>
      context.readable(resource) && resource.available
      && (goal.kind !== 'satisfy_need' || resource.need === goal.need))
    : [];
  if (usesResource && resources.length === 0) {
    return { ...result, status: 'unreachable', reason: 'no_legal_plan' };
  }
  const ranks = {
    places: new Map([...context.places].map((placeId, index) => [placeId, index])),
    actors: new Map([...context.present].map((actorId, index) => [actorId, index])),
    items: new Map([...context.possessions.keys()].map((itemId, index) => [itemId, index])),
  };
  const initial: GoapState = {
    placeId: context.current != null && context.places.has(context.current) ? context.current : null,
    pickedItemId: null,
    predicted: false,
  };
  const firstEdges = goapEdges(context, objective, routes, resources, initial, ranks);
  if (firstEdges.some(edge => edge.state.predicted)) return { ...result, reason: 'single_step' };
  if (initial.placeId == null) return { ...result, status: 'unreachable', reason: 'unknown_position' };

  const root: GoapNode = { state: initial, depth: 0, cost: 0, order: [] };
  let queue: GoapNode[] = [root];
  const best = new Map([[goapStateKey(initial), root]]);
  let depthLimited = false;
  result.generatedStates = 1;
  while (queue.length > 0) {
    // Remove superseded entries together; they do not count as expanded states or require repeated sorts.
    queue = queue.filter(node => best.get(goapStateKey(node.state)) === node);
    if (queue.length === 0) break;
    // Charge before testing a state, including terminal states: the 64th may succeed, the 65th is never read.
    if (result.expandedStates >= GOAP_MAX_EXPANDED_STATES) {
      return { ...result, status: 'unreachable', reason: 'expansion_limit' };
    }
    queue.sort(compareGoapNodes);
    const node = queue.shift()!;
    result.expandedStates++;
    result.maxDepthReached = Math.max(result.maxDepthReached, node.depth);
    if (node.state.predicted && node.first) {
      return {
        ...result,
        status: 'candidate',
        reason: 'first_step',
        candidate: node.first,
        planLength: node.depth,
        totalCost: node.cost,
      };
    }
    if (node.depth >= GOAP_MAX_DEPTH) {
      depthLimited = true;
      continue;
    }
    const edges = node.depth === 0 ? firstEdges : goapEdges(context, objective, routes, resources, node.state, ranks);
    for (const edge of edges) {
      const next: GoapNode = {
        state: edge.state,
        depth: node.depth + 1,
        cost: node.cost + GOAP_OPERATION_COST,
        order: [...node.order, edge.rank],
        first: node.first ?? edge.candidate,
      };
      const key = goapStateKey(next.state);
      const previous = best.get(key);
      if (previous && compareGoapNodes(previous, next) <= 0) continue;
      best.set(key, next);
      queue.push(next);
      result.generatedStates++;
    }
  }
  return { ...result, status: 'unreachable', reason: depthLimited ? 'depth_limit' : 'no_legal_plan' };
}
