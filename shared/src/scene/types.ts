import {emotionIdentitySeed as sharedEmotionIdentitySeed} from '../emotion/identity.ts';
import type { AcceptedMessage, Analysis } from '../core/types.ts';
import type { Scope } from '../memory/access.ts';
import type { EmotionSettings, EmotionState } from '../emotion/openher.ts';
import type { ValidatedCommitmentOperation } from '../commitments/types.ts';
import type { AbsenceExplanationOperation } from '../emotion/absence-explanation.ts';
import type { PhysiologyOperation } from '../common/physiology.ts';
import type { GeographyOperation } from '../common/geography.ts';
import type { StoredLedger, LedgerMarks } from './world-ledger.ts';
import type { TavernEventAddress } from './tavern-engine/types.ts';

/** A user-model candidate is opaque to the shared core; the companion extension decodes and narrows it. */
export type SceneProfileCandidate=unknown;

/** scope.characterId identifies the single Tavern card; NPC ids remain separate. */
export type SceneScope = Scope;
export interface SceneIdentityEvidence { sourceId: string; quote: string; documentHash: string }
export type SceneIdentitySource =
  | { kind: 'automatic'; evidence: SceneIdentityEvidence[] }
  | { kind: 'manual' };
/** A roster identity and optional settings; reserved metadata is opaque and only retained from stored values. */
export interface SceneCharacter {
  id: string;
  name: string;
  aliases: string[];
  persona: string;
  emotion?: EmotionSettings;
  /** Omitted legacy entries are treated as user-confirmed manual identities. */
  identitySource?: SceneIdentitySource;
  calibration?: unknown;
  emotionProvenance?: unknown;
}
/** The scope's ordered roster; emotionControls is opaque stored metadata, never populated from a caller. */
export interface SceneRoster {
  characters: SceneCharacter[];
  emotionControls?: unknown;
}
export type SceneInputMode = 'direct' | 'scene';
export interface SceneEnvelope {
  /** Host-selected player identity, not inferred from NPC dialogue. */
  playerName?: string;
  targetId: string;
  mode: SceneInputMode;
  presentIds: string[];
}

/** One accepted assistant recall. UTF-16 ranges are half-open; time comes from the carrying message. */
export interface SceneRecall {
  character: string;
  source: string;
  revision: number;
  identity: string;
  /** Omission is strong; only weak recalls store a strength. */
  strength?: 'weak';
  details?: {start: number; end: number; stray?: true}[];
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
  /** Server-produced recalls, stored only when this assistant message is accepted. */
  recalled?: SceneRecall[];
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
/** A source-bound experience for its readers; optional attribution does not change visibility. */
export interface LegacyObservation {
  /** Absence is the historical message-offset encoding; no marker is added when reading it. */
  channel?: 'message';
  /**
   * When present, actorId names the speaker or actor. Its absence means narration, multiple actors, or uncertainty.
   * Observations without this marker are legacy data and retain the older codec's identity semantics.
   */
  attributed?: true;
  playerVisible?: boolean;
  playerEvidence?: string;
  identityQuote?: string;
  id: string;
  kind: KnowledgeKind;
  start: number;
  end: number;
  quote: string;
  /**
   * Older codec: the speaking NPC for NPC speech, the direct listener for the player's own speech,
   * the observer for observed items, and the holder for thought/inferred items.
   * Attributed views: only the speaker or actor who said or did the content.
   */
  actorId?: string;
  recipients?: string[];
  evidence: string;
  identityEvidence?: {sourceId:string;quote:string;revision?:number}[];
  readers: string[];
}
/**
 * A routed event experience. The complete structural reference replaces prose offsets; sequence is an event count.
 * Readers and text come from the perception route, never from display prose or a model-provided audience.
 */
export interface EventSourceObservation extends Omit<LegacyObservation, 'channel' | 'start' | 'end' | 'actorId'> {
  channel: 'event';
  ref: TavernEventAddress;
  sequence: number;
  actorId: string;
  start?: never;
  end?: never;
}

/** Legacy message spans and routed event references are distinct; omitted channel always means legacy. */
export type Observation = LegacyObservation | EventSourceObservation;

export interface PerspectivePlan { observations: Observation[]; unresolved: string[];
  presentation?: {sentenceCount:number|null;dialogueOnly:boolean|null};
  generationRequests?: Record<string,string> }
/** Per-role accepted analysis; actors without emotion retain memory and preference data only. */
export type SceneCharacterAnalysis = Omit<Analysis, 'emotion' | 'memories'> & {
  emotion?: Analysis['emotion'];
  memories: Array<Analysis['memories'][number] & {
    /**
     * Explicit event addresses. The authority writes knowledge at commit for a single-event memory it resolves from
     * the plan; callers may supply knowledge or a complete knowledgeSet. All other source metadata is reconstructed.
     */
    source?: {knowledge?: TavernEventAddress; knowledgeSet?: TavernEventAddress[]};
  }>;
};

export interface SceneAnalysis {
  plan: PerspectivePlan;
  characters: Record<string, SceneCharacterAnalysis>;
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
  userModelCandidates?: SceneProfileCandidate[];
  /** Source-grounded virtual-character physiology operations, replayed locally. */
  physiologyOperations?: PhysiologyOperation[];
  /** Source-grounded geography operations, replayed from accepted prose. */
  geographyOperations?: GeographyOperation[];
  ledger?: StoredLedger;
  ledgerMarks?: LedgerMarks;
}
/** Pending causal/config retries may retain candidates while forcing a new plan. */
export interface StoredSceneAnalysis {
  plan: PerspectivePlan | null;
  characters: Record<string, SceneCharacterAnalysis>;
  skippedStages?: SceneAnalysis['skippedStages'];
  emotionSchedule?: SceneAnalysis['emotionSchedule'];
  emotionPendingIds?: string[];
  emotionCandidateReadyIds?: string[];
  contactResponseExpectation?: {expected:boolean|null;quote:string|null};
  absenceExplanation?:AbsenceExplanationOperation|null;
  controlRevision?: number;
  worldEffects?: unknown[];
  commitmentOperations?: ValidatedCommitmentOperation[];
  userModelCandidates?: SceneProfileCandidate[];
  physiologyOperations?: PhysiologyOperation[];
  geographyOperations?: GeographyOperation[];
  ledger?: StoredLedger;
  ledgerMarks?: LedgerMarks;
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

/** Branches inherit one NPC identity and its neural starting genome; JSON serialization errors propagate unchanged. */
export function emotionIdentitySeed(scope: SceneScope, npcId?: string): string {
  return sharedEmotionIdentitySeed(scope, npcId);
}
