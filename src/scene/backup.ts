import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';
import { advanceEmotion, createEmotion, validateEmotionState } from '../emotion/openher.ts';
import type { EmotionDelta } from '../emotion/openher.ts';
import {isSourceControl,memoryAccesses,preferenceOverrides} from '../core/controls.ts';
import type {StoredControl} from '../core/controls.ts';
import type {MemoryCandidate,PreferenceCandidate} from '../core/types.ts';
import {scopeKey} from '../core/types.ts';
import {Commitments} from '../commitments/store.ts';
import type {CommitmentSource} from '../commitments/types.ts';
import {CompanionStore} from '../companion/store.ts';
import {RelationshipAssessmentStore} from '../companion/relationship-assessment.ts';
import {ensureUserModelSchema} from '../user-model/schema.ts';
import {SceneDirector} from './director.ts';
import {SceneInteractions} from './interaction.ts';
import {captureReferenceRows,restoreReferenceRows} from './transfer.ts';
import type {PersistedReferenceRow} from './transfer.ts';
import type {SceneScope} from './types.ts';

export interface BackupManifest {
  schemaVersion: number;
  sha256: string;
  createdAt: string;
}

export interface BackupResult {
  directory: string;
  databasePath: string;
  manifestPath: string;
  manifest: BackupManifest;
}

export interface RestoreResult {
  databasePath: string;
  recoveryDirectory: string | null;
  appliedDeletionCount: number;
  deletionRules: 'target' | 'backup_only';
}

export interface RestoreOptions {
  mode?: 'rollback' | 'recovery';
}

export interface AuthorityLease {
  release(): void;
}

type LeaseOwner = 'server' | 'restore' | 'recovery';

interface LeaseRecord {
  protocol: 1;
  owner: LeaseOwner;
  pid: number;
  nonce: string;
  acquiredAt: string;
}

interface HeldServerLease {
  active: string;
  record: LeaseRecord;
  references: number;
}

interface CoreDeletion {
  scope: string;
  id: string;
  revision: number;
  role: string;
  text: string;
  hash: string;
  accepted: number;
  observed: number;
  status: string;
  payload: string | null;
}

interface SceneDeletion {
  scope: string;
  id: string;
  revision: number;
  message: string;
  observed: number;
  status: string;
  processing: string;
  analysis: string | null;
}

interface RestoreRules {
  coreDeletions: CoreDeletion[];
  sceneDeletions: SceneDeletion[];
  coreVersions: Map<string, number>;
  sceneVersions: Map<string, number>;
  sceneWorlds: {key:string;version:number;characters:string[]}[];
  sceneIndexCleanup: {scope:string;character:string;version:number}[];
  referenceDeletions:{scope:SceneScope;rows:PersistedReferenceRow[]}[];
  targetControls:TargetControlRows;
}

type SqlValue=string|number|bigint|Uint8Array|null;
type SqlRow=Record<string,SqlValue>;

interface TargetControlRows {
  core:SqlRow[];
  sceneAccess:SqlRow[];
  scenePreferences:SqlRow[];
  subjectBindings:SqlRow[];
  profileControls:SqlRow[];
  profileOverrides:SqlRow[];
  profileFeedback:SqlRow[];
  profileContactPauses:SqlRow[];
  contactSettings:SqlRow[];
  companionActivity:SqlRow[];
  companionStates:SqlRow[];
  companionOpportunities:SqlRow[];
  companionReceipts:SqlRow[];
  relationshipCorrections:SqlRow[];
  interactions:SqlRow[];
  interactionBindings:SqlRow[];
}

interface CorePayload {
  memories: MemoryCandidate[];
  preferences: PreferenceCandidate[];
  emotion: EmotionDelta;
}

const workspaceRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const localRoot = path.join(workspaceRoot, '.local');
const heldServerLeases = new Map<string,HeldServerLease>();
const requiredTables = [
  'controls',
  'memories',
  'preferences',
  'scene_checkpoints',
  'scene_controls',
  'scene_sources',
  'scene_world_settings',
  'scene_worlds',
  'scopes',
  'sources',
] as const;

/** Claim a database before opening Authority, and release it after Authority closes. */
export function acquireAuthorityLease(databasePath: string, owner: LeaseOwner): AuthorityLease {
  const filename = localPath(databasePath);
  if (filename === localRoot) throw new Error('invalid_backup_path');
  const targetExists = fs.existsSync(filename);
  const held = owner === 'server' ? heldServerLeases.get(filename) : undefined;
  if (held) {
    held.references++;
    return serverLeaseHandle(filename,held);
  }
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  assertRealPath(path.dirname(filename));
  const guard = `${filename}.xldb-guard`;
  fs.mkdirSync(guard, { recursive: true });
  const protocol = path.join(guard, 'protocol-v1');
  if ((owner === 'restore' || (owner === 'recovery' && targetExists)) && !fs.existsSync(protocol)) throw new Error('backup_restore_guard_unavailable');
  if (!fs.existsSync(protocol)) {
    try { fs.writeFileSync(protocol, '1\n', { flag: 'wx' }); }
    catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
  }
  if (fs.readFileSync(protocol, 'utf8') !== '1\n') throw new Error('invalid_backup_guard_protocol');

  const active = path.join(guard, 'active');
  claimActive(active, guard);
  const record: LeaseRecord = { protocol: 1, owner, pid: process.pid, nonce: randomUUID(), acquiredAt: new Date().toISOString() };
  try {
    fs.writeFileSync(path.join(active, 'owner.json'), JSON.stringify(record) + '\n', { flag: 'wx' });
  } catch (error) {
    fs.rmdirSync(active);
    throw error;
  }
  if(owner==='server') {
    const next={active,record,references:1};
    heldServerLeases.set(filename,next);
    return serverLeaseHandle(filename,next);
  }
  let released = false;
  return { release() {
    if (released) return;
    const current = readLease(path.join(active, 'owner.json'));
    if (!current || current.nonce !== record.nonce) throw new Error('backup_lease_lost');
    fs.unlinkSync(path.join(active, 'owner.json'));
    fs.rmdirSync(active);
    released = true;
  } };
}

