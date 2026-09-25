import {createHash} from 'node:crypto';
import type {RelationshipAssessmentInput,RelationshipMetric,RelationshipMetrics} from './relationship-assessment.ts';

export const RELATIONSHIP_EVIDENCE_SCHEMA='xldb-relationship-evidence-v2' as const;
export const SUPPORTED_RELATIONSHIP_EVIDENCE_SCHEMA='xldb-relationship-evidence-v3' as const;
export const CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA='xldb-relationship-evidence-v4' as const;
export const RELATIONSHIP_EVALUATION_VERSION='relationship-evidence-rule-v4.2' as const;
export const RELATIONSHIP_EVENT_KINDS=[
  'distance_boundary','limited_contact','personal_warmth','explicit_care','mutual_closeness',
  'information_distrust','information_doubt','domain_verification','repeated_verification','sustained_reference',
  'disclosure_refusal','shallow_feeling','specific_feeling','vulnerable_disclosure','repeated_deep_disclosure',
  'delegation_refusal','supervised_task','bounded_delegation','repeated_important_delegation','broad_completed_delegation',
  'independent_coping','optional_support','habitual_support','coping_difficulty','dependency_harm',
] as const;
export type RelationshipEventKind=typeof RELATIONSHIP_EVENT_KINDS[number];
export interface RelationshipEvidenceItem {
  eventKind:RelationshipEventKind;attribution:'self'|'quoted_other'|'roleplay'|'uncertain';
  polarity:'affirmed'|'negated'|'uncertain';domain:string;timeBasis:'current'|'past'|'future'|'unknown';
  /** Fresh-host standing of the relationship proposition, not the date of the underlying action. */
  stanceStatus?:'active'|'historical'|'proposed'|'unknown';
  ref:{sourceId:string;revision:number;start:number;end:number;quote:string};qualifier:string;
  retracts?:{sourceId:string;revision:number;start:number;end:number;quote:string};
  support?:{verdict:'direct'|'unsupported'|'uncertain';basisQuote:string;reason:string};
}
export interface RelationshipEvidenceExtraction {schema:typeof RELATIONSHIP_EVIDENCE_SCHEMA|typeof SUPPORTED_RELATIONSHIP_EVIDENCE_SCHEMA|typeof CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA;
  items:RelationshipEvidenceItem[];
  receipt?:{provider:'host:relationshipEvidence';calls:1;inputCharacters:number;elapsedMs:number}}

