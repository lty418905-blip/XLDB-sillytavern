import type { AcceptedMessage } from '../../core/types.ts';
import type { Scope } from '../../memory/access.ts';
import type { CommitmentCandidate } from '../../commitments/types.ts';
import type { PhysiologyOperation } from '../../common/physiology.ts';
import type { CalendarClaim } from '../calendar.ts';

/** Payload reference slots per event, including repeated references; fixed by the event contract. */
export const MAX_EVENT_REFERENCES = 16;

/** Provisional evidence threshold in [0, 1]; meeting it never grants permission to mutate state. */
export const MIN_ACTION_CONFIDENCE = 0.8;

/** Contract limits per candidate, in UTF-16 units except nextCodePoints and array counts. */
export const CODEC_LIMITS = Object.freeze({
  items: 2,
  soloFirstItems: 6,
  effects: 6,
  text: 800,
  goal: 500,
  nextCodePoints: 60,
});

/** Closed player action vocabulary; an action describes an attempt and cannot itself patch state. */
export type PlayerActionKind = 'move' | 'give' | 'take' | 'attack' | 'use' | 'touch' | 'other';

/** An event address, independent of rendered prose offsets; revisions are positive safe integers. */
export interface EventReference {
  turnId: string;
  turnRevision: number;
  eventId: string;
}

/** Evidence addresses use either UTF-16 message offsets or an event address, never fabricated offsets. */
export type ObservationSource =
  | { channel: 'message'; sourceId: string; revision: number; start: number; end: number }
  | ({ channel: 'event' } & EventReference);

/** Host-owned event identity; interpret uses beat 0 and beat dispatch uses a positive safe integer. */
export interface EngineEventEnvelope {
  id: string;
  turnId: string;
  beatIndex: number;
  source: 'interpret' | 'beat' | 'engine';
  status: 'tentative' | 'accepted' | 'rejected';
}

/** Host-owned ledger provenance; scope and source revisions do not consume payload reference slots. */
export interface EventOrigin {
  scope: Scope;
  turnRevision: number;
  sourceId: string;
  sourceRevision: number;
  ruleVersion: string;
}

/** Caller-provided identity and current entity catalog; no callback or model-owned identity is accepted. */
export interface EventDecodeContext {
  envelope: EngineEventEnvelope;
  scope: Scope;
  turnRevision: number;
  ruleVersion: string;
  message: AcceptedMessage;
  actorId: string;
  entityIds: readonly string[];
  itemIds: readonly string[];
  placeIds: readonly string[];
  eventReferences: readonly EventReference[];
}

/** Beat limits depend on the host's scheduled actor count, not a model-provided solo flag. */
export interface BeatDecodeContext extends EventDecodeContext {
  scheduledActorCount: number;
}

/** Shared candidate evidence; confidence is finite in [0, 1], and evidence is locally source-checked. */
export interface EventEvidence {
  actorId: string;
  confidence: number;
  evidence?: readonly ObservationSource[];
}

/** Roleplay commitment fields reuse the existing candidate contract; validation/commit remains downstream. */
export type EventCommitment = Pick<CommitmentCandidate,
  'operationId' | 'action' | 'commitmentId' | 'targetId' | 'targetRevision' | 'quote' | 'evidence'
  | 'content' | 'participants' | 'obligors' | 'agreement' | 'term'>;

/** P1 hard-effect candidates only; these records are decoded proposals, not authorized state writes. */
export type BeatEffect = EventEvidence & (
  | { kind: 'Enter' | 'Exit'; entityId: string; placeId: string }
  | { kind: 'Transfer'; itemId: string; fromId: string; toId: string }
  | { kind: 'CommitmentEvent'; operation: EventCommitment }
);

/** Machine-readable decode reasons; these are protocol values, not user-facing wording. */
export type DecodeIssue =
  | 'invalid_shape' | 'invalid_context' | 'unknown_kind' | 'phase_disabled' | 'invalid_confidence'
  | 'low_confidence' | 'missing_evidence' | 'invalid_reference' | 'too_many_references'
  | 'unknown_entity' | 'invalid_length' | 'invalid_source' | 'invalid_item_ref' | 'invalid_phase'
  | 'evidence_not_found' | 'evidence_ambiguous' | 'evidence_span_mismatch'
  | 'effect_world_mismatch' | 'effect_actor_not_allowed' | 'world_unavailable';

/** A diagnostic event preserves supplied text and provenance without carrying an executable effect. */
export interface UnknownEvent {
  kind: 'Unknown';
  actorId: string;
  text: string;
  reason: DecodeIssue;
}

/** Closed P1 payloads. Utterances preserve literal text; actions and effects still require consumer validation. */
export type EventPayload = BeatEffect | UnknownEvent | (EventEvidence & (
  | { kind: 'PlayerUtterance' | 'NpcSpeech'; addressees: readonly string[];
      whisperTo?: readonly string[]; text: string }
  | { kind: 'PlayerAction'; action: { kind: PlayerActionKind }; targets: readonly string[];
      objects: readonly string[]; text: string }
  | { kind: 'NpcAction'; targets: readonly string[]; text: string }
  | { kind: 'TimeAdvance'; minutes: number; temporality: 'current' | 'recollection' | 'plan' }
));

/** Reserved P2 payloads reuse closed operations; the current decoder returns phase_disabled for every branch. */
export type DeferredPhaseTwoPayload =
  | { kind: 'PhysiologyEvent'; operation: PhysiologyOperation }
  | { kind: 'CalendarEvent'; claim: Omit<CalendarClaim, 'sourceId' | 'sourceRevision' | 'sourceHash'> }
  | { kind: 'ConsumeItem'; itemId: string };

