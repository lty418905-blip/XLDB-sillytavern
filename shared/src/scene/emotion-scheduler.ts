import {foldForMatch} from '../common/script-fold.ts';
import {AgentJevClient,DEFAULT_BACKOFF_MS,agentJevIdentityOffLoop,available as agentJevAvailable} from '../agentjev/client.ts';
import type {AgentJevClientOptions} from '../agentjev/client.ts';
import type {SceneState} from './types.ts';

export const EMOTION_NPC_BUDGET=4;

export interface EmotionRankCandidate {
  id:string;
  name:string;
  evidenceQuotes:string[];
  omittedEvidenceCount:number;
  currentEmotion:string;
  currentTarget:boolean;
  present:boolean;
  deferredEvents:number;
}

export interface EmotionRanking {
  orderedIds:string[];
  method:'agentjev'|'agentjev_guarded'|'deterministic';
  reason?:string;
  modelIdentity?:string;
}

type RankEvaluation=(payload:unknown)=>ReturnType<AgentJevClient['evaluate']>;

/**
 * Longest foreground wait for one AgentJev ranking. Past it the turn takes the deterministic order with reason
 * agentjev_warming, while the worker keeps loading (or the request keeps running) for later turns.
 */
export const EMOTION_RANK_FOREGROUND_MS=5_000;

export interface EmotionRankerStatus {
  status:'available'|'warming'|'degraded';
  /** Why the ranker is warming or degraded; degraded turns use the deterministic order. */
  reason?:string;
  modelIdentity?:string;
  retryAtMs?:number;
}

type RankerLocation=Pick<AgentJevClientOptions,'root'|'executable'|'modelDir'|'runner'>;
let location:RankerLocation={};
let now:()=>number=Date.now;
let client:AgentJevClient|undefined;
let clientIdentity:string|undefined;
/**
 * Model identity hashed off the event loop; the worker process itself starts only with the first ranking. A failed
 * warm-up is retried after DEFAULT_BACKOFF_MS, so the ranker recovers within a session once the model is usable.
 */
type Warmup={status:'warming';abort:AbortController}|{status:'failed';error:string;retryAtMs:number};
let warmup:Warmup|undefined;
let warmupFailures=0;
/** Bumped only by closeEmotionRanker(); results of a warm-up or ranking from before a close are discarded. */
let generation=0;
/** Rankings that outlived their foreground budget and still run against the starting worker. */
let lateRankings=0;

export function closeEmotionRanker():void {
  generation++;if(warmup?.status==='warming')warmup.abort.abort();warmup=undefined;warmupFailures=0;lateRankings=0;
  client?.close();client=undefined;clientIdentity=undefined;
}

/** Point the ranker at another AgentJev install and clock (tests and fixtures). Closes the current ranker first. */
export function configureEmotionRanker(options:RankerLocation&{now?:()=>number}={}):void {
  closeEmotionRanker();
  const {now:clock,...paths}=options;location=paths;now=clock??Date.now;
}

function startWarmup():void {
  if(warmup&&(warmup.status==='warming'||now()<warmup.retryAtMs))return;
  const current=generation,abort=new AbortController();
  warmup={status:'warming',abort};
  const failed=(error:unknown)=>{
    if(current!==generation)return;
    const step=DEFAULT_BACKOFF_MS[Math.min(warmupFailures,DEFAULT_BACKOFF_MS.length-1)];warmupFailures++;
    // Only our own codes reach the status; a raw file-system message could carry local paths.
    const code=error instanceof Error&&/^agentjev_[a-z_]+$/.test(error.message)?error.message:'agentjev_identity_failed';
    warmup={status:'failed',error:code,retryAtMs:now()+step};
  };
  agentJevIdentityOffLoop(location,abort.signal).then(identity=>{
    if(current!==generation)return;
    // The identity computed off the loop is handed over, so this thread never reads or hashes the model. There is no
    // synchronous fallback: a worker that could not produce it leaves the ranker degraded until the next retry.
    try{client=new AgentJevClient({...location,identity});}catch(error){failed(error);return;}
    clientIdentity=identity;warmup=undefined;warmupFailures=0;
  },failed);
}

/**
 * Stage fingerprint for AgentJev rankings. It never hashes on the caller's thread: until the off-loop identity is
 * ready it is 'agentjev_warming' and rankings are deterministic; after a failed warm-up it is 'agentjev_unavailable'
 * until the retry is due.
 */
export function emotionRankModelIdentity():string {
  if(!agentJevAvailable(location))return 'agentjev_unavailable';
  if(client&&clientIdentity)return clientIdentity;
  startWarmup();
  return warmup?.status==='failed'?'agentjev_unavailable':'agentjev_warming';
}

