import type {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {scopeKey} from '../core/types.ts';
import type {SceneAnalysis,SceneScope,SceneSource,SceneState} from './types.ts';
import {decodeLedgerAccountEvent,decodeLedgerCorrection,decodeLedgerMarks,serializeLedger,LEDGER_LIMITS} from './world-ledger.ts';
import type {LedgerAccountEvent,LedgerCorrection,LedgerFoldOptions} from './world-ledger.ts';
import {foldWorldState} from './world-state.ts';
import type {WorldSettings} from './world-state.ts';

const ACCOUNTS='scene_world_ledger_accounts';
const CORRECTIONS='scene_world_ledger_corrections';

export interface WorldLedgerAccountRow {
  scope:string; id:string; seq:number; created:number; kind:LedgerAccountEvent['kind']; body:string;
}
export interface WorldLedgerCorrectionRow {
  scope:string; id:string; seq:number; created:number; source_id:string|null; source_revision:number|null;
  kind:LedgerCorrection['action']; body:string;
}
export type RejectedWorldLedgerRow=(WorldLedgerAccountRow|WorldLedgerCorrectionRow)&{
  table:'accounts'|'corrections'; reason:string;
};
export interface WorldLedgerRows {
  accounts:(WorldLedgerAccountRow&{value:LedgerAccountEvent})[];
  corrections:(WorldLedgerCorrectionRow&{value:LedgerCorrection})[];
  rejected:RejectedWorldLedgerRow[];
  /** Includes malformed rows for diagnostics; usable rows alone determine fold behavior. */
  hasRows:boolean;
}

function tableExists(db:DatabaseSync,table:string):boolean {
  return db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table)!==undefined;
}

/** Writes call this inside their transaction. No existence cache survives a rolled-back CREATE. */
export function ensureWorldLedgerTables(db:DatabaseSync):void {
  db.exec(`CREATE TABLE IF NOT EXISTS scene_world_ledger_accounts (
    scope TEXT NOT NULL REFERENCES scene_worlds(key), id TEXT NOT NULL, seq INTEGER NOT NULL,
    created INTEGER NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(scope,seq), UNIQUE(scope,id));
    CREATE TABLE IF NOT EXISTS scene_world_ledger_corrections (
    scope TEXT NOT NULL REFERENCES scene_worlds(key), id TEXT NOT NULL, seq INTEGER NOT NULL,
    created INTEGER NOT NULL, source_id TEXT, source_revision INTEGER, kind TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(scope,id), UNIQUE(scope,seq));`);
}

/** Raw strings are snapshot and fingerprint inputs, never decoded and re-serialized. O(rows). */
export function captureWorldLedgerRows(db:DatabaseSync,scope:SceneScope):{
  worldLedgerAccounts?:WorldLedgerAccountRow[]; worldLedgerCorrections?:WorldLedgerCorrectionRow[];
} {
  const key=scopeKey(scope);
  const accounts=tableExists(db,ACCOUNTS)?db.prepare(`SELECT scope,id,seq,created,kind,body FROM ${ACCOUNTS} WHERE scope=? ORDER BY seq`).all(key) as unknown as WorldLedgerAccountRow[]:[];
  const corrections=tableExists(db,CORRECTIONS)?db.prepare(`SELECT scope,id,seq,created,source_id,source_revision,kind,body FROM ${CORRECTIONS} WHERE scope=? ORDER BY seq`).all(key) as unknown as WorldLedgerCorrectionRow[]:[];
  return {...(accounts.length?{worldLedgerAccounts:accounts}:{}),...(corrections.length?{worldLedgerCorrections:corrections}:{})};
}