function serverLeaseHandle(filename:string,held:HeldServerLease):AuthorityLease {
  let released=false;
  return {release(){
    if(released)return;
    released=true;
    held.references--;
    if(held.references>0)return;
    heldServerLeases.delete(filename);
    const current=readLease(path.join(held.active,'owner.json'));
    if(!current||current.nonce!==held.record.nonce)throw new Error('backup_lease_lost');
    fs.unlinkSync(path.join(held.active,'owner.json'));
    fs.rmdirSync(held.active);
  }};
}

export async function createAuthorityBackup(databasePath: string, outputRoot = path.join(localRoot, 'backups')): Promise<BackupResult> {
  const sourcePath = existingLocalFile(databasePath);
  const root = localPath(outputRoot);
  fs.mkdirSync(root, { recursive: true });
  assertRealPath(root);
  const id = `${timestamp()}-${randomUUID()}`;
  const staging = path.join(root, `.pending-${id}`);
  const directory = path.join(root, id);
  fs.mkdirSync(staging, { recursive: false });
  const destination = path.join(staging, 'authority.sqlite');
  const manifestPath = path.join(staging, 'manifest.json');
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    await backup(source, destination);
  } catch (error) {
    removeStaging(staging);
    throw error;
  } finally {
    source?.close();
  }
  try {
    const copied=new DatabaseSync(destination);
    try { clearProcessingCandidates(copied);clearDirectorCache(copied);clearRelationshipModels(copied); } finally { copied.close(); }
    const schemaVersion = inspectDatabase(destination);
    const manifest: BackupManifest = {
      schemaVersion,
      sha256: await sha256(destination),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(staging, directory);
    return {
      directory,
      databasePath: path.join(directory, 'authority.sqlite'),
      manifestPath: path.join(directory, 'manifest.json'),
      manifest,
    };
  } catch (error) {
    removeStaging(staging);
    throw error;
  }
}

