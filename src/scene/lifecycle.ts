import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { scopeKey } from '../core/types.ts';
import type { SceneScope } from './types.ts';
import {captureReferenceRows,restoreReferenceRows} from './transfer.ts';
import type {PersistedReferenceRow} from './transfer.ts';
import {captureCalendarTodoRows,captureCalendarAckRows,restoreCalendarRows} from './calendar-store.ts';
import type {PersistedCalendarTodoRow,PersistedCalendarAckRow} from './calendar-store.ts';

export interface SceneLifecycleCheckpoint {
  id: string;
  createdAt: string;
  reason: string;
  automatic: boolean;
  consumedAt?: string;
}

interface WorldRow {
  scope: string;
  roster: string;
  created: number;
}

interface SourceRow {
  id: string;
  revision: number;
  message: string;
  observed: number;
  status: string;
  processing: string;
  analysis: string | null;
}

interface ControlRow {
  character: string;
  id: string;
  revision: number;
  access: string;
}

interface WorldSettingsRow {
  settings: string;
  clockFloor: number;
}

interface CompanionPresetRow {
  presetId:string;revision:number;documentHash:string;document:string;status:string;generation:number;
  claimToken:string|null;leaseUntil:number|null;details:string|null;persona:string|null;characterId:string|null;
  error:string|null;imported:number;updated:number;
}

interface SceneCheckpointSnapshot {
  schema: 1;
  world: WorldRow;
  sources: SourceRow[];
  controls: ControlRow[];
  preferenceControls?: {character:string;id:string;body:string}[];
  physiologySettings?: {revision:number;body:string}|null;
  physiologyCorrections?: {id:string;character:string;body:string}[];
  geographySettings?: {revision:number;body:string}|null;
  geographyMaps?: {mapId:string;documentRevision:number;documentHash:string;basis:string;body:string;imported:number}[];
  geographyCorrections?: {id:string;body:string}[];
  geographyLayouts?: {reader:string;revision:number;body:string}[];
  worldSettings: WorldSettingsRow | null;
  references?:PersistedReferenceRow[];
  calendarTodos?:PersistedCalendarTodoRow[];
  calendarReminderAcks?:PersistedCalendarAckRow[];
  companionPreset?:CompanionPresetRow|null;
}

interface StoredCheckpoint {
  id: string;
  scope: string;
  snapshot: string;
}

function rosterCharacterIds(serialized: string): string[] {
  const value = JSON.parse(serialized) as { characters?: unknown };
  if (!Array.isArray(value.characters) || value.characters.some(character =>
    !character || typeof character !== 'object' || typeof (character as { id?: unknown }).id !== 'string'
    || !(character as { id: string }).id)) throw new Error('invalid_scene_checkpoint');
  return value.characters.map(character => (character as { id: string }).id);
}

/** Immutable full-scope checkpoints for undo, rollback, and branch forks. */
export class SceneLifecycle {
  private db: DatabaseSync;
  private savepointSequence = 0;
  private rebuildEmotionStates?: (scope: SceneScope) => void;

  constructor(db: DatabaseSync, rebuildEmotionStates?: (scope: SceneScope) => void) {
    this.db = db;
    this.rebuildEmotionStates = rebuildEmotionStates;
    db.exec(`CREATE TABLE IF NOT EXISTS scene_checkpoints (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL REFERENCES scene_worlds(key),
      created TEXT NOT NULL,
      reason TEXT NOT NULL,
      automatic INTEGER NOT NULL,
      consumed_at TEXT,
      snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS scene_checkpoints_scope_created
      ON scene_checkpoints(scope,created);`);
  }

