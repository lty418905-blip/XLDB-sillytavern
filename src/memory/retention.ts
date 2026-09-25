import type {Access,Memory,MemorySnapshot} from './access.ts';

export const emotionalReactions = {
  joy:'喜悦', gratitude:'感激', affection:'爱意', relief:'如释重负', pride:'自豪',
  sadness:'悲伤', grief:'悲痛', hurt:'委屈', anger:'愤怒', fear:'恐惧',
  worry:'担忧', shame:'羞耻', guilt:'内疚', disappointment:'失望',
  jealousy:'嫉妒', longing:'思念', loneliness:'孤独', disgust:'厌恶', awe:'震撼',
} as const;
export interface EmotionalProtection {
  reactions:(keyof typeof emotionalReactions)[];
  intensity:'strong';
  feelingBasis:'explicit'|'inferred';
  /** Stored evidence only; never copied into the faded emotional projection. */
  basisQuote:string;
}

/** Missing on legacy records means retain, never permission to forget. */
export interface Retention {
  kind:'retain'|'peripheral';
  basisQuote:string;
  cues:string[];
  emotionalProtection?:EmotionalProtection;
}

export function retentionOf(value:unknown,detail:string):Retention|undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_memory_retention');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['kind','basisQuote','cues','emotionalProtection'].includes(key))||
    !['retain','peripheral'].includes(String(input.kind))||typeof input.basisQuote!=='string'||
    !input.basisQuote.trim()||input.basisQuote.length>1000||!detail.includes(input.basisQuote)||
    !Array.isArray(input.cues)||input.cues.length>3)throw new Error('invalid_memory_retention');
  const cues=input.cues.map(cue=>{
    if(typeof cue!=='string'||cue.trim().length<4||cue.length>80||!detail.includes(cue))throw new Error('invalid_memory_retention');
    return cue;
  });
  const emotionalProtection=emotionalProtectionOf(input.emotionalProtection,detail);
  return {kind:input.kind as Retention['kind'],basisQuote:input.basisQuote,cues:[...new Set(cues)],
    ...(emotionalProtection?{emotionalProtection}:{})};
}

function emotionalProtectionOf(value:unknown,detail:string):EmotionalProtection|undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_memory_retention');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['reactions','intensity','feelingBasis','basisQuote'].includes(key))||
    input.intensity!=='strong'||!['explicit','inferred'].includes(String(input.feelingBasis))||
    !Array.isArray(input.reactions)||input.reactions.length<1||input.reactions.length>3||
    input.reactions.some(key=>typeof key!=='string'||!Object.hasOwn(emotionalReactions,key))||
    typeof input.basisQuote!=='string'||!input.basisQuote.trim()||input.basisQuote.length>1000||
    !detail.includes(input.basisQuote))throw new Error('invalid_memory_retention');
  return {reactions:[...new Set(input.reactions)] as EmotionalProtection['reactions'],intensity:'strong',
    feelingBasis:input.feelingBasis as EmotionalProtection['feelingBasis'],basisQuote:input.basisQuote};
}

/** Protect the reaction, not the event's precise words or the character's current mood. */
export function protectedEmotionalReaction(memory:Memory) {
  const value=memory.retention?.emotionalProtection;
  if(!value||memory.kind!=='episode'||!memory.episode||memory.access==='hidden'||memory.access==='anchor')return undefined;
  const checked=emotionalProtectionOf(value,memory.detail)!;
  return {reactions:[...checked.reactions],intensity:checked.intensity,feelingBasis:checked.feelingBasis};
}

export function protectedFeeling(memory:Memory):string|undefined {
  const value=protectedEmotionalReaction(memory);
  return value?`仍清楚记得当时强烈的${value.reactions.map(key=>emotionalReactions[key]).join('、')}。${value.feelingBasis==='inferred'?'这是当时的主观情绪推断。':''}`:undefined;
}

