import {emotionSummary,type EmotionState,type BehaviorSignalName,BEHAVIOR_SIGNAL_NAMES} from './openher.ts';
import type {Scope,MemoryView} from '../memory/access.ts';
import type {ContactAffect} from './contact-affect.ts';

export interface EmotionExpressionInput {
  scope:Scope;
  actorId:string;
  addresseeId:string;
  sourceVersion:number;
  nowMs:number;
  timeZone:string|null;
  clockKind?:'realtime'|'story';
  clockTimeMs?:number|null;
  hideStoryTime?:boolean;
  relationBasis?:'current_directional_projection'|'core_state_unspecified_target';
  emotion:EmotionState;
  /** Only the final, permission and retention filtered MemoryViews for this actor. */
  memories:readonly MemoryView[];
  waiting?:ContactAffect|null;
  address?:string;
}

export interface EmotionExpression {
  schema:'xldb-emotion-expression-v1';
  scope:Scope;
  actorId:string;
  addresseeId:string;
  sourceVersion:number;
  clock:{readAtMs:number|null;kind:'realtime'|'story';timeMs:number|null;timeZone:string|null};
  observation:{atMs:number|null;basis:'unobserved'|'recent_observation'|'stale_baseline'};
  signals:{values:EmotionState['behavioralSignals'];basis:'current_openher_projection'};
  trend?:{basis:'accepted_pre_thermal';fromInteraction:number;toInteraction:number;
    deltas:Record<BehaviorSignalName,number>};
  drives:EmotionState['drives'];
  frustration:EmotionState['frustration'];
  relation:{values:EmotionState['stableRelations'];basis:'current_directional_projection'|'core_state_unspecified_target'};
  causes:{memoryId:string;sourceId:string;revision:number;feeling:string;basis:'explicit'|'inferred'}[];
  waiting:{phase:'waiting'|'returning';absence:ContactAffect['absence'];elapsedMs:number;
    feelings:ContactAffect['feelings'];needsClarification:boolean;hasCurrentExplanation:boolean;
    sourceRefs:{outgoingIds:string[];reply:{sourceId:string;revision:number}|null;
      explanationSources:{sourceId:string;revision:number}[]}}|null;
  address:string;
}

/** Pure presentation of one actor's already authorized state at one source version. */
export function buildEmotionExpression(input:EmotionExpressionInput):EmotionExpression {
  if(!input.actorId.trim()||!input.addresseeId.trim())throw new Error('invalid_emotion_expression_actor');
  const summary=emotionSummary(input.emotion);
  // Persisted history holds pre-thermal outputs from accepted neural steps only.
  // It is never compared with the current, thermally projected display signals.
  const history=input.emotion.neural.signalHistory;
  const trend=history.length>=2&&input.emotion.neural.interactionCount>=2?{
    basis:'accepted_pre_thermal' as const,fromInteraction:input.emotion.neural.interactionCount-1,
    toInteraction:input.emotion.neural.interactionCount,
    deltas:Object.fromEntries(BEHAVIOR_SIGNAL_NAMES.map(key=>
      [key,history.at(-1)![key]-history.at(-2)![key]])) as Record<BehaviorSignalName,number>,
  }:undefined;
  const causes=input.memories.filter(memory=>memory.kind==='episode'&&memory.access==='clear'&&
    !memory.source.reference&&memory.episode?.appraisal?.trim()).slice(0,3).map(memory=>({
      memoryId:memory.id,sourceId:memory.source.messageId,revision:memory.source.revision,
      feeling:memory.episode!.appraisal,basis:memory.episode!.feelingBasis,
    }));
  const waiting=input.waiting?.phase!=='none'&&input.waiting?.episode?{
    phase:input.waiting.phase,absence:input.waiting.absence,elapsedMs:input.waiting.episode.elapsedMs,
    feelings:{...input.waiting.feelings},needsClarification:Boolean(input.waiting.needsClarification),
    hasCurrentExplanation:Boolean(input.waiting.currentExplanation),
    sourceRefs:{outgoingIds:[...input.waiting.sourceRefs.outgoingIds],
      reply:input.waiting.sourceRefs.reply?{...input.waiting.sourceRefs.reply}:null,
      explanationSources:input.waiting.sourceRefs.explanationSources.map(({sourceId,revision})=>({sourceId,revision}))},
  }:null;
  return {schema:'xldb-emotion-expression-v1',scope:{...input.scope},actorId:input.actorId,addresseeId:input.addresseeId,
    sourceVersion:input.sourceVersion,clock:{readAtMs:input.clockKind==='story'?null:input.nowMs,kind:input.clockKind??'realtime',
      timeMs:input.clockKind==='story'?(input.hideStoryTime?null:input.clockTimeMs??null):input.nowMs,timeZone:input.timeZone},
    observation:{atMs:input.clockKind==='story'&&input.hideStoryTime?null:summary.criticContextAtMs,
      basis:summary.criticContextBasis as EmotionExpression['observation']['basis']},
    signals:{values:{...input.emotion.behavioralSignals},basis:'current_openher_projection'},
    ...(trend?{trend}:{}),
    drives:{...input.emotion.drives},frustration:{...input.emotion.frustration},
    relation:{values:{...input.emotion.stableRelations},basis:input.relationBasis??'core_state_unspecified_target'},
    causes,waiting,address:input.address??''};
}