  checkpoint(
    scope: SceneScope,
    reason: string,
    options: { automatic?: boolean } = {},
  ): { id: string; createdAt: string } {
    if (!reason.trim()) throw new Error('invalid_scene_checkpoint_reason');
    return this.transaction(() => {
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const snapshot = this.capture(scope);
      this.db.prepare(`INSERT INTO scene_checkpoints
        (id,scope,created,reason,automatic,consumed_at,snapshot) VALUES(?,?,?,?,?,NULL,?)`)
        .run(id, scopeKey(scope), createdAt, reason, options.automatic === true ? 1 : 0, JSON.stringify(snapshot));
      return { id, createdAt };
    });
  }

  list(scope: SceneScope): SceneLifecycleCheckpoint[] {
    const rows = this.db.prepare(`SELECT id,created,reason,automatic,consumed_at
      FROM scene_checkpoints WHERE scope=? ORDER BY rowid DESC`).all(scopeKey(scope)) as {
        id: string;
        created: string;
        reason: string;
        automatic: number;
        consumed_at: string | null;
      }[];
    return rows.map(row => ({
      id: row.id,
      createdAt: row.created,
      reason: row.reason,
      automatic: row.automatic === 1,
      ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    }));
  }

  preview(scope:SceneScope,checkpointId?:string) {
    const live=this.capture(scope),key=scopeKey(scope);
    const version=(this.db.prepare('SELECT version FROM scene_worlds WHERE key=?').get(key) as {version:number}).version;
    const checkpoint=checkpointId===undefined?this.db.prepare(`SELECT id,scope,snapshot FROM scene_checkpoints
      WHERE scope=? AND automatic=1 AND consumed_at IS NULL ORDER BY rowid DESC LIMIT 1`).get(key) as StoredCheckpoint|undefined
      :this.storedCheckpoint(scope,checkpointId);
    if(!checkpoint)return {version,checkpointId:null,changes:{added:[],removed:[],changed:[]},rosterChanged:false,worldChanged:false,unchanged:true};
    const target=this.withCurrentTombstones(scope,JSON.parse(checkpoint.snapshot) as SceneCheckpointSnapshot);
    const visible=(rows:SourceRow[])=>rows.filter(row=>row.status!=='deleted');
    const before=new Map(visible(live.sources).map(row=>[row.id,row]));
    const after=new Map(visible(target.sources).map(row=>[row.id,row]));
    const beforeReferences=(live.references??[]).filter(row=>row.status==='accepted');
    const afterReferences=(target.references??live.references??[]).filter(row=>row.status==='accepted');
    return {scope,version,checkpointId:checkpoint.id,references:{before:beforeReferences.length,after:afterReferences.length,
      removed:beforeReferences.filter(row=>!afterReferences.some(item=>item.id===row.id)).map(row=>row.id)},changes:{
      added:[...after.keys()].filter(id=>!before.has(id)),removed:[...before.keys()].filter(id=>!after.has(id)),
      changed:[...after.keys()].filter(id=>before.has(id)&&JSON.stringify(before.get(id))!==JSON.stringify(after.get(id)))},
      rosterChanged:live.world.roster!==target.world.roster,worldChanged:JSON.stringify(live.worldSettings)!==JSON.stringify(target.worldSettings),
      unchanged:false,notice:'预览不写入。确认后替换当前分支的受管正文与派生状态；已删除资料仍受删除规则约束。'};
  }

  restore(scope: SceneScope, checkpointId: string,expectedVersion?:number): void {
    this.transaction(() => {
      this.checkVersion(scope,expectedVersion);
      const checkpoint = this.storedCheckpoint(scope, checkpointId);
      this.restoreSnapshot(scope, JSON.parse(checkpoint.snapshot) as SceneCheckpointSnapshot);
      this.rebuildEmotionStates?.(scope);
      this.redactUnsafeCheckpoints(scope, this.deletedSourceIds(scope));
      const consumedAt = new Date().toISOString();
      this.db.prepare(`UPDATE scene_checkpoints SET consumed_at=?
        WHERE scope=? AND automatic=1 AND consumed_at IS NULL`).run(consumedAt, scopeKey(scope));
    });
  }