/** O(total row JSON + sorting within each stored record); no chat-wide row or node cap. */
export function readWorldLedgerRows(db:DatabaseSync,scope:SceneScope):WorldLedgerRows {
  const raw=captureWorldLedgerRows(db,scope),accounts:WorldLedgerRows['accounts']=[],corrections:WorldLedgerRows['corrections']=[],rejected:RejectedWorldLedgerRow[]=[];
  for(const row of raw.worldLedgerAccounts??[]) {
    let reason='body_json_invalid';
    try {
      const decoded=decodeLedgerAccountEvent(JSON.parse(row.body));
      if(decoded.ok){
        const value=decoded.value;
        if(row.id===value.id&&row.seq===value.seq&&row.kind===value.kind){accounts.push({...row,value});continue;}
        reason='ledger_row_mismatch';
      }else reason=decoded.code;
    }catch{ /* A malformed stored row is panel data, not a read failure. */ }
    rejected.push({...row,table:'accounts',reason});
  }
  for(const row of raw.worldLedgerCorrections??[]) {
    let reason='body_json_invalid';
    try {
      const decoded=decodeLedgerCorrection(JSON.parse(row.body));
      if(decoded.ok){
        const value=decoded.value;
        if(row.id===value.id&&row.seq===value.seq&&row.kind===value.action&&
          row.source_id===(value.sourceId??null)&&row.source_revision===(value.revision??null)){
          corrections.push({...row,value});continue;
        }
        reason='ledger_row_mismatch';
      }else reason=decoded.code;
    }catch{ /* A malformed stored row is panel data, not a read failure. */ }
    rejected.push({...row,table:'corrections',reason});
  }
  return {accounts,corrections,rejected,hasRows:accounts.length+corrections.length+rejected.length>0};
}

export function worldLedgerOptions(rows:WorldLedgerRows):LedgerFoldOptions {
  return {...(rows.accounts.length?{accountEvents:rows.accounts.map(row=>row.value)}:{}),
    ...(rows.corrections.length?{corrections:rows.corrections.map(row=>row.value)}:{})};
}

/** O(JSON length plus ledger decoding); malformed JSON-compatible data stays available for ledger diagnostics. */
export function storedLedgerFields(input:unknown):Pick<SceneAnalysis,'ledgerMarks'|'ledger'> {
  const out:Pick<SceneAnalysis,'ledgerMarks'|'ledger'>={};
  for(const key of ['ledgerMarks','ledger'] as const)try {
    if(input===null||typeof input!=='object'||!Object.hasOwn(input,key))continue;
    const raw=(input as Record<string,unknown>)[key];
    if(raw===null||raw===undefined)continue;
    const decoded=key==='ledger'?serializeLedger(raw):decodeLedgerMarks(raw);
    const text=decoded.ok?(key==='ledger'?decoded.value as string:JSON.stringify(decoded.value)):JSON.stringify(raw);
    if(text!==undefined&&text!=='null'&&jsonDepthWithinLimit(text))Object.defineProperty(out,key,{value:JSON.parse(text),enumerable:true,writable:true,configurable:true});
  }catch{ /* Throwing getters, toJSON, cycles and non-JSON values count as an absent optional key. */ }
  return out;
}

/** O(JSON length), O(1) space; quoted brackets and escaped quotes do not contribute to container depth. */
function jsonDepthWithinLimit(text:string):boolean {
  let depth=0,quoted=false,escaped=false;
  for(const character of text){
    if(quoted){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;}
    else if(depth>LEDGER_LIMITS.jsonDepth&&character!=='}'&&character!==']'&&!/\s/.test(character))return false;
    else if(character==='"')quoted=true;
    else if(character==='{'||character==='['){if(depth++>LEDGER_LIMITS.jsonDepth)return false;}
    else if(character==='}'||character===']')depth--;
  }
  return true;
}

