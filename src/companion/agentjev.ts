import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,openSync,readSync,closeSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hasOpposingDistanceAndCare,type RelationshipAssessmentTask,type RelationshipMetric} from './relationship-assessment.ts';
import {CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA,decodeRelationshipEvidence,projectRelationshipEvidence,relationshipEvidenceTask} from './relationship-evidence.ts';
import type {RelationshipEvidenceExtraction} from './relationship-evidence.ts';
import type {ContactContext} from './contact-context.ts';
import type {ContactJudgment} from '../scene/companion-flow.ts';
import {type LearningTrace,type PersonalTaskType,type PersonalWeightsStore} from './personal-weights.ts';

const DEFAULT_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Dimension-specific anchors; missing opportunities are unknown, never a zero.
export const METRIC_LEVELS:Record<RelationshipMetric,readonly string[]>={
  agentToUserIntimacy:['Agent 明确要求疏远','Agent 只表达有限礼貌','Agent 表达个人化友善','Agent 明确表达关心与亲近','Agent 持续表达双方已接纳的深度亲近'],
  userToAgentIntimacy:['用户明确要求疏远','用户明确只接受有限交往','用户表达个人化友善','用户明确表达关心与亲近','用户持续表达双方已接纳的深度亲近'],
  informationReliability:['用户明确认为信息不可信','用户表示怀疑且只把信息作为线索','用户认可特定领域的信息但要求核对','用户明确认可多次已核实的回答','用户持续把已验证信息作为重要参考'],
  emotionalDisclosure:['用户明确不愿向 Agent 披露感受','用户明确只愿浅谈感受','用户分享具体个人感受','用户主动分享脆弱感受并寻求理解','用户多次主动分享重要内心体验并明确表示信任'],
  taskDelegation:['用户明确不愿委托任务','用户只允许逐步监督下的小任务','用户允许限定范围的任务','用户反复授权具体重要任务','用户明确授权较大任务并认可已完成结果'],
  userDependency:['用户明确表示不依赖 Agent 并能独立应对','用户明确表示有帮助但可自行处理','用户报告遇事惯常寻求 Agent 支持','用户报告缺少 Agent 时明显难以应对','用户明确报告依赖 Agent 已影响独立生活或其它关系'],
};
export function relationshipSupportQuestion(metric:RelationshipMetric,level:number,id=String(level)){
  if(!Number.isInteger(level)||level<0||level>=METRIC_LEVELS[metric].length)
    throw new Error('invalid_relationship_level');
  return {id,type:'boolean' as const,
    question:`来源原文是否直接且充分支持该关系档位：${METRIC_LEVELS[metric][level]}？只以原文事实判断。`,
    criteria:{true:'该档位所要求的限定条件都由原文直接支持',false:'原文没有充分支持该档位全部限定条件'}};
}
type Question={id:string;type:'choice';question:string;options:Record<string,string>}|
  {id:string;type:'score';question:string;levels:string[]}|
  {id:string;type:'boolean';question:string;criteria?:{true:string;false:string}};
interface Request {id:string;state:string;questions:Question[]}
interface Answer {id:string;type:'choice'|'score'|'boolean';value?:string|boolean;score?:number;level?:number;
  probability?:number;distribution:Record<string,number>;top_probability?:number;margin?:number}
interface Response {id:string;results:Array<{id:string;answers:Answer[]}>;usage?:unknown;calibration?:string;
  learning?:Array<{features:number[][];baseLogits:number[]}>}
export interface AgentJevOptions {
  root?:string;executable?:string;modelDir?:string;runner?:string;
  startupTimeoutMs?:number;inferenceTimeoutMs?:number;threads?:number;
  extractEvidence?:(task:ReturnType<typeof relationshipEvidenceTask>)=>Promise<unknown>;
  personalWeights?:PersonalWeightsStore;
}
interface Pending {resolve:(value:Response)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>;payload:{requests:Request[]}}

