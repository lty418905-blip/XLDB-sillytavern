import { perspectiveOf } from './perspective.ts';
import type { KnowledgeKind, PerspectivePlan, SceneCharacter, SceneMessage, SceneRoster } from './types.ts';

const MAX_OBSERVATIONS = 12;
const MAX_RECIPIENTS = 32;
const MAX_IDENTITY_REFS = 4;
const MAX_UNRESOLVED = 8;
const MAX_TEXT = 20_000;
const kinds = new Set<KnowledgeKind>(['observed', 'heard', 'private', 'thought', 'inferred']);

interface Segment {
  ref: string;
  text: string;
  start: number;
  end: number;
}

interface HistorySegment extends Segment {
  sourceId: string;
  revision: number;
  role: SceneMessage['role'];
}

export interface CompactPerspectiveInput {
  role: SceneMessage['role'];
  automatic: boolean;
  knownSpeaker: string | null;
  playerName: string | null;
  characters: { key: string; name: string; aliases: string[]; identityId?: string }[];
  current: Segment[];
  history: { ref: string; role: SceneMessage['role']; start: number; end: number; text: string }[];
}

export interface PerspectiveCodec {
  input: CompactPerspectiveInput;
  decode(raw: unknown): PerspectivePlan;
}

/** Keep stable character and history identities local while the model uses compact references. */
export function buildPerspectiveInput(messageValue: SceneMessage, rosterValue: SceneRoster, historyValue: SceneMessage[] = []): PerspectiveCodec {
  const message = structuredClone(messageValue);
  const roster = structuredClone(rosterValue);
  const history = structuredClone(historyValue);
  const characterEntries: [string, SceneCharacter][] = roster.characters.map((character, index) => [`c${index}`, character]);
  const characterByKey = new Map(characterEntries);
  const keyByCharacter = new Map(characterEntries.map(([key, character]) => [character.id, key]));
  const labels = roster.characters.flatMap(character => [character.name, ...character.aliases]);
  const current = segmentsOf(message.text, 's');
  const currentByRef = new Map(current.map(segment => [segment.ref, segment]));
  const historySegments: HistorySegment[] = history.flatMap((source, historyIndex) =>
    segmentsOf(source.text, `h${historyIndex}p`).map(segment => ({ ...segment, sourceId: source.id, revision: source.revision, role: source.role })),
  );
  const historyByRef = new Map(historySegments.map(segment => [segment.ref, segment]));
  const knownSpeaker = message.speakerId === undefined ? null : keyByCharacter.get(message.speakerId);
  if (message.speakerId !== undefined && knownSpeaker === undefined) fail('invalid_scene_character');

  const input: CompactPerspectiveInput = {
    role: message.role,
    automatic: message.automatic === true,
    knownSpeaker: knownSpeaker ?? null,
    playerName: message.envelope.playerName ?? null,
    characters: characterEntries.map(([key, character]) => ({
      key, name: character.name, aliases: [...character.aliases],
      ...([character.name, ...character.aliases].some(label => labels.filter(candidate => candidate === label).length > 1)
        ? { identityId: character.id } : {}),
    })),
    current: current.map(segment => ({ ...segment })),
    history: historySegments.map(({ ref, role, start, end, text }) => ({ ref, role, start, end, text })),
  };

  return { input, decode(raw) {
    const root = exactRecord(raw, ['observations', 'unresolved'], 'invalid_scene_perspective');
    if (!Array.isArray(root.observations) || root.observations.length > MAX_OBSERVATIONS
      || !Array.isArray(root.unresolved) || root.unresolved.length > MAX_UNRESOLVED) fail('invalid_scene_perspective');
    const unresolved = root.unresolved.map(value => bounded(value, 500, 'invalid_scene_perspective'));
    const observations = root.observations.map(value => {
      const item = keyedRecord(value, ['id', 'kind', 'quote', 'sourceRef', 'actor', 'recipients', 'identityRefs'], ['playerRef','audienceQuote'], 'invalid_scene_perspective');
      const id = bounded(item.id, 200, 'invalid_scene_perspective', true);
      const quote = bounded(item.quote, MAX_TEXT, 'invalid_scene_quote');
      if (typeof item.kind !== 'string' || !kinds.has(item.kind as KnowledgeKind)) fail('invalid_scene_perspective');
      const sourceRef = bounded(item.sourceRef, 40, 'invalid_scene_evidence', true);
      const source = currentByRef.get(sourceRef);
      if (!source || !source.text.includes(quote)) fail('invalid_scene_evidence');
      const start = message.text.indexOf(quote);
      if (start < 0 || message.text.indexOf(quote, start + 1) >= 0) fail('invalid_scene_quote');
      const actorKey = bounded(item.actor, 40, 'invalid_scene_character', true);
      const actor = characterByKey.get(actorKey);
      if (!actor) fail('invalid_scene_character');
      const recipientKeys = compactList(item.recipients, MAX_RECIPIENTS, 'invalid_scene_readers');
      const recipients = recipientKeys.map(key => characterByKey.get(key)?.id ?? fail('invalid_scene_character'));
      let evidence = quote;
      if (item.audienceQuote !== undefined) {
        if (!(message.role === 'assistant' && !message.automatic && message.speakerId === actor.id
          && recipients.some(recipient => recipient !== actor.id))) fail('invalid_scene_evidence');
        evidence = bounded(item.audienceQuote, MAX_TEXT, 'invalid_scene_evidence');
        if (!literalCovers(message.text, evidence, start, start + quote.length)) fail('invalid_scene_evidence');
      }
      const identityRefs = compactList(item.identityRefs, MAX_IDENTITY_REFS, 'invalid_scene_evidence');
      const currentIdentity = identityRefs.map(ref => currentByRef.get(ref)).filter((segment): segment is Segment => segment !== undefined);
      const historyIdentity = identityRefs.map(ref => historyByRef.get(ref)).filter((segment): segment is HistorySegment => segment !== undefined);
      if (currentIdentity.length + historyIdentity.length !== identityRefs.length) fail('invalid_scene_evidence');
      const identityQuote = currentIdentity.length ? span(message.text, currentIdentity) : undefined;
      const identityEvidence = historyIdentity.length
        ? historyIdentity.map(segment => ({ sourceId: segment.sourceId, quote: segment.text, revision: segment.revision })) : undefined;
      let playerEvidence: string | undefined;
      if (item.playerRef != null) {
        const playerRef = bounded(item.playerRef, 40, 'invalid_scene_player_evidence', true);
        const player = currentByRef.get(playerRef);
        if (!player || playerRef !== sourceRef) fail('invalid_scene_player_evidence');
        playerEvidence = quote;
      }
      return {
        id, kind: item.kind, start, end: start + quote.length, quote,
        actorId: actor.id, recipients, evidence,
        ...(identityQuote === undefined ? {} : { identityQuote }),
        ...(identityEvidence === undefined ? {} : { identityEvidence }),
        ...(playerEvidence === undefined ? {} : { playerVisible: true, playerEvidence }),
      };
    });
    return perspectiveOf({ observations, unresolved }, message, roster, history);
  } };
}

