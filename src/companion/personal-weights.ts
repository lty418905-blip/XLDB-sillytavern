import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

export type PersonalTaskType='contact'|'relationship';
export interface PersonalScope {worldId:string;sessionId:string;branchId:string;characterId:string;subjectId:string}
export interface LearningTrace {
  scopeKey:string;taskType:PersonalTaskType;modelIdentity:string;parameterVersion:number;
  requestId:string;questionId:string;state:string;question:string;options:Record<string,string>;
  keys:string[];features:number[][];baseLogits:number[];
}
export interface PersonalFeedback {
  trace:LearningTrace;labelKey:string;sourceId:string;sourceRevision:number;
  kind:'explicit'|'behavior';weight?:number;
}
type Sample={trace:LearningTrace;labelKey:string;weight:number;sourceId:string;sourceRevision:number};
interface WeightRow {version:number;weights:string;bias:number;model_identity:string}
interface SampleRow {trace:string;label_key:string;weight:number;source_id:string;source_revision:number}
const FEATURE_SIZE=256;

export function personalScopeKey(scope:PersonalScope):string {
  for(const value of [scope.worldId,scope.sessionId,scope.branchId,scope.characterId,scope.subjectId])
    if(typeof value!=='string'||!value.trim())throw new Error('invalid_personal_scope');
  return JSON.stringify(['agent','companion',scope.worldId,scope.sessionId,scope.branchId,scope.characterId,scope.subjectId]);
}