function readyClient():AgentJevClient {
  const identity=emotionRankModelIdentity();
  if(!client||identity!==clientIdentity)throw new Error(identity==='agentjev_warming'?'agentjev_warming':'agentjev_unavailable');
  return client;
}

/** Read-only ranker state for diagnostics and the Tavern badge. It never starts a worker or a hash. */
export function emotionRankerStatus():EmotionRankerStatus {
  if(!agentJevAvailable(location))return {status:'degraded',reason:'agentjev_unavailable'};
  if(warmup?.status==='failed')return {status:'degraded',reason:warmup.error,retryAtMs:warmup.retryAtMs};
  if(warmup)return {status:'warming',reason:'agentjev_warming'};
  if(!client)return {status:'available'};
  const availability=client.availability(),modelIdentity=clientIdentity?{modelIdentity:clientIdentity}:{};
  if(availability.status==='backoff')return {status:'degraded',reason:availability.lastError??'agentjev_backoff',
    ...(availability.retryAtMs===undefined?{}:{retryAtMs:availability.retryAtMs}),...modelIdentity};
  if(availability.status!=='available')return {status:'degraded',reason:`agentjev_${availability.status}`,...modelIdentity};
  if(lateRankings)return {status:'warming',reason:'agentjev_warming',...modelIdentity};
  return {status:'available',...modelIdentity};
}

/** Shared Tavern judge process for emotion ranking and anonymous schedule choices. */
export async function evaluateSceneAgentJev(payload:unknown) {
  return readyClient().evaluate(payload);
}

/**
 * Deterministic order used whenever AgentJev is not installed, still warming, over budget or failing: current
 * first-person impact band first, then deterministicScore, a weighted score led by visible emotion words plus the
 * deferred backlog, being addressed, unmet drive, being mentioned and presence, nudged by evidence length (at most 1
 * point) and finally ordered by id. The caller keeps the same top-N
 * budget; the rest stay pending for the background queue.
 */
export function deterministicEmotionRanking(candidates:readonly EmotionRankCandidate[],reason:string):EmotionRanking {
  return {orderedIds:[...candidates].sort((a,b)=>
    currentImpactBand(b)-currentImpactBand(a)||deterministicScore(b)-deterministicScore(a)||
    a.id.localeCompare(b.id)).map(item=>item.id),method:'deterministic',reason};
}

/** Rank only authorized character-visible evidence. No companion profile is sent to AgentJev. */
export async function rankEmotionCandidates(candidates:readonly EmotionRankCandidate[],
  evaluate?:RankEvaluation,options:{foregroundMs?:number}={}):Promise<EmotionRanking> {
  const fallback=(reason:string)=>deterministicEmotionRanking(candidates,reason);
  if(!evaluate&&!agentJevAvailable(location))return fallback('agentjev_unavailable');
  // A late ranking still occupies the single worker; queueing another behind it would only time out again.
  if(!evaluate&&lateRankings)return fallback('agentjev_warming');
  let judge:RankEvaluation,modelIdentity:string;
  try{
    if(evaluate){judge=evaluate;modelIdentity='injected';}
    else{const ranker=readyClient();judge=payload=>ranker.evaluate(payload);modelIdentity=clientIdentity!;}
  }catch(error){return fallback(error instanceof Error?error.message:'agentjev_unavailable');}
  const scoring=scoreCandidates(candidates,judge);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const budget=new Promise<'over_budget'>(resolve=>{
    timer=setTimeout(()=>resolve('over_budget'),options.foregroundMs??EMOTION_RANK_FOREGROUND_MS);timer.unref?.();
  });
  try {
    const scores=await Promise.race([scoring,budget]);
    if(scores==='over_budget'){
      // The worker keeps loading; this late result is discarded and a later turn ranks again.
      const settled=scoring.then(()=>undefined,()=>undefined);
      if(!evaluate){
        const current=generation;lateRankings++;
        void settled.then(()=>{if(current===generation)lateRankings=Math.max(0,lateRankings-1);});
      }
      return fallback('agentjev_warming');
    }
    // The local model is not calibrated for this scene domain. Only a bounded,
    // current first-person event signal may overrule its raw rank. This keeps
    // negated, quoted, historical and other-person affect out of the guard.
    const bands=new Map(candidates.map(item=>[item.id,currentImpactBand(item)]));
    const guarded=new Set(bands.values()).size>1;
    return {orderedIds:[...candidates].sort((a,b)=>(bands.get(b.id)??0)-(bands.get(a.id)??0)||
      (scores.get(b.id)??0)-(scores.get(a.id)??0)||
      deterministicScore(b)-deterministicScore(a)||a.id.localeCompare(b.id)).map(item=>item.id),
      method:guarded?'agentjev_guarded':'agentjev',
      ...(guarded?{reason:'current_visible_impact_priority'}:{}),modelIdentity};
  } catch(error) {
    return fallback(error instanceof Error?error.message:'agentjev_rank_failed');
  } finally {clearTimeout(timer);}
}

