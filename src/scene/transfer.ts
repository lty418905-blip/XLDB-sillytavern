import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { scopeKey } from '../core/types.ts';
import type { Memory } from '../memory/access.ts';
import { npcScope } from './types.ts';
import type { SceneRoster, SceneScope } from './types.ts';
import {rosterOf} from './perspective.ts';
import type { WorldSettings } from './world-state.ts';
import { foldWorldState } from './world-state.ts';
import type { SceneAuthority } from './store.ts';

export interface SceneTemplate {
  format: 'xldb-scene-template-v1';
  name: string;
  roster: SceneRoster;
  worldSettings: WorldSettings | null;
}

export interface ReferenceImportRow {
  table: string;
  row: string;
  text: string;
  knownBy?: string[];
  occurredAtMs?: number | null;
}

export interface ReferenceImport {
  format: 'xldb-reference-import-v1';
  rows: ReferenceImportRow[];
}

export type SceneTransferDocument = SceneTemplate | ReferenceImport;

export interface SceneReference {
  id: string;
  text: string;
  knownBy: string[];
  occurredAtMs: number | null;
  fileHash: string;
  table: string;
  row: string;
  importedAtMs: number;
}

export interface PersistedReferenceRow {
  id: string;
  body: string;
  status: 'accepted' | 'deleted';
}

export interface ReferenceRestoreOptions {
  /** Lifecycle checkpoints replace active rows absent from their capture; backup merges leave them alone. */
  replaceAccepted?: boolean;
}

/** Read-only capture for lifecycle/backup. Legacy databases simply have no rows. */
export function captureReferenceRows(db: DatabaseSync, scope: SceneScope): PersistedReferenceRow[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_import_references'").get();
  if (!exists) return [];
  return db.prepare('SELECT id,body,status FROM scene_import_references WHERE scope=? ORDER BY rowid')
    .all(scopeKey(scope)) as unknown as PersistedReferenceRow[];
}

/**
 * Restore/backup merge helper. A live or incoming tombstone wins. It does not
 * erase omitted rows, so a caller represents deletion with an explicit row.
 */
