import {projectMemories} from '../memory/access.ts';
import {emotionSummary} from '../emotion/openher.ts';
import type {SceneAuthority} from './store.ts';
import type {SceneScope} from './types.ts';
import type {SceneWriteGuard} from './types.ts';
import type {Core} from '../core/service.ts';
import type {Configurations} from '../core/types.ts';
import {text} from '../core/types.ts';

export interface MaterialRow {
  id:string;
  type:'source'|'memory'|'preference'|'identity'|'emotion'|'clock'|'balance'|'inventory'|'receipt'|'reference'|'commitment';
  label:string;
  value:unknown;
  characterId?:string;
  sourceId?:string;
  revision?:number;
  occurredAtMs?:number|null;
  updatedAtMs?:number|null;
  status:string;
  access?:string;
  enabled?:boolean;
  corrected?:boolean;
  category?:string;
}

export async function correctSceneSource(core:Core,scope:SceneScope,sourceId:string,revision:number,
  replacement:string|null,guard:SceneWriteGuard,configs:Configurations) {
  const state=core.authority.scene.state(scope);
  const source=state.sources.find(item=>item.id===sourceId&&item.status!=='deleted');
  if(!source)throw new Error('record_not_found');
  if(source.revision!==revision||state.version!==guard.expectedVersion)throw new Error('context_changed_retry');
  const messages=state.sources.filter(item=>item.status!=='deleted'&&(replacement!==null||item.id!==sourceId))
    .map(item=>item.id===sourceId?{...item,text:text(replacement,20000)}:item);
  return core.scene.reconcile(scope,messages,configs,guard);
}

/** A manager view is explicit; character mode never returns the source transcript. */
export function sceneWorkbench(authority:SceneAuthority,scope:SceneScope,
  options:{view:'admin'|'character';characterId?:string;query?:string;type?:string},now=Date.now()) {
  if(options.view!=='admin'&&options.view!=='character')throw new Error('invalid_workbench_view');
  const state=authority.state(scope);
  if(options.view==='character'&&!state.roster.characters.some(actor=>actor.id===options.characterId))throw new Error('invalid_scene_character');
  const rows:MaterialRow[]=[];
  const mode=authority.interactions.modeOf(scope);
  if(mode)for(const record of authority.commitments.list(scope,{mode,...(options.view==='character'?{readerId:options.characterId}:{}),realNowMs:now}))
    rows.push({id:record.id,type:'commitment',label:record.content,value:record,status:record.status,sourceId:record.latestSourceId,revision:record.revision});
  const actors=state.roster.characters.filter(actor=>!options.characterId||actor.id===options.characterId);
  if(options.view==='admin') {
    for(const reference of authority.transfer.references(scope))rows.push({id:reference.id,type:'reference',label:'迁入参考资料',
      value:{text:reference.text,knownBy:reference.knownBy,fileHash:reference.fileHash,table:reference.table,row:reference.row},
      occurredAtMs:reference.occurredAtMs,updatedAtMs:reference.importedAtMs,status:'ready'});
    for(const source of state.sources)rows.push({id:source.id,type:'source',label:source.role==='user'?'用户正文':'角色正文',
      value:source.text,sourceId:source.id,revision:source.revision,occurredAtMs:source.acceptedAtMs,updatedAtMs:source.observedAtMs,
      status:source.status==='accepted'?source.processing:source.status});
  }
  for(const actor of actors) {
    if(options.view==='admin')rows.push({id:`identity:${actor.id}`,type:'identity',characterId:actor.id,label:actor.name,
      value:{name:actor.name,aliases:actor.aliases,persona:actor.persona,source:actor.identitySource?.kind??'manual'},status:'configured'});
    const snapshot=authority.snapshot(scope,actor.id,state);
    const memories=options.view==='admin'?[...snapshot.memories.values()]:projectMemories(snapshot,{scope:snapshot.scope,asOfMs:now,ids:[...snapshot.memories.keys()]}).memories;
    for(const memory of memories.filter(memory=>options.view!=='admin'||!memory.source.reference))rows.push({id:memory.id,type:memory.source.reference?'reference':'memory',characterId:actor.id,
      label:memory.kind==='episode'?'情景与感受':memory.source.reference?'迁入参考资料':'事实与记忆',
      value:options.view==='admin'?memory.detail:{detail:memory.detail,gist:memory.gist,feeling:memory.feeling,anchor:memory.anchor,
        protectedFacts:memory.protectedFacts,forgotten:'forgotten' in memory?memory.forgotten:undefined,episode:memory.episode,reference:memory.source.reference},
      sourceId:memory.source.messageId,revision:memory.source.revision,occurredAtMs:memory.source.occurredAtMs,
      updatedAtMs:memory.source.knownAtMs,status:'ready',access:memory.access});
    for(const preference of authority.preferences(scope,actor.id,state)) {
      if(options.view==='character'&&!preference.enabled)continue;
      rows.push({id:preference.id,type:'preference',characterId:actor.id,label:preference.category,value:preference.text,
        sourceId:preference.sourceId,revision:preference.revision,status:preference.enabled?'enabled':'disabled',
        category:preference.category,enabled:preference.enabled,corrected:preference.corrected});
    }
    rows.push({id:`emotion:${actor.id}`,type:'emotion',characterId:actor.id,label:`${actor.name}当前情绪`,
      value:emotionSummary(authority.emotion(scope,actor.id,now,state)),status:'derived'});
  }
  const world=authority.world(scope,options.view==='character'?options.characterId:undefined,now,state);
  if(world) {
    const current='state' in world?world.state:world;
    if(current.timeMs!==undefined)rows.push({id:'clock',type:'clock',label:'当前世界时间',value:new Date(current.timeMs).toISOString(),status:'derived'});
    for(const balance of current.balances)rows.push({id:`balance:${balance.ownerId}:${balance.unit}`,type:'balance',label:`${balance.ownerId} · ${balance.unit}`,value:balance.value,status:'derived'});
    for(const item of current.inventory)rows.push({id:`inventory:${item.ownerId}:${item.item}`,type:'inventory',label:`${item.ownerId} · ${item.item}`,value:item.count,status:'derived'});
    for(const [index,receipt] of world.receipts.entries())rows.push({id:`receipt:${receipt.sourceId}:${index}`,type:'receipt',label:receipt.kind,
      value:receipt,sourceId:receipt.sourceId,revision:receipt.revision,status:receipt.applied?'applied':'ignored'});
  }
  const query=(options.query??'').trim().toLocaleLowerCase();
  const filtered=rows.filter(row=>(!options.type||options.type===row.type)&&(!query||JSON.stringify(row).toLocaleLowerCase().includes(query)));
  return {version:state.version,view:options.view,characterId:options.characterId??null,total:rows.length,items:filtered,
    capabilities:{sourceCorrection:options.view==='admin',preferenceCorrection:options.view==='admin',accessControl:options.view==='admin',
      ledgerDirectEdit:false,neuralWeightEdit:false},
    notice:options.view==='admin'?'管理员视图包含原始来源；正文纠正会使依赖资料待重新核对。':'仅展示该角色当前可访问的粒度；未知不补全。'};
}
