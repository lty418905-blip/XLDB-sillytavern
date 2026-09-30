import type {SceneSource} from './types.ts';

/**
 * Interim tavern memory-clock floor (M-a). Roleplay memory otherwise ages only by accepted story time, so a chat
 * whose extractor never catches a time statement would never forget. Each accepted player source therefore adds
 * a fixed amount of ageing time. Uncertain constant: calibrated by M6 real-model acceptance.
 * The per-scene-switch floor belongs to the architecture release and is intentionally absent here.
 */
export const TAVERN_MEMORY_MS_PER_PLAYER_SOURCE=30*60_000;

/**
 * The single retention clock for scene memory. `storyTimeMs` is the scope's accepted narrative time over the same
 * `sources` prefix (SceneAuthority.emotionTime). Only SillyTavern roleplay adds the floor; every other scope keeps
 * its existing clock. Used for both a memory's retentionAtMs and the snapshot's memoryTimeMs, so their difference
 * is the memory's age on one clock, and undo (a source leaving `accepted`) removes its contribution.
 */
export function memoryClockMs(storyTimeMs:number,sources:readonly Pick<SceneSource,'role'|'status'>[],tavernRoleplay:boolean):number {
  if(!tavernRoleplay)return storyTimeMs;
  let players=0;
  for(const source of sources)if(source.status==='accepted'&&source.role==='user')players++;
  return storyTimeMs+players*TAVERN_MEMORY_MS_PER_PLAYER_SOURCE;
}
