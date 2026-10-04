import type {SceneAuthority} from './store.ts';
import type {SceneScope,SceneState,SceneSource} from './types.ts';
import type {SceneReference} from './transfer.ts';
import type {StoryClockReading} from './story-clock-store.ts';
import type {StoryClockMs,StoryClockState,StoryClockView,StoryClockSourceClock} from './story-clock-types.ts';
import type {CommitmentStoryClock} from '../commitments/types.ts';
import type {StoryDeadlineClock} from '../commitments/time.ts';
import type {OriginScanEntry} from './time-expressions.ts';
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

/** One reading per immutable timeline; O(n) to index it, then O(1) per at lookup. */
export function commitmentStoryClock(authority:SceneAuthority,scope:SceneScope,timeline:SceneSource[]):CommitmentStoryClock|undefined {
  if(!isStoryScope(authority,scope))return undefined;
  let reading:StoryClockReading|null|undefined;
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
      if(authority.worldSettings(scope)?.mode!=='story')return null;
      const i=indices.get(key(source.id,source.revision))??-1;
      if(i<0)return null;
      try{return authority.legacyEmotionTime(scope,timeline.slice(0,i+1),source.acceptedAtMs,timeline);}
      catch(error){
        if(error instanceof Error&&error.message.startsWith('invalid_world_'))return null;
        throw error;
      }
    },
  };
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
