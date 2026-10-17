import type { AcceptedMessage, ModelConfig } from '../core/types.ts';
import type { SceneEmotionInput } from '../core/models.ts';
import type { SceneCharacter, SceneMessage, SceneSource } from '../scene/types.ts';
import type { StoryClockReading } from '../scene/story-clock-store.ts';
import { storyClockSourceKind } from '../scene/story-clock-store.ts';
import { actorHasEmotion } from '../scene/actor-emotion.ts';
import { APPRAISAL_QUESTION } from './appraisal-wording.ts';
import { APPRAISAL_CONTRACT_VERSION, APPRAISAL_RULE_VERSION } from './appraisal.ts';
import { needsNow } from './need-scale.ts';
import { elapsedWording } from './appraisal-elapsed.ts';
import type { EmotionState } from './openher.ts';

/** One visible observation with a speaker marker; quote remains the accepted source's exact text. */
export interface AppraisalLine {
  speaker: string;
  quote: string;
}

/** An accepted source pointer; revisions are unitless positive integers. */
export interface AppraisalSourcePointer {
  sourceId: string;
  revision: number;
}

/** Private history cursor; the source and ordinal never enter model input. */
export interface AppraisalPrevious {
  source: SceneSource;
  ordinal: number;
}

/** Bounded visible context and an optional original own-line pointer, without stored appraisal data. */
export interface AppraisalHistoryView {
  recent: AppraisalLine[];
  previous?: AppraisalPrevious;
  ownLine?: { ref: string; text: string };
  ownLineSource?: AppraisalSourcePointer;
}

/** Readable model input in contract order; conditional sections are absent rather than undefined. */
export interface AppraisalInput {
  who?: { name: string; persona: string };
  needsNow: string[];
  recent?: AppraisalLine[];
  elapsed?: string;
  happened: (AppraisalLine & Record<string, unknown>)[];
  question: string;
  towardTargets: { id: string; kind?: string; name?: string; aliases?: readonly string[] }[];
  ownLine?: { ref: string; text: string };
  subjectId?: string;
  userActorId?: string;
  targets?: { id: string; kind?: string; name?: string; aliases?: readonly string[] }[];
  contactAffect?: unknown;
}

function pointerKey(sourceId: string, revision: number): string {
  return JSON.stringify([sourceId, revision]);
}

function speakerFor(
  source: Pick<SceneMessage, 'role' | 'automatic' | 'speakerId'>,
  observation: { kind?: string; actorId?: string },
  subjectId: string,
  actors: ReadonlyMap<string, { name: string }>,
  userActorId: string,
): string {
  if (source.role === 'user') return 'player';
  const actorId = !source.automatic && source.speakerId
    ? source.speakerId
    : observation.kind === 'heard' ? observation.actorId : undefined;
  if (actorId === userActorId) return 'player';
  if (actorId === subjectId) return 'self';
  return actorId === undefined ? 'narration' : actors.get(actorId)?.name ?? 'narration';
}

/**
 * Incrementally reads accepted prefixes within one processing job. A source is visited once; each role keeps three lines.
 * Queries must advance monotonically through one unchanged source order. refresh updates a previously deferred judgment.
 * Work is O(sources + reader memberships + clock advances + queries); no text or stored thought is scanned.
 */
export class AppraisalHistory {
  readonly work = { sources: 0, observations: 0, advances: 0 };
  private readonly actors: Map<string, SceneCharacter>;
  private readonly windows = new Map<string, { line: AppraisalLine; source: SceneSource }[]>();
  private readonly ownLines = new Map<string, { source: SceneSource; ordinal: number; text: string }>();
  private readonly previous = new Map<string, AppraisalPrevious>();
  private readonly positions = new Map<string, number>();
  private consumed = 0;
  private accepted = 0;
  private advanceCursor = 0;
  private latestExplicit = -1;

  constructor(actors: readonly SceneCharacter[]) {
    this.actors = new Map(actors.map(actor => [actor.id, actor]));
  }

