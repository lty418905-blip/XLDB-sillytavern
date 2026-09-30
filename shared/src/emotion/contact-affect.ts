import {behavioralSignalsAt,DEFAULT_EMOTION_SETTINGS,emotionSettingsOf,FRUSTRATION_TO_DRIVE,type EmotionSettings,type EmotionState} from './openher.ts';
import {neuralForward,neuralThermodynamic} from './neural.ts';

const WAIT_THRESHOLD_MS=12*3_600_000;

export interface ContactOutgoing {
  id:string;
  targetId:string;
  atMs:number;
  body:string;
  kind:'accepted_assistant'|'confirmed_proactive';
  hostMessageId?:string;
  /** Accepted source order within the same timestamp; required when a reply shares that timestamp. */
  sequence?:number;
  responseExpectation:{expected:boolean|null;quote:string|null};
  quietException?:boolean;
}
export interface ContactReply {sourceId:string;revision:number;targetId:string;acceptedAtMs:number;sequence?:number}
/** These intervals must already be reconstructed from current accepted direct user sources. */
export interface ContactAbsenceInterval {
  sourceId:string;sourceRevision:number;characterId:string;quote:string;
  validFromMs:number;validUntilMs:number|null;effectiveUntilMs:number|null;
  certainty:'bounded'|'uncertain';
}
export interface ContactAffectInput {
  targetId:string;
  nowMs:number;
  outgoing:readonly ContactOutgoing[];
  replies:readonly ContactReply[];
  explanations:readonly ContactAbsenceInterval[];
  currentReply?:{sourceId:string;revision:number}|null;
  /** Quote from that current reply's validated return explanation. */
  currentExplanation?:string|null;
  emotion:EmotionState;
}
export interface ContactAffect {
  phase:'none'|'waiting'|'returning';
  episode:{deliveryId:string;sentAtMs:number;elapsedMs:number;unexplainedMs:number}|null;
  absence:'explained'|'uncertain'|'unexplained'|null;
  currentExplanation?:string;
  needsClarification?:boolean;
  /** Candidate expressions from the OpenHer state and the sourced wait; these are not facts about user intent. */
  feelings:{longing:boolean;worry:boolean;hurt:boolean};
  sourceRefs:{outgoingIds:string[];reply:{sourceId:string;revision:number}|null;
    explanationSources:{sourceId:string;revision:number;quote:string}[]};
}

