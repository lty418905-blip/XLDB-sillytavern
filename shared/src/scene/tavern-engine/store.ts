import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { scopeKey } from '../../core/types.ts';
import { readStoreFormat, stampStoreFormat } from '../../core/store-format.ts';
import type { Scope } from '../../memory/access.ts';
import { projectBeatItems } from './codec.ts';
import type {
  TavernAcceptedPlayerInterpretation,
  TavernEngineCommitInput,
  TavernEngineLedgerPort,
  TavernEnginePlayerInput,
  TavernInterpretationMetadata,
  TavernTurnIdentity,
  TavernUnknownActionDiagnostic,
  TavernUnknownEffectDiagnostic,
} from './engine.ts';
import type { DecodedBeat, EngineEvent, EngineEventEnvelope, EventOrigin } from './types.ts';

/** Caller-selected positive store format and nonempty writer identity; no production format is allocated here. */
export interface TavernStoreFormat {
  format: number;
  writerVersion: string;
}

/** Source address within a scene; revisions are positive safe integers, independent of turn revisions. */
export interface TavernSourceReference {
  id: string;
  revision: number;
}

/** Already decoded, locally validated player events; the referenced user source must already be accepted. */
export interface PlayerInterpretationInput {
  scope: Scope;
  turnId: string;
  turnRevision: number;
  source: TavernSourceReference;
  expectedVersion: number;
  events: readonly EngineEvent[];
  interpretation?: TavernInterpretationMetadata | null;
}

/** A validated beat and its actually emitted original item indices; omitted items and effects are discarded. */
export interface EmittedTavernBeat {
  beat: DecodedBeat;
  emittedItemRefs: readonly number[];
}

/** Host-owned pending acceptance identity; beats refer to the accepted player source, not the display body. */
export interface NpcTurnInput {
  scope: Scope;
  ticketId: string;
  turnId: string;
  turnRevision: number;
  expectedVersion: number;
  assistantSource: TavernSourceReference;
  beats: readonly EmittedTavernBeat[];
}

/** Detached, in-memory ticket; all retained beats remain tentative until the enclosing transaction commits. */
export interface TavernTurnTicket {
  scope: Scope;
  ticketId: string;
  turnId: string;
  turnRevision: number;
  expectedVersion: number;
  playerSource: TavernSourceReference;
  assistantSource: TavernSourceReference;
  beats: readonly DecodedBeat[];
}

/** Accepted ledger entry; version is the scene authority revision, not a schema or source revision. */
export type AcceptedTavernTurn = {
  scope: Scope;
  turnId: string;
  turnRevision: number;
  source: TavernSourceReference;
  version: number;
} & (
  | { kind: 'interpret'; events: readonly EngineEvent[]; interpretation?: TavernInterpretationMetadata }
  | ({ kind: 'npc'; beats: readonly DecodedBeat[] } & Partial<TavernNpcAcceptance>)
);

/**
 * Accepted, non-executable Unknown record. The envelope is ledger-owned; source retains the tentative origin.
 * Original zero-based item/effect indices and rejected links are audit data, never projected world effects.
 */
export type AcceptedTavernUnknownDiagnostic = (TavernUnknownActionDiagnostic | TavernUnknownEffectDiagnostic) & {
  envelope: EngineEventEnvelope;
  origin: EventOrigin;
};

interface TavernNpcAcceptance {
  playerSource: TavernSourceReference;
  inputHash: string;
  display: TavernEngineCommitInput['display'];
  unknownDiagnostics: readonly AcceptedTavernUnknownDiagnostic[];
}

/** Durable result; acceptedAtMs is Unix ms, bodyHash is SHA-256 of the JSON-quoted display string in UTF-8. */
export interface TavernCommitReceipt {
  scope: Scope;
  ticketId: string;
  turnId: string;
  turnRevision: number;
  source: TavernSourceReference;
  version: number;
  acceptedAtMs: number;
  bodyHash: string;
  status: 'accepted';
}

function identifier(value: string): void {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('invalid_tavern_identity');
}

function integer(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError('invalid_tavern_integer');
}

function checkedScope(scope: Scope): string {
  identifier(scope.worldId);
  identifier(scope.sessionId);
  identifier(scope.branchId);
  identifier(scope.characterId);
  return scopeKey(scope);
}

function sourceReference(source: TavernSourceReference): void {
  identifier(source.id);
  integer(source.revision, 1);
}

function turnAddress(scope: Scope, turnId: string, turnRevision: number): string {
  const key = checkedScope(scope);
  identifier(turnId);
  integer(turnRevision, 1);
  return key;
}

function bodyHash(body: string): string {
  // JSON preserves lone UTF-16 surrogates that UTF-8 replacement would otherwise collapse to the same hash.
  // Native quoting, encoding and hashing are O(body length); no history or prefix is rescanned.
  return createHash('sha256').update(JSON.stringify(body), 'utf8').digest('hex');
}

function inTransaction<Value>(database: DatabaseSync, action: () => Value): Value {
  const outer = !database.isTransaction;
  database.exec(outer ? 'BEGIN IMMEDIATE' : 'SAVEPOINT tavern_ledger_write');

  try {
    const result = action();
    database.exec(outer ? 'COMMIT' : 'RELEASE tavern_ledger_write');
    return result;
  } catch (error) {
    database.exec(outer ? 'ROLLBACK' : 'ROLLBACK TO tavern_ledger_write');
    if (!outer) database.exec('RELEASE tavern_ledger_write');
    throw error;
  }
}

function checkEvent(
  event: Pick<EngineEvent, 'envelope' | 'origin'>,
  scope: Scope,
  turnId: string,
  turnRevision: number,
  source: TavernSourceReference,
  kind: 'interpret' | 'beat',
): void {
  identifier(event.envelope.id);
  identifier(event.origin.ruleVersion);
  integer(event.envelope.beatIndex, kind === 'interpret' ? 0 : 1);

  if (checkedScope(event.origin.scope) !== checkedScope(scope)
    || event.envelope.turnId !== turnId
    || event.origin.turnRevision !== turnRevision
    || event.origin.sourceId !== source.id
    || event.origin.sourceRevision !== source.revision
    || event.envelope.source !== kind
    || event.envelope.status !== 'tentative'
    || (kind === 'interpret' && event.envelope.beatIndex !== 0)) {
    throw new Error('tavern_event_mismatch');
  }
}

function sameSource(left: TavernSourceReference, right: TavernSourceReference): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function checkInterpretation(input: PlayerInterpretationInput): void {
  const metadata = input.interpretation;

  if (metadata == null) throw new Error('tavern_interpretation_metadata_missing');
  sourceReference(metadata.source);
  integer(metadata.turnRevision, 1);

  if (!sameSource(metadata.source, input.source) || metadata.turnRevision !== input.turnRevision
    || (metadata.outcome !== 'success' && metadata.outcome !== 'fallback')
    || (metadata.outcome === 'fallback' && input.events.length !== 0)) {
    throw new Error('tavern_interpretation_metadata_mismatch');
  }
}

function checkedIdentity(identity: TavernTurnIdentity): string {
  const key = turnAddress(identity.scope, identity.turnId, identity.turnRevision);
  identifier(identity.ticketId);
  sourceReference(identity.playerSource);
  sourceReference(identity.assistantSource);
  return key;
}

