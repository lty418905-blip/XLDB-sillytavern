import type { SceneMessage, SceneScope, PerspectivePlan } from '../scene/types.ts';

export type CommitmentMode = 'roleplay' | 'companion';
export type CommitmentAction = 'propose' | 'confirm' | 'establish' | 'revise' | 'fulfill' | 'cancel' | 'harden';
export type CommitmentAgreement = 'unilateral' | 'mutual';
export type CommitmentTerm =
  | { kind: 'unknown' }
  | { kind: 'persistent' }
  | { kind: 'deadline'; clock: 'real' | 'story'; deadlineQuote:string; reminderQuote?:string; dueAtMs: number; remindAtMs?: number };
export type CommitmentCandidateTerm =
  | { kind: 'unknown' }
  | { kind: 'persistent' }
  | { kind: 'deadline'; clock: 'real' | 'story'; deadlineQuote:string; reminderQuote?:string; dueAtMs?:number; remindAtMs?:number };

export interface CommitmentEvidence {
  actorId: string;
  quote: string;
}

export type ContactRestrictionCandidate =
  | {kind:'interval';startQuote:string;endQuote:string;startAtMs?:number;endAtMs?:number;level?:'soft'|'hard'}
  | {kind:'daily';startQuote:string;endQuote:string;timeZone?:string;startMinute?:number;endMinute?:number;level?:'soft'|'hard'};
export type ContactRestriction =
  | {kind:'interval';startQuote:string;endQuote:string;startAtMs:number;endAtMs:number;level:'soft'|'hard'}
  | {kind:'daily';startQuote:string;endQuote:string;timeZone:string;startMinute:number;endMinute:number;level:'soft'|'hard'};

/** Model output is only a candidate until validate() grounds it in one accepted source. */
export interface CommitmentCandidate {
  operationId: string;
  action: CommitmentAction;
  commitmentId?: string;
  targetId?: string;
  /** Host-stamped binding; older saved events may omit it. */
  targetRevision?: number;
  targetSourceId?: string;
  targetSourceRevision?: number;
  /** Exact, distinguishing excerpt from the referenced target's accepted terms. */
  targetExcerpt?: string;
  /** Host contract marker; the model never supplies it. */
  contractVersion?: 2;
  quote: string;
  evidence: CommitmentEvidence[];
  content?: string;
  participants?: string[];
  obligors?: string[];
  readers?: string[];
  agreement?: CommitmentAgreement;
  term?: CommitmentCandidateTerm;
  contactRestriction?:ContactRestrictionCandidate;
}

export interface ValidatedCommitmentOperation extends Omit<CommitmentCandidate,'term'|'contactRestriction'> {
  term?:CommitmentTerm;
  contactRestriction?:ContactRestriction;
  commitmentId?: string;
  targetId?: string;
  sourceId: string;
  sourceRevision: number;
  sourceAcceptedAtMs: number;
  mode: CommitmentMode;
}

export interface CommitmentSource extends SceneMessage {
  analysis?: { commitmentOperations?: ValidatedCommitmentOperation[] } | null;
  status?: 'accepted' | 'deleted' | 'needs_review';
  processing?: 'pending' | 'ready' | 'failed';
}

export interface CommitmentValidationInput {
  source: SceneMessage;
  plan: PerspectivePlan;
  /** All stable principals accepted by this host, normally roster ids plus player. */
  actorIds: readonly string[];
  /** Stable principal for the accepted user message, for example `player`. */
  userActorId?: string;
  mode: CommitmentMode;
  /** Clock at this accepted source, never current wall time during replay. */
  clockTimeMs?:number;
  /** IANA zone used only for explicit 今天/明天 local-clock phrases. */
  timeZone?:string;
  /** Current host contract; omitted when old saved operations are checked. */
  contractVersion?:2;
  /** Immediately preceding accepted source, when one exists. */
  responseTo?:{id:string;revision:number};
  responseContext?:{id:string;revision:number;role:'user'|'assistant';text:string};
  /** Host binding to a delivered contact exception; never inferred from a model target id. */
  contactFeedbackTargets?:readonly {id:string;revision:number;sourceId:string;sourceRevision:number}[];
  /** Locally derived transition candidates. An empty array is different from legacy omission. */
  existing?:readonly CommitmentTargetCandidate[];
}

export type CommitmentStatus = 'proposed' | 'active' | 'fulfilled' | 'cancelled' | 'superseded';

export interface CommitmentRecord {
  scope: SceneScope;
  id: string;
  revision: number;
  mode: CommitmentMode;
  status: CommitmentStatus;
  agreement: CommitmentAgreement;
  content: string;
  participants: string[];
  obligors: string[];
  readers: string[];
  term: CommitmentTerm;
  contactRestriction?:ContactRestriction;
  createdSourceId: string;
  createdSourceRevision: number;
  latestSourceId: string;
  latestSourceRevision: number;
  consentActorIds?: string[];
  replaces?: string;
  /** Revision of the still-active commitment when this replacement was proposed. */
  replacesRevision?: number;
}

export interface CommitmentTargetCandidate {
  id:string;
  revision:number;
  status:'proposed'|'active';
  /** Only a proposed replacement carries the old active target id. */
  replaces?:string;
  agreement:CommitmentAgreement;
  content:string;
  participants:string[];
  obligors:string[];
  term:CommitmentTerm;
  targetSourceId:string;
  targetSourceRevision:number;
  latestSourceId:string;
  latestSourceRevision:number;
  requiredConsentActorIds:string[];
  missingConsentActorIds:string[];
  adjacent:boolean;
  contactRestriction?:ContactRestriction;
  allowedActions:Array<'propose'|'confirm'|'revise'|'fulfill'|'cancel'|'harden'>;
}

export interface CommitmentQuery {
  mode?: CommitmentMode;
  participantId?: string;
  obligorId?: string;
  readerId?: string;
  sourceId?: string;
  status?: CommitmentStatus | 'overdue';
  clock?: 'real' | 'story';
  text?: string;
  realNowMs?: number;
  storyNowMs?: number;
}

export interface PersistentProjection {
  entries: Array<Pick<CommitmentRecord, 'id' | 'revision' | 'content' | 'participants' | 'obligors' | 'latestSourceId'>>;
  systemText: string;
}

export interface CommitmentTodo {
  commitmentId: string;
  revision: number;
  mode: CommitmentMode;
  clock: 'real' | 'story';
  dueAtMs: number;
  remindAtMs: number;
  obligorId: string;
  stage: 'upcoming' | 'due';
}

export interface CommitmentPrompt {
  system: string;
  input: {
    sourceId: string;
    sourceRevision: number;
    role: SceneMessage['role'];
    text: string;
    observations: PerspectivePlan['observations'];
    actorIds: readonly string[];
    userActorId?: string;
    mode: CommitmentMode;
    clockTimeMs?:number;
    timeZone?:string;
    responseTo?:{id:string;revision:number};
    contactFeedbackTargets?:readonly {id:string;revision:number;sourceId:string;sourceRevision:number}[];
    existing?:readonly CommitmentTargetCandidate[];
  };
  schema: Record<string, unknown>;
}