/** Rebuilds the current unanswered episode; repeated polls neither train nor accumulate emotion. */
export function projectContactAffect(input:ContactAffectInput):ContactAffect {
  const now=validTime(input.nowMs),target=input.targetId;
  const noAffect=():ContactAffect=>({phase:'none',episode:null,absence:null,feelings:{longing:false,worry:false,hurt:false},
    sourceRefs:{outgoingIds:[],reply:null,explanationSources:[]}});
  const grouped=new Map<string,ContactOutgoing[]>();
  for(const row of input.outgoing){
    if(row.targetId!==target||row.atMs>now)continue;
    validTime(row.atMs);
    const key=row.hostMessageId??row.id;
    const current=grouped.get(key)??[];current.push(row);grouped.set(key,current);
  }
  const sends=[...grouped.values()].filter(rows=>!rows.some(row=>row.quietException))
    .map(rows=>{
      const accepted=rows.find(row=>row.kind==='accepted_assistant');
      const primary=accepted??rows[0]!;
      const expected=primary.responseExpectation.expected===true&&Boolean(primary.responseExpectation.quote)&&
        primary.body.includes(primary.responseExpectation.quote!);
      return expected?{id:primary.id,atMs:Math.min(...rows.map(row=>row.atMs)),sequence:primary.sequence}:null;
    }).filter((row):row is {id:string;atMs:number;sequence:number|undefined}=>row!==null)
    .sort((a,b)=>a.atMs-b.atMs||a.id.localeCompare(b.id));
  const replies=input.replies.filter(row=>row.targetId===target&&row.acceptedAtMs<=now)
    .map(row=>({...row,acceptedAtMs:validTime(row.acceptedAtMs)}))
    .sort((a,b)=>a.acceptedAtMs-b.acceptedAtMs||a.sourceId.localeCompare(b.sourceId));
  let pending:{id:string;atMs:number;ids:string[]}|null=null;
  let lastEnded:{id:string;atMs:number;ids:string[];reply:ContactReply}|null=null;
  const events=[...sends.map(row=>({type:'send' as const,atMs:row.atMs,sequence:row.sequence,row})),
    ...replies.map(row=>({type:'reply' as const,atMs:row.acceptedAtMs,sequence:row.sequence,row}))]
    .sort((a,b)=>{
      if(a.atMs!==b.atMs)return a.atMs-b.atMs;
      if(a.sequence!==undefined&&b.sequence!==undefined&&a.sequence!==b.sequence)return a.sequence-b.sequence;
      if(a.type!==b.type)throw new Error('ambiguous_contact_event_order');
      return a.type==='send'&&b.type==='send'?a.row.id.localeCompare(b.row.id):
        a.type==='reply'&&b.type==='reply'?a.row.sourceId.localeCompare(b.row.sourceId):0;
    });
  for(const event of events){
    if(event.type==='send'){
      if(pending)pending.ids.push(event.row.id);
      else pending={id:event.row.id,atMs:event.row.atMs,ids:[event.row.id]};
    }else if(pending){lastEnded={...pending,reply:event.row};pending=null;}
  }
  const returned=input.currentReply&&lastEnded?.reply.sourceId===input.currentReply.sourceId&&
    lastEnded.reply.revision===input.currentReply.revision?lastEnded:null;
  const episode=returned??pending;
  if(!episode)return noAffect();
  const end=returned?returned.reply.acceptedAtMs:now;
  const elapsed=end-episode.atMs;
  if(elapsed<=WAIT_THRESHOLD_MS)return noAffect();
  const intervals=input.explanations.filter(row=>row.characterId===target&&row.quote.trim()&&
    Number.isSafeInteger(row.validFromMs)&&row.validFromMs>=0)
    .map(row=>({row,start:Math.max(episode.atMs,row.validFromMs),end:Math.min(end,row.effectiveUntilMs??row.validUntilMs??end)}))
    .filter(item=>item.end>item.start);
  const covered=unionLength(intervals.map(item=>({start:item.start,end:item.end})));
  const unexplainedMs=Math.max(0,elapsed-covered);
  // A previously unresolved interval cannot mask a later, clearly uncovered
  // wait forever. An open uncertain explanation requires clarification, not
  // an invented expiry or a claim that the whole wait was explained.
  const uncertain=intervals.some(item=>item.row.certainty==='uncertain'&&item.end===end);
  const absence=uncertain?'uncertain':unexplainedMs>WAIT_THRESHOLD_MS?'unexplained':'explained';
  const emotion=input.emotion;
  return {phase:returned?'returning':'waiting',episode:{deliveryId:episode.id,sentAtMs:episode.atMs,elapsedMs:elapsed,unexplainedMs},
    absence,...(uncertain?{needsClarification:true}:{}),...(returned&&input.currentExplanation?{currentExplanation:input.currentExplanation}:{}),
    feelings:{longing:Boolean(returned)||emotion.frustration.connection>0,worry:absence!=='explained'&&emotion.frustration.safety>0,
      hurt:absence==='unexplained'&&emotion.frustration.connection>0},
    sourceRefs:{outgoingIds:episode.ids,reply:returned?{sourceId:returned.reply.sourceId,revision:returned.reply.revision}:null,
      explanationSources:intervals.map(item=>({sourceId:item.row.sourceId,revision:item.row.sourceRevision,quote:item.row.quote}))}};
}

