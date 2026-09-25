import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHmac} from 'node:crypto';
import type {Scope} from '../memory/access.ts';

type Address={sourceId?:string;revision?:number;stage?:string;characterId?:string;roundId?:string;parts?:readonly string[];attempt?:number};
type Event={id:number;at:string;requestId:string;operation:string;scope:Scope;bindingId?:string;kind:'model'|'stage';
  status:string;durationMs?:number;model?:string;modelGroupId?:string;inputCharacters?:number;outputCharacters?:number;
  inputTokens?:number|null;outputTokens?:number|null;cachedInputTokens?:number|null;apiAttempt?:boolean;physicalRequestId?:string;
  transportStatus?:'not_dispatched'|'completed'|'failed';businessValidation?:'not_checked'|'passed'|'failed';
  error?:string;attempt?:number}&Address;
type Context={log:RuntimeLog;scope:Scope;bindingId?:string;requestId:string;operation:string}&Address;
const endpointSalt=randomUUID();
const context=new AsyncLocalStorage<Context>();
const modelUsage=new AsyncLocalStorage<{inputTokens:number|null;outputTokens:number|null;cachedInputTokens:number|null;physicalRequestId?:string;transportStatus?:Event['transportStatus']}>();
/** Called at the actual HTTP dispatch boundary, after local configuration checks. */
export function recordModelDispatch(){
  const current=modelUsage.getStore();
  if(current)current.physicalRequestId=randomUUID();
}
/** A response was received; later structured-output rejection is not a connection failure. */
export function recordModelResponse(){const current=modelUsage.getStore();if(current)current.transportStatus='completed';}
export function recordModelUsage(value:unknown){
  const current=modelUsage.getStore();if(!current||!value||typeof value!=='object')return;
  const usage=value as Record<string,unknown>;
  for(const [target,source] of [['inputTokens','prompt_tokens'],['outputTokens','completion_tokens']] as const){
    const count=usage[source];current[target]=typeof count==='number'&&Number.isSafeInteger(count)&&count>=0?count:null;
  }
  const details=usage.prompt_tokens_details;
  const cached=details&&typeof details==='object'?(details as Record<string,unknown>).cached_tokens:undefined;
  const count=cached??usage.prompt_cache_hit_tokens;
  // Each usage object is a cumulative snapshot, never mix fields from different snapshots.
  current.cachedInputTokens=typeof count==='number'&&Number.isSafeInteger(count)&&count>=0?count:null;
  if(current.cachedInputTokens!==null&&current.inputTokens!==null&&current.cachedInputTokens>current.inputTokens)current.cachedInputTokens=null;
}
const sameScope=(a:Scope,b:Scope)=>a.worldId===b.worldId&&a.sessionId===b.sessionId&&a.branchId===b.branchId&&a.characterId===b.characterId;
const errorCode=(error:unknown)=>error instanceof Error&&/^(model_[a-z_]+(?:_\d{3})?|invalid_[a-z_]+|context_changed_retry)$/.test(error.message)?error.message:'operation_failed';

/** Bounded process-local diagnostics. Never retains prompts, responses, credentials or endpoints. */
export class RuntimeLog {
  private events:Event[]=[];
  private sequence=0;
  readonly startedAt=new Date().toISOString();
  private capacity:number;
  constructor(capacity=1000){this.capacity=capacity;}
  enter(scope:Scope,operation:string,bindingId?:string){
    context.enterWith({log:this,scope:{...scope},bindingId,requestId:randomUUID(),operation});
  }
  append(event:Omit<Event,'id'>){
    this.events.push({...event,id:++this.sequence,scope:{...event.scope}});
    if(this.events.length>this.capacity)this.events.splice(0,this.events.length-this.capacity);
  }
  snapshot(scope:Scope,bindingId?:string){
    const events=this.events.filter(event=>sameScope(event.scope,scope)&&event.bindingId===bindingId);
    const model=events.filter(event=>event.kind==='model');
    const dispatched=model.filter(event=>event.apiAttempt);
    const tokenUsage=summarizeTokens(dispatched);
    const groups=new Map<string,Event[]>();
    for(const event of dispatched){const key=event.modelGroupId??event.model??'unknown';const list=groups.get(key)??[];list.push(event);groups.set(key,list);}
    const tokenUsageByModel=[...groups].map(([modelGroupId,items])=>({modelGroupId,model:items[0].model??'未知模型',...summarizeTokens(items)}));
    return {schema:'xldb-runtime-log-v1',exportedAt:new Date().toISOString(),startedAt:this.startedAt,scope:{...scope},
      retention:{kind:'process-local',capacity:this.capacity,windowScope:'all-scopes',windowTruncated:this.sequence>this.capacity},
      coverage:'已记录窗口内的后台文本模型、embedding、reranker 调用及处理阶段；不含酒馆正文与独立宿主调用。字符数不是 token 数；服务未提供用量时为 null。',
      tokenUsage,tokenUsageByModel,
      summary:{apiAttempts:model.filter(event=>event.apiAttempt).length,failedCalls:model.filter(event=>event.apiAttempt&&event.status==='failed').length,
        undispatchedFailures:model.filter(event=>!event.apiAttempt&&event.status==='failed').length,
        cacheHits:events.filter(event=>event.status==='cache_hit').length,inputCharacters:model.reduce((n,event)=>n+(event.inputCharacters??0),0),
        inputTokens:model.length&&model.every(event=>event.inputTokens!=null)?model.reduce((n,e)=>n+e.inputTokens!,0):null,
        outputTokens:model.length&&model.every(event=>event.outputTokens!=null)?model.reduce((n,e)=>n+e.outputTokens!,0):null,
        callsWithoutTokenUsage:model.filter(event=>event.inputTokens==null||event.outputTokens==null).length},events:structuredClone(events)};
  }
}

