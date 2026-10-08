import type {SceneAuthority} from './store.ts';
import type {SceneScope,SceneState,SceneSource} from './types.ts';
import type {SceneReference} from './transfer.ts';
import type {StoryClockLegacyTimeline,StoryClockReading} from './story-clock-store.ts';
import type {StoryClockMs,StoryClockState,StoryClockView,StoryClockSourceClock} from './story-clock-types.ts';
import type {CommitmentStoryClock} from '../commitments/types.ts';
import type {StoryDeadlineClock} from '../commitments/time.ts';
import type {OriginScanEntry} from './time-expressions.ts';
import type {DirectorClock} from './director.ts';
import type {MemorySnapshot} from '../memory/access.ts';
import {storyLanguageOf,type StoryLanguage} from '../memory/text-units.ts';

export function isStoryScope(authority:SceneAuthority,scope:SceneScope):boolean {
  return authority.worldSettings(scope)?.mode==='story'||authority.interactions.frozenRoleplayTime(scope)!==undefined;
}

export interface StoryNow {
  atMs:StoryClockMs;state:StoryClockState;view:StoryClockView|null;
  originAtMs:StoryClockMs;dayOneStartMs:StoryClockMs;sources:readonly StoryClockSourceClock[];
}
export function storyNow(authority:SceneAuthority,scope:SceneScope,state?:SceneState):StoryNow|null {
  const reading=authority.storyClock.read(scope,state);
  if(reading===null)return null;
  const result=reading.result;
  return {atMs:result.state.atMs,state:result.state,view:reading.view,originAtMs:result.originAtMs,
    dayOneStartMs:result.dayOneStartMs,sources:result.sources};
}

export function storyTimelineOf(processed:readonly SceneSource[],accepted:readonly SceneSource[]):SceneSource[] {
  return [...processed,...accepted.slice(processed.length)];
}

/**
 * One reading and one set of legacy times per immutable timeline; O(n) to index it, then O(1) per lookup. Whether the
 * world is a story world is read once, here. The object belongs to the synchronous call that builds it: it keeps what
 * it has read, so it is never stored and never used after an await or after a write to the scene.
 */
export function commitmentStoryClock(authority:SceneAuthority,scope:SceneScope,timeline:SceneSource[]):CommitmentStoryClock|undefined {
  const story=authority.worldSettings(scope)?.mode==='story';
  // The story-scope test, with the mode already in hand.
  if(!story&&authority.interactions.frozenRoleplayTime(scope)===undefined)return undefined;
  let reading:StoryClockReading|null|undefined;
  let legacyTimes:StoryClockLegacyTimeline|undefined;
  const states=new Map<string,StoryDeadlineClock>();
  const key=(id:string,revision:number)=>JSON.stringify([id,revision]);
  const indices=new Map(timeline.map((source,index)=>[key(source.id,source.revision),index]));
  return {
    at(source){
      if(reading===undefined){
        reading=authority.storyClock.readTimeline(scope,timeline);
        if(reading!==null)for(const entry of reading.result.sources){
          const {atMs,dateKnown,yearKnown,timeOfDayKnown}=entry.state;
          states.set(key(entry.sourceId,entry.revision),{atMs,dateKnown,yearKnown,timeOfDayKnown});
        }
      }
      if(reading===null)return null;
      return states.get(key(source.id,source.revision))??null;
    },
    legacyAt(source){
      if(!story)return null;
      const i=indices.get(key(source.id,source.revision))??-1;
      if(i<0)return null;
      try{return (legacyTimes??=authority.storyClock.legacyTimeline(scope,timeline)).at(i,source.acceptedAtMs);}
      catch(error){
        if(error instanceof Error&&error.message.startsWith('invalid_world_'))return null;
        throw error;
      }
    },
  };
}

/** The director speaks only in calendar dates: known iff the unified clock is dated; `time` is null while the time of day is unknown. */
export function directorClockOf(now:StoryNow|null):DirectorClock {
  const known=now?.view?.kind==='dated';
  const date=known?now!.view!.date:null,time=known?now!.view!.time:null;
  const pad=(value:number,length=2)=>String(value).padStart(length,'0');
  return {kind:'story',known,
    date:date===null||date.year===null?null:`${pad(date.year,4)}-${pad(date.month)}-${pad(date.day)}`,
    time:time===null?null:`${pad(time.hour)}:${pad(time.minute)}`};
}

/** O(n + total table length); only the four public initialization kinds are offered, in input order. */
export function originScanEntries(references:readonly SceneReference[]):OriginScanEntry[] {
  const entries:OriginScanEntry[]=[];
  for(const reference of references){
    const {table,text}=reference;
    if(typeof table!=='string'||typeof text!=='string')continue;
    if(/^initialization\/(world_setting|npc_setting|public_background|starting_state)(\/|$)/.test(table))entries.push({table,text});
  }
  return entries;
}

/** O(n + total text length), with each accepted source text read once. No separate language ratio rule. */
export function sceneStoryLanguage(state:SceneState):StoryLanguage {
  const accepted:string[]=[],assistant:string[]=[];
  for(const source of state.sources){
    if(source.status!=='accepted')continue;
    const text=source.text;
    accepted.push(text);
    if(source.role==='assistant'&&text.trim())assistant.push(text);
  }
  const texts=assistant.length?assistant:accepted;
  // Structural adapter: storyLanguageOf reads only detail, status and source.reference.
  const snapshot={memories:new Map(texts.map((detail,index)=>[String(index),{detail,status:'accepted',source:{}}]))};
  return storyLanguageOf(snapshot as unknown as Pick<MemorySnapshot,'memories'>);
}

export function contextLanguage(snapshot:MemorySnapshot,state:SceneState):StoryLanguage {
  for(const memory of snapshot.memories.values()){
    if(memory.status==='accepted'&&!memory.source.reference)return storyLanguageOf(snapshot);
  }
  return sceneStoryLanguage(state);
}
