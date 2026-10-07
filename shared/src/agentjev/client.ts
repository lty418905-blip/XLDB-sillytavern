import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,openSync,readSync,closeSync,statSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Worker} from 'node:worker_threads';
import {spawnManaged,trackThread} from '../process/spawner.ts';

/**
 * The host-neutral AgentJev client: install detection, the off-loop identity, the single local worker with bounded
 * failure backoff, and request/response validation. The Tavern uses it for NPC emotion ranking and schedule conflicts;
 * the Agent's companion client (companion-agent/src/companion/agentjev.ts) extends it with relationship and contact
 * decisions. The workspace root is three levels up, as it was from the companion client.
 */

const DEFAULT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');

export type Question={id:string;type:'choice';question:string;options:Record<string,string>}|
  {id:string;type:'score';question:string;levels:string[]}|
  {id:string;type:'boolean';question:string;criteria?:{true:string;false:string}};
export interface Request {id:string;state:string;questions:Question[]}
export interface Answer {id:string;type:'choice'|'score'|'boolean';value?:string|boolean;score?:number;level?:number;
  probability?:number;distribution:Record<string,number>;top_probability?:number;margin?:number}
export interface Response {id:string;results:Array<{id:string;answers:Answer[]}>;usage?:unknown;calibration?:string;
  learning?:Array<{features:number[][];baseLogits:number[]}>}
/** Where the local model lives, its timeouts and backoff; host-specific options live in subclasses. */
export interface AgentJevClientOptions {
  root?:string;executable?:string;modelDir?:string;runner?:string;
  startupTimeoutMs?:number;inferenceTimeoutMs?:number;threads?:number;
  /** Wall clock used only for failure backoff; injectable for tests. */
  now?:()=>number;
  /** Backoff after consecutive worker failures; the last step repeats. Each step is at most 30 minutes. */
  backoffMs?:readonly number[];
  /**
   * Identity already computed off the event loop (agentJevIdentityOffLoop) for these same paths. When given, the
   * constructor reads and hashes nothing, so the caller's thread never hashes the multi-GB model.
   */
  identity?:string;
}
export interface AgentJevAvailability {
  status:'available'|'backoff'|'closed'|'not_installed';retryAtMs?:number;lastError?:string;
}
export const DEFAULT_BACKOFF_MS=[30_000,120_000,600_000,1_800_000] as const;
const MAX_BACKOFF_MS=1_800_000;
interface Pending {resolve:(value:Response)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>;payload:{requests:Request[]}}

function locations(options:AgentJevClientOptions={}){
  const root=path.resolve(options.root??DEFAULT_ROOT);
  return {root,executable:path.resolve(options.executable??path.join(root,'.local/agentjev/runtime/python.exe')),
    modelDir:path.resolve(options.modelDir??path.join(root,'.local/agentjev/model')),
    runner:path.resolve(options.runner??path.join(root,'shared/third-party/agentjev/runner.py'))};
}

export function available(options:AgentJevClientOptions={}):boolean {
  const files=locations(options);
  return existsSync(files.executable)&&existsSync(path.join(files.modelDir,'model.safetensors'))&&existsSync(files.runner)&&
    releaseRuntimeMatches(files.root);
}

/**
 * A release install carries tools/agent-assets.json; its portable runtime counts as installed only when the receipt
 * .local/agentjev/release-runtime.sha256 names the manifest's runtime.sha256 (the install-check rule). A development
 * checkout has no release manifest, so there is nothing to compare against.
 */
function releaseRuntimeMatches(root:string):boolean {
  let expected:unknown;
  try{expected=(JSON.parse(readFileSync(path.join(root,'tools','agent-assets.json'),'utf8')) as {runtime?:{sha256?:unknown}})?.runtime?.sha256;}
  catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT';}
  try{return typeof expected==='string'&&readFileSync(path.join(root,'.local','agentjev','release-runtime.sha256'),'utf8').trim()===expected;}
  catch{return false;}
}

