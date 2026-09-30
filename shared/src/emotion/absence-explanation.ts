import type {SceneSource} from '../scene/types.ts';
import {resolveCommitmentTime} from '../commitments/time.ts';

export type AbsenceReason='busy'|'offline'|'paused'|'unknown';
type AbsenceAssertion={subject:'self';timeRelation:'current'|'scheduled';polarity:'affirmed';speech:'direct'};
export type AbsenceExplanationOperation=
  | {kind:'announce';sourceId:string;sourceRevision:number;sourceAcceptedAtMs:number;characterId:string;
      quote:string;reason:AbsenceReason;timeRelation:'current'|'scheduled';startCertainty:'bounded'|'uncertain';
      validFromMs:number;validUntilMs:number|null;certainty:'bounded'|'uncertain'}
  | {kind:'return';sourceId:string;sourceRevision:number;sourceAcceptedAtMs:number;characterId:string;quote:string};
export type AbsenceExplanationInterval=Extract<AbsenceExplanationOperation,{kind:'announce'}>&{effectiveUntilMs:number|null};

type Candidate=
  | {kind:'none'}
  | {kind:'announce';quote:string;reason:AbsenceReason;assertion:AbsenceAssertion;startQuote?:string;untilQuote?:string}
  | {kind:'return';quote:string;assertion:AbsenceAssertion};

const schema={type:'object',additionalProperties:false,oneOf:[
  {type:'object',additionalProperties:false,required:['kind'],properties:{kind:{const:'none'}}},
  {type:'object',additionalProperties:false,required:['kind','quote','reason','assertion'],properties:{kind:{const:'announce'},
    quote:{type:'string'},reason:{enum:['busy','offline','paused','unknown']},assertion:{type:'object',additionalProperties:false,
      required:['subject','timeRelation','polarity','speech'],properties:{subject:{const:'self'},
      timeRelation:{enum:['current','scheduled']},polarity:{const:'affirmed'},speech:{const:'direct'}}},
    startQuote:{type:'string'},untilQuote:{type:'string'}}},
  {type:'object',additionalProperties:false,required:['kind','quote','assertion'],properties:{kind:{const:'return'},quote:{type:'string'},
    assertion:{type:'object',additionalProperties:false,required:['subject','timeRelation','polarity','speech'],
      properties:{subject:{const:'self'},timeRelation:{const:'current'},polarity:{const:'affirmed'},speech:{const:'direct'}}}}},
]};

export function absenceExplanationTask(source:SceneSource,timeZone:string){
  return {messages:[
    {role:'system' as const,content:[
      'Extract the real user’s own direct, affirmed explanation for a current or scheduled inability to reply, or their explicit return/clarification. This is neither an assistant promise nor a no-contact rule.',
      'Return JSON kind none, announce, or return. An announce includes assertion {subject:"self",timeRelation:"current"|"scheduled",polarity:"affirmed",speech:"direct"}; a return uses current. Copy quote and any startQuote/untilQuote verbatim from this accepted user body. reason is busy, offline, paused, or unknown if no narrower reason is supported. Never compute a timestamp. Vague timing remains uncertain; do not invent exact hours.',
      'Accept omitted first-person subjects when the direct user clearly refers to their own availability: “这几天忙，回头聊”, “忙完找你”. “我明天考试，晚上再聊” is scheduled and uncertain unless a precise start/end is said. “我到明晚忙不能回复” is current and uncertain until. Reject hypothetical examples, someone else’s speech, past-only unavailability, negated claims, and no-contact requests. “我回来了”, “昨天一直开会，刚能回复” and “I was busy yesterday, but I am back now” are current return statements; keep their explanation in the quote without rewriting it as advance notice. Ordinary silence is none.',
    ].join(' ' )},
    {role:'user' as const,content:JSON.stringify({sourceId:source.id,sourceRevision:source.revision,
      acceptedAtMs:source.acceptedAtMs,role:source.role,targetId:source.envelope.targetId,mode:source.envelope.mode,timeZone,text:source.text})},
  ],schema};
}

