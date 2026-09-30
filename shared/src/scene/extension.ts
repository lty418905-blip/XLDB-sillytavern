import type {DatabaseSync} from 'node:sqlite';
import type {Configurations} from '../core/types.ts';
import type {ModelRunner} from '../core/models.ts';
import type {ContactAffect} from '../emotion/contact-affect.ts';
import type {SceneScope,SceneMessage,SceneRoster,SceneSource,SceneState,SceneProfileCandidate} from './types.ts';
import type {SceneAuthority} from './store.ts';

/**
 * The injection seam between the shared scene core and an optional companion extension. Every hook and port method
 * has a no-op default, so a host that passes nothing (the Tavern) runs no companion code and creates no companion
 * tables. Only the Agent passes the companion extension (companion-agent/src/companion/scene-extension.ts).
 */

/** The explicitly bound real user of an active Agent companion scope. */
export interface SceneSubjectBinding {host:'agent';baseScope:SceneScope;subjectId:string;bindingId:string;createdAtMs:number}

/** The contact projection read by replies, proactive checks and relationship reads: the emotion and, if any, the contact affect. */
export interface ContactEmotionProjection {emotion:ReturnType<SceneAuthority['responseEmotion']>;affect:ContactAffect|null}

/** A checkpoint field an extension owns (its JSON field name stays `companionPreset` for old checkpoints). */
export interface SceneCheckpointHooks {
  /** The value stored in a new checkpoint; undefined leaves the field out, so a restore never touches it. */
  capture(scopeKey:string):unknown;
  /** Restore the field of a checkpoint that owns it; `replace` removes the live value first (rollback), a fork only inserts. */
  restore(scopeKey:string,value:unknown,replace:boolean):void;
}

export interface SceneAuthorityHooks {
  subject(scope:SceneScope):SceneSubjectBinding|null;
  /** After a roster change was written. */
  onConfigured(scope:SceneScope):void;
  /** After an accepted source was erased (deleted by a replace reconcile). */
  onSourceErased(scope:SceneScope,source:SceneSource):void;
  /** After accepted user text was written. */
  onUserActivity(scope:SceneScope,nowMs:number):void;
  /** After a commit made analyses ready. */
  onCommitted(scope:SceneScope):void;
  /** The extension part of the derived projections, after the commitment projection was rebuilt. */
  rebuildDerived(scope:SceneScope,state:SceneState,nowMs:number):void;
  /** Null keeps the base response emotion without a contact affect. */
  contactEmotion(scope:SceneScope,characterId:string,nowMs:number,state:SceneState,
    currentReply:{sourceId:string;revision:number}|null,base:ContactEmotionProjection['emotion']):ContactEmotionProjection|null;
  /** Validated user-model candidates of one source, or undefined to drop them (the default never throws). */
  decodeUserModelCandidates(value:unknown,sourceText:string):readonly SceneProfileCandidate[]|undefined;
  checkpoint:SceneCheckpointHooks;
}

/** What an extension may use of the authority under construction; everything else is its public API (`scene`). */
export interface SceneAuthorityInternals {
  scene:SceneAuthority;
  transaction<T>(action:()=>T):T;
  bump(scope:SceneScope):void;
  rebuildDerived(scope:SceneScope,nowMs?:number):void;
  /** Configure without capturing a checkpoint. */
  configure(scope:SceneScope,roster:SceneRoster,nowMs:number):ReturnType<SceneAuthority['configure']>;
}

/**
 * Builds the extension members and hooks. It runs inside the SceneAuthority constructor, before the lifecycle and the
 * emotion-state migration; the members are installed on the authority with their property descriptors (accessors stay
 * accessors), so the authority is typed `SceneAuthority & M`.
 */
export type SceneAuthorityExtensionFactory<M extends object>=(db:DatabaseSync,internals:SceneAuthorityInternals)=>
  {members:M;hooks?:Partial<SceneAuthorityHooks>};

export function defaultSceneHooks():SceneAuthorityHooks {
  return {
    subject:()=>null,onConfigured:()=>{},onSourceErased:()=>{},onUserActivity:()=>{},onCommitted:()=>{},rebuildDerived:()=>{},
    contactEmotion:()=>null,decodeUserModelCandidates:()=>undefined,
    checkpoint:{capture:()=>undefined,restore:()=>{}},
  };
}

