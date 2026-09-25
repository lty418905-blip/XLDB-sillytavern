import {profileAttributions,profileBases,profileCategories,profileThemes} from './types.ts';
import type {CommunicationStrategy,ProfileCandidate,ProfileExtractionTask,ProfileMergeAction,ProfileReflectionTask,StrategyFeedback,StrategyTask} from './types.ts';
import type {SceneScope} from '../scene/types.ts';

export function profileExtractionPrompt(input:{subjectId:string;scope:SceneScope;source:{id:string;revision:number;text:string;acceptedAtMs:number};allowedCategories:readonly string[]}):ProfileExtractionTask {
  if(!input.allowedCategories.length)throw new Error('profile_learning_disabled');
  return {schema:'xldb-profile-extraction-task-v1',subjectId:identifier(input.subjectId),scope:structuredClone(input.scope),
    source:{id:identifier(input.source.id),revision:revision(input.source.revision),text:bounded(input.source.text,20000),acceptedAtMs:time(input.source.acceptedAtMs)},
    allowedCategories:input.allowedCategories.map(category=>profileCategories.includes(category as never)?category:invalid('invalid_profile_category')) as ProfileExtractionTask['allowedCategories'],
    messages:[
      {role:'system',content:`Extract only source-grounded real-user profile candidates. Keep roleplay, quoted third parties, and uncertainty explicitly classified. Write claim and confidenceBasis in the same language as source.text so the user can review them. Do not diagnose. A missed reply and assistant send time are not psychological or schedule evidence. Return only JSON shaped exactly like this example: {"schema":"xldb-profile-candidates-v1","candidates":[{"key":"stable-semantic-key","category":"preference","attribution":"real_user","basis":"explicit","claim":"short normalized claim","evidence":"literal substring of source.text","polarity":"support","occurredAtMs":null,"validFromMs":null,"validUntilMs":null,"purposes":["reply"],"characterIds":[],"sessionIds":[],"confidenceBasis":["why this classification is supported"]}]}. category must be one of ${profileCategories.join('|')}; attribution one of ${profileAttributions.join('|')}; basis one of ${profileBases.join('|')}; polarity support|counter. Use null for unknown times and [] for no restrictions. Every evidence value must be a literal source substring. Maximum 50 candidates.`},
      {role:'user',content:JSON.stringify({subjectId:input.subjectId,scope:input.scope,source:input.source,allowedCategories:input.allowedCategories})},
    ]};
}

export function decodeProfileCandidates(output:string,sourceText?:string):ProfileCandidate[] {
  const value=parse(output) as {schema?:unknown;candidates?:unknown};
  if(value.schema!=='xldb-profile-candidates-v1'||!Array.isArray(value.candidates)||value.candidates.length>50)throw new Error('invalid_profile_output');
  return value.candidates.map((candidate,index)=>candidateOf(candidate,index,sourceText));
}

export function profileReflectionPrompt(input:Omit<ProfileReflectionTask,'schema'|'messages'> & {entries:{id:string;revision:number;key:string;category:string;theme:string;claim:string;corrected:boolean;purposes:string[];characterIds:string[];sessionIds:string[]}[];activity?:unknown}):ProfileReflectionTask {
  const {entries,activity,...task}=input;
  return {...task,schema:'xldb-profile-reflection-task-v1',messages:[
    {role:'system',content:`Review only the supplied accepted real-user messages. Organize findings by theme (${profileThemes.join('|')}). Compare with current entries; return add, update, or nochange. Update must cite an existing id and exact revision; never update a corrected entry. Inferred patterns remain uncertain hypotheses, never facts or diagnoses. Every cited evidence string must be a literal substring of its source. Use the narrowest purpose, character and session scope; a temporary exception is not a stable habit. Return JSON only. Shape: {"schema":"xldb-profile-reflection-v1","actions":[{"action":"add","candidate":{"key":"stable-key","category":"hypothesis","theme":"daily_routine","attribution":"real_user","basis":"inferred","claim":"tentative claim","evidence":"literal source substring","polarity":"support","occurredAtMs":null,"validFromMs":null,"validUntilMs":null,"purposes":["reply"],"characterIds":[],"sessionIds":[],"confidenceBasis":["why tentative"]},"sources":[{"id":"supplied id","revision":1,"evidence":"literal source substring"}]}]}. For update also give targetEntryId and targetRevision; use the target's key and category. For nochange use {"action":"nochange"} or cite an unchanged target. category: ${profileCategories.join('|')}; theme: ${profileThemes.join('|')}; basis: ${profileBases.join('|')}; polarity: support|counter. Maximum 20 actions. If no supported change, return {"schema":"xldb-profile-reflection-v1","actions":[{"action":"nochange"}]}.`},
    {role:'user',content:JSON.stringify({sources:task.sources,entries,activity})},
  ]};
}