function locations(options:AgentJevOptions={}){
  const root=path.resolve(options.root??DEFAULT_ROOT);
  return {root,executable:path.resolve(options.executable??path.join(root,'.local/agentjev/runtime/python.exe')),
    modelDir:path.resolve(options.modelDir??path.join(root,'.local/agentjev/model')),
    runner:path.resolve(options.runner??path.join(root,'third-party/agentjev/runner.py'))};
}

export function available(options:AgentJevOptions={}):boolean {
  const files=locations(options);
  return existsSync(files.executable)&&existsSync(path.join(files.modelDir,'model.safetensors'))&&existsSync(files.runner);
}

/** Local, single-worker CPU client. Failure is explicit; there is no remote or host-model fallback. */
export class AgentJevClient {
  private readonly files:ReturnType<typeof locations>;
  private readonly startupTimeoutMs:number;
  private readonly inferenceTimeoutMs:number;
  private readonly threads:number;
  private readonly extractEvidence?:AgentJevOptions['extractEvidence'];
  private readonly personalWeights?:PersonalWeightsStore;
  private readonly identityValue:string;
  private process:ChildProcessWithoutNullStreams|null=null;
  private opening:Promise<void>|null=null;
  private ready=false;
  private closed=false;
  private buffer='';
  private pending=new Map<string,Pending>();
  private startupResolve:(()=>void)|null=null;
  private startupReject:((error:Error)=>void)|null=null;
  private startupTimer:ReturnType<typeof setTimeout>|null=null;

  constructor(options:AgentJevOptions={}){
    this.files=locations(options);
    this.startupTimeoutMs=timeout(options.startupTimeoutMs,120_000);
    this.inferenceTimeoutMs=timeout(options.inferenceTimeoutMs,180_000);
    this.threads=options.threads??4;
    this.extractEvidence=options.extractEvidence;
    this.personalWeights=options.personalWeights;
    this.identityValue=this.computeIdentity();
    if(!Number.isSafeInteger(this.threads)||this.threads<1||this.threads>8)throw new Error('invalid_agentjev_threads');
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
    if(existsSync(model)){
      const descriptor=openSync(model,'r'),digest=createHash('sha256'),buffer=Buffer.allocUnsafe(2*1024*1024);
      try{let count:number;while((count=readSync(descriptor,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,count));}
      finally{closeSync(descriptor);}
      parts.push(`model:${digest.digest('hex')}`);
    }else parts.push('model:missing');
    return `agentjev-v2:${createHash('sha256').update(parts.join('|')).digest('hex')}`;
  }

  async evaluate(payload:unknown):Promise<Response> {
    return this.evaluateRaw(payload,false);
  }

  /** Capture the frozen decision input and the exact pre-fc2 candidate features. */
  async evaluateWithTrace(payload:unknown,learning:{scopeKey:string;taskType:PersonalTaskType}):Promise<{
    response:Response;learningTraces:LearningTrace[];
  }> {
    const expected=validatePayload(payload);
    const response=await this.evaluateRaw(expected,true);
    if(!response.learning||response.learning.length!==expected.requests.reduce((n,item)=>n+item.questions.length,0))
      throw new Error('agentjev_missing_learning_features');
    const learningTraces:LearningTrace[]=[];
    let index=0;
    for(const request of expected.requests)for(const question of request.questions){
      const raw=response.learning[index++];
      const options=question.type==='choice'?question.options:question.type==='score'?
        Object.fromEntries(question.levels.map((level,i)=>[String(i),level])):
        {true:question.criteria?.true??'TRUE',false:question.criteria?.false??'FALSE'};
      const trace:LearningTrace={scopeKey:learning.scopeKey,taskType:learning.taskType,
        modelIdentity:this.identityValue,parameterVersion:this.personalWeights?.version(learning.scopeKey,
          learning.taskType,this.identityValue)??0,requestId:request.id,questionId:question.id,
        state:request.state,question:question.question,options,keys:Object.keys(options),
        features:raw.features,baseLogits:raw.baseLogits};
      if(trace.features.length!==trace.keys.length||trace.baseLogits.length!==trace.keys.length||
        trace.features.some(row=>row.length!==256||row.some(value=>!Number.isFinite(value)))||
        trace.baseLogits.some(value=>!Number.isFinite(value)))throw new Error('agentjev_invalid_learning_features');
      learningTraces.push(trace);
    }
    if(this.personalWeights){
      let offset=0;
      for(const result of response.results)for(let qi=0;qi<result.answers.length;qi++){
        const trace=learningTraces[offset++],logits=this.personalWeights.adjustedLogits(trace);
        if(!logits)continue;
        const probabilities=softmax(logits);
        result.answers[qi]=answerForTrace(result.answers[qi].type,trace,probabilities);
      }
      validateResponse(response,expected);
    }
    delete response.learning;
    return {response,learningTraces};
  }

  private async evaluateRaw(payload:unknown,captureFeatures:boolean):Promise<Response> {
    const expected=validatePayload(payload);
    await this.open();
    if(!this.process||!this.ready||this.closed)throw new Error('agentjev_unavailable');
    const id=randomUUID();
    return new Promise<Response>((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail(new Error('agentjev_inference_timeout')),this.inferenceTimeoutMs);
      this.pending.set(id,{resolve,reject,timer,payload:expected});
      this.process!.stdin.write(JSON.stringify({id,payload:expected,...(captureFeatures?{captureFeatures:true}:{})})+'\n',error=>{
        if(error)this.fail(new Error('agentjev_pipe_failed'));
      });
    });
  }

