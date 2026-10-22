import { CODEC_LIMITS } from './types.ts';
import type { TavernEventAddress, TavernPlayerEventView } from './types.ts';

/** SLOT-FALLBACK, 待 Claude. Empty notice wording; this module never supplies display copy. */
export const FALLBACK_NOTICE_SLOT = '';

/** SLOT-FALLBACK, 待 Claude. Empty item-layout wording, including speaker separators and quotation marks. */
export const FALLBACK_ITEM_LAYOUT_SLOT = '';

/** SLOT-FALLBACK, 待 Claude. Empty whisper-marker wording; participant data carries no whisper content. */
export const WHISPER_MARKER_SLOT = '';

/**
 * Per-render packet ceiling, not a history limit: eight beats times the codec's largest single-beat allowance.
 * This conservative contract bound permits every legal turn and bounds the distinct action-speaker scans.
 * Excess current-turn render items reject the packet; historical observations are filtered before counting.
 */
export const MAX_RENDER_ITEMS = 8 * CODEC_LIMITS.soloFirstItems;

/** Server-owned ticket identity; revisions are positive safe integers, versions are nonnegative safe integers. */
export interface TavernRenderIdentity {
  turnId: string;
  turnRevision: number;
  packetHash: string;
  sceneVersion: number;
  modelRevision: number;
  candidateId: string;
}

/** Existing display data, supplied by the caller. Referenced actors must have distinct, nonempty labels. */
export interface TavernRenderActor {
  actorId: string;
  displayLabel: string;
}

/**
 * Trusted local projection input, not a host-supplied ledger. view must be the current player projection
 * over validated, emitted selections. It cannot independently prove emission or source validity.
 * Actor labels are existing display data; ambiguous labels are rejected, never rewritten here.
 */
export interface TavernRenderInput {
  identity: TavernRenderIdentity;
  playerId: string;
  actors: readonly TavernRenderActor[];
  view: TavernPlayerEventView;
}

/** One emitted, player-visible item. Text is verbatim; source is structural and never a generated prose offset. */
export interface TavernRenderItem {
  source: TavernEventAddress;
  sequence: number;
  kind: 'speech' | 'action';
  actor: TavernRenderActor;
  addressees: readonly string[];
  whisperTo: readonly string[];
  text: string;
}

/** Visible whisper act only. Empty wording is a Claude-owned slot; no private text or reason is retained. */
export interface TavernRenderWhisper {
  source: TavernEventAddress;
  actor: TavernRenderActor;
  recipients: readonly TavernRenderActor[];
  wording: typeof WHISPER_MARKER_SLOT;
}

/**
 * Detached, bounded render data. validated_tentative is not accepted history.
 * Markers remain a separate ordered list: the perception marker type has no global sequence number.
 */
export interface TavernRenderPacket {
  identity: TavernRenderIdentity;
  state: 'validated_tentative';
  items: readonly TavernRenderItem[];
  whisperMarkers: readonly TavernRenderWhisper[];
}

/** Actual UTF-16 character comparisons and visited items, with no clock or timer involved. */
export interface TavernRenderWork {
  prefixComparisons: number;
  bodyComparisons: number;
  itemsVisited: number;
  actionSpeakerScans: number;
}

/** A mechanical match span in UTF-16 units, end-exclusive; it is not evidence of a semantic action. */
export interface TavernRenderMatch {
  source: TavernEventAddress;
  actorId: string;
  start: number;
  end: number;
}

/** Internal machine reasons only; no diagnostic is user-facing copy or a semantic quality verdict. */
export type TavernRenderFailure = 'invalid_body' | 'speech_missing_or_out_of_order' | 'action_speaker_missing';

/**
 * Only speech identity/order and literal action-speaker presence are checked. A true result does not establish
 * action preservation, correct attribution, absence of added facts, privacy of invented prose, or acceptance.
 * On failure, reason is populated and matches contains only the mechanically established prefix.
 */
