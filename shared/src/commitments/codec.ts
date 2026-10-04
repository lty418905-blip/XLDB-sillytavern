import type {
  CommitmentCandidate, CommitmentCandidateTerm, CommitmentPrompt, CommitmentRecord, CommitmentTargetCandidate,
  CommitmentTerm, CommitmentFoldTerm, CommitmentValidationInput, ValidatedCommitmentOperation, ContactRestrictionCandidate, ContactRestriction, CommitmentMode,
} from './types.ts';
import {resolveCommitmentTime} from './time.ts';
import {contactLiftRequest,contactWindowContains,noContactRequest,resolveContactRestriction,storedContactRestriction,userRangeMatches} from './contact.ts';

const MAX_ID = 200;
const MAX_TEXT = 8_000;
const MAX_OPERATIONS = 64;

/** Companion-only contact windows and feedback hardening; never part of a roleplay extraction contract. */
const COMPANION_CONTACT_RULE =
  'Companion-only contactRestriction may mark an explicit no-contact interval or daily local quiet hours in a propose/establish/revise operation. Copy startQuote and endQuote exactly from the current quote; never calculate timestamps or local minutes. The host resolves them. For a duration counted from now, such as 开会这两小时别发, use kind interval with startQuote and endQuote both equal to the exact duration phrase (两小时). For a range that starts now and only names its end, such as 七点前别找我, 七点之前别发, 到七点为止别找我, or 现在到七点别找我, use kind interval and copy only the end phrase: endQuote is the exact end phrase (七点前, 七点之前, 到七点为止, or 七点), and startQuote repeats that same phrase, or is the user\'s own 现在 when they said it; never invent a start time, the host starts the window at the message time. Bare clocks such as 十点到七点 and 24-hour clocks after a period such as 晚上21点 are allowed; the host picks the reading. A time range the user asks not to be contacted in (别找我, 别打扰, 不要发消息, 别联系, 勿扰, 别烦我 and similar) is the user\'s hard window: the host always marks it hard and never lets it be soft; there is no exception inside it. From the user\'s own message, extract a contactRestriction only when the user asks not to be contacted; a bare schedule the user mentions (开会, 加班, 睡觉, such as 我明天三点到五点开会) is a state, not a window, so emit none for it; if such a range is nevertheless extracted without a no-contact request, the host records it as her soft window, never the user\'s hard window. If the character then offers to stay quiet in it (那三点到五点我不打扰你), that is her own soft window, as is a quiet time she proposes about her own life. When she restates or changes the times of a commitment whose window is the user\'s, it stays the user\'s hard window. When a revise or replacement proposal changes a commitment that has a user\'s hard window and the current source does not restate a window, omit contactRestriction: the host keeps the existing window. Only when the user\'s own current words explicitly lift that window (可以找我, 随时找我, 不用…了, 取消, 解除, 不限制) may a user-source replacement set contactRestriction to null. When the user\'s own current words ask not to be contacted in the times of an existing commitment whose window is soft without restating the times (那段时间别找我), emit a user-source replacement proposal bound to it and omit contactRestriction: the host makes that window the user\'s hard window. Never emit contactRestriction for a state without an explicit time range, such as 这几天比较忙, 可能没空, 我去睡了, 晚安; the host treats those as states, not windows, and drops such a restriction. For a direct user negative reaction to an actual quiet-hour exception, emit harden with the exact negative feedback quote and a bound active target; this makes the remaining restriction strict without new NPC consent. Do not harden from roleplay, an assistant message, generic unhappiness, or a guessed target.';