const IDENTITY_TIMEOUT_MS=600_000;
/**
 * The client identity computed on a worker thread, so the first hash of the multi-GB model never blocks the caller's
 * event loop. Pass the result as the `identity` option so the client constructed afterwards reads and hashes nothing.
 * No AgentJev process is started; aborting terminates the worker. The hash is bounded by IDENTITY_TIMEOUT_MS (a 2.4 GB
 * model hashes in well under a minute on a local disk); a timeout or an exit without an answer rejects.
 */
export function agentJevIdentityOffLoop(options:Pick<AgentJevClientOptions,'root'|'executable'|'modelDir'|'runner'>={},
  signal?:AbortSignal):Promise<string> {
  const paths=Object.fromEntries((['root','executable','modelDir','runner'] as const)
    .filter(key=>options[key]!==undefined).map(key=>[key,options[key]]));
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new Error('agentjev_identity_aborted'));return;}
    const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');
import(workerData.module).then(({AgentJevClient})=>{const client=new AgentJevClient(workerData.options);
  parentPort.postMessage({identity:client.identity()});client.close();})
  .catch(error=>parentPort.postMessage({error:String(error&&error.message||error)}));`,
    {eval:true,workerData:{module:import.meta.url,options:paths}});
    trackThread('agentjev-identity',worker);
    worker.unref();
    // Settles exactly once: on the answer, a worker error, an exit without an answer, the time limit or an abort.
    // Every failure goes through the caller's retry path instead of leaving the warm-up pending.
    let settled=false;
    const finish=(error:Error|undefined,identity?:string)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();
      if(error)reject(error);else resolve(identity!);
    };
    const timer=setTimeout(()=>finish(new Error('agentjev_identity_timeout')),IDENTITY_TIMEOUT_MS);
    timer.unref();
    const abort=()=>finish(new Error('agentjev_identity_aborted'));
    signal?.addEventListener('abort',abort,{once:true});
    worker.once('message',(value:{identity?:string;error?:string})=>{
      if(typeof value.identity==='string')finish(undefined,value.identity);else finish(new Error(value.error??'agentjev_identity_failed'));
    });
    worker.once('error',error=>finish(error));
    worker.once('exit',()=>finish(new Error('agentjev_identity_failed')));
  });
}

function sha256File(file:string):string {
  const descriptor=openSync(file,'r'),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(2*1024*1024);
  try{let count:number;while((count=readSync(descriptor,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,count));}
  finally{closeSync(descriptor);}
  return digest.digest('hex');
}
type DigestKey={size:number;mtimeMs:number;ctimeMs:number;ino:number};
function digestKey(file:string):DigestKey {
  const stat=statSync(file);return {size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino};
}
function sameKey(left:DigestKey,right:unknown):boolean {
  return object(right)&&right.size===left.size&&right.mtimeMs===left.mtimeMs&&right.ctimeMs===left.ctimeMs&&right.ino===left.ino;
}
function readDigestCache(cachePath:string):Record<string,unknown> {
  try{
    const value=JSON.parse(readFileSync(cachePath,'utf8'));
    return object(value)&&value.version===1&&object(value.entries)?value.entries:{};
  }catch{return {};}
}
/**
 * File timestamps come from a coarse clock (NTFS about 16 ms, others up to seconds), so a same-size rewrite in the
 * same tick can keep the whole stat key. As with Git's "racily clean" rule, an entry is trusted only when it was
 * recorded at least this long after the file's last mtime/ctime.
 */
const DIGEST_RACY_MS=2_000;
/**
 * SHA-256 of a large file, cached by {path,size,mtimeMs,ctimeMs,ino}. A matching, non-racy stat key reuses the stored
 * digest without reading the file. A corrupt, missing or unwritable cache only costs a full hash; it never throws.
 */
export function cachedFileSha256(file:string,cachePath:string,digestFile:(file:string)=>string=sha256File,
  now:()=>number=Date.now):string {
  const resolved=path.resolve(file),entries=readDigestCache(cachePath);
  const before=digestKey(resolved),cached=entries[resolved];
  if(sameKey(before,cached)){
    const entry=cached as {sha256?:unknown;cachedAtMs?:unknown};
    if(typeof entry.sha256==='string'&&/^[0-9a-f]{64}$/.test(entry.sha256)&&typeof entry.cachedAtMs==='number'&&
      Number.isFinite(entry.cachedAtMs)&&entry.cachedAtMs-Math.max(before.mtimeMs,before.ctimeMs)>=DIGEST_RACY_MS)
      return entry.sha256;
  }
  const sha256=digestFile(resolved);
  // Only a file that stayed unchanged while hashing may be cached.
  if(!sameKey(before,digestKey(resolved)))return sha256;
  const temporary=`${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try{
    mkdirSync(path.dirname(cachePath),{recursive:true});
    writeFileSync(temporary,JSON.stringify({version:1,entries:{...entries,[resolved]:{...before,sha256,cachedAtMs:now()}}}));
    renameSync(temporary,cachePath);
  }catch{try{unlinkSync(temporary);}catch{}}
  return sha256;
}