/** Reserved P3 action phases; no attempt or result can be activated by a model-supplied field. */
export type DeferredPhaseThreePayload =
  | (Extract<EventPayload, { kind: 'PlayerAction' | 'NpcAction' }> & { phase: 'attempt' })
  | (Extract<EventPayload, { kind: 'PlayerAction' | 'NpcAction' }> & {
      phase: 'result';
      attemptRef: EventReference;
      effects: readonly BeatEffect[];
    });

/** Decoded event storage shape, with separate host envelope, source provenance and closed payload. */
export interface EngineEvent {
  envelope: EngineEventEnvelope;
  origin: EventOrigin;
  payload: EventPayload;
}

/** Decode failures never expose a partially decoded value; invalid event payloads instead become Unknown. */
export type DecodeResult<Value> = { ok: true; value: Value } | { ok: false; reason: DecodeIssue };

/** Decoded item identity stays at its original zero-based position even after a projection excludes other items. */
export interface BeatItem {
  itemIndex: number;
  actorId: string;
  kind: 'speech' | 'action';
  text: string;
  addressees: readonly string[];
  whisperTo?: readonly string[];
}

/** Effect location is mandatory; effectIndex preserves the original effects-array order within each phase. */
export interface LinkedBeatEffect {
  itemRef: number;
  phase: 'beforeItem' | 'afterItem';
  effectIndex: number;
  effect: BeatEffect | UnknownEvent;
}

/** Interrupt addresses are structural only; the scheduler must check pending status and actor eligibility. */
export interface PendingItemReference {
  turnId: string;
  turnRevision: number;
  beatIndex: number;
  itemIndex: number;
}

/** A pure decoded beat; empty items terminate normally and cannot contain effects. */
export interface DecodedBeat {
  envelope: EngineEventEnvelope;
  origin: EventOrigin;
  actorId: string;
  intent?: { goal: string; next: string };
  interrupt?: PendingItemReference;
  items: readonly BeatItem[];
  effects: readonly LinkedBeatEffect[];
}

/** Ordered projection of retained items; omitted items carry no effects, and indices are never compacted. */
export interface ProjectedBeatItem {
  item: BeatItem;
  beforeItem: readonly LinkedBeatEffect[];
  afterItem: readonly LinkedBeatEffect[];
}

/** Structural sub-event address; item/effect indices retain their decoded zero-based positions. */
export interface TavernEventAddress extends EventReference {
  phase: 'event' | 'beforeItem' | 'item' | 'afterItem';
  itemRef?: number | null;
  effectIndex?: number | null;
}

/**
 * Caller-validated content permission in the input world's scope. Missing entries grant nothing.
 * basis lists all earlier event dependencies; readers must know every basis, including through authorship.
 * observableBy separately grants visibility of the whisper act, never its content or private reasons.
 */
export interface TavernEventPermission {
  address: TavernEventAddress;
  readers: readonly string[];
  observableBy: readonly string[];
  basis: readonly TavernEventAddress[];
}

/**
 * A routed structural event, independent of rendered prose. sequence is a positive ordered event count.
 * quote is the exact original text, or empty for non-text effects; no message offsets are fabricated.
 * eventId identifies the full structural address, while source.eventId retains the original ledger ID.
 */
export interface EventObservation {
  eventId: string;
  sequence: number;
  source: TavernEventAddress & { channel: 'event' };
  actorId: string;
  perceptionKind: 'heard' | 'observed' | 'diagnostic';
  quote: string;
  content: EventPayload | BeatItem;
  readers: readonly string[];
}

/** Closed supplementary input channels; opaque structured values are never parsed, summarized or interpreted. */
export interface TavernPerceptionMaterial {
  id: string;
  channel: 'memory' | 'recall' | 'emotion' | 'candidate' | 'diagnostic' | 'possession' | 'commitment' | 'physiology';
  readers: readonly string[];
  basis: readonly TavernEventAddress[];
  value: unknown;
}

/** Validated source set; all presence and position values come exclusively from the supplied world projection. */
export interface TavernPerceptionInput {
  baseline: import('./projection.ts').TavernWorldSnapshot;
  steps: readonly import('./projection.ts').TavernProjectionStep[];
  playerId: string;
  permissions: readonly TavernEventPermission[];
  materials?: readonly TavernPerceptionMaterial[] | null;
  geography?: {
    freshPositions: readonly {
      entityId: string;
      basis: import('./projection.ts').TavernProjectionBasis;
    }[];
    adjacent: readonly { fromId: string; toId: string }[];
  } | null;
}

/** Detached per-actor input; authorship does not add the author to a whisper's routed readers. */
export interface TavernActorEventView {
  actorId: string;
  inbox: readonly EventObservation[];
  authoredEvents: readonly EventObservation[];
  materials: readonly TavernPerceptionMaterial[];
}

/** Content-free observable whisper act; includes only its structural source and visible participants. */
export interface TavernWhisperMarker {
  source: TavernEventAddress & { channel: 'event' };
  actorId: string;
  recipientIds: readonly string[];
  kind: 'whisper';
}

/** Player input for both renderers; it contains neither hidden beat fields nor inaccessible original content. */
export interface TavernPlayerEventView {
  playerRenderableEvents: readonly EventObservation[];
  whisperMarkers: readonly TavernWhisperMarker[];
}

/** Prepared input and opaque delivery receipt; cursor movement is a separate explicit consumption operation. */
export interface TavernPerceptionDispatch {
  input: TavernActorEventView & {
    deliveryCursor: number;
    turnWindow: readonly EventObservation[];
  };
  receipt: object;
}