export function extractCommitmentPrompt(input: CommitmentValidationInput): CommitmentPrompt {
  assertTimeContext(input);
  return {
    system: [
      'Extract only explicit proposals, confirmations of existing proposals, established commitments, revisions, fulfillment, and cancellation.',
      'Classify the current source before matching existing targets. Present facts, completed actions, and preparations do not by themselves create an obligation or accept a proposal. Existing proposals supply reference context only; their presence is not evidence of acceptance. Require the current speaker to explicitly propose, accept, establish, change, or cancel an obligation. An explicit acceptance of a uniquely identified proposal is valid; mere consistency with its expected behavior is not. For fulfillment of an already active finite obligation, a report that its required act is actually complete can be evidence; it cannot retroactively accept a proposed obligation. Return an empty operations array for ordinary memory facts. Do not convert a third party or an addressee into the recipient of the obligation.',
      '确认existing中status=proposed的提议必须使用action:"confirm"，输出operationId、action、targetId、quote、evidence，以及需要时的targetExcerpt或目标版本/来源引用。不得复制或修改旧content、名单、agreement或term。当前只需提供本轮实际同意者的逐字证据；脚本继承原条款并累计同意，未全部同意仍是提议。改约确认只confirm新提议，旧约由脚本自动supersede，不另发cancel。不要把这种跨轮确认写成establish。',
      '修改existing中status=active的约定时，revise只用于当前source逐字包含原约定所需全部同意者的明确同意：mutual需要原participants全部同意，unilateral需要原obligors全部同意；不得继承旧同意。单方提出改期须用propose、新commitmentId和旧约targetId；旧约在新提议获得所需同意前继续有效。真正revise时commitmentId必须与targetId不同。',
      '相对改期的content只取本轮quote中的连续原文，例如“改为明天下午四点，地点和事情不变”；不要补写旧任务。targetExcerpt只取本轮quote与旧content共有的逐字短片段，例如“三点”，不要复制本轮未说出的旧全文。',
      '必须逐字提取：content直接复制text中的连续原文，可以直接与quote相同。禁止翻译成英文、转述为第三人称、总结请求或补写内容。quote也必须是text中的连续原文，并完整包含每个evidence.quote；证据不能比quote更长。',
      'Copy quote, evidence.quote, content, deadlineQuote, and reminderQuote verbatim from the source. Do not infer consent, participants, readers, deadlines, or permanence.',
      'unknown means the source gives no usable duration. persistent is only for an explicitly continuing rule with no end condition.',
      'For deadline, return its exact time phrase as deadlineQuote and an optional exact reminder phrase as reminderQuote. Never calculate or return dueAtMs/remindAtMs; the host script computes them from the accepted-source clock. If the phrase is missing or ambiguous, use unknown.',
      'A unilateral commitment lists only its actual obligor. A mutual agreement needs evidence spoken by every participant.',
      'For a direct user source, only userActorId is the speaker; the target NPC is an addressee, not the speaker. Reported third-party speech is not direct consent. For a direct assistant source, only speakerId speaks. Scene speech by another actor requires explicit grounded identity provenance in that observation.',
      '在已接受的assistant跑团正文中，若叙述逐字明确写出某NPC本人答应了可唯一定位的提议，例如“林舟点头应下”，可以据此对该提议输出confirm；同意不必只出现在引号内的台词。有speakerId时该NPC必须与speakerId相同；无speakerId的scene正文须由当前观察的actorId归属该NPC，并以覆盖同意原文的identityQuote或已核验的identityEvidence证实身份。只写“点头”、记住时间、准备行动、旁人的安心感或行为符合安排都不等于同意。role=user对NPC同意的间接转述不能代替本人同意；场景中NPC的现场直接发言仍须有该观察的明确身份依据identityEvidence，按既有规则处理。',
      '名单必须满足 obligors ⊆ participants ⊆ readers；readers必须同时属于所引观察的合法读者交集。来源role=user时userActorId也是合法读者。unilateral恰好一名obligor。建立mutual约定须每名participant都有其本人逐字同意证据；未同意时仅propose。',
      'For propose, establish, or revise, every operation MUST include commitmentId, content, nonempty participants, nonempty obligors, nonempty readers, agreement, and term, in addition to operationId/action/quote/evidence. A proposal changing an active commitment uses targetId and keeps its parties and agreement. To establish an existing proposal, use its commitmentId and targetId. revise additionally requires targetId naming the existing commitment. fulfill and cancel require targetId. Never output a partial definition; when the source does not support a complete commitment, omit that operation.',
      'fulfill and cancel apply only to an existing record whose status is active. A proposed record cannot be fulfilled or cancelled; preparation or performance alone does not confirm that proposal. Completion of the specific required act may fulfill an active finite obligation after source and target binding; one compliant act never ends a persistent rule.',
      'A request telling someone what to do is only a proposal unless that obligor explicitly agrees; do not invent their consent. Unknown duration still requires term:{"kind":"unknown"}.',
      'Readers must be limited to principals who can know the cited observation. Return {"operations":[]} only when no grounded operations exist.',
      'existing contains every currently actionable target in a compact host-authored form. A unique adjacent proposal may be confirmed from the current quote. Otherwise include targetExcerpt only when one exact distinguishing span occurs verbatim in both the current quote and that target content, and no other actionable target for the operation contains it. targetExcerpt identifies the referenced object; it does not prove consent. If the current source uses only a generic or relative reference that cannot uniquely identify an older target, omit the operation. Each target operation still needs its own current-source quote and evidence. Never reuse one generic quote/evidence to transform several targets. A persistent target cannot be fulfilled by one compliant act; omit that operation.',
      ...(input.mode==='companion'?[COMPANION_CONTACT_RULE]:[]),
    ].join(' '),
    input: {
      sourceId: input.source.id,
      sourceRevision: input.source.revision,
      role: input.source.role,
      ...(input.source.speakerId===undefined?{}:{speakerId:input.source.speakerId}),
      text: input.source.text,
      observations: input.plan.observations.map(observation=>({...observation,readers:[...commitmentReaders(input,observation)]})),
      actorIds: input.actorIds,
      ...(input.userActorId === undefined ? {} : {userActorId: input.userActorId}),
      mode: input.mode,
      ...(input.clockTimeMs===undefined?{}:{clockTimeMs:input.clockTimeMs}),
      ...(input.timeZone===undefined?{}:{timeZone:input.timeZone}),
      ...(input.responseTo===undefined?{}:{responseTo:input.responseTo}),
      ...(input.contactFeedbackTargets===undefined?{}:{contactFeedbackTargets:input.contactFeedbackTargets}),
      ...(input.responseContext===undefined?{}:{responseContext:input.responseContext}),
      ...(input.existing===undefined?{}:{existing:input.existing}),
    },
    schema: commitmentSchemaFor(input.mode),
  };
}

export function validateCommitmentOperations(
  input: CommitmentValidationInput,
  raw: unknown,
): ValidatedCommitmentOperation[] {
  if(input.storyDeadlines==='fold'&&input.mode!=='roleplay')throw new Error('invalid_commitment_deadline_mode');
  assertTimeContext(input);
  const root = exactObject(raw, ['operations'], 'invalid_commitment_output');
  if (!Array.isArray(root.operations) || root.operations.length > MAX_OPERATIONS) throw new Error('invalid_commitment_operations');
  const actors = new Set(input.actorIds);
  const operationIds = new Set<string>();
  const result:ValidatedCommitmentOperation[]=[];
  for(const value of roleplayOperations(input,root.operations)) {
    const candidate = copiedUserWindow(input,candidateOf(value));
    if (operationIds.has(candidate.operationId)) throw new Error('invalid_commitment_operation_id');
    operationIds.add(candidate.operationId);
    const grounded=groundCandidate(input, actors, candidate);
    const target=bindTarget(input,grounded);
    // A replacement whose new window was dropped as a time-less state must not silently lift the target's window.
    if(candidate.contactRestriction&&!grounded.contactRestriction&&target?.contactRestriction)throw new Error('invalid_contact_time');
    // A fresh revision or replacement that does not restate a window keeps the user's own hard window: the window is
    // copied into the stored operation (marked with the target it came from), so a rebuild only replays what was stored.
    const creates=grounded.action==='propose'||grounded.action==='establish'||grounded.action==='revise';
    // A window the user made hard by negative feedback (origin hardened) is kept the same way.
    const userWindow=input.revalidate!==true&&creates&&userBoundary(target?.contactRestriction)?target!.contactRestriction:undefined;
    const inherit=()=>{const {inheritedFrom:_previous,...window}=userWindow!;return {...window,inheritedFrom:target!.id};};
    // The user's later no-contact request about the bound target's soft window (「那段时间别找我」) makes that window the
    // user's hard window when it is not restated with new times: it is copied, stamped hard/user and marked inherited.
    const promoted=input.revalidate!==true&&creates&&candidate.contactRestriction===undefined&&userPromotesTarget(input,candidate);
    if(promoted){const {inheritedFrom:_previous,...window}=target!.contactRestriction!;
      grounded.contactRestriction={...window,level:'hard',origin:'user',inheritedFrom:target!.id};}
    else if(userWindow&&candidate.contactRestriction===undefined)grounded.contactRestriction=inherit();
    // Her own words may not move or narrow the user's hard window. A restatement from a source other than the user takes
    // (a) new times the user asked for in the message it answers (userWordedRange), or (b) a window covering the old one;
    // (c) anything else keeps the old window unchanged with the host mark (never an error, so the source does not stall).
    else if(userWindow&&input.source.role!=='user'&&grounded.contactRestriction){
      const rule=grounded.contactRestriction,{inheritedFrom:_previous,...old}=userWindow;
      if(!userWordedRange(input,rule)&&!contactWindowContains(rule,old))grounded.contactRestriction=inherit();
    }
    // One compliant act does not consume a continuing rule. Drop it only after
    // the speaker, source, and target have passed the same checks as other ops.
    if(target?.status==='active'&&target.term.kind==='persistent'&&grounded.action==='fulfill')continue;
    result.push({
      ...grounded,
      ...(target?{targetRevision:target.revision,targetSourceId:target.targetSourceId,targetSourceRevision:target.targetSourceRevision}:{}),
      ...(input.contractVersion===undefined?{}:{contractVersion:input.contractVersion}),
      sourceId: input.source.id,
      sourceRevision: input.source.revision,
      sourceAcceptedAtMs: input.source.acceptedAtMs,
      mode: input.mode,
    } satisfies ValidatedCommitmentOperation);
  }
  assertDistinctTargetClaims(result);
  return result;
}

