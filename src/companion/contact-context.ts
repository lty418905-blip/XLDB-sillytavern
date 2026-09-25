import type {SceneSource} from '../scene/types.ts';
import type {ProfileEntry} from '../user-model/types.ts';
import type {CommitmentRecord} from '../commitments/types.ts';
import type {ContactAffect} from '../emotion/contact-affect.ts';
import {selectWholeContactFacts} from './relationship-context.ts';

export interface ContactSource {id:string;revision:number;role:'user'|'assistant';text:string;acceptedAtMs:number}
export interface ContactContext {
  clock:{nowMs:number;utcIso:string;timeZone:string;localDateTime:string;weekday:string};
  /** Only the latest accepted direct user source may establish an active sleep boundary. */
  sleepBoundary:{sourceRef:string;acceptedAtMs:number}|null;
  waiting:{phase:'waiting'|'returning';sentAtMs:number;sourceId:string;absence:string;feelings:ContactAffect['feelings'];
    needsClarification:boolean;explanations:{ref:string;quote:string}[];currentExplanation?:string}|null;
  interaction:{windowStartMs:number;windowEndMs:number;summary:string;sourceRefs:string[]};
  user:{habits:{ref:string;claim:string;uncertain:boolean}[];profile:{ref:string;claim:string;uncertain:boolean}[]};
  commitments:{ref:string;content:string;term:CommitmentRecord['term']}[];
  emotion:{persona:string;current:string};
  omitted:{habits:number;profile:number;commitments:number};
}

const HOUR=3_600_000;
export function contactSources(sources:readonly SceneSource[],characterId:string,nowMs:number):ContactSource[]{
  if(!Number.isSafeInteger(nowMs)||nowMs<12*HOUR)throw new Error('invalid_contact_context');
  return sources.filter(source=>source.status==='accepted'&&source.processing==='ready'&&
    source.acceptedAtMs>=nowMs-12*HOUR&&source.acceptedAtMs<=nowMs&&
    source.envelope.mode==='direct'&&source.envelope.targetId===characterId&&
    source.envelope.presentIds.length===1&&source.envelope.presentIds[0]===characterId&&
    (source.role==='user'||source.role==='assistant'&&source.speakerId===characterId))
    .map(source=>({id:source.id,revision:source.revision,role:source.role as 'user'|'assistant',text:source.text,acceptedAtMs:source.acceptedAtMs}));
}

export function contactSummaryTask(sources:readonly ContactSource[],nowMs:number){
  const input=JSON.stringify({windowStartMs:nowMs-12*HOUR,windowEndMs:nowMs,sources});
  if(input.length>20_000)throw new Error('contact_context_too_large');
  return {sources:[...sources],messages:[
    {role:'system' as const,content:'只总结所给过去12小时真实且可见的互动，区分用户与角色；不补造动机、计划或用户近况。返回 JSON：{"schema":"xldb-contact-summary-v1","summary":"不超过320字；没有互动时写无近期互动","sources":[{"id":"输入来源ID","revision":1,"quote":"来自该来源正文的逐字短句"}]}。sources列出摘要实际引用的来源及逐字证据；无互动时为空。'},
    {role:'user' as const,content:input},
  ]};
}

export function decodeContactSummary(raw:string,sources:readonly ContactSource[]):{summary:string;sources:{id:string;revision:number}[]}{
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('invalid_contact_summary');}
  if(!value||typeof value!=='object')throw new Error('invalid_contact_summary');
  const row=value as Record<string,unknown>;
  if(row.schema!=='xldb-contact-summary-v1'||typeof row.summary!=='string'||!row.summary.trim()||row.summary.length>320||
    !Array.isArray(row.sources)||row.sources.length>sources.length)throw new Error('invalid_contact_summary');
  const allowed=new Map(sources.map(source=>[source.id,source]));
  const refs=row.sources.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_contact_summary');
    const ref=item as Record<string,unknown>;
    const source=typeof ref.id==='string'?allowed.get(ref.id):undefined;
    if(!source||source.revision!==ref.revision||typeof ref.quote!=='string'||!ref.quote.trim()||
      ref.quote.length>200||!source.text.includes(ref.quote))throw new Error('invalid_contact_summary');
    return {id:ref.id as string,revision:ref.revision as number};
  });
  if(new Set(refs.map(ref=>ref.id)).size!==refs.length||(!sources.length&&refs.length))throw new Error('invalid_contact_summary');
  if(sources.length&&!refs.length)throw new Error('invalid_contact_summary');
  return {summary:row.summary.trim(),sources:refs};
}

