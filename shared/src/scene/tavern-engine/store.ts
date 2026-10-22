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

/**
 * Captures only this scope's accepted ledger rows, including embedded private plans and durable receipts.
 * Returns undefined without creating tables when the scope has no rows. SQL errors propagate unchanged.
 * Work is O(rows + stored bytes); raw JSON is retained so capture does not normalize accepted history.
 */
export function captureTavernEngineRows(database: DatabaseSync, scope: Scope): {
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

  return turns.length || receipts.length ? { turns, receipts } : undefined;
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
 * Source/turn queues and one ordered suffix pass cost O(sources + rows + references + serialized bytes).
 * Explicit IDs include deletions/corrections; current source status/revision also invalidates stale entries.
 * Missing tables/data are a no-op. Writes share the caller transaction; any SQL/JSON/getter failure rolls back.
 */
export function eraseTavernEngineSources(
  database: DatabaseSync,
  scope: Scope,
  sourceIds: Iterable<string>,
): { deletedSourceIds: Set<string>; sourceRevisions: Set<string> } {
  const key = checkedScope(scope);
  const invalidated = { deletedSourceIds: new Set(sourceIds), sourceRevisions: new Set<string>() };

  return inTransaction(
    database,
    () => {
      const snapshot = captureTavernEngineRows(database, scope);

      if (!snapshot)
        return invalidated;

      const sources = database.prepare(
        'SELECT id,revision,status,message,analysis FROM scene_sources WHERE scope=? ORDER BY rowid',
      ).all(key) as { id: string; revision: number; status: string; message: string; analysis: string | null }[];
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

      if (!erased.size)
        return invalidated;

      const invalidateAnalysis = database.prepare(
        "UPDATE scene_sources SET status='needs_review',processing='failed',analysis=NULL WHERE scope=? AND id=? AND revision=? AND status='accepted'",
      );
      const clearStages = database.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_processing_stages'",
      ).get()
        ? database.prepare('DELETE FROM scene_processing_stages WHERE scope=? AND source=? AND revision=?')
        : undefined;
      const hasWorld = Boolean(database.prepare('SELECT 1 FROM scene_world_settings WHERE scope=?').get(key));
      const affectedCharacters = new Set<string>();
      let changed = false;

      // Removed historical revisions can still have staged work, even when the current source has advanced.
      // Match both writes to the removed revision so its replacement keeps its analysis and staged learning.
      for (const source of erased.values()) {
        invalidateAnalysis.run(key, source.id, source.revision);
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
  }

  const references = (evidence: import('./types.ts').EventEvidence['evidence']): boolean =>
    (evidence ?? []).some(reference => reference.channel === 'message'
      ? sourceInvalid(reference.sourceId, reference.revision)
      : !eventIdentities.has(JSON.stringify([reference.turnId, reference.turnRevision, reference.eventId])));

  for (const turn of turns) {
    if (sourceInvalid(turn.source.id, turn.source.revision))
      return true;

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
