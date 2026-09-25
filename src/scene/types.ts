import type { AcceptedMessage, Analysis } from '../core/types.ts';
import type { Scope } from '../memory/access.ts';
import type { EmotionSettings, EmotionState } from '../emotion/openher.ts';
import type { ValidatedCommitmentOperation } from '../commitments/types.ts';
import type { ProfileCandidate } from '../user-model/types.ts';
import type { AbsenceExplanationOperation } from '../emotion/absence-explanation.ts';
import type { PhysiologyOperation } from '../common/physiology.ts';
import type { GeographyOperation } from '../common/geography.ts';

/** scope.characterId identifies the single Tavern card; NPC ids remain separate. */
export type SceneScope = Scope;
export interface SceneIdentityEvidence { sourceId: string; quote: string; documentHash: string }
export type SceneIdentitySource =
  | { kind: 'automatic'; evidence: SceneIdentityEvidence[] }
  | { kind: 'manual' };
export interface SceneCharacter {
  id: string;
  name: string;
  aliases: string[];
  persona: string;
  emotion?: EmotionSettings;
  /** Omitted legacy entries are treated as user-confirmed manual identities. */
  identitySource?: SceneIdentitySource;
}
export interface SceneRoster { characters: SceneCharacter[] }
export type SceneInputMode = 'direct' | 'scene';
export interface SceneEnvelope {
  /** Host-selected player identity, not inferred from NPC dialogue. */
  playerName?: string;
  targetId: string;
  mode: SceneInputMode;
  presentIds: string[];
}
export interface SceneMessage extends AcceptedMessage {
  /** IANA zone captured at first acceptance; legacy sources without one replay in UTC. */
  acceptedTimeZone?: string;
  /** Native theatre prose; participants must be established by body evidence. */
  automatic?: boolean;
  envelope: SceneEnvelope;
  /** Accepted assistant text is spoken only by the selected NPC. */
  speakerId?: string;
  dependencies?: { id: string; revision: number }[];
  /** Actual conversational antecedent, distinct from the full knowledge dependency set. */
  replyTo?: {id:string;revision:number};
}
export type KnowledgeKind = 'observed' | 'heard' | 'private' | 'thought' | 'inferred';
/** A model candidate. Recipients cannot exceed the user-controlled envelope. */
export interface ObservationCandidate {
  /** Explicit player audience; absence never grants narrator access. */
  playerVisible?: boolean;
  playerEvidence?: string;
  /** Short literal antecedent in the same body, separate from the event span. */
  identityQuote?: string;
  id: string;
  kind: KnowledgeKind;
  start: number;
  end: number;
  quote: string;
  actorId: string;
  recipients: string[];
  /** A literal source span naming the actor/listeners, never an invented rationale. */
  evidence: string;
  identityEvidence?: {sourceId:string;quote:string;revision?:number}[];
}
export interface Observation {
  playerVisible?: boolean;
  playerEvidence?: string;
  identityQuote?: string;
  id: string;
  kind: KnowledgeKind;
  start: number;
  end: number;
  quote: string;
  /** Legacy actor/recipient attribution is present on the older perspective codec only. */
  actorId?: string;
  recipients?: string[];
  evidence: string;
  identityEvidence?: {sourceId:string;quote:string;revision?:number}[];
  readers: string[];
}
export interface PerspectivePlan { observations: Observation[]; unresolved: string[];
  presentation?: {sentenceCount:number|null;dialogueOnly:boolean|null};
  generationRequests?: Record<string,string> }
export interface SceneAnalysis {
  plan: PerspectivePlan;
  characters: Record<string, Analysis>;
  /** Failed model stages omitted from this accepted source's derived state. */
  skippedStages?: import('./processing.ts').SkippedStage[];
  /** Foreground decision for the user turn; assistant replies share its four-NPC budget. */
  emotionSchedule?: {windowId:string;eligibleIds:string[];selectedIds:string[];forcedIds:string[];deferredIds:string[];
    method:'agentjev'|'agentjev_guarded'|'deterministic'|'all';reason?:string;modelIdentity?:string};
  /** Accepted emotion candidates awaiting local OpenHer learning after the foreground commit. */
  emotionPendingIds?: string[];
  /** Deferred NPCs whose model candidates were actually analyzed; absent in older placeholder records. */
  emotionCandidateReadyIds?: string[];
  /** Source-grounded reply expectation for accepted companion assistant text. */
  contactResponseExpectation?: {expected:boolean|null;quote:string|null};
  absenceExplanation?:AbsenceExplanationOperation|null;
  worldEffects?: unknown[];
  /** Locally grounded operations; raw model candidates are never persisted here. */
  commitmentOperations?: ValidatedCommitmentOperation[];
  /** Source-grounded candidates for the explicitly bound real-user subject. */
  userModelCandidates?: ProfileCandidate[];
  /** Source-grounded virtual-character physiology operations, replayed locally. */
  physiologyOperations?: PhysiologyOperation[];
  /** Source-grounded geography operations, replayed from accepted prose. */
  geographyOperations?: GeographyOperation[];
}
/** Pending causal/config retries may retain candidates while forcing a new plan. */
export interface StoredSceneAnalysis {
  plan: PerspectivePlan | null;
  characters: Record<string, Analysis>;
  skippedStages?: SceneAnalysis['skippedStages'];
  emotionSchedule?: SceneAnalysis['emotionSchedule'];
  emotionPendingIds?: string[];
  emotionCandidateReadyIds?: string[];
  contactResponseExpectation?: {expected:boolean|null;quote:string|null};
  absenceExplanation?:AbsenceExplanationOperation|null;
  controlRevision?: number;
  worldEffects?: unknown[];
  commitmentOperations?: ValidatedCommitmentOperation[];
  userModelCandidates?: ProfileCandidate[];
  physiologyOperations?: PhysiologyOperation[];
  geographyOperations?: GeographyOperation[];
  /** Local deterministic projection after this accepted source; model output is never trusted here. */
  emotionStates?: Record<string, EmotionState>;
}
export interface SceneSource extends SceneMessage {
  observedAtMs: number;
  status: 'accepted' | 'deleted' | 'needs_review';
  processing: 'pending' | 'ready' | 'failed';
  analysis: StoredSceneAnalysis | null;
}
export interface SceneState {
  scope: SceneScope;
  version: number;
  createdAtMs: number;
  roster: SceneRoster;
  sources: SceneSource[];
}

/** The caller's last acknowledged snapshot, never a fresh server version substituted for it. */
export interface SceneWriteGuard { expectedVersion:number; operationId:string; reconfirmIds?:string[] }

export function npcScope(scope: SceneScope, npcId: string): Scope {
  return { ...scope, characterId: JSON.stringify(['npc', scope.characterId, npcId]) };
}

/** Branches inherit one NPC identity and its neural starting genome. */
export function emotionIdentitySeed(scope: SceneScope, npcId?: string): string {
  return JSON.stringify(['xldb-emotion-v2', scope.worldId, scope.sessionId, scope.characterId, npcId ?? null]);
}