  async assess(task:RelationshipAssessmentTask,extracted?:unknown,personalScopeKey?:string):Promise<{
    schema:'xldb-relationship-assessment-v2';extraction:RelationshipEvidenceExtraction;
    selections:Partial<Record<RelationshipMetric,number>>;rawDiagnostics?:unknown;learningTraces?:LearningTrace[];
  }> {
    if(task.schema!=='xldb-relationship-assessment-v2'||!Array.isArray(task.sources))throw new Error('invalid_agentjev_assessment_task');
    if(!extracted&&!this.extractEvidence)throw new Error('relationship_evidence_extractor_required');
    const extraction=decodeRelationshipEvidence(extracted??await this.extractEvidence!(relationshipEvidenceTask(task)),task);
    if((extraction.receipt||extracted===undefined)&&extraction.schema!==CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA)
      throw new Error('relationship_evidence_current_contract_required');
    const projection=projectRelationshipEvidence(extraction,task);
    const contextExclusions:Record<string,{profileRefs:string[];commitmentRefs:string[]}>={};
    const requests:Request[]=Object.entries(projection.ambiguous)
      .filter(([,ambiguity])=>!hasOpposingDistanceAndCare(ambiguity!.items)).map(([metric,ambiguity])=>{
      const compact=relationshipAmbiguityState(task,metric,ambiguity!.items);
      contextExclusions[metric]=compact.excluded;
      return {id:metric,state:compact.state,questions:ambiguity!.levels.map(level=>
        relationshipSupportQuestion(metric as RelationshipMetric,level))};
    });
    const selections:Partial<Record<RelationshipMetric,number>>={};
    let rawDiagnostics:unknown,learningTraces:LearningTrace[]|undefined;
    if(requests.length){
      const outcome=personalScopeKey?await this.evaluateWithTrace({requests},{scopeKey:personalScopeKey,taskType:'relationship'}):null;
      const reply=outcome?.response??await this.evaluate({requests});
      learningTraces=outcome?.learningTraces;rawDiagnostics={...reply,contextExclusions};
      for(const result of reply.results){
        const ranked=result.answers.map(answer=>({level:Number(answer.id),support:answer.probability??0}))
          .sort((left,right)=>right.support-left.support);
        if(ranked[0]?.support>=.5)selections[result.id as RelationshipMetric]=ranked[0].level;
      }
    }
    return {schema:'xldb-relationship-assessment-v2',extraction,selections,rawDiagnostics,learningTraces};
  }

