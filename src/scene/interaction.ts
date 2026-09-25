import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {scopeKey} from '../core/types.ts';
import type {SceneScope} from './types.ts';

export type InteractionHost='sillytavern'|'agent'|'agent-roleplay';
export type InteractionMode='roleplay'|'companion';

export interface InteractionState {
  baseScope:SceneScope;
  scope:SceneScope;
  host:InteractionHost;
  mode:InteractionMode;
  revision:number;
  directorEnabled:boolean;
  directorAvailable:boolean;
  configuredTimeZone:string|null;
  timeZone:string;
  bindings:Record<InteractionMode,SceneScope>;
}

interface InteractionRow {
  owner:string;
  base_scope:string;
  host:InteractionHost;
  active_mode:InteractionMode;
  revision:number;
  director_enabled:number;
  time_zone:string|null;
}

interface BindingRow {owner:string;mode:InteractionMode;physical_scope:string;physical_key:string}

type StoryClock=(scope:SceneScope,now:number)=>unknown;

/** Persistent host/mode control. Content stays in ordinary, isolated scene scopes. */
export class SceneInteractions {
  private savepointSequence=0;
  private db:DatabaseSync;
  private storyClock:StoryClock;
  constructor(db:DatabaseSync,storyClock:StoryClock) {
    this.db=db;
    this.storyClock=storyClock;
    db.exec(`CREATE TABLE IF NOT EXISTS scene_interactions (
      owner TEXT PRIMARY KEY, base_scope TEXT NOT NULL, host TEXT NOT NULL,
      active_mode TEXT NOT NULL, revision INTEGER NOT NULL,
      director_enabled INTEGER NOT NULL, time_zone TEXT);
      CREATE TABLE IF NOT EXISTS scene_interaction_bindings (
      owner TEXT NOT NULL REFERENCES scene_interactions(owner) ON DELETE CASCADE,
      mode TEXT NOT NULL, physical_scope TEXT NOT NULL, physical_key TEXT NOT NULL UNIQUE,
      PRIMARY KEY(owner,mode));`);
  }

  open(scope:SceneScope,host:InteractionHost):InteractionState {
    assertHost(host);
    return this.transaction(()=>{
      const existing=this.resolve(scope);
      if(existing){
        const current=this.checkedState(existing,host);
        return host==='sillytavern'&&current.mode==='companion'
          ?this.switch(scope,host,'roleplay',current.revision):current;
      }
      const baseScope=structuredClone(scope);
      const owner=scopeKey(baseScope);
      const defaultMode:InteractionMode=host==='agent'?'companion':'roleplay';
      const configured=this.db.prepare('SELECT settings FROM scene_world_settings WHERE scope=?').get(owner) as {settings:string}|undefined;
      const originalMode:InteractionMode=configured
        ? (worldMode(configured.settings)==='story'?'roleplay':'companion') : defaultMode;
      const configuredTimeZone:null=null;
      this.db.prepare(`INSERT INTO scene_interactions
        (owner,base_scope,host,active_mode,revision,director_enabled,time_zone) VALUES(?,?,?,?,1,?,?)`)
        .run(owner,JSON.stringify(baseScope),host,defaultMode,host==='agent'?0:1,configuredTimeZone);
      const otherMode:InteractionMode=originalMode==='roleplay'?'companion':'roleplay';
      const original=baseScope;
      const other=derivedScope(baseScope,otherMode);
      this.insertBinding(owner,originalMode,original,true);
      this.insertBinding(owner,otherMode,other);
      if(defaultMode!==originalMode)this.materializeRoster(original,other);
      return this.stateByOwner(owner)!;
    });
  }

  get(scope:SceneScope,host:InteractionHost):InteractionState {
    assertHost(host);
    const row=this.resolve(scope);
    if(!row)throw new Error('invalid_interaction_not_open');
    return this.checkedState(row,host);
  }

  roleplay(scope:SceneScope):InteractionState {
    const row=this.resolve(scope);
    if(!row||row.active_mode!=='roleplay'||row.host==='agent')throw new Error('invalid_interaction_mode');
    return this.stateByOwner(row.owner)!;
  }

