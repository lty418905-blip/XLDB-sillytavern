const numeric = /[\d零〇○一二两三四五六七八九十百千万亿兆壹贰叁肆伍陆柒捌玖拾佰仟萬億廿卅卌]/u;
const arithmeticSymbol = /[+＋\-−﹣*＊×/／÷=＝<>＜＞≤≥≠≈%％^＾√∑]/u;
const chineseIntent = /(?:合计|总计|一共|总和|求和|平均|均值|中位数|统计|方差|标准差|百分比|比例|计数|数量|个数|次数|多少|几个|还剩|剩余|余额|金额|总额|小计|成本|价钱|价格|费用|库存|存货|够不够|足不足|更多|更少|最多|最少|哪个(?:更|较)?多|哪个(?:更|较)?少|比较|相比|大于|小于|等于|多于|少于|至少|至多|相差|差额|差多少|时间差|时长|多久|间隔|经过(?:了)?多长|计算|算(?:一下|一算|出)?|加上|减去|乘以|除以)/u;
const englishNumber = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion)\b/iu;
const englishIntent = /\b(?:calculate|calculation|compute|evaluate|evaluation|sum|total|average|mean|median|variance|percentage|ratio|count|quantity|amount|balance|cost|price|remaining|remainder|inventory|stock|enough|more|less|fewer|greater|smaller|largest|smallest|difference|duration|elapsed|plus|minus|times|multiply|multiplied|divide|divided|subtract|subtracted|add|added)\b|\bstandard\s+deviation\b|\bhow\s+(?:many|much|long)\b|\bwhich\b[^?.!,;\n]{0,40}\b(?:more|less|fewer|greater|smaller)\b/iu;

/** Conservative local gate: false only when the current input has no calculation signal. */
export function mayNeedCalculation(input: string): boolean {
  return numeric.test(input.replace(/一如既往|一直|一起|万一|千万别/gu,''))
    || arithmeticSymbol.test(input) || chineseIntent.test(input)
    || englishNumber.test(input.replace(/\bone another\b/giu,'')) || englishIntent.test(input);
}
