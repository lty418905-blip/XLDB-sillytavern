import {spawn} from 'node:child_process';
import type {ChildProcess,SpawnOptions} from 'node:child_process';

export type ProcessKind='agentjev'|'daemon'|'browser';
export type ThreadKind='agentjev-identity'|'learning';
export interface ProcessPolicy {readonly maxLive:number;readonly detached:boolean}
/**
 * Per-kind ceiling on in-service children and whether a kind may be detached. Infinity means no ceiling: agentjev has
 * none until one shared service per process owns that worker. The daemon and browser values are provisional until
 * those kinds have a caller.
 */
export const PROCESS_POLICY:Readonly<Record<ProcessKind,ProcessPolicy>>=Object.freeze({
  agentjev:Object.freeze({maxLive:Infinity,detached:false}),
  daemon:Object.freeze({maxLive:3,detached:true}),
  browser:Object.freeze({maxLive:1,detached:false}),
});
export const THREAD_KINDS:readonly ThreadKind[]=Object.freeze(['agentjev-identity','learning'] as const);

export interface ProcessListing {kind:ProcessKind;pid:number|null;startedAt:string|null;state:'starting'|'running'|'stopping';detached:boolean;executable:string}
export interface ThreadListing {kind:ThreadKind;threadId:number|null;startedAt:string|null}
export interface SpawnerCounts {
  createdTotal:Record<ProcessKind,number>;spawnErrors:Record<ProcessKind,number>;refused:Record<ProcessKind,number>;
  threadsCreated:Record<ThreadKind,number>;threadsRejected:number;
}
export interface SpawnerDeps {
  spawn:(file:string,args:readonly string[],options:SpawnOptions)=>ChildProcess;
  onExit:(handler:()=>void)=>void;
  now:()=>number;
}
export interface Spawner {
  spawnManaged(kind:ProcessKind,file:string,args:readonly string[],options?:SpawnOptions):ChildProcess;
  trackThread<T>(kind:ThreadKind,worker:T):T;
  processes():ProcessListing[];
  threads():ThreadListing[];
  counts():SpawnerCounts;
}
export function createSpawner(deps:SpawnerDeps):Spawner
{
  try{
    if(typeof deps!=='object'||deps===null||typeof deps.spawn!=='function'||typeof deps.onExit!=='function'||typeof deps.now!=='function')
      throw new Error('process_spawner_deps_invalid');
  }catch{throw new Error('process_spawner_deps_invalid');}
  type ProcessEntry={child:ChildProcess;kind:ProcessKind;file:string;detached:boolean;created:boolean;removed:boolean;startedAt:string|null};
  type ThreadEntry={worker:{once:(event:string,handler:()=>void)=>unknown;threadId?:unknown};kind:ThreadKind;startedAt:string|null};
  const children=new Set<ProcessEntry>(),workers=new Map<unknown,ThreadEntry>();
  const totals:SpawnerCounts={createdTotal:{agentjev:0,daemon:0,browser:0},spawnErrors:{agentjev:0,daemon:0,browser:0},
    refused:{agentjev:0,daemon:0,browser:0},threadsCreated:{'agentjev-identity':0,learning:0},threadsRejected:0};
  let exitInstalled=false;
  function timestamp():string|null {
    try{const value=deps.now();return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=8640000000000000
      ?new Date(value).toISOString():null;}catch{return null;}
  }
  function killed(child:ChildProcess):boolean {try{return child.killed===true;}catch{return false;}}
  function exitHandler():void {
    for(const entry of [...children]){
      if(entry.detached)continue;
      try{entry.child.kill();}catch{}
    }
  }
  function installExit():void {
    if(exitInstalled)return;
    try{deps.onExit(exitHandler);exitInstalled=true;}catch{}
  }
  function spawnManaged(kind:ProcessKind,file:string,args:readonly string[],options?:SpawnOptions):ChildProcess {
    if(typeof kind!=='string'||!Object.hasOwn(PROCESS_POLICY,kind))throw new Error('process_kind_unknown');
    let copied:SpawnOptions;
    try{
      if(options!==undefined&&(typeof options!=='object'||options===null||Array.isArray(options)))throw new Error('process_spawn_options_invalid');
      copied={...options};
    }catch{throw new Error('process_spawn_options_invalid');}
    if(copied.detached&&!PROCESS_POLICY[kind].detached)throw new Error('process_detached_forbidden');
    // The ceiling check and listings scan registered entries in O(n); basename extraction is O(file.length).
    let live=0;
    for(const entry of children)if(entry.kind===kind&&!killed(entry.child))live++;
    if(live>=PROCESS_POLICY[kind].maxLive){totals.refused[kind]++;throw new Error('process_kind_busy');}
    let child:ChildProcess;
    try{child=deps.spawn(file,args,copied);}catch(error){totals.spawnErrors[kind]++;throw error;}
    const entry:ProcessEntry={child,kind,file,detached:Boolean(copied.detached),created:false,removed:false,startedAt:null};
    const onSpawn=()=>{try{
      if(entry.removed||entry.created)return;
      entry.created=true;totals.createdTotal[kind]++;entry.startedAt=timestamp();
    }catch{}};
    const onError=()=>{try{
      if(entry.removed||entry.created)return;
      totals.spawnErrors[kind]++;entry.removed=true;children.delete(entry);
    }catch{}};
    const onChildExit=()=>{try{
      if(entry.removed)return;
      if(!entry.created)totals.createdTotal[kind]++;
      entry.removed=true;children.delete(entry);
    }catch{}};
    try{
      if(typeof child!=='object'||child===null)throw new Error('unregistrable');
      const on=child.on as (event:string,handler:()=>void)=>unknown;
      if(typeof on!=='function')throw new Error('unregistrable');
      on.call(child,'spawn',onSpawn);on.call(child,'error',onError);on.call(child,'exit',onChildExit);
    }catch{entry.removed=true;totals.spawnErrors[kind]++;return child;}
    if(!entry.removed){children.add(entry);installExit();}return child;
  }
  function trackThread<T>(kind:ThreadKind,worker:T):T {
    if(!THREAD_KINDS.includes(kind)){totals.threadsRejected++;return worker;}
    if(workers.has(worker))return worker;
    try{
      if(typeof worker!=='object'||worker===null)throw new Error('unregistrable');
      const object=worker as unknown as ThreadEntry['worker'],once=object.once;
      if(typeof once!=='function')throw new Error('unregistrable');
      once.call(worker,'exit',()=>{try{workers.delete(worker);}catch{}});
      workers.set(worker,{worker:object,kind,startedAt:timestamp()});totals.threadsCreated[kind]++;
    }catch{totals.threadsRejected++;}
    return worker;
  }
  function processes():ProcessListing[] {
    return [...children].map(entry=>{
      let pid:number|null=null;
      try{const value=entry.child.pid;if(typeof value==='number'&&Number.isSafeInteger(value)&&value>0)pid=value;}catch{}
      const file=entry.file;
      return {kind:entry.kind,pid,startedAt:entry.startedAt,state:killed(entry.child)?'stopping':entry.created?'running':'starting',
        detached:entry.detached,executable:typeof file==='string'?file.slice(Math.max(file.lastIndexOf('/'),file.lastIndexOf('\\'))+1):''};
    });
  }
  function threads():ThreadListing[] {
    return [...workers.values()].map(entry=>{
      let threadId:number|null=null;
      try{const value=entry.worker.threadId;if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)threadId=value;}catch{}
      return {kind:entry.kind,threadId,startedAt:entry.startedAt};
    });
  }
  function counts():SpawnerCounts {
    return {createdTotal:{...totals.createdTotal},spawnErrors:{...totals.spawnErrors},refused:{...totals.refused},
      threadsCreated:{...totals.threadsCreated},threadsRejected:totals.threadsRejected};
  }
  return {spawnManaged,trackThread,processes,threads,counts};
}

// The one product-wide instance. The closure reads the child_process binding at call time; nothing runs at import.
const shared=createSpawner({
  spawn:(file,args,options)=>spawn(file,args,options),
  onExit:handler=>{process.on('exit',handler);},
  now:()=>Date.now(),
});
export const spawnManaged=shared.spawnManaged;
export const trackThread=shared.trackThread;
export const processes=shared.processes;
export const threads=shared.threads;
export const counts=shared.counts;