export function contactContext(input:{sources:readonly ContactSource[];nowMs:number;summary:{summary:string;sources:{id:string;revision:number}[]};
  entries:readonly ProfileEntry[];commitments:readonly CommitmentRecord[];persona:string;emotion:string;timeZone:string;
  affect?:ContactAffect|null}):ContactContext {
  const affect=input.affect;
  const result:ContactContext={clock:contactClock(input.nowMs,input.timeZone),
    sleepBoundary:explicitSleepBoundary(input.sources),
    waiting:affect?.episode&&affect.phase!=='none'?{phase:affect.phase,sentAtMs:affect.episode.sentAtMs,
      sourceId:affect.episode.deliveryId,absence:affect.absence??'uncertain',feelings:affect.feelings,
      needsClarification:Boolean(affect.needsClarification),
      explanations:affect.sourceRefs.explanationSources.map(ref=>({ref:`${ref.sourceId}@${ref.revision}`,quote:ref.quote})),
      ...(affect.currentExplanation?{currentExplanation:affect.currentExplanation}:{})}:null,
    interaction:{windowStartMs:input.nowMs-12*HOUR,windowEndMs:input.nowMs,
    summary:input.summary.summary,sourceRefs:input.summary.sources.map(ref=>`${ref.id}@${ref.revision}`)},
    user:{habits:[],profile:[]},commitments:[],emotion:{persona:input.persona,current:input.emotion},
    omitted:{habits:0,profile:0,commitments:0}};
  const available=2400-JSON.stringify(result).length-100;
  if(available<1)throw new Error('contact_context_too_large');
  const selected=selectWholeContactFacts(input.entries,input.commitments,available);
  if(input.commitments.some(record=>record.contactRestriction&&selected.excluded.commitmentRefs.includes(`${record.id}@${record.revision}`)))
    throw new Error('contact_context_too_large');
  const habits=selected.profileEntries.filter(entry=>entry.theme==='daily_routine'||entry.theme==='communication')
    .map(entry=>({ref:`${entry.id}@${entry.revision}`,claim:entry.claim,
      uncertain:entry.basis==='inferred'||entry.attribution==='uncertain'}));
  const profile=selected.profileEntries.filter(entry=>entry.theme!=='daily_routine'&&entry.theme!=='communication')
    .map(entry=>({ref:`${entry.id}@${entry.revision}`,claim:entry.claim,uncertain:entry.basis==='inferred'||entry.attribution==='uncertain'}));
  const commitments=selected.commitments.map(record=>({ref:`${record.id}@${record.revision}`,content:record.content,term:record.term}));
  result.user={habits,profile};result.commitments=commitments;
  result.omitted={habits:input.entries.filter(entry=>(entry.theme==='daily_routine'||entry.theme==='communication')&&
      selected.excluded.profileRefs.includes(`${entry.id}@${entry.revision}`)).length,
    profile:input.entries.filter(entry=>entry.theme!=='daily_routine'&&entry.theme!=='communication'&&
      selected.excluded.profileRefs.includes(`${entry.id}@${entry.revision}`)).length,
    commitments:selected.excluded.commitmentRefs.length};
  if(JSON.stringify(result).length>2400)throw new Error('contact_context_too_large');
  return result;
}

export function explicitSleepBoundary(sources:readonly ContactSource[]):ContactContext['sleepBoundary'] {
  let latest:ContactSource|undefined;
  for(const source of sources)if(source.role==='user'&&(!latest||source.acceptedAtMs>=latest.acceptedAtMs))latest=source;
  if(!latest)return null;
  // Require a direct, current statement. A habit, quoted speech, denial, or an older
  // bedtime followed by a new user message cannot establish this boundary.
  const text=latest.text.replace(/“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'/gu,'').trim();
  const direct=/(?:^|[。！？\n])\s*(?:(?:我|我现在|我先|我要|我得|现在|先)\s*(?:去|要|准备)?\s*睡(?:觉)?(?:了)?|晚安)(?:[，。！？\s]|$)/u;
  const match=direct.exec(text);
  if(!match)return null;
  const following=text.slice(match.index+match[0].length);
  // A future plan (e.g. “明早继续工作”) is not a retraction of going to sleep now.
  const currentRetraction=/^(?:(?:但是|不过|其实|但)\s*)?(?:我)?(?:现在|目前|这会儿|此刻)?(?:没睡|不睡|还醒着|醒了|(?:还要|还得|还在|正在|继续)(?:继续)?(?:工作|加班|忙|学习))/u;
  const deniedSleep=/^(?:(?:但是|不过|其实|但)\s*)?(?:我)?(?:不是说|并非|不表示|没说).{0,12}(?:睡|休息)/u;
  if(following.split(/[，,。；;！？!?\n]/u).some(clause=>currentRetraction.test(clause.trim())||deniedSleep.test(clause.trim())))return null;
  return {sourceRef:`${latest.id}@${latest.revision}`,acceptedAtMs:latest.acceptedAtMs};
}

export function contactClock(nowMs:number,timeZone:string):ContactContext['clock'] {
  if(!Number.isSafeInteger(nowMs)||nowMs<0||typeof timeZone!=='string'||!timeZone)throw new Error('invalid_contact_clock');
  let parts:Intl.DateTimeFormatPart[];
  try{parts=new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'short',hourCycle:'h23'}).formatToParts(nowMs);}
  catch{throw new Error('invalid_contact_clock');}
  const part=(kind:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===kind)?.value??'';
  return {nowMs,utcIso:new Date(nowMs).toISOString(),timeZone,
    localDateTime:`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`,
    weekday:part('weekday')};
}