  /** Reads sources strictly before endIndex. Missing visible history returns an empty recent list. */
  read(sources: readonly SceneSource[], endIndex: number, subjectId: string): AppraisalHistoryView {
    while (this.consumed < endIndex) {
      const source = sources[this.consumed++]!;
      this.work.sources += 1;
      if (source.status !== 'accepted') continue;
      const ordinal = this.accepted++;
      this.positions.set(pointerKey(source.id, source.revision), ordinal);
      this.refresh(source);
      const visibleOwn = new Map<string, string[]>();
      for (const observation of source.analysis?.plan?.observations ?? []) {
        this.work.observations += 1;
        for (const reader of new Set(observation.readers)) {
          if (!this.actors.has(reader)) continue;
          const window = this.windows.get(reader) ?? [];
          window.push({
            line: {
              speaker: speakerFor(source, observation, reader, this.actors, 'player'),
              quote: observation.quote,
            },
            source,
          });
          if (window.length > 3) window.shift();
          this.windows.set(reader, window);
          if (source.role === 'assistant' && !source.automatic && source.speakerId === reader) {
            const quotes = visibleOwn.get(reader) ?? [];
            quotes.push(observation.quote);
            visibleOwn.set(reader, quotes);
          }
        }
      }
      for (const [reader, quotes] of visibleOwn) {
        this.ownLines.set(reader, { source, ordinal, text: quotes.join('\n') });
      }
    }

    const window = this.windows.get(subjectId) ?? [];
    const own = this.ownLines.get(subjectId);
    const ownVisible = own !== undefined && window.some(item => item.source.id === own.source.id
      && item.source.revision === own.source.revision);
    const previous = this.previous.get(subjectId);
    return {
      recent: window.map(item => ({ ...item.line })),
      ...(previous ? { previous } : {}),
      ...(ownVisible ? {
        ownLine: { ref: `s${own.ordinal}`, text: own.text },
        ownLineSource: { sourceId: own.source.id, revision: own.source.revision },
      } : {}),
    };
  }

  /** Updates only applied judgments of a source already visited; absence, a placeholder, or a skip adds nothing. */
  refresh(source: SceneSource): void {
    const ordinal = this.positions.get(pointerKey(source.id, source.revision));
    if (ordinal === undefined || source.status !== 'accepted' || source.processing !== 'ready'
      || !source.analysis?.plan) return;
    for (const [id, analysis] of Object.entries(source.analysis.characters)) {
      const actor = this.actors.get(id);
      if (!actor || !actorHasEmotion(actor) || !analysis.emotion || source.analysis.emotionPendingIds?.includes(id)) continue;
      if ((this.previous.get(id)?.ordinal ?? -1) <= ordinal) this.previous.set(id, { source, ordinal });
    }
  }

  /**
   * Reads the already folded clock, without another fold. Advances are consumed once in chronological source order.
   * Unknown/missing/degraded endpoints and unrepresentable durations omit the phrase; clock getters still propagate.
   */
  elapsed(reading: StoryClockReading | null, current: SceneSource, previous?: AppraisalPrevious): string | undefined {
    if (!reading) return undefined;
    const result = reading.result;
    const currentOrdinal = this.accepted;
    this.positions.set(pointerKey(current.id, current.revision), currentOrdinal);
    while (this.advanceCursor < result.advances.length) {
      const advance = result.advances[this.advanceCursor]!;
      const ordinal = this.positions.get(pointerKey(advance.sourceId, advance.revision));
      if (ordinal === undefined || ordinal > currentOrdinal) break;
      this.advanceCursor += 1;
      this.work.advances += 1;
      if (advance.basis === 'explicit') this.latestExplicit = ordinal;
    }
    if (!previous) return undefined;
    const start = result.sources[previous.ordinal];
    const end = result.sources[currentOrdinal];
    if (!start || !end || start.sourceId !== previous.source.id || start.revision !== previous.source.revision
      || end.sourceId !== current.id || end.revision !== current.revision || start.pending || end.pending) return undefined;
    for (const endpoint of [previous.source, current]) {
      const kind = storyClockSourceKind(endpoint);
      if (kind === 'pending' || kind === 'degraded') return undefined;
    }
    const milliseconds = end.state.atMs - start.state.atMs;
    // The wording helper supports at most 9999 rounded years and safe-integer millisecond arithmetic.
    if (!Number.isSafeInteger(milliseconds) || milliseconds >= 9999.5 * 31_557_600_000) return undefined;
    return elapsedWording(milliseconds, this.latestExplicit > previous.ordinal);
  }
}