const KIND_LEVEL:Record<RelationshipEventKind,{metric:RelationshipMetric;level:number}>=Object.fromEntries([
  ['agentToUserIntimacy',['distance_boundary','limited_contact','personal_warmth','explicit_care','mutual_closeness']],
  ['informationReliability',['information_distrust','information_doubt','domain_verification','repeated_verification','sustained_reference']],
  ['emotionalDisclosure',['disclosure_refusal','shallow_feeling','specific_feeling','vulnerable_disclosure','repeated_deep_disclosure']],
  ['taskDelegation',['delegation_refusal','supervised_task','bounded_delegation','repeated_important_delegation','broad_completed_delegation']],
  ['userDependency',['independent_coping','optional_support','habitual_support','coping_difficulty','dependency_harm']],
] .flatMap(([metric,kinds])=>(kinds as string[]).map((kind,level)=>[kind,{metric,level}]))) as Record<RelationshipEventKind,{metric:RelationshipMetric;level:number}>;
// Warmth and boundaries have the same observable levels on both sides; source role chooses direction.
const INTIMACY_KINDS=new Set<RelationshipEventKind>(['distance_boundary','limited_contact','personal_warmth','explicit_care','mutual_closeness']);
const MAX_INPUT_CHARS=48_000;
const EXTRACTION_RULES=[
  'assistant 来源只可提取亲近组，表示 Agent 对用户的态度；user 来源可提取用户亲近组及其余组。assistant 的帮助不是用户委托、依赖或信任。引用、虚构角色、假设和否定不得归属说话人。',
  '逐条扫描完整正文，同维度相反表态分别保留来源。亲近0要求当前明确疏远；1是仍愿维持客气、有界的办事往来或继续提供事务帮助，无须表达私人亲近；2要求针对对方的个人化友善；3要求明确关注对方感受、处境或福祉，普通祝愿或帮助达成小喜好仍属2；4要求双方持续了解与接纳。单句礼貌致谢、联系时间或隐私限定本身不定档。明确疏远并保留必要事务往来可同时提取0和1。',
  '信息2须一次特定结果核验正确且获用户认可；3须多次独立正确核验并获当前认可；4须明确将助手信息持续作为重要依据，而不仅是愿意先看看某个版本。核验动作在过去不等于认可已经失效；用户现在确认结果仍正确或据此行动时，相关命题为 active，ref.quote 应包含核验及当前认可依据。失败或错误核验不作正向证据。',
  '披露1仅浅谈情绪；2说明具体事件和由此产生的感受；3须进一步坦露平常隐藏的恐惧、羞耻、关系不安或自我价值等脆弱内心，仅有明确原因、持续委屈或比喻不够；4须反复披露重要深层内心且现在仍愿分享。仅保留情绪的原因或细节不构成全面拒谈0。',
  '委托评分看交给 Agent 执行行动的范围。只要解释、分析、建议或询问做法，即使许可回答，也不是执行委派；明确保留实际办理并拒绝代办可支持0。监督小任务为1，明确边界内独立执行为2，反复重要执行授权为3，较大任务已完成且获认可后继续授权为4。某项授权的排除范围写 qualifier；确实不同的执行任务分别保留授权与拒绝。',
  '非委托按连续项目归 domain，上下任务及当前认可的既往经历同域；亲近不按细小话题拆域。委托按 Agent 执行范围归 domain：同一行动的授权与拒绝须同域，同项目不同行动分域；用户自行做 A 不否定委托 B，排除 C 只限 C。',
  '依赖只看用户明确表达的应对能力、求助习惯或失去支持的影响。独立应对0可与可选支持1、惯常支持2同在，以更具体的求助档表达；缺少支持就难以应对3或损害独立生活4不能与独立应对合并。仅拒绝委托或说自己处理某件事不证明0。',
  'stanceStatus 表示当前命题是否有效，不表示动作发生日期：active=现在持有态度、意愿、认可或授权；historical=只有过去叙述而无当前延续；proposed=未来设想尚未形成当前意愿；unknown=依据不足。现在想将来交流、现在授权将来执行、现在认可过去核验或完成结果均为 active。',
  '同一引文的高档若包含低档，仅输出有独立必要条件支持的最高档；不同引文可保留相容观察。逐候选核对 direct 的独有条件、数量、当前效力和领域，缺少条件就标 unsupported，不能用相邻档推断。'
].join('\n');