function npcInputHash(input: TavernEngineCommitInput): string {
  // Scope is the SQL primary-key namespace. Normalize only the already-checked scope fields so a fork
  // can retry the same accepted request in its destination scope without retaining a second executable copy.
  // Native serialization/hash and these array passes are O(input bytes + items + effects + diagnostics).
  const { scope: _scope, ...address } = input;
  const relativeOrigin = ({ scope: _originScope, ...origin }: EventOrigin) => origin;
  const relative = {
    ...address,
    beats: input.beats.map(selection => ({
      ...selection,
      beat: { ...selection.beat, origin: relativeOrigin(selection.beat.origin) },
    })),
    unknownDiagnostics: input.unknownDiagnostics.map(diagnostic => ({
      ...diagnostic,
      source: { ...diagnostic.source, origin: relativeOrigin(diagnostic.source.origin) },
    })),
  };
  return createHash('sha256').update(JSON.stringify(relative), 'utf8').digest('hex');
}

/**
 * Inert data operations on the caller's scene database; construction and module import perform no SQL.
 * Inputs are trusted decoder/validator outputs, never raw model candidates. SQLite and getter errors propagate.
 * Writes use one transaction or a savepoint inside the caller's transaction; outer rollback remains authoritative.
 */
export class TavernLedgerStore implements TavernEngineLedgerPort {
  private readonly database: DatabaseSync;
  private readonly format: TavernStoreFormat;
  private readonly now: () => number;
  private readonly tickets = new Map<string, TavernTurnTicket>();

  constructor(database: DatabaseSync, format: TavernStoreFormat, now?: (() => number) | null) {
    const copied = structuredClone(format);
    integer(copied.format, 1);
    identifier(copied.writerVersion);
    this.database = database;
    this.format = copied;
    if (now != null && typeof now !== 'function') throw new TypeError('invalid_tavern_clock');
    this.now = now ?? Date.now;
  }

  /** Explicit schema setup on an existing scene database; no format stamp, source or scene is created. */
  initialize(): void {
    inTransaction(this.database, () => {
      this.database.exec(`CREATE TABLE IF NOT EXISTS scene_tavern_turns (
        scope TEXT NOT NULL REFERENCES scene_worlds(key),
        turn_id TEXT NOT NULL,
        turn_revision INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('interpret','npc')),
        body TEXT NOT NULL,
        PRIMARY KEY(scope,turn_id,turn_revision,kind))`);
      this.database.exec(`CREATE TABLE IF NOT EXISTS scene_tavern_receipts (
        scope TEXT NOT NULL REFERENCES scene_worlds(key),
        ticket_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        receipt TEXT NOT NULL,
        PRIMARY KEY(scope,ticket_id))`);
    });
  }

  /**
   * Checks the exact authority version and accepted user revision without creating ledger tables.
   * Missing/stale authority returns false; invalid identity, malformed stored JSON and SQL errors throw.
   */
  isCurrent(identity: TavernTurnIdentity, expectedVersion: number): boolean {
    const copied = structuredClone(identity);
    const key = checkedIdentity(copied);
    integer(expectedVersion, 0);
    const row = this.database.prepare('SELECT version FROM scene_worlds WHERE key=?').get(key) as
      { version: number } | undefined;
    return row?.version === expectedVersion && this.sourceIsCurrent(key, copied.playerSource, 'user');
  }

  /**
   * Reads the exact player source/turn revision, or null when absent or no longer current. No SQL writes occur.
   * Legacy rows stay readable via readTurn, but absent metadata throws here: never infer an outcome or rerun M1.
   */
  readPlayer(identity: TavernTurnIdentity): TavernAcceptedPlayerInterpretation | null {
    const copied = structuredClone(identity);
    const key = checkedIdentity(copied);

    if (!this.sourceIsCurrent(key, copied.playerSource, 'user')) return null;
    const entry = this.readTurn(copied.scope, copied.turnId, copied.turnRevision, 'interpret');

    if (!entry || entry.kind !== 'interpret' || !sameSource(entry.source, copied.playerSource)) return null;
    checkInterpretation({ ...entry, expectedVersion: entry.version });
    return entry as TavernAcceptedPlayerInterpretation;
  }

  /**
   * Accepts M1 events and required metadata in one transaction. Fallback is an explicit exhausted-M1 outcome,
   * not inferred from event count; success may be empty. Exact retries do not write; conflicting metadata throws.
   */
  acceptPlayer(input: TavernEnginePlayerInput): TavernAcceptedPlayerInterpretation {
    const copied = structuredClone(input);
    checkInterpretation(copied);
    return this.acceptPlayerInterpretation(copied) as TavernAcceptedPlayerInterpretation;
  }

  /**
   * Accepts emitted beats, non-executable diagnostics, display and receipt in the caller's SQLite transaction.
   * The ticket binds the complete request, including expectedVersion. Exact retries survive reopen and fork.
   * The injected clock supplies Unix milliseconds only for a new acceptance; clock/SQL failures roll back.
   */
  commitNpc(input: TavernEngineCommitInput): TavernCommitReceipt {
    const copied = structuredClone(input);
    const key = checkedIdentity(copied);
    integer(copied.expectedVersion, 0);

    if (typeof copied.display.body !== 'string'
      || (copied.display.renderer !== 'A' && copied.display.renderer !== 'B')
      || typeof copied.display.fallback !== 'boolean') {
      throw new TypeError('invalid_tavern_display');
    }

    return inTransaction(this.database, () => {
      const player = this.readPlayer(copied);
      if (!player) throw new Error('tavern_interpretation_missing');
      const details = this.npcAcceptance(copied, player);
      const previous = this.readReceipt(copied.scope, copied.ticketId);

      if (previous) {
        const receipt = this.findReceipt(copied);
        const turn = this.readTurn(copied.scope, copied.turnId, copied.turnRevision, 'npc');

        if (!receipt || turn?.kind !== 'npc' || turn.inputHash !== details.inputHash) {
          throw new Error('tavern_ticket_conflict');
        }
        return receipt;
      }

      this.requireVersion(key, copied.expectedVersion);
      const ticket = this.projectNpcTurn(copied);
      const acceptedAtMs = this.now();
      integer(acceptedAtMs, 0);
      // An injected clock can execute caller code. Recheck authority after it and before writing any NPC data.
      this.requireVersion(key, copied.expectedVersion);
      this.requirePlayerSource(key, copied.playerSource);
      return this.acceptNpcTicket(ticket, copied.display.body, acceptedAtMs, details);
    });
  }

  /**
   * Returns a durable receipt only for the full requested turn/ticket and both current source revisions.
   * Missing, obsolete or legacy unbound records return null. SQL/JSON and malformed-identity errors throw.
   */
  findReceipt(identity: TavernTurnIdentity): TavernCommitReceipt | null {
    const copied = structuredClone(identity);
    const key = checkedIdentity(copied);
    const receipt = this.readReceipt(copied.scope, copied.ticketId);

    if (!receipt || receipt.turnId !== copied.turnId || receipt.turnRevision !== copied.turnRevision
      || !sameSource(receipt.source, copied.assistantSource)
      || !this.sourceIsCurrent(key, copied.playerSource, 'user')
      || !this.sourceIsCurrent(key, copied.assistantSource, 'assistant')) {
      return null;
    }

    const turn = this.readTurn(copied.scope, copied.turnId, copied.turnRevision, 'npc');
    if (turn?.kind !== 'npc' || !turn.playerSource || !sameSource(turn.playerSource, copied.playerSource)
      || !sameSource(turn.source, copied.assistantSource)) {
      return null;
    }
    return receipt;
  }