export async function restoreAuthorityBackup(
  backupDirectory: string,
  databasePath: string,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  const mode=options.mode??'rollback';
  if(mode!=='rollback'&&mode!=='recovery')throw new Error('invalid_restore_mode');
  const directory = existingLocalDirectory(backupDirectory);
  const source = existingLocalFile(path.join(directory, 'authority.sqlite'));
  const manifestPath = existingLocalFile(path.join(directory, 'manifest.json'));
  const manifest = readManifest(manifestPath);
  if (await sha256(source) !== manifest.sha256) throw new Error('backup_hash_mismatch');
  if (inspectDatabase(source) !== manifest.schemaVersion) throw new Error('backup_schema_mismatch');

  const target = mode==='rollback' ? existingLocalFile(databasePath) : localPath(databasePath);
  const targetEntry=fs.statSync(target,{throwIfNoEntry:false});
  if(targetEntry&&!targetEntry.isFile())throw new Error('backup_recovery_target_not_file');
  const targetExists=Boolean(targetEntry);

  const lease = acquireAuthorityLease(target, mode==='rollback'?'restore':'recovery');
  const id = `${timestamp()}-${randomUUID()}`;
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.restore-${id}`);
  const recoveryDirectory = targetExists ? path.join(path.dirname(target), `${path.basename(target)}.recovery-${id}`) : null;
  const targetFiles = [target, `${target}-wal`, `${target}-shm`];
  const moved: { from: string; to: string }[] = [];
  const copied: { from: string; to: string }[] = [];
  let preservationComplete = false;
  try {
    if(mode==='recovery'&&recoveryDirectory) {
      fs.mkdirSync(recoveryDirectory);
      for (const current of targetFiles) {
        if (!fs.existsSync(current)) continue;
        const saved = path.join(recoveryDirectory, path.basename(current));
        fs.copyFileSync(current, saved, fs.constants.COPYFILE_EXCL);
        copied.push({ from: current, to: saved });
      }
      preservationComplete = true;
    }
    let rules:RestoreRules|undefined;
    if(mode==='rollback')rules=readRestoreRules(target);
    else if(targetExists) {
      let targetValid=false;
      try { inspectDatabase(target); targetValid=true; } catch {}
      if(targetValid)throw new Error('backup_recovery_target_valid');
      try { rules=readRestoreRules(target); } catch {}
    }
    fs.copyFileSync(source, staging, fs.constants.COPYFILE_EXCL);
    if (await sha256(staging) !== manifest.sha256 || inspectDatabase(staging) !== manifest.schemaVersion) {
      throw new Error('backup_staging_validation_failed');
    }
    const appliedDeletionCount = applyRestoreRules(staging, rules);
    if (inspectDatabase(staging) !== manifest.schemaVersion) throw new Error('backup_staging_validation_failed');
    if(recoveryDirectory) {
      if(mode==='rollback')fs.mkdirSync(recoveryDirectory);
      for (const current of targetFiles) {
        if (!fs.existsSync(current)) continue;
        if(mode==='rollback') {
          const saved = path.join(recoveryDirectory, path.basename(current));
          fs.renameSync(current, saved);
          moved.push({ from: current, to: saved });
        } else fs.unlinkSync(current);
      }
    }
    if(fs.existsSync(target))throw new Error('backup_recovery_target_changed');
    fs.renameSync(staging, target);
    return {databasePath:target,recoveryDirectory,appliedDeletionCount,deletionRules:rules?'target':'backup_only'};
  } catch (error) {
    try {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
      for (const entry of moved.reverse()) if (fs.existsSync(entry.to)) fs.renameSync(entry.to, entry.from);
      if(preservationComplete) {
        for(const current of targetFiles) if(fs.existsSync(current)) fs.unlinkSync(current);
        for(const entry of copied) fs.copyFileSync(entry.to,entry.from,fs.constants.COPYFILE_EXCL);
      }
      for(const entry of copied) if(fs.existsSync(entry.to))fs.unlinkSync(entry.to);
      if (recoveryDirectory&&fs.existsSync(recoveryDirectory) && fs.readdirSync(recoveryDirectory).length === 0) fs.rmdirSync(recoveryDirectory);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'backup_restore_rollback_failed');
    }
    throw error;
  } finally {
    lease.release();
  }
}

function readRestoreRules(filename: string): RestoreRules {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const coreDeletions = db.prepare(`SELECT scope,id,revision,role,text,hash,accepted,observed,status,payload
      FROM sources WHERE status='deleted'`).all() as unknown as CoreDeletion[];
    const sceneDeletions = db.prepare(`SELECT scope,id,revision,message,observed,status,processing,analysis
      FROM scene_sources WHERE status='deleted'`).all() as unknown as SceneDeletion[];
    const coreVersions = new Map((db.prepare('SELECT key,version FROM scopes').all() as unknown as {key:string;version:number}[])
      .map(row => [row.key,row.version] as const));
    const sceneWorlds = (db.prepare('SELECT key,version,roster FROM scene_worlds').all() as unknown as
      {key:string;version:number;roster:string}[]).map(row=>({
        key:row.key,version:row.version,characters:sceneRosterCharacters(row.roster),
      }));
    const sceneVersions = new Map(sceneWorlds
      .map(row => [row.key,row.version] as const));
    const sceneIndexCleanup=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_index_cleanup'").get()
      ? db.prepare('SELECT scope,character,version FROM scene_index_cleanup').all() as unknown as
        {scope:string;character:string;version:number}[]
      : [];
    const referenceDeletions=(db.prepare('SELECT scope FROM scene_worlds').all() as {scope:string}[]).map(row=>{
      const scope=JSON.parse(row.scope) as SceneScope;
      return {scope,rows:captureReferenceRows(db,scope).filter(item=>item.status==='deleted')};
    });
    const targetControls=captureTargetControls(db);
    return { coreDeletions, sceneDeletions, coreVersions, sceneVersions, sceneWorlds, sceneIndexCleanup, referenceDeletions,targetControls };
  } finally { db.close(); }
}

function applyRestoreRules(filename: string, rules?: RestoreRules): number {
  const db = new DatabaseSync(filename);
  let transaction = false;
  let appliedDeletionCount = 0;
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    transaction = true;
    clearProcessingCandidates(db);
    clearDirectorCache(db);
    ensureExtendedRestoreSchema(db);
    if(rules)restoreTargetControls(db,rules.targetControls);
    for(const deletion of rules?.referenceDeletions??[]) {
      restoreReferenceRows(db,deletion.scope,deletion.rows);
      appliedDeletionCount+=deletion.rows.length;
    }
    const rebuiltCoreScopes = new Set<string>();
    for (const deletion of rules?.coreDeletions??[]) {
      if (!db.prepare('SELECT 1 FROM scopes WHERE key=?').get(deletion.scope)) continue;
      const existing = db.prepare('SELECT revision,status FROM sources WHERE scope=? AND id=?')
        .get(deletion.scope,deletion.id) as {revision:number;status:string}|undefined;
      const revision = Math.max(deletion.revision, existing && existing.status !== 'deleted' ? existing.revision + 1 : existing?.revision ?? 0);
      db.prepare(`INSERT INTO sources(scope,id,revision,role,text,hash,accepted,observed,status,payload)
        VALUES(?,?,?,?,?,?,?,?, 'deleted',NULL)
        ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision,role=excluded.role,text='',hash='',
        accepted=excluded.accepted,observed=excluded.observed,status='deleted',payload=NULL`)
        .run(deletion.scope,deletion.id,revision,deletion.role,'','',deletion.accepted,deletion.observed);
      removeCoreControls(db,deletion.scope,deletion.id);
      rebuiltCoreScopes.add(deletion.scope);
      appliedDeletionCount++;
    }
    for (const scope of rebuiltCoreScopes) rebuildCoreScope(db,scope);

    const sceneScopes = new Map<string, SceneDeletion[]>();
    for (const deletion of rules?.sceneDeletions??[]) {
      if (!db.prepare('SELECT 1 FROM scene_worlds WHERE key=?').get(deletion.scope)) continue;
      const group = sceneScopes.get(deletion.scope) ?? [];
      group.push(deletion);
      sceneScopes.set(deletion.scope,group);
      appliedDeletionCount++;
    }
    for (const [scope,deletions] of sceneScopes) applySceneDeletions(db,scope,deletions);
    rebuildCommitmentProjections(db);
    clearProfileProjections(db);
    clearRelationshipModels(db);
    if(rules)bumpRestoredVersions(db,rules);
    scheduleRestoredSceneIndexCleanup(db,rules);
    db.exec('COMMIT');
    transaction = false;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE');
    return appliedDeletionCount;
  } catch (error) {
    if (transaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

function clearProcessingCandidates(db:DatabaseSync):void {
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_processing_stages'").get())
    db.exec('DELETE FROM scene_processing_stages');
}

function clearDirectorCache(db:DatabaseSync):void {
  if(tableExists(db,'scene_director_plans'))db.exec('DELETE FROM scene_director_plans');
}

function captureTargetControls(db:DatabaseSync):TargetControlRows {
  const companionReceipts=tableRows(db,'companion_outbox')
    .filter(row=>['host_committed','sending','unknown','sent'].includes(String(row.status)));
  const receiptOpportunityIds=new Set(companionReceipts.map(row=>String(row.opportunity_id)));
  const receiptTargets=new Set(companionReceipts.map(row=>JSON.stringify([row.subject,row.target])));
  return {
    core:tableRows(db,'controls'),
    sceneAccess:tableRows(db,'scene_controls'),
    scenePreferences:tableRows(db,'scene_preference_controls'),
    subjectBindings:tableRows(db,'user_subject_bindings'),
    profileControls:tableRows(db,'user_model_controls'),
    profileOverrides:tableRows(db,'user_profile_overrides'),
    profileFeedback:tableRows(db,'user_model_feedback'),
    profileContactPauses:tableRows(db,'user_model_contact_pauses'),
    contactSettings:tableRows(db,'companion_contact_settings'),
    companionActivity:tableRows(db,'companion_activity'),
    companionStates:tableRows(db,'companion_state').filter(row=>receiptTargets.has(JSON.stringify([row.subject,row.target]))),
    companionOpportunities:tableRows(db,'companion_opportunities').filter(row=>receiptOpportunityIds.has(String(row.id))),
    companionReceipts,
    relationshipCorrections:tableRows(db,'companion_relationship_assessments')
      .filter(row=>row.correction!==null).map(row=>({...row,model:null})),
    interactions:tableRows(db,'scene_interactions'),
    interactionBindings:tableRows(db,'scene_interaction_bindings'),
  };
}

function ensureExtendedRestoreSchema(db:DatabaseSync):void {
  ensureUserModelSchema(db);
  new CompanionStore(db);
  new RelationshipAssessmentStore(db);
  new SceneInteractions(db,()=>null);
  new SceneDirector(db);
  new Commitments(db);
}

function restoreTargetControls(db:DatabaseSync,rows:TargetControlRows):void {
  replaceRows(db,'controls',rows.core);
  replaceRows(db,'scene_controls',rows.sceneAccess);
  replaceRows(db,'scene_preference_controls',rows.scenePreferences);
  replaceRows(db,'user_subject_bindings',rows.subjectBindings);
  mergeNewerRows(db,'user_model_controls',rows.profileControls,['subject'],'revision','updated');
  mergeNewerRows(db,'user_profile_overrides',rows.profileOverrides,['entry_id'],undefined,'updated');
  mergeNewerRows(db,'user_model_feedback',rows.profileFeedback,['id'],undefined,'created');
  mergeNewerRows(db,'user_model_contact_pauses',rows.profileContactPauses,['subject','target'],undefined,'updated');
  mergeNewerRows(db,'companion_contact_settings',rows.contactSettings,['subject'],'revision','updated');
  mergeNewerRows(db,'companion_activity',rows.companionActivity,['subject'],'revision');
  mergeNewerRows(db,'companion_state',rows.companionStates,['subject','target'],'revision','updated');
  replaceRows(db,'companion_opportunities',rows.companionOpportunities);
  replaceRows(db,'companion_outbox',rows.companionReceipts);
  restoreInteractionControls(db,rows.interactions,rows.interactionBindings);
  const activeAgentScopes=new Set((db.prepare(`SELECT b.physical_key FROM scene_interaction_bindings b
    JOIN scene_interactions i ON i.owner=b.owner
    JOIN scene_worlds w ON w.key=b.physical_key
    WHERE b.mode='companion' AND i.active_mode='companion' AND i.host='agent'`).all() as {physical_key:string}[])
    .map(row=>row.physical_key));
  mergeNewerRows(db,'companion_relationship_assessments',rows.relationshipCorrections
    .filter(row=>activeAgentScopes.has(String(row.scope))),
    ['scope','subject','character'],'revision');
}

function clearRelationshipModels(db:DatabaseSync):void {
  if(!tableExists(db,'companion_relationship_assessments'))return;
  db.exec('DELETE FROM companion_relationship_assessments WHERE correction IS NULL');
  db.exec('UPDATE companion_relationship_assessments SET model=NULL WHERE model IS NOT NULL');
}

function restoreInteractionControls(db:DatabaseSync,rows:SqlRow[],bindings:SqlRow[]):void {
  for(const row of rows) {
    const owner=String(row.owner),revision=Number(row.revision);
    const existing=db.prepare('SELECT revision FROM scene_interactions WHERE owner=?').get(owner) as {revision:number}|undefined;
    if(existing&&existing.revision>revision)continue;
    const owned=bindings.filter(binding=>String(binding.owner)===owner);
    if(owned.length!==2||!materializeActiveInteractionWorld(db,row,owned))continue;
    replaceRows(db,'scene_interactions',[row]);
    db.prepare('DELETE FROM scene_interaction_bindings WHERE owner=?').run(owner);
    replaceRows(db,'scene_interaction_bindings',owned);
  }
}

function materializeActiveInteractionWorld(db:DatabaseSync,row:SqlRow,bindings:SqlRow[]):boolean {
  const active=bindings.find(binding=>binding.mode===row.active_mode);
  if(!active)return false;
  const activeKey=String(active.physical_key);
  if(db.prepare('SELECT 1 FROM scene_worlds WHERE key=?').get(activeKey))return true;
  for(const binding of bindings) {
    const source=db.prepare('SELECT roster,created FROM scene_worlds WHERE key=?').get(String(binding.physical_key)) as
      {roster:string;created:number}|undefined;
    if(!source)continue;
    db.prepare('INSERT INTO scene_worlds(key,scope,roster,version,created) VALUES(?,?,?,?,?)')
      .run(activeKey,String(active.physical_scope),source.roster,1,source.created);
    return true;
  }
  return false;
}

function mergeNewerRows(
  db:DatabaseSync,table:string,rows:SqlRow[],keys:string[],revisionColumn?:string,updatedColumn?:string,
):void {
  for(const row of rows) {
    const where=keys.map(key=>`${key}=?`).join(' AND ');
    const selected=[revisionColumn,updatedColumn].filter((value):value is string=>Boolean(value));
    const existing=selected.length
      ?db.prepare(`SELECT ${selected.join(',')} FROM ${table} WHERE ${where}`).get(...keys.map(key=>row[key])) as SqlRow|undefined
      :undefined;
    if(existing&&revisionColumn&&Number(existing[revisionColumn])>Number(row[revisionColumn]))continue;
    if(existing&&revisionColumn&&Number(existing[revisionColumn])===Number(row[revisionColumn])&&updatedColumn&&
      Number(existing[updatedColumn])>Number(row[updatedColumn]))continue;
    if(existing&&!revisionColumn&&updatedColumn&&Number(existing[updatedColumn])>Number(row[updatedColumn]))continue;
    replaceRows(db,table,[row]);
  }
}

function replaceRows(db:DatabaseSync,table:string,rows:SqlRow[]):void {
  if(!rows.length||!tableExists(db,table))return;
  const available=new Set((db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(row=>row.name));
  for(const row of rows) {
    const columns=Object.keys(row).filter(column=>available.has(column));
    if(!columns.length)continue;
    db.prepare(`INSERT OR REPLACE INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`)
      .run(...columns.map(column=>row[column]));
  }
}

function tableRows(db:DatabaseSync,table:string):SqlRow[] {
  return tableExists(db,table)?db.prepare(`SELECT * FROM ${table}`).all() as unknown as SqlRow[]:[];
}

function tableExists(db:DatabaseSync,table:string):boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table));
}

function rebuildCommitmentProjections(db:DatabaseSync):void {
  const commitments=new Commitments(db);
  db.exec('DELETE FROM commitment_todos; DELETE FROM commitment_parties; DELETE FROM commitment_records; DELETE FROM commitment_events');
  const worlds=db.prepare('SELECT key,scope FROM scene_worlds').all() as {key:string;scope:string}[];
  for(const world of worlds) {
    const sources=(db.prepare(`SELECT message,status,processing,analysis FROM scene_sources WHERE scope=? ORDER BY rowid`).all(world.key) as
      {message:string;status:CommitmentSource['status'];processing:CommitmentSource['processing'];analysis:string|null}[])
      .map(row=>({...JSON.parse(row.message),status:row.status,processing:row.processing,
        analysis:row.analysis?JSON.parse(row.analysis):null}) as CommitmentSource);
    commitments.replaceProjection(JSON.parse(world.scope) as SceneScope,sources);
  }
}

function clearProfileProjections(db:DatabaseSync):void {
  for(const table of ['user_model_strategies','user_profile_evidence','user_profile_entries','user_profile_state'])
    if(tableExists(db,table))db.exec(`DELETE FROM ${table}`);
  if(!tableExists(db,'user_profile_reflections'))return;
  const rows=db.prepare('SELECT subject,source_scope,fingerprint,controls_revision,sources FROM user_profile_reflections').all() as
    {subject:string;source_scope:string;fingerprint:string;controls_revision:number;sources:string}[];
  const remove=db.prepare('DELETE FROM user_profile_reflections WHERE subject=? AND source_scope=? AND fingerprint=?');
  for(const row of rows){
    const scope=JSON.parse(row.source_scope) as SceneScope,sourceKey=scopeKey(scope);
    const controls=db.prepare('SELECT revision FROM user_model_controls WHERE subject=?').get(row.subject) as {revision:number}|undefined;
    const binding=db.prepare(`SELECT 1 FROM scene_interaction_bindings b JOIN scene_interactions i ON i.owner=b.owner
      WHERE b.physical_key=? AND b.mode='companion' AND i.active_mode='companion' AND i.host='agent'`).get(sourceKey);
    const refs=JSON.parse(row.sources) as {id:string;revision:number}[];
    if(!controls||controls.revision!==row.controls_revision||!binding||refs.some(ref=>{
      const source=db.prepare("SELECT revision,status FROM scene_sources WHERE scope=? AND id=?").get(sourceKey,ref.id) as
        {revision:number;status:string}|undefined;
      return !source||source.revision!==ref.revision||source.status!=='accepted';
    }))remove.run(row.subject,row.source_scope,row.fingerprint);
  }
}

function scheduleRestoredSceneIndexCleanup(db:DatabaseSync,rules?:RestoreRules):void {
  db.exec(`CREATE TABLE IF NOT EXISTS scene_index_cleanup (
    scope TEXT NOT NULL, character TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(scope,character))`);
  const register=db.prepare(`INSERT INTO scene_index_cleanup(scope,character,version) VALUES(?,?,?)
    ON CONFLICT(scope,character) DO UPDATE SET version=MAX(scene_index_cleanup.version,excluded.version)`);
  const restoredWorlds=db.prepare('SELECT key,version,roster FROM scene_worlds').all() as unknown as
    {key:string;version:number;roster:string}[];
  for(const world of restoredWorlds)for(const character of sceneRosterCharacters(world.roster))
    register.run(world.key,character,world.version);
  for(const world of rules?.sceneWorlds??[]) {
    for(const character of world.characters)register.run(world.key,character,world.version+1);
  }
  for(const cleanup of rules?.sceneIndexCleanup??[])register.run(cleanup.scope,cleanup.character,cleanup.version);
}

function sceneRosterCharacters(roster:string):string[] {
  return (JSON.parse(roster) as {characters:{id:string}[]}).characters.map(character=>character.id);
}

function rebuildCoreScope(db: DatabaseSync, key: string): void {
  const scopeRow = db.prepare('SELECT scope,created FROM scopes WHERE key=?').get(key) as {scope:string;created:number};
  const scope = JSON.parse(scopeRow.scope) as Record<string,unknown>;
  let emotion = createEmotion(scopeRow.created,undefined,coreEmotionIdentitySeed(scope));
  db.prepare('DELETE FROM memories WHERE scope=?').run(key);
  db.prepare('DELETE FROM preferences WHERE scope=?').run(key);
  const controls = db.prepare('SELECT id,revision,kind,body FROM controls WHERE scope=?').all(key) as unknown as StoredControl[];
  const preferences = new Map<string,Record<string,unknown>>();
  const sources = db.prepare(`SELECT id,revision,accepted,observed,status,payload FROM sources
    WHERE scope=? ORDER BY accepted,rowid`).all(key) as unknown as
    {id:string;revision:number;accepted:number;observed:number;status:string;payload:string|null}[];
  for (const source of sources) {
    if (source.status !== 'committed' || !source.payload) continue;
    const payload = JSON.parse(source.payload) as CorePayload;
    const accesses=memoryAccesses(source.id,source.revision,payload.memories,controls);
    for (const [index,candidate] of payload.memories.entries()) {
      const id = `${source.id}#${index}`;
      const memory = { ...candidate,id,scope,status:'accepted',access:accesses[index],
        source:{messageId:source.id,revision:source.revision,occurredAtMs:source.accepted,
          knownAtMs:Math.max(source.accepted,source.observed)} };
      db.prepare('INSERT INTO memories VALUES(?,?,?,?,?)').run(key,id,source.id,source.revision,JSON.stringify(memory));
    }
    const overrides=preferenceOverrides(source.id,source.revision,payload.preferences,controls);
    for (const [index,candidate] of payload.preferences.entries()) {
      const id = `${source.id}:preference:${index}`;
      const override=overrides[index]??{};
      preferences.set(candidate.category,{...candidate,id,sourceId:source.id,revision:source.revision,
        enabled:override.enabled??true,text:override.text??candidate.text,corrected:typeof override.text==='string'});
    }
    emotion = advanceEmotion(emotion,payload.emotion,source.accepted);
  }
  for (const preference of preferences.values()) {
    db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?)')
      .run(key,preference.id as string,preference.sourceId as string,preference.revision as number,JSON.stringify(preference));
  }
  db.prepare('UPDATE scopes SET emotion=? WHERE key=?').run(JSON.stringify(emotion),key);
}