function segmentsOf(text: string, prefix: string): Segment[] {
  const result: Segment[] = [];
  for (const match of text.matchAll(/[^\r\n]+/gu)) {
    if (!match[0].trim()) continue;
    const start = match.index;
    result.push({ ref: `${prefix}${result.length}`, text: match[0], start, end: start + match[0].length });
  }
  return result;
}

function span(source: string, segments: Segment[]): string {
  const start = Math.min(...segments.map(segment => segment.start));
  const end = Math.max(...segments.map(segment => segment.end));
  return source.slice(start, end);
}

function compactList(value: unknown, max: number, code: string): string[] {
  if (!Array.isArray(value) || value.length > max) fail(code);
  const result = value.map(item => bounded(item, 40, code, true));
  if (new Set(result).size !== result.length) fail(code);
  return result;
}

function exactRecord(value: unknown, keys: string[], code: string): Record<string, unknown> {
  return keyedRecord(value, keys, [], code);
}

function keyedRecord(value: unknown, required: string[], optional: string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const input = value as Record<string, unknown>;
  const actual = Object.keys(input);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(input, key)) || actual.some(key => !allowed.has(key))) fail(code);
  return input;
}

function literalCovers(source: string, evidence: string, quoteStart: number, quoteEnd: number): boolean {
  let start = source.indexOf(evidence);
  while (start >= 0) {
    if (start <= quoteStart && start + evidence.length >= quoteEnd) return true;
    start = source.indexOf(evidence, start + 1);
  }
  return false;
}

function bounded(value: unknown, max: number, code: string, trimmed = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (trimmed && value !== value.trim())) fail(code);
  return value;
}

function fail(code: string): never { throw new Error(code); }