export function restoreReferenceRows(
  db: DatabaseSync, scope: SceneScope, rows: readonly PersistedReferenceRow[], options: ReferenceRestoreOptions = {},
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scene_import_references (
    scope TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
    deleted_at INTEGER, PRIMARY KEY(scope,id), CHECK(status IN ('accepted','deleted')));`);
  for (const row of rows) {
    if (!isHash(row.id) || !['accepted','deleted'].includes(row.status)) throw new Error('invalid_scene_reference_restore');
    parseReference(row.body);
  }
  if (options.replaceAccepted) {
    const retained = new Set(rows.map(row => row.id));
    const live = db.prepare("SELECT id FROM scene_import_references WHERE scope=? AND status='accepted'")
      .all(scopeKey(scope)) as unknown as {id:string}[];
    for (const row of live) if (!retained.has(row.id)) {
      // This was added after the checkpoint, not user-deleted, so it may be
      // removed rather than converted into a permanent erase boundary.
      db.prepare('DELETE FROM scene_import_references WHERE scope=? AND id=?').run(scopeKey(scope), row.id);
    }
  }
  for (const row of rows) {
    if (!isHash(row.id) || !['accepted','deleted'].includes(row.status)) throw new Error('invalid_scene_reference_restore');
    const incoming = parseReference(row.body);
    const live = db.prepare('SELECT status FROM scene_import_references WHERE scope=? AND id=?')
      .get(scopeKey(scope), row.id) as {status:'accepted'|'deleted'} | undefined;
    const status = live?.status === 'deleted' || row.status === 'deleted' ? 'deleted' : 'accepted';
    const body = status === 'deleted' ? JSON.stringify({...incoming, text: '', knownBy: []}) : JSON.stringify(incoming);
    db.prepare(`INSERT INTO scene_import_references(scope,id,body,status,deleted_at) VALUES(?,?,?,?,?)
      ON CONFLICT(scope,id) DO UPDATE SET body=excluded.body,status=excluded.status,deleted_at=excluded.deleted_at`)
      .run(scopeKey(scope), row.id, body, status, status === 'deleted' ? Date.now() : null);
    if(status==='deleted')redactReferenceCheckpoints(db,scope,row.id,body);
  }
}

interface OperationGuard {
  expectedVersion: number;
  operationId: string;
}

const MAX_ROWS = 1_000;
const MAX_TEXT = 20_000;
const MAX_IDENTIFIER = 500;
const MAX_OPERATION_ID = 200;
const KNOWN_REFERENCE_TABLES = new Set(['characters', 'world', 'locations', 'items', 'tasks', 'notes', 'relationships']);

/**
 * Limited SPDB-inspired transfer surface.  Its records are reference claims,
 * never accepted scene experiences or executable table instructions.
 */
export class SceneTransfer {
  private savepointSequence = 0;
  private db: DatabaseSync;
  private authority: SceneAuthority;

  constructor(db: DatabaseSync, authority: SceneAuthority) {
    this.db = db;
    this.authority = authority;
    db.exec(`CREATE TABLE IF NOT EXISTS scene_import_references (
      scope TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
      deleted_at INTEGER, PRIMARY KEY(scope,id), CHECK(status IN ('accepted','deleted')));
      CREATE TABLE IF NOT EXISTS scene_transfer_operations (
      scope TEXT NOT NULL, id TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(scope,id));`);
  }

  exportTemplate(scope: SceneScope, name: string): SceneTemplate {
    const state = this.authority.state(scope);
    if (!state.version) throw new Error('invalid_scene_not_configured');
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('invalid_scene_template_name');
    return clone({
      format: 'xldb-scene-template-v1', name,
      roster: state.roster,
      worldSettings: this.authority.worldSettings(scope),
    });
  }

  preview(scope: SceneScope, document: unknown, projectedRoster?: SceneRoster) {
    const state = this.authority.state(scope);
    if (!state.version) throw new Error('invalid_scene_not_configured');
    // Initialization may preview references for NPCs in its reviewed roster.
    // Apply still validates against the roster committed at that point.
    const normalized = validateDocument(document, projectedRoster ?? state.roster);
    const documentHash = hash(normalized);
    const previewId = hash({scope:scopeKey(scope),version:state.version,documentHash});
    const conflicts = normalized.format === 'xldb-scene-template-v1'
      ? templateConflicts(state, this.authority.worldSettings(scope), normalized) : importDiff(scope,normalized,this.db).conflicts;
    const warnings = normalized.format === 'xldb-reference-import-v1'
      ? referenceWarnings(normalized.rows) : [];
    return {
      previewId, expectedVersion: state.version, documentHash, format: normalized.format,
      valid: conflicts.length === 0, conflicts, warnings,
      diff: normalized.format === 'xldb-scene-template-v1'
        ? templateDiff(state.roster, this.authority.worldSettings(scope), normalized)
        : importDiff(scope, normalized, this.db),
      ...(normalized.format === 'xldb-reference-import-v1' ? {fileHash: documentHash} : {}),
    };
  }

  apply(scope: SceneScope, document: unknown, guard: ApplyGuard) {
    return this.transaction(() => {
    const state = this.authority.state(scope);
    const normalized = validateDocument(document, state.roster);
    validateGuard(guard);
    if (typeof guard.previewId !== 'string' || !guard.previewId) throw new Error('invalid_scene_transfer_preview');
    const documentHash = hash(normalized);
    // This binds the reviewed input across CLI processes without writing during preview.
    if (guard.previewId!==hash({scope:scopeKey(scope),version:guard.expectedVersion,documentHash}))throw new Error('invalid_scene_transfer_preview');
    const requestHash = hash({action: 'apply', expectedVersion: guard.expectedVersion, documentHash});
    const duplicate = this.operation(scope, guard.operationId, requestHash);
    if (duplicate) return {...duplicate,version:this.authority.state(scope).version, duplicate: true};
    if (state.version !== guard.expectedVersion) throw new Error('context_changed_retry');
    const conflicts = normalized.format === 'xldb-scene-template-v1'
      ? templateConflicts(state, this.authority.worldSettings(scope), normalized) : importDiff(scope,normalized,this.db).conflicts;
    if (conflicts.length) throw new Error(conflicts[0]!.code);

      const changed=normalized.format==='xldb-scene-template-v1'
        ?canonical(state.roster)!==canonical(normalized.roster)||canonical(this.authority.worldSettings(scope))!==canonical(normalized.worldSettings)
        :importDiff(scope,normalized,this.db).new>0;
      const checkpoint = changed?this.authority.lifecycle.checkpoint(scope, '模板或参考资料迁入', {automatic: true}):null;
      let imported = 0;
      let skipped = 0;
      if (normalized.format === 'xldb-scene-template-v1') {
        const rosterChanged = canonical(state.roster) !== canonical(normalized.roster);
        const settingsChanged = canonical(this.authority.worldSettings(scope)) !== canonical(normalized.worldSettings);
        if (rosterChanged) this.authority.configure(scope, normalized.roster,Date.now(),false);
        if (settingsChanged) this.authority.configureWorld(scope, normalized.worldSettings,false);
      } else {
        const result = this.insertReferences(scope, normalized, documentHash);
        imported = result.imported;
        skipped = result.skipped;
        if (imported) {
          this.bump(scope);
          this.queueCleanup(scope, result.readers, this.authority.state(scope).version);
        }
      }
      const result = {version: this.authority.state(scope).version, checkpointId: checkpoint?.id??null, imported, skipped, duplicate: false};
      this.db.prepare('INSERT INTO scene_transfer_operations(scope,id,request_hash,result) VALUES(?,?,?,?)')
        .run(scopeKey(scope), guard.operationId, requestHash, JSON.stringify(result));
      return result;
    });
  }

  /** Admin sees all active reference claims; a role sees only explicit grants. */
  references(scope: SceneScope, characterId?: string): SceneReference[] {
    const state = this.authority.state(scope);
    if (!state.version) throw new Error('invalid_scene_not_configured');
    if (characterId !== undefined && !state.roster.characters.some(character => character.id === characterId)) {
      throw new Error('invalid_scene_character');
    }
    const rows = this.db.prepare("SELECT id,body FROM scene_import_references WHERE scope=? AND status='accepted' ORDER BY rowid")
      .all(scopeKey(scope)) as {id:string; body:string}[];
    return rows.map(row => ({id: row.id, ...parseReference(row.body)}))
      .filter(row => characterId === undefined || row.knownBy.includes(characterId!));
  }

  deleteReference(scope: SceneScope, id: string, guard: OperationGuard) {
    return this.transaction(() => {
    validateGuard(guard);
    if (!isHash(id)) throw new Error('invalid_scene_reference');
    const requestHash = hash({action: 'delete-reference', expectedVersion: guard.expectedVersion, id});
    const duplicate = this.operation(scope, guard.operationId, requestHash);
    if (duplicate) return {...duplicate,version:this.authority.state(scope).version, duplicate: true};
    const state = this.authority.state(scope);
    if (state.version !== guard.expectedVersion) throw new Error('context_changed_retry');
    const row = this.db.prepare("SELECT body,status FROM scene_import_references WHERE scope=? AND id=?")
      .get(scopeKey(scope), id) as {body:string;status:'accepted'|'deleted'} | undefined;
    if (!row || row.status !== 'accepted') throw new Error('record_not_found');

      const reference = parseReference(row.body);
      const checkpoint = this.authority.lifecycle.checkpoint(scope, '导入参考资料删除', {automatic: true});
      const tombstone = {...reference, text: '', knownBy: [], deletedAtMs: Date.now()};
      redactReferenceCheckpoints(this.db,scope,id,JSON.stringify(tombstone));
      this.db.prepare("UPDATE scene_import_references SET body=?,status='deleted',deleted_at=? WHERE scope=? AND id=?")
        .run(JSON.stringify(tombstone), tombstone.deletedAtMs, scopeKey(scope), id);
      this.bump(scope);
      this.queueCleanup(scope, reference.knownBy, this.authority.state(scope).version);
      const result = {version: this.authority.state(scope).version, checkpointId: checkpoint.id, deleted: true, duplicate: false};
      this.db.prepare('INSERT INTO scene_transfer_operations(scope,id,request_hash,result) VALUES(?,?,?,?)')
        .run(scopeKey(scope), guard.operationId, requestHash, JSON.stringify(result));
      return result;
    });
  }

  /** Pieces for SceneAuthority.snapshot to merge; they do not replace its authority rows. */
  projection(scope: SceneScope, characterId: string): {
    messages: Map<string, {revision:number;status:'accepted'|'deleted'}>;
    memories: Map<string, Memory>;
  } {
    const state = this.authority.state(scope);
    if (!state.roster.characters.some(character => character.id === characterId)) throw new Error('invalid_scene_character');
    const roleScope = npcScope(scope, characterId);
    const messages = new Map<string, {revision:number;status:'accepted'|'deleted'}>();
    const memories = new Map<string, Memory>();
    for (const reference of this.references(scope, characterId)) {
      const messageId = `reference:${reference.id}`;
      const memoryId = `${messageId}:${characterId}`;
      messages.set(messageId, {revision: 1, status: 'accepted'});
      const memory: Memory = {
        id: memoryId, scope: roleScope, status: 'accepted' as const, access: 'clear' as const,
        detail: reference.text, gist: reference.text, feeling: '', anchor: reference.text,
        protectedFacts: [reference.text], kind: 'fact' as const,
        source: {
          messageId, revision: 1, occurredAtMs: reference.occurredAtMs, knownAtMs: reference.importedAtMs,
          knowledge: {kind: 'reference', observationId: reference.id, start: 0, end: reference.text.length},
          reference: {fileHash: reference.fileHash, table: reference.table, row: reference.row},
        },
      };
      memories.set(memoryId, memory);
    }
    return {messages, memories};
  }

  /** Lifecycle/backup hook: includes tombstones so old captures cannot resurrect a deleted row. */
  captureReferenceRows(scope: SceneScope): PersistedReferenceRow[] {
    return captureReferenceRows(this.db, scope);
  }

  /**
   * Merges saved rows.  A live or incoming tombstone wins, and omitted rows are
   * intentionally retained; callers must supply a tombstone for a deletion.
   */
  restoreReferenceRows(scope: SceneScope, rows: readonly PersistedReferenceRow[], options?: ReferenceRestoreOptions): void {
    restoreReferenceRows(this.db, scope, rows, options);
  }

  private insertReferences(scope: SceneScope, document: ReferenceImport, fileHash: string) {
    const roster = this.authority.state(scope).roster;
    let imported = 0;
    let skipped = 0;
    const readers = new Set<string>();
    const prior=referenceRowsByIdentity(this.db,scope);
    const insert = this.db.prepare('INSERT INTO scene_import_references(scope,id,body,status,deleted_at) VALUES(?,?,?,\'accepted\',NULL)');
    for (const row of document.rows) {
      const id = hash([fileHash, row.table, row.row]);
      const existing = prior.get(rowIdentity(row));
      if (existing) { skipped++; continue; }
      const reference: SceneReference = {
        id, text: row.text, knownBy: row.knownBy ?? [], occurredAtMs: row.occurredAtMs ?? null,
        fileHash, table: row.table, row: row.row, importedAtMs: Date.now(),
      };
      // This remains a fixed JSON-to-reference mapping.  `table` is provenance,
      // never an SQLite identifier or a command.
      if (reference.knownBy.some(id => !roster.characters.some(character => character.id === id))) throw new Error('invalid_scene_reference_reader');
      insert.run(scopeKey(scope), id, JSON.stringify(reference));
      for (const reader of reference.knownBy) readers.add(reader);
      imported++;
    }
    return {imported, skipped, readers};
  }

  private operation(scope:SceneScope, operationId:string, requestHash:string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT request_hash,result FROM scene_transfer_operations WHERE scope=? AND id=?')
      .get(scopeKey(scope), operationId) as {request_hash:string;result:string} | undefined;
    if (!row) return undefined;
    if (row.request_hash !== requestHash) throw new Error('invalid_scene_operation');
    return JSON.parse(row.result) as Record<string, unknown>;
  }

  private bump(scope:SceneScope) { this.db.prepare('UPDATE scene_worlds SET version=version+1 WHERE key=?').run(scopeKey(scope)); }

  private queueCleanup(scope:SceneScope, readers:Iterable<string>, version:number) {
    const put = this.db.prepare(`INSERT INTO scene_index_cleanup(scope,character,version) VALUES(?,?,?)
      ON CONFLICT(scope,character) DO UPDATE SET version=MAX(scene_index_cleanup.version,excluded.version)`);
    for (const reader of readers) put.run(scopeKey(scope), reader, version);
  }

  private transaction<T>(fn:()=>T):T {
    const savepoint = `scene_transfer_${++this.savepointSequence}`;
    const outer=!this.db.isTransaction;
    this.db.exec(outer?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);
    try { const value = fn(); this.db.exec(outer?'COMMIT':`RELEASE ${savepoint}`); return value; }
    catch (error) { this.db.exec(outer?'ROLLBACK':`ROLLBACK TO ${savepoint}`); if(!outer)this.db.exec(`RELEASE ${savepoint}`); throw error; }
  }
}

type ApplyGuard = OperationGuard & {previewId:string};
/** Deletion also removes the saved text when restoring an older backup. */
function redactReferenceCheckpoints(db:DatabaseSync,scope:SceneScope,id:string,tombstone:string):void {
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_checkpoints'").get())return;
  const rows=db.prepare('SELECT id,snapshot FROM scene_checkpoints WHERE scope=?').all(scopeKey(scope)) as {id:string;snapshot:string}[];
  for(const row of rows) {
    const snapshot=JSON.parse(row.snapshot) as {references?:PersistedReferenceRow[]};
    if(!snapshot.references?.some(reference=>reference.id===id))continue;
    snapshot.references=snapshot.references.map(reference=>reference.id===id?{id,body:tombstone,status:'deleted'}:reference);
    db.prepare('UPDATE scene_checkpoints SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),row.id);
  }
}
function validateGuard(value: unknown): asserts value is OperationGuard {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger((value as OperationGuard).expectedVersion) ||
    (value as OperationGuard).expectedVersion < 0 || typeof (value as OperationGuard).operationId !== 'string' ||
    !(value as OperationGuard).operationId || (value as OperationGuard).operationId.length > MAX_OPERATION_ID) throw new Error('invalid_scene_operation');
}

function validateDocument(value: unknown, currentRoster:SceneRoster): SceneTransferDocument {
  const input = exactObject(value, ['format', 'name', 'roster', 'worldSettings', 'rows']);
  if (input.format === 'xldb-scene-template-v1') {
    if (Object.prototype.hasOwnProperty.call(input, 'rows')) throw new Error('invalid_scene_transfer_document');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new Error('invalid_scene_template_name');
    const roster = validateRoster(input.roster);
    const worldSettings = validateWorld(input.worldSettings);
    validateWorldIdentities(worldSettings, roster);
    return {format: input.format, name: input.name, roster, worldSettings};
  }
  if (input.format === 'xldb-reference-import-v1') {
    if (Object.keys(input).some(key => !['format', 'rows'].includes(key)) || !Array.isArray(input.rows) || input.rows.length > MAX_ROWS) throw new Error('invalid_scene_reference_import');
    const characterIds = new Set(currentRoster.characters.map(character => character.id));
    const identities = new Set<string>();
    const rows = input.rows.map(value => validateReferenceRow(value, characterIds, identities));
    return {format: input.format, rows};
  }
  throw new Error('invalid_scene_transfer_document');
}

function validateRoster(value:unknown):SceneRoster {
  const roster = exactObject(value, ['characters']);
  if(!Array.isArray(roster.characters))throw new Error('invalid_scene_roster');
  for(const character of roster.characters)exactObject(character,['id','name','aliases','persona','emotion','identitySource']);
  return rosterOf(roster);
}

function validateWorld(value:unknown):WorldSettings|null {
  if (value === null) return null;
  const settings = exactObject(value, ['mode', 'startTimeMs', 'actorLabels', 'playerName', 'publicTime', 'balances', 'inventory']);
  if (!['story','companion'].includes(settings.mode as string) || !Number.isSafeInteger(settings.startTimeMs) || settings.startTimeMs < 0 ||
    !short(settings.playerName) || typeof settings.publicTime !== 'boolean' || !plainObject(settings.actorLabels) ||
    !Array.isArray(settings.balances) || !Array.isArray(settings.inventory)) throw new Error('invalid_scene_world_settings');
  for (const [id,labels] of Object.entries(settings.actorLabels)) if (!short(id) || !Array.isArray(labels) || labels.some(label => !short(label))) throw new Error('invalid_scene_world_settings');
  for (const balance of settings.balances) exactObject(balance, ['ownerId','unit','value','readerIds']);
  for (const inventory of settings.inventory) exactObject(inventory, ['ownerId','item','count','readerIds']);
  try { foldWorldState(clone(settings) as WorldSettings, []); } catch { throw new Error('invalid_scene_world_settings'); }
  return clone(settings) as WorldSettings;
}

function validateWorldIdentities(settings:WorldSettings|null, roster:SceneRoster):void {
  if (!settings) return;
  const identities = new Set(['player', ...roster.characters.map(character => character.id)]);
  const valid = (id:unknown) => typeof id === 'string' && identities.has(id);
  if (Object.keys(settings.actorLabels).some(id => !valid(id)) ||
    settings.balances.some(balance => !valid(balance.ownerId) || (balance.readerIds ?? []).some(reader => !valid(reader))) ||
    settings.inventory.some(item => !valid(item.ownerId) || (item.readerIds ?? []).some(reader => !valid(reader)))) throw new Error('invalid_scene_world_actor');
}

function validateReferenceRow(value:unknown, characterIds:Set<string>, identities:Set<string>):ReferenceImportRow {
  const row = exactObject(value, ['table','row','text','knownBy','occurredAtMs']);
  if (!short(row.table) || !short(row.row) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > MAX_TEXT ||
    (row.occurredAtMs !== undefined && row.occurredAtMs !== null && (!Number.isSafeInteger(row.occurredAtMs) || row.occurredAtMs < 0)) ||
    (row.knownBy !== undefined && (!Array.isArray(row.knownBy) || row.knownBy.some(id => !short(id) || !characterIds.has(id))))) throw new Error('invalid_scene_reference_import');
  const identity = `${row.table}\u0000${row.row}`;
  if (identities.has(identity)) throw new Error('duplicate_scene_reference_row');
  identities.add(identity);
  return {table:row.table, row:row.row, text:row.text, ...(row.knownBy === undefined ? {} : {knownBy:[...row.knownBy]}),
    ...(row.occurredAtMs === undefined ? {} : {occurredAtMs:row.occurredAtMs})};
}

function templateConflicts(state:ReturnType<SceneAuthority['state']>, current:WorldSettings|null, template:SceneTemplate) {
  const settingsChanged = canonical(current) !== canonical(template.worldSettings);
  if (settingsChanged && state.sources.some(source => source.status === 'accepted')) return [{code:'invalid_template_world_history'}];
  return [] as {code:string}[];
}

function templateDiff(currentRoster:SceneRoster,currentSettings:WorldSettings|null,template:SceneTemplate) {
  return {roster: canonical(currentRoster) === canonical(template.roster) ? 'unchanged' : 'changed',
    worldSettings: canonical(currentSettings) === canonical(template.worldSettings) ? 'unchanged' : 'changed'};
}

function importDiff(scope:SceneScope, document:ReferenceImport, db:DatabaseSync) {
  let existing = 0;
  let tombstoned = 0;
  const prior=referenceRowsByIdentity(db,scope),conflicts:{code:string;table:string;row:string}[]=[];
  for (const row of document.rows) {
    const found = prior.get(rowIdentity(row));
    if (found?.status === 'deleted') tombstoned++;
    else if (found) {
      existing++;
      if(canonical({text:row.text,knownBy:[...(row.knownBy??[])].sort(),occurredAtMs:row.occurredAtMs??null})!==
        canonical({text:found.value.text,knownBy:[...found.value.knownBy].sort(),occurredAtMs:found.value.occurredAtMs}))
        conflicts.push({code:'invalid_scene_reference_conflict',table:row.table,row:row.row});
    }
  }
  return {rows: document.rows.length, new: document.rows.length-existing-tombstoned, existing, tombstoned,conflicts};
}

function rowIdentity(row:{table:string;row:string}):string { return JSON.stringify([row.table,row.row]); }
function referenceRowsByIdentity(db:DatabaseSync,scope:SceneScope) {
  const result=new Map<string,{status:string;value:Omit<SceneReference,'id'>}>();
  for(const row of captureReferenceRows(db,scope)) {
    const value=parseReference(row.body),key=rowIdentity(value);
    if(result.get(key)?.status!=='deleted')result.set(key,{status:row.status,value});
  }
  return result;
}

function referenceWarnings(rows:readonly ReferenceImportRow[]) {
  const tables = [...new Set(rows.map(row => row.table).filter(table => !KNOWN_REFERENCE_TABLES.has(table)))];
  return tables.map(table => ({code:'reference_table_mapped_as_provenance_only', table}));
}

function parseReference(serialized:string):Omit<SceneReference,'id'> {
  const value = JSON.parse(serialized) as Record<string,unknown>;
  if (typeof value.text !== 'string' || !Array.isArray(value.knownBy) || value.knownBy.some(id => typeof id !== 'string') ||
    (value.occurredAtMs !== null && (!Number.isSafeInteger(value.occurredAtMs) || (value.occurredAtMs as number) < 0)) ||
    !isHash(value.fileHash) || !short(value.table) || !short(value.row) || !Number.isSafeInteger(value.importedAtMs)) throw new Error('invalid_scene_reference');
  return {text:value.text, knownBy:[...value.knownBy] as string[], occurredAtMs:value.occurredAtMs as number|null,
    fileHash:value.fileHash, table:value.table, row:value.row, importedAtMs:value.importedAtMs as number};
}

function exactObject(value:unknown, allowed:string[]):Record<string,any> {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('invalid_scene_transfer_document');
  return value as Record<string,any>;
}
function plainObject(value:unknown):value is Record<string,unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function short(value:unknown):value is string { return typeof value === 'string' && !!value.trim() && value.length <= MAX_IDENTIFIER; }
function isHash(value:unknown):value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function canonical(value:unknown):string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function hash(value:unknown):string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function clone<T>(value:T):T { return JSON.parse(JSON.stringify(value)) as T; }