  undo(scope: SceneScope,expectedVersion?:number,expectedCheckpointId?:string): { checkpointId: string } | null {
    return this.transaction(() => {
      this.checkVersion(scope,expectedVersion);
      const checkpoint = this.db.prepare(`SELECT id,scope,snapshot FROM scene_checkpoints
        WHERE scope=? AND automatic=1 AND consumed_at IS NULL ORDER BY rowid DESC LIMIT 1`)
        .get(scopeKey(scope)) as StoredCheckpoint | undefined;
      if(expectedCheckpointId!==undefined&&checkpoint?.id!==expectedCheckpointId)throw new Error('context_changed_retry');
      if (!checkpoint) return null;
      this.restoreSnapshot(scope, JSON.parse(checkpoint.snapshot) as SceneCheckpointSnapshot);
      this.rebuildEmotionStates?.(scope);
      this.redactUnsafeCheckpoints(scope, this.deletedSourceIds(scope));
      this.db.prepare('UPDATE scene_checkpoints SET consumed_at=? WHERE id=?')
        .run(new Date().toISOString(), checkpoint.id);
      return { checkpointId: checkpoint.id };
    });
  }

  fork(scope: SceneScope, newBranchId: string, checkpointId?: string): SceneScope {
    if (!newBranchId.trim() || newBranchId.length > 200) throw new Error('invalid_scene_branch');
    return this.transaction(() => {
      const target = { ...scope, branchId: newBranchId };
      if (this.db.prepare('SELECT 1 FROM scene_worlds WHERE key=?').get(scopeKey(target))) {
        throw new Error('scene_branch_exists');
      }
      let snapshot = checkpointId === undefined
        ? this.capture(scope)
        : JSON.parse(this.storedCheckpoint(scope, checkpointId).snapshot) as SceneCheckpointSnapshot;
      snapshot = this.withCurrentTombstones(scope, snapshot);
      this.insertFork(target, snapshot);
      this.rebuildEmotionStates?.(target);
      this.redactUnsafeCheckpoints(scope, this.deletedSourceIds(scope));
      return target;
    });
  }

  /** A deletion is an erasure boundary, so retained checkpoints cannot replay it. */
  redactUnsafeCheckpoints(scope: SceneScope, sourceIds: Iterable<string>): void {
    const deleted = new Set(sourceIds);
    if (!deleted.size) return;
    const checkpoints = this.db.prepare('SELECT id,snapshot FROM scene_checkpoints WHERE scope=?')
      .all(scopeKey(scope)) as { id: string; snapshot: string }[];
    for (const checkpoint of checkpoints) {
      if (!this.snapshotReferencesDeletedSource(checkpoint.snapshot, deleted)) continue;
      this.db.prepare('DELETE FROM scene_checkpoints WHERE id=?').run(checkpoint.id);
    }
  }