/**
 * Roleplay has no contact windows: before any candidate is decoded, a fresh roleplay extraction drops whole harden
 * operations and the contactRestriction key (null included), so a stray companion field never fails the batch. Stored
 * roleplay operations never carry either, so revalidation passes them through unchanged.
 */
function roleplayOperations(input:CommitmentValidationInput,operations:readonly unknown[]):readonly unknown[] {
  if(input.mode!=='roleplay'||input.revalidate===true)return operations;
  return operations.flatMap(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return [value];
    const object=value as Record<string,unknown>;
    if(object.action==='harden')return [];
    if(!Object.hasOwn(object,'contactRestriction'))return [value];
    const {contactRestriction:_dropped,...rest}=object;
    return [rest];
  });
}

/** Compact transition view with no count cap; completed records cannot transition. */
export function commitmentTransitionTargets(
  records:readonly CommitmentRecord[],responseTo?:{id:string;revision:number},
):CommitmentTargetCandidate[]{
  return records.flatMap(record=>{
    if(record.status!=='proposed'&&record.status!=='active')return [];
    const required=[...requiredConsent(record.agreement,record.participants,record.obligors)];
    const consent=new Set(record.consentActorIds??[]);
    const allowedActions:CommitmentTargetCandidate['allowedActions']=record.status==='proposed'
      ?['confirm']
      :['propose','revise',...(record.term.kind==='persistent'?[]:['fulfill'] as const),'cancel',
        ...(record.mode==='companion'&&record.contactRestriction?.level==='soft'?['harden'] as const:[])];
    return [{
      id:record.id,revision:record.revision,status:record.status,agreement:record.agreement,content:record.content,
      ...(record.status==='proposed'&&record.replaces?{replaces:record.replaces}:{}),
      participants:[...record.participants],obligors:[...record.obligors],term:
        record.term.kind==='unknown'&&record.term.deadlineQuote!==undefined||
        record.term.kind==='deadline'&&record.term.domain==='story_clock'
          ?{kind:'deadline',clock:'story',deadlineQuote:record.term.deadlineQuote!,
            ...(record.term.reminderQuote===undefined?{}:{reminderQuote:record.term.reminderQuote})}:record.term,
      // The host's inheritance mark stays out of the model's view: the model copying it back must not matter.
      ...(record.contactRestriction?{contactRestriction:withoutInheritance(record.contactRestriction)}:{}),
      targetSourceId:record.createdSourceId,targetSourceRevision:record.createdSourceRevision,
      latestSourceId:record.latestSourceId,latestSourceRevision:record.latestSourceRevision,
      requiredConsentActorIds:required,missingConsentActorIds:required.filter(actor=>!consent.has(actor)),
      adjacent:responseTo?.id===record.createdSourceId&&responseTo.revision===record.createdSourceRevision,
      allowedActions,
    }];
  });
}

/**
 * A fresh, non-user source that restates the bound target's user hard window by copying it (the target's own quotes, or
 * quotes that are not in the current quote) is treated as not restating it at all, so the window is inherited instead of
 * failing on quotes she never said.
 */
function copiedUserWindow(input:CommitmentValidationInput,candidate:CommitmentCandidate):CommitmentCandidate {
  const rule=candidate.contactRestriction;
  if(!rule)return candidate;
  // The user's no-contact request that copies the soft target's own quotes without saying them is the promotion above.
  const soft=userPromotesTarget(input,candidate)?input.existing?.find(item=>item.id===candidate.targetId)?.contactRestriction:undefined;
  if(soft&&rule.startQuote===soft.startQuote&&rule.endQuote===soft.endQuote&&
    (!candidate.quote.includes(rule.startQuote)||!candidate.quote.includes(rule.endQuote))){
    const {contactRestriction:_copy,...rest}=candidate;
    return rest;
  }
  const window=userHardTarget(input,candidate);
  // The user's own new times stand even when her reply does not repeat them (「好的，听你的」).
  if(!window||userWordedRange(input,rule))return candidate;
  const copied=(rule.startQuote===window.startQuote&&rule.endQuote===window.endQuote)||
    !candidate.quote.includes(rule.startQuote)||!candidate.quote.includes(rule.endQuote);
  if(!copied)return candidate;
  const {contactRestriction:_copy,...rest}=candidate;
  return rest;
}

/**
 * On a fresh extraction from a source other than the user, the bound target's user hard window (origin user, or a self
 * window the user hardened by negative feedback), if any.
 */
function userHardTarget(input:CommitmentValidationInput,candidate:CommitmentCandidate):ContactRestriction|undefined {
  if(input.revalidate===true||input.source.role==='user'||!candidate.targetId)return undefined;
  const window=input.existing?.find(item=>item.id===candidate.targetId)?.contactRestriction;
  return userBoundary(window)?window:undefined;
}

