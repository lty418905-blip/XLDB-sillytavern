import {projectMemories} from './access.ts';
import type {MemorySnapshot,MemoryView} from './access.ts';
import {memoryClockTimeMs} from './vector-forgetting.ts';
import {storyClockElapsedParts} from '../scene/story-clock.ts';

/** Days of the memory clock that `recent` covers; BL1 wires the character's memory trait (7 to 30) to it. */
export const RECENT_WINDOW_DAYS=14;
const DAY=86_400_000;
/** Rows of the last-contact block: the last memories about the user before an absence. */
export const LAST_CONTACT_ROWS=3;
/** Characters (`JSON.stringify` of the views) the last-contact block may hold; counted inside the 24 000 total. */
export const LAST_CONTACT_LIMIT=3000;

/** The user source a reply path is answering. */
export interface CurrentSource {id:string;revision:number}

/** The one check of a `currentSource` option: absent, or a non-empty id of at most 200 characters and a revision >= 0. */
export function checkCurrentSource(value:unknown):asserts value is CurrentSource|undefined {
  if(value===undefined)return;
  const source=value as Partial<CurrentSource>|null;
  if(!source||typeof source!=='object'||Array.isArray(source)||typeof source.id!=='string'||source.id.length<1||source.id.length>200||
    !Number.isSafeInteger(source.revision)||source.revision!<0)throw new Error('invalid_current_source');
}

/**
 * A faded view with nothing left to say: no layer survived the copy guard, no protected fact and no remembered
 * reaction. It stays in inspect and user controls but never enters the foreground.
 */
export function isTextless(view:MemoryView):boolean {
  return view.access!=='clear'&&view.gist===undefined&&view.feeling===undefined&&view.anchor===undefined&&
    view.protectedFacts.length===0&&view.emotionalReaction===undefined;
}

/**
 * Both layers are selected from the same permission/granularity projection. `recent` holds only memories inside the
 * window on the memory clock (snapshot.memoryTimeMs, else `now`). `absence` is reported when memories about the user
 * exist and none of them, leaving out the turn being answered, is inside the window; `lastContact` then holds the last
 * of those memories (at most LAST_CONTACT_ROWS rows and LAST_CONTACT_LIMIT characters), newest first, each with its age.
 */