export interface TavernRenderVerification {
  ok: boolean;
  reason: TavernRenderFailure | null;
  speechMatches: TavernRenderMatch[];
  actionSpeakerMatches: TavernRenderMatch[];
  semanticQuality: 'not_checked';
  work: TavernRenderWork;
}

/** Structured A data only. All new display wording is empty; item text and labels are copied from the packet. */
export interface TavernFallbackLayout {
  kind: 'A';
  identity: TavernRenderIdentity;
  notice: typeof FALLBACK_NOTICE_SLOT;
  itemLayout: typeof FALLBACK_ITEM_LAYOUT_SLOT;
  items: readonly TavernRenderItem[];
  whisperMarkers: readonly TavernRenderWhisper[];
}

/**
 * B decision for one candidate. A failure selects A immediately and remains recorded on repeat calls.
 * elapsedMs is caller-measured nonnegative finite milliseconds, not a duration measured by this module.
 * Neither choice accepts events nor permits regeneration. The host and authority own invalidation and commit.
 */
export interface TavernRenderDecision {
  identity: TavernRenderIdentity;
  presentation: 'A' | 'B';
  verification: TavernRenderVerification;
  renderVerificationFailures: number;
  fallbackUsed: boolean;
  fallback: TavernFallbackLayout | null;
  elapsedMs: number;
  accepted: false;
  regenerationAllowed: false;
}

function requireText(value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid_render_input');
  return value;
}

function requireInteger(value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('invalid_render_input');
  return value;
}

function copySource(source: TavernEventAddress): TavernEventAddress {
  const address: TavernEventAddress = {
    turnId: requireText(source.turnId),
    turnRevision: requireInteger(source.turnRevision, 1),
    eventId: requireText(source.eventId),
    phase: source.phase,
  };
  if (address.phase === 'item') {
    address.itemRef = requireInteger(source.itemRef!, 0);
  } else if (address.phase !== 'event' || source.itemRef != null) {
    throw new Error('invalid_render_input');
  }
  if (source.effectIndex != null) throw new Error('invalid_render_input');
  return address;
}

