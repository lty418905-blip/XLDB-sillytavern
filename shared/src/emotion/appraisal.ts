import { detectHanScript } from '../common/han-script.ts';
import type { HanScript } from '../common/han-script.ts';
import { DRIVE_NAMES, timeOfDayAt } from './openher.ts';
import type { CriticContext, DriveValues } from './openher.ts';
import { validateRelationships } from './relationships.ts';
import type { DirectionalRelationship, SceneRelationshipContext } from './relationships.ts';
import {
  APPRAISAL_PROBLEM_WORDS,
  APPRAISAL_PROBLEM_SEPARATOR,
  APPRAISAL_REASK_TEMPLATE,
} from './appraisal-wording.ts';

/** Current mapping version for newly accepted appraisals; existing records retain their recorded version. */
export const APPRAISAL_RULE_VERSION = 1;

/** Current input/output contract version for newly accepted appraisals. */
export const APPRAISAL_CONTRACT_VERSION = 1;

/** Signed integer effect on one need or directional relation, in model scale units. */
export type AppraisalEffect = -2 | -1 | 0 | 1 | 2;

/** Unsigned scene intensity in model scale units. */
export type AppraisalSceneLevel = 0 | 1 | 2 | 3;

/** Closed separation answer; absence after a failed reask remains absence rather than a guessed key. */
export type AppraisalSeparation = 'apart' | 'together' | 'unstated';

/** One readable feeling, with a nonempty name of at most eight Unicode code points and intensity 1..3. */
export interface AppraisalFeeling {
  name: string;
  level: 1 | 2 | 3;
}

/** All scene ratings in integer model units; tone and otherMood are signed. */
export interface AppraisalScene {
  otherMood: AppraisalEffect;
  intimacy: AppraisalSceneLevel;
  depth: AppraisalSceneLevel;
  engagement: AppraisalSceneLevel;
  conflict: AppraisalSceneLevel;
  novelty: AppraisalSceneLevel;
  otherOpenness: AppraisalSceneLevel;
  tone: AppraisalEffect;
}

/** One allowed target's readable assessment; invalid bond alone may be omitted after the reask. */
export interface AppraisalToward {
  target: string;
  event: string;
  importance: 'minor' | 'notable' | 'major';
  trust: AppraisalEffect;
  closeness: AppraisalEffect;
  liking: AppraisalEffect;
  bond?: 'close' | 'not_close';
}

/** A checked response to the caller's own-line reference; the caller later replaces ref with a source pointer. */
export interface AppraisalReception {
  ref: string;
  answered: boolean;
  level: AppraisalEffect;
  quote: string;
}

/** Readable accepted data only, with no unknown keys; separation is stored separately in relation. */
export interface ReadableAppraisal {
  thought?: string;
  feelings: AppraisalFeeling[];
  needs: Record<(typeof DRIVE_NAMES)[number], AppraisalEffect>;
  scene: AppraisalScene;
  toward: AppraisalToward[];
  reception?: AppraisalReception;
}

/** Mapped directional increments; counterpartId is reserved for a later caller and is never inferred here. */
export interface AppraisalRelation {
  valence: number;
  toward: { target: string; depth: number; trust: number }[];
  skipSeparation?: AppraisalSeparation;
  counterpartId?: string;
}

/** Newly mapped record, without driveSatisfaction or the caller-specific stableRelationDelta. */
export interface AppraisalEmotionDelta {
  context: CriticContext;
  frustrationDelta: DriveValues;
  appraisal: ReadableAppraisal;
  relation: AppraisalRelation;
  appraisalRule: number;
  contract: number;
}

/** Already-validated caller context; null optional members mean omission and getter failures propagate. */
export interface AppraisalDecodeContext {
  towardTargets: readonly string[];
  happened: readonly string[];
  ownLine?: { ref: string } | null;
  relationshipContext?: SceneRelationshipContext | null;
  attempt?: 1 | 2 | null;
  clockTimeMs?: number | null;
  timeZone?: string | null;
}

/** Closed-list problem with its member path and filled fixed phrase; no raw answer is retained. */
export interface AppraisalProblem {
  kind: keyof typeof APPRAISAL_PROBLEM_WORDS;
  path: string;
  message: string;
}

/** Diagnostic code and member path only; private thought text and model output never enter diagnostics. */
export interface AppraisalDiagnostic {
  code: string;
  path: string;
}

