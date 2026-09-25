import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEmotion, advanceEmotion, emotionAt, validateEmotionState } from '../emotion/openher.ts';
import type { EmotionState } from '../emotion/openher.ts';
import { projectMemories } from '../memory/access.ts';
import {retentionSnapshot} from '../memory/retention.ts';
import type { Scope, Access, Memory, MemorySnapshot } from '../memory/access.ts';
import { scopeKey,text } from './types.ts';
import type { AcceptedMessage, Analysis } from './types.ts';
import {isSourceControl,memoryAccesses,memoryControlId,preferenceControlId,preferenceOverrides} from './controls.ts';
import type {StoredControl} from './controls.ts';
import { SceneAuthority } from '../scene/store.ts';
import {acquireAuthorityLease} from '../scene/backup.ts';
import type {AuthorityLease} from '../scene/backup.ts';

type Source = AcceptedMessage & { status: string; payload: string | null; observedAtMs: number };
export interface Preference {
  id: string; category: string; text: string; quote: string; sourceId: string;
  revision: number; enabled: boolean; corrected: boolean;
  duration?:'turn'|'persistent';
}

const NEURAL_PERSISTENCE_APPLICATION_ID=0x584c4402;

/** SQLite is the authority. Indexes and UI never write these tables directly. */
export class Authority {
  private db: DatabaseSync;
  private lease?:AuthorityLease;
  readonly scene: SceneAuthority;
  constructor(filename: string) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    if(filename!==':memory:')this.lease=acquireAuthorityLease(filename,'server');
    let opened:DatabaseSync|undefined;
    try {
    this.db = opened = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scopes (
        key TEXT PRIMARY KEY, scope TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, emotion TEXT NOT NULL, indexed INTEGER NOT NULL DEFAULT -1);
      CREATE TABLE IF NOT EXISTS sources (
        scope TEXT NOT NULL REFERENCES scopes(key), id TEXT NOT NULL, revision INTEGER NOT NULL,
        role TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, accepted INTEGER NOT NULL,
        observed INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT,
        PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS memories (
        scope TEXT NOT NULL REFERENCES scopes(key), id TEXT NOT NULL, source TEXT NOT NULL,
        revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS preferences (
        scope TEXT NOT NULL REFERENCES scopes(key), id TEXT NOT NULL, source TEXT NOT NULL,
        revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS controls (
        scope TEXT NOT NULL REFERENCES scopes(key), id TEXT NOT NULL, revision INTEGER NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,id,revision,kind));
      PRAGMA user_version=1;`);
    const needsEmotionMigration=(this.db.prepare('PRAGMA application_id').get() as {application_id:number}).application_id!==NEURAL_PERSISTENCE_APPLICATION_ID;
    this.scene = new SceneAuthority(this.db,needsEmotionMigration);
    if(needsEmotionMigration) {
      this.migrateEmotionStates();
      this.db.exec(`PRAGMA application_id=${NEURAL_PERSISTENCE_APPLICATION_ID}`);
    }
    }catch(error){opened?.close();this.lease?.release();throw error;}
  }
  close() { if(this.db.isOpen)this.db.close();this.lease?.release(); }
  sqliteVersion(): string { return (this.db.prepare('SELECT sqlite_version() AS version').get() as {version:string}).version; }

  begin(scope: Scope, message: AcceptedMessage, now = Date.now()): 'pending' | 'duplicate' | 'conflict' {
    return this.transaction(() => {
      this.ensureScope(scope, Math.min(now, message.acceptedAtMs));
      const key = scopeKey(scope);
      const previous = this.source(scope, message.id);
      if (previous && (message.revision < previous.revision ||
        (message.revision === previous.revision && (message.text !== previous.text || message.role !== previous.role)))) return 'conflict';
      if (previous?.status === 'deleted' && message.revision <= previous.revision) return 'conflict';
      if (previous && message.revision === previous.revision && previous.status === 'committed') return 'duplicate';
      if (previous && message.revision > previous.revision + 1) return 'conflict';
      if (!previous && message.revision !== 1) return 'conflict';
      if (previous && message.revision === previous.revision) {
        this.db.prepare("UPDATE sources SET status='pending' WHERE scope=? AND id=?").run(key, message.id);
        return 'pending';
      }
      this.db.prepare(`INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,'pending',NULL)
        ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision,role=excluded.role,
        text=excluded.text,hash=excluded.hash,observed=excluded.observed,status='pending',payload=NULL`)
        .run(key, message.id, message.revision, message.role, message.text, digest(message.text), message.acceptedAtMs, now);
      this.rebuild(scope);
      return 'pending';
    });
  }

  commit(scope: Scope, message: AcceptedMessage, analysis: Analysis): 'committed' | 'duplicate' | 'conflict' {
    return this.transaction(() => {
      const source = this.source(scope, message.id);
      if (!source || source.revision !== message.revision || source.text !== message.text || source.role !== message.role || source.status === 'deleted') return 'conflict';
      if (source.status === 'committed') return 'duplicate';
      this.db.prepare("UPDATE sources SET payload=?,status='committed' WHERE scope=? AND id=?")
        .run(JSON.stringify(analysis), scopeKey(scope), message.id);
      this.rebuild(scope);
      return 'committed';
    });
  }

  fail(scope: Scope, message: AcceptedMessage) {
    this.db.prepare("UPDATE sources SET status='failed' WHERE scope=? AND id=? AND revision=? AND text=? AND status='pending'")
      .run(scopeKey(scope), message.id, message.revision, message.text);
  }

  /** Called before generation: edits/deletions invalidate old projections immediately. */
  reconcile(scope: Scope, current: {id: string; role: 'user' | 'assistant'; text: string}[], now = Date.now()) {
    return this.transaction(() => {
      const known = this.sources(scope);
      const present = new Map(current.map(item => [item.id, item]));
      if (present.size !== current.length) throw new Error('duplicate_message_id');
      let removed = 0;
      let changed = false;
      if (current.length && !known.length) this.ensureScope(scope, now);
      for (const item of current) {
        if (known.some(source => source.id === item.id)) continue;
        this.db.prepare("INSERT INTO sources VALUES(?,?,1,?,?,?,?,?,'pending',NULL)")
          .run(scopeKey(scope), item.id, item.role, item.text, digest(item.text), now, now);
        changed = true;
      }
      for (const source of known) {
        const live = present.get(source.id);
        if (!live && source.status !== 'deleted') {
          this.db.prepare("UPDATE sources SET revision=revision+1,status='deleted',payload=NULL,text='',hash='',observed=? WHERE scope=? AND id=?")
            .run(now, scopeKey(scope), source.id);
          this.deleteControls(scopeKey(scope),source.id);
          removed++; changed = true;
        } else if (live && source.status !== 'deleted' && (live.text !== source.text || live.role !== source.role)) {
          this.db.prepare("UPDATE sources SET revision=revision+1,status='pending',payload=NULL,text=?,hash=?,role=?,observed=? WHERE scope=? AND id=?")
            .run(live.text, digest(live.text), live.role, now, scopeKey(scope), source.id);
          changed = true;
        }
      }
      if (changed) this.rebuild(scope);
      return { removed, reprocess: this.sources(scope).filter(item => item.status === 'pending' || item.status === 'failed')
        .map(({id, revision, role, text, acceptedAtMs}) => ({id, revision, role, text, acceptedAtMs})) };
    });
  }

  snapshot(scope: Scope): MemorySnapshot {
    const key = scopeKey(scope);
    const row = this.db.prepare('SELECT version FROM scopes WHERE key=?').get(key) as {version:number} | undefined;
    const sources = this.sources(scope);
    const memories = this.db.prepare('SELECT body FROM memories WHERE scope=? ORDER BY rowid').all(key) as {body:string}[];
    return { scope, version: row?.version ?? 0,
      messages: new Map(sources.map(item => [item.id, { revision: item.revision, status: item.status === 'committed' ? 'accepted' : 'deleted' }])),
      memories: new Map(memories.map(item => { const memory = JSON.parse(item.body) as Memory; return [memory.id, memory]; })) };
  }
  inspect(scope: Scope, now = Date.now()) {
    const snapshot = retentionSnapshot(this.snapshot(scope),now);
    return { ...projectMemories(snapshot, {scope, asOfMs: now, ids: [...snapshot.memories.keys()]}),
      messages: this.sources(scope).map(({payload: _payload, observedAtMs, ...message}) => ({...message, observedAtMs})),
      preferences: this.preferences(scope), emotion: this.emotion(scope, now) };
  }
  preferences(scope: Scope, currentReplySourceId?:string): Preference[] {
    return (this.db.prepare('SELECT body FROM preferences WHERE scope=? ORDER BY rowid').all(scopeKey(scope)) as {body:string}[])
      .map(row => JSON.parse(row.body) as Preference)
      .filter(preference=>preference.duration!=='turn'||preference.sourceId===currentReplySourceId);
  }
  /** A turn instruction is usable only while replying to the current accepted user source. */
  currentReplySourceId(scope:Scope,input:string,requestedId?:string):string|undefined {
    const latest=this.sources(scope).filter(source=>source.status==='committed').at(-1);
    if(!latest||latest.role!=='user'||latest.text!==text(input,20000)||(requestedId!==undefined&&latest.id!==text(requestedId,200)))return undefined;
    return latest.id;
  }
  emotion(scope: Scope, now = Date.now()): EmotionState {
    const row = this.db.prepare('SELECT emotion FROM scopes WHERE key=?').get(scopeKey(scope)) as {emotion:string} | undefined;
    return row ? emotionAt(validateEmotionState(JSON.parse(row.emotion)), now) : createEmotion(now,undefined,emotionIdentitySeed(scope));
  }
  setAccess(scope: Scope, id: string, access: Access) {
    if (!['clear','gist','feeling','anchor','hidden'].includes(access)) throw new Error('invalid_access');
    this.control(scope, id, 'access', access, 'memories');
  }
  setPreference(scope: Scope, id: string, enabled: boolean, newText?: string) {
    this.control(scope, id, 'preference', { enabled, ...(newText === undefined ? {} : {text: newText}) }, 'preferences');
  }
  needsIndex(scope: Scope): boolean {
    const row = this.db.prepare('SELECT version,indexed FROM scopes WHERE key=?').get(scopeKey(scope)) as {version:number;indexed:number} | undefined;
    return !!row && row.version !== row.indexed;
  }
  markIndexed(scope: Scope, version: number) {
    this.db.prepare('UPDATE scopes SET indexed=? WHERE key=? AND version=?').run(version, scopeKey(scope), version);
  }
  resetIndex() { this.db.exec('UPDATE scopes SET indexed=-1'); }

  private control(scope: Scope, id: string, kind: string, value: unknown, table: 'memories' | 'preferences') {
    this.transaction(() => {
      const key=scopeKey(scope);
      const row = this.db.prepare(`SELECT source,revision,body FROM ${table} WHERE scope=? AND id=?`).get(key, id) as {source:string;revision:number;body:string} | undefined;
      if (!row) throw new Error('record_not_found');
      const candidate=JSON.parse(row.body) as Memory|Preference;
      const controlId=table==='memories' ? memoryControlId(row.source,candidate as Memory) : preferenceControlId(row.source,candidate as Preference);
      this.db.prepare('DELETE FROM controls WHERE scope=? AND id=? AND revision=? AND kind=?').run(key,id,row.revision,kind);
      this.db.prepare('INSERT OR REPLACE INTO controls VALUES(?,?,?,?,?)').run(key,controlId,0,kind,JSON.stringify(value));
      this.rebuild(scope);
    });
  }
  private source(scope: Scope, id: string) { return this.sources(scope).find(item => item.id === id); }
  private sources(scope: Scope): Source[] {
    return this.db.prepare(`SELECT id,revision,role,text,accepted AS acceptedAtMs,observed AS observedAtMs,status,payload
      FROM sources WHERE scope=? ORDER BY accepted,rowid`).all(scopeKey(scope)) as unknown as Source[];
  }
  private deleteControls(key:string,sourceId:string):void {
    const controls=this.db.prepare('SELECT id,revision,kind,body FROM controls WHERE scope=?').all(key) as unknown as StoredControl[];
    const remove=this.db.prepare('DELETE FROM controls WHERE scope=? AND id=? AND revision=? AND kind=?');
    for(const control of controls)if(isSourceControl(control,sourceId))remove.run(key,control.id,control.revision,control.kind);
  }
  private ensureScope(scope: Scope, now: number) {
    this.db.prepare('INSERT OR IGNORE INTO scopes(key,scope,created,emotion) VALUES(?,?,?,?)')
      .run(scopeKey(scope), JSON.stringify(scope), now, JSON.stringify(createEmotion(now,undefined,emotionIdentitySeed(scope))));
  }
  private rebuild(scope: Scope) {
    const key = scopeKey(scope);
    const row = this.db.prepare('SELECT created FROM scopes WHERE key=?').get(key) as {created:number};
    let emotion = createEmotion(row.created,undefined,emotionIdentitySeed(scope));
    this.migrateControls(scope);
    this.db.prepare('DELETE FROM memories WHERE scope=?').run(key);
    this.db.prepare('DELETE FROM preferences WHERE scope=?').run(key);
    const controls = this.db.prepare('SELECT id,revision,kind,body FROM controls WHERE scope=?').all(key) as unknown as StoredControl[];
    const preferences = new Map<string, Preference>();
    const sources=this.sources(scope),currentUserId=sources.filter(source=>source.status==='committed'&&source.role==='user').at(-1)?.id;
    for (const source of sources) {
      if (source.status !== 'committed' || !source.payload) continue;
      const payload = JSON.parse(source.payload) as Analysis;
      const accesses=memoryAccesses(source.id,source.revision,payload.memories,controls);
      for (const [i, candidate] of payload.memories.entries()) {
        const id = `${source.id}#${i}`;
        const accessOverride=controls.some(control=>control.kind==='access'&&
          ((control.id===memoryControlId(source.id,candidate)&&control.revision===0)||(control.id===id&&control.revision===source.revision)));
        const rehearsed=candidate.retention?.cues.length?this.sources(scope).filter(later=>later.status==='committed'&&later.acceptedAtMs>source.acceptedAtMs&&
          candidate.retention!.cues.some(cue=>later.text.includes(cue))).at(-1):undefined;
        const memory: Memory = { ...candidate, id, scope, status: 'accepted', access: accesses[i],accessOverride,retentionAtMs:rehearsed?.acceptedAtMs??source.acceptedAtMs,
          source: { messageId: source.id, revision: source.revision, occurredAtMs: source.acceptedAtMs, knownAtMs: Math.max(source.acceptedAtMs, source.observedAtMs) } };
        this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?)').run(key, id, source.id, source.revision, JSON.stringify(memory));
      }
      const overrides=preferenceOverrides(source.id,source.revision,payload.preferences,controls);
      for (const [i, candidate] of payload.preferences.entries()) {
        if(candidate.duration==='turn'&&source.id!==currentUserId)continue;
        const id = `${source.id}:preference:${i}`;
        const override=overrides[i]??{};
        preferences.set(candidate.category, { ...candidate, id, sourceId: source.id, revision: source.revision,
          enabled: override.enabled ?? true, text: override.text ?? candidate.text, corrected: typeof override.text === 'string' });
      }
      // Only recorded accepted deltas are replayed; reads and model upgrades do not reinterpret history.
      emotion = advanceEmotion(emotion, payload.emotion, source.acceptedAtMs);
    }
    for (const preference of preferences.values()) {
      this.db.prepare('INSERT INTO preferences VALUES(?,?,?,?,?)')
        .run(key, preference.id, preference.sourceId, preference.revision, JSON.stringify(preference));
    }
    this.db.prepare('UPDATE scopes SET emotion=?,version=version+1 WHERE key=?').run(JSON.stringify(emotion), key);
  }
  /** Upgrade position/revision controls while the old projection still exists. */
  private migrateControls(scope:Scope) {
    const key=scopeKey(scope);
    const rows=this.db.prepare('SELECT id,revision,kind,body FROM controls WHERE scope=? AND revision>0').all(key) as {id:string;revision:number;kind:string;body:string}[];
    for(const control of rows) {
      const table=control.kind==='access' ? 'memories' : control.kind==='preference' ? 'preferences' : undefined;
      if(!table)continue;
      const projection=this.db.prepare(`SELECT source,body FROM ${table} WHERE scope=? AND id=? AND revision=?`).get(key,control.id,control.revision) as {source:string;body:string}|undefined;
      if(!projection)continue;
      const candidate=JSON.parse(projection.body) as Memory|Preference;
      const stableId=table==='memories' ? memoryControlId(projection.source,candidate as Memory) : preferenceControlId(projection.source,candidate as Preference);
      const exists=this.db.prepare('SELECT 1 AS found FROM controls WHERE scope=? AND id=? AND revision=0 AND kind=?').get(key,stableId,control.kind) as {found:number}|undefined;
      if(!exists)this.db.prepare('INSERT INTO controls VALUES(?,?,?,?,?)').run(key,stableId,0,control.kind,control.body);
      this.db.prepare('DELETE FROM controls WHERE scope=? AND id=? AND revision=? AND kind=?').run(key,control.id,control.revision,control.kind);
    }
  }
  /** Upgrade each legacy v1 projection once by replaying recorded candidates. */
  private migrateEmotionStates() {
    this.transaction(()=>{
      const rows=this.db.prepare('SELECT scope,emotion FROM scopes').all() as {scope:string;emotion:string}[];
      for(const row of rows) {
        const scope=JSON.parse(row.scope) as Scope;
        const stored=JSON.parse(row.emotion) as {version?:unknown};
        if(stored.version===2) { validateEmotionState(stored); continue; }
        if(stored.version!==1) throw new TypeError('invalid_emotion_state_version');
        this.rebuild(scope);
      }
    });
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
function digest(text: string) { return createHash('sha256').update(text).digest('hex'); }
function emotionIdentitySeed(scope:Scope):string {
  return JSON.stringify(['xldb-emotion-v2',scope.worldId,scope.sessionId,scope.characterId,null]);
}