/** A hard window the user set (origin user) or made hard by negative feedback (origin hardened). */
function userBoundary(window:ContactRestriction|undefined):boolean {
  return window?.level==='hard'&&(window.origin==='user'||window.origin==='hardened');
}

/**
 * On a fresh extraction from the user's own message that asks not to be contacted and does not lift contact, whether the
 * bound target has a soft window that this message makes the user's hard window (the boundary split over two messages:
 * 「我十一点到七点睡觉。」 then 「那段时间别找我。」).
 */
function userPromotesTarget(input:CommitmentValidationInput,candidate:CommitmentCandidate):boolean {
  if(input.revalidate===true||input.source.role!=='user'||!candidate.targetId)return false;
  if(!noContactRequest(input.source.text)||contactLiftRequest(input.source.text))return false;
  return input.existing?.find(item=>item.id===candidate.targetId)?.contactRestriction?.level==='soft';
}

/**
 * Whether the user message this source answers asks for exactly these new times: both quotes are in it, it asks not to be
 * contacted, and it does not lift contact (「九点到十点随时找我」, 「我十一点到七点睡觉」 do not move a window).
 */
function userWordedRange(input:CommitmentValidationInput,rule:{startQuote:string;endQuote:string}):boolean {
  const answered=input.responseContext?.role==='user'?input.responseContext.text:'';
  return answered.includes(rule.startQuote)&&answered.includes(rule.endQuote)&&noContactRequest(answered)&&!contactLiftRequest(answered);
}

/** A restriction without the host-only `inheritedFrom` mark, for views shown to a model. */
export function withoutInheritance(restriction:ContactRestriction):ContactRestriction {
  const {inheritedFrom:_mark,...window}=restriction;return window;
}

/** User corrections still become a normal accepted, quoted operation. */
export function makeCorrectionCandidate(value: unknown): CommitmentCandidate {
  return candidateOf(value);
}

function candidateOf(value: unknown): CommitmentCandidate {
  const object = keyedObject(value,
    ['operationId', 'action', 'quote', 'evidence'],
    ['commitmentId', 'targetId', 'targetRevision', 'targetSourceId', 'targetSourceRevision', 'targetExcerpt', 'contractVersion',
      'content', 'participants', 'obligors', 'readers', 'agreement', 'term','contactRestriction'],
    'invalid_commitment_operation');
  const action = oneOf(object.action, ['propose', 'confirm', 'establish', 'revise', 'fulfill', 'cancel','harden'] as const, 'invalid_commitment_action');
  if(action==='confirm' && ['commitmentId','content','participants','obligors','readers','agreement','term'].some(key=>object[key]!==undefined))
    throw new Error('invalid_commitment_confirmation');
  const base: CommitmentCandidate = {
    operationId: identifier(object.operationId, 'invalid_commitment_operation_id'),
    action,
    quote: boundedText(object.quote, 'invalid_commitment_quote'),
    evidence: evidenceOf(object.evidence),
  };
  if (object.commitmentId !== undefined) base.commitmentId = identifier(object.commitmentId, 'invalid_commitment_id');
  if (object.targetId !== undefined && object.targetId !== null) base.targetId = identifier(object.targetId, 'invalid_commitment_target');
  if(object.targetRevision!==undefined)base.targetRevision=positiveRevision(object.targetRevision,'invalid_commitment_target_revision');
  if(object.targetSourceId!==undefined)base.targetSourceId=identifier(object.targetSourceId,'invalid_commitment_target_source');
  if(object.targetSourceRevision!==undefined)base.targetSourceRevision=positiveRevision(object.targetSourceRevision,'invalid_commitment_target_source');
  if(object.targetExcerpt!==undefined)base.targetExcerpt=boundedText(object.targetExcerpt,'invalid_commitment_target_binding');
  if(object.contractVersion!==undefined){if(object.contractVersion!==2)throw new Error('invalid_commitment_contract_version');base.contractVersion=2;}
  if (object.content !== undefined) base.content = boundedText(object.content, 'invalid_commitment_content');
  if (object.participants !== undefined) base.participants = identifiers(object.participants, 'invalid_commitment_participants');
  if (object.obligors !== undefined) base.obligors = identifiers(object.obligors, 'invalid_commitment_obligors');
  if (object.readers !== undefined) base.readers = identifiers(object.readers, 'invalid_commitment_readers');
  if (object.agreement !== undefined) base.agreement = oneOf(object.agreement, ['unilateral', 'mutual'] as const, 'invalid_commitment_agreement');
  if (object.term !== undefined) base.term = termOf(object.term);
  if(object.contactRestriction!==undefined)base.contactRestriction=object.contactRestriction===null?null:contactRestrictionOf(object.contactRestriction);

  const creates = action === 'propose' || action === 'establish' || action === 'revise';
  if (creates) {
    if (!base.commitmentId || !base.content || !base.participants?.length || !base.obligors?.length ||
      !base.readers?.length || !base.agreement || !base.term) throw new Error('invalid_commitment_definition');
    if (action === 'revise' && !base.targetId) throw new Error('invalid_commitment_target');
  } else if (!base.targetId) throw new Error('invalid_commitment_target');
  if(!creates&&base.contactRestriction!==undefined)throw new Error('invalid_contact_restriction');
  if(action==='harden'&&['commitmentId','content','participants','obligors','readers','agreement','term'].some(key=>object[key]!==undefined))
    throw new Error('invalid_contact_feedback');
  if(base.targetExcerpt&&!base.targetId)throw new Error('invalid_commitment_target_binding');
  return base;
}

