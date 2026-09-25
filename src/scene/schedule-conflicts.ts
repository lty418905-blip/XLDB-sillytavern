import {createHash} from 'node:crypto';
import {available as agentJevAvailable} from '../companion/agentjev.ts';
import {emotionRankModelIdentity,evaluateSceneAgentJev} from './emotion-scheduler.ts';

export interface ScheduleSlot {
  /** Internal stable key. It is never sent to AgentJev. */
  key:string;
  date:string;
  startTime:string;
  endTime?:string|null;
  kind:'event'|'course'|'todo'|'commitment';
  authority:'accepted'|'candidate'|'provisional';
  happened?:boolean;
  nature?:ScheduleNature;
  motive?:ScheduleMotive;
}
export type ScheduleNature='care'|'meeting'|'observation'|'travel'|'work'|'conflict'|'other';
export type ScheduleMotive='fear'|'loyalty'|'grief'|'anger'|'duty'|'avoidance'|'other';
export interface ConflictContext {
  scopeKey:string;
  npcId:string;
  affect:{lastReward:number;frustration:Record<string,number>;drives:Record<string,number>};
  /** Numeric observations from unrelated accepted sources; no text, source ids, or requester labels. */
  recent:{count:number;lastAgeMinutes:number|null;themes?:ScheduleNature[]};
}
export interface ConflictDecision {decline:'existing'|'proposed'|'undecided';method:'agentjev'|'director'|'deterministic';reason?:string;
  modelIdentity?:string}
export type BlindConflictChoice='A'|'B'|'neither';
export interface BlindConflictReview {state:string;agentJevChoice:BlindConflictChoice;
  distribution:Record<BlindConflictChoice,number>|null}
export type ReviewScheduleConflict=(input:BlindConflictReview)=>Promise<BlindConflictChoice>;
// AgentJev choice scores are uncalibrated. These are routing thresholds, not accuracy claims.
const decisiveTop=0.7,decisiveMargin=0.2;
const driveNames=['connection','novelty','expression','safety','play'] as const;
const natureNames=new Set<ScheduleNature>(['care','meeting','observation','travel','work','conflict','other']);

/** Exact point/interval overlap. Date-only entries and unknown times are not assumed busy. */
export function overlaps(proposed:ScheduleSlot,existing:ScheduleSlot):boolean {
  if(proposed.date!==existing.date)return false;
  const proposedEnd=proposed.endTime??proposed.startTime;
  const existingEnd=existing.endTime??existing.startTime;
  if(proposedEnd===proposed.startTime&&existingEnd===existing.startTime)return proposed.startTime===existing.startTime;
  if(proposedEnd===proposed.startTime)return existing.startTime<=proposed.startTime&&proposed.startTime<existingEnd;
  if(existingEnd===existing.startTime)return proposed.startTime<=existing.startTime&&existing.startTime<proposedEnd;
  return proposed.startTime<existingEnd&&existing.startTime<proposedEnd;
}