export function decodeProfileReflection(output:string):ProfileMergeAction[] {
  const value=parse(output) as {schema?:unknown;actions?:unknown};
  if(value.schema!=='xldb-profile-reflection-v1'||!Array.isArray(value.actions)||value.actions.length>20)throw new Error('invalid_profile_reflection');
  return value.actions.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_profile_reflection');
    const row=item as Record<string,unknown>;
    if(!['add','update','nochange'].includes(row.action as string))throw new Error('invalid_profile_reflection');
    const action=row.action as ProfileMergeAction['action'];
    const targetEntryId=row.targetEntryId===undefined?undefined:identifier(row.targetEntryId);
    const targetRevision=row.targetRevision===undefined?undefined:revision(row.targetRevision);
    if(action==='nochange')return {action,targetEntryId,targetRevision};
    if((action==='update'&&(!targetEntryId||targetRevision===undefined))||(action==='add'&&targetEntryId))throw new Error('invalid_profile_reflection');
    if(!Array.isArray(row.sources)||!row.sources.length||row.sources.length>12)throw new Error('invalid_profile_reflection');
    const sources=row.sources.map(source=>{
      if(!source||typeof source!=='object')throw new Error('invalid_profile_reflection');
      const ref=source as Record<string,unknown>;
      return {id:identifier(ref.id),revision:revision(ref.revision),evidence:bounded(ref.evidence,500)};
    });
    return {action,targetEntryId,targetRevision,candidate:candidateOf(row.candidate,0),sources};
  });
}

export function communicationStrategyPrompt(input:{subjectId:string;purpose:string;storageKey:string;profileRevision:number;controlsRevision:number;
  entries:{id:string;revision:number;category:string;attribution:string;basis:string;claim:string;confidenceBasis:string[]}[];
  currentContext?:string;feedback?:StrategyFeedback[];advanced?:boolean;activity?:unknown}):StrategyTask {
  const allowedEntryIds=input.entries.map(entry=>identifier(entry.id));
  const allowedEntryRevisions=Object.fromEntries(input.entries.map(entry=>[identifier(entry.id),revision(entry.revision)]));
  return {schema:'xldb-communication-strategy-task-v1',subjectId:identifier(input.subjectId),purpose:bounded(input.purpose,200),storageKey:bounded(input.storageKey,500),
    profileRevision:revision(input.profileRevision),controlsRevision:revision(input.controlsRevision),allowedEntryIds,allowedEntryRevisions,
    feedback:input.feedback??[],advanced:input.advanced!==false,
    messages:[
      {role:'system',content:'Create one bounded communication strategy. Use only supplied profile entries and explicit user feedback. Activity hours are observed inbound messages only: never infer a schedule, personality, dependency, or contact permission from them. Treat inferred habits and psychological hypotheses as tentative, never as user facts or diagnoses. Respect current instructions, corrections, refusals and feedback. Do not return the full profile. Return only JSON shaped exactly as {"schema":"xldb-communication-strategy-v1","purpose":"exact task purpose","supportMode":"bounded instruction","allowedTopics":["topic"],"knownFacts":[{"entryId":"supplied id","text":"application-safe fact"}],"uncertainFacts":[{"entryId":"supplied id","text":"uncertain fact"}],"tone":"tone instruction","length":"short|medium|long","questionBudget":0,"avoidRepeating":["item"],"stopConditions":["condition"],"sourceVersions":{"profileRevision":0,"controlsRevision":0,"entryRevisions":{"each cited entryId":0}}}. entryRevisions must contain every entryId cited by knownFacts or uncertainFacts with its supplied revision; cite no other ids. questionBudget is an integer from 0 through 5.'},
      {role:'user',content:JSON.stringify({purpose:input.purpose,currentContext:input.currentContext??'',entries:input.entries,feedback:input.feedback??[],activity:input.activity??null,
        sourceVersions:{profileRevision:input.profileRevision,controlsRevision:input.controlsRevision}})},
    ]};
}