async function scoreCandidates(candidates:readonly EmotionRankCandidate[],judge:RankEvaluation):Promise<Map<string,number>> {
  const scores=new Map<string,number>();
  for(let offset=0;offset<candidates.length;offset+=32){
    const group=candidates.slice(offset,offset+32);
    const reply=await judge({requests:group.map(item=>({
      id:item.id,
      state:JSON.stringify({name:item.name,evidenceQuotes:[...new Set(item.evidenceQuotes)],
        omittedEvidenceCount:item.omittedEvidenceCount,currentEmotion:compactCurrentEmotion(item.currentEmotion),
        deferredEvents:item.deferredEvents,currentTarget:item.currentTarget,present:item.present}),
      questions:[{id:'change',type:'choice',question:'结合当前情绪，估计此 NPC 对可见待学习经历的 OpenHer 情绪变化幅度。排除否定、引文、平静旧事及他人情绪；考虑无情绪词的强烈身体反应。',
        options:{none:'几乎没有',small:'较小',medium:'中等',large:'明显'}}],
    }))});
    const expected=new Set(group.map(item=>item.id));
    for(const result of reply.results){
      if(!expected.delete(result.id))throw new Error('agentjev_invalid_emotion_rank');
      const distribution=result.answers[0]?.distribution;
      if(!distribution)throw new Error('agentjev_invalid_emotion_rank');
      const values=['none','small','medium','large'].map(key=>distribution[key]);
      if(values.some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)||
        Math.abs(values.reduce((sum,value)=>sum+value,0)-1)>0.02)throw new Error('agentjev_invalid_emotion_rank');
      scores.set(result.id,(distribution.small??0)+2*(distribution.medium??0)+3*(distribution.large??0));
    }
    if(expected.size)throw new Error('agentjev_invalid_emotion_rank');
  }
  if(scores.size!==candidates.length)throw new Error('agentjev_invalid_emotion_rank');
  return scores;
}

function compactCurrentEmotion(serialized:string):unknown {
  try {
    const value=JSON.parse(serialized);
    if(!value||typeof value!=='object'||Array.isArray(value))return serialized;
    const current=value as Record<string,unknown>;
    return Object.fromEntries(['frustration','drives','criticContext','criticContextBasis',
      'behavioralSignals','stableRelations','lastReward'].filter(key=>key in current).map(key=>[key,current[key]]));
  } catch {return serialized;}
}

function currentImpactBand(item:EmotionRankCandidate):number {
  // This is a conservative salience gate, not an emotion diagnosis. The source
  // quotations are already scoped to this NPC by the scene service.
  let band=0;
  const name=foldForMatch(item.name);
  for(const original of item.evidenceQuotes){
    // Fixed scans of a matching copy: O(n); the ranker never rewrites stored evidence.
    const source=foldForMatch(original);
    const outsideQuotes=source.replace(/[“‘「『]([^”’」』]*)[”’」』]/gu,(_whole,spoken:string,offset:number)=>{
      const lead=source.slice(Math.max(0,offset-16),offset);
      return /(?:说|喊|表示|回答|承认|坦白|叫道|喊道)\s*[:：]?$/u.test(lead)?spoken:'';
    });
    for(const raw of outsideQuotes.split(/[，,。；;！？!?\n]/u)){
      let clause=raw.trim();
      if(!clause||/^(?:回忆|想起|记得)|(?:十年前|多年前|当年|以前|过去|曾经)/u.test(clause)&&
        !/(?:此刻|现在|如今|再次|重新|刚刚|刚|这时)/u.test(clause))continue;
      if(/(?:档案|书中|报道)/u.test(clause)&&!/(?:自己|本人|此刻|现在)/u.test(clause))continue;
      const other=/(?:别人|另一个人|旁人|其他人|他人|隔壁有人)/u.exec(clause);
      if(other){
        const after=clause.slice(other.index+other[0].length);
        const own=[after.indexOf('自己'),after.indexOf('本人'),after.indexOf(name)]
          .filter(index=>index>=0).sort((a,b)=>a-b)[0];
        if(own===undefined)continue;
        clause=after.slice(own);
      }
      const positive=clause
        .replace(/(?:没有|并未|未曾|不再|不|没|无)(?:再)?(?:感到|觉得|会)?(?:受伤|害怕|恐惧|愤怒|悲伤|痛哭|哭泣|惊恐|绝望|发抖|颤抖|流泪|掉泪|掉眼泪|僵住|僵在原地)/gu,'')
        .replace(/(?:双手|手|身体|身子|浑身|全身)(?:已经)?(?:没有|不再|不|没)(?:再)?抖/gu,'');
      if(/(?:失声痛哭|痛哭|惊恐|恐惧|害怕|绝望|愤怒|背叛|去世|死亡|死了|失踪|遇险|重逢|失而复得|心碎|panic|terrified|betray|crying|grief|reunited)/iu.test(positive))band=Math.max(band,3);
      else if(/(?:发抖|颤抖|(?:双手|手|身体|身子|浑身|全身)(?:还|一直|不停|止不住)?抖|僵(?:住|在原地)|眼泪(?:止不住地)?(?:掉|流|落)|(?:泪水|泪珠)(?:掉|流|落)|手心(?:全|都)?是汗|嘴唇发白|脸色发白|喘不过气|发不出声音|说不出话|站不住|脚下一软|眼眶发红|哭了|哭泣|摔下|冲上去拥抱|握紧拳头|反[复覆]确认|紧紧抓住)/u.test(positive))band=Math.max(band,2);
      else if(/(?:道歉|失落|担心|不安|惊讶|笑了|点了点头|怀疑|期待已久|质问)/u.test(positive))band=Math.max(band,1);
    }
  }
  return band;
}