function copyPacket(input: TavernRenderInput): TavernRenderPacket {
  const suppliedIdentity = input.identity;
  const identity: TavernRenderIdentity = {
    turnId: requireText(suppliedIdentity.turnId),
    turnRevision: requireInteger(suppliedIdentity.turnRevision, 1),
    packetHash: requireText(suppliedIdentity.packetHash),
    sceneVersion: requireInteger(suppliedIdentity.sceneVersion, 0),
    modelRevision: requireInteger(suppliedIdentity.modelRevision, 0),
    candidateId: requireText(suppliedIdentity.candidateId),
  };
  const playerId = requireText(input.playerId);
  const labels = new Map<string, string>();
  const usedLabels = new Map<string, string>();
  for (const actor of input.actors) {
    const actorId = requireText(actor.actorId);
    const label = requireText(actor.displayLabel);
    if (labels.has(actorId)) throw new Error('invalid_render_input');
    labels.set(actorId, label);
  }

  function actorLabel(actorId: string): TavernRenderActor {
    const displayLabel = labels.get(actorId);
    if (displayLabel == null) throw new Error('invalid_render_input');
    const owner = usedLabels.get(displayLabel);
    // One shared name cannot establish two identities; disambiguation belongs to existing display data.
    if (owner != null && owner !== actorId) throw new Error('invalid_render_input');
    usedLabels.set(displayLabel, actorId);
    return { actorId, displayLabel };
  }

  function current(source: TavernEventAddress): boolean {
    return source.turnId === identity.turnId && source.turnRevision === identity.turnRevision;
  }

  const items: TavernRenderItem[] = [];
  const sources = new Set<string>();
  const view = input.view;
  let previousSequence = 0;
  for (const observation of view.playerRenderableEvents) {
    const suppliedSource = observation.source;
    if (!current(suppliedSource)) continue;
    const content = observation.content;
    const kind = content.kind;
    if (kind !== 'speech' && kind !== 'action' && kind !== 'NpcSpeech' && kind !== 'NpcAction') continue;
    if (observation.perceptionKind === 'diagnostic') continue;
    const actorId = requireText(observation.actorId);
    if (actorId === playerId || !observation.readers.includes(playerId)) continue;
    const whisperTo = 'whisperTo' in content ? [...(content.whisperTo ?? [])] : [];
    if (whisperTo.length > 0 && !whisperTo.includes(playerId)) continue;
    const source = copySource(suppliedSource);
    if (!current(source)) throw new Error('invalid_render_input');
    const key = JSON.stringify(source);
    const sequence = requireInteger(observation.sequence, 1);
    if (sequence <= previousSequence || sources.has(key)) throw new Error('invalid_render_input');
    if (content.actorId !== actorId) throw new Error('invalid_render_input');
    const text = requireText(content.text);
    if (text.length > CODEC_LIMITS.text || observation.quote !== text) throw new Error('invalid_render_input');
    const addressees = 'addressees' in content ? [...content.addressees] : [];
    addressees.forEach(requireText);
    whisperTo.forEach(requireText);
    if (items.length >= MAX_RENDER_ITEMS) throw new Error('invalid_render_input');
    items.push({
      source,
      sequence,
      kind: kind === 'speech' || kind === 'NpcSpeech' ? 'speech' : 'action',
      actor: actorLabel(actorId),
      addressees,
      whisperTo,
      text,
    });
    previousSequence = sequence;
    sources.add(key);
  }

  const whisperMarkers: TavernRenderWhisper[] = [];
  for (const marker of view.whisperMarkers) {
    const suppliedSource = marker.source;
    if (!current(suppliedSource)) continue;
    const source = copySource(suppliedSource);
    if (!current(source)) throw new Error('invalid_render_input');
    const key = JSON.stringify(source);
    if (marker.kind !== 'whisper' || sources.has(key) || marker.recipientIds.length === 0) {
      throw new Error('invalid_render_input');
    }
    if (items.length + whisperMarkers.length >= MAX_RENDER_ITEMS) throw new Error('invalid_render_input');
    whisperMarkers.push({
      source,
      actor: actorLabel(marker.actorId),
      recipients: marker.recipientIds.map(actorLabel),
      wording: WHISPER_MARKER_SLOT,
    });
    sources.add(key);
  }
  return { identity, state: 'validated_tentative', items, whisperMarkers };
}

// KMP avoids quadratic work on repeated-prefix prose. Prefix preparation costs < 2m comparisons;
// a forward search costs < 2n comparisons. Neither quotes, whitespace nor Unicode forms are normalized.
function findLiteral(body: string, pattern: string, start: number, work: TavernRenderWork): number {
  const prefixes = new Array<number>(pattern.length).fill(0);
  let matched = 0;
  for (let index = 1; index < pattern.length; index++) {
    while (true) {
      work.prefixComparisons++;
      if (pattern[index] === pattern[matched]) {
        matched++;
        break;
      }
      if (matched === 0) break;
      matched = prefixes[matched - 1];
    }
    prefixes[index] = matched;
  }

  matched = 0;
  for (let index = start; index < body.length; index++) {
    while (true) {
      work.bodyComparisons++;
      if (body[index] === pattern[matched]) {
        matched++;
        break;
      }
      if (matched === 0) break;
      matched = prefixes[matched - 1];
    }
    if (matched === pattern.length) return index - pattern.length + 1;
  }
  return -1;
}

