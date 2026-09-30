import type {SceneState} from './types.ts';

/** Read-only state used to prepare a replacement for an accepted reply. */
export interface GenerationView {
  state: SceneState;
  /** A correction anchored to one of these sources is excluded, not orphaned. */
  excludedSourceIds: ReadonlySet<string>;
}

export function generationView(state:SceneState,replacedAssistantId?:string):GenerationView {
  if(!replacedAssistantId)return {state,excludedSourceIds:new Set()};
  const accepted=state.sources.filter(source=>source.status==='accepted');
  const last=accepted.at(-1);
  if(!last||last.id!==replacedAssistantId||last.role!=='assistant'||last.processing!=='ready')
    throw new Error('invalid_scene_regeneration');
  return {state:{...state,sources:state.sources.slice(0,state.sources.indexOf(last))},
    excludedSourceIds:new Set([last.id])};
}