export function contextMemories(snapshot:MemorySnapshot,rankedIds:readonly string[],now:number,
  options:{recentWindowDays?:number;currentSource?:CurrentSource}={}) {
  const windowDays=options.recentWindowDays===undefined?RECENT_WINDOW_DAYS:options.recentWindowDays;
  if(!Number.isSafeInteger(windowDays)||windowDays<7||windowDays>30)throw new Error('invalid_recent_window');
  checkCurrentSource(options.currentSource);
  const current=options.currentSource;
  const all=projectMemories(snapshot,{scope:snapshot.scope,asOfMs:now,ids:[...snapshot.memories.keys()]});
  const eligible=all.memories.filter(memory=>!isTextless(memory));
  const byId=new Map(eligible.map(memory=>[memory.id,memory]));
  const bySource=new Map<string,MemoryView[]>();
  for(const memory of eligible){
    const key=sourceKey(memory.source.messageId,memory.source.revision);
    const group=bySource.get(key)??[];group.push(memory);bySource.set(key,group);
  }
  // A trusted one-hop reply binding of an assistant memory, after the four checks; otherwise undefined.
  const replyLink=(memory:MemoryView)=>{
    if(memory.source.author?.role!=='assistant')return undefined;
    const link=snapshot.replyParents?.get(memory.source.messageId);
    if(!link||link.assistantRevision!==memory.source.revision||link.parentMessageId===memory.source.messageId)return undefined;
    const parentMessage=snapshot.messages.get(link.parentMessageId);
    if(!parentMessage||parentMessage.status!=='accepted'||parentMessage.revision!==link.parentRevision)return undefined;
    return link;
  };
  const linkedParents=(memory:MemoryView):readonly MemoryView[]=>{
    const link=replyLink(memory);
    if(!link)return [];
    return (bySource.get(sourceKey(link.parentMessageId,link.parentRevision))??[])
      .filter(parent=>parent.source.author?.role==='user');
  };
  const clock=snapshot.memoryTimeMs??now;
  const timeOf=(memory:MemoryView)=>memoryClockTimeMs(snapshot.memories.get(memory.id)!);
  // Elapsed milliseconds on the memory clock; a memory later than the clock (a backward correction) has age 0.
  const inWindow=(memory:MemoryView)=>Math.max(0,clock-timeOf(memory))<=windowDays*DAY;
  const recent:MemoryView[]=[],sources=new Set<string>(),chosen=new Set<string>();
  let recentSize=0;
  const addRecent=(memory:MemoryView):boolean=>{
    if(chosen.has(memory.id))return true;
    if(recent.length>=4||(sources.size>=3&&!sources.has(memory.source.messageId)))return false;
    const size=JSON.stringify(memory).length;
    if(recentSize+size>4000)return false;
    chosen.add(memory.id);sources.add(memory.source.messageId);recent.push(memory);recentSize+=size;return true;
  };
  // Imported reference material is not a recent shared experience. A linked parent rides with its child: it is the
  // user line the child answers, so it has no window test of its own.
  for(const memory of eligible.filter(item=>!item.source.reference&&inWindow(item)).sort((a,b)=>
    b.source.knownAtMs-a.source.knownAtMs || (b.source.occurredAtMs??0)-(a.source.occurredAtMs??0))) {
    if(recent.length>=4)break;
    let parentBlocked=false;
    for(const parent of linkedParents(memory))if(!addRecent(parent))parentBlocked=true;
    if(!parentBlocked)addRecent(memory);
  }
  // The turn being answered: the current source's own memories, or a stored reply to it (another NPC's line this turn).
  const currentTurn=(memory:MemoryView)=>{
    if(!current)return false;
    if(memory.source.messageId===current.id&&memory.source.revision===current.revision)return true;
    const link=replyLink(memory);
    return !!link&&link.parentMessageId===current.id&&link.parentRevision===current.revision;
  };
  // Remembered contact with the user: a user line, a reply to the user (any speaker, author.actorId is not tested), or a
  // record older than the author field. An assistant line without a valid reply link (an opening) does not count.
  const aboutUser=eligible.filter(memory=>!memory.source.reference&&!currentTurn(memory)&&
    (!memory.source.author||memory.source.author.role==='user'||replyLink(memory)!==undefined));
  let absence:{lastMs:number;elapsedDays:number}|undefined;
  if(aboutUser.length&&!aboutUser.some(inWindow)){
    const last=aboutUser.reduce((latest,memory)=>Math.max(latest,timeOf(memory)),Number.NEGATIVE_INFINITY);
    const parts=storyClockElapsedParts(last,clock);
    if(parts)absence={lastMs:last,elapsedDays:parts.days};
  }
  // Last contact: with the mark, the last memories about the user before the gap, each with its age on the memory clock.
  const lastContact:{memory:MemoryView;daysAgo:number}[]=[];
  let lastContactSize=0;
  if(absence){
    const candidates=[...aboutUser].sort((a,b)=>timeOf(b)-timeOf(a)||b.source.knownAtMs-a.source.knownAtMs||
      (b.source.occurredAtMs??0)-(a.source.occurredAtMs??0)||(a.id<b.id?-1:a.id>b.id?1:0));
    for(const memory of candidates){
      if(lastContact.length>=LAST_CONTACT_ROWS)break;
      if(chosen.has(memory.id))continue;
      const parts=storyClockElapsedParts(timeOf(memory),clock);
      if(!parts)continue;
      const size=JSON.stringify(memory).length;
      if(lastContactSize+size>LAST_CONTACT_LIMIT)continue;
      chosen.add(memory.id);lastContact.push({memory,daysAgo:parts.days});lastContactSize+=size;
    }
  }
  const relevant:MemoryView[]=[];
  const budgetOmitted=new Set<string>();
  let totalSize=recentSize+lastContactSize;
  const addRelevant=(memory:MemoryView):boolean=>{
    if(chosen.has(memory.id))return true;
    const size=JSON.stringify(memory).length;
    if(totalSize+size>24000){budgetOmitted.add(memory.id);return false;}
    chosen.add(memory.id);relevant.push(memory);totalSize+=size;return true;
  };
  for(const id of rankedIds) {
    if(chosen.has(id))continue;
    const memory=byId.get(id);if(!memory)continue;
    let parentBlocked=false;
    for(const parent of linkedParents(memory))if(!addRelevant(parent))parentBlocked=true;
    if(!parentBlocked)addRelevant(memory);else budgetOmitted.add(memory.id);
  }
  const memories=[...recent,...lastContact.map(row=>row.memory),...relevant];
  return {...all,memories,recent,relevant,...(absence?{absence}:{}),...(lastContact.length?{lastContact}:{}),
    grounding:{selectedEvidence:memories.map(memory=>({memoryId:memory.id,sourceId:memory.source.messageId,
      sourceRevision:memory.source.revision,access:memory.access,
      kind:memory.source.reference?'reference':memory.source.knowledge?.kind??'memory'})),
      budgetOmissions:[...budgetOmitted].filter(id=>!chosen.has(id)).length},
    budget:{recentCharacters:recentSize,lastContactCharacters:lastContactSize,totalCharacters:totalSize,
      recentLimit:4000,totalLimit:24000}};
}

function sourceKey(messageId:string,revision:number):string{return `${messageId}\u0000${revision}`;}