function removeCoreControls(db:DatabaseSync,scope:string,sourceId:string):void {
  const controls=db.prepare('SELECT id,revision,kind,body FROM controls WHERE scope=?').all(scope) as unknown as StoredControl[];
  const remove=db.prepare('DELETE FROM controls WHERE scope=? AND id=? AND revision=? AND kind=?');
  for(const control of controls)if(isSourceControl(control,sourceId))remove.run(scope,control.id,control.revision,control.kind);
}

function applySceneDeletions(db: DatabaseSync, scope: string, deletions: SceneDeletion[]): void {
  const before = sceneRows(db,scope);
  const changes:{index:number;characters:Set<string>}[]=[];
  for (const deletion of deletions) {
    const existing = before.find(row=>row.id===deletion.id);
    if (existing?.status === 'accepted') {
      changes.push({index:before.indexOf(existing),characters:analysisCharacters(existing.analysis)});
    }
    const revision = Math.max(deletion.revision, existing && existing.status !== 'deleted' ? existing.revision + 1 : existing?.revision ?? 0);
    const message = JSON.parse(deletion.message) as Record<string,unknown>;
    message.revision=revision;message.text='';message.dependencies=[];
    db.prepare(`INSERT INTO scene_sources(scope,id,revision,message,observed,status,processing,analysis)
      VALUES(?,?,?,?,?,'deleted','ready',NULL)
      ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision,message=excluded.message,
      observed=excluded.observed,status='deleted',processing='ready',analysis=NULL`)
      .run(scope,deletion.id,revision,JSON.stringify(message),deletion.observed);
    removeScenePreferenceControls(db,scope,deletion.id);
  }

  let changed = true;
  while (changed) {
    changed = false;
    const rows = sceneRows(db,scope);
    for (const row of rows) {
      if (row.status !== 'accepted') continue;
      const message = JSON.parse(row.message) as {dependencies?:{id:string;revision:number}[]};
      const valid = (message.dependencies??[]).every(dependency=>rows.some(origin=>
        origin.id===dependency.id&&origin.revision===dependency.revision&&origin.status==='accepted'));
      if (valid) continue;
      changes.push({index:rows.indexOf(row),characters:analysisCharacters(row.analysis)});
      db.prepare("UPDATE scene_sources SET status='needs_review',processing='failed',analysis=NULL WHERE scope=? AND id=?")
        .run(scope,row.id);
      changed = true;
    }
  }

  const hasWorld = Boolean(db.prepare('SELECT 1 FROM scene_world_settings WHERE scope=?').get(scope));
  const rows = sceneRows(db,scope);
  for (const [index,row] of rows.entries()) {
    if (row.status !== 'accepted' || !row.analysis) continue;
    const characters = analysisCharacters(row.analysis);
    if (!changes.some(change=>change.index<index&&(hasWorld||[...characters].some(id=>change.characters.has(id))))) continue;
    db.prepare("UPDATE scene_sources SET processing='pending',analysis=? WHERE scope=? AND id=?")
      .run(withoutStoredEmotionStates(row.analysis),scope,row.id);
    changes.push({index,characters});
  }
  removeUnsafeCheckpoints(db,scope,new Set(deletions.map(row=>row.id)));
}