/** One read-time neural forward for the ongoing expectation. Persisted neural learning and stable relations stay unchanged. */
export function projectContactEmotion(emotion:EmotionState,affect:ContactAffect,settings?:EmotionSettings):EmotionState {
  if(affect.phase==='none')return structuredClone(emotion);
  const selected=emotionSettingsOf(settings);
  const pendingForesight=affect.phase==='returning'?0:affect.absence==='unexplained'?1:0.5;
  const context={...emotion.criticContext,relationshipDepth:emotion.stableRelations.depth,
    emotionalValence:emotion.stableRelations.valence,trustLevel:emotion.stableRelations.trust,pendingForesight};
  const forward=neuralForward(emotion.neural,context,emotion.drives);
  const thermodynamic=neuralThermodynamic(forward.state,forward.signals,
    Object.values(emotion.frustration).reduce((sum,value)=>sum+value,0),selected.temperatureCoefficient,selected.temperatureFloor);
  return {...structuredClone(emotion),behavioralSignals:thermodynamic.signals};
}

/** The seed a confirmed proactive send expressed; the same union as contact-pressure's SeedKind. */
export type ExpressionReliefKind='longing'|'share'|'recall'|'check_in'|'followup'|'reminder'|'window_end';
/**
 * `connection` is her connection frustration F_c the send was written from (the outbox relief_connection, M3-5 item 9); it is
 * absent on sends queued before it was kept, and those release the table amount.
 */
export interface ExpressionReliefSend {atMs:number;kind:ExpressionReliefKind;connection?:number}
export interface ExpressionRelief {connection:number;expression:number}

/**
 * Release on connection frustration (tu) per expressed seed; a share also releases expression. A reminder keeps a
 * promise and expresses no longing, so it releases nothing.
 */
export const EXPRESSION_RELIEF:Readonly<Record<ExpressionReliefKind,Readonly<ExpressionRelief>>>=Object.freeze({
  longing:Object.freeze({connection:1.5,expression:0}),
  share:Object.freeze({connection:1.5,expression:1}),
  check_in:Object.freeze({connection:1.5,expression:0}),
  window_end:Object.freeze({connection:1.5,expression:0}),
  recall:Object.freeze({connection:1,expression:0}),
  followup:Object.freeze({connection:0.75,expression:0}),
  reminder:Object.freeze({connection:0,expression:0}),
});

/**
 * Proportional release (M3-5 item 9): a longing, a window-end message, or a check-in relabelled from her longing releases
 * min(R_table, EXPRESSION_RELIEF_PROPORTION * F_c at the send) on connection, so one good-morning does not empty a whole day
 * of missing him. Only these kinds read the send's `connection`; a share keeps its table release (and its expression 1),
 * recall, follow-up and reminder are unchanged. A native check-in carries no `connection`, so it keeps the table amount.
 */
export const EXPRESSION_RELIEF_PROPORTION=0.6;
const PROPORTIONAL_RELIEF_KINDS:ReadonlySet<ExpressionReliefKind>=new Set(['longing','window_end','check_in']);

/** The connection release of one send at its own time: the table amount, or the proportional one when it applies. */
function connectionReliefOf(send:ExpressionReliefSend,table:Readonly<ExpressionRelief>):number {
  if(send.connection===undefined||!PROPORTIONAL_RELIEF_KINDS.has(send.kind))return table.connection;
  if(typeof send.connection!=='number'||!Number.isFinite(send.connection)||send.connection<0)
    throw new Error('invalid_expression_relief_connection');
  return Math.min(table.connection,EXPRESSION_RELIEF_PROPORTION*send.connection);
}

/**
 * The release decays at least this fast whatever the persona's frustrationDecayPerHour (OpenHer's default rate), so
 * with a decay of 0 or near 0 a send still stops releasing and only hard conditions can keep her silent for good.
 */
export const EXPRESSION_RELIEF_MIN_DECAY_PER_HOUR=DEFAULT_EMOTION_SETTINGS.frustrationDecayPerHour;
/** The summed release never exceeds the largest single release in the table: several sends release no more than one. */
export const EXPRESSION_RELIEF_CAP:Readonly<ExpressionRelief>=Object.freeze({
  connection:Math.max(...Object.values(EXPRESSION_RELIEF).map(item=>item.connection)),
  expression:Math.max(...Object.values(EXPRESSION_RELIEF).map(item=>item.expression)),
});
/** Below this weight a send no longer releases anything measurable (R * weight < 1e-6 for every R in the table). */
const RELIEF_NEGLIGIBLE_WEIGHT=1e-6/EXPRESSION_RELIEF_CAP.connection;