function verify(packet: TavernRenderPacket, body: string): TavernRenderVerification {
  const result: TavernRenderVerification = {
    ok: false,
    reason: null,
    speechMatches: [],
    actionSpeakerMatches: [],
    semanticQuality: 'not_checked',
    work: { prefixComparisons: 0, bodyComparisons: 0, itemsVisited: 0, actionSpeakerScans: 0 },
  };
  if (typeof body !== 'string') {
    result.reason = 'invalid_body';
    return result;
  }

  let cursor = 0;
  for (const item of packet.items) {
    result.work.itemsVisited++;
    if (item.kind !== 'speech') continue;
    const start = findLiteral(body, item.text, cursor, result.work);
    if (start < 0) {
      result.reason = 'speech_missing_or_out_of_order';
      return result;
    }
    const end = start + item.text.length;
    result.speechMatches.push({ source: item.source, actorId: item.actor.actorId, start, end });
    // Consume the whole occurrence: duplicates and overlapping substrings cannot share one utterance.
    cursor = end;
  }

  const speakerPositions = new Map<string, number>();
  for (const item of packet.items) {
    result.work.itemsVisited++;
    if (item.kind !== 'action') continue;
    const actorId = item.actor.actorId;
    if (!speakerPositions.has(actorId)) {
      result.work.actionSpeakerScans++;
      speakerPositions.set(actorId, findLiteral(body, item.actor.displayLabel, 0, result.work));
    }
    const start = speakerPositions.get(actorId)!;
    if (start < 0) {
      result.reason = 'action_speaker_missing';
      return result;
    }
    result.actionSpeakerMatches.push({
      source: item.source,
      actorId,
      start,
      end: start + item.actor.displayLabel.length,
    });
  }
  result.ok = true;
  return result;
}

/**
 * One local render candidate, with no host, model, persistence, callback or clock capability.
 * Construction snapshots only public render fields, catches external getters, and throws invalid_render_input
 * without exposing supplied text. Work is O(input field bytes); no history-prefix recomputation is performed.
 * Callers must discard this instance when its authoritative ticket is invalidated; it cannot detect that itself.
 */
export class TavernRenderVerifier {
  #packet: TavernRenderPacket;
  #decision: TavernRenderDecision | null = null;

  /** Copies a validated emitted player view. Malformed structure, duplicate labels or throwing getters reject it. */
  constructor(input: TavernRenderInput) {
    try {
      this.#packet = copyPacket(input);
    } catch {
      throw new Error('invalid_render_input');
    }
  }

  /** Returns detached public data for B; it grants neither acceptance nor permission to reconstruct hidden events. */
  packet(): TavernRenderPacket {
    return structuredClone(this.#packet);
  }

  /**
   * Checks unlimited-length prose; never changes event or decision state. All spans use UTF-16 code units.
   * KMP work is O((1 + a)n + p), with a distinct action actors bounded by MAX_RENDER_ITEMS, n body length,
   * p total checked pattern length. Speech consumes one forward scan; each distinct action actor scans once.
   * Counters report real comparisons, not elapsed time. Non-string bodies return invalid_body.
   */
  verify(body: string): TavernRenderVerification {
    return structuredClone(verify(this.#packet, body));
  }

  /** Returns detached structured A data from the same packet; no text synthesis or acceptance occurs. */
  fallback(): TavernFallbackLayout {
    return structuredClone({
      kind: 'A',
      identity: this.#packet.identity,
      notice: FALLBACK_NOTICE_SLOT,
      itemLayout: FALLBACK_ITEM_LAYOUT_SLOT,
      items: this.#packet.items,
      whisperMarkers: this.#packet.whisperMarkers,
    });
  }

  /**
   * Records B verification; its first failure is sticky. Later notifications preserve that failure and duration.
   * Successful prose is checked again on each call, so changed text cannot reuse a previous successful verdict.
   * A later successful string cannot erase a failure or authorize retry.
   * Invalid elapsedMs throws invalid_render_duration before changing state; no callback is invoked.
   */
  evaluate(body: string, elapsedMs: number): TavernRenderDecision {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('invalid_render_duration');
    if (this.#decision?.fallbackUsed) return structuredClone(this.#decision);
    const verification = this.verify(body);
    this.#decision = {
      identity: this.#packet.identity,
      presentation: verification.ok ? 'B' : 'A',
      verification,
      renderVerificationFailures: verification.ok ? 0 : 1,
      fallbackUsed: !verification.ok,
      fallback: verification.ok ? null : this.fallback(),
      elapsedMs,
      accepted: false,
      regenerationAllowed: false,
    };
    return structuredClone(this.#decision);
  }
}