  switch(scope:SceneScope,host:InteractionHost,mode:InteractionMode,expectedRevision:number):InteractionState {
    assertHost(host);assertMode(mode);assertRevision(expectedRevision);
    return this.transaction(()=>{
      const row=this.resolve(scope);
      if(!row)throw new Error('invalid_interaction_not_open');
      this.assertHost(row,host);
      if(host==='agent'?mode!=='companion':mode!=='roleplay')throw new Error('invalid_interaction_mode');
      if(row.revision!==expectedRevision)throw new Error('context_changed_retry');
      if(row.active_mode===mode)return this.stateByOwner(row.owner)!;
      const bindings=this.bindings(row.owner);
      const leaving=bindings[row.active_mode];
      const entering=bindings[mode];
      this.materializeRoster(leaving,entering);
      this.bumpScene(leaving);
      this.db.prepare('UPDATE scene_interactions SET active_mode=?,revision=revision+1 WHERE owner=?').run(mode,row.owner);
      return this.stateByOwner(row.owner)!;
    });
  }

  settings(
    scope:SceneScope,host:InteractionHost,
    value:{timeZone?:string|null;directorEnabled?:boolean},expectedRevision:number,
  ):InteractionState {
    assertHost(host);assertRevision(expectedRevision);
    if(value.timeZone===undefined&&value.directorEnabled===undefined)throw new Error('invalid_interaction_settings');
    if(value.timeZone!==undefined&&value.timeZone!==null)validateTimeZone(value.timeZone);
    if(value.directorEnabled!==undefined&&typeof value.directorEnabled!=='boolean')throw new Error('invalid_interaction_settings');
    return this.transaction(()=>{
      const row=this.resolve(scope);
      if(!row)throw new Error('invalid_interaction_not_open');
      this.assertHost(row,host);
      if(row.revision!==expectedRevision)throw new Error('context_changed_retry');
      if(value.directorEnabled!==undefined&&(host==='agent'||row.active_mode!=='roleplay'))throw new Error('invalid_interaction_director');
      const nextZone=value.timeZone===undefined?row.time_zone:value.timeZone;
      const nextDirector=value.directorEnabled===undefined?row.director_enabled:(value.directorEnabled?1:0);
      if(nextZone===row.time_zone&&nextDirector===row.director_enabled)return this.stateByOwner(row.owner)!;
      const active=this.bindings(row.owner)[row.active_mode];
      this.bumpScene(active);
      this.db.prepare(`UPDATE scene_interactions SET time_zone=?,director_enabled=?,revision=revision+1 WHERE owner=?`)
        .run(nextZone,nextDirector,row.owner);
      return this.stateByOwner(row.owner)!;
    });
  }

  clock(scope:SceneScope,now=Date.now()) {
    if(!Number.isSafeInteger(now)||now<0)throw new Error('invalid_interaction_clock');
    const row=this.resolve(scope);
    if(!row)throw new Error('invalid_interaction_not_open');
    const state=this.stateByOwner(row.owner)!;
    if(state.mode==='companion')return {kind:'realtime' as const,known:true,timeMs:now,
      configuredTimeZone:state.configuredTimeZone,timeZone:state.timeZone};
    const world=this.storyClock(state.scope,now);
    const timeMs=world&&typeof world==='object'&&'state' in world&&world.state&&typeof world.state==='object'&&'timeMs' in world.state
      ? world.state.timeMs : undefined;
    return {kind:'story' as const,known:Number.isSafeInteger(timeMs),timeMs:Number.isSafeInteger(timeMs)?timeMs:null,
      configuredTimeZone:state.configuredTimeZone,timeZone:state.timeZone};
  }

  modeOf(scope:SceneScope):InteractionMode|undefined {
    return (this.db.prepare('SELECT mode FROM scene_interaction_bindings WHERE physical_key=?').get(scopeKey(scope)) as {mode:InteractionMode}|undefined)?.mode;
  }

  isTavernRoleplay(scope:SceneScope):boolean {
    const row=this.resolve(scope);
    return row?.host==='sillytavern'&&row.active_mode==='roleplay'&&this.modeOf(scope)==='roleplay';
  }

  /** Bound product calls carry the control revision; legacy unbound low-level scopes remain valid. */
  assertActive(scope:SceneScope,expectedRevision?:number):InteractionState|undefined {
    const binding=this.binding(scope);
    if(!binding)return undefined;
    if(expectedRevision===undefined)throw new Error('invalid_interaction_revision');
    assertRevision(expectedRevision);
    const row=this.row(binding.owner)!;
    if(row.active_mode!==binding.mode)throw new Error('invalid_interaction_scope');
    if(row.revision!==expectedRevision)throw new Error('context_changed_retry');
    return this.stateByOwner(row.owner)!;
  }

