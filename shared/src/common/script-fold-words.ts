/** Original spellings unique to Traditional input; keys are never character-folded. */
export const SCRIPT_MATCH_WORD_PAIRS: readonly (readonly [string, string])[] = [
  ['計畫', '计划'], ['連絡', '联络'], ['連繫', '联系'], ['甚麼', '什么'], ['甚麽', '什么'],
];

/** Closed, equal-width lexical equivalents for the last quote-search fallback only. */
export const SCRIPT_FOLD_WORD_PAIRS: readonly (readonly [string, string])[] = [
  ['計畫', '计划'], ['回覆', '回复'], ['反覆', '反复'],
  ['想像', '想象'], ['連絡', '联络'], ['連繫', '联系'],
  ['甚麼', '什么'], ['身分', '身份'], ['部份', '部分'],
  ['份量', '分量'], ['成份', '成分'], ['瞭解', '了解'],
  ['明瞭', '明了'], ['藉口', '借口'], ['憑藉', '凭借'],
  ['彷彿', '仿佛'], ['傢俱', '家具'], ['甦醒', '苏醒'],
  ['好象', '好像'], ['其它', '其他'],
];