type GroundedCandidate=Omit<CommitmentCandidate,'term'|'contactRestriction'>&{term?:CommitmentTerm|CommitmentFoldTerm;contactRestriction?:ContactRestriction|null};
function groundCandidate(input: CommitmentValidationInput, actors: Set<string>, candidate: CommitmentCandidate): GroundedCandidate {
  if (!input.source.text.includes(candidate.quote)) throw new Error('invalid_commitment_quote');
  if (candidate.content !== undefined && !input.source.text.includes(candidate.content)) throw new Error('invalid_commitment_content');
  const lists = [candidate.participants ?? [], candidate.obligors ?? [], candidate.readers ?? []];
  if (lists.some(list => list.some(actor => !actors.has(actor)))) throw new Error('invalid_commitment_actor');
  if (candidate.participants && candidate.obligors?.some(actor => !candidate.participants!.includes(actor))) throw new Error('invalid_commitment_obligor');
  if (candidate.participants?.some(actor => !candidate.readers!.includes(actor))) throw new Error('invalid_commitment_reader');
  if (candidate.agreement === 'unilateral' && candidate.obligors?.length !== 1) throw new Error('invalid_commitment_agreement');
  if (candidate.term?.kind === 'deadline' &&
    ((input.mode === 'companion' && candidate.term.clock !== 'real') ||
      (input.mode === 'roleplay' && candidate.term.clock !== 'story')))
    throw new Error('invalid_commitment_clock');
  if(candidate.contactRestriction&&input.mode!=='companion')throw new Error('invalid_contact_mode');

  const relevant = input.plan.observations.filter(observation =>
    input.source.text.includes(observation.quote) &&
    (candidate.quote.includes(observation.quote) || observation.quote.includes(candidate.quote)));
  if (!relevant.length) throw new Error('invalid_commitment_evidence');
  // Every reader must know every observation span used by the commitment
  // quote. A union would leak a private clause when the quote also contains a
  // public clause.
  const allowedReaders = commitmentReaders(input,relevant[0]!);
  for (const observation of relevant.slice(1)) {
    const observationReaders = commitmentReaders(input,observation);
    for (const reader of [...allowedReaders]) if (!observationReaders.has(reader)) allowedReaders.delete(reader);
  }
  if ((candidate.readers ?? []).some(reader => !allowedReaders.has(reader))) throw new Error('invalid_commitment_reader');
  if (!candidate.evidence.length) throw new Error('invalid_commitment_evidence');
  const strict=(input.contractVersion??candidate.contractVersion)===2;
  for (const evidence of candidate.evidence) {
    if (!actors.has(evidence.actorId) || !input.source.text.includes(evidence.quote) || !candidate.quote.includes(evidence.quote))
      throw new Error('invalid_commitment_evidence');
    if (!groundedEvidenceActor(input,relevant,evidence,strict))
      throw new Error('invalid_commitment_evidence');
  }
  const evidenceActors = new Set(candidate.evidence.map(evidence => evidence.actorId));
  if (candidate.action === 'propose' && !(candidate.participants ?? []).some(actor => evidenceActors.has(actor)))
    throw new Error('invalid_commitment_evidence');
  if ((candidate.action === 'establish' || candidate.action === 'revise') &&
    requiredConsent(candidate.agreement!, candidate.participants!, candidate.obligors!).some(actor => !evidenceActors.has(actor)))
    throw new Error('invalid_commitment_consent');
  if(candidate.action==='harden'){
    if(input.mode!=='companion'||input.source.role!=='user'||input.userActorId===undefined||
      candidate.evidence.length!==1||candidate.evidence[0]?.actorId!==input.userActorId||
      !negativeContactFeedback(candidate.evidence[0].quote))
      throw new Error('invalid_contact_feedback');
  }
  let contactRestriction:GroundedCandidate['contactRestriction'];
  if(candidate.contactRestriction===null){
    // Only the user's own words that lift a window (可以找我, 随时找我, 取消, 解除...) may clear it, in a replacement that
    // names the old commitment; omission never does.
    if(input.mode!=='companion'||input.source.role!=='user'||!candidate.targetId||input.userActorId===undefined||
      !candidate.evidence.some(item=>item.actorId===input.userActorId)||!contactLiftRequest(candidate.quote))
      throw new Error('invalid_contact_restriction');
    contactRestriction=null;
  } else if(candidate.contactRestriction){
    // A window inherited from the target keeps the target's quotes; only a stored operation may carry that mark. A fresh
    // extraction drops a model-supplied mark silently, like its level and origin (the model may copy an existing window).
    const {inheritedFrom:_modelMark,...fresh}=candidate.contactRestriction;
    const rule=input.revalidate===true?candidate.contactRestriction:fresh as ContactRestrictionCandidate;
    const inherited=rule.inheritedFrom!==undefined;
    if(inherited&&rule.inheritedFrom!==candidate.targetId)throw new Error('invalid_contact_restriction');
    // Quotes come from her words, or, restating a user hard window, from the user's own new times she answers. A stored
    // operation being revalidated has neither the target nor the answered message; its complete stored times were checked
    // when it was extracted, so they stand (like an inherited window). A stored row without complete times still fails closed.
    const storedComplete=input.revalidate===true&&storedContactRestriction(rule,'soft')!==null;
    if(!inherited&&!storedComplete&&(!candidate.quote.includes(rule.startQuote)||!candidate.quote.includes(rule.endQuote))&&
      !(userHardTarget(input,candidate)&&userWordedRange(input,rule)))
      throw new Error('invalid_contact_restriction');
    // The source decides level and origin, never the model, by one rule for both sources: a range is the user's hard window
    // only when the user's text (the user's own message on a user source; the answered user message on her echo) holds both
    // quotes (on her echo, or a range resolving to the same window), asks not to be contacted and does not lift contact, or when it restates the window of a commitment whose
    // window is the user's (level and origin may not change; whether the times may is decided with the bound target in
    // validateCommitmentOperations). A range the user states without asking not to be contacted is not a boundary (being
    // busy does not mean a message is unwelcome; user decision 2026-09-28): it is her soft window, like a bare schedule
    // such as 我明天三点到五点开会 followed by her own offer. A stored
    // operation being revalidated (`revalidate`) keeps its stored times, level and origin without parsing its quotes again
    // (legacy records keep theirs, and none is added). A state without any time word resolves to nothing and is dropped;
    // the rest is kept. Time words that do not resolve throw.
    const targetWindow=candidate.targetId===undefined?undefined:
      input.existing?.find(item=>item.id===candidate.targetId)?.contactRestriction;
    const userWindowTarget=targetWindow?.origin==='user';
    // A restatement of a window the user hardened by feedback stays hard with that origin (no window_end is added).
    const hardenedTarget=!userWindowTarget&&targetWindow?.origin==='hardened'&&targetWindow.level==='hard';
    const userText=input.source.role==='user'?input.source.text:
      input.responseContext?.role==='user'?input.responseContext.text:'';
    // Her echo may word the user's times differently (十点 / 七点 answered 晚上十点 / 早上七点): the range is still the
    // user's when her quotes resolve to the same window as a range in the answered user message.
    const userAsked=noContactRequest(userText)&&!contactLiftRequest(userText)&&
      (userText.includes(rule.startQuote)&&userText.includes(rule.endQuote)||
        input.source.role!=='user'&&userRangeMatches(userText,rule,input));
    const userTimed=userWindowTarget||userAsked;
    const stored=input.revalidate===true?storedContactRestriction(rule,userTimed?'hard':'soft'):null;
    const stamp=input.revalidate===true?{level:rule.level??(userTimed?'hard' as const:'soft' as const),...(rule.origin?{origin:rule.origin}:{})}:
      {level:userTimed||hardenedTarget?'hard' as const:'soft' as const,
        origin:userTimed?'user' as const:hardenedTarget?'hardened' as const:'self' as const};
    contactRestriction=stored??resolveContactRestriction(rule,input,stamp)??undefined;
  }
  const {contactRestriction:_candidateRestriction,...baseCandidate}=candidate;
  const restricted=contactRestriction===undefined?{}:{contactRestriction};
  if(candidate.term?.kind!=='deadline')return {...baseCandidate,...restricted} as GroundedCandidate;
  if(!candidate.quote.includes(candidate.term.deadlineQuote)||!input.source.text.includes(candidate.term.deadlineQuote))
    throw new Error('invalid_commitment_deadline_quote');
  if(candidate.term.reminderQuote!==undefined&&(!candidate.quote.includes(candidate.term.reminderQuote)||!input.source.text.includes(candidate.term.reminderQuote)))
    throw new Error('invalid_commitment_reminder_quote');
  if(input.mode==='roleplay'&&(input.revalidate===true?candidate.term.dueAtMs===undefined:input.storyDeadlines==='fold'))
    return {...baseCandidate,...restricted,term:{kind:'deadline',clock:'story',deadlineQuote:candidate.term.deadlineQuote,
      ...(candidate.term.reminderQuote===undefined?{}:{reminderQuote:candidate.term.reminderQuote})}};
  const dueAtMs=resolveCommitmentTime(candidate.term.deadlineQuote,{clockTimeMs:input.clockTimeMs,timeZone:input.timeZone});
  if(dueAtMs===null)return {...baseCandidate,...restricted,term:{kind:'unknown'}};
  if(candidate.term.dueAtMs!==undefined&&candidate.term.dueAtMs!==dueAtMs)throw new Error('invalid_commitment_deadline');
  let remindAtMs:number|undefined;
  if(candidate.term.reminderQuote!==undefined){
    const resolved=resolveCommitmentTime(candidate.term.reminderQuote,{clockTimeMs:input.clockTimeMs,timeZone:input.timeZone});
    if(resolved!==null)remindAtMs=resolved;
  }
  if(candidate.term.remindAtMs!==undefined&&candidate.term.remindAtMs!==remindAtMs)throw new Error('invalid_commitment_reminder');
  if(remindAtMs!==undefined&&remindAtMs>dueAtMs)throw new Error('invalid_commitment_reminder');
  return {...baseCandidate,...restricted,term:{kind:'deadline',clock:candidate.term.clock,deadlineQuote:candidate.term.deadlineQuote,
    ...(candidate.term.reminderQuote===undefined?{}:{reminderQuote:candidate.term.reminderQuote}),dueAtMs,
    ...(remindAtMs===undefined?{}:{remindAtMs})}};
}