const DAY=86_400_000;
const DIRECT_COPY_RUN=6;
const DIRECT_CODE_RUN=4;
const conservativeCoarse={
  gist:'记得曾发生过一件事，但具体内容已经模糊。',
  feeling:'这段经历仍留下感觉，但具体感受已经模糊。',
  anchor:'仍记得发生过一件事。',
} as const;

/** Copy guard shared by the foreground projection and exact-cue decision. */
export function directlyCopiesPreciseText(detail:string,coarse:string,protectedFacts:readonly string[]=[]):boolean {
  if(!coarse)return false;
  const projected=compactCopyText(coarse);
  if(!projected)return false;
  for(const preciseText of [detail,...protectedFacts]){
    const precise=compactCopyText(preciseText);
    if(!precise)continue;
    if(precise===projected)return true;
    if(precise.length>=DIRECT_COPY_RUN&&projected.includes(precise))return true;
    if(projected.length>=DIRECT_COPY_RUN&&precise.includes(projected))return true;
    if(sharesExactRun(precise,projected,DIRECT_COPY_RUN))return true;
    const codes=precise.match(/[a-z0-9]{4,}/g)??[];
    if(codes.some(code=>code.length>=DIRECT_CODE_RUN&&projected.includes(code)))return true;
  }
  return false;
}

export function withoutDirectCopy(detail:string,coarse:string,layer:keyof typeof conservativeCoarse,
  protectedFacts:readonly string[]=[]):string {
  return directlyCopiesPreciseText(detail,coarse,protectedFacts)?conservativeCoarse[layer]:coarse;
}

function compactCopyText(value:string):string{return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');}
function sharesExactRun(left:string,right:string,length:number):boolean {
  if(left.length<length||right.length<length)return false;
  const shorter=left.length<=right.length?left:right,longer=left.length<=right.length?right:left;
  for(let index=0;index<=shorter.length-length;index++)if(longer.includes(shorter.slice(index,index+length)))return true;
  return false;
}

/** A view-only time decision; it neither changes history nor writes on recall. */
export function retainedAccess(memory:Memory,nowMs:number,cueText=''): {access:Access;reactivated?:true} {
  if(memory.accessOverride||memory.access!=='clear'||memory.source.reference||memory.retention?.kind!=='peripheral')return {access:memory.access};
  if(memory.reactivated)return {access:memory.access,reactivated:true};
  const since=memory.retentionAtMs??memory.source.knownAtMs;
  const age=Math.max(0,nowMs-since);
  // Only explicitly peripheral memories participate. Anchors and protected
  // facts survive every stage, and absence of a safe classification retains.
  const first=memory.kind==='episode'?30*DAY:60*DAY;
  if(age<first)return {access:'clear'};
  // A forgotten detail is never a hidden lookup key.  Exact cues may only
  // reactivate when the cue is also present in a currently accessible layer.
  const layers:('gist'|'feeling'|'anchor')[]=age<180*DAY?['gist','feeling','anchor']:['feeling','anchor'];
  const visible=layers.map(layer=>withoutDirectCopy(memory.detail,memory[layer],layer,memory.protectedFacts));
  if(cueText&&memory.retention.cues.some(cue=>cueText.includes(cue)&&visible.some(layer=>layer.includes(cue))))
    return {access:age<180*DAY?'clear':'gist',reactivated:true};
  return {access:age<180*DAY?'gist':'feeling'};
}

export interface SemanticCue {id:string;cue:string;basis:string;distance:number;margin:number}

/** Use the same effective granularity for retrieval and foreground context. */
export function retentionSnapshot(snapshot:MemorySnapshot,nowMs:number,cueText=''):MemorySnapshot {
  const clock=snapshot.memoryTimeMs??nowMs;
  return {...snapshot,memories:new Map([...snapshot.memories].map(([id,memory])=>{
    const result=retainedAccess(memory,clock,cueText);
    return [id,{...memory,access:result.access,...(result.reactivated?{reactivated:true}:{})}];
  }))};
}
