import {JUDGE_CALL_SITES, judgeQuestionSpec} from './call-sites.ts';
import type {JudgeCallSite, JudgeQuestionType, JudgeQuestionSpec} from './call-sites.ts';
import {judgeStateIsWrapped} from './state-wrapper.ts';
export const SYSTEMONE_PATH = '/systemone';
export const JUDGE_LIMITS = Object.freeze({maxStateChars: 16000, maxQuestions: 16, maxInstructionsChars: 4000,
  maxCriterionChars: 1000, maxResponseChars: 1000000, maxDetailChars: 200} as const);
export const JUDGE_MODEL_PATTERN = Object.freeze(/^[A-Za-z0-9._:\/-]{1,128}$/);
export const JUDGE_QUESTION_VERSION_PATTERN = Object.freeze(/^[A-Za-z0-9._-]{1,64}$/);
export type JudgeWireType = 'choice' | 'noul' | 'score';
export type JudgeTypeSupport = 'supported' | 'unsupported' | 'unverified';
export interface JudgeQuestion {id: string; type: JudgeQuestionType; version: string; instructions: string; criteria: Readonly<Record<string, string>>}
export interface JudgeRequest {callSite: JudgeCallSite; state: string; questions: readonly JudgeQuestion[]}
export type JudgeAnswer =
  | {id: string; type: 'choice'; distribution: Readonly<Record<string, number>>; value: string}
  | {id: string; type: 'noul'; p: number; distribution: Readonly<Record<string, number>>; value: string}
  | {id: string; type: 'score'; via: 'native' | 'shim'; expected: number; distribution: Readonly<Record<string, number>>; value: string};
export type JudgeRequestIssue = 'request_not_object' | 'unknown_call_site' | 'state_not_string' | 'state_empty' | 'state_too_long' | 'state_not_wrapped'
  | 'questions_not_array' | 'questions_empty' | 'too_many_questions' | 'question_not_object' | 'question_id_not_allowed'
  | 'duplicate_question_id' | 'question_type_mismatch' | 'question_version_invalid' | 'instructions_invalid' | 'criteria_keys_mismatch' | 'criterion_invalid';