export function validateAbsenceExplanation(source:SceneSource,raw:unknown,input:{characterId:string;timeZone:string}):AbsenceExplanationOperation|null {
  if(source.role!=='user'||source.envelope.mode!=='direct'||source.envelope.targetId!==input.characterId||
    source.envelope.presentIds.length!==1||source.envelope.presentIds[0]!==input.characterId)return null;
  if(!Number.isSafeInteger(source.acceptedAtMs)||source.acceptedAtMs<0)throw new Error('invalid_absence_source_time');
  const candidate=decode(raw);
  if(candidate.kind==='none')return null;
  const quote=candidate.quote.trim();
  if(!quote||quote.length>500||!source.text.includes(quote)||!groundedExplanation(source.text,quote,candidate.kind==='return'))
    throw new Error('invalid_absence_evidence');
  const common={sourceId:source.id,sourceRevision:source.revision,sourceAcceptedAtMs:source.acceptedAtMs,
    characterId:input.characterId,quote};
  if(candidate.kind==='return'){
    if(candidate.assertion.timeRelation!=='current')
      throw new Error('invalid_absence_return');
    return {kind:'return',...common};
  }
  if(/(?:我|本人)?(?:不忙|不是.{0,4}忙|没在忙|没有离线|并不忙|不会忙)/.test(quote))
    throw new Error('invalid_absence_evidence');
  let validFromMs=source.acceptedAtMs;
  let startCertainty:'bounded'|'uncertain'=candidate.assertion.timeRelation==='current'?'bounded':'uncertain';
  if(candidate.startQuote!==undefined){
    if(!quote.includes(candidate.startQuote))throw new Error('invalid_absence_time_quote');
    const start=resolveCommitmentTime(candidate.startQuote,{clockTimeMs:source.acceptedAtMs,timeZone:input.timeZone});
    if(start!==null){
      if(candidate.assertion.timeRelation==='current'&&start>source.acceptedAtMs)throw new Error('invalid_absence_future');
      validFromMs=candidate.assertion.timeRelation==='scheduled'?start:source.acceptedAtMs;
      startCertainty='bounded';
    }
  }
  if(candidate.untilQuote!==undefined&&!quote.includes(candidate.untilQuote))throw new Error('invalid_absence_time_quote');
  const until=candidate.untilQuote===undefined?null:resolveCommitmentTime(candidate.untilQuote,
    {clockTimeMs:source.acceptedAtMs,timeZone:input.timeZone});
  if(until!==null&&until<=validFromMs)throw new Error('invalid_absence_past');
  const reason=reasonInQuote(candidate.reason,quote)?candidate.reason:'unknown';
  return {kind:'announce',...common,reason,timeRelation:candidate.assertion.timeRelation,startCertainty,validFromMs,
    validUntilMs:until,certainty:until===null||startCertainty==='uncertain'?'uncertain':'bounded'};
}

export function absenceExplanationTimeline(sources:readonly SceneSource[],characterId:string,nowMs=Number.MAX_SAFE_INTEGER):AbsenceExplanationInterval[]{
  const result:AbsenceExplanationInterval[]=[];
  for(const source of sources){
    if(source.status!=='accepted'||source.processing!=='ready'||source.acceptedAtMs>nowMs||source.role!=='user'||
      source.envelope.mode!=='direct'||source.envelope.targetId!==characterId||
      source.envelope.presentIds.length!==1||source.envelope.presentIds[0]!==characterId)continue;
    const operation=source.analysis?.absenceExplanation;
    if(!operation||operation.sourceId!==source.id||operation.sourceRevision!==source.revision||
      operation.sourceAcceptedAtMs!==source.acceptedAtMs||operation.characterId!==characterId||
      !source.text.includes(operation.quote))continue;
    // Announcing a future absence does not end the absence that is happening
    // now. An unresolved future start cannot supply a replacement boundary.
    const cutoff=operation.kind==='return'||operation.timeRelation==='current'?source.acceptedAtMs:
      operation.startCertainty==='bounded'?operation.validFromMs:null;
    if(cutoff!==null)for(const prior of result){
      if(prior.validFromMs<=cutoff&&(prior.effectiveUntilMs===null||prior.effectiveUntilMs>cutoff))
        prior.effectiveUntilMs=cutoff;
    }
    if(operation.kind==='announce')result.push({...operation,effectiveUntilMs:operation.validUntilMs});
  }
  return result;
}

