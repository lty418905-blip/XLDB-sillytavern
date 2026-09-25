import { segmentOutward } from './outward.ts';
import { envelopeOf } from './perspective.ts';
import type { KnowledgeKind, Observation, PerspectivePlan, SceneCharacter, SceneMessage, SceneRoster } from './types.ts';

const MAX_HISTORY = 6;
const MAX_ITEMS_PER_VIEW = 8;
const MAX_CANDIDATES = 64;
const MAX_OBSERVATIONS = 32;
const MAX_UNRESOLVED = 8;
const MAX_UNRESOLVED_TEXT = 500;
const MAX_SOURCE_LENGTH = 20_000;
const kinds = new Set<KnowledgeKind>(['observed', 'heard', 'private', 'thought', 'inferred']);

export interface ViewInput {
  role: SceneMessage['role'];
  playerName: string | null;
  characters: { key: string; name: string; aliases: string[] }[];
  fragments: { ref: string; text: string }[];
  /** Previous accepted prose is supplied only for identity and presence disambiguation. */
  history: { role: SceneMessage['role']; text: string }[];
}

export interface ViewCodec {
  input: ViewInput;
  decode(raw: unknown): PerspectivePlan;
}

interface BoundFragment {
  ref: string;
  text: string;
  start: number;
  end: number;
  index: number;
}

interface DecodedView {
  character: SceneCharacter;
  kind: KnowledgeKind;
  fragments: BoundFragment[];
  isPublic: boolean;
}

/** Compact automatic-scene view input; stable ids and source bindings remain local. */
export function buildViewInput(messageValue: SceneMessage, rosterValue: SceneRoster, historyValue: SceneMessage[] = []): ViewCodec {
  const message = structuredClone(messageValue);
  const roster = structuredClone(rosterValue);
  const history = structuredClone(historyValue.slice(-MAX_HISTORY));
  const envelope = envelopeOf(message.envelope, roster);
  if (message.automatic !== true || envelope.mode !== 'scene') fail('invalid_scene_view_input');
  if ((message.role !== 'user' && message.role !== 'assistant')
    || typeof message.id !== 'string' || !message.id.trim()
    || typeof message.text !== 'string'
    || !Number.isSafeInteger(message.revision) || message.revision < 1
    || !Number.isSafeInteger(message.acceptedAtMs) || message.acceptedAtMs < 0
    || !message.text.trim()) fail('invalid_scene_view_input');

  const characters = envelope.presentIds.map(id => roster.characters.find(character => character.id === id)
    ?? fail('invalid_scene_character'));
  const entries = characters.map((character, index) => [`c${index}`, character] as const);
  const fragments: BoundFragment[] = segmentOutward(message.text).map((fragment, index) => ({ ...fragment, index }));
  for (const source of history) validateHistory(source);

  const input: ViewInput = {
    role: message.role,
    playerName: envelope.playerName ?? null,
    characters: entries.map(([key, character]) => ({ key, name: character.name, aliases: [...character.aliases] })),
    fragments: fragments.map(({ ref, text }) => ({ ref, text })),
    history: history.map(source => ({ role: source.role, text: source.text })),
  };
  return { input, decode: raw => viewsOf(raw, message, roster, history) };
}