/** Deterministic work counters: JSON input code units, visited keys/text points, script units, and quote comparisons. */
export interface AppraisalWork {
  parsedCodeUnits: number;
  keys: number;
  textCodePoints: number;
  scriptCodeUnits: number;
  quoteComparisons: number;
}

/** Accepted mapped data or the complete ordered problem list; relationship validation errors still throw unchanged. */
export type AppraisalDecodeResult = {
  accepted: true;
  emotion: AppraisalEmotionDelta;
  relationships?: DirectionalRelationship[];
  diagnostics: AppraisalDiagnostic[];
  work: AppraisalWork;
} | {
  accepted: false;
  problems: AppraisalProblem[];
  diagnostics: AppraisalDiagnostic[];
  work: AppraisalWork;
};

// Provisional mapping values, pending real-model and engine calibration; changing them requires a new mapping version.
const NEED_INCREMENTS = new Map<number, number>([[-2, 2.0], [-1, 0.8], [0, 0], [1, -0.8], [2, -2.0]]);
const SCENE_DIVISOR = 3;
const MOOD_DIVISOR = 2;
const TONE_DIVISOR = 2;
const RELATION_INCREMENT = 0.05;

// Provisional limits apply to one answer and to each listed text member, never to accumulated chat history.
const THOUGHT_LIMIT = 160;
const FEELING_NAME_LIMIT = 8;
const FEELINGS_LIMIT = 3;
const TOWARD_EVENT_LIMIT = 40;
const TOWARD_LIMIT = 4;
const RECEPTION_QUOTE_LIMIT = 120;
const TOP_FIELDS = ['thought', 'feelings', 'needs', 'scene', 'toward', 'skipSeparation', 'reception', 'relationships'];
const SCENE_FIELDS = ['otherMood', 'intimacy', 'depth', 'engagement', 'conflict', 'novelty', 'otherOpenness', 'tone'];
const TOWARD_FIELDS = ['target', 'event', 'importance', 'trust', 'closeness', 'liking', 'bond'];
const RECEPTION_FIELDS = ['ref', 'answered', 'level', 'quote'];
const SEPARATIONS = new Set(['apart', 'together', 'unstated']);
const BONDS = new Set(['close', 'not_close']);
const IMPORTANCES = new Set(['minor', 'notable', 'major']);

type JsonObject = Record<string, unknown>;
type Validation = {
  problems: AppraisalProblem[];
  problemKeys: Set<string>;
  diagnostics: AppraisalDiagnostic[];
  work: AppraisalWork;
  secondAnswer: boolean;
  sourceScript: HanScript;
};

/**
 * Maps already-validated readable levels into engine units, preserving readable data without reinterpreting it.
 * Null/omitted clock uses the existing unknown-time value; invalid clocks, time zones, or caller getters propagate.
 * Work is O(t) for t directional targets (at most four after decoding); no model execution or state mutation occurs.
 */