/**
 * Builds one scene appraisal input, preserving observation fields while excluding every internal emotion number.
 * O(visible observations + actor targets); caller history is already bounded to three lines. Getters propagate.
 */
export function buildAppraisalInput(message: AcceptedMessage, scene: SceneEmotionInput): AppraisalInput {
  const observations = scene.plan.observations.filter(observation => observation.readers.includes(scene.subjectId));
  const rosterActors = scene.rosterActors ?? scene.towardActors ?? scene.actors;
  const allActors = new Map(rosterActors.map(actor => [actor.id, actor]));
  const targets = [
    { id: scene.userActorId, kind: 'player' },
    ...scene.actors.filter(actor => actor.id !== scene.subjectId && actorHasEmotion(actor as SceneCharacter))
      .map(actor => ({ id: actor.id, name: actor.name, aliases: actor.aliases })),
  ];
  const towardTargets = new Map(targets.map(target => [target.id, target]));
  const readers = new Set(scene.plan.observations.flatMap(observation => observation.readers));
  for (const actor of scene.towardActors ?? scene.actors) {
    if (actor.id !== scene.subjectId && readers.has(actor.id) && actorHasEmotion(actor as SceneCharacter)
      && !towardTargets.has(actor.id)) {
      towardTargets.set(actor.id, { id: actor.id, name: actor.name, aliases: actor.aliases });
    }
  }
  const frustration = scene.character?.experienceState?.frustration;
  return {
    ...(scene.character ? { who: { name: scene.character.name, persona: scene.character.persona } } : {}),
    needsNow: frustration ? needsNow(frustration) : [],
    ...(scene.recent?.length ? { recent: scene.recent } : {}),
    ...(scene.elapsed ? { elapsed: scene.elapsed } : {}),
    happened: observations.map(observation => ({
      speaker: speakerFor(scene.source ?? message, observation, scene.subjectId, allActors, scene.userActorId),
      id: observation.id,
      quote: observation.quote,
      evidence: observation.evidence,
      actorId: observation.actorId ?? null,
      recipients: observation.recipients ?? [],
      playerVisible: observation.playerVisible === true,
      playerEvidence: observation.playerEvidence ?? null,
    })),
    question: APPRAISAL_QUESTION,
    towardTargets: [...towardTargets.values()],
    ...(scene.ownLine ? { ownLine: scene.ownLine } : {}),
    subjectId: scene.subjectId,
    userActorId: scene.userActorId,
    targets,
    ...(scene.contactAffect == null ? {} : { contactAffect: scene.contactAffect }),
  };
}

/** Builds the reduced core input; an absent identity remains absent, and assistant text is marked self. */
export function buildCoreAppraisalInput(
  message: AcceptedMessage,
  character?: { name: string; persona: string; experienceState?: EmotionState },
  experienceState = character?.experienceState,
): AppraisalInput {
  return {
    ...(character ? { who: { name: character.name, persona: character.persona } } : {}),
    needsNow: experienceState ? needsNow(experienceState.frustration) : [],
    happened: [{ speaker: message.role === 'user' ? 'player' : 'self', quote: message.text }],
    question: APPRAISAL_QUESTION,
    towardTargets: [{ id: 'player', kind: 'player' }],
  };
}

/** Hash input for cached mapped scene appraisals; internal state and fixed prompt text are deliberately absent. */
export function appraisalFingerprintInput(message: AcceptedMessage, scene: SceneEmotionInput, config: ModelConfig): unknown {
  return {
    contract: APPRAISAL_CONTRACT_VERSION,
    appraisalRule: APPRAISAL_RULE_VERSION,
    input: buildAppraisalInput(message, scene),
    clock: {
      timeMs: scene.clockTimeMs === undefined ? message.acceptedAtMs : scene.clockTimeMs,
      timeZone: scene.timeZone ?? 'UTC',
    },
    ownLineSource: scene.ownLineSource ?? null,
    config,
  };
}