  /**
   * Accepts a player's interpretation independently of NPC generation. Empty interpretations are permitted.
   * Exact replay returns the original entry without writes; changed content, stale sources or versions throw.
   * Work is O(input bytes + events), plus indexed lookups, independent of the number of prior chat sources.
   */
  acceptPlayerInterpretation(input: PlayerInterpretationInput): AcceptedTavernTurn {
    const copied = structuredClone(input);
    const key = turnAddress(copied.scope, copied.turnId, copied.turnRevision);
    sourceReference(copied.source);
    integer(copied.expectedVersion, 0);
    if (copied.interpretation != null) checkInterpretation(copied);
    const eventIds = new Set<string>();

    for (const event of copied.events) {
      checkEvent(event, copied.scope, copied.turnId, copied.turnRevision, copied.source, 'interpret');
      if (eventIds.has(event.envelope.id)) throw new Error('tavern_duplicate_event');
      eventIds.add(event.envelope.id);
      event.envelope.status = 'accepted';
    }

    return inTransaction(this.database, () => {
      this.requirePlayerSource(key, copied.source);
      const previous = this.readTurn(copied.scope, copied.turnId, copied.turnRevision, 'interpret');
      if (previous) {
        if (previous.kind !== 'interpret'
          || JSON.stringify(previous.source) !== JSON.stringify(copied.source)
          || JSON.stringify(previous.events) !== JSON.stringify(copied.events)
          || JSON.stringify(previous.interpretation ?? null) !== JSON.stringify(copied.interpretation ?? null)) {
          throw new Error('tavern_interpretation_conflict');
        }
        return previous;
      }

      this.requireVersion(key, copied.expectedVersion);
      if (!this.hasTable('scene_tavern_turns')) this.initialize();
      this.stampFormat();
      const entry: AcceptedTavernTurn = {
        scope: copied.scope,
        turnId: copied.turnId,
        turnRevision: copied.turnRevision,
        source: copied.source,
        version: copied.expectedVersion + 1,
        kind: 'interpret',
        events: copied.events,
        ...(copied.interpretation == null ? {} : { interpretation: copied.interpretation }),
      };
      this.insertTurn(key, entry);
      this.bumpVersion(key, copied.expectedVersion);
      return entry;
    });
  }

  /**
   * Replaces the scope's active ticket with an immutable snapshot of emitted items only, without database writes.
   * No rendering or permission validation is performed here. Invalid provenance, indices or stale state throw.
   * Projection is O(input bytes + items + effects); original item/effect indices and phase order are preserved.
   */
  prepareNpcTurn(input: NpcTurnInput): TavernTurnTicket {
    const ticket = this.projectNpcTurn(input);
    const key = checkedScope(ticket.scope);
    const previous = this.tickets.get(key);

    if (previous?.ticketId === ticket.ticketId && JSON.stringify(previous) !== JSON.stringify(ticket)) {
      throw new Error('tavern_ticket_conflict');
    }
    this.tickets.set(key, ticket);
    return structuredClone(ticket);
  }

  /** Projects a detached ticket without retaining it; failed port transactions leave no in-memory candidates. */
  private projectNpcTurn(input: NpcTurnInput): TavernTurnTicket {
    const copied = structuredClone(input);
    const key = turnAddress(copied.scope, copied.turnId, copied.turnRevision);
    identifier(copied.ticketId);
    sourceReference(copied.assistantSource);
    integer(copied.expectedVersion, 0);
    this.requireVersion(key, copied.expectedVersion);
    const player = this.readTurn(copied.scope, copied.turnId, copied.turnRevision, 'interpret');
    if (!player) throw new Error('tavern_interpretation_missing');
    this.requirePlayerSource(key, player.source);
    if (this.readReceipt(copied.scope, copied.ticketId)) throw new Error('tavern_ticket_accepted');
    const beats: DecodedBeat[] = [];
    const eventIds = new Set<string>();
    let previousBeatIndex = 0;

    for (const selection of copied.beats) {
      const beat = selection.beat;
      checkEvent(beat, copied.scope, copied.turnId, copied.turnRevision, player.source, 'beat');
      if (beat.envelope.beatIndex <= previousBeatIndex || eventIds.has(beat.envelope.id)) {
        throw new Error('tavern_beat_order');
      }
      previousBeatIndex = beat.envelope.beatIndex;
      eventIds.add(beat.envelope.id);
      const projected = projectBeatItems(beat, selection.emittedItemRefs);
      if (!projected.ok) throw new Error(projected.reason);
      // Keep empty beats as dispatch records, but never preserve an unissued item or its effects.
      const retained = new Set(projected.value.map(entry => entry.item.itemIndex));
      beat.items = projected.value.map(entry => entry.item);
      beat.effects = beat.effects.filter(effect => retained.has(effect.itemRef));
      beats.push(beat);
    }

    const ticket: TavernTurnTicket = {
      scope: copied.scope,
      ticketId: copied.ticketId,
      turnId: copied.turnId,
      turnRevision: copied.turnRevision,
      expectedVersion: copied.expectedVersion,
      playerSource: player.source,
      assistantSource: copied.assistantSource,
      beats,
    };
    return ticket;
  }

  /** Returns a detached tentative ticket only in its exact scope; accepted, replaced or absent tickets are undefined. */
  readTicket(scope: Scope, ticketId: string): TavernTurnTicket | undefined {
    const copiedScope = structuredClone(scope);
    const key = checkedScope(copiedScope);
    identifier(ticketId);
    const ticket = this.tickets.get(key);
    if (!ticket || ticket.ticketId !== ticketId || this.readReceipt(copiedScope, ticketId)) return undefined;
    return structuredClone(ticket);
  }

  /**
   * Atomically accepts a caller-verified display body, source stub, emitted ledger and receipt, then bumps version.
   * Exact ticket/body retry returns the durable receipt, including after restart; a different body always throws.
   * This is a storage boundary, not a renderer verifier or a production source adapter. The outer transaction,
   * when present, must commit before callers publish the returned accepted receipt. Timestamps are Unix ms >= 0.
   */
  commitNpcTurn(scope: Scope, ticketId: string, body: string, acceptedAtMs: number): TavernCommitReceipt {
    const copiedScope = structuredClone(scope);
    const key = checkedScope(copiedScope);
    identifier(ticketId);
    if (typeof body !== 'string') throw new TypeError('invalid_tavern_body');
    integer(acceptedAtMs, 0);
    const digest = bodyHash(body);

    return inTransaction(this.database, () => {
      const previous = this.readReceipt(copiedScope, ticketId);
      if (previous) {
        if (previous.bodyHash !== digest) throw new Error('tavern_body_conflict');
        return previous;
      }

      const ticket = this.readTicket(copiedScope, ticketId);
      if (!ticket) throw new Error('tavern_ticket_missing');
      this.requireVersion(key, ticket.expectedVersion);
      this.requirePlayerSource(key, ticket.playerSource);
      const player = this.readTurn(copiedScope, ticket.turnId, ticket.turnRevision, 'interpret');
      if (!player || player.source.id !== ticket.playerSource.id
        || player.source.revision !== ticket.playerSource.revision) {
        throw new Error('tavern_interpretation_missing');
      }

      return this.acceptNpcTicket(ticket, body, acceptedAtMs);
    });
  }

