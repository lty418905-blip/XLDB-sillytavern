import {foldForMatch,includesForMatch,sourceQuote,scriptQuoteSearch} from '../common/script-fold.ts';
import type {
  KnowledgeKind,
  EventSourceObservation,
  Observation,
  ObservationCandidate,
  PerspectivePlan,
  SceneCharacter,
  SceneEnvelope,
  SceneMessage,
  SceneRoster,
} from './types.ts';
import { emotionSettingsOf } from '../emotion/openher.ts';
import type { EventObservation } from './tavern-engine/types.ts';

const MAX_CHARACTERS = 32;
const MAX_ALIASES = 16;
const MAX_SOURCE_LENGTH = 20_000;
const MAX_OBSERVATIONS = 12;
const MAX_UNRESOLVED = 8;
const knowledgeKinds = new Set<KnowledgeKind>(['observed', 'heard', 'private', 'thought', 'inferred']);

/**
 * Most identity references one observation may cite: the compact identityRefs a
 * model returns, and the history quotes they become. Eight lets a crowded scene
 * name each listener, since one fragment can also name several people at once.
 */
export const MAX_IDENTITY_REFERENCES = 8;

/**
 * Returns the id of the sole character with an own, literal-true card flag, or undefined.
 * The roster is trusted stored data; the scan is O(character count), stopping at a second flag.
 */
export function cardCharacterIdOf(roster: SceneRoster): string | undefined {
  let characterId: string | undefined;

  for (const character of roster.characters) {
    if (!Object.hasOwn(character, 'cardCharacter')
      || (character as SceneCharacter & { cardCharacter?: unknown }).cardCharacter !== true) continue;

    if (characterId !== undefined) return undefined;
    characterId = character.id;
  }

  return characterId;
}

/** Returns whether a trusted stored message has its own literal-true narrator flag; absent/null is false. */
export function isNarratorSource(message: SceneMessage): boolean {
  return Object.hasOwn(message, 'narrator')
    && (message as SceneMessage & { narrator?: unknown }).narrator === true;
}

export function rosterOf(value: unknown): SceneRoster {
  const input = record(value, 'invalid_scene_roster');
  if (!Array.isArray(input.characters) || input.characters.length < 1 || input.characters.length > MAX_CHARACTERS) {
    fail('invalid_scene_roster');
  }
  const characters = input.characters.map(characterOf);
  if (new Set(characters.map(character => character.id)).size !== characters.length) fail('invalid_scene_roster');
  return { characters };
}

export function envelopeOf(value: unknown, roster: SceneRoster): SceneEnvelope {
  const input = record(value, 'invalid_scene_envelope');
  const targetId = idText(input.targetId, 'invalid_scene_envelope');
  if (input.mode !== 'direct' && input.mode !== 'scene') fail('invalid_scene_envelope');
  const mode = input.mode;
  const presentIds = idList(input.presentIds, MAX_CHARACTERS, 'invalid_scene_envelope');
  const ids = rosterIds(roster);
  if (!ids.has(targetId) || presentIds.some(id => !ids.has(id))) fail('invalid_scene_character');
  if (!presentIds.includes(targetId)) fail('invalid_scene_envelope');
  if (mode === 'direct' && (presentIds.length !== 1 || presentIds[0] !== targetId)) fail('invalid_scene_envelope');
  const playerName=input.playerName===undefined ? undefined : boundedText(input.playerName,200,'invalid_scene_envelope');
  return { targetId, mode, presentIds, ...(playerName?{playerName}:{}) };
}

export function perspectiveOf(value: unknown, message: SceneMessage, roster: SceneRoster, history:SceneMessage[]=[]): PerspectivePlan {
  const envelope = checkedMessage(message, roster);
  if (envelope.mode === 'direct') fail('invalid_scene_direct');

  const input = record(value, 'invalid_scene_perspective');
  if (!Array.isArray(input.observations) || input.observations.length > MAX_OBSERVATIONS) {
    fail('invalid_scene_perspective');
  }
  if (!Array.isArray(input.unresolved) || input.unresolved.length > MAX_UNRESOLVED) {
    fail('invalid_scene_perspective');
  }
  const unresolved = input.unresolved.map(item => boundedText(item, 500, 'invalid_scene_perspective'));
  const observations = input.observations.map(value => observationOf(value, message, roster, envelope, history));
  if (new Set(observations.map(observation => observation.id)).size !== observations.length) {
    fail('invalid_scene_perspective');
  }
  return { observations, unresolved };
}

