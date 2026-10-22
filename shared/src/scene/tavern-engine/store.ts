import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { scopeKey } from '../../core/types.ts';
import { readStoreFormat, stampStoreFormat } from '../../core/store-format.ts';
import type { Scope } from '../../memory/access.ts';
import { projectBeatItems } from './codec.ts';
import type { DecodedBeat, EngineEvent } from './types.ts';

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
  | { kind: 'interpret'; events: readonly EngineEvent[] }
  | { kind: 'npc'; beats: readonly DecodedBeat[] }
);

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
  event: EngineEvent | DecodedBeat,
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

/**
 * Inert data operations on the caller's scene database; construction and module import perform no SQL.
 * Inputs are trusted decoder/validator outputs, never raw model candidates. SQLite and getter errors propagate.
 * Writes use one transaction or a savepoint inside the caller's transaction; outer rollback remains authoritative.
 */
export class TavernLedgerStore {
  private readonly database: DatabaseSync;
  private readonly format: TavernStoreFormat;
  private readonly tickets = new Map<string, TavernTurnTicket>();

  constructor(database: DatabaseSync, format: TavernStoreFormat) {
    const copied = structuredClone(format);
    integer(copied.format, 1);
    identifier(copied.writerVersion);
    this.database = database;
    this.format = copied;
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
   * Accepts a player's interpretation independently of NPC generation. Empty interpretations are permitted.
   * Exact replay returns the original entry without writes; changed content, stale sources or versions throw.
   * Work is O(input bytes + events), plus indexed lookups, independent of the number of prior chat sources.
   */
  acceptPlayerInterpretation(input: PlayerInterpretationInput): AcceptedTavernTurn {
    const copied = structuredClone(input);
    const key = turnAddress(copied.scope, copied.turnId, copied.turnRevision);
    sourceReference(copied.source);
    integer(copied.expectedVersion, 0);
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
          || JSON.stringify(previous.events) !== JSON.stringify(copied.events)) {
          throw new Error('tavern_interpretation_conflict');
        }
        return previous;
      }

      this.requireVersion(key, copied.expectedVersion);
      this.stampFormat();
      const entry: AcceptedTavernTurn = {
        scope: copied.scope,
        turnId: copied.turnId,
        turnRevision: copied.turnRevision,
        source: copied.source,
        version: copied.expectedVersion + 1,
        kind: 'interpret',
        events: copied.events,
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
    const previous = this.tickets.get(key);
    if (previous?.ticketId === ticket.ticketId && JSON.stringify(previous) !== JSON.stringify(ticket)) {
      throw new Error('tavern_ticket_conflict');
    }
    this.tickets.set(key, ticket);
    return structuredClone(ticket);
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
        scope: copiedScope,
        turnId: ticket.turnId,
        turnRevision: ticket.turnRevision,
        source: ticket.assistantSource,
        version: ticket.expectedVersion + 1,
        kind: 'npc',
        beats,
      });
      const receipt: TavernCommitReceipt = {
        scope: copiedScope,
        ticketId,
        turnId: ticket.turnId,
        turnRevision: ticket.turnRevision,
        source: ticket.assistantSource,
        version: ticket.expectedVersion + 1,
        acceptedAtMs,
        bodyHash: digest,
        status: 'accepted',
      };
      this.database.prepare(`INSERT INTO scene_tavern_receipts(scope,ticket_id,body_hash,receipt)
        VALUES(?,?,?,?)`).run(key, ticketId, digest, JSON.stringify(receipt));
      this.bumpVersion(key, ticket.expectedVersion);
      // Keep the single scope ticket until replaced: a caller may still roll back its outer transaction.
      return receipt;
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
    const row = this.database.prepare(`SELECT body FROM scene_tavern_turns
      WHERE scope=? AND turn_id=? AND turn_revision=? AND kind=?`).get(key, turnId, turnRevision, kind) as
      { body: string } | undefined;
    return row ? JSON.parse(row.body) as AcceptedTavernTurn : undefined;
  }

  /** Reads one committed receipt in its exact scope; no ticket or body from another scope can be returned. */
  readReceipt(scope: Scope, ticketId: string): TavernCommitReceipt | undefined {
    const key = checkedScope(structuredClone(scope));
    identifier(ticketId);
    const row = this.database.prepare(`SELECT receipt FROM scene_tavern_receipts
      WHERE scope=? AND ticket_id=?`).get(key, ticketId) as { receipt: string } | undefined;
    return row ? JSON.parse(row.receipt) as TavernCommitReceipt : undefined;
  }

  private requirePlayerSource(key: string, source: TavernSourceReference): void {
    const row = this.database.prepare(`SELECT revision,status,message FROM scene_sources
      WHERE scope=? AND id=?`).get(key, source.id) as
      { revision: number; status: string; message: string } | undefined;
    if (!row || row.revision !== source.revision || row.status !== 'accepted') {
      throw new Error('tavern_player_source_changed');
    }
    const message = JSON.parse(row.message);
    if (message.id !== source.id || message.revision !== source.revision || message.role !== 'user') {
      throw new Error('tavern_player_source_changed');
    }
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