  async decideContact(input:{context:ContactContext;opportunity:{purpose:string;topic:string;basis?:unknown};candidateBody?:string},
    personalScopeKey?:string):Promise<ContactJudgment & {learningTraces?:LearningTrace[]}> {
    if(!input||typeof input!=='object'||!input.context||!input.opportunity)throw new Error('invalid_agentjev_contact_input');
    const purpose=boundedText(input.opportunity.purpose,180),topic=boundedText(input.opportunity.topic,300);
    if(!purpose||!topic)throw new Error('invalid_agentjev_contact_input');
    const candidateBody=input.candidateBody;
    if(candidateBody!==undefined&&(typeof candidateBody!=='string'||!candidateBody.trim()||candidateBody.length>300))
      throw new Error('invalid_agentjev_contact_input');
    if(input.context.sleepBoundary)return {experience:'negative',emotion:'uncertain',choice:'skip',rawChoice:'skip',
      ...(personalScopeKey?{learningTraces:[]}:{})};
    const request:Request={id:'contact',state:JSON.stringify({context:input.context,opportunity:{purpose,topic,
      basis:input.opportunity.basis??null},candidateBody}),questions:[
      {id:'clearHelp',type:'choice',question:'所给最新用户互动是否明确支持现在发送这条具体消息会受欢迎或及时帮上忙？',
        options:{yes:'有当前明确的欢迎或及时帮助依据',no:'没有当前明确的欢迎或及时帮助依据'}},
      {id:'clearHarm',type:'choice',question:'所给最新用户互动是否明确表明这条消息现在会打扰、重复已答问题、违背拒绝或不合当前处境？',
        options:{yes:'有当前明确的不适合发送依据',no:'没有当前明确的不适合发送依据'}},
      {id:'emotion',type:'choice',question:'依角色设定和当前OpenHer情绪，主动联系是否符合人物此时的情绪与立场？',
        options:{aligned:'明确符合',uncertain:'无法确认',conflicting:'明显不符'}},
      {id:'contactChoice',type:'choice',question:'硬性联系机会已许可。只有用户体验positive且人物情绪aligned才可send；否则wait或skip。不得因依赖提高频率。',
        options:{send:'现在发送',wait:'保留机会等待',skip:'放弃本次机会'}},
    ]};
    if(request.state.length>3000)throw new Error('contact_context_too_large');
    const outcome=personalScopeKey?await this.evaluateWithTrace({requests:[request]},
      {scopeKey:personalScopeKey,taskType:'contact'}):null;
    const response=outcome?.response??await this.evaluate({requests:[request]});
    const answers=response.results[0]?.answers;
    const clearHelp=answers?.[0]?.value,clearHarm=answers?.[1]?.value;
    const experience=clearHarm==='yes'?'negative':clearHelp==='yes'?'positive':'uncertain';
    const emotion=answers?.[2]?.value,choice=answers?.[3]?.value;
    if((clearHelp!=='yes'&&clearHelp!=='no')||(clearHarm!=='yes'&&clearHarm!=='no')||
      (emotion!=='aligned'&&emotion!=='uncertain'&&emotion!=='conflicting')||
      (choice!=='send'&&choice!=='wait'&&choice!=='skip'))throw new Error('agentjev_invalid_response');
    // A negative experience or conflicting emotion rules out this opportunity even when
    // the model's third answer says "wait"; that answer must not contradict its evidence judgments.
    const resolved=experience==='negative'||emotion==='conflicting'?'skip':
      choice==='send'&&(experience!=='positive'||emotion!=='aligned')?'wait':choice;
    return {experience,emotion,choice:resolved,rawChoice:choice,
      ...(outcome?{learningTraces:outcome.learningTraces}:{})};
  }