  /** Reads one accepted revision/phase via its full primary key; absence returns undefined and SQL errors propagate. */
  readTurn(
    scope: Scope,
    turnId: string,
    turnRevision: number,
    kind: 'interpret' | 'npc',
  ): AcceptedTavernTurn | undefined {
    const key = turnAddress(structuredClone(scope), turnId, turnRevision);
    if (kind !== 'interpret' && kind !== 'npc') throw new TypeError('invalid_tavern_turn_kind');
    if (!this.hasTable('scene_tavern_turns')) return undefined;
    const row = this.database.prepare(`SELECT body FROM scene_tavern_turns
      WHERE scope=? AND turn_id=? AND turn_revision=? AND kind=?`).get(key, turnId, turnRevision, kind) as
      { body: string } | undefined;
    return row ? JSON.parse(row.body) as AcceptedTavernTurn : undefined;
  }

  /** Reads one committed receipt in its exact scope; no ticket or body from another scope can be returned. */
  readReceipt(scope: Scope, ticketId: string): TavernCommitReceipt | undefined {
    const key = checkedScope(structuredClone(scope));
    identifier(ticketId);
    if (!this.hasTable('scene_tavern_receipts')) return undefined;
    const row = this.database.prepare(`SELECT receipt FROM scene_tavern_receipts
      WHERE scope=? AND ticket_id=?`).get(key, ticketId) as { receipt: string } | undefined;
    return row ? JSON.parse(row.receipt) as TavernCommitReceipt : undefined;
  }

  private hasTable(name: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  }

  private npcAcceptance(
    input: TavernEngineCommitInput,
    player: TavernAcceptedPlayerInterpretation,
  ): TavernNpcAcceptance {
    const beats = new Map(input.beats.map(selection => {
      const beat = selection.beat;
      checkEvent(beat, input.scope, input.turnId, input.turnRevision, input.playerSource, 'beat');
      return [beat.envelope.id, {
        beat,
        items: new Map(beat.items.map(item => [item.itemIndex, item])),
        emitted: new Set(selection.emittedItemRefs),
        effects: new Set(beat.effects.map(link => link.effectIndex)),
      }];
    }));
    const eventIds = new Set([
      ...player.events.map(event => event.envelope.id),
      ...beats.keys(),
    ]);
    const unknownDiagnostics: AcceptedTavernUnknownDiagnostic[] = [];

    for (const [index, diagnostic] of input.unknownDiagnostics.entries()) {
      checkEvent(diagnostic.source, input.scope, input.turnId, input.turnRevision, input.playerSource, 'beat');
      identifier(diagnostic.actorId);
      identifier(diagnostic.reason);
      integer(diagnostic.itemRef, 0);
      const selected = beats.get(diagnostic.source.envelope.id);
      const item = selected?.items.get(diagnostic.itemRef);

      if (diagnostic.kind !== 'Unknown' || !selected || !item
        || diagnostic.text !== item.text || diagnostic.actorId !== selected.beat.actorId
        || diagnostic.source.envelope.beatIndex !== selected.beat.envelope.beatIndex
        || diagnostic.source.origin.ruleVersion !== selected.beat.origin.ruleVersion) {
        throw new Error('tavern_diagnostic_mismatch');
      }

      if ('effectIndex' in diagnostic) {
        integer(diagnostic.effectIndex, 0);
        const link = diagnostic.effect;
        if (link.effectIndex !== diagnostic.effectIndex || link.itemRef !== diagnostic.itemRef
          || selected.effects.has(diagnostic.effectIndex)) {
          throw new Error('tavern_diagnostic_effect_retained');
        }
      } else if (selected.emitted.has(diagnostic.itemRef)) {
        throw new Error('tavern_diagnostic_action_retained');
      }

      // Array position distinguishes multiple rejections of the same beat/item. The content-addressed base
      // is stable across retries/reopen/fork; suffixing also avoids caller-chosen beat/player event IDs.
      const address = [input.turnId, input.turnRevision, input.ticketId, diagnostic.source.envelope.id, index];
      const base = `unknown:${createHash('sha256').update(JSON.stringify(address), 'utf8').digest('hex')}`;
      let id = base;
      let suffix = 0;
      while (eventIds.has(id)) id = `${base}:${++suffix}`;
      eventIds.add(id);
      unknownDiagnostics.push({
        ...diagnostic,
        envelope: {
          id,
          turnId: input.turnId,
          beatIndex: diagnostic.source.envelope.beatIndex,
          source: 'engine',
          status: 'accepted',
        },
        origin: structuredClone(diagnostic.source.origin),
      });
    }

    return {
      playerSource: input.playerSource,
      inputHash: npcInputHash(input),
      display: input.display,
      unknownDiagnostics,
    };
  }

  private acceptNpcTicket(
    ticket: TavernTurnTicket,
    body: string,
    acceptedAtMs: number,
    details?: TavernNpcAcceptance,
  ): TavernCommitReceipt {
    const key = checkedScope(ticket.scope);
    const digest = bodyHash(body);
    this.stampFormat();
    const message = {
      id: ticket.assistantSource.id,
      revision: ticket.assistantSource.revision,
      role: 'assistant',
      text: body,
      acceptedAtMs,
    };
    // INSERT deliberately rejects an existing source; editing/replacing accepted turns belongs to lifecycle wiring.
    this.database.prepare(`INSERT INTO scene_sources
      (scope,id,revision,message,observed,status,processing,analysis)
      VALUES(?,?,?,?,?,'accepted','pending',NULL)`).run(
      key,
      message.id,
      message.revision,
      JSON.stringify(message),
      acceptedAtMs,
    );
    const beats = ticket.beats.map(beat => ({
      ...beat,
      envelope: { ...beat.envelope, status: 'accepted' as const },
    }));
    this.insertTurn(key, {
      scope: ticket.scope,
      turnId: ticket.turnId,
      turnRevision: ticket.turnRevision,
      source: ticket.assistantSource,
      version: ticket.expectedVersion + 1,
      kind: 'npc',
      beats,
      ...details,
    });
    const receipt: TavernCommitReceipt = {
      scope: ticket.scope,
      ticketId: ticket.ticketId,
      turnId: ticket.turnId,
      turnRevision: ticket.turnRevision,
      source: ticket.assistantSource,
      version: ticket.expectedVersion + 1,
      acceptedAtMs,
      bodyHash: digest,
      status: 'accepted',
    };
    this.database.prepare(`INSERT INTO scene_tavern_receipts(scope,ticket_id,body_hash,receipt)
      VALUES(?,?,?,?)`).run(key, ticket.ticketId, digest, JSON.stringify(receipt));
    this.bumpVersion(key, ticket.expectedVersion);
    // Keep the single scope ticket until replaced: a caller may still roll back its outer transaction.
    return receipt;
  }

  private requirePlayerSource(key: string, source: TavernSourceReference): void {
    if (!this.sourceIsCurrent(key, source, 'user')) throw new Error('tavern_player_source_changed');
  }

  private sourceIsCurrent(key: string, source: TavernSourceReference, role: 'user' | 'assistant'): boolean {
    const row = this.database.prepare(`SELECT revision,status,message FROM scene_sources
      WHERE scope=? AND id=?`).get(key, source.id) as
      { revision: number; status: string; message: string } | undefined;
    if (!row || row.revision !== source.revision || row.status !== 'accepted') {
      return false;
    }
    const message = JSON.parse(row.message);
    return message.id === source.id && message.revision === source.revision && message.role === role;
  }