function reliefDecayPerHour(settings?:unknown):number {
  return Math.max(emotionSettingsOf(settings).frustrationDecayPerHour,EXPRESSION_RELIEF_MIN_DECAY_PER_HOUR);
}

/**
 * How far back a send can still release anything measurable at these settings; older sends can be skipped without
 * resolving their kind.
 */
export function expressionReliefHorizonMs(settings?:unknown):number {
  return -Math.log(RELIEF_NEGLIGIBLE_WEIGHT)/reliefDecayPerHour(settings)*3_600_000;
}

/**
 * Read-time release after her own confirmed sends: min(cap, sum of R_k*e^(-k*(t-t_k))) with k = OpenHer's own frustration
 * decay rate per hour, floored at EXPRESSION_RELIEF_MIN_DECAY_PER_HOUR, and cap = the largest single R. R_k on connection is
 * the table amount, or for a send that carries the F_c it was written from the proportional release (see
 * EXPRESSION_RELIEF_PROPORTION), never above the table amount. Sends after t do not count. Nothing is trained, and only the
 * F_c at the send is persisted, so a replay never adds a release twice; the release follows the host-confirmed receipt,
 * not the scene source.
 */
export function expressionRelief(sends:readonly ExpressionReliefSend[],nowMs:number,settings?:unknown):ExpressionRelief {
  const decay=reliefDecayPerHour(settings),relief={connection:0,expression:0};
  for(const send of sends){
    if(!Number.isFinite(send.atMs)||send.atMs>nowMs)continue;
    const table=EXPRESSION_RELIEF[send.kind];
    if(!table)throw new Error('invalid_expression_relief_kind');
    const weight=Math.exp(-decay*(nowMs-send.atMs)/3_600_000);
    relief.connection+=connectionReliefOf(send,table)*weight;relief.expression+=table.expression*weight;
  }
  return {connection:Math.min(EXPRESSION_RELIEF_CAP.connection,relief.connection),
    expression:Math.min(EXPRESSION_RELIEF_CAP.expression,relief.expression)};
}

/**
 * Subtract a release from projected frustration (floored at 0), move the drives by the same OpenHer coupling, and
 * recompute the read-time behavioral signals from the relieved drives exactly as emotionAt does, so the signals never
 * disagree with the frustration and drives beside them. Nothing is trained or persisted.
 */
export function applyExpressionRelief(emotion:EmotionState,relief:ExpressionRelief,settings?:unknown):EmotionState {
  if(relief.connection<=0&&relief.expression<=0)return emotion;
  const frustration={...emotion.frustration},drives={...emotion.drives};
  let changed=false;
  for(const drive of ['connection','expression'] as const){
    const next=Math.max(0,frustration[drive]-Math.max(0,relief[drive]));
    if(next!==frustration[drive])changed=true;
    drives[drive]=Math.min(1,Math.max(0,drives[drive]-(frustration[drive]-next)*FRUSTRATION_TO_DRIVE));
    frustration[drive]=next;
  }
  if(!changed)return emotion;
  const relieved={...emotion,frustration,drives};
  return {...relieved,behavioralSignals:behavioralSignalsAt(relieved,settings)};
}

function unionLength(intervals:{start:number;end:number}[]):number {
  let length=0,lastEnd=-1;
  for(const interval of intervals.sort((a,b)=>a.start-b.start||a.end-b.end)){
    if(interval.end<=lastEnd)continue;
    length+=interval.end-Math.max(lastEnd,interval.start);
    lastEnd=interval.end;
  }
  return length;
}
function validTime(value:number):number {
  if(!Number.isSafeInteger(value)||value<0)throw new Error('invalid_contact_affect_time');
  return value;
}
