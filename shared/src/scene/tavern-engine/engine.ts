import { createHash } from 'node:crypto';
import type { AcceptedMessage } from '../../core/types.ts';
import type { Scope } from '../../memory/access.ts';
import { checkTavernBeatScript, decodeBeatCandidate, MAX_TAVERN_TURN_UNITS } from './codec.ts';
import type { TavernBeatQuotation } from './codec.ts';
import { buildTavernBeatInput, SLOT_INTENT_INSTRUCTIONS } from './model-input.ts';
import type { TavernBeatActorContract, TavernBeatInput, TavernBeatPrefix, TavernIntentInput } from './model-input.ts';
import { TavernPerception } from './perception.ts';
import { projectTavernWorld } from './projection.ts';
import type { TavernWorldSnapshot } from './projection.ts';
import {
  buildTavernScheduleRoster,
  createTavernTurnBudget,
  selectNextTavernBeat,
} from './scheduler.ts';
import type {
  TavernActorSignals,
  TavernBudgetInput,
  TavernCloseReason,
  TavernDispatch,
  TavernRosterInput,
  TavernScheduleRoster,
  TavernTurnBudget,
} from './scheduler.ts';
import type {
  AcceptedTavernTurn,
  EmittedTavernBeat,
  NpcTurnInput,
  PlayerInterpretationInput,
  TavernCommitReceipt,
  TavernSourceReference,
} from './store.ts';
import type {
  DecodedBeat,
  EngineEvent,
  EngineEventEnvelope,
  EventOrigin,
  EventReference,
  LinkedBeatEffect,
  TavernEventPermission,
  TavernPerceptionDispatch,
  TavernPerceptionInput,
  TavernPlayerEventView,
} from './types.ts';

/** Closed execution states; Abort discards only this turn's NPC candidates and always returns to Idle. */
export type TavernEngineState =
  | 'Idle' | 'Interpret' | 'Validate' | 'Schedule' | 'Beat' | 'CheckBeat'
  | 'Close' | 'Render' | 'VerifyRender' | 'Commit' | 'Abort';

/** All identity belongs to the caller; revisions are positive integers and IDs are opaque nonempty strings. */
export interface TavernTurnIdentity {
  scope: Scope;
  turnId: string;
  turnRevision: number;
  ticketId: string;
  playerSource: TavernSourceReference;
  assistantSource: TavernSourceReference;
}

/**
 * Already accepted user input and arrival time in monotonic milliseconds. No timer starts at construction.
 * Null optional samples/signals mean omission. A rejected request neither queues nor changes an active turn.
 */
export interface TavernEngineRequest extends TavernTurnIdentity {
  message: AcceptedMessage;
  playerId: string;
  expectedVersion: number;
  directorEnabled: boolean;
  startedAtMs: number;
  hostId: string;
  configurationId: string;
  /** Separate effective settings for host render and beat samples; null/omission uses configurationId. */
  renderConfigurationId?: string | null;
  beatConfigurationId?: string | null;
  renderSamples?: TavernBudgetInput['renderSamples'];
  beatSamples?: TavernBudgetInput['beatSamples'];
  signal?: AbortSignal | null;
}

/**
 * Non-executable rejected action, kept separately from emitted items. text and itemRef are verbatim/original.
 * source binds the full original envelope, scope, player source revision and rule version; reason is a code.
 * Persistence must accept this list even when every action was excluded and no visible item remains.
 */
export interface TavernUnknownActionDiagnostic {
  kind: 'Unknown';
  actorId: string;
  text: string;
  itemRef: number;
  reason: string;
  source: { envelope: EngineEventEnvelope; origin: EventOrigin };
}

/**
 * Non-executable effect rejection on a retained item. Both indices are original zero-based references.
 * effect preserves the rejected link for replay/audit only; text is the item's verbatim text, never rewritten.
 */
export interface TavernUnknownEffectDiagnostic extends TavernUnknownActionDiagnostic {
  effectIndex: number;
  effect: LinkedBeatEffect;
}

/**
 * Atomic NPC acceptance input. The port must persist display, emitted-only ledger, diagnostics and receipt
 * in one authority transaction. Rejected effects are absent from beats, with original links in diagnostics.
 * Retained speech/items and remaining effect indices are unchanged; diagnostics never become world effects.
 * Validate playerSource and expectedVersion in that transaction, and bind ticketId to the complete input.
 */
export interface TavernEngineCommitInput extends NpcTurnInput {
  playerSource: TavernSourceReference;
  unknownDiagnostics: readonly (TavernUnknownActionDiagnostic | TavernUnknownEffectDiagnostic)[];
  display: { body: string; renderer: 'A' | 'B'; fallback: boolean };
}

/** Source/revision-bound M1 outcome. A successful empty plan is success; only exhausted retries yield fallback. */
export interface TavernInterpretationMetadata {
  outcome: 'success' | 'fallback';
  source: TavernSourceReference;
  turnRevision: number;
}

/** Player acceptance must atomically persist events and their outcome; idempotency includes both. */
export interface TavernEnginePlayerInput extends PlayerInterpretationInput {
  interpretation: TavernInterpretationMetadata;
}

/** Durable player interpretation with mandatory replay metadata; missing or mismatched metadata is rejected. */
export type TavernAcceptedPlayerInterpretation = Extract<AcceptedTavernTurn, { kind: 'interpret' }> & {
  interpretation: TavernInterpretationMetadata;
};

/**
 * Synchronous local authority port; no model/host awaits may occur inside these operations.
 * isCurrent checks the accepted user source and exact authority version. readPlayer is source/revision keyed.
 * acceptPlayer is idempotent and survives any later NPC abort. commitNpc must be atomic and idempotent.
 * readPlayer/acceptPlayer preserve interpretation metadata, bound to the same player source and turn revision.
 * Legacy entries without outcome metadata cannot be guessed from events; migration is the port's responsibility.
 * findReceipt returns only a durable receipt for the entire supplied identity, including assistantSource.
 * A thrown commit may be recovered by that same receipt; a failed transaction must leave no NPC effects.
 */
export interface TavernEngineLedgerPort {
  isCurrent(identity: TavernTurnIdentity, expectedVersion: number): boolean;
  readPlayer(identity: TavernTurnIdentity): TavernAcceptedPlayerInterpretation | null;
  acceptPlayer(input: TavernEnginePlayerInput): TavernAcceptedPlayerInterpretation;
  commitNpc(input: TavernEngineCommitInput): TavernCommitReceipt;
  findReceipt(identity: TavernTurnIdentity): TavernCommitReceipt | null;
}