  private requireVersion(key: string, expectedVersion: number): void {
    integer(expectedVersion, 0);
    // Incrementing a maximum safe integer would lose the authority's compare-and-swap identity.
    if (expectedVersion === Number.MAX_SAFE_INTEGER) throw new Error('tavern_version_exhausted');
    const row = this.database.prepare('SELECT version FROM scene_worlds WHERE key=?').get(key) as
      { version: number } | undefined;
    if (!row || row.version !== expectedVersion) throw new Error('tavern_version_changed');
  }

  private stampFormat(): void {
    if (readStoreFormat(this.database) > this.format.format) throw new Error('tavern_format_unsupported');
    stampStoreFormat(this.database, this.format.format, this.format.writerVersion);
  }

  private insertTurn(key: string, turn: AcceptedTavernTurn): void {
    this.database.prepare(`INSERT INTO scene_tavern_turns(scope,turn_id,turn_revision,kind,body)
      VALUES(?,?,?,?,?)`).run(key, turn.turnId, turn.turnRevision, turn.kind, JSON.stringify(turn));
  }

  private bumpVersion(key: string, expectedVersion: number): void {
    const result = this.database.prepare('UPDATE scene_worlds SET version=version+1 WHERE key=? AND version=?')
      .run(key, expectedVersion);
    if (result.changes !== 1) throw new Error('tavern_version_changed');
  }
}

/**
 * Captures only this scope's accepted ledger rows, including embedded private plans and durable receipts.
 * Returns undefined without creating tables when the scope has no rows. SQL errors propagate unchanged.
 * Work is O(rows + stored bytes); raw JSON is retained so capture does not normalize accepted history.
 * With includeReferencedEmptyScope, explicit memory event references retain an empty snapshot for erasure.
 * The eligibility probe returns only a scope flag, never source rows; unrelated ledger tables do not qualify.
 */
export function captureTavernEngineRows(
  database: DatabaseSync,
  scope: Scope,
  includeReferencedEmptyScope = false,
): {
  turns: { turn_id: string; turn_revision: number; kind: string; body: string }[];
  receipts: { ticket_id: string; body_hash: string; receipt: string }[];
} | undefined {
  const key = checkedScope(scope);
  const tables = new Set((database.prepare(
    `SELECT name FROM sqlite_schema
    WHERE type='table' AND name IN ('scene_tavern_turns','scene_tavern_receipts')`
  ).all() as
    { name: string }[]).map(
      row => row.name
    ));
  const turns = tables.has('scene_tavern_turns')
    ? database.prepare(
      `SELECT turn_id,turn_revision,kind,body FROM scene_tavern_turns
      WHERE scope=? ORDER BY rowid`
    ).all(key) as
    { turn_id: string; turn_revision: number; kind: string; body: string }[]
    : [];
  const receipts = tables.has('scene_tavern_receipts')
    ? database.prepare(
      `SELECT ticket_id,body_hash,receipt FROM scene_tavern_receipts
      WHERE scope=? ORDER BY rowid`
    ).all(key) as
    { ticket_id: string; body_hash: string; receipt: string }[]
    : [];

  if (turns.length || receipts.length) {
    return { turns, receipts };
  }

  // No accepted event reference can originate without ledger tables. Keep that legacy path free of source reads.
  // Existing tables can be empty after deletion, so check this scope's references before discarding the snapshot.
  if (includeReferencedEmptyScope && tables.size > 0) {
    const references = database.prepare(`SELECT 1 AS scope_event_references
      FROM scene_sources AS source,
        json_each(CASE
          WHEN instr(source.analysis, '"knowledge') > 0 OR instr(source.analysis, '\\u') > 0
          THEN source.analysis ELSE NULL END, '$.characters') AS character,
        json_each(character.value, '$.memories') AS memory
      WHERE source.scope=? AND (
        json_type(memory.value, '$.source.knowledge') NOT IN ('null')
        OR json_array_length(memory.value, '$.source.knowledgeSet') > 0
      ) LIMIT 1`).get(key);

    if (references) {
      return { turns, receipts };
    }
  }

  return undefined;
}

/**
 * Replaces one scope's ledger inside the caller's transaction (or a local transaction for direct use).
 * Null/absent snapshots clear existing rows without creating tables. Nonempty snapshots restore the two
 * existing ledger tables only; forked turns, origins and receipts use the destination scope. Errors roll back.
 * Sources must already be restored. Filtering and rebinding cost O(rows + references + serialized bytes).
 */
export function restoreTavernEngineRows(
  database: DatabaseSync,
  scope: Scope,
  snapshot?: ReturnType<typeof captureTavernEngineRows> | null,

): void {
  const key = checkedScope(scope);
  inTransaction(
    database,
    () => {
      const sources = snapshot == null
        ? []
        : database.prepare(`SELECT id,revision,status,message FROM scene_sources
      WHERE scope=?`).all(key) as { id: string; revision: number; status: string; message: string }[];
      const filtered = filterTavernEngineSnapshot(snapshot, sources);

      for (const table of ['scene_tavern_receipts', 'scene_tavern_turns']) {
        if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)) {
          database.prepare(`DELETE FROM ${table} WHERE scope=?`).run(key);
        }
      }

      if (!filtered || (!filtered.turns.length && !filtered.receipts.length))
        return;
      database.exec(
        `CREATE TABLE IF NOT EXISTS scene_tavern_turns (
      scope TEXT NOT NULL REFERENCES scene_worlds(key),
      turn_id TEXT NOT NULL,
      turn_revision INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('interpret','npc')),
      body TEXT NOT NULL,
      PRIMARY KEY(scope,turn_id,turn_revision,kind))`
      );
      database.exec(
        `CREATE TABLE IF NOT EXISTS scene_tavern_receipts (
      scope TEXT NOT NULL REFERENCES scene_worlds(key),
      ticket_id TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      receipt TEXT NOT NULL,
      PRIMARY KEY(scope,ticket_id))`
      );

      const insertTurn = database.prepare(
        `INSERT INTO scene_tavern_turns(scope,turn_id,turn_revision,kind,body)
      VALUES(?,?,?,?,?)`
      );

      for (const row of filtered.turns) {
        const turn = JSON.parse(row.body) as AcceptedTavernTurn;
        let body = row.body;

        if (scopeKey(turn.scope) !== key) {
          turn.scope = structuredClone(scope);

          const events = turn.kind === 'interpret' ? turn.events : turn.beats;

          for (const event of events)
            event.origin.scope = structuredClone(scope);

          if (turn.kind === 'npc') {
            for (const diagnostic of turn.unknownDiagnostics ?? []) {
              diagnostic.origin.scope = structuredClone(scope);
              diagnostic.source.origin.scope = structuredClone(scope);
            }
          }
          body = JSON.stringify(turn);
        }
        insertTurn.run(key, row.turn_id, row.turn_revision, row.kind, body);
      }

      const insertReceipt = database.prepare(`INSERT INTO scene_tavern_receipts(scope,ticket_id,body_hash,receipt)
      VALUES(?,?,?,?)`);

      for (const row of filtered.receipts) {
        const receipt = JSON.parse(row.receipt) as TavernCommitReceipt;
        let body = row.receipt;

        if (scopeKey(receipt.scope) !== key) {
          receipt.scope = structuredClone(scope);
          body = JSON.stringify(receipt);
        }
        insertReceipt.run(key, row.ticket_id, row.body_hash, body);
      }
    }
  );
}

/**
 * Removes whole accepted turns whose source, origin or evidence is no longer valid, and dependent turns.
 * Plans live inside beats and are removed with their turn; receipts survive only with their exact NPC turn.
 * Null/absent snapshots return undefined. Inputs stay unchanged; optional output separates whole-source erasure
 * from invalid revisions, keyed by JSON [sourceId, revision] so different revisions cannot alias.
 * Malformed stored JSON/getter errors propagate; a null output object is equivalent to omitting it.
 * A reverse dependency queue visits each row/reference once: O(sources + rows + references + JSON bytes).
 */
