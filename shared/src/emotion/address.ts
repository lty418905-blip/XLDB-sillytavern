import type { StableRelations,EmotionState } from './openher.ts';

/** A current, accepted directional relationship anchor. */
export interface AddressRelationAnchor {
  sourceId: string;
  revision: number;
  status: 'accepted';
  direction: 'speaker-to-addressee';
  relations: Pick<StableRelations, 'depth' | 'trust' | 'valence'>;
}

export type AddressPreference =
  | { status: 'accepted'; scope: 'all' | 'private' | 'public'; kind: 'use'; address: string }
  | { status: 'accepted'; scope: 'all' | 'private' | 'public'; kind: 'reject-intimate' }
  | { status: 'revoked'; scope: 'all' | 'private' | 'public'; kind: 'use' | 'reject-intimate'; address?: string };

export interface AddressSituation {
  visibility: 'private' | 'public';
  /** Includes the speaker and addressee. Two means a private pair. */
  presentCount: number;
  formality: 'casual' | 'formal';
  /** The current speaker may only use a personal name it is entitled to know. */
  addresseeIdentityKnown: boolean;
}

export interface AddressSuggestion {
  mode: 'explicit' | 'personal-name-allowed' | 'conservative';
  /** Present only when the user explicitly supplied this exact address. */
  address?: string;
  reason: 'explicit_preference' | 'intimacy_rejected' | 'grounded_long_term_relation' | 'public_or_formal' | 'missing_relation_anchor' | 'identity_not_known';
  instruction: string;
  tone?:'warming'|'settled'|'strained';
  askNickname?:boolean;
}

export interface AddressAffect {
  emotion:Pick<EmotionState,'behavioralSignals'|'criticContext'>;
  nicknameAsked:boolean;
}

const MAX_ADDRESS_LENGTH = 120;

/**
 * Produces a narrow presentation hint. It never invents a nickname, changes
 * state. Callers provide the already-filtered
 * directional anchor and only the preferences visible in this scene.
 */
export function suggestAddress(
  situation: AddressSituation,
  anchor: AddressRelationAnchor | undefined,
  preferences: readonly AddressPreference[] = [],
  affect?:AddressAffect,
): AddressSuggestion {
  validateSituation(situation);
  const applicable = preferences.filter(preference => preference.status === 'accepted' &&
    (preference.scope === 'all' || preference.scope === situation.visibility));
  if (applicable.some(preference => preference.kind === 'reject-intimate')) return conservative('intimacy_rejected');
  const explicit = applicable.find((preference): preference is Extract<AddressPreference,{kind:'use';status:'accepted'}> =>
    preference.kind === 'use' && typeof preference.address === 'string' && validAddress(preference.address));
  if (explicit) return {
    mode: 'explicit', address: explicit.address, reason: 'explicit_preference',
    instruction: '只使用用户明确指定的称谓；不扩写、变形或另造昵称。',
  };
  if(affect){
    const warmth=affect.emotion.behavioralSignals.warmth;
    const conflict=affect.emotion.criticContext.conflictLevel;
    if(Number.isFinite(warmth)&&Number.isFinite(conflict)){
      const privateCasual=situation.visibility==='private'&&situation.presentCount===2&&situation.formality==='casual';
      const grounded=anchor&&validAnchor(anchor)&&isGroundedPositiveRelation(anchor.relations);
      const warming=privateCasual&&conflict<.5&&(warmth>=.6||grounded);
      const tone=conflict>=.5?'strained':warming?'warming':'settled';
      const askNickname=warming&&!affect.nicknameAsked;
      const instruction=warming
        ?'当前情绪更温暖，可随感情自然升温，把全名或姓氏加身份的正式称呼逐渐换成对方已明确透露的名；只有全名时不要自行拆姓猜名。'+
          (askNickname?'尚未问过昵称，可在合适的话题中自然问一次对方喜欢被怎么称呼；这是可选交流，不必本轮强行插入。':'之前已讨论过称呼，沿用已确认偏好；不要重复追问昵称。')
        :tone==='strained'?'当前情绪存在紧张或冲突，称呼可更克制，结合人设选择全名、已知身份或省略称呼；不是固定降级或惩罚用户。'
        :'当前称呼可保留全名、已知姓氏加身份或原有叫法，随人设和语境自然变化。';
      return {mode:grounded&&situation.addresseeIdentityKnown?'personal-name-allowed':'conservative',
        reason:grounded?'grounded_long_term_relation':situation.addresseeIdentityKnown?'missing_relation_anchor':'identity_not_known',
        tone,askNickname,instruction:instruction+'这些是情绪驱动的表达倾向，不是固定台词；未知姓名不编造，称呼约定优先。'};
    }
  }
  if (!situation.addresseeIdentityKnown) return conservative('identity_not_known');
  if (situation.visibility === 'public' || situation.presentCount > 2 || situation.formality === 'formal') {
    return conservative('public_or_formal');
  }
  if (!anchor || !validAnchor(anchor)) return conservative('missing_relation_anchor');
  if (isGroundedPositiveRelation(anchor.relations)) return {
    mode: 'personal-name-allowed', reason: 'grounded_long_term_relation',
    instruction: '可自然使用对方已知姓名，但不必强行称呼；不得自行创造昵称、亲属称谓或亲密身份。',
  };
  return conservative('missing_relation_anchor');
}

function conservative(reason:AddressSuggestion['reason']):AddressSuggestion {
  return {mode:'conservative',reason,instruction:'使用已知全名、明确身份称谓，或不使用称谓；不得擅自使用亲昵称呼。'};
}

function isGroundedPositiveRelation(relations:Pick<StableRelations,'depth'|'trust'|'valence'>):boolean {
  return relations.depth >= 0.65 && relations.trust >= 0.7 && relations.valence >= 0.35;
}

function validAnchor(anchor:AddressRelationAnchor):boolean {
  return !!anchor.sourceId && anchor.sourceId.length <= 500 && Number.isSafeInteger(anchor.revision) && anchor.revision > 0 &&
    anchor.status === 'accepted' && anchor.direction === 'speaker-to-addressee' &&
    [anchor.relations.depth,anchor.relations.trust].every(value => Number.isFinite(value) && value >= 0 && value <= 1) &&
    Number.isFinite(anchor.relations.valence) && anchor.relations.valence >= -1 && anchor.relations.valence <= 1;
}

function validAddress(value:string):boolean { return !!value.trim() && value.length <= MAX_ADDRESS_LENGTH; }

function validateSituation(value:AddressSituation):void {
  if (!value || !['private','public'].includes(value.visibility) || !['casual','formal'].includes(value.formality) ||
    !Number.isSafeInteger(value.presentCount) || value.presentCount < 2 || typeof value.addresseeIdentityKnown !== 'boolean') {
    throw new Error('invalid_address_situation');
  }
}
