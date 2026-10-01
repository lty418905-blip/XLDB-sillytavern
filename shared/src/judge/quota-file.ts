import * as nodeFs from 'node:fs';
import path from 'node:path';
import {JUDGE_MODEL_PATTERN} from './systemone.ts';
import {JUDGE_PROVIDER_IDS} from './providers.ts';
export const JUDGE_QUOTA_SCHEMA = 'xldb-judge-quota-v1';
export const JUDGE_QUOTA_MAX_WRITERS = 32;
export const JUDGE_QUOTA_KEY_PATTERN = Object.freeze(/^(opencode-zen|typesafe)\/[A-Za-z0-9._:\/-]{1,128}$/);
export type JudgeNeedsUserStatus = 401 | 402 | 403 | 404;
export interface JudgeQuotaWriter {day: string; n: number; atMs: number; needsUser: JudgeNeedsUserStatus | null}
export interface JudgeQuotaModel {writers: Record<string, JudgeQuotaWriter>; blockedUntilMs: number | null}
export interface JudgeQuotaFile {schema: typeof JUDGE_QUOTA_SCHEMA; models: Record<string, JudgeQuotaModel>}
export interface JudgeQuotaFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  mkdirSync(path: string, options: {recursive: true}): unknown;
  unlinkSync(path: string): void;
}
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function errorCode(error: unknown, fallback: string): string {
  try { const code = (error as {code?: unknown})?.code; return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : fallback; }
  catch { return fallback; }
}
export function judgeQuotaKey(provider: string, model: string): string | null {
  return JUDGE_PROVIDER_IDS.includes(provider as typeof JUDGE_PROVIDER_IDS[number]) && typeof model === 'string' && JUDGE_MODEL_PATTERN.test(model) ? provider + '/' + model : null;
}
export function defaultJudgeQuotaPath(root: string): string { return path.join(root, '.local', 'judge', 'quota.json'); }
export function parseJudgeQuotaFile(text: unknown): JudgeQuotaFile | null {
  try {
    if (typeof text !== 'string' || text.length > 1000000) return null;
    const root: unknown = JSON.parse(text);
    if (!record(root) || root.schema !== JUDGE_QUOTA_SCHEMA || !record(root.models)) return null;
    const models: [string, JudgeQuotaModel][] = [];
    for (const [key, model] of Object.entries(root.models)) {
      if (!JUDGE_QUOTA_KEY_PATTERN.test(key) || !record(model)) continue;
      const writers: [string, JudgeQuotaWriter][] = [];
      for (const [id, w] of Object.entries(record(model.writers) ? model.writers : {})) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !record(w) || typeof w.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.day)
          || !nonnegative(w.n) || w.n > 10000000 || !nonnegative(w.atMs) || !(w.needsUser === null || [401, 402, 403, 404].includes(w.needsUser as number))) continue;
        writers.push([id, {day: w.day, n: w.n, atMs: w.atMs, needsUser: w.needsUser as JudgeNeedsUserStatus | null}]);
      }
      models.push([key, {writers: Object.fromEntries(writers), blockedUntilMs: nonnegative(model.blockedUntilMs) ? model.blockedUntilMs : null}]);
    }
    return {schema: JUDGE_QUOTA_SCHEMA, models: Object.fromEntries(models)};
  } catch { return null; }
}
export function readJudgeQuotaFile(filePath: string, fs: JudgeQuotaFs = nodeFs): {ok: true; file: JudgeQuotaFile | null} | {ok: false; error: string} {
  try {
    const file = parseJudgeQuotaFile(fs.readFileSync(filePath, 'utf8'));
    return file === null ? {ok: false, error: 'corrupt'} : {ok: true, file};
  } catch (error) {
    const code = errorCode(error, 'read_failed');
    return code === 'ENOENT' ? {ok: true, file: null} : {ok: false, error: code};
  }
}
export function mergeJudgeQuotaModel(base: JudgeQuotaModel | null, own: {writerId: string; writer: JudgeQuotaWriter; blockedUntilMs: number | null}): JudgeQuotaModel {
  const writers = Object.fromEntries([...Object.entries(base?.writers ?? {}).filter(([id]) => id !== own.writerId).map(([id, w]) => [id, {...w}]), [own.writerId, {...own.writer}]]);
  const windows = [base?.blockedUntilMs ?? null, own.blockedUntilMs].filter((v): v is number => v !== null);
  return {writers, blockedUntilMs: windows.length ? Math.max(...windows) : null};
}
export function pruneJudgeQuotaFile(file: JudgeQuotaFile, keepModel: string, ownWriterId: string, today: string, nowMs: number): JudgeQuotaFile {
  const models: [string, JudgeQuotaModel][] = [];
  for (const [key, model] of Object.entries(file.models)) {
    const entries = Object.entries(model.writers).filter(([, w]) => w.day === today);
    const removable = entries.filter(([id]) => id !== ownWriterId).sort(([a, wa], [b, wb]) => wa.atMs - wb.atMs || (a < b ? -1 : a > b ? 1 : 0));
    const drop = new Set(removable.slice(0, Math.max(0, entries.length - JUDGE_QUOTA_MAX_WRITERS)).map(([id]) => id));
    const writers = Object.fromEntries(entries.filter(([id]) => !drop.has(id)).map(([id, w]) => [id, {...w}]));
    if (key !== keepModel && Object.keys(writers).length === 0 && (model.blockedUntilMs === null || model.blockedUntilMs <= nowMs)) continue;
    models.push([key, {writers, blockedUntilMs: model.blockedUntilMs}]);
  }
  return {schema: JUDGE_QUOTA_SCHEMA, models: Object.fromEntries(models)};
}
export function writeJudgeQuotaFile(filePath: string, file: JudgeQuotaFile, tempTag: string, fs: JudgeQuotaFs = nodeFs): {ok: true} | {ok: false; error: string} {
  if (typeof tempTag !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(tempTag)) return {ok: false, error: 'invalid_temp_tag'};
  const tmp = filePath + '.' + tempTag + '.tmp';
  try {
    fs.mkdirSync(path.dirname(filePath), {recursive: true});
    fs.writeFileSync(tmp, JSON.stringify(file) + '\n', 'utf8');
    fs.renameSync(tmp, filePath);
    return {ok: true};
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失敗不覆蓋原錯誤。 */ }
    return {ok: false, error: errorCode(error, 'write_failed')};
  }
}