  assertWorldMode(scope:SceneScope,mode:'story'|'companion'|null):void {
    if(mode===null)return;
    const binding=this.binding(scope);
    if(!binding)return;
    const expected=binding.mode==='roleplay'?'story':'companion';
    if(mode!==expected)throw new Error('invalid_interaction_world_mode');
  }

  /** Bind an already-created scene fork to a new owner without copying the other mode. */
  inherit(from:SceneScope,to:SceneScope,host:InteractionHost):InteractionState|undefined {
    assertHost(host);
    return this.transaction(()=>{
      const binding=this.binding(from);
      if(!binding)return undefined;
      const parent=this.row(binding.owner)!;
      this.assertHost(parent,host);
      if(parent.active_mode!==binding.mode)throw new Error('invalid_interaction_scope');
      if(this.resolve(to))throw new Error('invalid_interaction_fork');
      const parentBase=JSON.parse(parent.base_scope) as SceneScope;
      const baseScope={...parentBase,branchId:to.branchId};
      const owner=scopeKey(baseScope);
      if(this.row(owner))throw new Error('invalid_interaction_fork');
      this.db.prepare(`INSERT INTO scene_interactions
        (owner,base_scope,host,active_mode,revision,director_enabled,time_zone) VALUES(?,?,?,?,?,?,?)`)
        .run(owner,JSON.stringify(baseScope),host,parent.active_mode,parent.revision,parent.director_enabled,parent.time_zone);
      this.insertBinding(owner,parent.active_mode,to,true);
      const other:InteractionMode=parent.active_mode==='roleplay'?'companion':'roleplay';
      this.insertBinding(owner,other,derivedScope(baseScope,other));
      return this.stateByOwner(owner)!;
    });
  }

  /** Keep lifecycle fork creation and mode inheritance in one SQLite savepoint. */
  fork<T extends {scope:SceneScope}>(from:SceneScope,host:InteractionHost,create:()=>T):T {
    assertHost(host);
    return this.transaction(()=>{
      const binding=this.binding(from);
      if(binding){
        const parent=this.row(binding.owner)!;
        this.assertHost(parent,host);
        if(parent.active_mode!==binding.mode)throw new Error('invalid_interaction_scope');
      }
      const result=create();
      if(binding)this.inherit(from,result.scope,host);
      return result;
    });
  }

  /** Roleplay without a configured story clock must not age during wall-clock pauses. */
  frozenRoleplayTime(scope:SceneScope):number|undefined {
    const binding=this.binding(scope);
    if(binding?.mode!=='roleplay')return undefined;
    const row=this.db.prepare('SELECT created FROM scene_worlds WHERE key=?').get(scopeKey(scope)) as {created:number}|undefined;
    return row?.created;
  }