function removeScenePreferenceControls(db:DatabaseSync,scope:string,sourceId:string):void {
  if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scene_preference_controls'").get())return;
  const rows=db.prepare('SELECT character,id FROM scene_preference_controls WHERE scope=?').all(scope) as unknown as {character:string;id:string}[];
  const remove=db.prepare('DELETE FROM scene_preference_controls WHERE scope=? AND character=? AND id=?');
  for(const row of rows)if(scenePreferenceSourceId(row.id)===sourceId)remove.run(scope,row.character,row.id);
}

function scenePreferenceSourceId(id:string):string|null {
  const marker=':pref:@';
  const index=id.lastIndexOf(marker);
  return index>0&&/^[a-f0-9]{64}$/.test(id.slice(index+marker.length))?id.slice(0,index):null;
}

function sceneRows(db:DatabaseSync,scope:string) {
  return db.prepare('SELECT id,revision,message,status,analysis FROM scene_sources WHERE scope=? ORDER BY rowid')
    .all(scope) as unknown as {id:string;revision:number;message:string;status:string;analysis:string|null}[];
}

function analysisCharacters(analysis:string|null):Set<string> {
  if(!analysis)return new Set();
  const value=JSON.parse(analysis) as {characters?:Record<string,unknown>};
  return new Set(Object.keys(value.characters??{}));
}