export function mapAppraisal(
  appraisal: ReadableAppraisal,
  options: {
    skipSeparation?: AppraisalSeparation | null;
    clockTimeMs?: number | null;
    timeZone?: string | null;
  } = {},
): AppraisalEmotionDelta {
  const scene = appraisal.scene;
  const frustrationDelta = Object.fromEntries(DRIVE_NAMES.map(drive => [
    drive,
    NEED_INCREMENTS.get(appraisal.needs[drive])!,
  ])) as DriveValues;
  const relation: AppraisalRelation = {
    valence: scene.tone / TONE_DIVISOR,
    toward: appraisal.toward.map(item => ({
      target: item.target,
      depth: item.closeness * RELATION_INCREMENT,
      trust: item.trust * RELATION_INCREMENT,
    })),
  };
  if (options.skipSeparation != null) {
    relation.skipSeparation = options.skipSeparation;
  }

  return {
    context: {
      userEmotion: scene.otherMood / MOOD_DIVISOR,
      topicIntimacy: scene.intimacy / SCENE_DIVISOR,
      conversationDepth: scene.depth / SCENE_DIVISOR,
      userEngagement: scene.engagement / SCENE_DIVISOR,
      conflictLevel: scene.conflict / SCENE_DIVISOR,
      noveltyLevel: scene.novelty / SCENE_DIVISOR,
      userVulnerability: scene.otherOpenness / SCENE_DIVISOR,
      timeOfDay: timeOfDayAt(options.clockTimeMs ?? null, options.timeZone ?? 'UTC'),
    },
    frustrationDelta,
    appraisal,
    relation,
    appraisalRule: APPRAISAL_RULE_VERSION,
    contract: APPRAISAL_CONTRACT_VERSION,
  };
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function orderedFields(input: JsonObject, fields: readonly string[], state: Validation): string[] {
  const keys = Object.keys(input);
  state.work.keys += keys.length;
  const present = new Set(keys);
  const allowed = new Set(fields);
  return [...keys.filter(key => allowed.has(key)), ...fields.filter(key => !present.has(key))];
}

function problem(
  state: Validation,
  kind: AppraisalProblem['kind'],
  path: string,
  parameters: Record<string, string> = {},
): void {
  const identity = `${kind}\0${path}`;
  if (state.problemKeys.has(identity)) {
    return;
  }
  state.problemKeys.add(identity);
  const replacements = new Map(Object.entries({ 成员: path, ...parameters }));
  const message = APPRAISAL_PROBLEM_WORDS[kind].replace(/\{([^{}]+)\}/g,
    (placeholder, key: string) => replacements.get(key) ?? placeholder);
  state.problems.push({ kind, path, message });
}

function countText(text: string, state: Validation): number {
  let length = 0;
  // One pass over code points, including astral characters and lone surrogates: O(text.length).
  for (const character of text) {
    length += 1;
    state.work.textCodePoints += 1;
  }
  return length;
}

function scriptOf(text: string, state: Validation): HanScript {
  // The shared detector visits each code point once, bounded above by this code-unit count.
  state.work.scriptCodeUnits += text.length;
  return detectHanScript(text);
}

function differsFromSource(script: HanScript, state: Validation): boolean {
  return state.sourceScript !== 'unknown' && script !== 'unknown' && script !== state.sourceScript;
}

function readLevel(
  value: unknown,
  minimum: number,
  maximum: number,
  path: string,
  state: Validation,
): number | undefined {
  if (value == null) {
    problem(state, 'missing', path);
  } else if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    problem(state, 'range', path, { 范围: `${minimum}到${maximum}` });
  } else {
    return value as number;
  }
  return undefined;
}

function readText(
  value: unknown,
  limit: number,
  path: string,
  state: Validation,
  allowEmpty = false,
): string | undefined {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    problem(state, 'missing', path);
    return undefined;
  }
  if (countText(value, state) > limit) {
    problem(state, 'length', path, { 上限: String(limit) });
    return undefined;
  }
  return value;
}

function readThought(value: unknown, state: Validation): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || countText(value, state) > THOUGHT_LIMIT) {
    state.diagnostics.push({ code: 'appraisal_thought_dropped', path: 'thought' });
    return undefined;
  }
  if (differsFromSource(scriptOf(value, state), state)) {
    state.diagnostics.push({ code: 'appraisal_thought_script_mismatch', path: 'thought' });
  }
  return value;
}

function readRatings(value: unknown, scene: boolean, state: Validation): JsonObject | undefined {
  const path = scene ? 'scene' : 'needs';
  if (!isObject(value)) {
    problem(state, 'missing', path);
    return undefined;
  }
  const output: JsonObject = {};
  for (const key of orderedFields(value, scene ? SCENE_FIELDS : DRIVE_NAMES, state)) {
    const unsigned = scene && key !== 'tone' && key !== 'otherMood';
    const number = readLevel(value[key], unsigned ? 0 : -2, unsigned ? 3 : 2, `${path}.${key}`, state);
    if (number !== undefined) {
      output[key] = number;
    }
  }
  return output;
}

function readFeelings(value: unknown, state: Validation): AppraisalFeeling[] | undefined {
  if (!Array.isArray(value)) {
    problem(state, 'missing', 'feelings');
    return undefined;
  }
  if (value.length > FEELINGS_LIMIT) {
    problem(state, 'feelingsCount', 'feelings');
  }
  const names = value.filter(isObject).map(item => item.name).filter(name => typeof name === 'string').join('\n');
  if (differsFromSource(scriptOf(names, state), state)) {
    if (state.secondAnswer) {
      state.diagnostics.push({ code: 'appraisal_feelings_script_mismatch', path: 'feelings' });
    } else {
      problem(state, 'script', 'feelings', { '繁体/简体': state.sourceScript === 'traditional' ? '繁体' : '简体' });
    }
  }

  const output: AppraisalFeeling[] = [];
  for (const [index, item] of value.entries()) {
    const path = `feelings[${index + 1}]`;
    if (!isObject(item)) {
      problem(state, 'missing', path);
      continue;
    }
    const feeling: JsonObject = {};
    for (const key of orderedFields(item, ['name', 'level'], state)) {
      const checked = key === 'name'
        ? readText(item[key], FEELING_NAME_LIMIT, `${path}.${key}`, state)
        : readLevel(item[key], 1, 3, `${path}.${key}`, state);
      if (checked !== undefined) {
        feeling[key] = checked;
      }
    }
    output.push(feeling as unknown as AppraisalFeeling);
  }
  return output;
}