/**
 * Host-owned monotonic clock. schedule wakes at an absolute deadline in milliseconds and returns cleanup.
 * Cancellation must stop host/model work when its signal aborts; late settlements are ignored by the engine.
 * schedule must not fire early. Callback/getter errors abort the turn; cleanup errors are reported separately.
 */
export interface TavernEngineClockPort {
  now(): number;
  schedule(deadlineMs: number, wake: () => void): () => void;
}

/** Structured interpretation from the M1 adapter; retryable failures share the existing four-attempt limit. */
export type TavernInterpretationReply =
  | { kind: 'plan'; events: readonly EngineEvent[] }
  | { kind: 'retryable' }
  | { kind: 'fatal' };

/**
 * Source-checked state after player acceptance, existing foreground barriers and fixed recall.
 * perception is the baseline plus its valid suffix, not prose. version includes completed foreground writes.
 * targeting/signals are privileged local data; the engine never passes them wholesale to an NPC model.
 */
export interface TavernPreparedTurn {
  version: number;
  perception: TavernPerceptionInput;
  targeting: Omit<TavernRosterInput, 'projection' | 'directorEnabled'>;
  actors: readonly TavernActorSignals[];
  ruleVersion: string;
  eventReferences?: readonly EventReference[] | null;
  /** M2 adapter preparation; omit only for a port implementing its own complete contract validation. */
  beatContracts?: readonly TavernBeatActorContract[] | null;
}

/** Nonempty reason codes address original action items; speech cannot be silently removed or rewritten. */
export interface TavernInvalidAction {
  itemRef: number;
  reason: string;
}

/**
 * Rejected effect's original zero-based index and nonempty reason code.
 * Linked actions are also rejected; linked speech remains a statement without the rejected hard effect.
 */
export interface TavernInvalidEffect {
  effectIndex: number;
  reason: string;
}

/**
 * Local semantic/phase validation result. retry covers fields or script form; invalid_actions names failures
 * that may be excluded after the one shared retry. invalid_effects can also name rejected actions.
 * The port owns the complete dependency closure: scan remaining items/effects in phase order after exclusions,
 * adding every action/effect that loses a prerequisite. Codec bounds make this a finite local operation.
 * This keeps domain validation in one place; the engine never infers prerequisites from text or retries M2 again.
 * An incomplete closure that fails projection aborts. Permissions are independently checked by perception.
 */
export type TavernBeatCheck = {
  permissions: readonly TavernEventPermission[];
  /**
   * Source-verified quotation spans for this decoded candidate only, resolved after generation.
   * The checker verifies current source revision and actor access. Null/omission grants no exemptions.
   * Unrelated prepared spans must not be returned; the codec still verifies exact text and offsets.
   */
  quotations?: readonly TavernBeatQuotation[] | null;
} & (
  | { kind: 'valid' }
  | { kind: 'retry'; reason: string }
  | { kind: 'invalid_actions'; actions: readonly TavernInvalidAction[] }
  | { kind: 'invalid_effects'; effects: readonly TavernInvalidEffect[]; actions?: readonly TavernInvalidAction[] | null }
);

/**
 * All external work is injected. Model callbacks receive no full world, unfiltered beats or private packet.
 * prepare performs existing pre-generation work, not an extra model dispatch owned by this engine.
 * checkBeat/verifyRender/renderA are synchronous local operations; renderA is formatting, never a model.
 * afterCommit schedules existing ending stages and must not undo acceptance if scheduling throws.
 * Prompt wording is deliberately absent; adapters own it. Rejected promises/getters abort unless typed retryable.
 */
export interface TavernEnginePorts {
  ledger: TavernEngineLedgerPort;
  clock: TavernEngineClockPort;
  interpret(input: {
    identity: TavernTurnIdentity;
    message: AcceptedMessage;
    attempt: number;
    signal: AbortSignal;
  }): Promise<TavernInterpretationReply>;
  prepare(input: {
    identity: TavernTurnIdentity;
    interpretation: TavernAcceptedPlayerInterpretation;
    lowConfidenceBroadcast: boolean;
    signal: AbortSignal;
  }): Promise<TavernPreparedTurn>;
  /** Optional first-beat front call for different settings; returns {goal, next}, with no independent retry. */
  intent?: ((input: { modelInput: TavernIntentInput; signal: AbortSignal }) => unknown | PromiseLike<unknown>) | null;
  beat(input: {
    identity: TavernTurnIdentity;
    actorId: string;
    beatIndex: number;
    attempt: number;
    maxItems: number;
    firstForActor: boolean;
    intent?: NonNullable<DecodedBeat['intent']>;
    modelInput?: TavernBeatInput;
    input: TavernPerceptionDispatch['input'];
    retryReasons: readonly string[];
    signal: AbortSignal;
  }): Promise<unknown>;
  checkBeat(input: { identity: TavernTurnIdentity; world: TavernWorldSnapshot; beat: DecodedBeat }): TavernBeatCheck;
  render(input: {
    identity: TavernTurnIdentity;
    packet: TavernPlayerEventView;
    signal: AbortSignal;
  }): Promise<string>;
  verifyRender(input: { packet: TavernPlayerEventView; body: string; renderer: 'A' | 'B' }): boolean;
  renderA(packet: TavernPlayerEventView): string;
  afterCommit(receipt: TavernCommitReceipt): void;
}

/** Diagnostic codes only, never provider error text, prompts or product wording. */
export type TavernEngineAbortReason =
  | 'cancelled' | 'source_invalid' | 'turn_deadline' | 'port_error' | 'invalid_plan'
  | 'invalid_preparation' | 'invalid_beat' | 'invalid_packet' | 'invalid_render'
  | 'invalid_receipt' | 'model_overlap' | 'clock_error';

/** Per-run mechanical evidence; no history, model bodies or secrets are retained by the worker. */
export interface TavernEngineRunSummary {
  states: readonly TavernEngineState[];
  playerAccepted: boolean;
  dispatches: readonly TavernDispatch[];
  unservedRespondIds: readonly string[];
  closeReason: TavernCloseReason | null;
  interpretationAttempts: number;
  modelDispatches: number;
  /** One fixed code per failed front value, at most eight served NPCs; no returned model text. */
  intentDiagnostics: readonly 'invalid_front_intent'[];
  renderFailures: number;
  cleanupFailures: number;
  postCommitFailed: boolean;
}