export class PersonalWeightsStore {
  private readonly db:DatabaseSync;
  constructor(db:DatabaseSync){
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS companion_personal_samples (
      scope_key TEXT NOT NULL, task_type TEXT NOT NULL, source_id TEXT NOT NULL,
      question_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
      trace TEXT NOT NULL, label_key TEXT NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL,
      PRIMARY KEY(scope_key,task_type,source_id,question_id)
    );
    CREATE TABLE IF NOT EXISTS companion_personal_weights (
      scope_key TEXT NOT NULL, task_type TEXT NOT NULL, model_identity TEXT NOT NULL, head_key TEXT NOT NULL,
      version INTEGER NOT NULL, weights TEXT NOT NULL, bias REAL NOT NULL,
      sample_fingerprint TEXT NOT NULL, train_loss REAL NOT NULL, validation_loss REAL,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(scope_key,task_type,model_identity,head_key)
    );
    CREATE TABLE IF NOT EXISTS companion_personal_captures (
      scope_key TEXT NOT NULL, task_type TEXT NOT NULL, binding_id TEXT NOT NULL,
      traces TEXT NOT NULL, PRIMARY KEY(scope_key,task_type,binding_id)
    );
    CREATE TABLE IF NOT EXISTS companion_personal_generation (
      scope_key TEXT NOT NULL, task_type TEXT NOT NULL, model_identity TEXT NOT NULL,
      version INTEGER NOT NULL, PRIMARY KEY(scope_key,task_type,model_identity)
    );`);
  }

  capture(input:{scopeKey:string;taskType:PersonalTaskType;bindingId:string;traces:LearningTrace[]}):boolean {
    const {scopeKey,taskType,bindingId,traces}=input;
    this.checkScope(scopeKey);checkTask(taskType);
    if(!bindingId||!traces.length||traces.length>128)throw new Error('invalid_personal_capture');
    for(const trace of traces){validateTrace(trace);if(trace.scopeKey!==scopeKey||trace.taskType!==taskType)
      throw new Error('invalid_personal_capture');}
    const serialized=JSON.stringify(traces);
    const old=this.db.prepare(`SELECT traces FROM companion_personal_captures
      WHERE scope_key=? AND task_type=? AND binding_id=?`).get(scopeKey,taskType,bindingId) as {traces:string}|undefined;
    if(old){if(old.traces===serialized)return false;throw new Error('conflicting_personal_capture');}
    this.db.prepare(`INSERT INTO companion_personal_captures(scope_key,task_type,binding_id,traces)
      VALUES(?,?,?,?)`).run(scopeKey,taskType,bindingId,serialized);
    return true;
  }

  captured(scopeKey:string,taskType:PersonalTaskType,bindingId:string):LearningTrace[] {
    this.checkScope(scopeKey);checkTask(taskType);
    const row=this.db.prepare(`SELECT traces FROM companion_personal_captures
      WHERE scope_key=? AND task_type=? AND binding_id=?`).get(scopeKey,taskType,bindingId) as {traces:string}|undefined;
    return row?JSON.parse(row.traces) as LearningTrace[]:[];
  }

  hasFeedback(scopeKey:string,taskType:PersonalTaskType,sourceId:string,sourceRevision:number,questionId:string):boolean {
    this.checkScope(scopeKey);checkTask(taskType);
    const row=this.db.prepare(`SELECT 1 FROM companion_personal_samples WHERE scope_key=? AND task_type=?
      AND source_id=? AND source_revision=? AND question_id=?`).get(scopeKey,taskType,sourceId,sourceRevision,questionId);
    return row!==undefined;
  }

  synchronizeSources(scopeKey:string,sources:Array<{id:string;revision:number}>):number {
    this.checkScope(scopeKey);
    const active=new Map(sources.map(source=>[source.id,source.revision]));
    if(active.size!==sources.length||sources.some(source=>!source.id||!Number.isSafeInteger(source.revision)||source.revision<0))
      throw new Error('invalid_personal_sources');
    const rows=this.db.prepare(`SELECT source_id,source_revision,task_type FROM companion_personal_samples WHERE scope_key=?`)
      .all(scopeKey) as Array<{source_id:string;source_revision:number;task_type:PersonalTaskType}>;
    let removed=0;
    for(const row of rows)if(active.get(row.source_id)!==row.source_revision){
      const affected=this.db.prepare(`SELECT trace FROM companion_personal_samples WHERE scope_key=? AND task_type=?
        AND source_id=? AND source_revision=?`).all(scopeKey,row.task_type,row.source_id,row.source_revision) as Array<{trace:string}>;
      const result=this.db.prepare(`DELETE FROM companion_personal_samples WHERE scope_key=? AND task_type=?
        AND source_id=? AND source_revision=?`).run(scopeKey,row.task_type,row.source_id,row.source_revision);
      removed+=Number(result.changes);
      for(const item of affected){const trace=JSON.parse(item.trace) as LearningTrace;
        this.invalidate(scopeKey,trace.taskType,personalHeadKey(trace)!);}
    }
    return removed;
  }

  forgetCapture(scopeKey:string,taskType:PersonalTaskType,bindingId:string):void {
    this.checkScope(scopeKey);checkTask(taskType);
    this.db.prepare(`DELETE FROM companion_personal_captures WHERE scope_key=? AND task_type=? AND binding_id=?`)
      .run(scopeKey,taskType,bindingId);
  }

  version(scopeKey:string,taskType:PersonalTaskType,modelIdentity:string):number {
    this.checkScope(scopeKey);checkTask(taskType);
    const active=this.db.prepare(`SELECT 1 FROM companion_personal_weights WHERE scope_key=? AND task_type=?
      AND model_identity=? AND active=1 LIMIT 1`).get(scopeKey,taskType,modelIdentity);
    if(!active)return 0;
    const row=this.db.prepare(`SELECT version FROM companion_personal_generation
      WHERE scope_key=? AND task_type=? AND model_identity=?`).get(scopeKey,taskType,modelIdentity) as {version:number}|undefined;
    return row?.version??0;
  }

  status(scopeKey:string):{samples:number;heads:Array<{taskType:PersonalTaskType;modelIdentity:string;
    headKey:string;version:number;trainLoss:number;validationLoss:number|null}>} {
    this.checkScope(scopeKey);
    const count=this.db.prepare(`SELECT COUNT(*) AS count FROM companion_personal_samples WHERE scope_key=?`)
      .get(scopeKey) as {count:number};
    const rows=this.db.prepare(`SELECT task_type,model_identity,head_key,version,train_loss,validation_loss
      FROM companion_personal_weights WHERE scope_key=? AND active=1 ORDER BY task_type,head_key`)
      .all(scopeKey) as Array<{task_type:PersonalTaskType;model_identity:string;head_key:string;
        version:number;train_loss:number;validation_loss:number|null}>;
    return {samples:count.count,heads:rows.map(row=>({taskType:row.task_type,modelIdentity:row.model_identity,
      headKey:row.head_key,version:row.version,trainLoss:row.train_loss,validationLoss:row.validation_loss}))};
  }

  logits(trace:LearningTrace):number[] {
    return this.adjustedLogits(trace)??[...trace.baseLogits];
  }

  adjustedLogits(trace:LearningTrace):number[]|null {
    validateTrace(trace);const row=this.readWeights(trace);
    if(!row)return null;
    const weights=JSON.parse(row.weights) as number[];
    if(weights.length!==FEATURE_SIZE||weights.some(value=>!Number.isFinite(value))||!Number.isFinite(row.bias))
      throw new Error('invalid_personal_weights');
    return trace.baseLogits.map((base,index)=>base+row.bias+dot(weights,trace.features[index]));
  }

  recordFeedback(input:PersonalFeedback,inTransaction=false):boolean {
    const {trace,labelKey,sourceId,sourceRevision,kind}=input;
    validateTrace(trace);this.checkScope(trace.scopeKey);
    if(!personalHeadKey(trace))throw new Error('unsupported_personal_question');
    if(!trace.keys.includes(labelKey)||typeof sourceId!=='string'||!sourceId||
      !Number.isSafeInteger(sourceRevision)||sourceRevision<0||!['explicit','behavior'].includes(kind))
      throw new Error('invalid_personal_feedback');
    const weight=input.weight??(kind==='explicit'?1:0.25);
    if(!Number.isFinite(weight)||weight<=0||weight>1||kind==='behavior'&&weight>0.5)
      throw new Error('invalid_personal_feedback');
    const existing=this.db.prepare(`SELECT trace,label_key,source_revision,weight,kind FROM companion_personal_samples
      WHERE scope_key=? AND task_type=? AND source_id=? AND question_id=?`)
      .get(trace.scopeKey,trace.taskType,sourceId,trace.questionId) as
      {trace:string;label_key:string;source_revision:number;weight:number;kind:string}|undefined;
    const serialized=JSON.stringify(trace);
    if(existing&&existing.source_revision>sourceRevision)throw new Error('stale_personal_feedback');
    if(existing&&existing.source_revision===sourceRevision){
      if(existing.trace===serialized&&existing.label_key===labelKey&&existing.weight===weight&&existing.kind===kind)return false;
      throw new Error('conflicting_personal_feedback');
    }
    if(!inTransaction)this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare(`INSERT INTO companion_personal_samples
        (scope_key,task_type,source_id,question_id,source_revision,trace,label_key,kind,weight)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,task_type,source_id,question_id)
        DO UPDATE SET source_revision=excluded.source_revision,trace=excluded.trace,
          label_key=excluded.label_key,kind=excluded.kind,weight=excluded.weight`)
        .run(trace.scopeKey,trace.taskType,sourceId,trace.questionId,sourceRevision,serialized,labelKey,kind,weight);
      // New observations wait in the queue; keep the last trained head until idle training succeeds.
      if(existing)this.invalidate(trace.scopeKey,trace.taskType,personalHeadKey(trace)!);
      if(!inTransaction)this.db.exec('COMMIT');
    }catch(error){if(!inTransaction)this.db.exec('ROLLBACK');throw error;}
    return true;
  }

  reconcileSource(scopeKey:string,sourceId:string,activeRevision:number|null):number {
    this.checkScope(scopeKey);
    if(!sourceId||activeRevision!==null&&(!Number.isSafeInteger(activeRevision)||activeRevision<0))
      throw new Error('invalid_personal_source');
    const affected=this.db.prepare(`SELECT trace FROM companion_personal_samples WHERE scope_key=? AND source_id=?
      AND (? IS NULL OR source_revision<>?)`).all(scopeKey,sourceId,activeRevision,activeRevision) as Array<{trace:string}>;
    const result=this.db.prepare(`DELETE FROM companion_personal_samples WHERE scope_key=? AND source_id=?
      AND (? IS NULL OR source_revision<>?)`).run(scopeKey,sourceId,activeRevision,activeRevision);
    for(const item of affected){const trace=JSON.parse(item.trace) as LearningTrace;
      this.invalidate(scopeKey,trace.taskType,personalHeadKey(trace)!);}
    return Number(result.changes);
  }

  pruneRelationshipSamples(scopeKey:string,input:{active:readonly {sourceId:string;sourceRevision:number;questionId:string}[];
    visibleSourceIds:readonly string[];correctedMetrics:readonly string[];
    invalidDomains:readonly {metric:string;domain:string}[]}):{
    removed:number;modelIdentities:string[]} {
    this.checkScope(scopeKey);
    const current=new Set(input.active.map(item=>JSON.stringify([item.sourceId,item.sourceRevision,item.questionId])));
    const visible=new Set(input.visibleSourceIds),corrected=new Set(input.correctedMetrics);
    const invalid=new Set(input.invalidDomains.map(item=>JSON.stringify([item.metric,item.domain])));
    const rows=this.db.prepare(`SELECT source_id,source_revision,question_id,trace FROM companion_personal_samples
      WHERE scope_key=? AND task_type='relationship'`).all(scopeKey) as Array<{
      source_id:string;source_revision:number;question_id:string;trace:string}>;
    let removed=0;const models=new Set<string>();
    for(const row of rows){
      if(current.has(JSON.stringify([row.source_id,row.source_revision,row.question_id])))continue;
      const trace=JSON.parse(row.trace) as LearningTrace;
      const obsoleteContract=!row.question_id.startsWith('rbool4:');
      let domain:string|undefined;
      try{domain=JSON.parse(trace.state).evidence?.[0]?.domain;}catch{/* Old trace without structured evidence. */}
      if(!obsoleteContract&&!visible.has(row.source_id)&&!corrected.has(trace.requestId)&&
        !invalid.has(JSON.stringify([trace.requestId,domain])))continue;
      this.db.prepare(`DELETE FROM companion_personal_samples WHERE scope_key=? AND task_type='relationship'
        AND source_id=? AND question_id=?`).run(scopeKey,row.source_id,row.question_id);
      this.invalidate(scopeKey,'relationship',personalHeadKey(trace)??undefined);
      models.add(trace.modelIdentity);
      removed++;
    }
    return {removed,modelIdentities:[...models]};
  }

  reset(scopeKey:string,taskType?:PersonalTaskType):void {
    this.checkScope(scopeKey);if(taskType)checkTask(taskType);
    for(const table of ['companion_personal_samples','companion_personal_weights','companion_personal_captures']){
      this.db.prepare(`DELETE FROM ${table} WHERE scope_key=?${taskType?' AND task_type=?':''}`)
        .run(...(taskType?[scopeKey,taskType]:[scopeKey]));
    }
    this.db.prepare(`UPDATE companion_personal_generation SET version=version+1 WHERE scope_key=?${taskType?' AND task_type=?':''}`)
      .run(...(taskType?[scopeKey,taskType]:[scopeKey]));
  }

  train(scopeKey:string,taskType:PersonalTaskType,modelIdentity:string,assertActive:()=>void=()=>{}):{
    activated:boolean;version:number;samples:number;trainLossBefore:number|null;trainLossAfter:number|null;
    validationLossBefore:number|null;validationLossAfter:number|null;weightNorm:number;steps:number;
  } {
    this.checkScope(scopeKey);checkTask(taskType);
    if(!modelIdentity)throw new Error('invalid_personal_model');
    const rows=this.db.prepare(`SELECT trace,label_key,weight,source_id,source_revision
      FROM companion_personal_samples WHERE scope_key=? AND task_type=? ORDER BY rowid`)
      .all(scopeKey,taskType) as unknown as SampleRow[];
    const samples:Sample[]=rows.map(row=>({trace:JSON.parse(row.trace) as LearningTrace,
      labelKey:row.label_key,weight:row.weight,sourceId:row.source_id,sourceRevision:row.source_revision}))
      .filter(row=>row.trace.modelIdentity===modelIdentity);
    for(const sample of samples){validateTrace(sample.trace);if(!sample.trace.keys.includes(sample.labelKey)||
      !personalHeadKey(sample.trace))throw new Error('invalid_personal_sample');}
    if(!samples.length){this.invalidate(scopeKey,taskType);return {activated:false,version:this.version(scopeKey,taskType,modelIdentity),samples:0,trainLossBefore:null,
      trainLossAfter:null,validationLossBefore:null,validationLossAfter:null,weightNorm:0,steps:0};}
    const grouped=new Map<string,Sample[]>();
    for(const sample of samples){const key=personalHeadKey(sample.trace)!;
      const group=grouped.get(key)??[];group.push(sample);grouped.set(key,group);}
    const reports=[...grouped].map(([headKey,group])=>{
      assertActive();return this.trainHead(scopeKey,taskType,modelIdentity,headKey,group,assertActive);
    });
    const sum=(field:'trainLossBefore'|'trainLossAfter'|'validationLossBefore'|'validationLossAfter')=>{
      const values=reports.map(report=>report[field]).filter((value):value is number=>value!==null);
      return values.length?values.reduce((total,value)=>total+value,0)/values.length:null;
    };
    return {activated:reports.some(report=>report.activated),version:this.version(scopeKey,taskType,modelIdentity),
      samples:samples.length,trainLossBefore:sum('trainLossBefore'),trainLossAfter:sum('trainLossAfter'),
      validationLossBefore:sum('validationLossBefore'),validationLossAfter:sum('validationLossAfter'),
      weightNorm:Math.hypot(...reports.map(report=>report.weightNorm)),
      steps:reports.reduce((total,report)=>total+report.steps,0)};
  }

  private trainHead(scopeKey:string,taskType:PersonalTaskType,modelIdentity:string,headKey:string,samples:Sample[],assertActive:()=>void){
    const fingerprint=createHash('sha256').update(JSON.stringify(samples)).digest('hex');
    const current=this.db.prepare(`SELECT version,sample_fingerprint,weights,bias,active FROM companion_personal_weights
      WHERE scope_key=? AND task_type=? AND model_identity=? AND head_key=?`).get(scopeKey,taskType,modelIdentity,headKey) as
      {version:number;sample_fingerprint:string;weights:string;bias:number;active:number}|undefined;
    if(current?.sample_fingerprint===fingerprint&&current.active===1)return {activated:false,version:current.version,samples:samples.length,
      trainLossBefore:null,trainLossAfter:null,validationLossBefore:null,validationLossAfter:null,
      weightNorm:Math.hypot(...JSON.parse(current.weights)),steps:0};
    // Bound CPU work while mixing older evidence with recent accepted feedback.
    const selected=samples.length>256?[...samples.slice(0,-128)
      .sort((a,b)=>sourceRank(a.sourceId)-sourceRank(b.sourceId)).slice(0,128),...samples.slice(-128)]:samples;
    const sourceIds=[...new Set(selected.map(sample=>sample.sourceId))];
    let heldSource:string|null=null;
    if(sourceIds.length>=5){
      heldSource=sourceIds.find(stableHoldout)??sourceIds[sourceIds.length-1];
    }
    const validation=heldSource?selected.filter(sample=>sample.sourceId===heldSource):[];
    const held=new Set(validation);
    const training=selected.filter(sample=>!held.has(sample));
    const weights=new Array<number>(FEATURE_SIZE).fill(0);let bias=0;
    const loss=(set:typeof samples)=>set.length?set.reduce((sum,sample)=>sum+sample.weight*crossEntropy(sample.trace,
      sample.labelKey,weights,bias),0)/set.reduce((sum,sample)=>sum+sample.weight,0):null;
    const trainLossBefore=loss(training),validationLossBefore=loss(validation);
    let steps=0;
    for(let epoch=0;epoch<12&&steps<384;epoch++)for(const sample of training){
      assertActive();
      if(steps>=384)break;
      const trace=sample.trace,index=trace.keys.indexOf(sample.labelKey);
      const probabilities=softmax(trace.baseLogits.map((base,i)=>base+bias+dot(weights,trace.features[i])));
      const gradient=new Array<number>(FEATURE_SIZE).fill(0);
      let biasGradient=0;
      for(let i=0;i<probabilities.length;i++){
        const error=(probabilities[i]-(i===index?1:0))*sample.weight;
        biasGradient+=error;
        for(let j=0;j<FEATURE_SIZE;j++)gradient[j]+=error*trace.features[i][j];
      }
      const norm=Math.hypot(...gradient);
      const scale=0.02/Math.max(1,norm);
      for(let j=0;j<FEATURE_SIZE;j++)weights[j]-=scale*(gradient[j]+0.001*weights[j]);
      bias-=scale*biasGradient;
      steps++;
    }
    const trainLossAfter=loss(training),validationLossAfter=loss(validation),weightNorm=Math.hypot(...weights);
    const improved=trainLossAfter!==null&&trainLossBefore!==null&&trainLossAfter<trainLossBefore-1e-8&&
      (validationLossBefore===null||validationLossAfter!==null&&validationLossAfter<=validationLossBefore+1e-8);
    if(!improved)return {activated:false,version:this.version(scopeKey,taskType,modelIdentity),samples:samples.length,
      trainLossBefore,trainLossAfter,validationLossBefore,validationLossAfter,weightNorm,steps};
    assertActive();
    const version=this.bumpVersion(scopeKey,taskType,modelIdentity);
    this.db.prepare(`INSERT INTO companion_personal_weights
      (scope_key,task_type,model_identity,head_key,version,weights,bias,sample_fingerprint,train_loss,validation_loss,active)
      VALUES(?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(scope_key,task_type,model_identity,head_key) DO UPDATE SET
      version=excluded.version,weights=excluded.weights,bias=excluded.bias,sample_fingerprint=excluded.sample_fingerprint,
      train_loss=excluded.train_loss,validation_loss=excluded.validation_loss,active=1`)
      .run(scopeKey,taskType,modelIdentity,headKey,version,JSON.stringify(weights),bias,fingerprint,trainLossAfter,validationLossAfter);
    return {activated:true,version,samples:samples.length,trainLossBefore,trainLossAfter,
      validationLossBefore,validationLossAfter,weightNorm,steps};
  }

  private readWeights(trace:LearningTrace):WeightRow|undefined {
    const headKey=personalHeadKey(trace);
    if(!headKey)return undefined;
    return this.db.prepare(`SELECT version,weights,bias,model_identity FROM companion_personal_weights
      WHERE scope_key=? AND task_type=? AND model_identity=? AND head_key=? AND active=1`)
      .get(trace.scopeKey,trace.taskType,trace.modelIdentity,headKey) as WeightRow|undefined;
  }
  private invalidate(scopeKey:string,taskType?:PersonalTaskType,headKey?:string):void {
    const where=`scope_key=?${taskType?' AND task_type=?':''}${headKey?' AND head_key=?':''}`;
    const args=headKey?[scopeKey,taskType!,headKey]:taskType?[scopeKey,taskType]:[scopeKey];
    const rows=this.db.prepare(`SELECT DISTINCT task_type,model_identity FROM companion_personal_weights
      WHERE ${where} AND active=1`).all(...args) as Array<{task_type:PersonalTaskType;model_identity:string}>;
    if(!rows.length)return;
    this.db.prepare(`UPDATE companion_personal_weights SET active=0 WHERE ${where} AND active=1`).run(...args);
    for(const row of rows)this.bumpVersion(scopeKey,row.task_type,row.model_identity);
  }
  private bumpVersion(scopeKey:string,taskType:PersonalTaskType,modelIdentity:string):number {
    const row=this.db.prepare(`INSERT INTO companion_personal_generation(scope_key,task_type,model_identity,version)
      VALUES(?,?,?,1) ON CONFLICT(scope_key,task_type,model_identity)
      DO UPDATE SET version=version+1 RETURNING version`).get(scopeKey,taskType,modelIdentity) as {version:number};
    return row.version;
  }
  private checkScope(scopeKey:string):void {
    let parts:unknown;try{parts=JSON.parse(scopeKey);}catch{throw new Error('invalid_personal_scope');}
    if(!Array.isArray(parts)||parts.length!==7||parts[0]!=='agent'||parts[1]!=='companion'||
      parts.slice(2).some(part=>typeof part!=='string'||!part))throw new Error('invalid_personal_scope');
  }
}

function checkTask(taskType:PersonalTaskType):void {
  if(taskType!=='contact'&&taskType!=='relationship')throw new Error('invalid_personal_task');
}
export function personalHeadKey(trace:Pick<LearningTrace,'taskType'|'requestId'|'questionId'|'keys'>):string|null {
  if(trace.taskType==='contact'){
    if(trace.requestId==='contact'&&(trace.questionId==='clearHelp'||trace.questionId==='clearHarm')&&
      trace.keys.length===2&&trace.keys[0]==='yes'&&trace.keys[1]==='no')
      return `contact-evidence-v1:${trace.questionId}`;
    return trace.questionId==='experience'||trace.questionId==='longingExperience'?trace.questionId:null;
  }
  if(trace.taskType==='relationship')return trace.requestId?
    `${trace.keys.length===2&&trace.keys[0]==='true'&&trace.keys[1]==='false'?
      trace.questionId.startsWith('rbool1:')?'relationship-binary-v1':
      trace.questionId.startsWith('rbool2:')?'relationship-binary-v2':
        trace.questionId.startsWith('rbool3:')?'relationship-binary-v3':'relationship-binary-v4':
      'relationship-choice-v0'}:${trace.requestId}`:null;
  return null;
}
function validateTrace(trace:LearningTrace):void {
  checkTask(trace.taskType);
  if(typeof trace.scopeKey!=='string'||typeof trace.modelIdentity!=='string'||!trace.modelIdentity||
    !trace.requestId||!trace.questionId||!trace.state||!trace.question||
    !Array.isArray(trace.keys)||trace.keys.length<2||trace.keys.length>255||
    new Set(trace.keys).size!==trace.keys.length||
    !Array.isArray(trace.features)||trace.features.length!==trace.keys.length||
    !Array.isArray(trace.baseLogits)||trace.baseLogits.length!==trace.keys.length||
    trace.baseLogits.some(value=>!Number.isFinite(value))||
    trace.features.some(row=>!Array.isArray(row)||row.length!==FEATURE_SIZE||row.some(value=>!Number.isFinite(value))))
    throw new Error('invalid_personal_trace');
}
function dot(weights:number[],features:number[]):number {let sum=0;for(let i=0;i<FEATURE_SIZE;i++)sum+=weights[i]*features[i];return sum;}
function softmax(logits:number[]):number[] {
  const max=Math.max(...logits),values=logits.map(value=>Math.exp(value-max)),sum=values.reduce((a,b)=>a+b,0);
  return values.map(value=>value/sum);
}
function crossEntropy(trace:LearningTrace,labelKey:string,weights:number[],bias:number):number {
  const probabilities=softmax(trace.baseLogits.map((base,i)=>base+bias+dot(weights,trace.features[i])));
  return -Math.log(Math.max(probabilities[trace.keys.indexOf(labelKey)],1e-12));
}
function stableHoldout(sourceId:string):boolean {
  return createHash('sha256').update(sourceId).digest()[0]%5===0;
}
function sourceRank(sourceId:string):number {
  return createHash('sha256').update(sourceId).digest().readUInt32BE(0);
}