function summarizeTokens(dispatched:Event[]){
    const cacheReported=dispatched.filter(event=>event.inputTokens!=null&&event.cachedInputTokens!=null&&event.cachedInputTokens<=event.inputTokens);
    const cacheEligibleInputTokens=cacheReported.reduce((sum,event)=>sum+event.inputTokens!,0);
    const cachedInputTokens=cacheReported.reduce((sum,event)=>sum+event.cachedInputTokens!,0);
    return {apiCalls:dispatched.length,
      reportedInputTokens:dispatched.reduce((sum,event)=>sum+(event.inputTokens??0),0),
      reportedOutputTokens:dispatched.reduce((sum,event)=>sum+(event.outputTokens??0),0),
      inputReportedCalls:dispatched.filter(event=>event.inputTokens!=null).length,
      outputReportedCalls:dispatched.filter(event=>event.outputTokens!=null).length,
      cacheReportedCalls:cacheReported.length,cachedInputTokens,cacheEligibleInputTokens,
      cacheHitRate:cacheEligibleInputTokens>0?cachedInputTokens/cacheEligibleInputTokens:null};
}

function record(kind:Event['kind'],status:string,fields:Partial<Event>={}){
  const active=context.getStore();if(!active)return;
  const {log,...metadata}=active;
  log.append({...metadata,at:new Date().toISOString(),kind,status,...fields} as Omit<Event,'id'>);
}
export function recordStage(status:string,address:Address){record('stage',status,address);}
export function withModelAddress<T>(address:Address,work:()=>Promise<T>):Promise<T>{
  const active=context.getStore();return active?context.run({...active,...address},work):work();
}
export function traceStage<T>(address:Address,attempt:number,work:()=>Promise<T>|T):Promise<T>{
  const active=context.getStore();
  const run=async()=>{const start=performance.now();record('stage','running',{attempt});
    try{const result=await work();record('stage','completed',{attempt,businessValidation:'passed',durationMs:Math.round(performance.now()-start)});return result;}
    catch(error){record('stage','failed',{attempt,businessValidation:'failed',durationMs:Math.round(performance.now()-start),error:errorCode(error)});throw error;}};
  return active?context.run({...active,...address,attempt},run):run();
}
export function traceModel<T>(config:{model:string;baseUrl:string},prompts:readonly {content:string}[],work:()=>Promise<T>):Promise<T>{
  return modelUsage.run({inputTokens:null,outputTokens:null,cachedInputTokens:null},async()=>{
  const start=performance.now();const fields={model:config.model,modelGroupId:createHmac('sha256',endpointSalt).update(JSON.stringify([config.baseUrl.trim().replace(/\/+$/,''),config.model])).digest('hex').slice(0,16),inputCharacters:prompts.reduce((n,p)=>n+p.content.length,0),
    inputTokens:null,outputTokens:null};
  try{const value=await work();const usage=modelUsage.getStore();record('model','completed',{...fields,...usage,
    apiAttempt:Boolean(usage?.physicalRequestId),transportStatus:usage?.physicalRequestId?'completed':'not_dispatched',
    businessValidation:'not_checked',...(typeof value==='string'?{outputCharacters:value.length}:{}),durationMs:Math.round(performance.now()-start)});return value;}
  catch(error){const usage=modelUsage.getStore();record('model','failed',{...fields,...usage,
    apiAttempt:Boolean(usage?.physicalRequestId),transportStatus:usage?.physicalRequestId
      ?error instanceof Error&&['model_connection_failed','model_stream_failed'].includes(error.message)?'failed':usage.transportStatus??'failed'
      :'not_dispatched',
    businessValidation:'not_checked',error:errorCode(error),durationMs:Math.round(performance.now()-start)});throw error;}
  });
}
