import {suggestAddress,type AddressPreference} from '../emotion/address.ts';
import type {EmotionState} from '../emotion/openher.ts';
import {relationshipContext} from '../emotion/relationships.ts';
import type {SceneAuthority} from './store.ts';
import type {SceneScope,SceneEnvelope,SceneState} from './types.ts';
import type {ContactAffect} from '../emotion/contact-affect.ts';

/** Only accepted speech visible to this actor can settle a nickname or an earlier invitation. */
export function addressConversation(messages:readonly {role:string;text:string}[],visibility:'private'|'public'='private'){
  let preference:AddressPreference|undefined,nicknameAsked=false;
  for(const message of messages){
    if(message.role==='assistant'){
      if(/(?:怎么称呼你|叫你什么|喜欢.{0,8}(?:叫|称呼)|可以叫你|你的昵称|what.{0,12}call you|nickname)/i.test(message.text))nicknameAsked=true;
      continue;
    }
    const text=message.text.trim();
    const scope:AddressPreference['scope']=/(?:只在|仅在|只限|仅限)\s*(?:私下|私聊|两个人)|私下.{0,8}(?:叫|称呼)/.test(text)?'private':
      /(?:只在|仅在|只限|仅限)\s*(?:公开|公共|正式|有其他人)/.test(text)?'public':'all';
    if(scope!=='all'&&scope!==visibility)continue;
    if(/^(?:请|以后|你)?(?:别|不要|不许).{0,5}(?:亲昵|昵称|小名|宝贝|叫我|称呼我)/.test(text)){
      preference={status:'accepted',scope,kind:'reject-intimate'};nicknameAsked=true;continue;
    }
    const match=text.match(/^(?:(?:请|以后|你可以|就|还是)\s*)?(?:叫我|称呼我(?:为)?|我的昵称是)\s*[“"「]?([^，。！？!?\n”"」]{1,24})[”"」]?(?:[，。！？!?]|$)/);
    if(match){preference={status:'accepted',scope,kind:'use',address:match[1].trim()};nicknameAsked=true;}
  }
  return {preferences:preference?[preference]:[],nicknameAsked};
}

export function sceneAddressGuidance(authority:SceneAuthority,scope:SceneScope,speakerId:string,envelope:SceneEnvelope,
  state:SceneState,emotion:Pick<EmotionState,'behavioralSignals'|'criticContext'>):string {
  const relation=authority.relationshipAnchor(scope,speakerId,'player',state);
  const messages=state.sources.filter(s=>s.status==='accepted'&&s.processing==='ready').flatMap(source=>{
    if(source.role==='assistant')return source.speakerId===speakerId?[{role:'assistant',text:source.text}]:[];
    const visible=source.analysis?.plan?.observations.filter(o=>o.actorId==='player'&&o.readers.includes(speakerId)&&o.kind==='heard').map(o=>o.quote).join('\n');
    return visible?[{role:'user',text:visible}]:[];
  });
  const presentCount=envelope.presentIds.length+1;
  const history=addressConversation(messages,presentCount>2?'public':'private');
  const suggestion=suggestAddress({visibility:presentCount>2?'public':'private',presentCount,formality:'casual',
    addresseeIdentityKnown:!!envelope.playerName?.trim()},relation?{sourceId:relation.sourceId,revision:relation.revision,
    status:'accepted',direction:'speaker-to-addressee',relations:relation.relations}:undefined,history.preferences,
    {emotion,nicknameAsked:history.nicknameAsked});
  return relationshipContext(authority.relationships(scope,speakerId,state))+
    `\n[XLDB 称谓建议] 当前上下文中已列明的显式称谓、拒绝和边界偏好优先于本建议。${suggestion.instruction}`+
    (suggestion.address?`用户明确指定的称呼：${JSON.stringify(suggestion.address)}。`:'');
}

/** Collects scene-local expression inputs without reading or rendering memories. */
export function sceneExpressionOptions(authority:SceneAuthority,scope:SceneScope,speakerId:string,envelope:SceneEnvelope,
  state:SceneState,emotion:EmotionState,nowMs:number,waiting?:ContactAffect|null,directional=true){
  const mode=authority.interactions.modeOf(scope);
  const clock=mode?authority.interactions.clock(scope,nowMs):null;
  const story=clock?.kind==='story'||!clock&&authority.worldSettings(scope)?.mode==='story';
  const zone=clock?.timeZone??(story?'UTC':null);
  const hideStoryTime=Boolean(story&&(authority.worldSettings(scope)?.publicTime===false||
    clock?.kind==='story'&&!clock.known));
  const clockTimeMs=clock?.kind==='story'?(typeof clock.timeMs==='number'?clock.timeMs:null):
    story?authority.emotionTime(scope,state.sources,nowMs):nowMs;
  return {actorId:speakerId,addresseeId:'player',timeZone:zone,clockKind:story?'story' as const:'realtime' as const,
    clockTimeMs,hideStoryTime,
    relationBasis:directional?'current_directional_projection' as const:'core_state_unspecified_target' as const,waiting,
    address:sceneAddressGuidance(authority,scope,speakerId,envelope,state,emotion)};
}