/**
 * Captures one routed event's source, classification and audience as plain data in O(reader entries).
 * Reader arrays use one length read and one read per element. Getter/Proxy errors escape unchanged;
 * malformed values remain data for the event decoder to reject, without invoking caller iterators.
 */
export function snapshotEventObservation(value: Omit<EventObservation, 'content'>): Omit<EventObservation, 'content'> {
  const {source, eventId, actorId, sequence, perceptionKind, quote, readers: suppliedReaders} = value;
  const {channel, turnId, turnRevision, eventId: sourceEventId, phase, itemRef, effectIndex} = source ?? {};
  let readers = suppliedReaders;
  if (Array.isArray(suppliedReaders)) {
    const length = suppliedReaders.length;
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid_event_observation');
    const detachedReaders: string[] = [];
    for (let index = 0; index < length; index++) detachedReaders.push(suppliedReaders[index]!);
    readers = detachedReaders;
  }
  return {
    eventId,
    actorId,
    sequence,
    perceptionKind,
    quote,
    readers,
    source: {channel, turnId, turnRevision, eventId: sourceEventId, phase, itemRef, effectIndex},
  };
}

/**
 * Decodes one trusted routed event into a scene observation for an authorized actor. Work is O(readers + text).
 * Invalid/missing references, diagnostic events and actors outside both delivery and authorship throw a code.
 * Getter/Proxy failures propagate unchanged. No display body is consulted; output never aliases the route.
 */
export function eventObservationOf(value: Omit<EventObservation, 'content'>, characterId: string): EventSourceObservation {
  const snapshot = snapshotEventObservation(value);
  const {source, eventId: observationId, actorId, sequence, perceptionKind, quote, readers} = snapshot;
  const {channel, turnId, turnRevision, eventId, phase, itemRef, effectIndex} = source ?? {};
  if (!source || channel !== 'event'
    || typeof turnId !== 'string' || turnId.length === 0
    || !Number.isSafeInteger(turnRevision) || turnRevision < 1
    || typeof eventId !== 'string' || eventId.length === 0
    || !['event', 'item', 'beforeItem', 'afterItem'].includes(phase)
    || (phase === 'event' ? itemRef != null : !Number.isSafeInteger(itemRef) || itemRef! < 0)
    || (phase === 'beforeItem' || phase === 'afterItem'
      ? !Number.isSafeInteger(effectIndex) || effectIndex! < 0 : effectIndex != null)
    || typeof observationId !== 'string' || observationId.length === 0
    || typeof actorId !== 'string' || actorId.length === 0
    || !Number.isSafeInteger(sequence) || sequence < 1
    || !['heard', 'observed'].includes(perceptionKind)
    || typeof quote !== 'string'
    || !Array.isArray(readers)
    || (actorId !== characterId && !readers.includes(characterId))) {
    throw new Error('invalid_event_observation');
  }

  return {
    channel: 'event',
    ref: {
      turnId,
      turnRevision,
      eventId,
      phase,
      ...(itemRef == null ? {} : {itemRef}),
      ...(effectIndex == null ? {} : {effectIndex}),
    },
    sequence,
    id: observationId,
    kind: perceptionKind === 'heard' ? 'heard' : 'observed',
    quote,
    actorId,
    attributed: true,
    evidence: quote,
    readers: [characterId],
  };
}

/**
 * Joins this reader's validated quotes, ordered by legacy UTF-16 spans or event sequence counts.
 * Unresolved plans throw; an actor with no visible observations receives an empty string.
 */