function readToward(value: unknown, targets: ReadonlySet<string>, state: Validation): AppraisalToward[] | undefined {
  if (!Array.isArray(value)) {
    problem(state, 'missing', 'toward');
    return undefined;
  }
  if (value.length > TOWARD_LIMIT) {
    problem(state, 'towardCount', 'toward');
  }
  const seen = new Set<string>();
  const output: AppraisalToward[] = [];
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) {
      problem(state, 'missing', `toward[${index + 1}]`);
      continue;
    }
    const id = typeof item.target === 'string' ? item.target : '';
    const path = typeof item.target === 'string' ? `toward[${JSON.stringify(id)}]` : `toward[${index + 1}]`;
    const checked: JsonObject = {};
    for (const key of orderedFields(item, TOWARD_FIELDS, state)) {
      const member = `${path}.${key}`;
      const raw = item[key];
      if (key === 'target') {
        if (typeof raw !== 'string') {
          problem(state, 'missing', member);
        } else {
          if (!targets.has(raw)) {
            problem(state, 'target', member, { id: raw });
          }
          if (seen.has(raw)) {
            problem(state, 'duplicate', member, { id: raw });
          }
          seen.add(raw);
          checked.target = raw;
        }
      } else if (key === 'event') {
        const event = readText(raw, TOWARD_EVENT_LIMIT, member, state);
        if (event !== undefined) {
          checked.event = event;
        }
      } else if (key === 'importance') {
        if (raw == null) {
          problem(state, 'missing', member);
        } else if (typeof raw !== 'string' || !IMPORTANCES.has(raw)) {
          problem(state, 'importance', member, { id });
        } else {
          checked.importance = raw;
        }
      } else if (key === 'bond') {
        if (typeof raw === 'string' && BONDS.has(raw)) {
          checked.bond = raw;
        } else if (state.secondAnswer) {
          state.diagnostics.push({ code: 'appraisal_bond_dropped', path: member });
        } else {
          problem(state, 'bond', member, { id });
        }
      } else {
        const number = readLevel(raw, -2, 2, member, state);
        if (number !== undefined) {
          checked[key] = number;
        }
      }
    }
    output.push(checked as unknown as AppraisalToward);
  }
  return output;
}

function containsQuote(text: string, quote: string, state: Validation): boolean {
  // The quote has already passed its 120-code-point cap (at most 240 UTF-16 units).
  // The bounded inner comparison makes this O(240 * text.length), even for repeated-prefix input.
  for (let start = 0; start <= text.length - quote.length; start += 1) {
    let offset = 0;
    while (offset < quote.length) {
      state.work.quoteComparisons += 1;
      if (text[start + offset] !== quote[offset]) {
        break;
      }
      offset += 1;
    }
    if (offset === quote.length) {
      return true;
    }
  }
  return false;
}

function readReception(
  value: unknown,
  reference: string,
  happened: readonly string[],
  state: Validation,
): AppraisalReception | undefined {
  if (!isObject(value)) {
    problem(state, 'missing', 'reception');
    return undefined;
  }
  const checked: JsonObject = {};
  for (const key of orderedFields(value, RECEPTION_FIELDS, state)) {
    const member = `reception.${key}`;
    const raw = value[key];
    if (key === 'ref') {
      if (raw == null || typeof raw !== 'string') {
        problem(state, 'missing', member);
      } else if (raw !== reference) {
        problem(state, 'reference', member);
      } else {
        checked.ref = raw;
      }
    } else if (key === 'answered') {
      if (raw == null) {
        problem(state, 'missing', member);
      } else if (typeof raw !== 'boolean') {
        problem(state, 'range', member, { 范围: 'true|false' });
      } else {
        checked.answered = raw;
        if (raw === false && ((typeof value.level === 'number' && value.level !== 0)
          || (typeof value.quote === 'string' && value.quote !== ''))) {
          problem(state, 'unanswered', 'reception');
        }
      }
    } else if (key === 'level') {
      const level = readLevel(raw, -2, 2, member, state);
      if (level !== undefined) {
        checked.level = level;
      }
    } else {
      const quote = readText(raw, RECEPTION_QUOTE_LIMIT, member, state, value.answered !== true);
      if (quote !== undefined) {
        checked.quote = quote;
        if (value.answered === true && !happened.some(text => containsQuote(text, quote, state))) {
          problem(state, 'quote', member);
        }
      }
    }
  }
  return checked as unknown as AppraisalReception;
}