/** Completion is separate from host/model quality. Committed means the authority port returned a bound receipt. */
export type TavernEngineResult =
  | { status: 'rejected'; reason: 'invalid_input' | 'scope_busy' }
  | (TavernEngineRunSummary & (
    | { status: 'committed'; receipt: TavernCommitReceipt }
    | { status: 'aborted'; reason: TavernEngineAbortReason }
  ));

// Existing foreground policy allows one initial attempt and three retries. Beat retries use the budget module.
const INTERPRETATION_ATTEMPTS = 4;

class StopTurn extends Error {
  readonly reason: TavernEngineAbortReason | 'beat_deadline';

  constructor(reason: TavernEngineAbortReason | 'beat_deadline') {
    super(reason);
    this.reason = reason;
  }
}

interface ActiveTurn {
  identity: TavernTurnIdentity;
  request: Omit<TavernEngineRequest, 'signal'>;
  controller: AbortController;
  state: TavernEngineState;
  version: number;
  budget: TavernTurnBudget;
  modelActive: boolean;
  summary: TavernEngineRunSummary;
}

function identityKey(scope: Scope): string {
  const parts = [scope.worldId, scope.sessionId, scope.branchId, scope.characterId];
  for (const part of parts) requireId(part);
  return JSON.stringify(parts);
}

function requireId(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new StopTurn('invalid_plan');
}

function requireInteger(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new StopTurn('invalid_plan');
}

function sameSource(left: TavernSourceReference, right: TavernSourceReference): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function checkIdentity(request: Omit<TavernEngineRequest, 'signal'>): TavernTurnIdentity {
  identityKey(request.scope);
  for (const value of [request.turnId, request.ticketId, request.playerId, request.hostId, request.configurationId,
    request.playerSource.id, request.assistantSource.id]) {
    requireId(value);
  }
  requireInteger(request.turnRevision, 1);
  requireInteger(request.playerSource.revision, 1);
  requireInteger(request.assistantSource.revision, 1);
  requireInteger(request.expectedVersion, 0);
  requireInteger(request.message.acceptedAtMs, 0);
  if (request.message.role !== 'user' || !sameSource(request.playerSource, request.message)
    || typeof request.message.text !== 'string' || typeof request.directorEnabled !== 'boolean'
    || request.playerSource.id === request.assistantSource.id) {
    throw new StopTurn('invalid_plan');
  }
  return {
    scope: request.scope,
    turnId: request.turnId,
    turnRevision: request.turnRevision,
    ticketId: request.ticketId,
    playerSource: request.playerSource,
    assistantSource: request.assistantSource,
  };
}

function requireEventIdentity(event: EngineEvent, identity: TavernTurnIdentity, status: 'tentative' | 'accepted'): void {
  requireId(event.envelope.id);
  requireId(event.origin.ruleVersion);
  if (identityKey(event.origin.scope) !== identityKey(identity.scope)
    || event.envelope.turnId !== identity.turnId || event.origin.turnRevision !== identity.turnRevision
    || event.origin.sourceId !== identity.playerSource.id
    || event.origin.sourceRevision !== identity.playerSource.revision
    || event.envelope.source !== 'interpret' || event.envelope.beatIndex !== 0 || event.envelope.status !== status) {
    throw new StopTurn('invalid_plan');
  }
}

function checkPlayerTurn(turn: TavernAcceptedPlayerInterpretation, identity: TavernTurnIdentity): void {
  if (turn.kind !== 'interpret' || identityKey(turn.scope) !== identityKey(identity.scope)
    || turn.turnId !== identity.turnId || turn.turnRevision !== identity.turnRevision
    || !sameSource(turn.source, identity.playerSource)) {
    throw new StopTurn('invalid_plan');
  }
  requireInteger(turn.version, 0);
  const metadata = turn.interpretation;
  if ((metadata.outcome !== 'success' && metadata.outcome !== 'fallback')
    || !sameSource(metadata.source, identity.playerSource)
    || metadata.turnRevision !== identity.turnRevision
    || (metadata.outcome === 'fallback' && turn.events.length !== 0)) {
    throw new StopTurn('invalid_plan');
  }
  for (const event of turn.events) requireEventIdentity(event, identity, 'accepted');
}

function checkedReceipt(receipt: TavernCommitReceipt, identity: TavernTurnIdentity, body?: string): TavernCommitReceipt {
  const copied = structuredClone(receipt);
  if (identityKey(copied.scope) !== identityKey(identity.scope) || copied.ticketId !== identity.ticketId
    || copied.turnId !== identity.turnId || copied.turnRevision !== identity.turnRevision
    || !sameSource(copied.source, identity.assistantSource) || copied.status !== 'accepted') {
    throw new StopTurn('invalid_receipt');
  }
  requireInteger(copied.version, 0);
  requireInteger(copied.acceptedAtMs, 0);
  requireId(copied.bodyHash);
  if (body != null && copied.bodyHash !== createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex')) {
    throw new StopTurn('invalid_receipt');
  }
  return copied;
}

function move(turn: ActiveTurn, state: TavernEngineState): void {
  turn.state = state;
  turn.summary.states = [...turn.summary.states, state];
}

/**
 * Long-lived, in-process worker. Import/construction is inert: no thread, process, timer, host or model starts.
 * run rejects same-scope overlap before any port call; different scopes have independent turn-local state.
 * Work is linear in supplied structured bytes per pass, with at most eight beats/two attempts each. Perception
 * folds a full suffix at most nine times, a fixed bound, never every history prefix. Text is only copied/hashed.
 * Unbounded message/history input is delegated to the existing linear modules; per-beat limits are codec-owned.
 */
export class TavernEngine {
  readonly #ports: TavernEnginePorts;
  readonly #active = new Map<string, ActiveTurn>();

  constructor(ports: TavernEnginePorts) {
    this.#ports = ports;
  }

  /** Returns this scope's current state, or Idle. Invalid/getter-bearing scope input throws without mutations. */
  state(scope: Scope): TavernEngineState {
    return this.#active.get(identityKey(scope))?.state ?? 'Idle';
  }

  /** Cancels only an active matching scope; returns false when idle. Accepted player state is never rolled back. */
  cancel(scope: Scope): boolean {
    const turn = this.#active.get(identityKey(scope));
    if (!turn) return false;
    turn.controller.abort();
    return true;
  }

