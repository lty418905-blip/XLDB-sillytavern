import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { scopeKey } from '../core/types.ts';
import type { PerspectivePlan, SceneScope, SceneState } from './types.ts';

export type ProcessingStage = 'perspective' | 'world' | 'memory' | 'emotion' | 'preference' | 'commitment' | 'profile' | 'physiology' | 'geography' |
  'contactResponseExpectation' | 'absenceExplanation' | 'emotionRank' | 'director' | 'directorGuidance' | 'generation';
export type ProcessingStatus = 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
export type ProcessingFailureKind = 'rate_limited' | 'format' | 'conflict' | 'configuration' | 'transport' | 'validation' | 'unknown';

export interface ProcessingAddress {
  scope: SceneScope;
  sourceId: string;
  revision: number;
  stage: ProcessingStage;
  characterId?: string;
}

export interface ProcessingFailure {
  kind: ProcessingFailureKind;
  code: string;
  retryable: boolean;
}
export interface SkippedStage { stage:ProcessingStage; characterId?:string; failure:ProcessingFailure; attempts:number }

export interface ProcessingStageProgress {
  stage: ProcessingStage;
  characterId?: string;
  status: ProcessingStatus | 'deferred';
  failure?: ProcessingFailure;
  attempts?: number;
  /** Process-local measurements; absent after restart, never inferred from wall timestamps. */
  timing?: { durationMs?: number; cacheHits: number; attempts: number };
}

export interface ProcessingProgress {
  scope: SceneScope;
  version: number;
  accepted: { total: number; ready: number; pending: number; failed: number; degraded?: number };
  requiredReady: boolean;
  generationBlocked: boolean;
  needsReview: string[];
  sources: {
    sourceId: string;
    revision: number;
    accepted: boolean;
    requiredReady: boolean;
    status: ProcessingStatus | 'needs_review' | 'degraded';
    stages: ProcessingStageProgress[];
  }[];
}

type Row = {
  source:string; revision:number; stage:ProcessingStage; character:string; fingerprint:string;
  status:ProcessingStatus; payload:string|null; error:string|null; attempts:number;
};

/** Durable candidate stages. Payloads remain private and have no effect until SceneAuthority.commit. */
export class Processing {
  private db:DatabaseSync;
  private timings=new Map<string,{fingerprint:string;started?:number;durationMs?:number;cacheHits:number;attempts:number}>();
  private monotonicNow:()=>number;