function removeUnsafeCheckpoints(db:DatabaseSync,scope:string,deletedIds:Set<string>):void {
  const checkpoints=db.prepare('SELECT id,snapshot FROM scene_checkpoints WHERE scope=?').all(scope) as unknown as {id:string;snapshot:string}[];
  for(const checkpoint of checkpoints) {
    let remove=false;
    try {
      const snapshot=JSON.parse(checkpoint.snapshot) as {sources?:{id?:string;status?:string;message?:string}[]};
      if(!Array.isArray(snapshot.sources))remove=true;
      else {
        const unsafe=new Set(snapshot.sources.filter(source=>typeof source.id==='string'&&deletedIds.has(source.id)&&source.status!=='deleted')
          .map(source=>source.id as string));
        let changed=true;
        while(changed) {
          changed=false;
          for(const source of snapshot.sources) {
            if(source.status!=='accepted'||typeof source.id!=='string'||unsafe.has(source.id)||typeof source.message!=='string')continue;
            const message=JSON.parse(source.message) as {dependencies?:{id?:string}[]};
            if(!(message.dependencies??[]).some(dependency=>typeof dependency.id==='string'&&(deletedIds.has(dependency.id)||unsafe.has(dependency.id))))continue;
            unsafe.add(source.id);changed=true;
          }
        }
        remove=unsafe.size>0;
      }
    } catch { remove=true; }
    if(remove)db.prepare('DELETE FROM scene_checkpoints WHERE id=?').run(checkpoint.id);
  }
}