export type JudgeAnswerIssue = 'answers_missing' | 'answer_missing' | 'answer_type_mismatch' | 'bad_noul' | 'no_probabilities' | 'bad_probabilities';
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const record = (v: unknown): v is Record<string, unknown> => object(v) && !Array.isArray(v);
export function judgeWireType(specType: unknown, support: unknown): JudgeWireType | null {
  if (specType === 'choice' || specType === 'noul') return specType;
  if (specType !== 'score') return null;
  try { return record(support) && Object.hasOwn(support, 'score') && support.score === 'supported' ? 'score' : 'choice'; }
  catch { return 'choice'; }
}
export function validateJudgeRequest(input: unknown): {ok: true; request: JudgeRequest} | {ok: false; detail: JudgeRequestIssue} {
  const fail = (detail: JudgeRequestIssue): {ok: false; detail: JudgeRequestIssue} => ({ok: false, detail});
  try {
    if (!object(input)) return fail('request_not_object');
    if (!JUDGE_CALL_SITES.includes(input.callSite as JudgeCallSite)) return fail('unknown_call_site');
    if (typeof input.state !== 'string') return fail('state_not_string');
    if (input.state.length === 0) return fail('state_empty');
    if (input.state.length > JUDGE_LIMITS.maxStateChars) return fail('state_too_long');
    if (!judgeStateIsWrapped(input.state)) return fail('state_not_wrapped');
    if (!Array.isArray(input.questions)) return fail('questions_not_array');
    if (input.questions.length === 0) return fail('questions_empty');
    if (input.questions.length > JUDGE_LIMITS.maxQuestions) return fail('too_many_questions');
    const questions: JudgeQuestion[] = [], ids = new Set<string>();
    for (const q of input.questions) {
      if (!object(q)) return fail('question_not_object');
      const spec = judgeQuestionSpec(input.callSite, q.id);
      if (typeof q.id !== 'string' || spec === null) return fail('question_id_not_allowed');
      if (ids.has(q.id)) return fail('duplicate_question_id');
      ids.add(q.id);
      if (q.type !== spec.type) return fail('question_type_mismatch');
      if (typeof q.version !== 'string' || !JUDGE_QUESTION_VERSION_PATTERN.test(q.version)) return fail('question_version_invalid');
      if (typeof q.instructions !== 'string' || q.instructions.length === 0 || q.instructions.length > JUDGE_LIMITS.maxInstructionsChars) return fail('instructions_invalid');
      const keys = spec.type === 'noul' ? ['true', 'false'] : spec.options;
      if (!record(q.criteria) || Object.keys(q.criteria).length !== keys.length || !keys.every(k => Object.hasOwn(q.criteria as object, k))) return fail('criteria_keys_mismatch');
      const criteria: Record<string, string> = {};
      for (const k of keys) {
        const v = q.criteria[k];
        if (typeof v !== 'string' || v.length === 0 || v.length > JUDGE_LIMITS.maxCriterionChars) return fail('criterion_invalid');
        criteria[k] = v;
      }
      questions.push({id: q.id, type: spec.type, version: q.version, instructions: q.instructions, criteria});
    }
    return {ok: true, request: {callSite: input.callSite as JudgeCallSite, state: input.state, questions}};
  } catch { return fail('request_not_object'); }
}
export function buildSystemoneQuestion(spec: JudgeQuestionSpec, question: JudgeQuestion, support: unknown): {type: JudgeWireType; instructions: string; criteria: Record<string, string>} {
  const keys = spec.type === 'noul' ? ['true', 'false'] : spec.options;
  return {type: judgeWireType(spec.type, support)!, instructions: question.instructions,
    criteria: Object.fromEntries(keys.map(k => [k, question.criteria[k]]))};
}
export function buildSystemoneBody(model: string, request: JudgeRequest, support: unknown): string {
  try {
    const questions = Object.fromEntries(request.questions.map(q => [q.id, buildSystemoneQuestion(judgeQuestionSpec(request.callSite, q.id)!, q, support)]));
    return JSON.stringify({model, state: request.state, questions});
  } catch { return ''; }
}
export function parseSystemoneAnswer(spec: JudgeQuestionSpec, question: JudgeQuestion, raw: unknown, support: unknown): {ok: true; answer: JudgeAnswer} | {ok: false; detail: JudgeAnswerIssue} {
  try {
    if (!object(raw)) return {ok: false, detail: 'answer_missing'};
    const wire = judgeWireType(spec.type, support);
    if (raw.type !== wire) return {ok: false, detail: 'answer_type_mismatch'};
    if (spec.type === 'noul') {
      const p = raw.noul;
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return {ok: false, detail: 'bad_noul'};
      return {ok: true, answer: {id: question.id, type: 'noul', p,
        distribution: {[spec.options[0]]: p, [spec.options[1]]: 1 - p}, value: p >= 0.5 ? spec.options[0] : spec.options[1]}};
    }
    if (!record(raw.probabilities)) return {ok: false, detail: 'no_probabilities'};
    const probabilities = raw.probabilities;
    const values = spec.options.map(k => Object.hasOwn(probabilities, k) ? probabilities[k] : 0);
    if (values.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return {ok: false, detail: 'bad_probabilities'};
    const sum = (values as number[]).reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return {ok: false, detail: 'bad_probabilities'};
    const distribution = Object.fromEntries(spec.options.map((k, i) => [k, (values[i] as number) / sum]));
    let value = spec.options[0];
    for (const k of spec.options) if (distribution[k] > distribution[value]) value = k;
    if (spec.type === 'score') {
      const weighted = spec.options.reduce((a, k, i) => a + distribution[k] * i, 0);
      const expected = weighted / (spec.options.length - 1);
      return {ok: true, answer: {id: question.id, type: 'score', via: wire === 'score' ? 'native' : 'shim', expected, distribution, value}};
    }
    return {ok: true, answer: {id: question.id, type: 'choice', distribution, value}};
  } catch { return {ok: false, detail: 'bad_probabilities'}; }
}
export function parseSystemoneAnswers(request: JudgeRequest, body: unknown, support: unknown): {ok: true; answers: Readonly<Record<string, JudgeAnswer>>} | {ok: false; detail: JudgeAnswerIssue} {
  try {
    if (!object(body) || !record(body.answers)) return {ok: false, detail: 'answers_missing'};
    const answers: Record<string, JudgeAnswer> = {};
    for (const q of request.questions) {
      const parsed = parseSystemoneAnswer(judgeQuestionSpec(request.callSite, q.id)!, q, body.answers[q.id], support);
      if (!parsed.ok) return parsed;
      answers[q.id] = parsed.answer;
    }
    return {ok: true, answers};
  } catch { return {ok: false, detail: 'answers_missing'}; }
}
export function parseRetryAfterMs(value: unknown, nowMs: number): number {
  if (typeof value !== 'string') return 60000;
  const v = value.trim(), clamp = (n: number) => Math.min(86400000, Math.max(1000, n));
  if (/^\d+$/.test(v)) return v.length > 10 ? 86400000 : clamp(Number(v) * 1000);
  if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(v) && Number.isFinite(Date.parse(v)) && Number.isFinite(nowMs)) return clamp(Date.parse(v) - nowMs);
  return 60000;
}
export function utcDayKey(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0 || ms > 8.64e15) return null;
  return new Date(ms).toISOString().split('T')[0];
}
export function redactSecret(text: unknown, secret: string | null): string {
  let out: string;
  try { out = typeof text === 'string' ? text : String(text); } catch { out = ''; }
  if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join('[REDACTED]');
  return out.replace(/bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]').slice(0, JUDGE_LIMITS.maxDetailChars);
}