  constructor(db:DatabaseSync,monotonicNow:()=>number=()=>performance.now()) {
    this.db=db;
    this.monotonicNow=monotonicNow;
    db.exec(`CREATE TABLE IF NOT EXISTS scene_processing_stages (
      scope TEXT NOT NULL, source TEXT NOT NULL, revision INTEGER NOT NULL,
      stage TEXT NOT NULL, character TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, payload TEXT, error TEXT, updated INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope,source,revision,stage,character));`);
    const columns=db.prepare('PRAGMA table_info(scene_processing_stages)').all() as {name:string}[];
    if(!columns.some(column=>column.name==='attempts'))db.exec('ALTER TABLE scene_processing_stages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE scene_processing_stages SET status='pending',payload=NULL,error=NULL WHERE status='running'");
  }

  load<T>(address:ProcessingAddress,fingerprint:string):T|undefined {
    const row=this.row(address);
    if(!row)return undefined;
    if(row.fingerprint!==fingerprint){this.remove(address);return undefined;}
    if(row.status!=='ready'||row.payload===null)return undefined;
    try{const value=JSON.parse(row.payload) as T;this.measurement(address,fingerprint).cacheHits++;return value;}
    catch{this.remove(address);return undefined;}
  }

  start(address:ProcessingAddress,fingerprint:string,now=Date.now()):void {
    this.db.prepare(`INSERT INTO scene_processing_stages(scope,source,revision,stage,character,fingerprint,status,payload,error,updated,attempts)
      VALUES(?,?,?,?,?,?,'running',NULL,NULL,?,1)
      ON CONFLICT(scope,source,revision,stage,character) DO UPDATE SET
      fingerprint=excluded.fingerprint,status='running',payload=NULL,error=NULL,updated=excluded.updated,
      attempts=CASE WHEN scene_processing_stages.fingerprint=excluded.fingerprint THEN scene_processing_stages.attempts+1 ELSE 1 END`)
      .run(scopeKey(address.scope),address.sourceId,address.revision,address.stage,address.characterId??'',fingerprint,now);
    const timing=this.measurement(address,fingerprint);timing.started=this.monotonicNow();timing.durationMs=undefined;timing.attempts++;
  }

  complete(address:ProcessingAddress,fingerprint:string,payload:unknown,now=Date.now()):void {
    this.db.prepare(`INSERT INTO scene_processing_stages(scope,source,revision,stage,character,fingerprint,status,payload,error,updated,attempts)
      VALUES(?,?,?,?,?,?,'ready',?,NULL,?,0)
      ON CONFLICT(scope,source,revision,stage,character) DO UPDATE SET
      fingerprint=excluded.fingerprint,status='ready',payload=excluded.payload,error=NULL,updated=excluded.updated`)
      .run(scopeKey(address.scope),address.sourceId,address.revision,address.stage,address.characterId??'',fingerprint,JSON.stringify(payload),now);
    this.finishTiming(address,fingerprint);
  }

  fail(address:ProcessingAddress,fingerprint:string,error:unknown,now=Date.now()):ProcessingFailure {
    const failure=processingFailure(error);
    this.db.prepare(`INSERT INTO scene_processing_stages(scope,source,revision,stage,character,fingerprint,status,payload,error,updated,attempts)
      VALUES(?,?,?,?,?,?,'failed',NULL,?,?,0)
      ON CONFLICT(scope,source,revision,stage,character) DO UPDATE SET
      fingerprint=excluded.fingerprint,status='failed',payload=NULL,error=excluded.error,updated=excluded.updated`)
      .run(scopeKey(address.scope),address.sourceId,address.revision,address.stage,address.characterId??'',fingerprint,failure.code,now);
    this.finishTiming(address,fingerprint);
    return failure;
  }

  clearScope(scope:SceneScope):void {
    this.db.prepare('DELETE FROM scene_processing_stages WHERE scope=?').run(scopeKey(scope));
    for(const key of this.timings.keys())if(JSON.parse(key)[0]===scopeKey(scope))this.timings.delete(key);
  }

  clearAll():void { this.db.exec('DELETE FROM scene_processing_stages');this.timings.clear(); }

  clearSources(scope:SceneScope,sourceIds:readonly string[]):void {
    const remove=this.db.prepare('DELETE FROM scene_processing_stages WHERE scope=? AND source=?');
    for(const sourceId of new Set(sourceIds))remove.run(scopeKey(scope),sourceId);
    for(const key of this.timings.keys()){const [keyScope,source]=JSON.parse(key);if(keyScope===scopeKey(scope)&&sourceIds.includes(source))this.timings.delete(key);}
  }

  discard(address:ProcessingAddress):void { this.remove(address); }

  state(address:ProcessingAddress,fingerprint:string):{status:ProcessingStatus;attempts:number;failure?:ProcessingFailure}|undefined {
    const row=this.row(address);
    if(!row||row.fingerprint!==fingerprint)return undefined;
    return {status:row.status,attempts:row.attempts,...(row.error?{failure:processingFailure(row.error)}:{})};
  }

  skippedForSource(scope:SceneScope,sourceId:string,revision:number):SkippedStage[] {
    return this.rows(scope).filter(row=>row.source===sourceId&&row.revision===revision&&row.status==='skipped')
      .map(row=>({stage:row.stage,...(row.character?{characterId:row.character}:{}),
        failure:processingFailure(row.error??'operation_failed'),attempts:row.attempts}));
  }

  skip(address:ProcessingAddress,fingerprint:string,error:unknown,now=Date.now()):SkippedStage {
    const failure=processingFailure(error);
    this.db.prepare(`UPDATE scene_processing_stages SET status='skipped',payload=NULL,error=?,updated=?
      WHERE scope=? AND source=? AND revision=? AND stage=? AND character=? AND fingerprint=?`)
      .run(failure.code,now,scopeKey(address.scope),address.sourceId,address.revision,address.stage,address.characterId??'',fingerprint);
    this.finishTiming(address,fingerprint);
    return {stage:address.stage,...(address.characterId?{characterId:address.characterId}:{}),failure,
      attempts:this.state(address,fingerprint)?.attempts??0};
  }

  failStored(address:ProcessingAddress,error:unknown,now=Date.now()):ProcessingFailure {
    const failure=processingFailure(error);
    this.db.prepare(`UPDATE scene_processing_stages SET status='failed',payload=NULL,error=?,updated=?
      WHERE scope=? AND source=? AND revision=? AND stage=? AND character=?`)
      .run(failure.code,now,scopeKey(address.scope),address.sourceId,address.revision,address.stage,address.characterId??'');
    return failure;
  }

  progress(scope:SceneScope,state:SceneState,worldEnabled:boolean,physiologyEnabled=false,geographyEnabled=false):ProcessingProgress {
    const needsReview=state.sources.filter(source=>source.status==='needs_review').map(source=>source.id);
    const accepted=state.sources.filter(source=>source.status==='accepted');
    const rows=this.rows(scope);
    const sources=state.sources.filter(source=>source.status!=='deleted').map(source=>{
      if(source.status==='needs_review')return {sourceId:source.id,revision:source.revision,accepted:false,requiredReady:false,
        status:'needs_review' as const,stages:[] as ProcessingStageProgress[]};
      const current=rows.filter(row=>row.source===source.id&&row.revision===source.revision);
      const plan=source.analysis?.plan??this.planFrom(current);
      const expected:{stage:ProcessingStage;characterId?:string}[]=[{stage:'perspective'}];
      if(current.some(row=>row.stage==='commitment')||source.analysis?.commitmentOperations)expected.push({stage:'commitment'});
      if(current.some(row=>row.stage==='profile')||source.analysis?.userModelCandidates)expected.push({stage:'profile'});
      if(worldEnabled)expected.push({stage:'world'});
      if(physiologyEnabled||current.some(row=>row.stage==='physiology')||source.analysis?.physiologyOperations)expected.push({stage:'physiology'});
      if(geographyEnabled||current.some(row=>row.stage==='geography')||source.analysis?.geographyOperations)expected.push({stage:'geography'});
      if(plan)for(const characterId of new Set(plan.observations.flatMap(observation=>observation.readers))) {
        expected.push({stage:'memory',characterId},{stage:'emotion',characterId},{stage:'preference',characterId});
      }
      const stages=expected.map(item=>{
        const row=current.find(candidate=>candidate.stage===item.stage&&candidate.character===(item.characterId??''));
        const measurement=this.timings.get(this.timingKey({scope,sourceId:source.id,revision:source.revision,...item}));
        const timing=measurement&&row?.fingerprint===measurement.fingerprint?{cacheHits:measurement.cacheHits,attempts:measurement.attempts,
          ...(measurement.durationMs===undefined?{}:{durationMs:measurement.durationMs})}:undefined;
        const skipped=source.analysis?.skippedStages?.find(value=>value.stage===item.stage&&value.characterId===item.characterId);
        if(skipped)return {...item,status:'skipped' as const,attempts:skipped.attempts,failure:skipped.failure,...(timing?{timing}:{})};
        if(source.processing==='ready')return {...item,status:item.stage==='emotion'&&source.analysis?.emotionPendingIds?.includes(item.characterId??'')
          ?'deferred' as const:'ready' as const,...(timing?{timing}:{})};
        if(!row)return {...item,status:'pending' as const};
        return {...item,status:row.status,...(row.status==='skipped'?{attempts:row.attempts}:{}),...(timing?{timing}:{}),
          ...(row.status==='failed'||row.status==='skipped'?{failure:processingFailure(row.error??'operation_failed')}:{})};
      });
      const degraded=source.processing==='ready'&&Boolean(source.analysis?.skippedStages?.length);
      return {sourceId:source.id,revision:source.revision,accepted:true,requiredReady:source.processing==='ready'&&!degraded,
        status:degraded?'degraded' as const:source.processing,stages};
    });
    const degraded=accepted.filter(source=>source.processing==='ready'&&source.analysis?.skippedStages?.length).length;
    const counts={total:accepted.length,ready:accepted.filter(source=>source.processing==='ready'&&!source.analysis?.skippedStages?.length).length,
      pending:accepted.filter(source=>source.processing==='pending').length,failed:accepted.filter(source=>source.processing==='failed').length,
      ...(degraded?{degraded}:{})};
    const requiredReady=needsReview.length===0&&counts.ready===counts.total;
    return {scope,version:state.version,accepted:counts,requiredReady,
      generationBlocked:needsReview.length>0||counts.pending>0||counts.failed>0,needsReview,sources};
  }

  private planFrom(rows:Row[]):PerspectivePlan|undefined {
    const row=rows.find(candidate=>candidate.stage==='perspective'&&candidate.character===''&&candidate.status==='ready'&&candidate.payload!==null);
    if(!row)return undefined;
    try{return JSON.parse(row.payload!) as PerspectivePlan;}catch{return undefined;}
  }

  private rows(scope:SceneScope):Row[] {
    return this.db.prepare(`SELECT source,revision,stage,character,fingerprint,status,payload,error,attempts
      FROM scene_processing_stages WHERE scope=? ORDER BY rowid`).all(scopeKey(scope)) as Row[];
  }

  private row(address:ProcessingAddress):Row|undefined {
    return this.db.prepare(`SELECT source,revision,stage,character,fingerprint,status,payload,error,attempts
      FROM scene_processing_stages WHERE scope=? AND source=? AND revision=? AND stage=? AND character=?`)
      .get(scopeKey(address.scope),address.sourceId,address.revision,address.stage,address.characterId??'') as Row|undefined;
  }

  private remove(address:ProcessingAddress):void {
    this.timings.delete(this.timingKey(address));
    this.db.prepare('DELETE FROM scene_processing_stages WHERE scope=? AND source=? AND revision=? AND stage=? AND character=?')
      .run(scopeKey(address.scope),address.sourceId,address.revision,address.stage,address.characterId??'');
  }
  private timingKey(address:ProcessingAddress):string {
    return JSON.stringify([scopeKey(address.scope),address.sourceId,address.revision,address.stage,address.characterId??'']);
  }
  private measurement(address:ProcessingAddress,fingerprint:string) {
    const key=this.timingKey(address);let value=this.timings.get(key);
    if(!value||value.fingerprint!==fingerprint){value={fingerprint,cacheHits:0,attempts:0};this.timings.delete(key);this.timings.set(key,value);}
    while(this.timings.size>512)this.timings.delete(this.timings.keys().next().value!);
    return value;
  }
  private finishTiming(address:ProcessingAddress,fingerprint:string):void {
    const value=this.measurement(address,fingerprint);
    if(value.started!==undefined){value.durationMs=Math.max(0,this.monotonicNow()-value.started);delete value.started;}
  }
}

export function processingFingerprint(value:unknown):string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function processingFailure(error:unknown):ProcessingFailure {
  const raw=typeof error==='string'?error:error instanceof Error?error.message:'';
  const code=/^(model_(not_configured|connection_failed|stream_failed|output_incomplete|invalid_response|invalid_json|output_truncated|http_\d{3})|host_(timeout|closed|worker_failed|invalid_result)|context_changed_retry|invalid_[a-z_]+|[a-z_]+_missing_source|unsafe_episode_projection|unsafe_rewrite)$/.test(raw)
    ?raw:'operation_failed';
  if(code==='model_http_429')return {kind:'rate_limited',code,retryable:true};
  if(code==='context_changed_retry')return {kind:'conflict',code,retryable:true};
  if(code==='model_not_configured')return {kind:'configuration',code,retryable:true};
  if(code==='model_connection_failed'||code==='model_stream_failed'||code==='model_output_incomplete'||code==='model_http_408'||code==='model_http_502'||code==='model_http_503'||code==='model_http_504'||code.startsWith('host_'))
    return {kind:'transport',code,retryable:true};
  if(code==='model_invalid_json'||code==='model_invalid_response'||code==='model_output_truncated'||code.startsWith('invalid_')||code.endsWith('_missing_source')||code==='unsafe_episode_projection'||code==='unsafe_rewrite')
    return {kind:'format',code,retryable:true};
  if(/^model_http_\d{3}$/.test(code))return {kind:'validation',code,retryable:Number(code.slice(-3))>=500};
  return {kind:'unknown',code:'operation_failed',retryable:true};
}

function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