/** Blind symmetric A/B recommendation. The caller keeps accepted history authoritative. */
export async function chooseScheduleConflict(existing:ScheduleSlot,proposed:ScheduleSlot,context:ConflictContext,
  evaluate?:((payload:unknown)=>Promise<unknown>),reviewLowConfidence?:ReviewScheduleConflict):Promise<ConflictDecision> {
  if(!overlaps(proposed,existing))return {decline:'undecided',method:'deterministic',reason:'no_exact_overlap'};
  if(JSON.stringify(blindSlot(existing))===JSON.stringify(blindSlot(proposed)))
    return {decline:'undecided',method:'deterministic',reason:'indistinguishable_schedule_evidence'};
  const evidenced=evidencePriority(existing,proposed,context);
  if(evidenced)return {decline:evidenced,method:'deterministic',reason:'visible_schedule_evidence'};
  const fallback=(reason:string):ConflictDecision=>({decline:'undecided',method:'deterministic',reason});
  if(!evaluate&&!agentJevAvailable())return fallback('agentjev_unavailable');
  try{
    const ordered=stableOrder(existing,proposed,context.scopeKey,context.npcId);
    const [a,b]=ordered;
    const state=JSON.stringify({
      A:blindSlot(a),B:blindSlot(b),
      affect:blindAffect(context.affect),recent:blindRecent(context.recent),
    });
    const response=await (evaluate??evaluateSceneAgentJev)({requests:[{
      id:'conflict',state,questions:[{id:'decline',type:'choice',
        question:'同一 NPC 的两件未来安排撞期。匿名比较 kind（commitment 是履约事项）、nature、motive、当前情绪与近期主题：若一边有具体且更强的行为动机，建议放弃另一边；两边相近、理由冲突或证据不足时选 neither。不要推断哪边是用户请求。建议只供导演规划；反悔须在后续剧情产生反应，不能改写承诺或已接受历史。',
        options:{A:'放弃 A，保留 B',B:'放弃 B，保留 A',neither:'无法据此区分，暂不取舍'}}],
    }]}) as {results?:Array<{id:string;answers?:Array<{value?:unknown;distribution?:unknown}>}>};
    if(response.results?.length!==1||response.results[0]?.id!=='conflict')throw new Error('agentjev_invalid_schedule_choice');
    const answer=response.results[0].answers?.[0],choice=answer?.value;
    if(choice!=='A'&&choice!=='B'&&choice!=='neither')throw new Error('agentjev_invalid_schedule_choice');
    const distribution=choiceDistribution(answer?.distribution);
    const scores=distribution?[...Object.values(distribution)].sort((left,right)=>right-left):null;
    const decisive=choice!=='neither'&&scores!==null&&distribution!==null&&distribution[choice]>=decisiveTop&&
      Math.abs(distribution[choice]-scores[0])<=1e-4&&scores[0]-scores[1]>=decisiveMargin;
    const decline=(selected:BlindConflictChoice)=>selected==='neither'?'undecided':
      ordered[selected==='A'?0:1]===existing?'existing':'proposed';
    const modelIdentity=!evaluate?{modelIdentity:emotionRankModelIdentity()}:{};
    if(decisive)return {decline:decline(choice),method:'agentjev',...modelIdentity};
    if(!reviewLowConfidence)return {decline:'undecided',method:'agentjev',
      reason:distribution?'agentjev_uncertain_choice':'agentjev_missing_confidence',...modelIdentity};
    try{
      const reviewed=await reviewLowConfidence({state,agentJevChoice:choice,distribution});
      if(reviewed!=='A'&&reviewed!=='B'&&reviewed!=='neither')throw new Error('invalid_director_conflict_review');
      return {decline:decline(reviewed),method:'director',reason:'agentjev_uncertain_choice',...modelIdentity};
    }catch{return {decline:'undecided',method:'director',reason:'director_conflict_review_failed',...modelIdentity};}
  }catch(error){return fallback(error instanceof Error?error.message:'agentjev_schedule_failed');}
}

function choiceDistribution(value:unknown):Record<BlindConflictChoice,number>|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const scores=value as Record<string,unknown>;
  if(Object.keys(scores).length!==3||!['A','B','neither'].every(key=>typeof scores[key]==='number'&&
    Number.isFinite(scores[key])&&scores[key]>=0&&scores[key]<=1))return null;
  const distribution={A:scores.A as number,B:scores.B as number,neither:scores.neither as number};
  return Math.abs(distribution.A+distribution.B+distribution.neither-1)<=1e-4?distribution:null;
}

function stableOrder(a:ScheduleSlot,b:ScheduleSlot,scopeKey:string,npcId:string):[ScheduleSlot,ScheduleSlot] {
  const pair=[a,b].sort((left,right)=>left.key.localeCompare(right.key)||
    JSON.stringify(blindSlot(left)).localeCompare(JSON.stringify(blindSlot(right))));
  const bit=createHash('sha256').update(JSON.stringify([scopeKey,npcId,pair.map(slot=>slot.key)])).digest()[0]&1;
  return bit?[pair[1],pair[0]]:[pair[0],pair[1]];
}

function blindSlot(slot:ScheduleSlot){
  return {date:slot.date,startTime:slot.startTime,endTime:slot.endTime??null,
    kind:slot.kind,nature:slot.nature??'other',motive:slot.motive??'other'};
}

