import {compact} from './text-units.ts';
import type {Access,Memory} from './access.ts';

export const TRACE_POLICY_VERSION=1;
// This is a planned value; the calibration run sets the final one.
export const TRACE_CANDIDATE_CEILING=0.50;
// This is a planned value; the calibration run sets the final one.
export const TRACE_CANDIDATE_LIMIT=3;
export const TRACE_STRONG_CUES=2;
export const TRACE_CUE_MIN_FOLDED=2;
export const TRACE_CUE_RAW_LIMIT=1000;
export const TRACE_RECORD_LIMIT=32;
/** Recalled events one context places first, at most; twins are one event. */
export const RECALL_EVENT_LIMIT=3;

// Work: O(s + u^2 * l), with s total text units, u distinct entries and l the longest entry.
export function clearKeyText(memory:Pick<Memory,'detail'|'episode'>):string {
  const episode=memory.episode as {scene?:unknown;participants?:unknown;sensoryCues?:unknown;appraisal?:unknown}|undefined;
  const list=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
  const texts=[memory.detail,episode?.scene,...list(episode?.participants),...list(episode?.sensoryCues),episode?.appraisal]
    .filter((value):value is string=>typeof value==='string'&&value.trim().length>0);
  const unique=[...new Set(texts)];
  return unique.filter(value=>!unique.some(other=>other.length>value.length&&other.includes(value))).join('\n');
}
// Work: O(c + s), with c cues and s the units of string cues within the raw length limit.
export function cueKeyTexts(memory:Pick<Memory,'retention'>):string[] {
  const cues:unknown=memory.retention?.kind==='peripheral'?memory.retention.cues:undefined;
  if(!Array.isArray(cues))return [];
  return [...new Set(cues.filter((cue):cue is string=>typeof cue==='string'&&cue.length<=TRACE_CUE_RAW_LIMIT&&[...compact(cue)].length>=TRACE_CUE_MIN_FOLDED))];
}
// Work: O(s), with s the units of the source id, revision encoding and detail.
export function eventKey(memory:Pick<Memory,'source'|'detail'>):string {
  return JSON.stringify([memory.source.messageId,memory.source.revision,memory.detail]);
}

let folds=0;
/** Calls of foldCue since module load, for the work-count tests. */
// Work: O(1); reads the fold-call counter.
export function foldCount():number {return folds;}
// Work: O(n), with n input text units, for normalization, casing and the disjoint character filter.
export function foldCue(text:string):string {folds++;return compact(text);}
/** The folds of the cues that may take part: distinct, in stored order. One foldCue call per string cue within the raw limit. */
// Work: O(s + c^2 * l), with c cues, s their accepted text units and l the longest fold.
export function foldedCues(cues:readonly unknown[]):string[] {
  if(!Array.isArray(cues))return [];
  const keys:string[]=[];
  for(const cue of cues){
    if(typeof cue!=='string'||cue.length>TRACE_CUE_RAW_LIMIT)continue;
    const key=foldCue(cue);
    if([...key].length>=TRACE_CUE_MIN_FOLDED&&!keys.includes(key))keys.push(key);
  }
  return keys;
}
// Work: O(s + c * n + c^2 * l), with n text units, c cues, s accepted cue units and l the longest fold.
export function visibleCueHits(cues:readonly unknown[],foldedText:string):number {
  if(typeof foldedText!=='string'||!foldedText)return 0;
  const found=foldedCues(cues).filter(key=>foldedText.includes(key));
  return found.filter(key=>!found.some(other=>other!==key&&other.includes(key))).length;
}

export type TraceTier='gist'|'feeling'|'anchor'|'hidden';
const RESTORED:Readonly<Record<TraceTier,Access>>={gist:'clear',feeling:'gist',anchor:'feeling',hidden:'anchor'};
// Work: O(1); checks and reads a fixed four-entry table.
export function restoredAccess(tier:TraceTier,strong:boolean):Access {
  if(!Object.hasOwn(RESTORED,tier))throw new Error('invalid_trace_tier');
  return strong===true?'clear':RESTORED[tier];
}
// Work: O(r log r * l), with r records and l the longest id compared; copies the input array.
export function recallOrder(memories:readonly Pick<Memory,'id'|'source'>[]):string[] {
  return [...memories].sort((a,b)=>a.source.knownAtMs-b.source.knownAtMs||(a.source.occurredAtMs??0)-(b.source.occurredAtMs??0)||
    (a.id<b.id?-1:a.id>b.id?1:0)).map(memory=>memory.id);
}

export interface TraceHolder {id:string;event:string;tier?:TraceTier}
export interface TraceKeyDistance {id:string;distance:number}
export interface TraceCandidateLimits {ceiling:number;limit:number;exclude:ReadonlySet<string>}
export interface TraceCandidate {event:string;ids:string[];distance:number}
export interface TraceHit {id:string;strong:boolean}

// Work: O(1); validates and clamps one number.
export function clampDistance(value:unknown):number|undefined {
  return typeof value==='number'&&Number.isFinite(value)?Math.min(2,Math.max(0,value)):undefined;
}
// Work: O(d), with d vector components; reads each component a fixed number of times.
export function cosineDistance(left:ArrayLike<number>,right:ArrayLike<number>):number|undefined {
  if(left.length!==right.length||left.length===0)return undefined;
  let dot=0,a=0,b=0;
  for(let index=0;index<left.length;index++){dot+=left[index]!*right[index]!;a+=left[index]!*left[index]!;b+=right[index]!*right[index]!;}
  if(!a||!b)return 1;
  return clampDistance(1-dot/Math.sqrt(a*b));
}
/**
 * The faded events nearest to the query. A holder with a tier is a target; an event's distance is the smallest key
 * distance among its targets. Events within the ceiling are kept, nearest first and by event at equal distance, and
 * the first `limit` are returned with their targets. An event in `exclude` is left out before the limit applies. A
 * key of an unknown id or of a holder that is no target, and a distance that is not a finite number, are ignored.
 */
// Work: O(h + k + e log e), with h holders, k keys and e events with a target; each distance is read once.
export function traceCandidates(holders:readonly TraceHolder[],keys:readonly TraceKeyDistance[],limits:TraceCandidateLimits):TraceCandidate[] {
  const ceiling=limits.ceiling,limit=limits.limit,exclude=limits.exclude;
  const eventOf=new Map<string,string>(),members=new Map<string,string[]>();
  for(const holder of holders){
    const id=holder.id,event=holder.event;
    if(holder.tier===undefined)continue;
    eventOf.set(id,event);
    const group=members.get(event)??[];group.push(id);members.set(event,group);
  }
  const nearest=new Map<string,number>();
  for(const key of keys){
    const event=eventOf.get(key.id),distance=clampDistance(key.distance);
    if(event===undefined||distance===undefined)continue;
    if(distance<(nearest.get(event)??Infinity))nearest.set(event,distance);
  }
  const found:TraceCandidate[]=[];
  for(const [event,distance] of nearest)if(distance<=ceiling&&!exclude.has(event))found.push({event,ids:[...members.get(event)!],distance});
  return found.sort((a,b)=>a.distance-b.distance||(a.event<b.event?-1:a.event>b.event?1:0)).slice(0,limit);
}