/**
 * Decodes primitive JSON text for all appraisal call forms; malformed/nonobject input returns one classified problem.
 * First answers reject every reader-relevant error; second answers tolerate only separation, bond, and script errors.
 * Caller context is already validated. Its getters, clock errors, and existing relationship validator errors propagate.
 * O(n + h + t) time/space for raw text n, happened text h, and allowed targets t; no input length limit.
 * Fixed-depth projection ignores unknown keys. Quote search is linear because each quote is capped before comparison.
 */
export function decodeAppraisal(raw: unknown, context: AppraisalDecodeContext): AppraisalDecodeResult {
  const state: Validation = {
    problems: [],
    problemKeys: new Set(),
    diagnostics: [],
    work: { parsedCodeUnits: 0, keys: 0, textCodePoints: 0, scriptCodeUnits: 0, quoteComparisons: 0 },
    secondAnswer: false,
    sourceScript: 'unknown',
  };
  let parsed: unknown;
  if (typeof raw === 'string') {
    state.work.parsedCodeUnits = raw.length;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Parsing primitive text has no caller callbacks; every parse failure uses the same closed-list problem.
      parsed = undefined;
    }
  }
  if (!isObject(parsed)) {
    problem(state, 'notObject', '');
    return { accepted: false, problems: state.problems, diagnostics: state.diagnostics, work: state.work };
  }

  state.secondAnswer = context.attempt === 2;
  state.sourceScript = scriptOf(context.happened.join('\n'), state);
  const targets = new Set(context.towardTargets);
  const ownLine = context.ownLine;
  const relationships = context.relationshipContext;
  const appraisal: JsonObject = {};
  let separation: AppraisalSeparation | undefined;
  for (const key of orderedFields(parsed, TOP_FIELDS, state)) {
    const value = parsed[key];
    let checked: unknown;
    if (key === 'thought') {
      checked = readThought(value, state);
    } else if (key === 'feelings') {
      checked = readFeelings(value, state);
    } else if (key === 'needs' || key === 'scene') {
      checked = readRatings(value, key === 'scene', state);
    } else if (key === 'toward') {
      checked = readToward(value, targets, state);
    } else if (key === 'skipSeparation') {
      if (typeof value === 'string' && SEPARATIONS.has(value)) {
        separation = value as AppraisalSeparation;
      } else if (state.secondAnswer) {
        state.diagnostics.push({ code: 'appraisal_separation_dropped', path: key });
      } else {
        problem(state, 'separation', key);
      }
    } else if (key === 'reception' && ownLine != null) {
      checked = readReception(value, ownLine.ref, context.happened, state);
    }
    if (checked !== undefined) {
      appraisal[key] = checked;
    }
  }
  if (state.problems.length > 0) {
    return { accepted: false, problems: state.problems, diagnostics: state.diagnostics, work: state.work };
  }

  // Keep the existing order: valid emotion first, then the existing scene relationship validator.
  const emotion = mapAppraisal(appraisal as unknown as ReadableAppraisal, {
    skipSeparation: separation,
    clockTimeMs: context.clockTimeMs,
    timeZone: context.timeZone,
  });
  const checkedRelationships = relationships == null ? undefined
    : validateRelationships(parsed.relationships ?? [], relationships, { ignoreValidatedZeroDelta: true });
  return {
    accepted: true,
    emotion,
    ...(checkedRelationships === undefined ? {} : { relationships: checkedRelationships }),
    diagnostics: state.diagnostics,
    work: state.work,
  };
}

/**
 * Fills one fixed reask from ordered decoder problems; repeated member/kind pairs appear once, empty input returns undefined.
 * Only classified problem phrases are used. O(p + m) work for p problems and m rendered code units; getters propagate.
 */
export function buildAppraisalReask(problems: readonly AppraisalProblem[]): string | undefined {
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const item of problems) {
    const identity = `${item.kind}\0${item.path}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      messages.push(item.message);
    }
  }
  if (messages.length === 0) {
    return undefined;
  }
  return APPRAISAL_REASK_TEMPLATE.replace('{问题}', () => messages.join(APPRAISAL_PROBLEM_SEPARATOR));
}
