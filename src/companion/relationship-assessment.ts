import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {SceneScope} from '../scene/types.ts';
import {decodeRelationshipEvidence,projectRelationshipEvidence,RELATIONSHIP_EVALUATION_VERSION,
  RELATIONSHIP_EVIDENCE_PROMPT_HASH} from './relationship-evidence.ts';
import type {RelationshipEvidenceExtraction} from './relationship-evidence.ts';
import {relationshipContextFingerprint,type RelationshipAuxiliaryContext} from './relationship-context.ts';

export const RELATIONSHIP_METRICS = [
  'agentToUserIntimacy','userToAgentIntimacy','informationReliability',
  'emotionalDisclosure','taskDelegation','userDependency',
] as const;
export type RelationshipMetric = typeof RELATIONSHIP_METRICS[number];
export type RelationshipContactChoice = 'initiate'|'send'|'wait'|'skip';
export type RelationshipConfidence = 'low'|'medium'|'high';
export interface RelationshipSource {
  id:string;revision:number;text:string;role:'user'|'assistant';acceptedAtMs:number;
}
export interface RelationshipAssessmentInput {
  scope:SceneScope;subjectId:string;characterId:string;sourceVersion:number;controlsRevision:number;
  /** Already accepted, authorized conversation sources for this one companion and real user. */
  sources:readonly RelationshipSource[];
  /** Bounded, authorized OpenHer state description; it is context, not user evidence. */
  openHerSummary?:string;
  /** Current, scope-filtered context for interpretation only. Scores still require a literal source ref. */
  auxiliaryContext?:RelationshipAuxiliaryContext;
  personalParameterVersion?:number;
}
export interface RelationshipEvidence {sourceId:string;revision:number;quote:string}
export interface RelationshipMetricValue {
  score:number|null;confidence:RelationshipConfidence;rationale:string;evidence:RelationshipEvidence[];
  corrected?:boolean;origin?:'evidence_rule'|'agentjev_constrained'|'user_correction';
  domains?:Array<{domain:string;status?:'current'|'historical'|'conflicted';score?:number|null;
    levels:number[];evidence:RelationshipEvidence[];qualifiers?:string[]}>;
}
export type RelationshipMetrics = Record<RelationshipMetric,RelationshipMetricValue>;
/** A present distance boundary and present care can coexist; one score would erase either fact. */
export function hasOpposingDistanceAndCare(items:readonly {eventKind:string}[]):boolean {
  return items.some(item=>item.eventKind==='distance_boundary')&&
    items.some(item=>item.eventKind==='explicit_care'||item.eventKind==='mutual_closeness');
}
export interface RelationshipAssessment {
  schema:'xldb-relationship-assessment-v2';scope:SceneScope;subjectId:string;characterId:string;
  sourceVersion:number;controlsRevision:number;sourceFingerprint:string;revision:number;
  metrics:RelationshipMetrics;contactChoice:RelationshipContactChoice;contactReason:string;
  corrected:boolean;contactCorrected:boolean;modelCurrent:boolean;
}
export interface RelationshipAssessmentTask extends RelationshipAssessmentInput {
  schema:'xldb-relationship-assessment-v2';sourceFingerprint:string;revision:number;
  prompt:string;
}
export interface RelationshipCorrection {
  metrics?:Partial<Record<RelationshipMetric,{score:number|null;note:string}>>;
  contactChoice?:RelationshipContactChoice;
  note?:string;
}
interface AssessmentRow {fingerprint:string;revision:number;model:string|null;correction:string|null}

const SCHEMA='xldb-relationship-assessment-v2';
const DECISION_VERSION='relationship-boolean-support-v2';
type NormalizedInput=RelationshipAssessmentInput&{sourceFingerprint:string};