function deterministicScore(item:EmotionRankCandidate):number {
  // Stable fallback priority; this is an operational estimate, not measured emotion quality.
  const evidence=foldForMatch(item.evidenceQuotes.join('\n'));
  const signal=(evidence.match(/!|！|哭|怒|怕|爱|恨|担心|害怕|惊|救|死|伤|失去|拥抱|争吵|道歉|高兴|悲伤/gu)??[]).length;
  const mentioned=item.name.trim()!==''&&evidence.includes(foldForMatch(item.name));
  return Math.min(signal,12)*10+Math.min(item.deferredEvents,8)*4+
    (item.currentTarget?6:0)+(mentioned?4:0)+(item.present?2:0)+unmetDrive(item.currentEmotion)*2+Math.min(evidence.length,500)/500;
}

/** Largest OpenHer frustration (unmet drive, 0..5) in the NPC's current emotion summary; 0 when unreadable. */
function unmetDrive(serialized:string):number {
  try {
    const frustration=(JSON.parse(serialized) as {frustration?:Record<string,unknown>})?.frustration;
    if(!frustration||typeof frustration!=='object')return 0;
    const values=Object.values(frustration).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));
    return Math.min(5,Math.max(0,...values));
  } catch {return 0;}
}

/** Read-only queue diagnostics. It exposes identifiers and counts, never another NPC's evidence. */
export function emotionScheduleStatus(state:SceneState) {
  const windows=new Map<string,{eligible:Set<string>;selected:Set<string>;forced:Set<string>;method:string;reason?:string;modelIdentity?:string}>();
  const pending=new Map<string,number>();
  const legacyPending=new Map<string,number>();
  for(const source of state.sources){
    if(source.status!=='accepted'||source.processing!=='ready'||!source.analysis)continue;
    for(const id of source.analysis.emotionPendingIds??[]){
      pending.set(id,(pending.get(id)??0)+1);
      if(!source.analysis.emotionCandidateReadyIds?.includes(id)&&
        !source.analysis.skippedStages?.some(item=>item.stage==='emotion'&&item.characterId===id))
        legacyPending.set(id,(legacyPending.get(id)??0)+1);
    }
    const schedule=source.analysis.emotionSchedule;
    if(!schedule)continue;
    const window=windows.get(schedule.windowId)??{eligible:new Set<string>(),selected:new Set<string>(),forced:new Set<string>(),method:schedule.method};
    for(const id of schedule.eligibleIds)window.eligible.add(id);
    for(const id of schedule.selectedIds)window.selected.add(id);
    for(const id of schedule.forcedIds)window.forced.add(id);
    window.method=schedule.method;window.reason=schedule.reason;window.modelIdentity=schedule.modelIdentity;
    windows.set(schedule.windowId,window);
  }
  const ordered=[...windows.entries()];
  return {budget:EMOTION_NPC_BUDGET,forceAfterMissedRounds:0,pendingTotal:[...pending.values()].reduce((a,b)=>a+b,0),
    latestRanking:ordered.length?{windowId:ordered.at(-1)![0],method:ordered.at(-1)![1].method,
      reason:ordered.at(-1)![1].reason??null,modelIdentity:ordered.at(-1)![1].modelIdentity??null}:null,
    npcs:state.roster.characters.map(character=>{
      let missedRounds=0,lastSelected:string|null=null,forced=false;
      for(const [windowId,window] of ordered)if(window.selected.has(character.id)){
        lastSelected=windowId;forced=window.forced.has(character.id);
      }
      for(const [,window] of [...ordered].reverse()){
        if(!window.eligible.has(character.id)||window.selected.has(character.id))break;
        missedRounds++;
      }
      return {id:character.id,pendingCount:pending.get(character.id)??0,
        legacyPendingCount:legacyPending.get(character.id)??0,missedRounds,lastSelected,forced};
    })};
}
