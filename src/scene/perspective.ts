import type {
  KnowledgeKind,
  Observation,
  ObservationCandidate,
  PerspectivePlan,
  SceneCharacter,
  SceneEnvelope,
  SceneMessage,
  SceneRoster,
} from './types.ts';
import { emotionSettingsOf } from '../emotion/openher.ts';

const MAX_CHARACTERS = 32;
const MAX_ALIASES = 16;
const MAX_SOURCE_LENGTH = 20_000;
const MAX_OBSERVATIONS = 12;
const MAX_UNRESOLVED = 8;
const knowledgeKinds = new Set<KnowledgeKind>(['observed', 'heard', 'private', 'thought', 'inferred']);

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

export function visibleText(plan: PerspectivePlan, characterId: string): string {
  if (plan.unresolved.length) fail('invalid_scene_unresolved');
  const seen = new Set<string>();
  return [...plan.observations]
    .filter(observation => observation.readers.includes(characterId))
    .sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id))
    .flatMap(observation => {
      const key = `${observation.start}:${observation.end}:${observation.quote}`;
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
    const playerEvidence=boundedText(input.playerEvidence,MAX_SOURCE_LENGTH,'invalid_scene_player_evidence');
    if (!evidenceCovers(message.text,playerEvidence,candidate.start,candidate.end)) fail('invalid_scene_player_evidence');
    const anchored=(message.role==='user' ? /你|您|玩家|我/ : /你|您|玩家/).test(playerEvidence)
      || Boolean(envelope.playerName && playerEvidence.includes(envelope.playerName));
    if(anchored) candidate.playerEvidence=playerEvidence;
    else delete candidate.playerVisible;
  }

  if (candidate.start >= candidate.end || candidate.end > message.text.length) fail('invalid_scene_offset');
  if (message.text.slice(candidate.start, candidate.end) !== candidate.quote) fail('invalid_scene_quote');
  if (!evidenceCovers(message.text, candidate.evidence, candidate.start, candidate.end)) fail('invalid_scene_evidence');
  if(input.identityQuote!==undefined && input.identityQuote!=='') {
    const quote=boundedText(input.identityQuote,4000,'invalid_scene_evidence');
    if(!message.text.includes(quote)) fail('invalid_scene_evidence');
    candidate.identityQuote=quote;
  }
  if (input.identityEvidence!==undefined) {
    if (!message.automatic || !Array.isArray(input.identityEvidence) || input.identityEvidence.length>4) fail('invalid_scene_evidence');
    candidate.identityEvidence=input.identityEvidence.map(value=>{
      const reference=record(value,'invalid_scene_evidence');
      const sourceId=idText(reference.sourceId,'invalid_scene_evidence');
      const quote=boundedText(reference.quote,4000,'invalid_scene_evidence');
      const origin=history.find(item=>item.id===sourceId);
      if(!origin || !origin.text.includes(quote)) fail('invalid_scene_evidence');
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

  if ((message.role === 'user' && envelope.mode === 'scene') || message.automatic) {
    const identityEvidence=[candidate.evidence,candidate.identityQuote??'',...(candidate.identityEvidence??[]).map(item=>item.quote)].join('\n');
    requireIdentity(identityEvidence, candidate.actorId, roster);
    if (candidate.kind === 'private' || candidate.kind === 'heard') {
      for (const recipient of candidate.recipients) requireIdentity(identityEvidence, recipient, roster);
    }
    if(message.automatic && candidate.kind==='observed') for(const recipient of candidate.recipients) requireIdentity(identityEvidence,recipient,roster);
  } else if (message.role === 'assistant') {
    for (const recipient of candidate.recipients) {
      if (recipient !== candidate.actorId) requireIdentity(candidate.evidence, recipient, roster);
    }
  }

  // Structural checks prevent thought/inference text from gaining other readers.
  // They cannot prove that one literal quote does not combine unrelated secrets;
  // ambiguous semantic grouping must remain unresolved for the management UI.
  return { ...candidate, recipients: [...new Set(candidate.recipients)], readers };
}

function requireIdentity(evidence: string, characterId: string, roster: SceneRoster): void {
  if (identityMention(evidence, characterId)) return;
  const character = roster.characters.find(item => item.id === characterId);
  if (!character) fail('invalid_scene_character');
  for (const label of [character.name, ...character.aliases]) {
    if (!identityMention(evidence, label)) continue;
    const owners = roster.characters.filter(item => item.name === label || item.aliases.includes(label));
    if (owners.length === 1 && owners[0]?.id === characterId) return;
  }
  fail('invalid_scene_identity');
}

function identityMention(evidence: string, label: string): boolean {
  // Latin identifiers/names must be whole tokens, never substrings such as a in rain.
  const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`${/^[A-Za-z0-9_]/.test(label)?'(?<![A-Za-z0-9_-])':''}${escaped}${/[A-Za-z0-9_]$/.test(label)?'(?![A-Za-z0-9_-])':''}`,'u').test(evidence);
}

function evidenceCovers(source: string, evidence: string, quoteStart: number, quoteEnd: number): boolean {
  let start = source.indexOf(evidence);
  while (start >= 0) {
    if (start <= quoteStart && start + evidence.length >= quoteEnd) return true;
    start = source.indexOf(evidence, start + 1);
  }
  return false;
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