  /** Runs one bounded turn. Input/getter errors reject; operational failures return Abort followed by Idle. */
  async run(input: TavernEngineRequest): Promise<TavernEngineResult> {
    let request: Omit<TavernEngineRequest, 'signal'>;
    let identity: TavernTurnIdentity;
    let signal: AbortSignal | null | undefined;
    let budget: TavernTurnBudget;
    let key: string;
    try {
      const { signal: suppliedSignal, ...data } = input;
      signal = suppliedSignal;
      if (signal != null && !(signal instanceof AbortSignal)) return { status: 'rejected', reason: 'invalid_input' };
      request = structuredClone(data);
      identity = checkIdentity(request);
      key = identityKey(identity.scope);
      if (this.#active.has(key)) return { status: 'rejected', reason: 'scope_busy' };
      budget = createTavernTurnBudget({
        startedAtMs: request.startedAtMs,
        hostId: request.hostId,
        configurationId: request.configurationId,
        renderConfigurationId: request.renderConfigurationId,
        beatConfigurationId: request.beatConfigurationId,
        now: () => this.#ports.clock.now(),
        renderSamples: request.renderSamples,
        beatSamples: request.beatSamples,
      });
    } catch {
      return { status: 'rejected', reason: 'invalid_input' };
    }

    const turn: ActiveTurn = {
      identity,
      request,
      controller: new AbortController(),
      state: 'Idle',
      version: request.expectedVersion,
      budget,
      modelActive: false,
      summary: {
        states: ['Idle'],
        playerAccepted: false,
        dispatches: [],
        unservedRespondIds: [],
        closeReason: null,
        interpretationAttempts: 0,
        modelDispatches: 0,
        intentDiagnostics: [],
        renderFailures: 0,
        cleanupFailures: 0,
        postCommitFailed: false,
      },
    };
    this.#active.set(key, turn);
    const cancel = () => turn.controller.abort();
    let outcome: { status: 'committed'; receipt: TavernCommitReceipt }
      | { status: 'aborted'; reason: TavernEngineAbortReason };
    try {
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      this.#checkCancellation(turn);
      const prior = this.#ports.ledger.findReceipt(structuredClone(identity));
      if (prior != null) {
        const receipt = checkedReceipt(prior, identity);
        turn.summary.playerAccepted = true;
        outcome = { status: 'committed', receipt };
      } else {
        const receipt = await this.#execute(turn);
        move(turn, 'Idle');
        try {
          this.#ports.afterCommit(structuredClone(receipt));
        } catch {
          turn.summary.postCommitFailed = true;
        }
        outcome = { status: 'committed', receipt };
      }
    } catch (error) {
      move(turn, 'Abort');
      turn.controller.abort();
      move(turn, 'Idle');
      const reason = error instanceof StopTurn && error.reason !== 'beat_deadline' ? error.reason : 'port_error';
      outcome = { status: 'aborted', reason };
    } finally {
      try {
        signal?.removeEventListener('abort', cancel);
      } catch {
        turn.summary.cleanupFailures++;
      } finally {
        this.#active.delete(key);
      }
    }
    return { ...turn.summary, ...outcome };
  }

  #checkCancellation(turn: ActiveTurn): void {
    if (turn.controller.signal.aborted) throw new StopTurn('cancelled');
  }

