import type {Memory,MemoryView} from './access.ts';

/**
 * Forgetting never changes vector precision (ruling 19). A faded memory is embedded exactly from its currently
 * visible layers, like every other memory; what fading changes is the visible text, the access stage and, where
 * scores are equal, this explicit salience order.
 */
export interface SalienceSubject {memory:Memory;view:MemoryView}

/** 0: emotionally protected or retained; 1: currently clear; 2: every other visible stage. */
export function salienceTier({memory,view}:SalienceSubject):0|1|2 {
  if(view.emotionalReaction||memory.retention?.kind==='retain')return 0;
  return view.access==='clear'?1:2;
}

/** The memory's time on the retention (memory) clock, which a grounded rehearsal advances; else when it was learned. */
export function memoryClockTimeMs(memory:Memory):number {
  return memory.retentionAtMs??memory.source.knownAtMs;
}

/**
 * Shared salience order: emotionally protected and retained first, then clear, then newer on the memory clock,
 * then id (code-point order, locale independent). Negative when `a` is more salient. Used as the tie key for equal
 * retrieval scores and as the salience path's own order.
 */
export function compareSalience(a:SalienceSubject,b:SalienceSubject):number {
  return salienceTier(a)-salienceTier(b)||memoryClockTimeMs(b.memory)-memoryClockTimeMs(a.memory)||
    (a.view.id<b.view.id?-1:a.view.id>b.view.id?1:0);
}