  async decideQuietException(input:{context:ContactContext;quiet:{content:string;windowKey:string}[];candidateBody:string}):Promise<'positive'|'uncertain'|'negative'>;
  async decideQuietException(input:{context:ContactContext;quiet:{content:string;windowKey:string}[];candidateBody:string},
    personalScopeKey:string):Promise<{verdict:'positive'|'uncertain'|'negative';learningTraces:LearningTrace[]}>;
  async decideQuietException(input:{context:ContactContext;quiet:{content:string;windowKey:string}[];candidateBody:string},
    personalScopeKey?:string):Promise<'positive'|'uncertain'|'negative'|{verdict:'positive'|'uncertain'|'negative';learningTraces:LearningTrace[]}> {
    if(!input||!input.context||!Array.isArray(input.quiet)||!input.quiet.length||
      typeof input.candidateBody!=='string'||!input.candidateBody.trim()||input.candidateBody.length>300)
      throw new Error('invalid_agentjev_contact_input');
    if(input.context.sleepBoundary)return personalScopeKey?{verdict:'negative',learningTraces:[]}:'negative';
    const state=JSON.stringify(input);
    if(state.length>3000)throw new Error('contact_context_too_large');
    const request:Request={id:'quiet-exception',state,questions:[{id:'longingExperience',type:'choice',
      question:'当前是用户约定的勿扰时段。按context.clock的此刻当地时间及用户当前说明，简短诉说思念且不要求回复能否明确让用户现在开心？用户明确说要睡觉或道晚安且目前仍适用时，通知可能吵醒，应判 negative；仅凭作息、时间或未回复不可断定已睡，无其它明确依据可判 uncertain。不得借提醒或依赖提高频率。',
      options:{positive:'有明确证据此刻会让用户开心',uncertain:'证据不足或利弊不明',negative:'可能打扰、施压或让用户不快'}}]};
    const outcome=personalScopeKey?await this.evaluateWithTrace({requests:[request]},
      {scopeKey:personalScopeKey,taskType:'contact'}):null;
    const answer=(outcome?.response??await this.evaluate({requests:[request]})).results[0]?.answers[0]?.value;
    if(answer!=='positive'&&answer!=='uncertain'&&answer!=='negative')throw new Error('agentjev_invalid_response');
    return outcome?{verdict:answer,learningTraces:outcome.learningTraces}:answer;
  }

  close():void {
    if(this.closed)return;
    this.closed=true;this.fail(new Error('agentjev_closed'));
  }