export function relationshipEvidenceTask(input:RelationshipAssessmentInput){
  const sources=input.sources.map(source=>({id:source.id,revision:source.revision,role:source.role,text:source.text,acceptedAtMs:source.acceptedAtMs}));
  const payload=JSON.stringify({schema:CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA,characterId:input.characterId,sources,
    ...(input.auxiliaryContext?{auxiliaryContext:input.auxiliaryContext}:{})});
  if(payload.length>MAX_INPUT_CHARS)throw new Error('relationship_evidence_input_incomplete');
  return {messages:[{role:'system' as const,content:`只从 sources 的逐字正文提取关系行为；auxiliaryContext 只帮助解释时间、背景和领域，绝不是评分证据，不能引用它作 ref。不要打分、诊断或推断沉默动机。输出严格 JSON：{"schema":"${CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA}","items":[{"eventKind":枚举,"attribution":"self|quoted_other|roleplay|uncertain","polarity":"affirmed|negated|uncertain","domain":具体领域或"general","stanceStatus":"active|historical|proposed|unknown","ref":{"sourceId":ID,"revision":修订,"quote":逐字片段},"qualifier":限定语或空串,"support":{"verdict":"direct|unsupported|uncertain","basisQuote":原文中的最短依据或空串,"reason":简短说明必要条件}}]}。eventKind：${RELATIONSHIP_EVENT_KINDS.join(', ')}。五档依次对应亲近：疏远/有限/友善/关怀/双方持续接纳；信息：不信/怀疑/特定领域核验/多次核验/持续重要参考；披露：拒绝/浅谈/具体感受/脆弱/反复重要内心；委托：拒绝/监督小任务/有限授权/反复重要授权/较大任务且认可完成；依赖：独立/可选支持/惯常支持/缺少时难应对/损害独立生活。逐个核验实际候选及易混淆的相邻档：原文是否在该领域直接满足该档独有条件，谁表达、肯定还是否定、当前态度是否有效、一次还是反复、授权范围和应对能力是什么。不能因较低档成立就填较高档 direct；缺少较高档条件时保留该候选为 unsupported 并说明缺少什么，证据不明填 uncertain。精确字符位置由脚本定位；同一 quote 在该 source 多处出现时必须给精确 UTF-16 start/end 消歧，禁止猜引用位置。direct 的 basisQuote 必须是 ref.quote 中逐字片段，不能只引用整个话题代替该档条件。同一片段的两个候选必须分别判，不得复制相同理由；不必枚举无关档位。仅 direct 可形成关系结论。user 的“我”只属用户，assistant 的“我”只属 Agent。若同源随后明确撤回已提取命题，另输出 negated 项及被撤回项的精确 retracts ref；普通否定不填 retracts。未知直接证据时 items 为空。
${EXTRACTION_RULES}`},
    {role:'user' as const,content:payload}],responseFormat:'json' as const};
}
export const RELATIONSHIP_EVIDENCE_PROMPT_HASH=createHash('sha256').update(relationshipEvidenceTask({
  scope:{worldId:'',sessionId:'',branchId:'',characterId:''},subjectId:'',characterId:'',
  sourceVersion:0,controlsRevision:0,sources:[]}).messages.filter(message=>message.role==='system').map(message=>message.content).join('\n')).digest('hex');

