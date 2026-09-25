import type {Memory,MemoryView} from './access.ts';

export type VectorPrecision = 32 | 8 | 4;

/** Precision follows the current authorized layer, never age alone. */
export function vectorPrecision(memory:Memory,view:MemoryView):VectorPrecision {
  if(memory.source.reference||memory.protectedFacts.length||view.emotionalReaction||
    (memory.retention?.kind!=='peripheral'&&!memory.accessOverride))return 32;
  if(view.access==='gist')return 8;
  if(view.access==='feeling'||view.access==='anchor')return 4;
  return 32;
}

/** Symmetric per-vector scalar quantization. Only the reconstructed values enter the index. */
export function quantizeVector(vector:readonly number[],bits:VectorPrecision):number[] {
  if(bits===32)return [...vector];
  const magnitude=Math.max(...vector.map(value=>Math.abs(value)));
  if(magnitude===0)return [...vector];
  const signedMax=(1<<(bits-1))-1;
  return vector.map(value=>Math.fround(Math.round(value/magnitude*signedMax)/signedMax*magnitude));
}
