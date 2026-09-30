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

/**
 * Whose words set the window's time range: `user` (a user message that asks not to be contacted, or her agreement echoing
 * the user message it answers) is always hard; `self` (only her own words, or a schedule the user merely mentioned) starts
 * soft; `hardened` is a `self` window made hard by negative feedback (projected on every rebuild). Records saved before
 * origins existed have none and count as not `user`.
 */
export type ContactRestrictionOrigin='user'|'self'|'hardened';
/** `level`, `origin` and resolved times from the model are ignored; only a stored operation being revalidated carries them. */
export type ContactRestrictionCandidate =
  | {kind:'interval';startQuote:string;endQuote:string;startAtMs?:number;endAtMs?:number;level?:'soft'|'hard';origin?:ContactRestrictionOrigin;inheritedFrom?:string}
  | {kind:'daily';startQuote:string;endQuote:string;timeZone?:string;startMinute?:number;endMinute?:number;level?:'soft'|'hard';origin?:ContactRestrictionOrigin;inheritedFrom?:string};
/**
 * `inheritedFrom`: the target commitment whose user hard window a revision or replacement kept without restating it (its
 * quotes are the target's); set only by the host.
 */
export type ContactRestriction =
  | {kind:'interval';startQuote:string;endQuote:string;startAtMs:number;endAtMs:number;level:'soft'|'hard';origin?:ContactRestrictionOrigin;inheritedFrom?:string}
  | {kind:'daily';startQuote:string;endQuote:string;timeZone:string;startMinute:number;endMinute:number;level:'soft'|'hard';origin?:ContactRestrictionOrigin;inheritedFrom?:string};

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
  /** null: the user's own words lift the target's window in this replacement; omission keeps a user's hard window. */
  contactRestriction?:ContactRestrictionCandidate|null;
}

export interface ValidatedCommitmentOperation extends Omit<CommitmentCandidate,'term'|'contactRestriction'> {
  term?:CommitmentTerm;
  contactRestriction?:ContactRestriction|null;
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
  /**
   * A stored operation is being checked again (the scene store's revalidation): a contact restriction keeps its stored
   * times, level and origin and its quotes are not parsed again. Fresh extractions leave it unset.
   */
  revalidate?:boolean;
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
