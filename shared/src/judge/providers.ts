import type {JudgeWireType, JudgeTypeSupport} from './systemone.ts';
export const JUDGE_PROVIDER_IDS = Object.freeze(['opencode-zen', 'typesafe'] as const);
export type JudgeRemoteProvider = typeof JUDGE_PROVIDER_IDS[number];
export interface JudgeProviderPreset {
  readonly id: JudgeRemoteProvider;
  readonly label: string;
  readonly defaultBaseUrl: string;
  readonly defaultModel: string;
  readonly keySlot: JudgeRemoteProvider;
  readonly freeDailyLimits: Readonly<Record<string, number>>;
  readonly questionTypes: Readonly<Record<JudgeWireType, JudgeTypeSupport>>;
  readonly capabilityEvidence: string;
}
export const JUDGE_PROVIDER_PRESETS: Readonly<Record<JudgeRemoteProvider, JudgeProviderPreset>> = Object.freeze({
  'opencode-zen': Object.freeze({id: 'opencode-zen', label: 'OpenCode Zen', defaultBaseUrl: 'https://opencode.ai/zen/v1',
    defaultModel: 'jev-1.13-free', keySlot: 'opencode-zen', freeDailyLimits: Object.freeze({'jev-1.13-free': 290}),
    questionTypes: Object.freeze({choice: 'supported', noul: 'supported', score: 'unsupported'}),
    capabilityEvidence: 'judge-eval 2026-09-30: choice and noul answered; score returned 422 Endpoint is unavailable'}),
  typesafe: Object.freeze({id: 'typesafe', label: 'TypeSafe', defaultBaseUrl: 'https://api.typesafe.ai/v1',
    defaultModel: 'jev-latest', keySlot: 'typesafe', freeDailyLimits: Object.freeze({}),
    questionTypes: Object.freeze({choice: 'unverified', noul: 'unverified', score: 'unverified'}),
    capabilityEvidence: 'vendor origin (OpenCode Zen resells Jev); not measured; score support claimed but unverified'}),
});
export function validateJudgeBaseUrl(value: unknown): string | null {
  try {
    if (typeof value !== 'string' || value.length < 1 || value.length > 512) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || value.includes('?') || value.includes('#') || value.endsWith('/') || url.href !== value) return null;
    return value;
  } catch { return null; }
}
