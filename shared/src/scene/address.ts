import {foldForMatch} from '../common/script-fold.ts';
import {suggestAddress,type AddressPreference} from '../emotion/address.ts';
import type {EmotionState} from '../emotion/openher.ts';
import {relationshipContext} from '../emotion/relationships.ts';
import type {SceneAuthority} from './store.ts';
import type {SceneScope,SceneEnvelope,SceneState} from './types.ts';
import type {ContactAffect} from '../emotion/contact-affect.ts';
import type {EventConsumerSource, EventConsumerProjection} from './tavern-engine/perception.ts';
import {isOwnEmotionLine} from './emotion-own-line.ts';

/** Only accepted speech visible to this actor can settle a nickname or an earlier invitation. */
export function addressConversation(messages:readonly {role:string;text:string}[],visibility:'private'|'public'='private'){
  let preference:AddressPreference|undefined,nicknameAsked=false;
  for(const message of messages){
    if(message.role==='assistant'){
      if(/(?:怎么称呼你|叫你(?:什么|甚么)|喜欢.{0,8}(?:叫|称呼)|可以叫你|你的昵称|what.{0,12}call you|nickname)/i.test(foldForMatch(message.text)))nicknameAsked=true;
      continue;
    }
    // Match a length-preserving copy; capture indices still point into the original nickname.
    const source=message.text.trim(),text=foldForMatch(source);
    const scope:AddressPreference['scope']=/(?:只在|仅在|只限|仅限)\s*(?:私下|私聊|两个人)|私下.{0,8}(?:叫|称呼)/.test(text)?'private':
      /(?:只在|仅在|只限|仅限)\s*(?:公开|公共|正式|有其[他它]人)/.test(text)?'public':'all';
    if(scope!=='all'&&scope!==visibility)continue;
    if(/^(?:请|以后|你)?(?:别|不要|不许).{0,5}(?:亲昵|昵称|小名|宝贝|叫我|称呼我)/.test(text)){
      preference={status:'accepted',scope,kind:'reject-intimate'};nicknameAsked=true;continue;
    }
    const match=text.match(/^(?:(?:请|以后|你可以|就|还是)\s*)?(?:叫我|称呼我(?:为)?|我的昵称是)\s*[“"「]?([^，。！？!?\n”"」]{1,24})[”"」]?(?:[，。！？!?]|$)/d);
    if(match){preference={status:'accepted',scope,kind:'use',address:source.slice(...match.indices![1]!).trim()};nicknameAsked=true;}
  }
  return {preferences:preference?[preference]:[],nicknameAsked};
}

/**
 * Collects accepted address history in source order. Ledger ownership, not visible-event count, selects
 * event history. An unresolved event reference without a projection cannot fall back to B. Legacy sources
 * keep their exact former selection and bytes. Missing events contribute no history; getter errors propagate.
 * O(sources + events + observations); only this NPC's speech and player speech addressed to it are retained.
 */
export function sceneAddressMessages(
  state: SceneState,
  speakerId: string,
  eventSources?: EventConsumerProjection | null,
): {role: string; text: string}[] {
  let ledgerSourceIds: ReadonlySet<string> | undefined;
  let projectedEvents: readonly EventConsumerSource[] = [];
  if (eventSources != null) {
    // Only an explicit omission selects legacy. A copied event array is a programming error.
    if (typeof eventSources !== 'object' || Array.isArray(eventSources)) {
      throw new TypeError('invalid_event_consumer_projection');
    }
    const events = eventSources.events;
    const sourceIds = eventSources.ledgerSourceIds;
    if (!Array.isArray(events) || !(sourceIds instanceof Set)) {
      throw new TypeError('invalid_event_consumer_projection');
    }
    projectedEvents = events;
    ledgerSourceIds = sourceIds;
  }

  const bySource = new Map<string, EventConsumerSource[]>();
  for (const event of projectedEvents) {
    const key = JSON.stringify([event.id, event.revision]);
    const group = bySource.get(key) ?? [];
    group.push(event);
    bySource.set(key, group);
  }
  return state.sources.filter(source => source.status === 'accepted' && source.processing === 'ready')
    .flatMap(source => {
      const sourceKey = JSON.stringify([source.id, source.revision]);
      const events = bySource.get(sourceKey);
      if (ledgerSourceIds?.has(source.id)) {
        return (events ?? []).flatMap(event => {
          if (!event.observation.readers.includes(speakerId)) return [];
          if (isOwnEmotionLine({role: event.role, event}, speakerId)) {
            return [{role: 'assistant', text: event.observation.quote}];
          }
          return event.content.kind === 'PlayerUtterance' && event.observation.actorId === 'player'
            ? [{role: 'user', text: event.observation.quote}] : [];
        });
      }
      // Without ledger ownership, an unresolved reference cannot authorize a legacy body read.
      if (source.analysis?.plan?.observations.some(observation => Object.hasOwn(observation, 'ref'))) return [];

      if (source.role === 'assistant') {
        return source.speakerId === speakerId ? [{role: 'assistant', text: source.text}] : [];
      }
      const visible = source.analysis?.plan?.observations
        .filter(observation => observation.actorId === 'player' && observation.readers.includes(speakerId)
          && observation.kind === 'heard')
        .map(observation => observation.quote).join('\n');
      return visible ? [{role: 'user', text: visible}] : [];
    });
}

/** Produces existing address guidance from accepted legacy or event speech; relation authority errors propagate. */
export function sceneAddressGuidance(
  authority: SceneAuthority,
  scope: SceneScope,
  speakerId: string,
  envelope: SceneEnvelope,
  state: SceneState,
  emotion: Pick<EmotionState, 'behavioralSignals' | 'criticContext' | 'neural'>,
  eventSources?: EventConsumerProjection | null,
): string {
  const messages = sceneAddressMessages(state, speakerId, eventSources);
  const relation = authority.relationshipAnchor(scope, speakerId, 'player', state);
  const presentCount = envelope.presentIds.length + 1;
  const history = addressConversation(messages, presentCount > 2 ? 'public' : 'private');
  const suggestion = suggestAddress(
    {
      visibility: presentCount > 2 ? 'public' : 'private',
      presentCount,
      formality: 'casual',
      addresseeIdentityKnown: !!envelope.playerName?.trim(),
    },
    relation ? {
      sourceId: relation.sourceId,
      revision: relation.revision,
      status: 'accepted',
      direction: 'speaker-to-addressee',
      relations: relation.relations,
    } : undefined,
    history.preferences,
    {emotion, nicknameAsked: history.nicknameAsked},
  );

  return relationshipContext(authority.relationships(scope, speakerId, state))
    + `\n[XLDB 称谓建议] 当前上下文中已列明的显式称谓、拒绝和边界偏好优先于本建议。${suggestion.instruction}`
    + (suggestion.address ? `用户明确指定的称呼：${JSON.stringify(suggestion.address)}。` : '');
}

/** Collects scene-local expression inputs without reading or rendering memories. */
export function sceneExpressionOptions(authority:SceneAuthority,scope:SceneScope,speakerId:string,envelope:SceneEnvelope,
  state:SceneState,emotion:EmotionState,nowMs:number,waiting?:ContactAffect|null,directional=true,timeline?:SceneState['sources']){
  const mode=authority.interactions.modeOf(scope);
  const clock=mode?authority.interactions.clock(scope,nowMs):null;
  const story=clock?.kind==='story'||!clock&&authority.worldSettings(scope)?.mode==='story';
  if(!story&&timeline!==undefined)authority.storyClock.withLedgerRows(scope,()=>authority.storyClock.checkTimeline?.(scope,state.sources,timeline));
  const zone=clock?.timeZone??(story?'UTC':null);
  const hideStoryTime=Boolean(story&&(authority.worldSettings(scope)===null||
    authority.worldSettings(scope)!.publicTime===false));
  let clockTimeMs:number|null=nowMs;
  if(story){
    try {
      clockTimeMs = authority.expressionClockTime(scope, state.sources, nowMs, timeline);
    }
    catch(error){
      if(error instanceof Error&&error.message.startsWith('invalid_world_'))clockTimeMs=null;
      else throw error;
    }
  }
  return {actorId:speakerId,addresseeId:'player',timeZone:zone,clockKind:story?'story' as const:'realtime' as const,
    clockTimeMs,hideStoryTime,
    relationBasis:directional?'current_directional_projection' as const:'core_state_unspecified_target' as const,waiting,
    address:sceneAddressGuidance(authority,scope,speakerId,envelope,state,emotion)};
}