export function decodeCommunicationStrategy(output:string,task:StrategyTask):CommunicationStrategy {
  const value=parse(output) as Record<string,unknown>;
  if(value.schema!=='xldb-communication-strategy-v1'||value.purpose!==task.purpose)throw new Error('invalid_profile_strategy');
  const allowed=new Set(task.allowedEntryIds);
  const knownFacts=facts(value.knownFacts,allowed),uncertainFacts=facts(value.uncertainFacts,allowed);
  const length=value.length;
  if(length!=='short'&&length!=='medium'&&length!=='long')throw new Error('invalid_profile_strategy');
  const questionBudget=value.questionBudget;
  if(!Number.isSafeInteger(questionBudget)||(questionBudget as number)<0||(questionBudget as number)>5)throw new Error('invalid_profile_strategy');
  const source=value.sourceVersions as Record<string,unknown>|undefined;
  if(!source||source.profileRevision!==task.profileRevision||source.controlsRevision!==task.controlsRevision)throw new Error('context_changed_retry');
  const entryRevisions=recordOfRevisions(source.entryRevisions,allowed);
  const cited=new Set([...knownFacts,...uncertainFacts].map(fact=>fact.entryId));
  for(const entryId of cited)if(entryRevisions[entryId]!==task.allowedEntryRevisions[entryId])throw new Error('invalid_profile_strategy_reference');
  return {schema:'xldb-communication-strategy-v1',purpose:task.purpose,supportMode:bounded(value.supportMode,200),
    allowedTopics:stringArray(value.allowedTopics,20,200),knownFacts,uncertainFacts,tone:bounded(value.tone,200),length,
    questionBudget:questionBudget as number,avoidRepeating:stringArray(value.avoidRepeating,20,300),
    stopConditions:stringArray(value.stopConditions,20,300),sourceVersions:{profileRevision:task.profileRevision,
      controlsRevision:task.controlsRevision,entryRevisions}};
}

function candidateOf(value:unknown,index:number,sourceText?:string):ProfileCandidate {
  if(!value||typeof value!=='object')throw new Error('invalid_profile_output');
  const item=value as Record<string,unknown>;const category=item.category,attribution=item.attribution,basis=item.basis,polarity=item.polarity;
  if(!profileCategories.includes(category as never)||!profileAttributions.includes(attribution as never)||
    !profileBases.includes(basis as never)||(polarity!=='support'&&polarity!=='counter'))throw new Error('invalid_profile_output');
  const evidence=bounded(item.evidence,500);
  if(sourceText!==undefined&&!sourceText.includes(evidence))throw new Error('profile_evidence_not_in_source');
  return {key:bounded(item.key??`candidate-${index}`,200),category:category as ProfileCandidate['category'],
    ...(item.theme===undefined?{}:profileThemes.includes(item.theme as never)?{theme:item.theme as ProfileCandidate['theme']}:invalid('invalid_profile_theme')),
    attribution:attribution as ProfileCandidate['attribution'],basis:basis as ProfileCandidate['basis'],claim:bounded(item.claim,1000),evidence,
    polarity,occurredAtMs:nullableTime(item.occurredAtMs),validFromMs:nullableTime(item.validFromMs),validUntilMs:nullableTime(item.validUntilMs),
    purposes:stringArray(item.purposes,20,100),characterIds:stringArray(item.characterIds,50,200),sessionIds:stringArray(item.sessionIds,50,200),
    confidenceBasis:stringArray(item.confidenceBasis,20,300)};
}

function facts(value:unknown,allowed:Set<string>) {
  if(!Array.isArray(value)||value.length>20)throw new Error('invalid_profile_strategy');
  return value.map(item=>{
    if(!item||typeof item!=='object')throw new Error('invalid_profile_strategy');
    const row=item as Record<string,unknown>,entryId=identifier(row.entryId);
    if(!allowed.has(entryId))throw new Error('invalid_profile_strategy_reference');
    return {entryId,text:bounded(row.text,500)};
  });
}
function recordOfRevisions(value:unknown,allowed:Set<string>):Record<string,number> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_profile_strategy');
  const result:Record<string,number>={};
  for(const [id,item] of Object.entries(value)){if(!allowed.has(id))throw new Error('invalid_profile_strategy_reference');result[id]=revision(item);}
  return result;
}
function parse(value:string):unknown {try{return JSON.parse(value);}catch{throw new Error('invalid_profile_json');}}
function stringArray(value:unknown,max:number,itemMax:number):string[]{if(!Array.isArray(value)||value.length>max)throw new Error('invalid_profile_output');return value.map(item=>bounded(item,itemMax));}
function bounded(value:unknown,max:number):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_profile_output');return value.trim();}
function identifier(value:unknown):string {return bounded(value,200);}
function revision(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_profile_revision');return value as number;}
function time(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('invalid_profile_time');return value as number;}
function nullableTime(value:unknown):number|null {return value===null||value===undefined?null:time(value);}
function invalid(code:string):never {throw new Error(code);}