/** One projection per real-user / companion / scene scope. The scene remains the source authority. */
export class RelationshipAssessmentStore {
  private readonly db:DatabaseSync;
  private providerIdentity='unspecified';
  constructor(db:DatabaseSync){
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS companion_relationship_assessments (
      scope TEXT NOT NULL, subject TEXT NOT NULL, character TEXT NOT NULL,
      fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
      model TEXT, correction TEXT,
      PRIMARY KEY(scope,subject,character)
    )`);
  }
  setProviderIdentity(identity:string):void {
    if(!identity||identity.length>500)throw new Error('invalid_relationship_provider_identity');
    this.providerIdentity=identity;
  }

  task(input:RelationshipAssessmentInput):RelationshipAssessmentTask|null {
    const current=normalize(input,this.providerIdentity),row=this.row(current);
    if(row?.fingerprint===current.sourceFingerprint&&row.model)return null;
    return {...current,schema:SCHEMA,revision:row?.revision??0,
      prompt:assessmentPrompt(current)};
  }

  save(task:RelationshipAssessmentTask,output:unknown,currentInput:RelationshipAssessmentInput):RelationshipAssessment {
    const current=normalize(currentInput,this.providerIdentity);
    if(task.schema!==SCHEMA||task.subjectId!==current.subjectId||task.characterId!==current.characterId||
      scopeKey(task.scope)!==scopeKey(current.scope)||task.sourceFingerprint!==current.sourceFingerprint||
      task.sourceVersion!==current.sourceVersion||task.controlsRevision!==current.controlsRevision)
      throw new Error('context_changed_retry');
    const model={...decodeModel(output,current),evidenceFingerprint:evidenceFingerprint(current,this.providerIdentity)};
    const row=this.row(current);
    if(row?.fingerprint===current.sourceFingerprint&&row.model)return this.view(current,row)!;
    if((row?.revision??0)!==task.revision)throw new Error('context_changed_retry');
    const nextRevision=(row?.revision??0)+1;
    this.db.prepare(`INSERT INTO companion_relationship_assessments
      (scope,subject,character,fingerprint,revision,model,correction) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(scope,subject,character) DO UPDATE SET fingerprint=excluded.fingerprint,
      revision=excluded.revision,model=excluded.model`).run(scopeKey(current.scope),current.subjectId,current.characterId,
        current.sourceFingerprint,nextRevision,JSON.stringify(model),row?.correction??null);
    return this.view(current,this.row(current)!)!;
  }

  read(input:RelationshipAssessmentInput):RelationshipAssessment|null {
    const current=normalize(input,this.providerIdentity);return this.view(current,this.row(current));
  }

  /** Reuse grounded extraction when only the decision clock/emotion has moved. */
  reusableEvidence(input:RelationshipAssessmentInput):RelationshipEvidenceExtraction|null {
    const current=normalize(input,this.providerIdentity),row=this.row(current);
    if(!row?.model)return null;
    const saved=JSON.parse(row.model);
    if(saved.evidenceFingerprint!==evidenceFingerprint(current,this.providerIdentity))return null;
    return decodeRelationshipEvidence(saved.extraction,current);
  }
  diagnostics(input:RelationshipAssessmentInput):{evaluationVersion:string;sourceFingerprint:string;extraction:RelationshipEvidenceExtraction;
    rawDiagnostics:unknown}|null {
    const current=normalize(input,this.providerIdentity),row=this.row(current);
    if(!row?.model||row.fingerprint!==current.sourceFingerprint)return null;
    const model=JSON.parse(row.model) as ReturnType<typeof decodeModel>;
    return {evaluationVersion:`${RELATIONSHIP_EVALUATION_VERSION}+${DECISION_VERSION}`,sourceFingerprint:current.sourceFingerprint,
      extraction:model.extraction,rawDiagnostics:model.rawDiagnostics??null};
  }

  /** Remove obsolete model evidence while preserving explicit user corrections. */
  clearStale(input:RelationshipAssessmentInput):void {
    const current=normalize(input,this.providerIdentity),row=this.row(current);
    if(row?.model&&row.fingerprint!==current.sourceFingerprint)
      this.db.prepare('UPDATE companion_relationship_assessments SET model=NULL,revision=revision+1 WHERE scope=? AND subject=? AND character=?')
        .run(scopeKey(current.scope),current.subjectId,current.characterId);
  }

  clearModels(scope:SceneScope):void {
    this.db.prepare('UPDATE companion_relationship_assessments SET model=NULL,revision=revision+1 WHERE scope=? AND model IS NOT NULL')
      .run(scopeKey(scope));
  }

  correct(input:RelationshipAssessmentInput,correction:RelationshipCorrection,expectedRevision:number):RelationshipAssessment {
    const current=normalize(input,this.providerIdentity),row=this.row(current);
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||(row?.revision??0)!==expectedRevision)
      throw new Error('context_changed_retry');
    const checked=decodeCorrection(correction);
    const previous=row?.correction?JSON.parse(row.correction) as RelationshipCorrection:{};
    const merged={...previous,...checked,metrics:{...(previous as RelationshipCorrection).metrics,...checked.metrics},
      semanticsVersion:RELATIONSHIP_EVALUATION_VERSION};
    const nextRevision=expectedRevision+1;
    this.db.prepare(`INSERT INTO companion_relationship_assessments
      (scope,subject,character,fingerprint,revision,model,correction) VALUES(?,?,?,?,?,NULL,?)
      ON CONFLICT(scope,subject,character) DO UPDATE SET revision=excluded.revision,
      correction=excluded.correction,fingerprint=''`).run(scopeKey(current.scope),current.subjectId,current.characterId,
        row?.fingerprint??current.sourceFingerprint,nextRevision,JSON.stringify(merged));
    return this.view(current,this.row(current)!)!;
  }

  /** Call on source edit/delete, rollback or a new branch when the old projection must disappear. */
  invalidate(scope:SceneScope,subjectId?:string,characterId?:string):number {
    const clauses=['scope=?'],args:(string)[]=[scopeKey(scope)];
    if(subjectId!==undefined){clauses.push('subject=?');args.push(id(subjectId));}
    if(characterId!==undefined){clauses.push('character=?');args.push(id(characterId));}
    return Number(this.db.prepare(`DELETE FROM companion_relationship_assessments WHERE ${clauses.join(' AND ')}`).run(...args).changes);
  }

  private row(input:NormalizedInput):AssessmentRow|undefined {
    return this.db.prepare(`SELECT fingerprint,revision,model,correction FROM companion_relationship_assessments
      WHERE scope=? AND subject=? AND character=?`).get(scopeKey(input.scope),input.subjectId,input.characterId) as AssessmentRow|undefined;
  }

  private view(input:NormalizedInput,row:AssessmentRow|undefined):RelationshipAssessment|null {
    if(!row)return null;
    const modelCurrent=row.fingerprint===input.sourceFingerprint&&!!row.model;
    const correction=row.correction?JSON.parse(row.correction) as RelationshipCorrection:null;
    if(!modelCurrent&&!correction)return null;
    const model=modelCurrent?JSON.parse(row.model!) as ReturnType<typeof decodeModel>:null;
    const metrics=unknownMetrics();
    for(const key of RELATIONSHIP_METRICS){
      if(model)metrics[key]=model.metrics[key];
      const override=correction?.metrics?.[key];
      if(override)metrics[key]={score:override.score,confidence:'high',rationale:override.note,evidence:[],corrected:true,origin:'user_correction'};
    }
    return {schema:SCHEMA,scope:input.scope,subjectId:input.subjectId,characterId:input.characterId,
      sourceVersion:input.sourceVersion,controlsRevision:input.controlsRevision,sourceFingerprint:input.sourceFingerprint,
      revision:row.revision,metrics,contactChoice:correction?.contactChoice??model?.contactChoice??'wait',
      contactReason:correction?.note??model?.contactReason??'当前来源不足，等待更多互动。',
      corrected:!!correction,contactCorrected:correction?.contactChoice!==undefined,modelCurrent};
  }
}

/** Expression preferences, not score-derived permissions or prohibited phrases. */
export function relationshipExpression(value:RelationshipAssessment|null,purpose:'reply'|'proactive') {
  if(!value)return [];
  const guidance:Record<RelationshipMetric,readonly string[]>={
    agentToUserIntimacy:['角色此时倾向保留距离，表达可克制而清楚','角色目前表达较含蓄，可用礼貌和轻关心','可流露个人化的友善和关注','可自然表达关心、想念和情绪','可结合共同经历表达熟悉与持续亲近'],
    userToAgentIntimacy:['用户有疏远信号，可先回应当下需要并留空间','用户接受的亲近较有限，可从轻松自然的交流开始','用户表达友善，可适度呼应亲昵与玩笑','用户表达关心，可更温暖地回应并分享角色感受','用户表达持续亲近，可沿用双方喜欢的称呼与默契'],
    informationReliability:['在这个信息领域可多解释依据并邀请核对','在这个信息领域可主动说明不确定处','在这个信息领域可给简明结论并保留核对路径','在这个信息领域可接续已建立的理解，减少重复铺垫','在这个信息领域可熟悉直接地交流，重要新事实仍说明依据'],
    emotionalDisclosure:['用户当前不愿多谈感受，可给空间并回应其选的话题','可先轻声回应感受，追问尺度随用户反应调整','可针对具体感受回应，适度问一个贴近当下的问题','可多倾听和共情，顺着用户主动分享的深度回应','可结合共同经历细致回应，避免机械重复安慰'],
    taskDelegation:['在这个任务领域可先提供选择，让用户决定如何做','在这个任务领域可把步骤讲清并配合逐步确认','在这个任务领域可围绕已授权范围直接协助','在这个任务领域可减少重复介绍，按已约定方式协作','在这个任务领域可用熟悉的协作语气汇报进展'],
    userDependency:['用户表现出独立应对倾向，可提供可选帮助并肯定其决定','陪伴是用户可选的支持，可自然回应而不假定需要介入','用户习惯来寻求支持，可先接住其诉求并共同梳理','用户缺少支持时较难应对，可更稳定耐心地陪其理清下一步','用户报告应对受到依赖影响，可更细致回应具体困难，并结合其意愿支持生活中的行动'],
  };
  return RELATIONSHIP_METRICS.flatMap(metric=>{
    if(purpose==='proactive'&&metric==='userDependency')return [];
    const item=value.metrics[metric];
    // User corrections are authoritative; stale model values cannot guide speech.
    if(!value.modelCurrent&&!item.corrected)return [];
    const candidates=item.corrected||!item.domains?.length
      ?item.score===null?[]:[{domain:'当前适用范围',score:item.score}]
      :item.domains.flatMap(domain=>{
        if(domain.status!=='current')return [];
        const score=domain.score===undefined?(domain.levels.length===1?domain.levels[0]:null):domain.score;
        return score===null?[]:[{domain:domain.domain,score}];
      });
    return candidates.slice(0,3).map(({domain,score})=>({metric,domain,score,
      suggestion:guidance[metric][score],basis:item.corrected?'用户纠正':'有来源的关系线索'}));
  });
}

export function formatRelationshipGuidance(value:RelationshipAssessment|null,purpose:'reply'|'proactive'):string {
  if(!value)return '';
  const keys=RELATIONSHIP_METRICS.filter(key=>purpose!=='proactive'||key!=='userDependency');
  const known=keys.filter(key=>value.metrics[key].score!==null||value.metrics[key].domains?.length).map(key=>{
    const item=value.metrics[key];
    const domainText=(item.domains??[]).slice(0,3).map(domain=>{
      const quote=domain.evidence[0]?.quote.slice(0,60),qualifier=domain.qualifiers?.filter(Boolean).slice(0,2).join('、');
      const timing=domain.status==='historical'?'（仅历史，不代表当前）':domain.status==='conflicted'?'（当前有冲突，暂不定档）':'';
      return `${domain.domain}${timing}${quote?`「${quote}」`:''}${qualifier?`（${qualifier}）`:''}`;
    }).join('；');
    return `${key}：${item.score===null?'不同证据暂不合并':`${item.score}/4（${item.origin??'evidence_rule'}）`}`+
      `${domainText?`，领域依据 ${domainText}`:''}`;
  });
  const caveat='这些只是有来源的互动线索；明确意愿、边界和联系设置优先。';
  const relationship=known.length?`当前关系参考：${known.join('；')}。`:'关系证据不足。';
  const expression=relationshipExpression(value,purpose);
  const style=expression.length?`话术倾向（不是固定台词、禁词或硬限制；结合人设、当前情绪、用户偏好和语境灵活选择）：${JSON.stringify(expression)}。关系分数不改变明确授权与承诺，不向用户播报评分。`:'';
  const lowBoundary=expression.some(item=>(item.metric==='userToAgentIntimacy'||item.metric==='userDependency')&&item.score<=1)
    ?'负面提示：当前有明确低亲密或低依赖依据，避免向用户索取情感回应、承诺或关注，避免排他与占有式表达。':'';
  if(purpose==='reply')return `${relationship}${caveat}${style}${lowBoundary}按证据限定语自然回应，不把推断当作用户自述。`;
  const choice=value.contactChoice;
  return `${relationship}${style}${lowBoundary}主动联系建议：${choice}；${value.contactReason}。${caveat}拿不准时等待或跳过。`;
}

function assessmentPrompt(input:NormalizedInput):string {
  return `关系证据任务 ${SCHEMA}；先用 relationshipEvidence 宿主阶段提取可验证行为命题。此 prompt 只用于可追溯任务说明；来源指纹 ${input.sourceFingerprint}。`;
}

function decodeModel(raw:unknown,input:NormalizedInput){
  let value:unknown=raw;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new Error('invalid_relationship_assessment');}}
  if(!record(value)||value.schema!==SCHEMA||!record(value.extraction))throw new Error('invalid_relationship_assessment');
  const extraction=decodeRelationshipEvidence(value.extraction,input,{allowLegacy:false}) as RelationshipEvidenceExtraction;
  const projected=projectRelationshipEvidence(extraction,input),metrics=projected.metrics;
  if(value.selections!==undefined){
    if(!record(value.selections))throw new Error('invalid_relationship_selection');
    for(const [key,selected] of Object.entries(value.selections)){
      const ambiguity=projected.ambiguous[key as RelationshipMetric];
      if(!ambiguity||!Number.isInteger(selected)||!ambiguity.levels.includes(selected as number))
        throw new Error('invalid_relationship_selection');
      if(hasOpposingDistanceAndCare(ambiguity.items))throw new Error('invalid_relationship_selection');
      const domain=ambiguity.items[0]?.domain;
      const domains=metrics[key as RelationshipMetric].domains?.map(item=>
        item.domain===domain&&item.status==='current'?{...item,score:selected as number}:item);
      if(!domain||domains?.filter(item=>item.domain===domain&&item.status==='current'&&
        item.score===selected).length!==1)throw new Error('invalid_relationship_selection');
      const evidence=ambiguity.items.slice(0,5).map(item=>({sourceId:item.ref.sourceId,revision:item.ref.revision,quote:item.ref.quote}));
      metrics[key as RelationshipMetric]={...metrics[key as RelationshipMetric],score:selected as number,evidence,domains,
        origin:'agentjev_constrained',rationale:'同一行为片段的多个有依据解释经本地模型约束排序'};
    }
  }
  if(value.rawDiagnostics!==undefined&&JSON.stringify(value.rawDiagnostics).length>50_000)
    throw new Error('invalid_relationship_diagnostics');
  return {metrics,contactChoice:'wait' as const,contactReason:'关系证据本身不授权主动联系',
    extraction,rawDiagnostics:value.rawDiagnostics};
}

function decodeCorrection(input:RelationshipCorrection):RelationshipCorrection {
  if(!record(input))throw new Error('invalid_relationship_correction');
  const metrics:RelationshipCorrection['metrics']={};
  if(input.metrics!==undefined){
    if(!record(input.metrics))throw new Error('invalid_relationship_correction');
    for(const [key,item] of Object.entries(input.metrics)){
      if(!RELATIONSHIP_METRICS.includes(key as RelationshipMetric)||!record(item))throw new Error('invalid_relationship_correction');
      if(item.score!==null&&(!Number.isInteger(item.score)||Number(item.score)<0||Number(item.score)>4))throw new Error('invalid_relationship_correction');
      metrics[key as RelationshipMetric]={score:item.score as number|null,note:bounded(item.note,300,false)};
    }
  }
  const contactChoice=input.contactChoice===undefined?undefined:choice(input.contactChoice);
  const note=input.note===undefined?undefined:bounded(input.note,240,false);
  if(!Object.keys(metrics).length&&contactChoice===undefined&&note===undefined)throw new Error('invalid_relationship_correction');
  return {metrics,contactChoice,note};
}

function normalize(input:RelationshipAssessmentInput,providerIdentity:string):NormalizedInput {
  if(!record(input)||!record(input.scope)||!Array.isArray(input.sources))throw new Error('invalid_relationship_input');
  const scope={worldId:id(input.scope.worldId),sessionId:id(input.scope.sessionId),branchId:id(input.scope.branchId),characterId:id(input.scope.characterId)};
  const subjectId=id(input.subjectId),characterId=id(input.characterId);
  if(!revision(input.sourceVersion)||!revision(input.controlsRevision)||input.sources.length>24)
    throw new Error('invalid_relationship_input');
  const seen=new Set<string>();
  const sources=input.sources.map(source=>{
    if(!record(source)||source.role!=='user'&&source.role!=='assistant'||!revision(source.revision)||!Number.isSafeInteger(source.acceptedAtMs)||source.acceptedAtMs<0)
      throw new Error('invalid_relationship_source');
    const idValue=id(source.id),textValue=bounded(source.text,20000,false);
    if(seen.has(idValue))throw new Error('duplicate_relationship_source');seen.add(idValue);
    return {id:idValue,revision:source.revision,text:textValue,role:source.role,acceptedAtMs:source.acceptedAtMs};
  });
  const openHerSummary=input.openHerSummary===undefined?undefined:bounded(input.openHerSummary,1000,true);
  const auxiliaryContext=input.auxiliaryContext;
  if(auxiliaryContext&&(typeof auxiliaryContext!=='object'||!Number.isSafeInteger(auxiliaryContext.clock?.nowMs)||
    auxiliaryContext.clock.nowMs<0||JSON.stringify(auxiliaryContext).length>4000))throw new Error('invalid_relationship_context');
  const normalized={scope,subjectId,characterId,sourceVersion:input.sourceVersion,controlsRevision:input.controlsRevision,
    sources,openHerSummary,auxiliaryContext,personalParameterVersion:input.personalParameterVersion??0};
  return {...normalized,sourceFingerprint:createHash('sha256').update(JSON.stringify({version:RELATIONSHIP_EVALUATION_VERSION,
    decisionVersion:DECISION_VERSION,
    prompt:RELATIONSHIP_EVIDENCE_PROMPT_HASH,
    providerIdentity,...normalized,auxiliaryContext:relationshipContextFingerprint(auxiliaryContext)})).digest('hex')};
}

function evidenceFingerprint(input:NormalizedInput,providerIdentity:string):string {
  const auxiliary=input.auxiliaryContext;
  return createHash('sha256').update(JSON.stringify({prompt:RELATIONSHIP_EVIDENCE_PROMPT_HASH,providerIdentity,
    scope:input.scope,subjectId:input.subjectId,characterId:input.characterId,controlsRevision:input.controlsRevision,sources:input.sources,
    // Clock and OpenHer changes affect current evaluation, not what the same
    // accepted words said. Revised contextual facts still require extraction.
    context:auxiliary?{timeZone:auxiliary.clock.timeZone,profileFacts:auxiliary.profileFacts,commitments:auxiliary.commitments,
      waitingSources:auxiliary.waiting?.sourceRefs??[],excluded:auxiliary.excluded}:null})).digest('hex');
}

function unknownMetrics():RelationshipMetrics {
  return Object.fromEntries(RELATIONSHIP_METRICS.map(key=>[key,{score:null,confidence:'low',rationale:'证据不足',evidence:[]}])) as unknown as RelationshipMetrics;
}
function scopeKey(scope:SceneScope){return JSON.stringify([scope.worldId,scope.sessionId,scope.branchId,scope.characterId]);}
function record(value:unknown):value is Record<string,any>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
function id(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>200)throw new Error('invalid_relationship_id');return value;}
function bounded(value:unknown,max:number,allowEmpty:boolean):string{
  if(typeof value!=='string'||value.length>max||!allowEmpty&&!value.trim())throw new Error('invalid_relationship_text');return value;
}
function revision(value:unknown):value is number{return Number.isSafeInteger(value)&&Number(value)>=0;}
function choice(value:unknown):RelationshipContactChoice{
  if(value!=='initiate'&&value!=='send'&&value!=='wait'&&value!=='skip')throw new Error('invalid_relationship_contact_choice');return value;
}