  #check(turn: ActiveTurn): void {
    this.#checkCancellation(turn);
    const time = turn.budget.snapshot();
    if (time.nowMs >= time.turnHardDeadlineMs) throw new StopTurn('turn_deadline');
    if (this.#ports.ledger.isCurrent(structuredClone(turn.identity), turn.version) !== true) {
      throw new StopTurn('source_invalid');
    }
    // A reentrant local port may cancel this turn while performing its check.
    this.#checkCancellation(turn);
    // Synchronous authority work consumes the same hard budget, including the final pre-commit check.
    const afterCheck = turn.budget.snapshot();
    // The injected clock can reenter cancellation just like the authority callback.
    this.#checkCancellation(turn);
    if (afterCheck.nowMs >= afterCheck.turnHardDeadlineMs) throw new StopTurn('turn_deadline');
  }

  #wait<Value>(
    turn: ActiveTurn,
    deadlineMs: number,
    deadlineReason: 'turn_deadline' | 'beat_deadline',
    model: boolean,
    operation: (signal: AbortSignal) => Promise<Value>,
  ): Promise<Value> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let cleanup: (() => void) | undefined;
      let ownsModel = false;
      const cleanTimer = () => {
        const remove = cleanup;
        cleanup = undefined;
        try {
          remove?.();
        } catch {
          turn.summary.cleanupFailures++;
        }
      };
      const finish = (result: { value: Value } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        if (ownsModel) turn.modelActive = false;
        turn.controller.signal.removeEventListener('abort', cancelled);
        if ('error' in result) controller.abort();
        cleanTimer();
        if ('error' in result) reject(result.error);
        else resolve(result.value);
      };
      const cancelled = () => finish({ error: new StopTurn('cancelled') });
      const expired = () => {
        try {
          const now = turn.budget.snapshot().nowMs;
          finish({ error: new StopTurn(now >= deadlineMs ? deadlineReason : 'clock_error') });
        } catch (error) {
          finish({ error });
        }
      };
      try {
        this.#check(turn);
        if (turn.budget.snapshot().nowMs >= deadlineMs) throw new StopTurn(deadlineReason);
        if (model && turn.modelActive) throw new StopTurn('model_overlap');
        turn.controller.signal.addEventListener('abort', cancelled, { once: true });
        cleanup = this.#ports.clock.schedule(deadlineMs, expired);
        if (typeof cleanup !== 'function') throw new StopTurn('clock_error');
        if (settled) {
          cleanTimer();
          return;
        }
        this.#check(turn);
        if (model) {
          turn.modelActive = true;
          ownsModel = true;
          turn.summary.modelDispatches++;
        }
        // Resolve assimilates foreign thenables under the same rejection boundary as synchronous callbacks.
        Promise.resolve(operation(controller.signal)).then(value => {
          if (settled) return;
          try {
            // prepare may legitimately advance the authority version; its caller adopts and checks that version.
            this.#checkCancellation(turn);
            if (turn.budget.snapshot().nowMs >= deadlineMs) throw new StopTurn(deadlineReason);
            finish({ value });
          } catch (error) {
            finish({ error });
          }
        }, error => finish({ error }));
      } catch (error) {
        finish({ error });
      }
    });
  }

  async #interpret(turn: ActiveTurn): Promise<{ accepted: TavernAcceptedPlayerInterpretation; fallback: boolean }> {
    move(turn, 'Interpret');
    this.#check(turn);
    const cached = this.#ports.ledger.readPlayer(structuredClone(turn.identity));
    let events: readonly EngineEvent[] = [];
    let fallback = false;
    if (cached == null) {
      fallback = true;
      for (let attempt = 0; attempt < INTERPRETATION_ATTEMPTS; attempt++) {
        turn.summary.interpretationAttempts++;
        const reply = structuredClone(await this.#wait(
          turn,
          turn.budget.snapshot().turnHardDeadlineMs,
          'turn_deadline',
          true,
          signal => this.#ports.interpret({
            identity: structuredClone(turn.identity),
            message: structuredClone(turn.request.message),
            attempt,
            signal,
          }),
        ));
        if (reply.kind === 'fatal') throw new StopTurn('port_error');
        if (reply.kind === 'plan') {
          events = reply.events;
          fallback = false;
          break;
        }
        if (reply.kind !== 'retryable') throw new StopTurn('invalid_plan');
      }
    }

    move(turn, 'Validate');
    this.#check(turn);
    if (cached != null) {
      const accepted = structuredClone(cached);
      checkPlayerTurn(accepted, turn.identity);
      turn.summary.playerAccepted = true;
      return { accepted, fallback: accepted.interpretation.outcome === 'fallback' };
    }
    for (const event of events) requireEventIdentity(event, turn.identity, 'tentative');
    const accepted = structuredClone(this.#ports.ledger.acceptPlayer({
      scope: structuredClone(turn.identity.scope),
      turnId: turn.identity.turnId,
      turnRevision: turn.identity.turnRevision,
      source: structuredClone(turn.identity.playerSource),
      expectedVersion: turn.version,
      events,
      interpretation: {
        outcome: fallback ? 'fallback' : 'success',
        source: structuredClone(turn.identity.playerSource),
        turnRevision: turn.identity.turnRevision,
      },
    }));
    checkPlayerTurn(accepted, turn.identity);
    if (accepted.interpretation.outcome !== (fallback ? 'fallback' : 'success')) throw new StopTurn('invalid_plan');
    if (accepted.version < turn.version) throw new StopTurn('invalid_plan');
    turn.version = accepted.version;
    turn.summary.playerAccepted = true;
    this.#check(turn);
    return { accepted, fallback };
  }

  async #execute(turn: ActiveTurn): Promise<TavernCommitReceipt> {
    const interpreted = await this.#interpret(turn);
    const prepared = structuredClone(await this.#wait(
      turn,
      turn.budget.snapshot().turnHardDeadlineMs,
      'turn_deadline',
      false,
      signal => this.#ports.prepare({
        identity: structuredClone(turn.identity),
        interpretation: structuredClone(interpreted.accepted),
        lowConfidenceBroadcast: interpreted.fallback,
        signal,
      }),
    ));
    requireInteger(prepared.version, turn.version);
    requireId(prepared.ruleVersion);
    if (identityKey(prepared.perception.baseline.scope) !== identityKey(turn.identity.scope)
      || prepared.perception.playerId !== turn.request.playerId) {
      throw new StopTurn('invalid_preparation');
    }
    turn.version = prepared.version;
    this.#check(turn);
    let world = projectTavernWorld(prepared.perception.baseline, prepared.perception.steps).world;
    const perception = new TavernPerception(prepared.perception);
    const roster = buildTavernScheduleRoster({
      ...prepared.targeting,
      projection: world,
      directorEnabled: turn.request.directorEnabled,
      ...(interpreted.fallback ? { inferredAddressees: [], perceivingActorIds: world.presentIds } : {}),
    });
    const selections: EmittedTavernBeat[] = [];
    const diagnostics: (TavernUnknownActionDiagnostic | TavernUnknownEffectDiagnostic)[] = [];
    const contracts = new Map<string, TavernBeatActorContract>();
    const prefixes = new Map<string, TavernBeatPrefix>();
    const intents = new Map<string, NonNullable<DecodedBeat['intent']>>();
    const completedActors = new Set<string>();
    for (const contract of prepared.beatContracts ?? []) {
      if (contracts.has(contract.actorId) || !world.entityIds.includes(contract.actorId)) {
        throw new StopTurn('invalid_preparation');
      }
      requireId(contract.beatConfigurationId);
      requireId(contract.frontConfigurationId);
      const initial = perception.prepareDispatch(contract.actorId, turn.identity.turnId).input;
      if (contract.persona != null && typeof contract.persona !== 'string') throw new StopTurn('invalid_preparation');
      contracts.set(contract.actorId, contract);
      prefixes.set(contract.actorId, {
        persona: contract.persona ?? '',
        materials: initial.materials.filter(material =>
          material.channel === 'memory' || material.channel === 'recall' || material.channel === 'emotion'),
        turnWindow: initial.turnWindow,
      });
      if (contract.beatConfigurationId !== contract.frontConfigurationId) {
        if (contract.frontIntent == null) {
          if (this.#ports.intent == null) throw new StopTurn('invalid_preparation');
        } else {
          intents.set(contract.actorId, this.#checkedIntent(
            contract.frontIntent, turn, prepared, world, contract.actorId, 'invalid_preparation',
          ));
        }
      }
    }

    move(turn, 'Schedule');
    while (true) {
      this.#check(turn);
      const decision = selectNextTavernBeat({
        roster,
        projection: world,
        actors: this.#scheduleActors(prepared, perception, turn.summary.dispatches, turn.identity.turnId),
        dispatches: turn.summary.dispatches,
        budget: turn.budget.snapshot(),
      });
      turn.summary.unservedRespondIds = decision.unservedRespondIds;
      if (decision.kind === 'Close') {
        if (decision.reason === 'turn_deadline') throw new StopTurn('turn_deadline');
        turn.summary.closeReason = decision.reason;
        break;
      }
      let lease = turn.budget.beginBeat(decision.beatIndex);
      if (lease == null) {
        turn.summary.closeReason = 'beat_deadline';
        break;
      }
      const dispatch: TavernDispatch = { actorId: decision.actorId, hasSpoken: false, hasActed: false };
      turn.summary.dispatches = [...turn.summary.dispatches, dispatch];
      this.#unserved(turn, roster);
      const delivery = perception.prepareDispatch(decision.actorId, turn.identity.turnId);
      const firstForActor = !completedActors.has(decision.actorId);
      let intent = intents.get(decision.actorId);
      const contract = contracts.get(decision.actorId);
      if (prepared.beatContracts != null && contract == null) throw new StopTurn('invalid_preparation');
      const dispatchInput = {
        identity: structuredClone(turn.identity),
        actorId: decision.actorId,
        beatIndex: decision.beatIndex,
        maxItems: decision.maxItems,
        firstForActor,
        ...(intent == null ? {} : { intent: structuredClone(intent) }),
        input: structuredClone(delivery.input),
        attempt: 0,
        retryReasons: [] as string[],
      };
      // Assemble once before either attempt: rejected output cannot alter the prefix, tail, actor or intent.
      const modelInput = contract == null ? undefined : buildTavernBeatInput(
        dispatchInput,
        contract,
        prefixes.get(decision.actorId)!,
        turn.request.message.text,
      );
      let retryReasons: string[] = [];
      let completed = false;
      try {
        // Only the first actual dispatch can spend a front call. Retries and later events stay on beat.
        if (firstForActor && contract != null && modelInput != null && intent == null
          && contract.beatConfigurationId !== contract.frontConfigurationId) {
          const rawIntent = await this.#wait(turn, lease.deadlineMs, 'beat_deadline', true, async signal => {
            const runner = this.#ports.intent;
            if (runner == null) throw new StopTurn('invalid_preparation');
            return runner.call(this.#ports, {
              modelInput: {
                instructions: SLOT_INTENT_INSTRUCTIONS,
                identity: structuredClone(turn.identity),
                actorId: decision.actorId,
                configurationId: contract.frontConfigurationId,
                prefix: structuredClone(modelInput.prefix),
                tail: structuredClone(modelInput.tail),
              },
              signal,
            });
          });
          intent = this.#decodeIntent(rawIntent, turn, prepared, world, decision.actorId);
          if (intent == null) {
            // A bad returned value spends no new call: the first beat and its existing retry must supply intent.
            modelInput.intentRequired = true;
            turn.summary.intentDiagnostics = [...turn.summary.intentDiagnostics, 'invalid_front_intent'];
          } else {
            intents.set(decision.actorId, intent);
            dispatchInput.intent = structuredClone(intent);
            modelInput.intent = structuredClone(intent);
          }
        }

        while (!completed) {
          move(turn, 'Beat');
          const raw = await this.#wait(turn, lease.deadlineMs, 'beat_deadline', true, signal => this.#ports.beat({
            ...structuredClone(dispatchInput),
            attempt: lease!.attempt,
            retryReasons: [...retryReasons],
            ...(modelInput == null ? {} : {
              modelInput: { ...structuredClone(modelInput), retryReasons: [...retryReasons] },
            }),
            signal,
          }));
          move(turn, 'CheckBeat');
          this.#check(turn);
          const decoded = decodeBeatCandidate(raw, {
            envelope: {
              id: JSON.stringify([turn.identity.turnId, turn.identity.turnRevision, 'beat', decision.beatIndex]),
              turnId: turn.identity.turnId,
              beatIndex: decision.beatIndex,
              source: 'beat',
              status: 'tentative',
            },
            scope: turn.identity.scope,
            turnRevision: turn.identity.turnRevision,
            ruleVersion: prepared.ruleVersion,
            message: turn.request.message,
            actorId: decision.actorId,
            entityIds: world.entityIds,
            itemIds: world.possessions.map(item => item.itemId),
            placeIds: world.placeIds,
            eventReferences: prepared.eventReferences ?? [],
            scheduledActorCount: decision.scheduledActorCount,
          });
          // Decode is the structural gate. Every other mechanical reason shares this one retry.
          const check: TavernBeatCheck | null = decoded.ok ? structuredClone(this.#ports.checkBeat({
            identity: structuredClone(turn.identity),
            world: structuredClone(world),
            beat: structuredClone(decoded.value),
          })) : null;
          this.#check(turn);
          const invalidEffects = decoded.ok && check != null
            ? this.#invalidEffects(decoded.value, check, contract != null) : [];
          const invalid = decoded.ok && check != null
            ? this.#invalidActions(decoded.value, check, invalidEffects) : [];
          const contractReasons: string[] = [];
          if (decoded.ok && contract != null && modelInput != null && check != null) {
            if (modelInput.intentRequired && decoded.value.intent == null) contractReasons.push('missing_intent');
            // Pending-item ownership is unavailable; a reference cannot activate it by itself.
            if (decoded.value.interrupt != null) contractReasons.push('interrupt_unavailable');
            const scriptCheck = checkTavernBeatScript(decoded.value, modelInput.script, check.quotations ?? []);
            if (!scriptCheck.ok) contractReasons.push(scriptCheck.reason);
            const presenceReason = this.#beatPresence(world, decoded.value, invalid, invalidEffects);
            if (presenceReason != null) contractReasons.push(presenceReason);
          }
          retryReasons = !decoded.ok ? [decoded.reason] : [...new Set([
            ...contractReasons,
            ...(check?.kind === 'retry' ? [check.reason] : []),
            ...invalid.map(action => action.reason),
            ...invalidEffects.map(effect => effect.reason),
          ])];
          if (retryReasons.length > 0 && lease.attempt === 0) {
            const retried = turn.budget.retryBeat(lease);
            if (retried == null) throw new StopTurn('beat_deadline');
            lease = retried;
            continue;
          }
          if (!decoded.ok || check == null || check.kind === 'retry' || contractReasons.length > 0) {
            throw new StopTurn('invalid_beat');
          }
          if (!turn.budget.finishBeat(lease, 'success')) throw new StopTurn('beat_deadline');

          const rejected = new Set(invalid.map(action => action.itemRef));
          const rejectedEffects = new Set(invalidEffects.map(effect => effect.effectIndex));
          // The checker supplied the full closure. Drop only those links; original item/effect indices survive.
          const beat = {
            ...decoded.value,
            ...(decoded.value.intent == null && intent != null ? { intent: structuredClone(intent) } : {}),
            effects: decoded.value.effects.filter(effect => !rejectedEffects.has(effect.effectIndex)),
          };
          const selection = {
            beat,
            emittedItemRefs: beat.items.filter(item => !rejected.has(item.itemIndex)).map(item => item.itemIndex),
          };
          for (const action of invalid) {
            const item = beat.items.find(entry => entry.itemIndex === action.itemRef)!;
            diagnostics.push({
              kind: 'Unknown',
              actorId: beat.actorId,
              text: item.text,
              itemRef: item.itemIndex,
              reason: action.reason,
              source: { envelope: structuredClone(beat.envelope), origin: structuredClone(beat.origin) },
            });
          }
          for (const invalidEffect of invalidEffects) {
            const link = decoded.value.effects.find(effect => effect.effectIndex === invalidEffect.effectIndex)!;
            const item = beat.items.find(entry => entry.itemIndex === link.itemRef)!;
            diagnostics.push({
              kind: 'Unknown',
              actorId: beat.actorId,
              text: item.text,
              itemRef: item.itemIndex,
              effectIndex: link.effectIndex,
              effect: structuredClone(link),
              reason: invalidEffect.reason,
              source: { envelope: structuredClone(beat.envelope), origin: structuredClone(beat.origin) },
            });
          }
          const nextWorld = projectTavernWorld(world, [{ kind: 'emitted', selection }]).world;
          // The bound is per turn, not per chat. Invalid candidates never consume persistent turn capacity.
          const serializedTurnUnits = JSON.stringify({
            beats: [...selections, selection],
            unknownDiagnostics: diagnostics,
          }).length;
          if (serializedTurnUnits > MAX_TAVERN_TURN_UNITS) throw new StopTurn('invalid_beat');
          if (!perception.acknowledgeDispatch(delivery.receipt)) throw new StopTurn('invalid_packet');
          prepared.perception.steps = [...prepared.perception.steps, { kind: 'emitted', selection }];
          prepared.perception.permissions = [...prepared.perception.permissions, ...check.permissions];
          perception.replaceSources(prepared.perception);
          world = nextWorld;
          selections.push(selection);
          if (beat.intent != null) intents.set(decision.actorId, structuredClone(beat.intent));
          completedActors.add(decision.actorId);
          const emitted = beat.items.filter(item => !rejected.has(item.itemIndex));
          dispatch.hasSpoken = emitted.some(item => item.kind === 'speech');
          dispatch.hasActed = emitted.some(item => item.kind === 'action');
          dispatch.addressedActorIds = [...new Set(emitted.flatMap(item => item.addressees))];
          completed = true;
        }
      } catch (error) {
        turn.budget.finishBeat(lease, 'cancelled');
        if (!(error instanceof StopTurn) || error.reason !== 'beat_deadline') throw error;
        turn.summary.closeReason = 'beat_deadline';
        break;
      }
      move(turn, 'Schedule');
    }

    move(turn, 'Close');
    this.#check(turn);
    const packet = perception.playerView();
    move(turn, 'Render');
    let body = await this.#wait(
      turn,
      turn.budget.snapshot().turnHardDeadlineMs,
      'turn_deadline',
      true,
      signal => this.#ports.render({
        identity: structuredClone(turn.identity),
        packet: structuredClone(packet),
        signal,
      }),
    );
    move(turn, 'VerifyRender');
    this.#check(turn);
    let renderer: 'A' | 'B' = 'B';
    const verified = typeof body === 'string' && this.#ports.verifyRender({
      packet: structuredClone(packet), body, renderer,
    }) === true;
    this.#check(turn);
    if (!verified) {
      turn.summary.renderFailures++;
      renderer = 'A';
      body = this.#ports.renderA(structuredClone(packet));
      this.#check(turn);
      if (typeof body !== 'string' || this.#ports.verifyRender({
        packet: structuredClone(packet), body, renderer,
      }) !== true) throw new StopTurn('invalid_render');
    }

    move(turn, 'Commit');
    const input: TavernEngineCommitInput = {
      scope: turn.identity.scope,
      ticketId: turn.identity.ticketId,
      turnId: turn.identity.turnId,
      turnRevision: turn.identity.turnRevision,
      expectedVersion: turn.version,
      assistantSource: turn.identity.assistantSource,
      playerSource: turn.identity.playerSource,
      beats: selections,
      unknownDiagnostics: diagnostics,
      display: { body, renderer, fallback: renderer === 'A' },
    };
    // The contract ceiling was checked before rendering; host display prose has its own host-owned budget.
    // Resolve getters and detach arguments before the final guards; neither may run external work afterwards.
    const ledger = this.#ports.ledger;
    const commitNpc = ledger.commitNpc.bind(ledger);
    const commitInput = structuredClone(input);
    this.#check(turn);
    try {
      return checkedReceipt(commitNpc(commitInput), turn.identity, body);
    } catch (error) {
      // Recover only a durable receipt for this exact acceptance; never retry the write or regenerate prose.
      const recovered = this.#ports.ledger.findReceipt(structuredClone(turn.identity));
      if (recovered == null) throw error;
      return checkedReceipt(recovered, turn.identity, body);
    }
  }

  #checkedIntent(
    raw: unknown,
    turn: ActiveTurn,
    prepared: TavernPreparedTurn,
    world: TavernWorldSnapshot,
    actorId: string,
    reason: 'invalid_preparation' | 'invalid_beat',
  ): NonNullable<DecodedBeat['intent']> {
    const intent = this.#decodeIntent(raw, turn, prepared, world, actorId);
    if (intent == null) throw new StopTurn(reason);

    return intent;
  }

  #decodeIntent(
    raw: unknown,
    turn: ActiveTurn,
    prepared: TavernPreparedTurn,
    world: TavernWorldSnapshot,
    actorId: string,
  ): NonNullable<DecodedBeat['intent']> | undefined {
    // Inspect descriptors outside the codec's value-failure boundary: caller accessors must still abort.
    // Like the codec, do not invoke getters. Proxy descriptor failures propagate to the engine unchanged.
    if (raw != null && typeof raw === 'object') {
      const descriptors = Object.getOwnPropertyDescriptors(raw);
      if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) {
        throw new StopTurn('invalid_beat');
      }
      // The codec reads this detached data snapshot, so caller descriptors are inspected only once.
      raw = Object.defineProperties({}, descriptors);
    }

    // Front and beat share the same goal/next bounds; no second parser or retry policy is introduced.
    const checked = decodeBeatCandidate({ items: [], intent: raw }, {
      envelope: { id: 'intent', turnId: turn.identity.turnId, beatIndex: 1, source: 'beat', status: 'tentative' },
      scope: turn.identity.scope,
      turnRevision: turn.identity.turnRevision,
      ruleVersion: prepared.ruleVersion,
      message: turn.request.message,
      actorId,
      entityIds: world.entityIds,
      itemIds: world.possessions.map(item => item.itemId),
      placeIds: world.placeIds,
      eventReferences: [],
      scheduledActorCount: 1,
    });
    return checked.ok ? checked.value.intent : undefined;
  }

  #scheduleActors(
    prepared: TavernPreparedTurn,
    perception: TavernPerception,
    dispatches: readonly TavernDispatch[],
    turnId: string,
  ): TavernActorSignals[] {
    const previousActorId = dispatches.at(-1)?.actorId;
    const served = new Set(dispatches.map(dispatch => dispatch.actorId));
    // Inboxes are actor-filtered and acknowledged only after a valid beat; retries consume nothing.
    // Work is O(inbox items + their addressee IDs + relation entries); no item text is parsed.
    return prepared.actors.map(signal => {
      const inbox = perception.prepareDispatch(signal.actorId, turnId).input.inbox;
      // An action audience is not an unanswered utterance and must not gain speech priority.
      const addressed = inbox.some(({ content }) =>
        (content.kind === 'speech' || content.kind === 'NpcSpeech' || content.kind === 'PlayerUtterance')
        && content.addressees.includes(signal.actorId));
      const relation = signal.relations == null
        ? signal.relationToPrevious
        : signal.relations.find(entry => entry.targetId === previousActorId);
      return {
        ...signal,
        addressed: addressed || (!served.has(signal.actorId) && signal.addressed),
        // New mid-turn interrupts remain unavailable; consume an initial pending interruption on service.
        interrupted: !served.has(signal.actorId) && signal.interrupted,
        relationToPrevious: relation ?? null,
      };
    });
  }

  #unserved(turn: ActiveTurn, roster: TavernScheduleRoster): void {
    const served = new Set(turn.summary.dispatches.map(dispatch => dispatch.actorId));
    turn.summary.unservedRespondIds = roster.respondIds.filter(actorId => !served.has(actorId));
  }

  #invalidActions(
    beat: DecodedBeat,
    check: TavernBeatCheck,
    effects: readonly TavernInvalidEffect[],
  ): TavernInvalidAction[] {
    if (check.kind !== 'valid' && check.kind !== 'retry' && check.kind !== 'invalid_actions') {
      if (check.kind !== 'invalid_effects') throw new StopTurn('invalid_beat');
    }
    if (check.kind === 'retry') requireId(check.reason);
    const invalid = new Map<number, TavernInvalidAction>();
    const actions = check.kind === 'invalid_actions'
      ? check.actions
      : check.kind === 'invalid_effects' ? check.actions ?? [] : [];
    for (const action of actions) {
      requireId(action.reason);
      const item = beat.items.find(entry => entry.itemIndex === action.itemRef);
      if (item?.kind !== 'action' || invalid.has(action.itemRef)) throw new StopTurn('invalid_beat');
      invalid.set(action.itemRef, action);
    }
    // A failed hard effect cannot leave its associated action looking successful.
    for (const effect of effects) {
      const link = beat.effects.find(entry => entry.effectIndex === effect.effectIndex)!;
      const item = beat.items.find(entry => entry.itemIndex === link.itemRef);
      if (item?.kind === 'action' && !invalid.has(link.itemRef)) {
        invalid.set(link.itemRef, { itemRef: link.itemRef, reason: effect.reason });
      }
    }
    // An Unknown hard-effect candidate is never allowed to make its accompanying action appear successful.
    for (const link of beat.effects) {
      if (link.effect.kind !== 'Unknown') continue;
      const item = beat.items.find(entry => entry.itemIndex === link.itemRef);
      if (item?.kind === 'action' && !invalid.has(link.itemRef)) {
        invalid.set(link.itemRef, { itemRef: link.itemRef, reason: link.effect.reason });
      }
    }
    if (check.kind === 'invalid_actions' && invalid.size === 0) throw new StopTurn('invalid_beat');
    return [...invalid.values()];
  }

  #invalidEffects(beat: DecodedBeat, check: TavernBeatCheck, m2Contract: boolean): TavernInvalidEffect[] {
    const invalid = new Map<number, TavernInvalidEffect>();
    for (const effect of check.kind === 'invalid_effects' ? check.effects : []) {
      requireId(effect.reason);
      const link = beat.effects.find(entry => entry.effectIndex === effect.effectIndex);
      if (!link || invalid.has(effect.effectIndex)) throw new StopTurn('invalid_beat');
      invalid.set(effect.effectIndex, effect);
    }
    if (check.kind === 'invalid_effects' && invalid.size === 0) throw new StopTurn('invalid_beat');
    // A custom port without M2 preparation retains responsibility for its own complete validation policy.
    if (!m2Contract) return [...invalid.values()];
    // Unknown on speech rejects only the effect. The words remain a statement, never proof of fulfillment.
    for (const link of beat.effects) {
      if (link.effect.kind !== 'Unknown') continue;
      const item = beat.items.find(entry => entry.itemIndex === link.itemRef);
      if (item?.kind === 'speech' && !invalid.has(link.effectIndex)) {
        invalid.set(link.effectIndex, { effectIndex: link.effectIndex, reason: link.effect.reason });
      }
    }
    return [...invalid.values()];
  }

  #beatPresence(
    world: TavernWorldSnapshot,
    beat: DecodedBeat,
    actions: readonly TavernInvalidAction[],
    effects: readonly TavernInvalidEffect[],
  ): string | null {
    const rejectedItems = new Set(actions.map(action => action.itemRef));
    const rejectedEffects = new Set(effects.map(effect => effect.effectIndex));
    const selection = {
      beat: { ...beat, effects: beat.effects.filter(effect => !rejectedEffects.has(effect.effectIndex)) },
      emittedItemRefs: beat.items.filter(item => !rejectedItems.has(item.itemIndex)).map(item => item.itemIndex),
    };
    try {
      // All folds stay local until the existing publication step. The port still owns effect dependency closure.
      const projected = projectTavernWorld(world, [{ kind: 'emitted', selection }]);
      for (const phase of projected.phases) {
        if (phase.phase !== 'item') continue;
        const item = beat.items.find(entry => entry.itemIndex === phase.itemRef)!;
        const present = new Set(phase.presentIds);
        if (!phase.presenceKnown || !present.has(item.actorId)
          || !item.addressees.every(actorId => present.has(actorId))) return 'invalid_presence';
      }

      return null;
    } catch {
      // A checker that omitted a failed prerequisite cannot publish even a partly valid overlay.
      return 'effect_precondition';
    }
  }
}