/** Names follow the opening-settings derivation, without interpreting a date or importing assets. O(roster labels). */
export function ledgerOnlySettings(head:SceneState):WorldSettings|null {
  try{
  const first=head.sources[0]?.status==='accepted'?head.sources[0]:undefined;
  const playerName=first?.envelope.playerName?.trim()||'玩家',used=new Set<string>([playerName]);
  const actorLabels=Object.fromEntries(head.roster.characters.map(actor=>{
    const labels=[actor.name,...actor.aliases].filter(label=>label&&label!=='我'&&!used.has(label));
    if(!labels.length)labels.push(actor.id);
    for(const label of labels)used.add(label);
    return [actor.id,labels];
  }));
  const settings:WorldSettings={mode:'story',startTimeMs:head.createdAtMs,actorLabels,playerName,publicTime:true,balances:[],inventory:[]};
  foldWorldState(settings,[]);return settings;
  }catch{return null;}
}

type DraftAccount<T> = T extends LedgerAccountEvent ? Omit<T,'id'|'seq'|'after'> : never;
export type WorldLedgerWrite = {table:'accounts';value:DraftAccount<LedgerAccountEvent>}
  | {table:'corrections';value:Omit<LedgerCorrection,'id'|'seq'|'after'>};
/** Limits apply to one panel call and one encoded row, never to accumulated chat history. */
export const WORLD_LEDGER_WRITE_LIMITS=Object.freeze({batch:256,bodyBytes:2_097_152,batchBytes:8_388_608});
const invalidWrite=()=>new Error('invalid_world_ledger_write');

/** Detaches caller data before any checkpoint. The ledger model remains the sole stored-body decoder. */
export function prepareWorldLedgerWrites(input:readonly WorldLedgerWrite[]):WorldLedgerWrite[] {
  try {
    if(!Array.isArray(input)||input.length===0||input.length>WORLD_LEDGER_WRITE_LIMITS.batch)throw invalidWrite();
    const detached=structuredClone(input);
    for(const row of detached)if(!row||!['accounts','corrections'].includes(row.table)||
      !row.value||typeof row.value!=='object'||Array.isArray(row.value))throw invalidWrite();
    return detached;
  }catch{throw invalidWrite();}
}

/** O(sources + existing corrections + batch); no per-write scan over the source history. */
export function guardWorldLedgerBindings(state:SceneState,writes:WorldLedgerWrite[],rows:ReturnType<typeof captureWorldLedgerRows>):void {
  const sources=new Map(state.sources.map(source=>[source.id,source]));
  const kinds=new Map((rows.worldLedgerCorrections??[]).map(row=>[row.id,row.kind]));
  for(const write of writes){
    if(write.table!=='corrections')continue;
    const value=write.value;
    if(value.sourceId==null)delete value.sourceId;
    if(value.revision==null)delete value.revision;
    const target=typeof value.anchor==='string'&&value.anchor.startsWith('user:')?kinds.get(value.anchor.slice(5)):undefined;
    if(value.action==='adjustment'||value.action==='clear'&&target==='adjustment'){
      delete value.sourceId;delete value.revision;continue;
    }
    if(value.sourceId!=null||value.revision!=null){
      const source=sources.get(value.sourceId!);
      if(!source||source.status!=='accepted'||source.revision!==value.revision)throw new Error('context_changed_retry');
    }
  }
}