export function filterTavernEngineSnapshot(
  snapshot: ReturnType<typeof captureTavernEngineRows> | null,
  sources: readonly { id: string; revision: number; status: string; message?: string | null }[],
  erasedSourceIds: Iterable<string> = [],
  invalidatedSources?: ReturnType<typeof eraseTavernEngineSources> | null,

): ReturnType<typeof captureTavernEngineRows> {
  if (snapshot == null)
    return undefined;

  const erased = new Set(erasedSourceIds);

  for (const sourceId of erased)
    invalidatedSources?.deletedSourceIds.add(sourceId);
  // Read each caller-owned source field once; queue traversal uses a stable revision snapshot.
  const currentSources = sources.map(({ id, revision, status, message }) => ({ id, revision, status, message }));
  const available = new Map(currentSources.map(source => [source.id, source]));
  const sourceIdentity = (source: TavernSourceReference): string => JSON.stringify([source.id, source.revision]);
  const sourceDependents = new Map<string, TavernSourceReference[]>();
  const invalidSources = new Set<string>();
  const sourceQueue: TavernSourceReference[] = [];
  const invalidateSource = (source: TavernSourceReference): void => {
    const identity = sourceIdentity(source);

    if (invalidSources.has(identity))
      return;
    invalidSources.add(identity);
    sourceQueue.push(source);
  };

  // Live checkpoint redaction runs before the scene authority invalidates message dependencies.
  // Resolve the same accepted-source prerequisites here without modifying source rows or their analyses.
  for (const source of currentSources) {
    if (source.status !== 'accepted' || erased.has(source.id))
      invalidateSource(source);

    if (source.status === 'deleted')
      invalidatedSources?.deletedSourceIds.add(source.id);

    const dependencies = source.message == null
      ? []
      :
      (JSON.parse(source.message) as { dependencies?: TavernSourceReference[] | null }).dependencies ?? [];

    for (const dependency of dependencies) {
      const parent = available.get(dependency.id);

      if (!parent || parent.status === 'deleted')
        invalidatedSources?.deletedSourceIds.add(dependency.id);

      if (parent?.status !== 'accepted' || parent.revision !== dependency.revision)
        invalidateSource(source);

      const identity = sourceIdentity(dependency);
      const children = sourceDependents.get(identity) ?? [];
      children.push(source);
      sourceDependents.set(identity, children);
    }
  }

  for (let cursor = 0;cursor < sourceQueue.length;cursor++) {
    for (const dependent of sourceDependents.get(sourceIdentity(sourceQueue[cursor]!)) ?? [])
      invalidateSource(dependent);
  }

  const sourceValid = (source: TavernSourceReference): boolean => {
    const current = available.get(source.id);

    if (!current || current.status === 'deleted')
      invalidatedSources?.deletedSourceIds.add(source.id);

    return !erased.has(source.id) && !invalidSources.has(sourceIdentity(source))
      && current?.status === 'accepted' && current.revision === source.revision;
  };
  const turns = snapshot.turns.map(row => JSON.parse(row.body) as AcceptedTavernTurn);
  const identity = (turnId: string, revision: number, kind: string): string => JSON.stringify([turnId, revision, kind]);
  const eventIdentity = (turnId: string, revision: number, eventId: string): string =>
    JSON.stringify([turnId, revision, eventId]);
  const positions = new Map<string, number>();
  const eventOwners = new Map<string, number>();
  const sourceTurns = new Map<string, number[]>();
  const dependents = new Map<number, number[]>();
  const invalid = new Set<number>();
  const queue: number[] = [];
  const invalidate = (index: number): void => {
    if (invalid.has(index))
      return;
    invalid.add(index);
    queue.push(index);
    // An obsolete turn invalidates only the revision that produced it; a replacement may be independent.
    invalidateSource(turns[index]!.source);
  };
  const dependOnSource = (index: number, source: TavernSourceReference): void => {
    const identity = sourceIdentity(source);
    const children = sourceTurns.get(identity) ?? [];
    children.push(index);
    sourceTurns.set(identity, children);

    if (!sourceValid(source))
      invalidate(index);
  };

  for (const [index, turn] of turns.entries()) {
    positions.set(identity(turn.turnId, turn.turnRevision, turn.kind), index);

    const events = turn.kind === 'interpret' ? turn.events : turn.beats;

    for (const event of events) {
      eventOwners.set(eventIdentity(event.envelope.turnId, event.origin.turnRevision, event.envelope.id), index);
    }

    if (turn.kind === 'npc') {
      for (const diagnostic of turn.unknownDiagnostics ?? []) {
        eventOwners.set(eventIdentity(
          diagnostic.envelope.turnId, diagnostic.origin.turnRevision, diagnostic.envelope.id,
        ), index);
      }
    }
  }

  const depend = (index: number, owner: number | undefined): void => {
    if (owner === undefined) {
      invalidate(index);

      return;
    }

    const children = dependents.get(owner) ?? [];
    children.push(index);
    dependents.set(owner, children);
  };
  const checkEvidence = (index: number, evidence: import('./types.ts').EventEvidence['evidence']): void => {
    for (const reference of evidence ?? []) {
      if (reference.channel === 'message') {
        dependOnSource(index, { id: reference.sourceId, revision: reference.revision });
      } else {
        depend(index, eventOwners.get(eventIdentity(reference.turnId, reference.turnRevision, reference.eventId)));
      }
    }
  };

  for (const [index, turn] of turns.entries()) {
    dependOnSource(index, turn.source);

    if (turn.kind === 'npc') {
      depend(index, positions.get(identity(turn.turnId, turn.turnRevision, 'interpret')));

      if (turn.playerSource) dependOnSource(index, turn.playerSource);
      for (const diagnostic of turn.unknownDiagnostics ?? []) {
        dependOnSource(index, { id: diagnostic.origin.sourceId, revision: diagnostic.origin.sourceRevision });
        dependOnSource(index, {
          id: diagnostic.source.origin.sourceId,
          revision: diagnostic.source.origin.sourceRevision,
        });
        // Rejected links are only inspected for erasure dependencies. They never enter the executable beat list.
        if ('effect' in diagnostic && 'evidence' in diagnostic.effect.effect) {
          checkEvidence(index, diagnostic.effect.effect.evidence);
        }
      }
    } else if (turn.interpretation != null) {
      dependOnSource(index, turn.interpretation.source);
      if (!sameSource(turn.interpretation.source, turn.source)
        || turn.interpretation.turnRevision !== turn.turnRevision) {
        invalidate(index);
      }
    }

    const events = turn.kind === 'interpret' ? turn.events : turn.beats;

    for (const event of events) {
      dependOnSource(index, { id: event.origin.sourceId, revision: event.origin.sourceRevision });

      if ('payload' in event) {
        if ('evidence' in event.payload)
          checkEvidence(index, event.payload.evidence);
      } else {
        for (const linked of event.effects) {
          if ('evidence' in linked.effect)
            checkEvidence(index, linked.effect.evidence);
        }
      }
    }
  }

  // Each source and turn is queued once. Alternating queues closes event -> source -> message -> event chains.
  let sourceCursor = 0;
  let turnCursor = 0;

  while (sourceCursor < sourceQueue.length || turnCursor < queue.length) {
    while (sourceCursor < sourceQueue.length) {
      const sourceId = sourceIdentity(sourceQueue[sourceCursor++]!);

      for (const dependent of sourceDependents.get(sourceId) ?? [])
        invalidateSource(dependent);

      for (const dependent of sourceTurns.get(sourceId) ?? [])
        invalidate(dependent);
    }

    if (turnCursor < queue.length) {
      for (const dependent of dependents.get(queue[turnCursor++]!) ?? [])
        invalidate(dependent);
    }
  }

  for (const identity of invalidSources)
    invalidatedSources?.sourceRevisions.add(identity);

  return {
    turns: snapshot.turns.filter((_row, index) => !invalid.has(index)),
    receipts: snapshot.receipts.filter(
      row => {
        const receipt = JSON.parse(row.receipt) as TavernCommitReceipt;
        const index = positions.get(identity(receipt.turnId, receipt.turnRevision, 'npc'));
        const turn = index === undefined ? undefined : turns[index];
        const validSource = sourceValid(receipt.source);

        return index !== undefined && !invalid.has(index) && validSource
          && turn?.source.id === receipt.source.id
          && turn.source.revision === receipt.source.revision;
      }
    ),
  };
}

