import type { SceneAuthority } from './store.ts';
import type { SceneScope } from './types.ts';
import type { WorldProjection } from './world-state.ts';
import {emotionSummary} from '../emotion/openher.ts';

/** Display-only inspection; it never changes the reader used by generation. */
export function sceneDashboard(authority:SceneAuthority,scope:SceneScope,now=Date.now(),options:{characterId?:string;year?:number;month?:number}={}) {
  const state=authority.state(scope);
  const characterId=options.characterId??'player';
  const character=state.roster.characters.find(actor=>actor.id===characterId);
  if(characterId!=='player'&&!character)throw new Error('invalid_dashboard_character');
  const inspecting=characterId!=='player';
  const world=authority.world(scope,'player',now,state) as WorldProjection|null;
  const complete=inspecting?authority.world(scope,undefined,now,state):null;
  const initialAssets=authority.initialization.activeAssets(scope);
  const ownWorld=complete&&'state' in complete?{balances:complete.state.balances,inventory:complete.state.inventory,receipts:complete.receipts}:world??{
    balances:initialAssets.balances.filter(row=>inspecting||(row.readerIds??['player']).includes('player')),
    inventory:initialAssets.inventory.filter(row=>inspecting||(row.readerIds??['player']).includes('player')),receipts:[]};
  const settings=authority.worldSettings(scope);
  const map=authority.geography.project(scope,characterId);
  const clock=authority.interactions.clock(scope,now);
  const dateParts=typeof clock.timeMs==='number'?new Intl.DateTimeFormat('en-US',{timeZone:clock.timeZone,year:'numeric',month:'numeric'}).formatToParts(clock.timeMs):[];
  const year=options.year??Number(dateParts.find(part=>part.type==='year')?.value);
  const month=options.month??Number(dateParts.find(part=>part.type==='month')?.value);
  const hasCalendarDate=typeof clock.timeMs==='number'||options.year!==undefined||options.month!==undefined;
  if(hasCalendarDate&&(!Number.isInteger(year)||year<1||year>9999||!Number.isInteger(month)||month<1||month>12))throw new Error('invalid_calendar_month');
  return {
    version:state.version,scope,mode:authority.interactions.modeOf(scope),
    playerName:settings?.playerName||'玩家',clock,
    selectedCharacterId:characterId,selectedCharacterName:character?.name??settings?.playerName??'玩家',
    view:inspecting?'inspection':'player',characters:state.roster.characters.map(({id,name})=>({id,name})),
    configured:Boolean(world)||map.configured,
    balances:(ownWorld?.balances??[]).filter(row=>row.ownerId===characterId).map(({ownerId,unit,value})=>({ownerId,unit,value})),
    inventory:(ownWorld?.inventory??[]).filter(row=>row.ownerId===characterId).map(({ownerId,item,count})=>({ownerId,item,count})),
    transactions:(ownWorld?.receipts??[]).filter(row=>row.ownerId===characterId&&['purchase','refund','consume'].includes(row.kind)).slice(-30).reverse()
      .map(({sourceId,revision,kind,ownerId,item,unit,balanceDeltaCents,inventoryDelta,applied})=>({sourceId,revision,kind,ownerId,item,unit,balanceDeltaCents,inventoryDelta,applied})),
    physiology:authority.physiology.status(scope,{readerId:'player',nowMs:now,...(inspecting?{inspectCharacterId:characterId}:{})}),
    emotion:inspecting?emotionSummary(authority.responseEmotion(scope,characterId,now,state)):null,
    todos:clock.kind==='story'?authority.calendar.listTodos(scope,inspecting?'admin':'player',inspecting?characterId:undefined):[],
    reminders:clock.kind==='story'&&typeof clock.timeMs==='number'?authority.calendar.reminds(scope,clock.timeMs):[],
    calendar:hasCalendarDate?authority.calendar.month(scope,{year,month,timeZone:clock.timeZone,view:inspecting?'admin':'player',...(inspecting?{characterId}:{})}):null,
    map,
  };
}