  private checkedState(row:InteractionRow,host:InteractionHost):InteractionState {
    this.assertHost(row,host);
    if(host==='agent'&&row.active_mode!=='companion'||host==='agent-roleplay'&&row.active_mode!=='roleplay')throw new Error('invalid_interaction_mode');
    return this.stateByOwner(row.owner)!;
  }
  private assertHost(row:InteractionRow,host:InteractionHost) {
    if(row.host!==host)throw new Error('invalid_interaction_host');
  }
  private resolve(scope:SceneScope):InteractionRow|undefined {
    const key=scopeKey(scope);
    const binding=this.db.prepare('SELECT owner FROM scene_interaction_bindings WHERE physical_key=?').get(key) as {owner:string}|undefined;
    return binding?this.row(binding.owner):this.row(key);
  }
  private row(owner:string):InteractionRow|undefined {
    return this.db.prepare(`SELECT owner,base_scope,host,active_mode,revision,director_enabled,time_zone
      FROM scene_interactions WHERE owner=?`).get(owner) as InteractionRow|undefined;
  }
  private binding(scope:SceneScope):BindingRow|undefined {
    return this.db.prepare(`SELECT owner,mode,physical_scope,physical_key FROM scene_interaction_bindings WHERE physical_key=?`)
      .get(scopeKey(scope)) as BindingRow|undefined;
  }
  private bindings(owner:string):Record<InteractionMode,SceneScope> {
    const rows=this.db.prepare('SELECT mode,physical_scope FROM scene_interaction_bindings WHERE owner=?').all(owner) as {mode:InteractionMode;physical_scope:string}[];
    const values=Object.fromEntries(rows.map(row=>[row.mode,JSON.parse(row.physical_scope)])) as Partial<Record<InteractionMode,SceneScope>>;
    if(!values.roleplay||!values.companion)throw new Error('invalid_interaction_bindings');
    return values as Record<InteractionMode,SceneScope>;
  }
  private stateByOwner(owner:string):InteractionState|undefined {
    const row=this.row(owner);if(!row)return undefined;
    const bindings=this.bindings(owner);
    const configuredTimeZone=row.time_zone;
    return {baseScope:JSON.parse(row.base_scope),scope:bindings[row.active_mode],host:row.host,mode:row.active_mode,
      revision:row.revision,directorEnabled:row.director_enabled===1,directorAvailable:true,configuredTimeZone,
      timeZone:configuredTimeZone??systemTimeZone(),bindings};
  }
  private insertBinding(owner:string,mode:InteractionMode,scope:SceneScope,allowExistingScene=false):void {
    if(!allowExistingScene&&this.db.prepare('SELECT 1 FROM scene_worlds WHERE key=?').get(scopeKey(scope)))
      throw new Error('invalid_interaction_binding');
    this.db.prepare('INSERT INTO scene_interaction_bindings(owner,mode,physical_scope,physical_key) VALUES(?,?,?,?)')
      .run(owner,mode,JSON.stringify(scope),scopeKey(scope));
  }
  private materializeRoster(from:SceneScope,to:SceneScope):void {
    const targetKey=scopeKey(to);
    if(this.db.prepare('SELECT 1 FROM scene_worlds WHERE key=?').get(targetKey))return;
    const source=this.db.prepare('SELECT roster FROM scene_worlds WHERE key=?').get(scopeKey(from)) as {roster:string}|undefined;
    if(!source)return;
    this.db.prepare('INSERT INTO scene_worlds(key,scope,roster,version,created) VALUES(?,?,?,?,?)')
      .run(targetKey,JSON.stringify(to),source.roster,1,Date.now());
  }
  private bumpScene(scope:SceneScope):void {
    const key=scopeKey(scope);
    this.db.prepare('UPDATE scene_worlds SET version=version+1 WHERE key=?').run(key);
    // Legacy single-character work uses the same physical scope and its own
    // optimistic version. A mode/settings change invalidates both pipelines.
    if(this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='scopes'").get())
      this.db.prepare('UPDATE scopes SET version=version+1 WHERE key=?').run(key);
  }
  private transaction<T>(work:()=>T):T {
    const name=`interaction_${this.savepointSequence++}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {const result=work();this.db.exec(`RELEASE ${name}`);return result;}
    catch(error){this.db.exec(`ROLLBACK TO ${name}`);this.db.exec(`RELEASE ${name}`);throw error;}
  }
}

function derivedScope(base:SceneScope,mode:InteractionMode):SceneScope {
  const digest=createHash('sha256').update(scopeKey(base)).update('\0').update(mode).digest('hex').slice(0,32);
  return {...base,branchId:`xldb-${mode}-${digest}`};
}
function worldMode(serialized:string):'story'|'companion' {
  const value=JSON.parse(serialized) as {mode?:unknown};
  if(value.mode!=='story'&&value.mode!=='companion')throw new Error('invalid_interaction_world_mode');
  return value.mode;
}
function assertHost(value:unknown):asserts value is InteractionHost {
  if(value!=='sillytavern'&&value!=='agent'&&value!=='agent-roleplay')throw new Error('invalid_interaction_host');
}
function assertMode(value:unknown):asserts value is InteractionMode {
  if(value!=='roleplay'&&value!=='companion')throw new Error('invalid_interaction_mode');
}
function assertRevision(value:unknown):asserts value is number {
  if(!Number.isSafeInteger(value)||(value as number)<1)throw new Error('invalid_interaction_revision');
}
function validateTimeZone(value:string):void {
  if(typeof value!=='string'||!value.trim()||value.length>100)throw new Error('invalid_interaction_time_zone');
  try {new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);}
  catch {throw new Error('invalid_interaction_time_zone');}
}
function systemTimeZone():string {
  const value=Intl.DateTimeFormat().resolvedOptions().timeZone;
  return value||'UTC';
}