/**
 * Erases invalid scoped ledger rows, receipts and accepted source analyses in the same transaction.
 * Returns whole deleted/missing source IDs and invalid revisions keyed by JSON [sourceId, revision].
 * Checkpoints must match that pair; a removed historical revision does not erase its valid replacement.
 * Later causal analyses are queued for rebuild.
 * A memory whose explicit event reference (its knowledge, or any knowledgeSet entry) is no longer current is erased
 * whole. Commit records every event a memory depends on, so memories without an explicit reference are never erased
 * here; an analysis keeps its stored bytes unless one of its memories is erased, and legacy analyses never change.
 * Source/turn queues and address lookups cost O(sources + rows + references + serialized bytes); an analysis text
 * that cannot hold a reference key is skipped without parsing.
 * Explicit IDs include deletions/corrections; current source status/revision also invalidates stale entries.
 * Reports changedSourceRevisions only for accepted rows whose status this call actually changed; historical
 * invalid revisions stay separate. The optional field is absent on read-only checkpoint filter accumulators.
 * Missing tables/data are a no-op. Writes share the caller transaction; any SQL/JSON/getter failure rolls back.
 */
export function eraseTavernEngineSources(
  database: DatabaseSync,
  scope: Scope,
  sourceIds: Iterable<string>,
): { deletedSourceIds: Set<string>; sourceRevisions: Set<string>; changedSourceRevisions?: Set<string> } {
  const key = checkedScope(scope);
  const invalidated = {
    deletedSourceIds: new Set(sourceIds),
    sourceRevisions: new Set<string>(),
    changedSourceRevisions: new Set<string>(),
  };

  return inTransaction(
    database,
    () => {
      const snapshot = captureTavernEngineRows(database, scope, true);

      // Only this scope's ledger rows or explicit memory event references authorize erasure. Empty shared
      // tables do not. The reference probe still finds stale memories after every ledger row was deleted.
      if (!snapshot) {
        return invalidated;
      }

      const sources = database.prepare(
        'SELECT id,revision,status,message,analysis FROM scene_sources WHERE scope=? ORDER BY rowid',
      ).all(key) as { id: string; revision: number; status: string; message: string; analysis: string | null }[];
      // Eligible event scopes retain the existing transitive invalidation of event and message dependencies.
      const filtered = filterTavernEngineSnapshot(snapshot, sources, invalidated.deletedSourceIds, invalidated)!;
      const retained = new Set(filtered.turns);
      const retainedReceipts = new Set(filtered.receipts);
      const sourceIdentity = (source: TavernSourceReference): string => JSON.stringify([source.id, source.revision]);
      const erased = new Map<string, TavernSourceReference>();

      for (const row of snapshot.turns) {
        if (retained.has(row))
          continue;
        database.prepare('DELETE FROM scene_tavern_turns WHERE scope=? AND turn_id=? AND turn_revision=? AND kind=?')
          .run(
            key,
            row.turn_id,
            row.turn_revision,
            row.kind
          );
        const source = (JSON.parse(row.body) as AcceptedTavernTurn).source;
        erased.set(sourceIdentity(source), source);
      }

      for (const row of snapshot.receipts) {
        if (retainedReceipts.has(row))
          continue;
        database.prepare('DELETE FROM scene_tavern_receipts WHERE scope=? AND ticket_id=?').run(key, row.ticket_id);
      }

      for (const source of sources) {
        if (invalidated.sourceRevisions.has(sourceIdentity(source)))
          erased.set(sourceIdentity(source), source);
      }

      const clearStages = database.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_processing_stages'",
      ).get()
        ? database.prepare('DELETE FROM scene_processing_stages WHERE scope=? AND source=? AND revision=?')
        : undefined;
      const currentSources = new Map(sources.map(source => [source.id, source]));
      const sourceValid = (source: TavernSourceReference): boolean => {
        const current = currentSources.get(source.id);

        return current?.status === 'accepted' && current.revision === source.revision
          && !invalidated.deletedSourceIds.has(source.id)
          && !invalidated.sourceRevisions.has(sourceIdentity(source));
      };
      type MemoryReference = import('./types.ts').TavernEventAddress;
      const addressIdentity = (reference: MemoryReference): string => JSON.stringify([
        reference.turnId,
        reference.turnRevision,
        reference.eventId,
        reference.phase,
        reference.itemRef ?? null,
        reference.effectIndex ?? null,
      ]);
      const latestRevisions = new Map<string, number>();

      for (const row of snapshot.turns) {
        latestRevisions.set(row.turn_id, Math.max(latestRevisions.get(row.turn_id) ?? 0, row.turn_revision));
      }

      const availableAddresses = new Set<string>();

      for (const row of filtered.turns) {
        const turn = JSON.parse(row.body) as AcceptedTavernTurn;

        if (turn.turnId !== row.turn_id || turn.turnRevision !== row.turn_revision || turn.kind !== row.kind
          || latestRevisions.get(turn.turnId) !== turn.turnRevision || scopeKey(turn.scope) !== key
          || !sourceValid(turn.source)) {
          continue;
        }

        for (const event of turn.kind === 'interpret' ? turn.events : turn.beats) {
          if (event.envelope.status !== 'accepted' || event.envelope.turnId !== turn.turnId
            || event.origin.turnRevision !== turn.turnRevision || scopeKey(event.origin.scope) !== key
            || !sourceValid({id: event.origin.sourceId, revision: event.origin.sourceRevision})) {
            continue;
          }

          const addAddress = (phase: MemoryReference['phase'], itemRef?: number, effectIndex?: number): void => {
            availableAddresses.add(addressIdentity({
              turnId: turn.turnId,
              turnRevision: turn.turnRevision,
              eventId: event.envelope.id,
              phase,
              ...(itemRef == null ? {} : {itemRef}),
              ...(effectIndex == null ? {} : {effectIndex}),
            }));
          };

          if ('payload' in event) {
            if (event.payload.kind !== 'Unknown') {
              addAddress('event');
            }
          } else {
            const itemIndices = new Set(event.items.map(item => item.itemIndex));

            for (const item of event.items) {
              addAddress('item', item.itemIndex);
            }

            for (const effect of event.effects) {
              if (itemIndices.has(effect.itemRef)) {
                addAddress(effect.phase, effect.itemRef, effect.effectIndex);
              }
            }
          }
        }
      }

      for (const source of sources) {
        if (source.status !== 'accepted' || source.analysis === null || erased.has(sourceIdentity(source))) {
          continue;
        }

        // Only a knowledge or knowledgeSet key can name an event, so a text with neither is skipped unparsed. The test
        // is exact for any JSON text: a key's letters appear literally or as \u escapes, so a text holding neither
        // the literal key prefix nor any \u escape has no such key, and parsing it could not erase a memory.
        if (!source.analysis.includes('"knowledge') && !source.analysis.includes('\\u')) {
          continue;
        }

        const analysis = JSON.parse(source.analysis) as import('../types.ts').StoredSceneAnalysis;
        let memoriesErased = false;

        for (const character of Object.values(analysis.characters ?? {})) {
          if (character.memories == null) {
            continue;
          }

          character.memories = character.memories.filter(memory => {
            const metadata = memory.source;
            // A memory without an explicit reference depends on no event, so it is never erased here.
            const memoryReferences = metadata?.knowledgeSet
              ?? (metadata?.knowledge == null ? [] : [metadata.knowledge]);
            const missingEvent = memoryReferences.some(reference => !availableAddresses.has(addressIdentity(reference)));

            if (missingEvent) {
              memoriesErased = true;
            }

            return !missingEvent;
          });
        }

        if (memoriesErased) {
          // Update the in-memory row too: the causal suffix below must not write erased candidates back.
          source.analysis = JSON.stringify(analysis);
          database.prepare('UPDATE scene_sources SET analysis=? WHERE scope=? AND id=? AND revision=?')
            .run(source.analysis, key, source.id, source.revision);
          clearStages?.run(key, source.id, source.revision);
        }
      }

      if (!erased.size) {
        return invalidated;
      }

      const invalidateAnalysis = database.prepare(
        "UPDATE scene_sources SET status='needs_review',processing='failed',analysis=NULL WHERE scope=? AND id=? AND revision=? AND status='accepted'",
      );
      const hasWorld = Boolean(database.prepare('SELECT 1 FROM scene_world_settings WHERE scope=?').get(key));
      const affectedCharacters = new Set<string>();
      let changed = false;

      // Removed historical revisions can still have staged work, even when the current source has advanced.
      // Match both writes to the removed revision so its replacement keeps its analysis and staged learning.
      for (const source of erased.values()) {
        const update = invalidateAnalysis.run(key, source.id, source.revision);

        if (update.changes > 0) {
          invalidated.changedSourceRevisions.add(sourceIdentity(source));
        }
        clearStages?.run(key, source.id, source.revision);
      }

      for (const source of sources) {

        if (source.status !== 'accepted')
          continue;

        const analysis = source.analysis === null
          ? null
          : JSON.parse(source.analysis) as {
            characters?: Record<string, unknown>;
            emotionStates?: unknown;
          };
        const characters = Object.keys(analysis?.characters ?? {});

        if (erased.has(sourceIdentity(source))) {
          changed = true;

          for (const character of characters)
            affectedCharacters.add(character);
          continue;
        }

        // Later analyses were learned from the invalidated state. Keep retry material, but exclude it from reads
        // and replay until normal processing recomputes it, as in the scene authority's causal suffix handling.
        if (!changed || !analysis || (!hasWorld && !characters.some(character => affectedCharacters.has(character)))) {
          continue;
        }
        delete analysis.emotionStates;
        database.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=? AND revision=?")
          .run(
            JSON.stringify(analysis),
            key,
            source.id,
            source.revision
          );
        clearStages?.run(key, source.id, source.revision);

        const message = JSON.parse(source.message) as {
          envelope?: { targetId?: string; presentIds?: string[] };
          speakerId?: string;
        };

        for (const character of [
          ...characters,
          message.envelope?.targetId,
          ...(message.envelope?.presentIds ?? []),
          message.speakerId,
        ]) {
          if (character)
            affectedCharacters.add(character);
        }
      }

      return invalidated;
    }
  );
}

