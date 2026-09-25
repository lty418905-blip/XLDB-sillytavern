import type {FrontendStrategy} from '../user-model/types.ts';

export type CompanionState='disabled'|'waiting'|'evaluating'|'cooldown'|'awaiting_reply'|'suspended';
export type OpportunityKind='schedule'|'experience'|'unfinished_topic'|'daily';
export type OpportunityStatus='waiting'|'evaluating'|'approved'|'deferred'|'dismissed'|'cancelled'|'consumed';
export type DeliveryStatus='draft'|'ready'|'sending'|'host_committed'|'failed'|'unknown'|'cancelled';

export interface LocalContactWindow {
  days:number[];
  start:string;
  end:string;
}
export interface ContactException {
  date:string;
  mode:'skip'|'replace';
  windows?:Omit<LocalContactWindow,'days'>[];
}
export interface ContactSettings {
  subjectId:string;
  revision:number;
  timeZone:string;
  windows:LocalContactWindow[];
  exceptions:ContactException[];
  minimumIntervalMs:number;
  maxUnanswered:number;
  updatedAtMs:number;
}
export interface ContactOccurrence {
  occurrenceId:string;
  localDate:string;
  windowIndex:number;
  startAtMs:number;
  endAtMs:number;
  timeZone:string;
  settingsRevision:number;
}

/** A single currently active soft no-contact promise and its current window. */
export interface QuietExceptionBinding {
  scopeKey:string;
  commitmentId:string;
  revision:number;
  key:string;
  sourceId:string;
  sourceRevision:number;
}
export type QuietExceptionStatus='available'|'reserved'|'consumed';

export interface CompanionBasis {kind:'source'|'profile'|'schedule'|'daily';id:string;revision:number}
export interface CompanionOpportunity {
  opportunityId:string;
  subjectId:string;
  targetId:string;
  kind:OpportunityKind;
  purpose:string;
  topic:string;
  basis:CompanionBasis[];
  occurrenceId:string;
  sourceVersion:number;
  profileRevision:number;
  activityRevision:number;
  controlsRevision:number;
  contactRevision:number;
  checkAtMs:number;
  windowStartMs:number;
  windowEndMs:number;
  expiresAtMs:number;
  status:OpportunityStatus;
  deferCount:number;
  decision:'approve'|'defer'|'dismiss'|null;
  strategy:FrontendStrategy|null;
  claimToken:string|null;
  claimUntilMs:number|null;
  createdAtMs:number;
  updatedAtMs:number;
}
export interface ScheduleOpportunityInput {
  subjectId:string;
  targetId:string;
  opportunityKey:string;
  kind:OpportunityKind;
  purpose:string;
  topic:string;
  basis:CompanionBasis[];
  sourceVersion:number;
  nowMs?:number;
  notBeforeMs?:number;
  expiresAtMs?:number;
}
export interface OpportunityClaim {opportunity:CompanionOpportunity;claimToken:string;claimUntilMs:number}
export type CompanionDecision=
  |{decision:'approve';strategy:FrontendStrategy}
  |{decision:'defer';nextCheckAtMs:number;reason:string}
  |{decision:'dismiss';reason:string};

export interface CompanionDelivery {
  deliveryId:string;
  opportunityId:string;
  subjectId:string;
  targetId:string;
  body:string;
  status:DeliveryStatus;
  sourceVersion:number;
  profileRevision:number;
  activityRevision:number;
  controlsRevision:number;
  contactRevision:number;
  claimToken:string|null;
  claimUntilMs:number|null;
  host:string|null;
  hostMessageId:string|null;
  resultCode:string|null;
  createdAtMs:number;
  updatedAtMs:number;
}
export interface DeliveryClaim {delivery:CompanionDelivery;claimToken:string;claimUntilMs:number}
export interface ConfirmedContactDelivery {
  deliveryId:string;
  subjectId:string;
  targetId:string;
  body:string;
  hostMessageId:string;
  confirmedSentAtMs:number;
  /** False when confirmation happened after an unknown delivery outcome. */
  replyTimingKnown:boolean;
  quietException:boolean;
}
export interface CompanionActivity {
  subjectId:string;
  revision:number;
  semanticReadyRevision:number;
  lastUserActivityAtMs:number|null;
  busyUntilMs:number|null;
  unansweredCount:number;
  lastSentAtMs:number|null;
}
export interface CompanionStatus {
  subjectId:string;
  targetId:string;
  state:CompanionState;
  revision:number;
  opportunityId:string|null;
  reason:string|null;
  nextCheckAtMs:number|null;
  activity:CompanionActivity;
  deliveries:{deliveryId:string;status:DeliveryStatus;hostMessageId:string|null;resultCode:string|null;updatedAtMs:number}[];
}

export interface CompanionDecisionTask {
  schema:'xldb-companion-decision-task-v1';
  opportunityId:string;
  allowedDecisions:['approve','defer','dismiss'];
  messages:{role:'system'|'user';content:string}[];
}
export interface CompanionDecisionOutput {
  schema:'xldb-companion-decision-v1';
  decision:'approve'|'defer'|'dismiss';
  reason:string;
  nextCheckAtMs:number|null;
}