/** Decode model view candidates without accepting model-provided identities or source text. */
export function viewsOf(
  raw: unknown,
  message: SceneMessage,
  roster: SceneRoster,
  history: SceneMessage[] = [],
): PerspectivePlan {
  const envelope = envelopeOf(message.envelope, roster);
  if (message.automatic !== true || envelope.mode !== 'scene') fail('invalid_scene_view_input');
  if ((message.role !== 'user' && message.role !== 'assistant')
    || typeof message.text !== 'string' || !message.text.trim()) fail('invalid_scene_view_input');
  const characters = new Map<string, SceneCharacter>(envelope.presentIds.map((id, index) => {
    const character = roster.characters.find(item => item.id === id) ?? fail('invalid_scene_character');
    return [`c${index}`, character] as const;
  }));
  const fragments = new Map(segmentOutward(message.text).map((fragment, index) =>
    [fragment.ref, { ...fragment, index }] as const));
  const candidateRoot=record(raw,'invalid_scene_views');
  const root = exactRecord(raw, ['views', 'unresolved',...['presentation','requests'].filter(key=>Object.hasOwn(candidateRoot,key))], 'invalid_scene_views');
  const generationRequests:Record<string,string>={};
  if(root.requests!==undefined){
    const requests=record(root.requests,'invalid_scene_request');
    if(message.role!=='user'&&Object.keys(requests).length)fail('invalid_scene_request');
    for(const [key,refs] of Object.entries(requests)){
      const character=characters.get(key);
      if(!character||!Array.isArray(refs)||!refs.length||refs.length>16)fail('invalid_scene_request');
      const selected=refs.map(ref=>typeof ref==='string'?fragments.get(ref):undefined);
      if(selected.some((fragment,index)=>!fragment||(index>0&&fragment.index!==selected[index-1]!.index+1)))fail('invalid_scene_request');
      const quote=quoteOf(message.text,selected as BoundFragment[]);
      if(quote.length>2048)fail('invalid_scene_request');
      generationRequests[character.id]=quote;
    }
  }
  let presentation:PerspectivePlan['presentation'];
  if(root.presentation!==undefined){
    const style=exactRecord(root.presentation,['sentenceCount','dialogueOnly','evidenceRefs'],'invalid_scene_presentation');
    if(style.sentenceCount!==null&&(!Number.isSafeInteger(style.sentenceCount)||Number(style.sentenceCount)<1||Number(style.sentenceCount)>100))fail('invalid_scene_presentation');
    if(style.dialogueOnly!==null&&typeof style.dialogueOnly!=='boolean')fail('invalid_scene_presentation');
    if(!Array.isArray(style.evidenceRefs)||style.evidenceRefs.length>16||style.evidenceRefs.some(ref=>typeof ref!=='string'||!fragments.has(ref)))fail('invalid_scene_presentation');
    if(style.sentenceCount!==null||style.dialogueOnly!==null){
      if(message.role!=='user'||!style.evidenceRefs.length)fail('invalid_scene_presentation');
      presentation={sentenceCount:style.sentenceCount as number|null,dialogueOnly:style.dialogueOnly as boolean|null};
    }
  }
  const views = record(root.views, 'invalid_scene_views');
  if (Object.keys(views).some(key => !characters.has(key))) fail('invalid_scene_character');
  if (!Array.isArray(root.unresolved) || root.unresolved.length > MAX_UNRESOLVED) fail('invalid_scene_views');
  const unresolved = root.unresolved.map(value => bounded(value, MAX_UNRESOLVED_TEXT, 'invalid_scene_views'));

  const decoded: DecodedView[] = [];
  let candidateCount = 0;
  for (const [key, value] of Object.entries(views)) {
    const character = characters.get(key) ?? fail('invalid_scene_character');
    if (!Array.isArray(value) || value.length > MAX_ITEMS_PER_VIEW) fail('invalid_scene_views');
    candidateCount += value.length;
    if (candidateCount > MAX_CANDIDATES) fail('invalid_scene_views');
    const used = new Set<string>();
    for (const candidate of value) {
      const item = exactRecord(candidate, ['refs', 'kind', 'public'], 'invalid_scene_views');
      if (!Array.isArray(item.refs) || item.refs.length < 1) fail('invalid_scene_views');
      const selected = item.refs.map(ref => {
        if (typeof ref !== 'string' || used.has(ref)) fail('invalid_scene_views');
        const fragment = fragments.get(ref);
        if (!fragment) fail('invalid_scene_views');
        used.add(ref);
        return fragment;
      });
      for (let index = 1; index < selected.length; index += 1) {
        if (selected[index]!.index !== selected[index - 1]!.index + 1) fail('invalid_scene_views');
      }
      if (typeof item.kind !== 'string' || !kinds.has(item.kind as KnowledgeKind)
        || typeof item.public !== 'boolean') fail('invalid_scene_views');
      const kind = item.kind as KnowledgeKind;
      const quote = quoteOf(message.text, selected);
      const isPublic = item.public && kind !== 'private' && kind !== 'thought' && kind !== 'inferred'
        && playerAnchored(quote, message.role, envelope.playerName);
      decoded.push({ character, kind, fragments: selected, isPublic });
    }
  }

  const grouped = new Map<string, { kind: KnowledgeKind; fragments: BoundFragment[]; isPublic: boolean; readers: string[] }>();
  for (const item of decoded) {
    const first = item.fragments[0]!;
    const last = item.fragments.at(-1)!;
    const privateView = item.kind === 'thought' || item.kind === 'inferred';
    const key = JSON.stringify([first.start, last.end, item.kind, item.isPublic, ...(privateView ? [item.character.id] : [])]);
    const current = grouped.get(key);
    if (current) current.readers.push(item.character.id);
    else grouped.set(key, { kind: item.kind, fragments: item.fragments, isPublic: item.isPublic, readers: [item.character.id] });
  }
  if (grouped.size > MAX_OBSERVATIONS) fail('invalid_scene_views');

  const readerRank = new Map(envelope.presentIds.map((id, index) => [id, index]));
  const observations: Observation[] = [...grouped.values()]
    .sort((left, right) => left.fragments[0]!.start - right.fragments[0]!.start
      || left.fragments.at(-1)!.end - right.fragments.at(-1)!.end
      || left.kind.localeCompare(right.kind)
      || Math.min(...left.readers.map(id => readerRank.get(id)!)) - Math.min(...right.readers.map(id => readerRank.get(id)!)))
    .map((item, index) => {
      const first = item.fragments[0]!;
      const last = item.fragments.at(-1)!;
      const quote = message.text.slice(first.start, last.end);
      const readers = [...new Set(item.readers)].sort((left, right) => readerRank.get(left)! - readerRank.get(right)!);
      const identity = identityFor(readers, message, roster, history.slice(-MAX_HISTORY), fragments);
      return {
        id: `${message.id}:view:${index}`,
        kind: item.kind,
        start: first.start,
        end: last.end,
        quote,
        evidence: quote,
        readers,
        ...(item.isPublic ? { playerVisible: true, playerEvidence: quote } : {}),
        ...(identity.identityQuote ? { identityQuote: identity.identityQuote } : {}),
        ...(identity.identityEvidence.length ? { identityEvidence: identity.identityEvidence } : {}),
      };
    });
  return { observations, unresolved,...(presentation?{presentation}:{}),...(Object.keys(generationRequests).length?{generationRequests}:{}) };
}