/**
 * Tests checkpoint turns, origins, evidence and receipts against whole-source erasure and invalid revision pairs.
 * Revision keys are JSON [sourceId, revision]; omitted/null revision sets mean only whole-source erasure.
 * Missing event owners are unsafe; owners present in the snapshot are checked against the same source pairs.
 * Null/absent snapshots are safe.
 * Work is O(rows + references + JSON bytes); malformed JSON and getter errors propagate to the caller's guard.
 */
export function tavernEngineSnapshotReferencesSources(
  snapshot: ReturnType<typeof captureTavernEngineRows> | null,
  sourceIds: Iterable<string>,
  sourceRevisions?: ReadonlySet<string> | null,
): boolean {
  if (snapshot == null)
    return false;

  const deleted = new Set(sourceIds);
  const sourceInvalid = (id: string, revision: number): boolean =>
    deleted.has(id) || sourceRevisions?.has(JSON.stringify([id, revision])) === true;
  const turns = snapshot.turns.map(row => JSON.parse(row.body) as AcceptedTavernTurn);
  const eventIdentities = new Set<string>();

  for (const turn of turns) {
    for (const event of turn.kind === 'interpret' ? turn.events : turn.beats)
      eventIdentities.add(JSON.stringify([event.envelope.turnId, event.origin.turnRevision, event.envelope.id]));

    if (turn.kind === 'npc') {
      for (const diagnostic of turn.unknownDiagnostics ?? []) {
        eventIdentities.add(JSON.stringify([
          diagnostic.envelope.turnId, diagnostic.origin.turnRevision, diagnostic.envelope.id,
        ]));
      }
    }
  }

  const references = (evidence: import('./types.ts').EventEvidence['evidence']): boolean =>
    (evidence ?? []).some(reference => reference.channel === 'message'
      ? sourceInvalid(reference.sourceId, reference.revision)
      : !eventIdentities.has(JSON.stringify([reference.turnId, reference.turnRevision, reference.eventId])));

  for (const turn of turns) {
    if (sourceInvalid(turn.source.id, turn.source.revision))
      return true;

    if (turn.kind === 'interpret' && turn.interpretation != null
      && sourceInvalid(turn.interpretation.source.id, turn.interpretation.source.revision)) {
      return true;
    }

    if (turn.kind === 'npc') {
      if (turn.playerSource && sourceInvalid(turn.playerSource.id, turn.playerSource.revision)) return true;
      for (const diagnostic of turn.unknownDiagnostics ?? []) {
        if (sourceInvalid(diagnostic.origin.sourceId, diagnostic.origin.sourceRevision)
          || sourceInvalid(diagnostic.source.origin.sourceId, diagnostic.source.origin.sourceRevision)
          || ('effect' in diagnostic && 'evidence' in diagnostic.effect.effect
            && references(diagnostic.effect.effect.evidence))) {
          return true;
        }
      }
    }

    const events = turn.kind === 'interpret' ? turn.events : turn.beats;

    for (const event of events) {
      if (sourceInvalid(event.origin.sourceId, event.origin.sourceRevision))
        return true;

      if ('payload' in event) {
        if ('evidence' in event.payload && references(event.payload.evidence))
          return true;
      } else
        if (event.effects.some(linked => 'evidence' in linked.effect && references(linked.effect.evidence))) {
          return true;
        }
    }
  }

  return snapshot.receipts.some(row => {
    const source = (JSON.parse(row.receipt) as TavernCommitReceipt).source;

    return sourceInvalid(source.id, source.revision);
  });
}