function blindAffect(affect:ConflictContext['affect']){
  const bounded=(value:number,min:number,max:number)=>Number.isFinite(value)?
    Math.round(Math.min(max,Math.max(min,value))*100)/100:0;
  const frustration:Record<string,number>={},drives:Record<string,number>={};
  for(const name of driveNames){
    const frustrationValue=affect.frustration[name];
    if(Number.isFinite(frustrationValue)&&frustrationValue>=0.5)
      frustration[name]=bounded(frustrationValue,0,5);
    const driveValue=affect.drives[name];
    if(Number.isFinite(driveValue)&&Math.abs(driveValue-0.5)>=0.15)
      drives[name]=bounded(driveValue,0,1);
  }
  return {lastReward:bounded(affect.lastReward,-1,1),frustration,drives};
}

function blindRecent(recent:ConflictContext['recent']){
  return {count:Number.isFinite(recent.count)?Math.min(6,Math.max(0,Math.floor(recent.count))):0,
    lastAgeMinutes:recent.lastAgeMinutes===null||!Number.isFinite(recent.lastAgeMinutes)?null:
      Math.max(0,Math.floor(recent.lastAgeMinutes)),
    themes:[...new Set((recent.themes??[]).filter(theme=>natureNames.has(theme)&&theme!=='other'))].slice(0,4)};
}

/** Only settled, source-independent comparisons; disputed motives stay with the model or undecided. */
function evidencePriority(existing:ScheduleSlot,proposed:ScheduleSlot,context:ConflictContext):ConflictDecision['decline']|null {
  const slots=[existing,proposed];
  const care=slots.map(slot=>slot.nature==='care'&&slot.motive==='fear'&&
    (context.affect.frustration.safety??0)>=3&&(context.affect.drives.safety??0)>=0.75&&
    (context.recent.themes??[]).includes('care'));
  const promise=slots.map(slot=>slot.kind==='commitment'&&slot.motive==='duty');
  if(care[0]!==care[1]&&promise[0]!==promise[1]&&care[0]!==promise[0])return 'undecided';
  if(care[0]!==care[1]&&!promise.some(Boolean)){
    const ordinary=care[0]?proposed:existing;
    if(ordinary.kind==='todo'&&ordinary.motive==='other'&&
      ['observation','travel','work','other'].includes(ordinary.nature??'other'))
      return care[0]?'proposed':'existing';
  }
  if(promise[0]!==promise[1]&&!care.some(Boolean)){
    const ordinary=promise[0]?proposed:existing;
    if(ordinary.kind==='todo'&&ordinary.motive==='other'&&
      ['observation','travel','work','other'].includes(ordinary.nature??'other'))
      return promise[0]?'proposed':'existing';
  }
  const unrelated=(context.recent.themes??[]).every(theme=>theme!==existing.nature&&theme!==proposed.nature);
  if(existing.kind==='todo'&&proposed.kind==='todo'&&existing.motive==='other'&&proposed.motive==='other'&&
    unrelated&&Object.values(context.affect.frustration).every(value=>value<3))return 'undecided';
  return null;
}

/** Closed vocabulary only: no raw names, requester labels, source text or ids reach the ranker. */
export function neutralScheduleNature(text:string):ScheduleNature {
  if(/照顾|照料|探病|救助|看护|care|rescue/iu.test(text))return 'care';
  if(/见面|会面|赴约|约定|约会|拜访|meet|visit/iu.test(text))return 'meeting';
  if(/观察|查看|看见|调查|搜寻|监视|watch|investigat/iu.test(text))return 'observation';
  if(/出发|赶往|旅行|乘车|去往|travel|depart/iu.test(text))return 'travel';
  if(/工作|值班|上课|课程|训练|work|class|train/iu.test(text))return 'work';
  if(/争吵|决斗|对抗|冲突|fight|argue/iu.test(text))return 'conflict';
  return 'other';
}
export function neutralScheduleMotive(text:string):ScheduleMotive {
  if(/害怕|恐惧|担忧|畏惧|fear|afraid/iu.test(text))return 'fear';
  if(/忠诚|守护|保护|不愿辜负|loyal|protect/iu.test(text))return 'loyalty';
  if(/悲伤|哀悼|失去|grief|mourn/iu.test(text))return 'grief';
  if(/愤怒|生气|报复|anger|revenge/iu.test(text))return 'anger';
  if(/责任|职责|必须履行|duty|obligation/iu.test(text))return 'duty';
  if(/回避|逃避|拒绝|不想面对|avoid|decline/iu.test(text))return 'avoidance';
  return 'other';
}
