import type {Memory,MemorySnapshot,Scope} from './access.ts';

/** The record under this id when it exists for the snapshot's scope at this time: the existence test of projectMemories. */
export function currentMemory(snapshot:MemorySnapshot,id:string,asOfMs:number):Memory|undefined {
  const memory=snapshot.memories.get(id);
  if(!memory||memory.id!==id||memory.status!=='accepted')return undefined;
  if(!sameScope(memory.scope,snapshot.scope))return undefined;
  const message=snapshot.messages.get(memory.source.messageId);
  if(!message||message.status!=='accepted'||message.revision!==memory.source.revision)return undefined;
  if(memory.source.knownAtMs>asOfMs||(memory.source.occurredAtMs!==null&&memory.source.occurredAtMs>asOfMs))return undefined;
  return memory;
}
export function sameScope(a: Scope, b: Scope): boolean {
  return a.worldId === b.worldId && a.sessionId === b.sessionId
    && a.branchId === b.branchId && a.characterId === b.characterId;
}
