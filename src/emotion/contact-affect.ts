import {emotionSettingsOf,type EmotionSettings,type EmotionState} from './openher.ts';
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