export function activeAbsenceExplanation(sources:readonly SceneSource[],characterId:string,nowMs:number):AbsenceExplanationInterval|null {
  if(!Number.isSafeInteger(nowMs)||nowMs<0)throw new Error('invalid_absence_time');
  return absenceExplanationTimeline(sources,characterId,nowMs).findLast(item=>
    (item.timeRelation==='current'||item.startCertainty==='bounded')&&item.validFromMs<=nowMs&&
    (item.effectiveUntilMs===null||item.effectiveUntilMs>nowMs))??null;
}

function decode(raw:unknown):Candidate {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid_absence_candidate');
  const row=raw as Record<string,unknown>;
  const kind=row.kind;
  if(kind==='none'&&Object.keys(row).length===1)return {kind};
  const assertion=assertionOf(row.assertion);
  if(kind==='return'&&Object.keys(row).length===3&&typeof row.quote==='string'&&assertion)
    return {kind,quote:row.quote,assertion};
  if(kind==='announce'&&typeof row.quote==='string'&&['busy','offline','paused','unknown'].includes(String(row.reason))&&assertion&&
    Object.keys(row).every(key=>['kind','quote','reason','assertion','startQuote','untilQuote'].includes(key))&&
    (row.startQuote===undefined||typeof row.startQuote==='string')&&
    (row.untilQuote===undefined||typeof row.untilQuote==='string'))
    return {kind,quote:row.quote,reason:row.reason as AbsenceReason,assertion,
      ...(row.startQuote===undefined?{}:{startQuote:row.startQuote}),
      ...(row.untilQuote===undefined?{}:{untilQuote:row.untilQuote})};
  throw new Error('invalid_absence_candidate');
}

function assertionOf(raw:unknown):AbsenceAssertion|null {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const value=raw as Record<string,unknown>;
  if(Object.keys(value).length!==4||value.subject!=='self'||value.polarity!=='affirmed'||value.speech!=='direct'||
    (value.timeRelation!=='current'&&value.timeRelation!=='scheduled'))return null;
  return value as AbsenceAssertion;
}

function groundedExplanation(sourceText:string,quote:string,currentReturn=false):boolean {
  if(!currentReturn&&/(?:以前|之前|过去|曾经|那时|昨天|上周|上个月)/.test(quote)||
    /(?:假如|假设|如果|比如|举例|例如)/.test(quote))return false;
  const before=sourceText.slice(Math.max(0,sourceText.indexOf(quote)-16),sourceText.indexOf(quote));
  if(/(?:他|她|他们|别人|朋友|同事).{0,12}(?:说|表示|告诉|发来|写道)[：:“"'\s]*$/.test(before)||
    /(?:举例|比如|假如|如果|假设|曾|说|写|提到|引用|引述)[：:“"'\s]*$/.test(before))return false;
  return true;
}
function reasonInQuote(reason:AbsenceReason,quote:string):boolean {
  if(reason==='unknown')return true;
  if(reason==='busy')return /忙|没空|没时间|工作|开会|考试|出差|不能回复|无法回复/.test(quote);
  if(reason==='offline')return /离线|没网|断网|无法上网/.test(quote);
  return /暂停|休息|不想聊|不方便聊|暂时不回复/.test(quote);
}