const signalMeaning:Record<BehaviorSignalName,string>={
  directness:'低值更委婉，高值更直白；直接不等于刻薄',
  vulnerability:'低值少袒露，高值更愿袒露；不等于信任所有人',
  playfulness:'低值较克制，高值更爱玩笑；低值不等于悲伤',
  initiative:'低值较被动，高值更想主动；不授予发送许可',
  depth:'低值轻谈，高值深入；不等于关系升级',
  warmth:'低值少外显，高值更温暖；不等于爱意存在或消失',
  defiance:'低值较退让，高值更坚持立场；不等于敌意',
  curiosity:'低值少探询，高值更好奇；不授予私密信息权限',
};

export function renderEmotionExpression(value:EmotionExpression):string {
  const line=(name:string,values:object)=>
    `${name}: ${Object.entries(values).map(([key,n])=>`${key}=${Number(n).toFixed(3)}`).join(', ')}`;
  const observation=value.observation.basis==='unobserved'?'尚无已接受 Critic 观测；情境使用计算基线，其他状态仍可随时间投影':
    value.observation.basis==='stale_baseline'?'旧 Critic 观测已过期，情境使用中性计算基线；不代表用户已经恢复，长期状态仍保留':
    '最近已接受 Critic 观测；当前信号还包含时间投影';
  return [
    '[XLDB current emotion]',
    `schema=${value.schema}`,
    `actor=${JSON.stringify(value.actorId)}; addressee=${JSON.stringify(value.addresseeId)}; sourceVersion=${value.sourceVersion}; readAtMs=${value.clock.readAtMs}; clock=${value.clock.kind}; clockTimeMs=${value.clock.timeMs===null?'unknown':value.clock.timeMs}; timeZone=${JSON.stringify(value.clock.timeZone)}`,
    `observation: ${observation}; atMs=${value.observation.atMs===null?'unknown':value.observation.atMs}`,
    line('drives',value.drives),line('frustration',value.frustration),
    line('signals',value.signals.values),
    'signals 是 OpenHer 当前输出，0–1 为表达倾向刻度，不是事实、许可或明确台词；按人设自然表达。'+BEHAVIOR_SIGNAL_NAMES.map(key=>`${key}: ${signalMeaning[key]}`).join('；'),
    value.trend?'最近两个已接受学习事件的同层神经输出变化（热噪声前；不与当前显示信号直接相减，也不证明单一原因）：'+JSON.stringify(value.trend):'',
    line('stableRelations',value.relation.values),
    value.relation.basis==='current_directional_projection'?'stableRelations 是当前对象的方向性长期关系投影；短期心情、人设和关系分别决定表达。':
      'stableRelations 是核心长期关系状态；当前对象方向未经单独确认，不据此断言对方关系。',
    value.causes.length?'可参考的历史情景评价（仅当前可访问的清楚情景记忆；不证明当前信号由单一事件造成，推断不是客观事实）：'+JSON.stringify(value.causes):'',
    value.waiting?'角色等待体验（主观感受，不能推断用户动机，不改写稳定信任；原话仅从正文或授权记忆读取）：'+JSON.stringify(value.waiting):'',
    value.waiting?.needsClarification?'先前无法回复的说明没有明确结束时间，可温和核实近况；不能当作已经证明永久忙碌。':'',
    value.waiting?.hasCurrentExplanation?'用户当前返场提供了解释，请结合当前可见的正文回应并修复关系，不继续埋怨。':'',
    value.address,
  ].filter(Boolean).join('\n');
}