/**
 * A reply-path enrichment that was retried or left out because the host returned output that failed local
 * validation (see CompanionFlow.systemContext). It never names entry content.
 */
export interface ReplyDiagnostic {stage:'strategy'|'relationship'|'profile';code:string;attempts:number;outcome:'recovered'|'omitted'|'cached'|'reextracted'|'dropped_counter'}

export type CompanionExtractor=(messages:{role:'system'|'user';content:string}[],run?:ModelRunner)=>Promise<string>;
/** The accepted exception bindings of the delivery a user text answers (empty when there is none or it is not accepted). */
export interface SceneCompanionFeedback {
  delivery:unknown|null;
  bindings:readonly {commitmentId:string;revision:number;sourceId:string;sourceRevision:number}[];
}

/** The companion calls SceneCore makes. CompanionFlow implements it in the Agent; the default is inert. */
export interface SceneCompanionPort {
  responseExpectationExtractor:CompanionExtractor|null;
  absenceExplanationExtractor:CompanionExtractor|null;
  systemContext(scope:SceneScope,characterId:string,legalContext:string,configs:Configurations,assertCurrent:()=>void,
    currentUserSourceId?:string,nowMs?:number,diagnostics?:ReplyDiagnostic[]):Promise<string>;
  contactEmotion(scope:SceneScope,characterId:string,nowMs:number,state?:SceneState,
    currentReply?:{sourceId:string;revision:number}|null):ContactEmotionProjection;
  extract(scope:SceneScope,source:SceneMessage,configs:Configurations,assertCurrent:()=>void,run?:ModelRunner):Promise<SceneProfileCandidate[]>;
  /** The profile controls that key the profile stage fingerprint, or null without a bound subject. */
  profileControls(scope:SceneScope):unknown;
  feedbackDelivery(scope:SceneScope,characterId:string,deliveryId:string):SceneCompanionFeedback;
  poll(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',configs:Configurations,assertCurrent:()=>void):Promise<unknown>;
  materialize(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',nowMs?:number):unknown;
  evaluate(scope:SceneScope,characterId:string,trigger:'event'|'scheduled',configs:Configurations,assertCurrent:()=>void):Promise<unknown>;
  receipt(scope:SceneScope,characterId:string,deliveryId:string,claimToken:string,
    outcome:{status:'sent';hostMessageId:string}|{status:'failed'|'unknown';code:string}):{status:string};
  reconcile(scope:SceneScope,characterId:string,deliveryId:string,
    outcome:{status:'sent';hostMessageId:string}|{status:'failed';code:string}):{status:string};
  acceptedMessage(scope:SceneScope,characterId:string,deliveryId:string):SceneMessage;
  identityGuidance(currentUserText:string|null):string;
  /** A truthy issue rejects a companion reply. */
  identityIssue(body:string,currentUserText:string|null):string|null;
  ensureIdentityBody(body:string,currentUserText:string|null,rewrite:(instruction:string,original:string)=>Promise<string>):Promise<string>;
}

/**
 * The inert port: no companion context, the base response emotion, no profile work, no feedback delivery and
 * pass-through identity checks. The proactive calls are reachable only through an Agent companion scope and throw.
 * Each SceneCore gets a fresh one, so assigning a method on one core never reaches another.
 */
export function defaultCompanionPort(scene:SceneAuthority):SceneCompanionPort {
  const unavailable=():never=>{throw new Error('companion_unavailable');};
  return {
    responseExpectationExtractor:null,absenceExplanationExtractor:null,
    systemContext:async()=>'',
    contactEmotion:(scope,characterId,nowMs,state=scene.state(scope),currentReply=null)=>
      scene.contactEmotionProjection(scope,characterId,nowMs,state,currentReply),
    extract:async()=>[],
    profileControls:()=>null,
    feedbackDelivery:()=>({delivery:null,bindings:[]}),
    poll:async()=>unavailable(),materialize:unavailable,evaluate:async()=>unavailable(),
    receipt:unavailable,reconcile:unavailable,acceptedMessage:unavailable,
    identityGuidance:()=>'',identityIssue:()=>null,ensureIdentityBody:async body=>body,
  };
}

/**
 * Local judge for the director's anonymous schedule conflicts and the Tavern emotion ranking. A host that owns an
 * AgentJev worker passes it, so the scene never starts a second worker.
 */
export interface SceneJudge {
  identity():string;
  evaluate(payload:unknown):Promise<unknown>;
}
