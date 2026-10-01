/**
 * 判斷題設計說明(J1 呼叫點登記; J5, J7 與 J2 後續重設計照此):
 * 1. 一題只問一件事. 其他面向交給別的題目, 並在題目 instructions 中寫明「只評 X, 不評 Y」.
 * 2. 決定性檢查先做. 規則, 資料或狀態已能決定的, 不呼叫判斷者; 決定不了才呼叫.
 * 3. state 一律經 state-wrapper.ts 的 wrapJudgeState 產生: 允許清單投影, 加固定不可信素材前言.
 *    不得把金標, 示範答案, 評分說明或內部欄位放進 state.
 * 4. 呼叫點把判斷結果讀成三段: 接受, 拒絕, 待定. 門檻一律標為未校準(calibrated: false),
 *    直到以基準資料校準; 待定走後備或規則.
 * 5. 每題帶 version; 題目文字, 選項或量規一改就遞增, 稽核紀錄據此跨期比較.
 * 6. 有序程度題用 score(有序量規, 按機率加權的期望值). 供應商不支援 score 時,
 *    核心自動改以 choice 送出並自行計算期望值(§2.2 轉接), 呼叫點不必分辨.
 */
export const JUDGE_CALL_SITES = Object.freeze(['quiet-exception', 'contact-decision', 'dependence-audit',
  'relationship-assessment', 'schedule-conflict', 'emotion-rank'] as const);
export type JudgeCallSite = typeof JUDGE_CALL_SITES[number];
export type JudgeSiteGroup = 'scene' | 'companion';
export type JudgeLane = 'foreground' | 'background';
export type JudgeQuestionType = 'choice' | 'noul' | 'score';
export interface JudgeQuestionSpec {
  readonly idPattern: RegExp;
  readonly type: JudgeQuestionType;
  readonly options: readonly string[];
}
export interface JudgeCallSiteSpec {
  readonly id: JudgeCallSite;
  readonly group: JudgeSiteGroup;
  readonly lane: JudgeLane;
  readonly priority: number;
  readonly shedAtPercent: number | null;
  readonly defaultEnabled: boolean;
  readonly locked: boolean;
  readonly questions: readonly JudgeQuestionSpec[];
}
function question(idPattern: RegExp, type: JudgeQuestionType, options: string[]): JudgeQuestionSpec {
  return Object.freeze({idPattern: Object.freeze(idPattern), type, options: Object.freeze(options)});
}
function site(id: JudgeCallSite, group: JudgeSiteGroup, lane: JudgeLane, priority: number,
  shedAtPercent: number | null, defaultEnabled: boolean, locked: boolean,
  questions: JudgeQuestionSpec[]): JudgeCallSiteSpec {
  return Object.freeze({id, group, lane, priority, shedAtPercent, defaultEnabled, locked, questions: Object.freeze(questions)});
}
export const JUDGE_CALL_SITE_SPECS: Readonly<Record<JudgeCallSite, JudgeCallSiteSpec>> = Object.freeze({
  'quiet-exception': site('quiet-exception', 'companion', 'background', 1, null, false, false,
    [question(/^longingExperience$/, 'choice', ['positive', 'uncertain', 'negative'])]),
  'contact-decision': site('contact-decision', 'companion', 'background', 2, 95, true, false,
    [question(/^clearHelp$/, 'noul', ['yes', 'no']), question(/^clearHarm$/, 'noul', ['yes', 'no']),
      question(/^emotion$/, 'choice', ['aligned', 'uncertain', 'conflicting']), question(/^contactChoice$/, 'choice', ['send', 'wait', 'skip'])]),
  'dependence-audit': site('dependence-audit', 'companion', 'background', 3, 90, true, false,
    [question(/^sincere:(0|[1-9][0-9]?)$/, 'choice', ['sincere', 'playful_sincere', 'joke', 'quote', 'irony']), question(/^support$/, 'noul', ['true', 'false'])]),
  'relationship-assessment': site('relationship-assessment', 'companion', 'background', 4, 85, true, false,
    [question(/^[0-4]$/, 'noul', ['true', 'false'])]),
  'schedule-conflict': site('schedule-conflict', 'scene', 'foreground', 5, 80, true, false,
    [question(/^decline$/, 'choice', ['A', 'B', 'neither'])]),
  'emotion-rank': site('emotion-rank', 'scene', 'foreground', 6, 80, false, true,
    [question(/^change$/, 'choice', ['none', 'small', 'medium', 'large'])]),
});
export const JUDGE_LANE_TIMEOUT_MS: Readonly<Record<JudgeLane, number>> = Object.freeze({foreground: 3000, background: 10000});
export function judgeQuestionSpec(site: unknown, questionId: unknown): JudgeQuestionSpec | null {
  if (typeof site !== 'string' || !Object.hasOwn(JUDGE_CALL_SITE_SPECS, site) || typeof questionId !== 'string') return null;
  return JUDGE_CALL_SITE_SPECS[site as JudgeCallSite].questions.find(q => q.idPattern.test(questionId)) ?? null;
}