export function visibleText(plan: PerspectivePlan, characterId: string): string {
  if (plan.unresolved.length) fail('invalid_scene_unresolved');
  const seen = new Set<string>();
  return [...plan.observations]
    .filter(observation => observation.readers.includes(characterId))
    .sort((left, right) => {
      if (left.channel === 'event' || right.channel === 'event') {
        if (left.channel !== 'event') return -1;
        if (right.channel !== 'event') return 1;
        return left.sequence - right.sequence || left.id.localeCompare(right.id);
      }
      return left.start - right.start || left.end - right.end || left.id.localeCompare(right.id);
    })
    .flatMap(observation => {
      const key = observation.channel === 'event'
        ? JSON.stringify(observation.ref)
        : `${observation.start}:${observation.end}:${observation.quote}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [observation.quote];
    })
    .join('\n');
}

/**
 * Deterministic path for a user speaking only to the selected target, or for a
 * selected assistant speaker addressing the envelope chosen by the user.
 */
export function directPlan(message: SceneMessage, roster: SceneRoster): PerspectivePlan {
  const envelope = checkedMessage(message, roster);
  if (message.role === 'user' && envelope.mode !== 'direct') fail('invalid_scene_direct');
  const actorId = message.role === 'assistant' ? checkedSpeaker(message, roster, envelope) : 'player';
  const readers = message.role === 'assistant' ? [...envelope.presentIds] : [envelope.targetId];
  if (message.role === 'assistant' && !readers.includes(actorId)) fail('invalid_scene_readers');
  const observation: Observation = {
    id: `${message.id}:direct:0`,
    kind: 'heard',
    start: 0,
    end: message.text.length,
    quote: message.text,
    actorId,
    recipients: [...readers],
    evidence: message.text,
    readers: [...new Set(readers)],
    ...(message.role === 'assistant' && envelope.mode === 'direct'
      ? {playerVisible:true,playerEvidence:message.text} : {}),
  };
  return { observations: [observation], unresolved: [] };
}

function characterOf(value: unknown): SceneCharacter {
  const input = record(value, 'invalid_scene_roster');
  // A stable id is mandatory. Names and aliases are never promoted to ids.
  const id = idText(input.id, 'invalid_scene_roster');
  const name = idText(input.name, 'invalid_scene_roster');
  const persona = boundedText(input.persona, MAX_SOURCE_LENGTH, 'invalid_scene_roster', true);
  if (!Array.isArray(input.aliases) || input.aliases.length > MAX_ALIASES) fail('invalid_scene_roster');
  const aliases = input.aliases.map(alias => idText(alias, 'invalid_scene_roster'));
  const identitySource = input.identitySource === undefined ? undefined : identitySourceOf(input.identitySource);
  if (identitySource?.kind === 'manual' && !persona.trim()) fail('invalid_scene_roster');
  return { id, name, aliases: [...new Set(aliases)], persona,
    ...(input.emotion===undefined?{}:{emotion:emotionSettingsOf(input.emotion)}),
    ...(identitySource===undefined?{}:{identitySource}) };
}

function identitySourceOf(value: unknown): NonNullable<SceneCharacter['identitySource']> {
  const input = record(value, 'invalid_scene_roster');
  if (input.kind === 'manual') return { kind: 'manual' };
  if (input.kind !== 'automatic' || !Array.isArray(input.evidence)
    || input.evidence.length < 1 || input.evidence.length > 32) fail('invalid_scene_roster');
  const evidence = input.evidence.map(value => {
    const item = record(value, 'invalid_scene_roster');
    const documentHash = boundedText(item.documentHash, 64, 'invalid_scene_roster');
    if (!/^[a-f0-9]{64}$/.test(documentHash)) fail('invalid_scene_roster');
    return {
      sourceId: idText(item.sourceId, 'invalid_scene_roster'),
      quote: boundedText(item.quote, 2_000, 'invalid_scene_roster'),
      documentHash,
    };
  });
  if (new Set(evidence.map(item => JSON.stringify(item))).size !== evidence.length) fail('invalid_scene_roster');
  return { kind: 'automatic', evidence };
}

function checkedMessage(message: SceneMessage, roster: SceneRoster): SceneEnvelope {
  if (!message || typeof message !== 'object') fail('invalid_scene_message');
  idText(message.id, 'invalid_scene_message');
  if (!Number.isSafeInteger(message.revision) || message.revision < 1) fail('invalid_scene_message');
  if (!Number.isSafeInteger(message.acceptedAtMs) || message.acceptedAtMs < 0) fail('invalid_scene_message');
  boundedText(message.text, MAX_SOURCE_LENGTH, 'invalid_scene_message');
  if (message.role !== 'user' && message.role !== 'assistant') fail('invalid_scene_message');
  const envelope = envelopeOf(message.envelope, roster);
  if (message.automatic && envelope.mode!=='scene') fail('invalid_scene_envelope');
  if (message.role === 'assistant' && !message.automatic) checkedSpeaker(message, roster, envelope);
  return envelope;
}

function checkedSpeaker(message: SceneMessage, roster: SceneRoster, envelope: SceneEnvelope): string {
  if (typeof message.speakerId !== 'string' || !rosterIds(roster).has(message.speakerId)) fail('invalid_scene_speaker');
  if (message.speakerId !== envelope.targetId) fail('invalid_scene_speaker');
  return message.speakerId;
}

function observationOf(value: unknown, message: SceneMessage, roster: SceneRoster, envelope: SceneEnvelope, history:SceneMessage[]): Observation {
  const input = record(value, 'invalid_scene_perspective');
  // Event sources require the trusted routed decoder; they cannot fall back to message offsets.
  if (input.channel === 'event') fail('invalid_event_observation');
  const candidate: ObservationCandidate = {
    ...(input.playerVisible === true ? {playerVisible:true} : {}),
    id: idText(input.id, 'invalid_scene_perspective'),
    kind: kindOf(input.kind),
    start: offsetOf(input.start),
    end: offsetOf(input.end),
    quote: boundedText(input.quote, MAX_SOURCE_LENGTH, 'invalid_scene_quote'),
    actorId: idText(input.actorId, 'invalid_scene_character'),
    recipients: idList(input.recipients, MAX_CHARACTERS, 'invalid_scene_readers'),
    evidence: boundedText(input.evidence, MAX_SOURCE_LENGTH, 'invalid_scene_evidence'),
  };

  if (candidate.playerVisible && ['private','thought','inferred'].includes(candidate.kind)) fail('invalid_scene_readers');
  if (candidate.playerVisible) {
    const playerEvidence=coveringQuote(message.text,boundedText(input.playerEvidence,MAX_SOURCE_LENGTH,'invalid_scene_player_evidence'),candidate.start,candidate.end);
    if (playerEvidence===null) fail('invalid_scene_player_evidence');
    const anchored=(message.role==='user' ? /你|您|玩家|我/ : /你|您|玩家/).test(foldForMatch(playerEvidence))
      || Boolean(envelope.playerName && includesForMatch(playerEvidence,envelope.playerName));
    if(anchored) candidate.playerEvidence=playerEvidence;
    else delete candidate.playerVisible;
  }

  if (candidate.start >= candidate.end || candidate.end > message.text.length) fail('invalid_scene_offset');
  if (foldForMatch(message.text.slice(candidate.start, candidate.end)) !== foldForMatch(candidate.quote)) fail('invalid_scene_quote');
  candidate.quote=message.text.slice(candidate.start,candidate.end);
  const evidence=coveringQuote(message.text,candidate.evidence,candidate.start,candidate.end);
  if(evidence===null) fail('invalid_scene_evidence');
  candidate.evidence=evidence;
  if(input.identityQuote!==undefined && input.identityQuote!=='') {
    const quote=sourceQuote(message.text,boundedText(input.identityQuote,4000,'invalid_scene_evidence'));
    if(quote===null) fail('invalid_scene_evidence');
    candidate.identityQuote=quote;
  }
  if (input.identityEvidence!==undefined) {
    if (!message.automatic || !Array.isArray(input.identityEvidence) || input.identityEvidence.length>MAX_IDENTITY_REFERENCES) fail('invalid_scene_evidence');
    candidate.identityEvidence=input.identityEvidence.map(value=>{
      const reference=record(value,'invalid_scene_evidence');
      const sourceId=idText(reference.sourceId,'invalid_scene_evidence');
      const inputQuote=boundedText(reference.quote,4000,'invalid_scene_evidence');
      const origin=history.find(item=>item.id===sourceId);
      if(!origin) fail('invalid_scene_evidence');
      const quote=sourceQuote(origin.text,inputQuote);
      if(quote===null) fail('invalid_scene_evidence');
      return {sourceId,quote,revision:origin.revision};
    });
  }

  const ids = rosterIds(roster);
  if (!ids.has(candidate.actorId) || candidate.recipients.some(id => !ids.has(id))) fail('invalid_scene_character');
  const allowed = new Set(envelope.presentIds);
  if (!allowed.has(candidate.actorId) || candidate.recipients.some(id => !allowed.has(id))) fail('invalid_scene_readers');
  if (message.role === 'assistant' && !message.automatic && candidate.actorId !== checkedSpeaker(message, roster, envelope)) fail('invalid_scene_speaker');

  let readers: string[];
  switch (candidate.kind) {
    case 'thought':
    case 'inferred':
      if (candidate.recipients.length) fail('invalid_scene_readers');
      readers = [candidate.actorId];
      break;
    case 'private':
      if (!candidate.recipients.length) fail('invalid_scene_readers');
      readers = [...new Set([candidate.actorId, ...candidate.recipients])];
      break;
    case 'heard':
      // An unproven audience grants no access; the speaker still knows their own words.
      readers = [...new Set([candidate.actorId, ...candidate.recipients])];
      break;
    case 'observed':
      if (!candidate.recipients.length) fail('invalid_scene_readers');
      readers = [...new Set(candidate.recipients)];
      break;
  }
  if (readers.some(id => !allowed.has(id))) fail('invalid_scene_readers');

  if (message.automatic) {
    const identityEvidence = [
      candidate.evidence,
      candidate.identityQuote ?? '',
      ...(candidate.identityEvidence ?? []).map(item => item.quote),
    ].join('\n');
    // Product presence default applies only to the card character in automatic prose.
    // Other readers still need literal identity evidence; narrator sources have no default speaker.
    const cardCharacterId = isNarratorSource(message) ? undefined : cardCharacterIdOf(roster);
    if (candidate.actorId !== cardCharacterId) requireIdentity(identityEvidence, candidate.actorId, roster);

    if (candidate.kind === 'private' || candidate.kind === 'heard') {
      for (const recipient of candidate.recipients) {
        if (recipient !== cardCharacterId) requireIdentity(identityEvidence, recipient, roster);
      }
    }
    if (candidate.kind === 'observed') {
      for (const recipient of candidate.recipients) {
        if (recipient !== cardCharacterId) requireIdentity(identityEvidence, recipient, roster);
      }
    }
  } else {
    // perspectiveOf rejects direct envelopes, so a message that is not automatic is a manual scene message here.
    requireHostListedIdentity(candidate, readers, message, envelope, roster);
  }

  // Structural checks prevent thought/inference text from gaining other readers.
  // They cannot prove that one literal quote does not combine unrelated secrets;
  // ambiguous semantic grouping must remain unresolved for the management UI.
  return { ...candidate, recipients: [...new Set(candidate.recipients)], readers };
}

/**
 * Identity rule for a manual scene message, whose envelope is the user's own
 * list of present characters. Being present needs no literal name; only an
 * audience narrower than everyone present does:
 * - heard or observed read by every present character: accepted as it is;
 * - heard or observed that leaves someone present out: accepted when every
 *   present character left out is named in the evidence or identity quote
 *   (the text saying why they are left out), or else when the literal-name rule
 *   holds for the readers;
 * - private, thought and inferred always keep the literal-name rule.
 */
function requireHostListedIdentity(candidate: ObservationCandidate, readers: string[], message: SceneMessage, envelope: SceneEnvelope, roster: SceneRoster): void {
  const sharedKind = candidate.kind === 'heard' || candidate.kind === 'observed';
  if (!sharedKind) {
    requireLiteralParticipants(candidate, readers, message, roster);
    return;
  }
  const readerIds = new Set(readers);
  const excludedIds = envelope.presentIds.filter(id => !readerIds.has(id));
  if (excludedIds.length === 0) return;
  const exclusionEvidence = [candidate.evidence, candidate.identityQuote ?? ''].join('\n');
  const everyExcludedNamed = excludedIds.every(id => identityProven(exclusionEvidence, id, roster));
  if (everyExcludedNamed) return;
  requireLiteralParticipants(candidate, readers, message, roster);
}

/**
 * Literal-name rule of a manual scene message. A user message names its actor
 * and every reader in the evidence or identity quote. An assistant message
 * names every reader except its speaker, whose identity the envelope fixes, in
 * the evidence alone, so a name elsewhere in the reply grants nobody the quote.
 */
function requireLiteralParticipants(candidate: ObservationCandidate, readers: string[], message: SceneMessage, roster: SceneRoster): void {
  if (message.role === 'user') {
    const userEvidence = [candidate.evidence, candidate.identityQuote ?? ''].join('\n');
    const participants = new Set([candidate.actorId, ...readers]);
    for (const participant of participants) requireIdentity(userEvidence, participant, roster);
    return;
  }
  for (const reader of readers) {
    if (reader !== candidate.actorId) requireIdentity(candidate.evidence, reader, roster);
  }
}

function requireIdentity(evidence: string, characterId: string, roster: SceneRoster): void {
  if (!identityProven(evidence, characterId, roster)) fail('invalid_scene_identity');
}

/**
 * True when the evidence names the character by its stable id, or by one of its
 * labels. A label proves the character when the spelling found in the evidence
 * belongs to this character alone: characters owning that exact spelling decide
 * first, and only when none owns it exactly does the folded (script-insensitive)
 * spelling decide. Either way exactly one owner must remain.
 */
function identityProven(evidence: string, characterId: string, roster: SceneRoster): boolean {
  if (identityMention(evidence, characterId, false)) return true;
  const character = roster.characters.find(item => item.id === characterId);
  if (!character) fail('invalid_scene_character');
  for (const label of [character.name, ...character.aliases]) {
    const quote=identityQuote(evidence,label);
    if(quote===undefined)continue;
    const exact=roster.characters.filter(item=>[item.name,...item.aliases].includes(quote));
    const owners=exact.length?exact:roster.characters.filter(item=>[item.name,...item.aliases].some(name=>foldForMatch(name)===foldForMatch(quote)));
    if (owners.length === 1 && owners[0]?.id === characterId) return true;
  }
  return false;
}

function identityMention(evidence: string, label: string, fold=true): boolean {
  return identityQuote(evidence,label,fold)!==undefined;
}

function identityQuote(evidence:string,label:string,fold=true):string|undefined {
  const source=evidence;
  if(fold){const exact=identityQuote(evidence,label,false);if(exact!==undefined)return exact;evidence=foldForMatch(evidence);label=foldForMatch(label);}
  // Latin identifiers/names must be whole tokens, never substrings such as a in rain.
  const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const match=new RegExp(`${/^[A-Za-z0-9_]/.test(label)?'(?<![A-Za-z0-9_-])':''}${escaped}${/[A-Za-z0-9_]$/.test(label)?'(?![A-Za-z0-9_-])':''}`,'u').exec(evidence);
  return match?source.slice(match.index,match.index+match[0].length):undefined;
}

function coveringQuote(source: string, evidence: string, quoteStart: number, quoteEnd: number): string|null {
  // O(n + m), including repeated occurrences; bind the spelling covering this observation.
  return scriptQuoteSearch(source,evidence,source.length+1).matches
    .find(match=>match.start<=quoteStart&&match.end>=quoteEnd)?.quote??null;
}

function kindOf(value: unknown): KnowledgeKind {
  if (typeof value !== 'string' || !knowledgeKinds.has(value as KnowledgeKind)) fail('invalid_scene_perspective');
  return value as KnowledgeKind;
}

function offsetOf(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('invalid_scene_offset');
  return value as number;
}

function idList(value: unknown, max: number, code: string): string[] {
  if (!Array.isArray(value) || value.length > max) fail(code);
  return [...new Set(value.map(item => idText(item, code)))];
}

function rosterIds(roster: SceneRoster): Set<string> {
  return new Set(roster.characters.map(character => character.id));
}

function boundedText(value: unknown, max: number, code: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(code);
  return value;
}

function idText(value: unknown, code: string): string {
  const result = boundedText(value, 200, code);
  if (result !== result.trim()) fail(code);
  return result;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function fail(code: string): never {
  throw new Error(code);
}