function identityFor(
  readerIds: string[],
  message: SceneMessage,
  roster: SceneRoster,
  history: SceneMessage[],
  current: ReadonlyMap<string, BoundFragment>,
): { identityQuote?: string; identityEvidence: { sourceId: string; quote: string; revision: number }[] } {
  const currentMatches: BoundFragment[] = [];
  const identityEvidence: { sourceId: string; quote: string; revision: number }[] = [];
  for (const readerId of new Set(readerIds)) {
    const character = roster.characters.find(item => item.id === readerId) ?? fail('invalid_scene_character');
    const local = [...current.values()].find(fragment => mentionsIdentity(fragment.text, character, roster));
    if (local) {
      currentMatches.push(local);
      continue;
    }
    let historical: { source: SceneMessage; quote: string } | undefined;
    for (let index = history.length - 1; index >= 0 && !historical; index -= 1) {
      const source = history[index]!;
      const quote = identityLiteral(source.text, character, roster);
      if (quote) historical = { source, quote };
    }
    if (!historical) fail('invalid_scene_identity');
    identityEvidence.push({ sourceId: historical.source.id, quote: historical.quote, revision: historical.source.revision });
  }
  let identityQuote: string | undefined;
  if (currentMatches.length) {
    const start = Math.min(...currentMatches.map(item => item.start));
    const end = Math.max(...currentMatches.map(item => item.end));
    identityQuote = message.text.slice(start, end);
  }
  return { identityQuote, identityEvidence };
}

function mentionsIdentity(text: string, character: SceneCharacter, roster: SceneRoster): boolean {
  return identityLiteral(text, character, roster) !== undefined;
}

function identityLiteral(text: string, character: SceneCharacter, roster: SceneRoster): string | undefined {
  if (mentions(text, character.id)) return character.id;
  for (const label of [character.name, ...character.aliases]) {
    if (!mentions(text, label)) continue;
    const owners = roster.characters.filter(item => item.name === label || item.aliases.includes(label));
    if (owners.length === 1 && owners[0]?.id === character.id) return label;
  }
  return undefined;
}

function mentions(text: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${/^[A-Za-z0-9_]/.test(label) ? '(?<![A-Za-z0-9_-])' : ''}${escaped}${/[A-Za-z0-9_]$/.test(label) ? '(?![A-Za-z0-9_-])' : ''}`, 'u').test(text);
}

function quoteOf(source: string, fragments: BoundFragment[]): string {
  return source.slice(fragments[0]!.start, fragments.at(-1)!.end);
}

function playerAnchored(quote: string, role: SceneMessage['role'], playerName: string | undefined): boolean {
  return (role === 'user' ? /你|您|玩家|我/u : /你|您|玩家/u).test(quote)
    || Boolean(playerName && quote.includes(playerName));
}

function validateHistory(source: SceneMessage): void {
  if (typeof source.id !== 'string' || !source.id.trim()
    || typeof source.text !== 'string'
    || !Number.isSafeInteger(source.revision) || source.revision < 1
    || (source.role !== 'user' && source.role !== 'assistant') || !source.text.trim()
    || source.text.length > MAX_SOURCE_LENGTH) fail('invalid_scene_view_input');
}

function exactRecord(value: unknown, keys: string[], code: string): Record<string, unknown> {
  const input = record(value, code);
  const actual = Object.keys(input);
  if (keys.some(key => !Object.hasOwn(input, key)) || actual.some(key => !keys.includes(key))) fail(code);
  return input;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function bounded(value: unknown, max: number, code: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(code);
  return value;
}

function fail(code: string): never { throw new Error(code); }