export function decodeRelationshipEvidence(raw:unknown,input:RelationshipAssessmentInput,
  options:{allowLegacy?:boolean}={}):RelationshipEvidenceExtraction {
  let value:unknown=raw;
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new Error('invalid_relationship_evidence');}}
  if(!object(value)||value.schema!==CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA&&
    !((options.allowLegacy??true)&&(value.schema===RELATIONSHIP_EVIDENCE_SCHEMA||
      value.schema===SUPPORTED_RELATIONSHIP_EVIDENCE_SCHEMA))||
    !Array.isArray(value.items)||value.items.length>96)
    throw new Error('invalid_relationship_evidence');
  const schema=value.schema as RelationshipEvidenceExtraction['schema'];
  const items:RelationshipEvidenceItem[]=value.items.map((candidate:unknown)=>{
    if(!object(candidate)||!RELATIONSHIP_EVENT_KINDS.includes(candidate.eventKind)||
      !['self','quoted_other','roleplay','uncertain'].includes(candidate.attribution)||
      !['affirmed','negated','uncertain'].includes(candidate.polarity)||
      (schema===CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA?
        !['active','historical','proposed','unknown'].includes(candidate.stanceStatus):
        !['current','past','future','unknown'].includes(candidate.timeBasis))||
      typeof candidate.domain!=='string'||!candidate.domain.trim()||candidate.domain.length>100||
      typeof candidate.qualifier!=='string'||candidate.qualifier.length>240||!object(candidate.ref))
      throw new Error('invalid_relationship_evidence');
    const ref=normalizeEvidenceRef(candidate.ref,input,schema===CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA);
    const source=input.sources.find(item=>item.id===ref.sourceId&&item.revision===ref.revision)!;
    let support:RelationshipEvidenceItem['support'];
    if(schema!==RELATIONSHIP_EVIDENCE_SCHEMA){
      const proposed=candidate.support;
      if(!object(proposed)||!['direct','unsupported','uncertain'].includes(proposed.verdict)||
        typeof proposed.basisQuote!=='string'||proposed.basisQuote.length>500||
        typeof proposed.reason!=='string'||!proposed.reason.trim()||proposed.reason.length>200||
        proposed.verdict==='direct'&&(!proposed.basisQuote||!ref.quote.includes(proposed.basisQuote))||
        proposed.verdict!=='direct'&&proposed.basisQuote&&!ref.quote.includes(proposed.basisQuote))
        throw new Error('invalid_relationship_support');
      support={verdict:proposed.verdict,basisQuote:proposed.basisQuote,reason:proposed.reason};
    }
    const kind=candidate.eventKind as RelationshipEventKind;
    if(INTIMACY_KINDS.has(kind)?source.role!=='user'&&source.role!=='assistant':source.role!=='user')
      throw new Error('invalid_relationship_evidence_role');
    const stanceStatus=schema===CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA?
      candidate.stanceStatus as RelationshipEvidenceItem['stanceStatus']:undefined;
    const timeBasis=stanceStatus===undefined?candidate.timeBasis as RelationshipEvidenceItem['timeBasis']:
      ({active:'current',historical:'past',proposed:'future',unknown:'unknown'} as const)[stanceStatus];
    return {eventKind:kind,attribution:candidate.attribution,polarity:candidate.polarity,
      domain:candidate.domain,timeBasis,...(stanceStatus?{stanceStatus}:{}),ref:{sourceId:source.id,revision:source.revision,
        start:ref.start,end:ref.end,quote:ref.quote},qualifier:candidate.qualifier,
        ...(candidate.retracts!==undefined?{retracts:schema===CURRENT_RELATIONSHIP_EVIDENCE_SCHEMA?
          normalizeEvidenceRef(candidate.retracts,input,true):candidate.retracts}:{}),...(support?{support}:{})};
  });
  for(const item of items){
    if(item.retracts===undefined)continue;
    const target=items.find(other=>other.polarity==='affirmed'&&other.attribution==='self'&&
      other.eventKind===item.eventKind&&relationshipDomain(other)===relationshipDomain(item)&&sameRef(other.ref,item.retracts));
    if(!target||item.attribution!=='self'||item.polarity!=='negated'||item.timeBasis!=='current'||
      !laterSameSpeaker(item,target,input))throw new Error('invalid_relationship_retraction');
    item.retracts={...target.ref};
  }
  let receipt:RelationshipEvidenceExtraction['receipt'];
  if(value.receipt!==undefined){
    if(!object(value.receipt)||value.receipt.provider!=='host:relationshipEvidence'||value.receipt.calls!==1||
      !Number.isSafeInteger(value.receipt.inputCharacters)||value.receipt.inputCharacters<0||
      !Number.isFinite(value.receipt.elapsedMs)||value.receipt.elapsedMs<0)
      throw new Error('invalid_relationship_evidence_receipt');
    receipt={provider:'host:relationshipEvidence',calls:1,inputCharacters:value.receipt.inputCharacters,
      elapsedMs:value.receipt.elapsedMs};
  }
  return {schema,items,...(receipt?{receipt}:{})};
}

