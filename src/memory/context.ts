import {projectMemories} from './access.ts';
import type {MemorySnapshot,MemoryView} from './access.ts';

/** Both layers are selected from the same permission/granularity projection. */
export function contextMemories(snapshot:MemorySnapshot,rankedIds:readonly string[],now:number) {
  const all=projectMemories(snapshot,{scope:snapshot.scope,asOfMs:now,ids:[...snapshot.memories.keys()]});
  const byId=new Map(all.memories.map(memory=>[memory.id,memory]));
  const bySource=new Map<string,MemoryView[]>();
  for(const memory of all.memories){
    const key=sourceKey(memory.source.messageId,memory.source.revision);
    const group=bySource.get(key)??[];group.push(memory);bySource.set(key,group);
  }
  const linkedParents=(memory:MemoryView):readonly MemoryView[]=>{
    if(memory.source.author?.role!=='assistant')return [];
    const link=snapshot.replyParents?.get(memory.source.messageId);
    if(!link||link.assistantRevision!==memory.source.revision||link.parentMessageId===memory.source.messageId)return [];
    const parentMessage=snapshot.messages.get(link.parentMessageId);
    if(!parentMessage||parentMessage.status!=='accepted'||parentMessage.revision!==link.parentRevision)return [];
    return (bySource.get(sourceKey(link.parentMessageId,link.parentRevision))??[])
      .filter(parent=>parent.source.author?.role==='user');
  };
  const recent:MemoryView[]=[],sources=new Set<string>(),chosen=new Set<string>();
  let recentSize=0;
  const addRecent=(memory:MemoryView):boolean=>{
    if(chosen.has(memory.id))return true;
    if(recent.length>=4||(sources.size>=3&&!sources.has(memory.source.messageId)))return false;
    const size=JSON.stringify(memory).length;
    if(recentSize+size>4000)return false;
    chosen.add(memory.id);sources.add(memory.source.messageId);recent.push(memory);recentSize+=size;return true;
  };
  // Imported reference material is not a recent shared experience.
  for(const memory of [...all.memories].filter(item=>!item.source.reference).sort((a,b)=>
    b.source.knownAtMs-a.source.knownAtMs || (b.source.occurredAtMs??0)-(a.source.occurredAtMs??0))) {
    if(recent.length>=4)break;
    let parentBlocked=false;
    for(const parent of linkedParents(memory))if(!addRecent(parent))parentBlocked=true;
    if(!parentBlocked)addRecent(memory);
  }
  const relevant:MemoryView[]=[];
  const budgetOmitted=new Set<string>();
  let totalSize=recentSize;
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
  const memories=[...recent,...relevant];
  return {...all,memories,recent,relevant,
    grounding:{selectedEvidence:memories.map(memory=>({memoryId:memory.id,sourceId:memory.source.messageId,
      sourceRevision:memory.source.revision,access:memory.access,
      kind:memory.source.reference?'reference':memory.source.knowledge?.kind??'memory'})),
      budgetOmissions:[...budgetOmitted].filter(id=>!chosen.has(id)).length},
    budget:{recentCharacters:recentSize,totalCharacters:totalSize,recentLimit:4000,totalLimit:24000}};
}

function sourceKey(messageId:string,revision:number):string{return `${messageId}\u0000${revision}`;}