  private open():Promise<void> {
    if(this.closed)return Promise.reject(new Error('agentjev_closed'));
    if(this.ready)return Promise.resolve();
    if(this.opening)return this.opening;
    if(!available({root:this.files.root,executable:this.files.executable,modelDir:this.files.modelDir,runner:this.files.runner}))
      return Promise.reject(new Error('agentjev_unavailable'));
    for(const part of ['cache/hf','tmp'])mkdirSync(path.join(this.files.root,'.local/agentjev',part),{recursive:true});
    const privateRoot=path.join(this.files.root,'.local/agentjev');
    const environment={...process.env,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HOME:path.join(privateRoot,'cache/hf'),
      HUGGINGFACE_HUB_CACHE:path.join(privateRoot,'cache/hf/hub'),TRANSFORMERS_CACHE:path.join(privateRoot,'cache/hf/transformers'),
      TEMP:path.join(privateRoot,'tmp'),TMP:path.join(privateRoot,'tmp'),TMPDIR:path.join(privateRoot,'tmp'),
      PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1',TOKENIZERS_PARALLELISM:'false'};
    this.opening=new Promise<void>((resolve,reject)=>{
      this.startupResolve=resolve;this.startupReject=reject;
      this.startupTimer=setTimeout(()=>this.fail(new Error('agentjev_startup_timeout')),this.startupTimeoutMs);
      const worker=spawn(this.files.executable,[this.files.runner,'--model',this.files.modelDir,'--threads',String(this.threads)],
        {cwd:this.files.root,windowsHide:true,stdio:['pipe','pipe','pipe'],env:environment});
      this.process=worker;
      worker.stdout.setEncoding('utf8');
      worker.stdout.on('data',(chunk:string)=>this.receive(chunk));
      worker.stderr.on('data',()=>{}); // Do not expose Python errors or source text.
      worker.on('error',()=>this.fail(new Error('agentjev_process_failed')));
      worker.on('exit',()=>this.fail(new Error('agentjev_process_exited')));
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
      try{request.resolve(validateResponse(value,request.payload));}
      catch{this.fail(new Error('agentjev_invalid_response'));request.reject(new Error('agentjev_invalid_response'));return;}
    }
  }

  private fail(error:Error):void {
    if(this.startupTimer)clearTimeout(this.startupTimer);this.startupTimer=null;
    this.startupReject?.(error);this.startupReject=null;this.startupResolve=null;
    for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();
    this.ready=false;this.closed=true;
    this.process?.kill();this.process=null;
  }
}

function timeout(value:number|undefined,defaultMs:number):number{
  const result=value??defaultMs;if(!Number.isSafeInteger(result)||result<1||result>600_000)throw new Error('invalid_agentjev_timeout');return result;
}
function relationshipAmbiguityState(task:RelationshipAssessmentTask,metric:string,
  items:readonly {eventKind:string;domain:string;ref:{sourceId:string;revision:number;quote:string}}[]):
  {state:string;excluded:{profileRefs:string[];commitmentRefs:string[]}} {
  const evidence=items.map(item=>({kind:item.eventKind,domain:item.domain,ref:`${item.ref.sourceId}@${item.ref.revision}`,
    quote:item.ref.quote}));
  const auxiliary=task.auxiliaryContext;
  const excluded={profileRefs:[...(auxiliary?.excluded.profileRefs??[])],
    commitmentRefs:[...(auxiliary?.excluded.commitmentRefs??[])]};
  const omitted={profile:auxiliary?.excluded.profileCount??excluded.profileRefs.length,
    commitments:auxiliary?.excluded.commitmentCount??excluded.commitmentRefs.length};
  if(!auxiliary){
    const state=JSON.stringify({mode:'relationship-ambiguity',metric,evidence});
    if(state.length>1800)throw new Error('agentjev_assessment_context_too_large');
    return {state,excluded};
  }
  const context={clock:auxiliary.clock,waiting:auxiliary.waiting,emotion:auxiliary.emotion,
    contactWindowState:auxiliary.contactWindowState,commitments:[] as typeof auxiliary.commitments,
    profileFacts:[] as typeof auxiliary.profileFacts,excludedCounts:{profile:0,commitments:0}};
  const shape={mode:'relationship-ambiguity',metric,evidence,context};
  const serialize=()=>JSON.stringify(shape);
  if(serialize().length>1800)throw new Error('agentjev_assessment_context_too_large');
  for(const record of auxiliary.commitments){
    context.commitments.push(record);
    if(serialize().length>1800){context.commitments.pop();excluded.commitmentRefs.push(record.ref);omitted.commitments++;}
  }
  for(const entry of auxiliary.profileFacts){
    context.profileFacts.push(entry);
    if(serialize().length>1800){context.profileFacts.pop();excluded.profileRefs.push(entry.ref);omitted.profile++;}
  }
  context.excludedCounts=omitted;
  const state=serialize();
  if(state.length>1800)throw new Error('agentjev_assessment_context_too_large');
  return {state,excluded};
}
function boundedText(value:unknown,max:number):string{
  if(typeof value!=='string')throw new Error('invalid_agentjev_text');return value.trim().slice(0,max);
}
function object(value:unknown):value is Record<string,any>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function validatePayload(payload:unknown):{requests:Request[]}{
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
function validateResponse(value:Record<string,any>,expected:{requests:Request[]}):Response {
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

function softmax(logits:number[]):number[] {
  const top=Math.max(...logits),exp=logits.map(value=>Math.exp(value-top));
  const sum=exp.reduce((total,value)=>total+value,0);
  return exp.map(value=>value/sum);
}
function answerForTrace(type:Answer['type'],trace:LearningTrace,probabilities:number[]):Answer {
  const distribution=Object.fromEntries(trace.keys.map((key,index)=>[key,probabilities[index]]));
  const top=Math.max(...probabilities),index=probabilities.indexOf(top);
  if(type==='boolean')return {id:trace.questionId,type,value:probabilities[0]>=0.5,
    probability:probabilities[0],distribution};
  if(type==='score')return {id:trace.questionId,type,score:probabilities.reduce((sum,p,i)=>sum+i*p,0),
    level:index,distribution};
  const ranked=[...probabilities].sort((a,b)=>b-a);
  return {id:trace.questionId,type,value:trace.keys[index],distribution,
    top_probability:top,margin:ranked[0]-ranked[1]};
}