/** The host identifies a literal quote; only an unambiguous occurrence may replace its offsets. */
function normalizeEvidenceRef(value:unknown,input:RelationshipAssessmentInput,anchorUnique:boolean):RelationshipEvidenceItem['ref'] {
  if(!object(value))throw new Error('invalid_relationship_evidence_ref');
  const source=input.sources.find(item=>item.id===value.sourceId&&item.revision===value.revision);
  if(!source||typeof value.quote!=='string'||!value.quote||value.quote.length>500)
    throw new Error('invalid_relationship_evidence_ref');
  if(anchorUnique){
    const first=source.text.indexOf(value.quote);
    if(first<0)throw new Error('invalid_relationship_evidence_ref');
    if(first===source.text.lastIndexOf(value.quote))return {sourceId:source.id,revision:source.revision,
      start:first,end:first+value.quote.length,quote:value.quote};
  }
  if(!Number.isSafeInteger(value.start)||!Number.isSafeInteger(value.end)||value.start<0||
    value.end<=value.start||value.end>source.text.length||
    source.text.slice(value.start,value.end)!==value.quote)throw new Error('invalid_relationship_evidence_ref');
  return {sourceId:source.id,revision:source.revision,start:value.start,end:value.end,quote:value.quote};
}

export interface EvidenceProjection {
  metrics:RelationshipMetrics;
  /** Ambiguous readings of the same span only. Conflicting events and domains remain unresolved. */
  ambiguous:Partial<Record<RelationshipMetric,{levels:number[];items:RelationshipEvidenceItem[]}>>;
}

/** Higher cumulative evidence can subsume a lower observation without erasing distinct boundaries. */
export function resolveRelationshipLevel(metric:RelationshipMetric,items:readonly RelationshipEvidenceItem[]):number|null {
  if(!items.length)return null;
  const levels=[...new Set(items.map(item=>KIND_LEVEL[item.eventKind].level))].sort((a,b)=>a-b);
  if(levels.length===1)return levels[0];
  if((metric==='agentToUserIntimacy'||metric==='userToAgentIntimacy')&&levels.join(',')==='0,1'){
    const distance=items.filter(item=>KIND_LEVEL[item.eventKind].level===0);
    const limited=items.filter(item=>KIND_LEVEL[item.eventKind].level===1);
    if(distance.some(left=>limited.some(right=>left.ref.sourceId!==right.ref.sourceId||
      left.ref.revision!==right.ref.revision||left.ref.end<=right.ref.start||right.ref.end<=left.ref.start)))
      return 0;
    return null;
  }
  const dependencyCompatible=new Set(['0,1','0,2','0,1,2','1,2','2,3','2,4','2,3,4','3,4']);
  const cumulative=metric==='agentToUserIntimacy'||metric==='userToAgentIntimacy'||
    metric==='informationReliability'?levels.every(level=>level>=2):
    metric==='emotionalDisclosure'?levels.every(level=>level>=1):
    metric==='taskDelegation'?levels.every(level=>level>=2):
    metric==='userDependency'?dependencyCompatible.has(levels.join(',')):false;
  if(!cumulative)return null;
  for(const item of items)for(const other of items){
    if(item===other||KIND_LEVEL[item.eventKind].level===KIND_LEVEL[other.eventKind].level)continue;
    if(metric==='userDependency')continue;
    const sameSpan=item.ref.sourceId===other.ref.sourceId&&item.ref.revision===other.ref.revision&&
      item.ref.start<other.ref.end&&other.ref.start<item.ref.end;
    const includedCondition=levels.length===2&&metric==='taskDelegation'&&levels[0]===2&&levels[1]===3;
    if(sameSpan&&!includedCondition)return null;
  }
  return levels.at(-1)!;
}