/** Called only inside the authority's transaction, after its version, binding and checkpoint steps. */
export function appendWorldLedgerRows(db:DatabaseSync,scope:SceneScope,state:SceneState,writes:WorldLedgerWrite[]):{id:string;seq:number;table:WorldLedgerWrite['table']}[] {
  const key=scopeKey(scope),rows=readWorldLedgerRows(db,scope);
  const accountIds=new Set(rows.accounts.filter(row=>row.value.kind==='create').map(row=>(row.value as Extract<LedgerAccountEvent,{kind:'create'}>).account.id));
  const rosterIds=new Set(['player',...state.roster.characters.map(actor=>actor.id)]);
  const kinds=new Map((captureWorldLedgerRows(db,scope).worldLedgerCorrections??[]).map(row=>[row.id,row.kind]));
  const max=db.prepare(`SELECT MAX(seq) AS seq FROM (SELECT seq FROM ${ACCOUNTS} WHERE scope=? UNION ALL SELECT seq FROM ${CORRECTIONS} WHERE scope=?)`).get(key,key) as {seq:number|null};
  let seq=max.seq??0;
  const last=state.sources.findLast(source=>source.status==='accepted');
  const after=last?{sourceId:last.id,revision:last.revision,acceptedAtMs:last.acceptedAtMs}:null;
  const created=Date.now();
  if(!Number.isSafeInteger(created)||created<0||!Number.isSafeInteger(seq)||seq<0||seq>Number.MAX_SAFE_INTEGER-writes.length)throw invalidWrite();
  let batchBytes=0;
  const result:{id:string;seq:number;table:WorldLedgerWrite['table']}[]=[];
  for(const write of writes){
    const id=randomUUID();seq++;
    if(write.table==='accounts'){
      const value={...write.value,id,seq,...(write.value.kind==='create'?{}:{after})};
      // Creation is a baseline, never a caller-selected timeline position.
      if(value.kind==='create')delete (value as {after?:unknown}).after;
      const decoded=decodeLedgerAccountEvent(value);if(!decoded.ok)throw invalidWrite();
      const event=decoded.value;
      if(event.kind==='create'){
        const account=event.account;
        if(account.kind==='private'||!account.id.startsWith('acct:')||account.id.length===5||rosterIds.has(account.id)||accountIds.has(account.id))throw invalidWrite();
        accountIds.add(account.id);
      }
      const body=JSON.stringify(event),bytes=Buffer.byteLength(body,'utf8');batchBytes+=bytes;
      if(bytes>WORLD_LEDGER_WRITE_LIMITS.bodyBytes||batchBytes>WORLD_LEDGER_WRITE_LIMITS.batchBytes)throw invalidWrite();
      db.prepare(`INSERT INTO ${ACCOUNTS}(scope,id,seq,created,kind,body) VALUES(?,?,?,?,?,?)`).run(key,id,seq,created,event.kind,body);
    }else{
      const value={...write.value,id,seq,...(write.value.action==='adjustment'?{after}:{})};
      if(value.action!=='adjustment')delete (value as {after?:unknown}).after;
      const decoded=decodeLedgerCorrection(value);if(!decoded.ok)throw invalidWrite();
      const correction=decoded.value;
      if(typeof correction.anchor==='string'&&correction.anchor.startsWith('user:')){
        const target=kinds.get(correction.anchor.slice(5));
        if(target==='adjustment'&&correction.action!=='clear'||
          target==='post'&&correction.action==='clear'&&correction.sourceId==null)throw invalidWrite();
      }
      const body=JSON.stringify(correction),bytes=Buffer.byteLength(body,'utf8');batchBytes+=bytes;
      if(bytes>WORLD_LEDGER_WRITE_LIMITS.bodyBytes||batchBytes>WORLD_LEDGER_WRITE_LIMITS.batchBytes)throw invalidWrite();
      db.prepare(`INSERT INTO ${CORRECTIONS}(scope,id,seq,created,source_id,source_revision,kind,body) VALUES(?,?,?,?,?,?,?,?)`)
        .run(key,id,seq,created,correction.sourceId??null,correction.revision??null,correction.action,body);
    }
    result.push({id,seq,table:write.table});
  }
  return result;
}

/** Source deletion never erases positioned adjustments, including legacy rows that carry a source binding. */
export function eraseWorldLedgerSource(db:DatabaseSync,scope:SceneScope,sourceId:string):{removed:number;retainedAdjustments:string[]} {
  if(!tableExists(db,CORRECTIONS))return {removed:0,retainedAdjustments:[]};
  const key=scopeKey(scope);
  const retainedAdjustments=(db.prepare(`SELECT id FROM ${CORRECTIONS} WHERE scope=? AND source_id=? AND kind='adjustment' ORDER BY seq`)
    .all(key,sourceId) as {id:string}[]).map(row=>row.id);
  const removed=Number(db.prepare(`DELETE FROM ${CORRECTIONS} WHERE scope=? AND source_id=? AND kind<>'adjustment'`).run(key,sourceId).changes);
  return {removed,retainedAdjustments};
}