function negativeContactFeedback(quote:string):boolean {
  if(/假如|假设|比如|举例|如果|引用|引述|(?:他|她|别人|朋友|同事).{0,10}(?:说|觉得|表示)/.test(quote))return false;
  return /(?:别再?|不要|不许|停止).{0,16}(?:发|联系|消息|打扰|破例)|(?:发|联系|消息|打扰|破例).{0,24}(?:不喜欢|不舒服|难受|烦|生气|打扰|违背|违反|别|不要)|(?:不喜欢|不舒服|难受|烦|生气).{0,24}(?:发|联系|消息|打扰|破例)|\b(?:stop|bother|upset|not okay)\b/i.test(quote);
}

function groundedEvidenceActor(
  input:CommitmentValidationInput,relevant:CommitmentValidationInput['plan']['observations'],
  evidence:{actorId:string;quote:string},strict:boolean,
):boolean{
  const quoted=(observation:CommitmentValidationInput['plan']['observations'][number])=>
    observation.readers.includes(evidence.actorId)&&(observation.quote.includes(evidence.quote)||evidence.quote.includes(observation.quote));
  if(!strict){
    return (input.source.role==='user'&&input.userActorId===evidence.actorId)||
      relevant.some(observation=>observation.actorId===evidence.actorId&&quoted(observation));
  }
  if(input.source.role==='user'&&input.userActorId===evidence.actorId)return true;
  if(input.source.role==='assistant'&&input.source.speakerId)return input.source.speakerId===evidence.actorId;
  if(input.source.envelope.mode==='direct')return false;
  // perspectiveOf has already bound identityQuote to this source and actor;
  // only assistant scene narration may use that current-source identity path.
  return relevant.some(observation=>observation.actorId===evidence.actorId&&quoted(observation)&&(
    Boolean(observation.identityEvidence?.length)||
    (input.source.role==='assistant'&&typeof observation.identityQuote==='string'&&
      input.source.text.includes(observation.identityQuote)&&observation.identityQuote.includes(evidence.quote))));
}