  private capture(scope: SceneScope): SceneCheckpointSnapshot {
    const key = scopeKey(scope);
    const world = this.db.prepare('SELECT scope,roster,created FROM scene_worlds WHERE key=?').get(key) as WorldRow | undefined;
    if (!world) throw new Error('invalid_scene_not_configured');
    const sources = this.db.prepare(`SELECT id,revision,message,observed,status,processing,analysis
      FROM scene_sources WHERE scope=? ORDER BY rowid`).all(key) as unknown as SourceRow[];
    const controls = this.db.prepare(`SELECT character,id,revision,access
      FROM scene_controls WHERE scope=? ORDER BY rowid`).all(key) as unknown as ControlRow[];
    const settings = this.db.prepare(`SELECT settings,clock_floor AS clockFloor
      FROM scene_world_settings WHERE scope=?`).get(key) as WorldSettingsRow | undefined;
    const preferenceControls=this.db.prepare('SELECT character,id,body FROM scene_preference_controls WHERE scope=? ORDER BY rowid').all(key) as {character:string;id:string;body:string}[];
    const physiologySettings=this.db.prepare('SELECT revision,body FROM scene_physiology_settings WHERE scope=?').get(key) as {revision:number;body:string}|undefined;
    const physiologyCorrections=this.db.prepare('SELECT id,character,body FROM scene_physiology_corrections WHERE scope=? ORDER BY rowid').all(key) as {id:string;character:string;body:string}[];
    const geographySettings=this.db.prepare('SELECT revision,body FROM scene_geography_settings WHERE scope=?').get(key) as {revision:number;body:string}|undefined;
    const geographyMaps=this.db.prepare(`SELECT map_id AS mapId,document_revision AS documentRevision,document_hash AS documentHash,basis,body,imported
      FROM scene_geography_maps WHERE scope=? ORDER BY rowid`).all(key) as unknown as {mapId:string;documentRevision:number;documentHash:string;basis:string;body:string;imported:number}[];
    const geographyCorrections=this.db.prepare('SELECT id,body FROM scene_geography_corrections WHERE scope=? ORDER BY rowid').all(key) as {id:string;body:string}[];
    const geographyLayouts=this.db.prepare('SELECT reader,revision,body FROM scene_geography_layouts WHERE scope=? ORDER BY rowid').all(key) as {reader:string;revision:number;body:string}[];
    const companionPreset=this.db.prepare(`SELECT preset_id AS presetId,revision,document_hash AS documentHash,document,status,generation,
      claim_token AS claimToken,lease_until AS leaseUntil,details,persona,character_id AS characterId,error,imported,updated
      FROM scene_companion_presets WHERE scope=?`).get(key) as CompanionPresetRow|undefined;
    return { schema: 1, world, sources, controls, preferenceControls,physiologySettings:physiologySettings??null,physiologyCorrections,
      geographySettings:geographySettings??null,geographyMaps,geographyCorrections,geographyLayouts,
      references:captureReferenceRows(this.db,scope),calendarTodos:captureCalendarTodoRows(this.db,scope),
      calendarReminderAcks:captureCalendarAckRows(this.db,scope),
      worldSettings: settings ?? null,companionPreset:companionPreset??null };
  }

  private checkVersion(scope:SceneScope,expectedVersion?:number):void {
    if(expectedVersion===undefined)return;
    const live=this.db.prepare('SELECT version FROM scene_worlds WHERE key=?').get(scopeKey(scope)) as {version:number}|undefined;
    if(live?.version!==expectedVersion)throw new Error('context_changed_retry');
  }

  private storedCheckpoint(scope: SceneScope, checkpointId: string): StoredCheckpoint {
    const checkpoint = this.db.prepare('SELECT id,scope,snapshot FROM scene_checkpoints WHERE id=?')
      .get(checkpointId) as StoredCheckpoint | undefined;
    if (!checkpoint) throw new Error('scene_checkpoint_not_found');
    if (checkpoint.scope !== scopeKey(scope)) throw new Error('invalid_scene_checkpoint_scope');
    return checkpoint;
  }

  private restoreSnapshot(scope: SceneScope, snapshot: SceneCheckpointSnapshot): void {
    const key = scopeKey(scope);
    const live = this.db.prepare('SELECT version,roster FROM scene_worlds WHERE key=?').get(key) as { version: number; roster: string } | undefined;
    if (!live) throw new Error('invalid_scene_not_configured');
    if (snapshot.schema !== 1) throw new Error('invalid_scene_checkpoint');
    snapshot = this.withCurrentTombstones(scope, snapshot);
    this.db.prepare('DELETE FROM scene_processing_stages WHERE scope=?').run(key);
    if(snapshot.references!==undefined)restoreReferenceRows(this.db,scope,snapshot.references,{replaceAccepted:true});
    const cleanupCharacters = new Set([...rosterCharacterIds(live.roster), ...rosterCharacterIds(snapshot.world.roster)]);
    this.db.prepare('DELETE FROM scene_sources WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_controls WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_preference_controls WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_physiology_corrections WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_physiology_settings WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_geography_settings WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_geography_maps WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_geography_corrections WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_geography_layouts WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_geography_write_operations WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM scene_world_settings WHERE scope=?').run(key);
    // Legacy snapshots did not carry preset state; only a snapshot that explicitly
    // owns this field may replace or remove the current preset instance.
    if(snapshot.companionPreset!==undefined)this.db.prepare('DELETE FROM scene_companion_presets WHERE scope=?').run(key);
    this.db.prepare('UPDATE scene_worlds SET scope=?,roster=?,version=?,created=? WHERE key=?')
      .run(snapshot.world.scope, snapshot.world.roster, live.version + 1, snapshot.world.created, key);
    this.insertChildren(key, snapshot);
    this.recordIndexCleanup(scope, cleanupCharacters, live.version + 1);
  }