/** Current user evidence that is neither retracted nor in a currently conflicted domain. */
export function currentUncontestedRelationshipEvidence(extraction:RelationshipEvidenceExtraction,
  input:RelationshipAssessmentInput):RelationshipEvidenceItem[] {
  const normalized=extraction.items.filter(directSupport).map(item=>({...item,domain:relationshipDomain(item)}));
  const positives=normalized.filter(item=>item.attribution==='self'&&item.polarity==='affirmed'&&
    item.timeBasis==='current'&&input.sources.some(source=>source.id===item.ref.sourceId&&
      source.revision===item.ref.revision&&source.role==='user')&&
    !(item.eventKind==='limited_contact'&&contactTimingOnly(item.ref.quote))).filter(item=>
    !normalized.some(other=>other.eventKind===item.eventKind&&other.domain===item.domain&&
      other.attribution==='self'&&other.polarity==='negated'&&other.timeBasis==='current'&&
      sameRef(item.ref,other.retracts)&&laterSameSpeaker(other,item,input)));
  return positives.filter(item=>!normalized.some(other=>other.attribution==='self'&&
    other.polarity==='negated'&&other.timeBasis==='current'&&!other.retracts&&
    other.domain===item.domain&&KIND_LEVEL[other.eventKind].metric===KIND_LEVEL[item.eventKind].metric&&
    positives.some(positive=>positive.domain===item.domain&&positive.eventKind===other.eventKind&&
      laterSameSpeaker(other,positive,input))));
}
export function projectRelationshipEvidence(extraction:RelationshipEvidenceExtraction,input:RelationshipAssessmentInput):EvidenceProjection {
  const metrics=Object.fromEntries((['agentToUserIntimacy','userToAgentIntimacy','informationReliability','emotionalDisclosure','taskDelegation','userDependency'] as RelationshipMetric[])
    .map(key=>[key,{score:null,confidence:'low',rationale:'没有可支持的当前行为证据',evidence:[],origin:'evidence_rule',domains:[]}])) as unknown as RelationshipMetrics;
  const normalizedItems=extraction.items.filter(directSupport).map(item=>({...item,domain:relationshipDomain(item)}));
  const grouped=new Map<RelationshipMetric,RelationshipEvidenceItem[]>();
  for(const item of normalizedItems){
    if(item.attribution!=='self'||item.polarity!=='affirmed'||item.timeBasis==='future'||item.timeBasis==='unknown')continue;
    if(item.eventKind==='limited_contact'&&contactTimingOnly(item.ref.quote))continue;
    const source=input.sources.find(candidate=>candidate.id===item.ref.sourceId&&candidate.revision===item.ref.revision)!;
    const metric=INTIMACY_KINDS.has(item.eventKind)?source.role==='user'?'userToAgentIntimacy':'agentToUserIntimacy':KIND_LEVEL[item.eventKind].metric;
    grouped.set(metric,[...(grouped.get(metric)??[]),item]);
  }
  const ambiguous:EvidenceProjection['ambiguous']={};
  for(const [metric,originalItems] of grouped){
    const items=originalItems.filter(item=>{
      return !normalizedItems.some(other=>other.eventKind===item.eventKind&&other.domain===item.domain&&
        other.attribution==='self'&&other.polarity==='negated'&&other.timeBasis==='current'&&
        sameRef(item.ref,other.retracts)&&laterSameSpeaker(other,item,input));
    });
    if(!items.length)continue;
    const currentItems=items.filter(item=>item.timeBasis==='current');
    const domains=[...new Set(items.map(item=>item.domain))];
    const domainItems=domains.map(domain=>{
      const positives=items.filter(item=>item.domain===domain),current=positives.filter(item=>item.timeBasis==='current');
      const negatives=normalizedItems.filter(other=>other.domain===domain&&other.attribution==='self'&&
        other.polarity==='negated'&&other.timeBasis==='current'&&!other.retracts&&
        positives.some(item=>item.eventKind===other.eventKind&&laterSameSpeaker(other,item,input)));
      const status=negatives.length?'conflicted' as const:current.length?'current' as const:'historical' as const;
      const combined=[...negatives,...(current.length?current:positives)];
      const domainScore=status==='current'?resolveRelationshipLevel(metric,current):null;
      return {domain,status,score:status==='conflicted'?null:domainScore,
        levels:[...new Set((current.length?current:positives).map(item=>KIND_LEVEL[item.eventKind].level))],
        evidence:combined.slice(0,5).map(item=>({sourceId:item.ref.sourceId,revision:item.ref.revision,quote:item.ref.quote})),
        qualifiers:[...new Set(combined.map(item=>item.qualifier).filter(Boolean))].slice(0,5)};
    });
    const currentDomains=domainItems.filter(domain=>domain.status==='current');
    const conflicted=domainItems.some(domain=>domain.status==='conflicted');
    const levels=[...new Set(currentItems.map(item=>KIND_LEVEL[item.eventKind].level))];
    const sameSpan=currentItems.length>0&&currentItems.every(item=>item.domain===currentItems[0].domain&&
      item.ref.sourceId===currentItems[0].ref.sourceId&&item.ref.revision===currentItems[0].ref.revision&&
      item.ref.start<currentItems[0].ref.end&&currentItems[0].ref.start<item.ref.end);
    if(!conflicted&&levels.length>1&&sameSpan&&currentDomains[0]?.score===null)
      ambiguous[metric]={levels,items:currentItems};
    const candidateScores=[...new Set(currentDomains.map(domain=>domain.score))];
    const score=!conflicted&&currentDomains.length>0&&candidateScores.length===1?candidateScores[0]:null;
    metrics[metric]={score,confidence:'low',rationale:score===null?'仅有历史、不同领域、不同档位或当前冲突证据，暂不形成当前分值':
      `已接受对话中有${items.length}条直接行为证据`,evidence:score===null?[]:
        currentDomains.flatMap(domain=>domain.evidence).slice(0,5),origin:'evidence_rule',domains:domainItems};
  }
  return {metrics,ambiguous};
}

