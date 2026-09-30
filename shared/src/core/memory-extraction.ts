import type { MemoryCandidate } from './types.ts';

export const MEMORY_REFERENCE_SCHEMA = 'memory-refs-v1' as const;

const MAX_INPUT_TEXT = 20_000;
const MAX_SOURCE_TEXT = 1_000;
const MAX_SOURCES = 64;
const MAX_MEMORIES = 6;
const MAX_EVIDENCE = 12;
const sentenceBoundary = /[。.!！？?；;\n\r]/u;
const quoteCloser = /[”’"'」』）》】]/u;

export interface MemoryExtractionInput {
  schema: typeof MEMORY_REFERENCE_SCHEMA;
  role: 'user' | 'assistant';
  sources: { ref: string; text: string }[];
  character?: Readonly<Record<string, unknown>>;
}

export interface MemoryExtractionCodec {
  input: MemoryExtractionInput;
  decode(raw: unknown): { memories: MemoryCandidate[] };
}

/**
 * Gives the model compact references while keeping source text selection local.
 * When excerpts are supplied, the full message is deliberately absent from input.
 */
export function buildMemoryInput(value: {
  role: 'user' | 'assistant';
  text: string;
  character?: Readonly<Record<string, unknown>>;
  excerpts?: readonly string[];
}): MemoryExtractionCodec {
  if ((value.role !== 'user' && value.role !== 'assistant')
    || typeof value.text !== 'string' || value.text.length > MAX_INPUT_TEXT || !value.text.trim()) fail('invalid_memory_reference_input');
  if (value.excerpts !== undefined && !Array.isArray(value.excerpts)) fail('invalid_memory_reference_input');
  const permitted = value.excerpts === undefined ? [value.text] : value.excerpts;
  const sourceTexts: string[] = [];
  for (const excerpt of permitted) {
    if (typeof excerpt !== 'string' || excerpt.length > MAX_INPUT_TEXT || !excerpt.trim()
      || !value.text.includes(excerpt)) fail('invalid_memory_reference_input');
    sourceTexts.push(...chunksOf(excerpt));
    if (sourceTexts.length > MAX_SOURCES) fail('invalid_memory_reference_input');
  }
  const sources = sourceTexts.map((text, index) => ({ ref: `m${index}`, text }));
  const input: MemoryExtractionInput = {
    schema: MEMORY_REFERENCE_SCHEMA,
    role: value.role,
    sources,
    ...(value.character === undefined ? {} : { character: structuredClone(value.character) }),
  };
  const sourceByRef = new Map(sources.map(source => [source.ref, source.text]));
  return { input, decode: raw => decodeMemories(raw, sourceByRef) };
}

function decodeMemories(raw: unknown, sourceByRef: ReadonlyMap<string, string>): { memories: MemoryCandidate[] } {
  const root = exactRecord(raw, ['schema', 'memories'], 'invalid_memory_reference_payload');
  if (root.schema !== MEMORY_REFERENCE_SCHEMA || !Array.isArray(root.memories)
    || root.memories.length > MAX_MEMORIES) fail('invalid_memory_reference_payload');
  const memories = root.memories.map(value => {
    const item = keyedRecord(value,
      ['kind', 'detailRef', 'gist', 'feeling', 'anchor', 'protectedFacts'], ['episode','retention'],
      'invalid_memory_reference_payload');
    if (item.kind !== 'fact' && item.kind !== 'episode') fail('invalid_memory_reference_payload');
    const detailRef = reference(item.detailRef, sourceByRef);
    const protectedFacts = stringList(item.protectedFacts, 10, 'invalid_memory_reference_payload');
    const base = {
      kind: item.kind,
      detail: sourceByRef.get(detailRef)!,
      gist: stringValue(item.gist, 'invalid_memory_reference_payload'),
      feeling: stringValue(item.feeling, 'invalid_memory_reference_payload'),
      anchor: stringValue(item.anchor, 'invalid_memory_reference_payload'),
      protectedFacts,
      ...(item.retention===undefined?{}:{retention:item.retention}),
    };
    if (item.kind === 'fact') {
      if (item.episode !== undefined) fail('invalid_memory_reference_payload');
      return base as MemoryCandidate;
    }
    if (item.episode === undefined) fail('invalid_memory_reference_payload');
    const episode = keyedRecord(item.episode,
      ['appraisal', 'feelingBasis', 'feelingRef', 'evidenceRefs'],
      ['sceneQuote', 'participants', 'sensoryCues'], 'invalid_memory_reference_payload');
    const evidenceRefs = referenceList(episode.evidenceRefs, sourceByRef);
    const evidenceUnion = [...new Set([detailRef, ...evidenceRefs])];
    if (evidenceUnion.length > MAX_EVIDENCE) fail('invalid_memory_reference_payload');
    const feelingRef = reference(episode.feelingRef, sourceByRef);
    if (!evidenceUnion.includes(feelingRef)) fail('invalid_memory_reference');
    if (episode.feelingBasis !== 'explicit' && episode.feelingBasis !== 'inferred') fail('invalid_memory_reference_payload');
    return {
      ...base,
      kind: 'episode',
      episode: {
        scene: episode.sceneQuote === undefined ? '' : stringValue(episode.sceneQuote, 'invalid_memory_reference_payload'),
        participants: episode.participants === undefined ? [] : stringList(episode.participants, 12, 'invalid_memory_reference_payload'),
        sensoryCues: episode.sensoryCues === undefined ? [] : stringList(episode.sensoryCues, 12, 'invalid_memory_reference_payload'),
        appraisal: stringValue(episode.appraisal, 'invalid_memory_reference_payload'),
        feelingBasis: episode.feelingBasis,
        feelingQuote: sourceByRef.get(feelingRef)!,
        evidenceQuotes: evidenceUnion.map(ref => sourceByRef.get(ref)!),
      },
    } as MemoryCandidate;
  });
  return { memories };
}

function chunksOf(source: string): string[] {
  if (source.length <= MAX_SOURCE_TEXT) return [source];
  const chunks: string[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + MAX_SOURCE_TEXT, source.length);
    if (end < source.length) {
      let boundary = -1;
      for (let index = start; index < end; index += 1) {
        if (sentenceBoundary.test(source[index]!)) boundary = index + 1;
      }
      if (boundary > start) end = boundary;
      while (end < source.length && end - start < MAX_SOURCE_TEXT && quoteCloser.test(source[end]!)) end += 1;
      if (end < source.length && /[\uD800-\uDBFF]/u.test(source[end - 1]!)) end -= 1;
    }
    const chunk = source.slice(start, end);
    if (chunk.trim()) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

function reference(value: unknown, sourceByRef: ReadonlyMap<string, string>): string {
  if (typeof value !== 'string' || !sourceByRef.has(value)) fail('invalid_memory_reference');
  return value;
}

function referenceList(value: unknown, sourceByRef: ReadonlyMap<string, string>): string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) fail('invalid_memory_reference_payload');
  const refs = value.map(item => reference(item, sourceByRef));
  if (new Set(refs).size !== refs.length) fail('invalid_memory_reference');
  return refs;
}

function stringList(value: unknown, max: number, code: string): string[] {
  if (!Array.isArray(value) || value.length > max) fail(code);
  return value.map(item => stringValue(item, code));
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== 'string') fail(code);
  return value;
}

function exactRecord(value: unknown, keys: string[], code: string): Record<string, unknown> {
  return keyedRecord(value, keys, [], code);
}

function keyedRecord(value: unknown, required: string[], optional: string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const input = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !allowed.has(key))) fail(code);
  return input;
}

function fail(code: string): never { throw new Error(code); }