function bindTarget(input:CommitmentValidationInput,candidate:GroundedCandidate):CommitmentTargetCandidate|undefined{
  if(!candidate.targetId||input.existing===undefined)return undefined;
  const target=input.existing.find(item=>item.id===candidate.targetId);
  if(!target)throw new Error('invalid_commitment_target');
  // These fields are host-authored bindings. If a caller nevertheless supplies
  // them, reject stale terms before stamping the current target onto the result.
  if(candidate.targetRevision!==undefined&&candidate.targetRevision!==target.revision)
    throw new Error('invalid_commitment_target_revision');
  if((candidate.targetSourceId!==undefined&&candidate.targetSourceId!==target.targetSourceId)||
    (candidate.targetSourceRevision!==undefined&&candidate.targetSourceRevision!==target.targetSourceRevision))
    throw new Error('invalid_commitment_target_source');
  const persistentNoop=target.status==='active'&&target.term.kind==='persistent'&&candidate.action==='fulfill';
  if(!persistentNoop&&!target.allowedActions.includes(candidate.action as CommitmentTargetCandidate['allowedActions'][number]))
    throw new Error('invalid_commitment_target');
  if(candidate.action==='propose'){
    if(target.status!=='active'||candidate.commitmentId===target.id||candidate.agreement!==target.agreement||
      !sameActors(candidate.participants!,target.participants)||!sameActors(candidate.obligors!,target.obligors)||
      candidate.evidence.some(item=>!target.participants.includes(item.actorId)))throw new Error('invalid_commitment_target');
  }
  if(candidate.action==='harden'){
    if(target.status!=='active'||target.contactRestriction?.level!=='soft')throw new Error('invalid_contact_target');
    const hostBound=input.contactFeedbackTargets?.some(item=>item.id===target.id&&item.revision===target.revision&&
      item.sourceId===target.latestSourceId&&item.sourceRevision===target.latestSourceRevision);
    if(hostBound)return target;
  }
  const canTake=(item:CommitmentTargetCandidate)=>item.allowedActions.includes(candidate.action as CommitmentTargetCandidate['allowedActions'][number])||
    (item.status==='active'&&item.term.kind==='persistent'&&candidate.action==='fulfill');
  const adjacentForAction=input.existing.filter(item=>item.adjacent&&canTake(item));
  if(target.adjacent&&adjacentForAction.length===1)return target;
  const excerpt=candidate.targetExcerpt?.trim();
  if(!excerpt||[...excerpt].length<2||!/\p{L}|\p{N}/u.test(excerpt)||
    !candidate.quote.includes(excerpt)||!target.content.includes(excerpt))
    throw new Error('invalid_commitment_target_binding');
  const matches=input.existing.filter(item=>canTake(item)&&item.content.includes(excerpt));
  if(matches.length!==1||matches[0]!.id!==target.id)throw new Error('invalid_commitment_target_binding');
  return target;
}

function sameActors(left:readonly string[],right:readonly string[]):boolean{
  return left.length===right.length&&left.every(actor=>right.includes(actor));
}

function assertDistinctTargetClaims(operations:readonly ValidatedCommitmentOperation[]):void {
  const quotes=new Map<string,string>();
  const evidence=new Map<string,string>();
  for(const operation of operations){
    if(!operation.targetId||operation.contractVersion!==2||operation.action==='harden')continue;
    const priorQuote=quotes.get(operation.quote);
    if(priorQuote&&priorQuote!==operation.targetId)throw new Error('invalid_commitment_target_binding');
    quotes.set(operation.quote,operation.targetId);
    const key=operation.evidence.map(item=>`${item.actorId}\u0000${item.quote}`).sort().join('\u0001');
    const priorEvidence=evidence.get(key);
    if(priorEvidence&&priorEvidence!==operation.targetId)throw new Error('invalid_commitment_target_binding');
    evidence.set(key,operation.targetId);
  }
}

export function requiredConsent(
  agreement: 'unilateral' | 'mutual', participants: readonly string[], obligors: readonly string[],
): readonly string[] {
  return agreement === 'mutual' ? participants : obligors;
}

function evidenceOf(value: unknown) {
  if (!Array.isArray(value) || value.length > 32) throw new Error('invalid_commitment_evidence');
  return value.map(item => {
    const object = exactObject(item, ['actorId', 'quote'], 'invalid_commitment_evidence');
    return {actorId: identifier(object.actorId, 'invalid_commitment_evidence'), quote: boundedText(object.quote, 'invalid_commitment_evidence')};
  });
}

function termOf(value: unknown): CommitmentCandidateTerm {
  const object = record(value, 'invalid_commitment_term');
  const kind = oneOf(object.kind, ['unknown', 'persistent', 'deadline'] as const, 'invalid_commitment_term');
  if (kind !== 'deadline') {
    exactKeys(object, ['kind'], 'invalid_commitment_term');
    return {kind};
  }
  exactKeys(object, ['kind', 'clock', 'deadlineQuote'], 'invalid_commitment_term', ['reminderQuote','dueAtMs','remindAtMs']);
  const clock = oneOf(object.clock, ['real', 'story'] as const, 'invalid_commitment_clock');
  const deadlineQuote=boundedTimeQuote(object.deadlineQuote,'invalid_commitment_deadline_quote');
  const reminderQuote=object.reminderQuote===undefined?undefined:boundedTimeQuote(object.reminderQuote,'invalid_commitment_reminder_quote');
  const dueAtMs=object.dueAtMs===undefined?undefined:timestamp(object.dueAtMs,'invalid_commitment_deadline');
  const remindAtMs=object.remindAtMs===undefined?undefined:timestamp(object.remindAtMs,'invalid_commitment_reminder');
  return {kind,clock,deadlineQuote,...(reminderQuote===undefined?{}:{reminderQuote}),...(dueAtMs===undefined?{}:{dueAtMs}),
    ...(remindAtMs===undefined?{}:{remindAtMs})};
}

function contactRestrictionOf(value:unknown):ContactRestrictionCandidate {
  const object=record(value,'invalid_contact_restriction');
  const kind=oneOf(object.kind,['interval','daily'] as const,'invalid_contact_restriction');
  exactKeys(object,['kind','startQuote','endQuote'],'invalid_contact_restriction',
    kind==='interval'?['startAtMs','endAtMs','level','origin','inheritedFrom']:['timeZone','startMinute','endMinute','level','origin','inheritedFrom']);
  const startQuote=boundedTimeQuote(object.startQuote,'invalid_contact_restriction');
  const endQuote=boundedTimeQuote(object.endQuote,'invalid_contact_restriction');
  const level=object.level===undefined?undefined:oneOf(object.level,['soft','hard'] as const,'invalid_contact_restriction');
  const origin=object.origin===undefined?undefined:oneOf(object.origin,['user','self','hardened'] as const,'invalid_contact_restriction');
  const inheritedFrom=object.inheritedFrom===undefined?undefined:identifier(object.inheritedFrom,'invalid_contact_restriction');
  const stored={...(level===undefined?{}:{level}),...(origin===undefined?{}:{origin}),...(inheritedFrom===undefined?{}:{inheritedFrom})};
  if(kind==='interval')return {kind,startQuote,endQuote,
    ...(object.startAtMs===undefined?{}:{startAtMs:timestamp(object.startAtMs,'invalid_contact_time')}),
    ...(object.endAtMs===undefined?{}:{endAtMs:timestamp(object.endAtMs,'invalid_contact_time')}),
    ...stored};
  const minute=(value:unknown)=>{if(!Number.isSafeInteger(value)||(value as number)<0||(value as number)>=1440)throw new Error('invalid_contact_time');return value as number;};
  return {kind,startQuote,endQuote,
    ...(object.timeZone===undefined?{}:{timeZone:boundedTimeQuote(object.timeZone,'invalid_contact_time_zone')}),
    ...(object.startMinute===undefined?{}:{startMinute:minute(object.startMinute)}),
    ...(object.endMinute===undefined?{}:{endMinute:minute(object.endMinute)}),
    ...stored};
}