/** One scope-local SQL sweep; source-id lookup uses the scene_sources primary key. */
export function sweepWorldLedgerTombstones(db:DatabaseSync,scope:SceneScope):{removed:number;retainedAdjustments:string[]} {
  if(!tableExists(db,CORRECTIONS))return {removed:0,retainedAdjustments:[]};
  const key=scopeKey(scope);
  const bound=`scope=? AND EXISTS (SELECT 1 FROM scene_sources s WHERE s.scope=${CORRECTIONS}.scope AND s.id=${CORRECTIONS}.source_id AND s.status='deleted')`;
  const retainedAdjustments=(db.prepare(`SELECT id FROM ${CORRECTIONS} WHERE ${bound} AND kind='adjustment' ORDER BY seq`).all(key) as {id:string}[]).map(row=>row.id);
  const removed=Number(db.prepare(`DELETE FROM ${CORRECTIONS} WHERE ${bound} AND kind<>'adjustment'`).run(key).changes);
  return {removed,retainedAdjustments};
}

/** Replaces one scope from raw snapshot rows. Missing/empty keys erase rows without creating either table. */
export function restoreWorldLedgerRows(db:DatabaseSync,scope:SceneScope,accounts:readonly WorldLedgerAccountRow[]=[],corrections:readonly WorldLedgerCorrectionRow[]=[]):void {
  const key=scopeKey(scope);
  for(const table of [ACCOUNTS,CORRECTIONS])if(tableExists(db,table))db.prepare(`DELETE FROM ${table} WHERE scope=?`).run(key);
  if(!accounts.length&&!corrections.length)return;
  ensureWorldLedgerTables(db);
  const accountInsert=db.prepare(`INSERT INTO ${ACCOUNTS}(scope,id,seq,created,kind,body) VALUES(?,?,?,?,?,?)`);
  for(const row of accounts)accountInsert.run(key,row.id,row.seq,row.created,row.kind,row.body);
  const correctionInsert=db.prepare(`INSERT INTO ${CORRECTIONS}(scope,id,seq,created,source_id,source_revision,kind,body) VALUES(?,?,?,?,?,?,?,?)`);
  for(const row of corrections)correctionInsert.run(key,row.id,row.seq,row.created,row.source_id,row.source_revision,row.kind,row.body);
}

/** A pure commit candidate; settlement has no separate source-writing route. */
export function replaceSceneLedger(source:SceneSource,ledger:SceneAnalysis['ledger'],ledgerMarks?:SceneAnalysis['ledgerMarks']):SceneAnalysis {
  if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis?.plan)throw new Error('context_changed_retry');
  const value={...source.analysis};
  if(ledger===undefined||ledger===null)delete value.ledger;else value.ledger=ledger;
  if(ledgerMarks!=null)value.ledgerMarks=ledgerMarks;
  return value as SceneAnalysis;
}

/** O(serialized analysis length). Only an interrupted, valid deferred ledger changes the original string. */
export function interruptDeferredLedgerAnalysis(serialized:string|null):string|null {
  if(serialized===null)return serialized;
  try{
    const analysis=JSON.parse(serialized),ledger=analysis?.ledger;
    if(!ledger||typeof ledger!=='object'||ledger.outcome!=='deferred')return serialized;
    const value={...ledger,outcome:'skipped',stop:'interrupted'};delete value.deferred;
    if(Array.isArray(value.unbooked))value.unbooked=value.unbooked.map((row:Record<string,unknown>)=>
      row?.reason==='recording'?{...row,reason:'stage_interrupted',by:'code'}:row);
    const encoded=serializeLedger(value);if(!encoded.ok)return serialized;
    analysis.ledger=JSON.parse(encoded.value);
    return JSON.stringify(analysis);
  }catch{return serialized;}
}