/** Local, single-worker CPU client. Failure is explicit; there is no remote or host-model fallback. */
export class AgentJevClient {
  private readonly files:ReturnType<typeof locations>;
  private readonly startupTimeoutMs:number;
  private readonly inferenceTimeoutMs:number;
  private readonly threads:number;
  private readonly identityValue:string;
  private readonly now:()=>number;
  private readonly backoffMs:readonly number[];
  private process:ChildProcessWithoutNullStreams|null=null;
  private opening:Promise<void>|null=null;
  private ready=false;
  /** Permanent: set only by close(). A worker failure is recoverable after backoff. */
  private disposed=false;
  private failures=0;
  private retryAtMs=0;
  private lastError:string|undefined;
  private buffer='';
  private pending=new Map<string,Pending>();
  private startupResolve:(()=>void)|null=null;
  private startupReject:((error:Error)=>void)|null=null;
  private startupTimer:ReturnType<typeof setTimeout>|null=null;

  constructor(options:AgentJevClientOptions={}){
    this.files=locations(options);
    this.startupTimeoutMs=timeout(options.startupTimeoutMs,120_000);
    this.inferenceTimeoutMs=timeout(options.inferenceTimeoutMs,180_000);
    this.threads=options.threads??4;
    this.now=options.now??Date.now;
    const backoff=options.backoffMs??DEFAULT_BACKOFF_MS;
    if(!Array.isArray(backoff)||!backoff.length||backoff.some(step=>!Number.isSafeInteger(step)||step<0||step>MAX_BACKOFF_MS))
      throw new Error('invalid_agentjev_backoff');
    this.backoffMs=[...backoff];
    if(!Number.isSafeInteger(this.threads)||this.threads<1||this.threads>8)throw new Error('invalid_agentjev_threads');
    if(options.identity!==undefined&&!/^agentjev-v2:[0-9a-f]{64}$/.test(options.identity))throw new Error('invalid_agentjev_identity');
    this.identityValue=options.identity??this.computeIdentity();
  }
  identity():string {
    return this.identityValue;
  }
  private computeIdentity():string {
    const smallFiles=[path.join(this.files.root,'.local/agentjev/bundle.json'),
      ...['config.json','tokenizer.json','tokenizer_config.json','temperatures.json'].map(name=>path.join(this.files.modelDir,name)),
      this.files.runner,...['jev_service/contract.py','jev_service/prefix.py','agentjev/model.py']
        .map(name=>path.join(path.dirname(this.files.runner),name))];
    const parts=smallFiles.map(file=>{try{return `${path.relative(this.files.root,file)}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;}
      catch{return `${path.relative(this.files.root,file)}:missing`;}});
    const model=path.join(this.files.modelDir,'model.safetensors');
    if(existsSync(model))parts.push(`model:${cachedFileSha256(model,path.join(this.files.root,'.local/agentjev/identity-cache.json'))}`);
    else parts.push('model:missing');
    return `agentjev-v2:${createHash('sha256').update(parts.join('|')).digest('hex')}`;
  }

  async evaluate(payload:unknown):Promise<Response> {
    return this.evaluateRaw(payload,false);
  }

  /** One validated request; `captureFeatures` asks the worker for the pre-fc2 learning features too. */
  protected async evaluateRaw(payload:unknown,captureFeatures:boolean):Promise<Response> {
    const expected=validatePayload(payload);
    await this.open();
    const worker=this.process;
    if(!worker||!this.ready||this.disposed)throw new Error('agentjev_unavailable');
    const id=randomUUID();
    return new Promise<Response>((resolve,reject)=>{
      const timer=setTimeout(()=>{if(this.pending.has(id))this.fail(new Error('agentjev_inference_timeout'));},this.inferenceTimeoutMs);
      this.pending.set(id,{resolve,reject,timer,payload:expected});
      worker.stdin.write(JSON.stringify({id,payload:expected,...(captureFeatures?{captureFeatures:true}:{})})+'\n',error=>{
        if(error&&worker===this.process)this.fail(new Error('agentjev_pipe_failed'));
      });
    });
  }

  /** Permanent shutdown; every later call rejects with agentjev_closed. */
  close():void {
    if(this.disposed)return;
    this.disposed=true;this.teardown(new Error('agentjev_closed'));
  }

  /** Current local-model availability; reading it never spawns or retries the worker. */
  availability():AgentJevAvailability {
    const lastError=this.lastError!==undefined?{lastError:this.lastError}:{};
    if(this.disposed)return {status:'closed',...lastError};
    if(!this.installed())return {status:'not_installed',...lastError};
    if(this.now()<this.retryAtMs)return {status:'backoff',retryAtMs:this.retryAtMs,...lastError};
    return {status:'available',...lastError};
  }

  private installed():boolean {
    return available({root:this.files.root,executable:this.files.executable,modelDir:this.files.modelDir,runner:this.files.runner});
  }

  private open():Promise<void> {
    if(this.disposed)return Promise.reject(new Error('agentjev_closed'));
    if(this.ready)return Promise.resolve();
    if(this.opening)return this.opening;
    if(this.now()<this.retryAtMs)return Promise.reject(new Error('agentjev_backoff'));
    if(!this.installed())return Promise.reject(new Error('agentjev_unavailable'));
    for(const part of ['cache/hf','tmp'])mkdirSync(path.join(this.files.root,'.local/agentjev',part),{recursive:true});
    const privateRoot=path.join(this.files.root,'.local/agentjev');
    const environment={...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HOME:path.join(privateRoot,'cache/hf'),
      HUGGINGFACE_HUB_CACHE:path.join(privateRoot,'cache/hf/hub'),TRANSFORMERS_CACHE:path.join(privateRoot,'cache/hf/transformers'),
      TEMP:path.join(privateRoot,'tmp'),TMP:path.join(privateRoot,'tmp'),TMPDIR:path.join(privateRoot,'tmp'),
      PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',TOKENIZERS_PARALLELISM:'false'};
    this.opening=new Promise<void>((resolve,reject)=>{
      this.startupResolve=resolve;this.startupReject=reject;
      this.startupTimer=setTimeout(()=>this.fail(new Error('agentjev_startup_timeout')),this.startupTimeoutMs);
      const worker=spawnManaged('agentjev',this.files.executable,[this.files.runner,'--model',this.files.modelDir,'--threads',String(this.threads)],
        {cwd:this.files.root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:environment}) as ChildProcessWithoutNullStreams;
      this.process=worker;
      // A replaced worker may still deliver late output, errors or its exit; only the current worker counts.
      worker.stdout.setEncoding('utf8');
      worker.stdout.on('data',(chunk:string)=>{if(worker===this.process)this.receive(chunk);});
      worker.stderr.on('data',()=>{}); // Do not expose Python errors or source text.
      worker.on('error',()=>{if(worker===this.process)this.fail(new Error('agentjev_process_failed'));});
      worker.on('exit',()=>{if(worker===this.process)this.fail(new Error('agentjev_process_exited'));});
    });
    return this.opening;
  }

  private receive(chunk:string):void {
    this.buffer+=chunk;
    if(this.buffer.length>1_000_000){this.fail(new Error('agentjev_invalid_response'));return;}
    let newline:number;
    while((newline=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
      let value:unknown;
      try{value=JSON.parse(line);}catch{this.fail(new Error('agentjev_invalid_response'));return;}
      if(!this.ready){
        if(!object(value)||value.status!=='ready'||value.model!=='agent-jev'||value.device!=='cpu'||value.precision!=='float32'||
          !Number.isFinite(value.loadMs)||Number(value.loadMs)<0){this.fail(new Error('agentjev_invalid_handshake'));return;}
        this.ready=true;if(this.startupTimer)clearTimeout(this.startupTimer);this.startupTimer=null;
        this.startupResolve?.();this.startupResolve=null;this.startupReject=null;
        continue;
      }
      if(!object(value)||typeof value.id!=='string'||!this.pending.has(value.id)){
        this.fail(new Error('agentjev_invalid_response'));return;
      }
      const request=this.pending.get(value.id)!;this.pending.delete(value.id);clearTimeout(request.timer);
      if(value.error){request.reject(new Error(value.error==='agentjev_context_limit'?'agentjev_context_limit':'agentjev_inference_failed'));continue;}
      let response:Response;
      try{response=validateResponse(value,request.payload);}
      catch{this.fail(new Error('agentjev_invalid_response'));request.reject(new Error('agentjev_invalid_response'));return;}
      this.failures=0;this.lastError=undefined; // One validated answer ends the failure streak.
      request.resolve(response);
    }
  }

  /** Recoverable worker failure: drop the worker and refuse to respawn until the bounded backoff expires. */
  private fail(error:Error):void {
    if(this.disposed)return;
    const step=this.backoffMs[Math.min(this.failures,this.backoffMs.length-1)];
    this.failures++;this.lastError=error.message;this.retryAtMs=this.now()+step;
    this.teardown(error);
  }

  private teardown(error:Error):void {
    if(this.startupTimer)clearTimeout(this.startupTimer);this.startupTimer=null;
    const startupReject=this.startupReject;this.startupReject=null;this.startupResolve=null;
    const pending=[...this.pending.values()];this.pending.clear();
    const worker=this.process;
    this.process=null;this.ready=false;this.opening=null;this.buffer='';
    worker?.kill();
    startupReject?.(error);
    for(const item of pending){clearTimeout(item.timer);item.reject(error);}
  }
}

function timeout(value:number|undefined,defaultMs:number):number{
  const result=value??defaultMs;if(!Number.isSafeInteger(result)||result<1||result>600_000)throw new Error('invalid_agentjev_timeout');return result;
}
export function object(value:unknown):value is Record<string,any>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
export function validatePayload(payload:unknown):{requests:Request[]}{
  if(!object(payload)||!Array.isArray(payload.requests)||payload.requests.length<1||payload.requests.length>32)throw new Error('invalid_agentjev_payload');
  let total=0;
  const requests=payload.requests.map((item:unknown)=>{
    if(!object(item)||typeof item.id!=='string'||!item.id||typeof item.state!=='string'||!item.state||
      item.state.length>4000||!Array.isArray(item.questions)||!item.questions.length)throw new Error('invalid_agentjev_payload');
    const questions=item.questions.map((question:unknown)=>{
      if(!object(question)||typeof question.id!=='string'||!question.id||
        typeof question.question!=='string'||!question.question||question.question.length>500)
        throw new Error('invalid_agentjev_payload');
      let keys:string[];
      if(question.type==='choice'&&object(question.options)){
        keys=Object.keys(question.options);
        if(keys.length<2||keys.length>255||keys.some(key=>!key||typeof question.options[key]!=='string'||
          !question.options[key]||question.options[key].length>500))
          throw new Error('invalid_agentjev_payload');
      } else if(question.type==='score'&&Array.isArray(question.levels)){
        keys=question.levels.map((_:unknown,index:number)=>String(index));
        if(keys.length<2||keys.length>10||question.levels.some((level:unknown)=>typeof level!=='string'||!level||level.length>500))
          throw new Error('invalid_agentjev_payload');
      } else if(question.type==='boolean'){
        keys=['true','false'];
        if(question.criteria!==undefined&&(!object(question.criteria)||typeof question.criteria.true!=='string'||
          typeof question.criteria.false!=='string'))throw new Error('invalid_agentjev_payload');
      } else throw new Error('invalid_agentjev_payload');
      total+=keys.length;
      return question as Question;
    });
    return {id:item.id,state:item.state,questions} as Request;
  });
  if(total>1024||requests.reduce((count,item)=>count+item.questions.length,0)>128||
    new Set(requests.map(item=>item.id)).size!==requests.length)throw new Error('invalid_agentjev_payload');
  return {requests};
}
export function validateResponse(value:Record<string,any>,expected:{requests:Request[]}):Response {
  if(!Array.isArray(value.results)||value.results.length!==expected.requests.length)throw new Error('agentjev_invalid_response');
  for(let index=0;index<expected.requests.length;index++){
    const request=expected.requests[index],result=value.results[index];
    if(!object(result)||result.id!==request.id||!Array.isArray(result.answers)||result.answers.length!==request.questions.length)
      throw new Error('agentjev_invalid_response');
    for(let qi=0;qi<request.questions.length;qi++){
      const question=request.questions[qi],answer=result.answers[qi];
      if(!object(answer)||answer.id!==question.id||answer.type!==question.type||!object(answer.distribution))
        throw new Error('agentjev_invalid_response');
      const keys=question.type==='choice'?Object.keys(question.options):question.type==='score'?
        question.levels.map((_,index)=>String(index)):['true','false'];
      const distribution=answer.distribution;
      if(Object.keys(distribution).length!==keys.length||keys.some(key=>!Number.isFinite(distribution[key])||
        distribution[key]<0||distribution[key]>1)||Math.abs(keys.reduce((sum,key)=>sum+distribution[key],0)-1)>1e-4)
        throw new Error('agentjev_invalid_response');
      const top=Math.max(...keys.map(key=>distribution[key]));
      if(question.type==='choice'){
        if(typeof answer.value!=='string'||!Object.hasOwn(question.options,answer.value)||
          !Number.isFinite(answer.top_probability)||Math.abs(answer.top_probability-top)>1e-4||
          !Number.isFinite(answer.margin)||answer.margin<0||answer.margin>1||
          Math.abs(distribution[answer.value]-top)>1e-4)throw new Error('agentjev_invalid_response');
      } else if(question.type==='score'){
        const score=keys.reduce((sum,key)=>sum+Number(key)*distribution[key],0);
        if(!Number.isFinite(answer.score)||answer.score<0||answer.score>keys.length-1||
          Math.abs(answer.score-score)>1e-4||!Number.isSafeInteger(answer.level)||
          answer.level<0||answer.level>=keys.length||Math.abs(distribution[String(answer.level)]-top)>1e-4)
          throw new Error('agentjev_invalid_response');
      } else if(typeof answer.value!=='boolean'||!Number.isFinite(answer.probability)||
        Math.abs(answer.probability-distribution.true)>1e-4||answer.value!==(answer.probability>=.5))
        throw new Error('agentjev_invalid_response');
    }
  }
  return value as Response;
}