function bumpRestoredVersions(db:DatabaseSync,rules:RestoreRules):void {
  const scopes=db.prepare('SELECT key,version FROM scopes').all() as unknown as {key:string;version:number}[];
  for(const scope of scopes)db.prepare('UPDATE scopes SET version=?,indexed=-1 WHERE key=?')
    .run(Math.max(scope.version,rules.coreVersions.get(scope.key)??0)+1,scope.key);
  const worlds=db.prepare('SELECT key,version FROM scene_worlds').all() as unknown as {key:string;version:number}[];
  for(const world of worlds)db.prepare('UPDATE scene_worlds SET version=? WHERE key=?')
    .run(Math.max(world.version,rules.sceneVersions.get(world.key)??0)+1,world.key);
}

function claimActive(active: string, guard: string): void {
  try { fs.mkdirSync(active); return; }
  catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
  const record = readLease(path.join(active, 'owner.json'));
  if (!record || pidIsAlive(record.pid)) throw new Error('backup_database_active');
  const stale = path.join(guard, `stale-${timestamp()}-${randomUUID()}`);
  try { fs.renameSync(active, stale); }
  catch (error) { if (isCode(error, 'ENOENT')) return claimActive(active, guard); throw error; }
  try { fs.mkdirSync(active); }
  catch (error) {
    if (isCode(error, 'EEXIST')) throw new Error('backup_database_active');
    throw error;
  }
}