export function relationshipDomain(item:RelationshipEvidenceItem):string {
  if(!INTIMACY_KINDS.has(item.eventKind))return item.domain;
  const domain=item.domain.trim();
  return domain==='general'||/^(?:relationship|the relationship|我们(?:的)?关系|双方(?:的)?关系|双方相处|亲近关系)$/i.test(domain)
    ?'relationship':domain;
}

function directSupport(item:RelationshipEvidenceItem):boolean {
  return item.support===undefined||item.support.verdict==='direct';
}

/** A contact schedule alone is a control, not a statement about relational closeness. */
function contactTimingOnly(quote:string):boolean {
  return /(?:今晚|今天|明天|晚上|白天|睡觉|睡眠|点后|点前|时段|tonight|tomorrow|after \d|before \d|while (?:I |I'm )?sleep)/i.test(quote)&&
    /(?:主动联系|联系时段|别联系|不要联系|发消息|回复时段|contact window|do not (?:call|text|message))/i.test(quote)&&
    !/(?:亲近|亲密|在乎|喜欢你|关心你|保持距离|疏远|冷淡|珍惜|不想再|受够|永远|以后都|再也|(?:our|this) relationship|keep (?:some )?distance|never|anymore|ever again)/i.test(quote);
}

function sameRef(left:RelationshipEvidenceItem['ref'],right:unknown):boolean {
  return object(right)&&left.sourceId===right.sourceId&&left.revision===right.revision&&
    left.start===right.start&&left.end===right.end&&left.quote===right.quote;
}
function laterSameSpeaker(later:RelationshipEvidenceItem,earlier:RelationshipEvidenceItem,input:RelationshipAssessmentInput):boolean {
  const a=input.sources.find(source=>source.id===later.ref.sourceId&&source.revision===later.ref.revision);
  const b=input.sources.find(source=>source.id===earlier.ref.sourceId&&source.revision===earlier.ref.revision);
  return !!a&&!!b&&a.role===b.role&&(a.acceptedAtMs>b.acceptedAtMs||a.id===b.id&&later.ref.start>earlier.ref.start);
}

function object(value:unknown):value is Record<string,any>{return typeof value==='object'&&value!==null&&!Array.isArray(value);}