  private recordIndexCleanup(scope: SceneScope, characters: Iterable<string>, version: number): void {
    const record = this.db.prepare(`INSERT INTO scene_index_cleanup(scope,character,version) VALUES(?,?,?)
      ON CONFLICT(scope,character) DO UPDATE SET version=MAX(scene_index_cleanup.version,excluded.version)`);
    for (const character of characters) record.run(scopeKey(scope), character, version);
  }

  private insertFork(scope: SceneScope, snapshot: SceneCheckpointSnapshot): void {
    if (snapshot.schema !== 1) throw new Error('invalid_scene_checkpoint');
    const key = scopeKey(scope);
    this.db.prepare('INSERT INTO scene_worlds(key,scope,roster,version,created) VALUES(?,?,?,?,?)')
      .run(key, JSON.stringify(scope), snapshot.world.roster, 1, snapshot.world.created);
    this.insertChildren(key, snapshot);
  }

  private insertChildren(key: string, snapshot: SceneCheckpointSnapshot): void {
    const [worldId,sessionId,branchId,characterId]=JSON.parse(key) as string[];
    restoreReferenceRows(this.db,{worldId:worldId!,sessionId:sessionId!,branchId:branchId!,characterId:characterId!},snapshot.references??[]);
    if(snapshot.calendarTodos!==undefined||snapshot.calendarReminderAcks!==undefined)
      restoreCalendarRows(this.db,{worldId:worldId!,sessionId:sessionId!,branchId:branchId!,characterId:characterId!},
        snapshot.calendarTodos??[],snapshot.calendarReminderAcks??[]);
    const insertSource = this.db.prepare(`INSERT INTO scene_sources
      (scope,id,revision,message,observed,status,processing,analysis) VALUES(?,?,?,?,?,?,?,?)`);
    for (const row of snapshot.sources) {
      insertSource.run(key, row.id, row.revision, row.message, row.observed, row.status, row.processing, row.analysis);
    }
    const insertControl = this.db.prepare(`INSERT INTO scene_controls
      (scope,character,id,revision,access) VALUES(?,?,?,?,?)`);
    for (const row of snapshot.controls) {
      insertControl.run(key, row.character, row.id, row.revision, row.access);
    }
    for(const row of snapshot.preferenceControls??[])this.db.prepare('INSERT INTO scene_preference_controls VALUES(?,?,?,?)').run(key,row.character,row.id,row.body);
    if(snapshot.physiologySettings)this.db.prepare('INSERT INTO scene_physiology_settings VALUES(?,?,?)')
      .run(key,snapshot.physiologySettings.revision,snapshot.physiologySettings.body);
    for(const row of snapshot.physiologyCorrections??[])this.db.prepare('INSERT INTO scene_physiology_corrections VALUES(?,?,?,?)')
      .run(key,row.id,row.character,row.body);
    if(snapshot.geographySettings)this.db.prepare('INSERT INTO scene_geography_settings VALUES(?,?,?)')
      .run(key,snapshot.geographySettings.revision,snapshot.geographySettings.body);
    for(const row of snapshot.geographyMaps??[])this.db.prepare('INSERT INTO scene_geography_maps VALUES(?,?,?,?,?,?,?)')
      .run(key,row.mapId,row.documentRevision,row.documentHash,row.basis,row.body,row.imported);
    for(const row of snapshot.geographyCorrections??[])this.db.prepare('INSERT INTO scene_geography_corrections VALUES(?,?,?)')
      .run(key,row.id,row.body);
    for(const row of snapshot.geographyLayouts??[])this.db.prepare('INSERT INTO scene_geography_layouts VALUES(?,?,?,?)')
      .run(key,row.reader,row.revision,row.body);
    if (snapshot.worldSettings) {
      this.db.prepare(`INSERT INTO scene_world_settings(scope,settings,clock_floor) VALUES(?,?,?)`)
        .run(key, snapshot.worldSettings.settings, snapshot.worldSettings.clockFloor);
    }
    if(snapshot.companionPreset){
      const row=snapshot.companionPreset;
      this.db.prepare(`INSERT INTO scene_companion_presets
        (scope,preset_id,revision,document_hash,document,status,generation,claim_token,lease_until,details,persona,character_id,error,imported,updated)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(key,row.presetId,row.revision,row.documentHash,row.document,row.status,row.generation,row.claimToken,row.leaseUntil,
          row.details,row.persona,row.characterId,row.error,row.imported,row.updated);
    }
  }

  private deletedSourceIds(scope: SceneScope): string[] {
    return (this.db.prepare("SELECT id FROM scene_sources WHERE scope=? AND status='deleted'")
      .all(scopeKey(scope)) as { id: string }[]).map(row => row.id);
  }

  private withCurrentTombstones(scope: SceneScope, value: SceneCheckpointSnapshot): SceneCheckpointSnapshot {
    const snapshot = structuredClone(value);
    if(snapshot.references!==undefined) {
      const references=new Map(snapshot.references.map(row=>[row.id,row]));
      for(const row of captureReferenceRows(this.db,scope))if(row.status==='deleted')references.set(row.id,row);
      snapshot.references=[...references.values()];
    }
    const key = scopeKey(scope);
    const tombstones = this.db.prepare(`SELECT id,revision,message,observed,status,processing,analysis
      FROM scene_sources WHERE scope=? AND status='deleted' ORDER BY rowid`).all(key) as unknown as SourceRow[];
    if (!tombstones.length) return snapshot;
    const changes: { index: number; characters: Set<string> }[] = [];
    for (const tombstone of tombstones) {
      snapshot.preferenceControls=snapshot.preferenceControls?.filter(control=>control.id.slice(0,control.id.lastIndexOf(':pref:@'))!==tombstone.id);
      const index = snapshot.sources.findIndex(source => source.id === tombstone.id);
      const prior = index < 0 ? undefined : snapshot.sources[index];
      if (index >= 0 && prior?.status === 'accepted') {
        changes.push({ index, characters: this.analysisCharacters(prior.analysis) });
      }
      const revision = Math.max(tombstone.revision, prior && prior.status !== 'deleted' ? prior.revision + 1 : prior?.revision ?? 0);
      const redacted: SourceRow = {
        ...tombstone,
        revision,
        message: this.redactedMessage(tombstone.message, revision),
        status: 'deleted',
        processing: 'ready',
        analysis: null,
      };
      if (index < 0) snapshot.sources.push(redacted);
      else snapshot.sources[index] = redacted;
    }
    this.invalidateSnapshotDependents(snapshot, changes);
    this.invalidateSnapshotCausalSuffix(snapshot, changes);
    return snapshot;
  }

  private redactedMessage(serialized: string, revision: number): string {
    const message = JSON.parse(serialized) as Record<string, unknown>;
    message.revision = revision;
    message.text = '';
    message.dependencies = [];
    delete message.analysis;
    return JSON.stringify(message);
  }

  private invalidateSnapshotDependents(
    snapshot: SceneCheckpointSnapshot,
    changes: { index: number; characters: Set<string> }[],
  ): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const source of snapshot.sources) {
        if (source.status !== 'accepted') continue;
        const message = JSON.parse(source.message) as { dependencies?: { id?: string; revision?: number }[] };
        const valid = (message.dependencies ?? []).every(dependency => snapshot.sources.some(origin =>
          origin.id === dependency.id && origin.revision === dependency.revision && origin.status === 'accepted'));
        if (valid) continue;
        changes.push({ index: snapshot.sources.indexOf(source), characters: this.analysisCharacters(source.analysis) });
        source.status = 'needs_review';
        source.processing = 'failed';
        source.analysis = null;
        changed = true;
      }
    }
  }

  /** Re-analysis is causal even when the later source has no explicit source link. */
  private invalidateSnapshotCausalSuffix(
    snapshot: SceneCheckpointSnapshot,
    changes: { index: number; characters: Set<string> }[],
  ): void {
    if (!changes.length) return;
    const hasWorld = snapshot.worldSettings !== null;
    for (const [index, source] of snapshot.sources.entries()) {
      if (source.status !== 'accepted' || !source.analysis) continue;
      const characters = this.analysisCharacters(source.analysis);
      if (!changes.some(change => change.index < index &&
        (hasWorld || [...characters].some(character => change.characters.has(character))))) continue;
      source.processing = 'pending';
      source.analysis = this.withoutEmotionStates(source.analysis);
      const message = JSON.parse(source.message) as {
        envelope?: { targetId?: string; presentIds?: string[] };
        speakerId?: string;
      };
      changes.push({
        index,
        characters: new Set([
          ...characters,
          message.envelope?.targetId ?? '',
          ...(message.envelope?.presentIds ?? []),
          ...(message.speakerId ? [message.speakerId] : []),
        ].filter(Boolean)),
      });
    }
  }

  private analysisCharacters(analysis: string | null): Set<string> {
    if (!analysis) return new Set();
    const value = JSON.parse(analysis) as { characters?: Record<string, unknown> };
    return new Set(Object.keys(value.characters ?? {}));
  }

  private withoutEmotionStates(analysis: string | null): string | null {
    if (!analysis) return null;
    const value = JSON.parse(analysis) as Record<string, unknown>;
    delete value.emotionStates;
    return JSON.stringify(value);
  }

  private snapshotReferencesDeletedSource(serialized: string, deleted: Set<string>): boolean {
    try {
      const snapshot = JSON.parse(serialized) as SceneCheckpointSnapshot;
      if (snapshot.schema !== 1 || !Array.isArray(snapshot.sources)) return true;
      const unsafe = new Set(snapshot.sources
        .filter(source => typeof source.id === 'string' && deleted.has(source.id) && source.status !== 'deleted')
        .map(source => source.id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const source of snapshot.sources) {
          if (source.status !== 'accepted' || typeof source.id !== 'string' || unsafe.has(source.id)) continue;
          const message = JSON.parse(source.message) as { dependencies?: { id?: string }[] };
          if (!(message.dependencies ?? []).some(dependency => typeof dependency.id === 'string' &&
            (deleted.has(dependency.id) || unsafe.has(dependency.id)))) continue;
          unsafe.add(source.id);
          changed = true;
        }
      }
      return unsafe.size > 0;
    } catch { return true; }
  }

  private transaction<T>(action: () => T): T {
    const savepoint = `scene_lifecycle_${++this.savepointSequence}`;
    const outer=!this.db.isTransaction;
    this.db.exec(outer?'BEGIN IMMEDIATE':`SAVEPOINT ${savepoint}`);
    try {
      const result = action();
      this.db.exec(outer?'COMMIT':`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(outer?'ROLLBACK':`ROLLBACK TO ${savepoint}`);
      if(!outer)this.db.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }
}