function readLease(filename: string): LeaseRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8')) as Partial<LeaseRecord>;
    if (value.protocol !== 1 || (value.owner !== 'server' && value.owner !== 'restore' && value.owner !== 'recovery') ||
      !Number.isSafeInteger(value.pid) || typeof value.nonce !== 'string' || typeof value.acquiredAt !== 'string') return null;
    return value as LeaseRecord;
  } catch { return null; }
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !isCode(error, 'ESRCH'); }
}

function inspectDatabase(filename: string): number {
  const db = new DatabaseSync(filename, { readOnly: true });
  let schemaVersion = 0;
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as unknown as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('backup_integrity_failed');
    const rows = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as unknown as { name: string }[];
    const names = new Set(rows.map(row => row.name));
    if (requiredTables.some(table => !names.has(table))) throw new Error('backup_required_table_missing');
    validatePersistedEmotionStates(db);
    schemaVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
    removeReadSidecars(filename);
  }
  return schemaVersion;
}

function removeReadSidecars(filename: string): void {
  const wal = `${filename}-wal`;
  const shm = `${filename}-shm`;
  if (fs.existsSync(wal) && fs.statSync(wal).size !== 0) throw new Error('backup_unexpected_wal');
  if (fs.existsSync(wal)) fs.unlinkSync(wal);
  if (fs.existsSync(shm)) fs.unlinkSync(shm);
}

function validatePersistedEmotionStates(db:DatabaseSync):void {
  try {
    for(const row of db.prepare('SELECT emotion FROM scopes').iterate() as unknown as Iterable<{emotion:string}>) {
      const state=JSON.parse(row.emotion) as {version?:unknown};
      if(state.version===2)validateEmotionState(state);
      else if(state.version!==1)throw new TypeError('invalid emotion version');
    }
    const validateAnalysis=(serialized:string):void=>{
      const analysis=JSON.parse(serialized) as {emotionStates?:unknown};
      if(analysis.emotionStates===undefined)return;
      if(!analysis.emotionStates||typeof analysis.emotionStates!=='object'||Array.isArray(analysis.emotionStates))throw new TypeError('invalid scene emotion states');
      for(const state of Object.values(analysis.emotionStates as Record<string,unknown>))validateEmotionState(state);
    };
    for(const row of db.prepare('SELECT analysis FROM scene_sources WHERE analysis IS NOT NULL').iterate() as unknown as Iterable<{analysis:string}>)
      validateAnalysis(row.analysis);
    for(const row of db.prepare('SELECT snapshot FROM scene_checkpoints').iterate() as unknown as Iterable<{snapshot:string}>) {
      const snapshot=JSON.parse(row.snapshot) as {sources?:{analysis?:string|null}[]};
      if(!Array.isArray(snapshot.sources))throw new TypeError('invalid checkpoint sources');
      for(const source of snapshot.sources) {
        if(source.analysis!==null&&source.analysis!==undefined&&typeof source.analysis!=='string')throw new TypeError('invalid checkpoint analysis');
        if(typeof source.analysis==='string')validateAnalysis(source.analysis);
      }
    }
  } catch(error) {
    throw new Error('backup_invalid_emotion_state',{cause:error});
  }
}

function withoutStoredEmotionStates(serialized:string|null):string|null {
  if(!serialized)return null;
  const analysis=JSON.parse(serialized) as Record<string,unknown>;
  delete analysis.emotionStates;
  return JSON.stringify(analysis);
}

function coreEmotionIdentitySeed(scope:Record<string,unknown>):string {
  return JSON.stringify(['xldb-emotion-v2',scope.worldId,scope.sessionId,scope.characterId,null]);
}

function readManifest(filename: string): BackupManifest {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('invalid_backup_manifest'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_backup_manifest');
  const manifest = value as Partial<BackupManifest>;
  if (!Number.isSafeInteger(manifest.schemaVersion) || (manifest.schemaVersion as number) < 1 ||
    typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
    typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error('invalid_backup_manifest');
  }
  return manifest as BackupManifest;
}

async function sha256(filename: string): Promise<string> {
  const hash = createHash('sha256');
  const input = fs.createReadStream(filename);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

function existingLocalFile(value: string): string {
  const filename = localPath(value);
  if (!fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) throw new Error('backup_file_not_found');
  assertRealPath(filename);
  return filename;
}

function existingLocalDirectory(value: string): string {
  const directory = localPath(value);
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) throw new Error('backup_directory_not_found');
  assertRealPath(directory);
  return directory;
}

function localPath(value: string): string {
  if (!value) throw new Error('invalid_backup_path');
  const resolved = path.resolve(value);
  if (!inside(localRoot, resolved) || resolved === localRoot) throw new Error('backup_path_outside_workspace');
  let parent = resolved;
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) throw new Error('invalid_backup_path');
    parent = next;
  }
  assertRealPath(parent);
  return resolved;
}

function assertRealPath(value: string): void {
  const root = fs.realpathSync(localRoot);
  const resolved = fs.realpathSync(value);
  if (!inside(root, resolved) && resolved !== root) throw new Error('backup_path_outside_workspace');
}

function inside(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function removeStaging(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
}

function timestamp(): string { return new Date().toISOString().replaceAll(':', '-'); }

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