/** The companion contract adds contact windows and harden; roleplay never sees either. */
export function commitmentSchemaFor(mode:CommitmentMode): Record<string, unknown> {
  return mode==='companion'?companionCommitmentSchema:roleplayCommitmentSchema;
}

const companionCommitmentSchema: Record<string, unknown> = commitmentSchemaOf(true);
const roleplayCommitmentSchema: Record<string, unknown> = commitmentSchemaOf(false);

function commitmentSchemaOf(companion:boolean): Record<string, unknown> {
  return {
  type: 'object', additionalProperties: false, required: ['operations'], properties: {
    operations: {type: 'array', maxItems: MAX_OPERATIONS, items: commitmentOperationSchema({
        operationId: {type: 'string'}, action: {enum: ['propose', 'confirm', 'establish', 'revise', 'fulfill', 'cancel',...(companion?['harden']:[])]},
        commitmentId: {type: 'string'}, targetId: {type: 'string'}, quote: {type: 'string'}, content: {type: 'string'},
        targetExcerpt:{type:'string'},
        evidence: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['actorId', 'quote'],
          properties: {actorId: {type: 'string'}, quote: {type: 'string'}}}},
        participants: {type: 'array', minItems:1, items: {type: 'string'}}, obligors: {type: 'array', minItems:1, items: {type: 'string'}},
        readers: {type: 'array', minItems:1, items: {type: 'string'}}, agreement: {enum: ['unilateral', 'mutual']},
        term: {oneOf: [
          {type: 'object', additionalProperties: false, required: ['kind'], properties: {kind: {const: 'unknown'}}},
          {type: 'object', additionalProperties: false, required: ['kind'], properties: {kind: {const: 'persistent'}}},
          {type: 'object', additionalProperties: false, required: ['kind', 'clock', 'deadlineQuote'], properties: {
            kind: {const: 'deadline'}, clock: {enum: ['real', 'story']}, deadlineQuote:{type:'string'}, reminderQuote:{type:'string'},
          }},
        ]},
        ...(companion?{contactRestriction:{oneOf:[
          {type:'object',additionalProperties:false,required:['kind','startQuote','endQuote'],properties:{
            kind:{const:'interval'},startQuote:{type:'string'},endQuote:{type:'string'}}},
          {type:'object',additionalProperties:false,required:['kind','startQuote','endQuote'],properties:{
            kind:{const:'daily'},startQuote:{type:'string'},endQuote:{type:'string'}}},
          {type:'null'},
        ]}}:{}),
      },companion),
    },
  },
  };
}

/** Each action exposes only its own payload; confirmation inherits existing terms. */
function commitmentOperationSchema(properties:Record<string,unknown>,companion:boolean) {
  const common=['operationId','action','quote','evidence'];
  const definition=['commitmentId','content','participants','obligors','readers','agreement','term'];
  const branch=(action:string,required:string[],optional:string[]=[])=>({
    type:'object',additionalProperties:false,required:[...common,...required],
    properties:Object.fromEntries([...common,...required,...optional].map(key=>[key,key==='action'?{const:action}:properties[key]])),
  });
  const contact=companion?['contactRestriction']:[];
  return {oneOf:[branch('propose',definition,['targetId','targetExcerpt',...contact]),branch('establish',definition,contact),
    branch('revise',[...definition,'targetId'],['targetExcerpt',...contact]),
    ...['confirm','fulfill','cancel',...(companion?['harden']:[])].map(action=>branch(action,['targetId'],['targetExcerpt']))]};
}

function commitmentReaders(input:CommitmentValidationInput,observation:CommitmentValidationInput['plan']['observations'][number]):Set<string>{
  return new Set([...observation.readers,
    ...(input.userActorId&&(input.source.role==='user'||input.source.envelope.mode==='direct'||observation.playerVisible)?[input.userActorId]:[])]);
}

function exactObject(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  const result = record(value, code); exactKeys(result, keys, code); return result;
}
function keyedObject(value: unknown, required: readonly string[], optional: readonly string[], code: string): Record<string, unknown> {
  const result = record(value, code); exactKeys(result, required, code, optional);
  if (required.some(key => result[key] === undefined)) throw new Error(code);
  return result;
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], code: string, optional: readonly string[] = []): void {
  const keys = Object.keys(value);
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) throw new Error(code);
}
function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}
function identifiers(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(code);
  const result = value.map(item => identifier(item, code));
  if (new Set(result).size !== result.length) throw new Error(code);
  return result;
}
function identifier(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID) throw new Error(code);
  return value;
}
function boundedText(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) throw new Error(code);
  return value;
}
function boundedTimeQuote(value:unknown,code:string):string {
  if(typeof value!=='string'||!value.trim()||value.length>200)throw new Error(code);return value;
}
function timestamp(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(code);
  return value as number;
}
function positiveRevision(value:unknown,code:string):number {
  if(!Number.isSafeInteger(value)||(value as number)<1)throw new Error(code);return value as number;
}
function assertTimeContext(input:CommitmentValidationInput):void {
  if(input.clockTimeMs!==undefined&&(!Number.isSafeInteger(input.clockTimeMs)||input.clockTimeMs<0))throw new Error('invalid_commitment_clock_time');
  if(input.timeZone!==undefined){
    if(typeof input.timeZone!=='string'||!input.timeZone.trim()||input.timeZone.length>100)throw new Error('invalid_commitment_time_zone');
    try{new Intl.DateTimeFormat('en-US',{timeZone:input.timeZone}).format(0);}catch{throw new Error('invalid_commitment_time_zone');}
  }
}
function oneOf<const T extends readonly string[]>(value: unknown, choices: T, code: string): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) throw new Error(code);
  return value as T[number];
}
