import {emotionalReactions,type EmotionalReactionKey} from './retention.ts';
import {compareSalience,type SalienceSubject} from './vector-forgetting.ts';

/**
 * Relevance gate and generalised salience path (MR3). Pure: no index, no file, no process. The constants are reference
 * values for DeepSeek-V4.1-Flash extraction with bge-m3 and bge-reranker-v2-m3 and at most 64 memories per NPC; MR7a
 * sweeps them through the Retrieval options.
 */
/** Lowest raw reranker score that admits. */
export const RERANK_FLOOR=0.02;
/** Largest cosine distance that admits. */
export const COSINE_RESCUE=0.42;
/** The salience path fills up to this many ids; also the bound of the emotion-question label rows. */
export const SALIENCE_MINIMUM=3;
/** Fused candidates kept per query part when no semantic signal exists. */
export const LEXICAL_ONLY_LIMIT=3;

export type AdmissionReason='rerank'|'cosine'|'reminded'|'lexical'|'label'|'salience';
export type GateBranch='reranked'|'cosine'|'lexical';
export interface GateCandidate {id:string;score?:number;distance?:number;reminded:boolean}
export interface Admitted {id:string;by:AdmissionReason}
export type SalienceTrigger='few_admitted'|'no_content_words'|'emotion_question';

const usableDistance=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const usableScore=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);

/**
 * Which fused candidates of one query part are admitted, and in which order. `candidates` is the fused order;
 * `compare` orders equal distances (the shared salience order). BM25 only proposes: in the reranked and cosine
 * branches a candidate with no score at the floor, no distance inside the rescue bound and no recall hit is dropped.
 */
export function gate(branch:GateBranch,candidates:readonly GateCandidate[],limits:{floor:number;rescue:number},
  compare:(a:string,b:string)=>number):Admitted[] {
  if(branch==='lexical')return candidates.flatMap((candidate,index):Admitted[]=>index<LEXICAL_ONLY_LIMIT?[{id:candidate.id,by:'lexical'}]:
    candidate.reminded?[{id:candidate.id,by:'reminded'}]:[]);
  const near=(candidate:GateCandidate)=>usableDistance(candidate.distance)&&candidate.distance<=limits.rescue;
  const admitted=candidates.flatMap(candidate=>{
    const by:AdmissionReason|undefined=branch==='reranked'&&usableScore(candidate.score)&&candidate.score>=limits.floor?'rerank':
      near(candidate)?'cosine':candidate.reminded?'reminded':undefined;
    return by?[{candidate,by}]:[];
  });
  const keyed=branch==='reranked'?(item:{candidate:GateCandidate})=>usableScore(item.candidate.score):
    (item:{candidate:GateCandidate})=>usableDistance(item.candidate.distance);
  // Array.prototype.sort is stable: equal scores keep the fused order.
  const first=admitted.filter(keyed).sort(branch==='reranked'?(a,b)=>b.candidate.score!-a.candidate.score!:
    (a,b)=>a.candidate.distance!-b.candidate.distance!||compare(a.candidate.id,b.candidate.id));
  return [...first,...admitted.filter(item=>!keyed(item))].map(item=>({id:item.candidate.id,by:item.by}));
}

// --- Appendix B (FINAL). Entries in lower case and Simplified script; a space in an English phrase stands for one or
// more white-space characters. Lists only decide whether the salience path runs and in which order it adds rows. ---

type Bilingual={readonly zh:readonly string[];readonly en:readonly string[]};
const words=(zh:string,en:string):Bilingual=>Object.freeze({zh:Object.freeze(zh.split(' ').filter(Boolean)),en:Object.freeze(en.split('|').filter(Boolean))});

/** B2: English intent expressions for queryIntent. */
export const INTENT_WORDS={
  episode:Object.freeze('feel|feels|feeling|feelings|felt|remember|remembers|remembered|recall|recalled|why|afraid|scared|nervous|relieved|disappointed|happy|glad|admire|admired|opinion|understand|understood|reconcile|reconciled|think of|think about|thought of|thought about|feel safe'.split('|')),
  fact:Object.freeze('how much|how many|what time|when|who|whom|whose|number|amount|price|cost|password|passphrase|code|promise|promised|agreement|agreed|identity|date|which day|what day|stock|inventory|which page|color|colour'.split('|')),
} as const;
/** B3a: recall words that count unconditionally. */
export const RECALL_WORDS=words('回忆 回想 印象 往事 以前 从前 曾经 当年 当初 小时候 那时候 那会儿 上次 还记得 记不记得 想起来 想不起来 第一次',
  'recall|recalled|memory|memories|impression|back then|in the past|used to|the old days|still remember|remember when|remember how|remember that|the first time|how we met|when we first|ring a bell');
/** B3b: recall words that count only in question form. */
export const RECALL_QUESTION_WORDS=words('记得 想起 忘了 忘记 过去 经历过 发生过','remember|remembers|remembered|forget|forgot|forgotten|happened to you');
/** Recent-past set, counts only in question form. */
export const RECENT_PAST=words('最近怎么样 最近好吗 最近还好吗 最近过得 最近在忙 最近发生 这些天 这阵子 这段时间 近来',
  "how have you been|how've you been|how are things|what's new|been up to|these days");
/** B4: emotion words by stored reaction key. */
export const EMOTION_WORDS:{readonly [K in EmotionalReactionKey]:Bilingual}=Object.freeze({
  joy:words('开心 高兴 快乐 喜悦 幸福 兴奋','happy|joy|joyful|delighted|glad|happiest|excited'),
  gratitude:words('感激 感谢 感恩 感动','grateful|thankful|gratitude'),
  affection:words('爱意 心动 疼爱 喜欢上你 喜欢上他 喜欢上她 你爱我 喜欢我 在乎我','affection|fond|in love|love me|care about me|like me'),
  relief:words('如释重负 松了口气 松了一口气 放心 安心','relief|relieved'),
  pride:words('自豪 骄傲 得意','proud|pride|proudest'),
  sadness:words('难过 伤心 悲伤 痛苦 不开心 不高兴','sad|sadness|unhappy|saddest|upset|cried|cry'),
  grief:words('悲痛 心碎 哀伤','grief|grieve|grieving|heartbroken|mourning'),
  hurt:words('委屈 心寒','wronged|hurt feelings|felt hurt|hurt your feelings|hurt my feelings'),
  anger:words('生气 愤怒 发火 恼火 恨','angry|anger|furious|annoyed'),
  fear:words('害怕 恐惧 吓坏 怕 最怕 怕不怕 可怕','afraid|scared|fear|frightened|terrified|scares|scary|scare|frightening|fears'),
  worry:words('担心 担忧 不安 紧张 焦虑','worried|worry|anxious|uneasy|nervous|worries|worrying|anxiety|stressed'),
  shame:words('丢脸 羞耻 难堪 尴尬 丢人','ashamed|shame|embarrassed|humiliated|embarrassing'),
  guilt:words('内疚 愧疚 过意不去 后悔','guilty|guilt|remorse|regret|regrets'),
  disappointment:words('失望','disappointed|disappointment|let down'),
  jealousy:words('嫉妒 吃醋 眼红 羡慕','jealous|jealousy|envious|envy'),
  longing:words('想念 思念 怀念 想我 你想我吗 你想我了 我想你了 挂念 牵挂',
    'longing|miss you|missed you|miss him|miss her|miss them|long for|miss me|missed me|think of me|think about me'),
  loneliness:words('孤独 孤单 寂寞','lonely|loneliness'),
  disgust:words('恶心 厌恶 反感 讨厌','disgusted|disgust|disgusting|hate|hated'),
  awe:words('震撼 惊叹 佩服','awe|awed|amazed|stunned|amazing|admire'),
});
/** B5: question forms. `吗` matches as a substring of the normalised query (ICU fuses it with a pronoun: 我吗). */
export const QUESTION_WORDS=words('吗 什么 为什么 为何 怎么 怎样 如何 有没有 是否 是不是 哪个 哪里 哪儿 哪些 哪 多少 多久 谁 啥 为啥 干嘛',
  'what|why|how|when|which|who|whom|whose|do you|did you|are you|were you|have you|is there|was there|tell me');
/** B6: comfort and non-question phrases; an emotion word or a B5 word inside one does not count. */
export const COMFORT_PHRASES=words('别担心 不用担心 不要担心 别怕 别害怕 不用怕 不要怕 别生气 别难过 别伤心 别紧张 别哭 没有什么 什么都 什么也 不管什么 无论什么',
  "don't worry|no need to worry|nothing to worry about|don't be afraid|don't be scared|don't be sad|don't be angry|don't be mad|don't be nervous|don't be embarrassed|don't cry|no matter what|no matter how|whatever");
/** B7: Traditional to Simplified fold of the matcher's copy, one code point to one code point. A Map: never an object-key lookup on query text. */
export const TRADITIONAL_FOLD:ReadonlyMap<string,string>=new Map(('憶忆 從从 經经 當当 時时 會会 兒儿 還还 記记 來来 過过 歷历 發发 麼么 麽么 樣样 嗎吗 這这 陣阵 間间 開开 興兴 樂乐 悅悦 奮奋 '+
  '謝谢 動动 愛爱 歡欢 釋释 負负 鬆松 氣气 驕骄 難难 傷伤 憤愤 惱恼 懼惧 嚇吓 壞坏 擔担 憂忧 緊紧 張张 慮虑 丟丢 臉脸 恥耻 尷尴 內内 後后 紅红 羨羡 懷怀 '+
  '掛挂 牽牵 獨独 單单 惡恶 厭厌 討讨 驚惊 嘆叹 歎叹 為为 爲为 沒没 個个 裡里 裏里 誰谁 幹干 別别 無无 論论').split(' ').map(pair=>[...pair] as [string,string]));

// --- matcher ---

/** NFKC, lower case, U+2019 as U+0027, and the Traditional fold. Only the matcher reads this copy. */
export function normaliseForMatch(text:string):string {
  let out='';
  for(const character of text.normalize('NFKC').toLowerCase())out+=character==='’'?"'":TRADITIONAL_FOLD.get(character)??character;
  return out;
}

type Span=readonly [number,number];
interface Prepared {q:string;terms:readonly string[];spans:readonly (Span|undefined)[]}
const HAN=/\p{Script=Han}/u;
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const patterns=new Map<string,RegExp>();
function pattern(entry:string):RegExp {
  let found=patterns.get(entry);
  if(!found){found=new RegExp(`(?<![\\p{L}\\p{N}])${escape(entry).replace(/ +/g,'\\s+')}(?![\\p{L}\\p{N}])`,'gu');patterns.set(entry,found);}
  return found;
}
function prepare(query:string,terms:readonly string[]):Prepared {
  const q=normaliseForMatch(query),normalised=terms.map(term=>normaliseForMatch(String(term)));
  const spans:(Span|undefined)[]=[];
  let cursor=0;
  // Terms are located in q from left to right; a term that cannot be located has no span.
  for(const term of normalised){
    const at=term?q.indexOf(term,cursor):-1;
    if(at<0){spans.push(undefined);continue;}
    spans.push([at,at+term.length]);cursor=at+term.length;
  }
  return {q,terms:normalised,spans};
}
/** Every occurrence of one list entry: its span in q, or null for a term occurrence that cannot be located. */
function occurrences(prepared:Prepared,rawEntry:string):(Span|null)[] {
  const entry=normaliseForMatch(rawEntry),found:(Span|null)[]=[];
  if(!HAN.test(entry)){
    for(const match of prepared.q.matchAll(pattern(entry)))found.push([match.index,match.index+match[0].length]);
    return found;
  }
  if([...entry].length>=3||entry==='吗'){
    for(let at=prepared.q.indexOf(entry);at>=0;at=prepared.q.indexOf(entry,at+1))found.push([at,at+entry.length]);
    return found;
  }
  // One or two characters: the concatenation of one or more consecutive tokenizer terms.
  for(let start=0;start<prepared.terms.length;start++){
    let joined='';
    for(let end=start;end<prepared.terms.length;end++){
      joined+=prepared.terms[end];
      if(joined===entry){
        const first=prepared.spans[start],last=prepared.spans[end];
        found.push(first&&last?[first[0],last[1]]:null);break;
      }
      if(!entry.startsWith(joined))break;
    }
  }
  return found;
}
const listOf=(list:Bilingual)=>[...list.zh,...list.en];
const comfortSpans=(prepared:Prepared):Span[]=>listOf(COMFORT_PHRASES).flatMap(entry=>occurrences(prepared,entry)).filter((span):span is Span=>span!==null);
const outside=(span:Span|null,comfort:readonly Span[])=>span===null||!comfort.some(([start,end])=>start<=span[0]&&span[1]<=end);
const occursIn=(prepared:Prepared,list:Bilingual)=>listOf(list).filter(entry=>occurrences(prepared,entry).length>0);
const occursOutside=(prepared:Prepared,list:Bilingual,comfort:readonly Span[])=>
  listOf(list).filter(entry=>occurrences(prepared,entry).some(span=>outside(span,comfort)));

/** The entries that occur, per list; emotion and question words only outside a comfort phrase. For evidence and tests. */
export function matchedEntries(query:string,terms:readonly string[]) {
  const {prepared,comfort}=analyse(query,terms);
  return {recall:occursIn(prepared,RECALL_WORDS),recallQuestion:occursIn(prepared,RECALL_QUESTION_WORDS),recentPast:occursIn(prepared,RECENT_PAST),
    emotion:(Object.keys(emotionalReactions) as EmotionalReactionKey[]).flatMap(key=>occursOutside(prepared,EMOTION_WORDS[key],comfort).map(entry=>({key,entry}))),
    question:occursOutside(prepared,QUESTION_WORDS,comfort),comfort:occursIn(prepared,COMFORT_PHRASES)};
}

/**
 * One query, read once (§3.1): the matcher's copy with its term spans and comfort spans, and the question form,
 * worked out on first use and then kept. The predicates below read this record and never prepare the query again.
 */
interface Analysis {readonly query:string;readonly prepared:Prepared;readonly comfort:readonly Span[];question?:boolean}
function analyse(query:string,terms:readonly string[]):Analysis {
  const prepared=prepare(query,terms);
  return {query,prepared,comfort:comfortSpans(prepared)};
}
function reactionsOf(analysis:Analysis):EmotionalReactionKey[] {
  const {prepared,comfort}=analysis;
  return (Object.keys(emotionalReactions) as EmotionalReactionKey[]).filter(key=>occursOutside(prepared,EMOTION_WORDS[key],comfort).length>0);
}
function questionOf(analysis:Analysis):boolean {
  const {query,prepared,comfort}=analysis;
  if(analysis.question===undefined)
    analysis.question=query.includes('?')||query.includes('？')||occursOutside(prepared,QUESTION_WORDS,comfort).length>0;
  return analysis.question;
}
function genericRecallOf(analysis:Analysis):boolean {
  const {prepared}=analysis;
  if(occursIn(prepared,RECALL_WORDS).length)return true;
  return (occursIn(prepared,RECALL_QUESTION_WORDS).length>0||occursIn(prepared,RECENT_PAST).length>0)&&questionOf(analysis);
}
function recallIntentOf(analysis:Analysis,reactions:readonly EmotionalReactionKey[]):boolean {
  return genericRecallOf(analysis)||(reactions.length>0&&questionOf(analysis));
}

/** Reaction keys whose emotion words occur outside every comfort phrase, in the key order of emotionalReactions. */
export function queryReactions(query:string,terms:readonly string[]):EmotionalReactionKey[] {
  return reactionsOf(analyse(query,terms));
}
/** A question mark in the raw query, or a B5 word outside every comfort phrase. */
export function questionForm(query:string,terms:readonly string[]):boolean {
  return questionOf(analyse(query,terms));
}
/** A B3a word; or a B3b word or a recent-past entry in question form. */
export function genericRecall(query:string,terms:readonly string[]):boolean {
  return genericRecallOf(analyse(query,terms));
}
/** Recall intent: generic recall, or an emotion word in a question. */
export function recallIntent(query:string,terms:readonly string[]):boolean {
  const analysis=analyse(query,terms);
  return recallIntentOf(analysis,reactionsOf(analysis));
}

export interface SalienceInput {
  /** The merged, admitted ids. */
  ids:readonly string[];
  query:string;
  /** tokenizer.terms(query), raw (fillers kept). */
  terms:readonly string[];
  /** The number of content terms of the whole query (the same terms after the filler filter). */
  contentTermCount:number;
  minimum:number;
  /** Indexed, non-reference rows that are not among the ids. */
  pool:readonly SalienceSubject[];
}
export interface SalienceFill {trigger:SalienceTrigger;reactions:EmotionalReactionKey[];added:Admitted[]}

/**
 * The generalised salience path, after the merge. Undefined when no trigger fires. Label matching reads only the
 * structured reaction keys of the API view. The lists never remove, veto or rewrite a row.
 */
export function salienceFill(input:SalienceInput):SalienceFill|undefined {
  const analysis=analyse(input.query,input.terms),reactions=reactionsOf(analysis);
  const trigger:SalienceTrigger|undefined=input.contentTermCount===0?'no_content_words':
    input.ids.length<input.minimum&&recallIntentOf(analysis,reactions)?'few_admitted':
    input.ids.length>=input.minimum&&reactions.length>0&&questionOf(analysis)?'emotion_question':undefined;
  if(!trigger)return undefined;
  const isLabel=(subject:SalienceSubject)=>(subject.view.emotionalReaction?.reactions??[]).some(key=>reactions.includes(key));
  const labels=input.pool.filter(isLabel).sort(compareSalience),others=input.pool.filter(subject=>!isLabel(subject)).sort(compareSalience);
  const added:Admitted[]=trigger==='emotion_question'
    ?labels.slice(0,Math.max(0,input.minimum)).map(subject=>({id:subject.view.id,by:'label'}))
    :[...labels.map(subject=>({id:subject.view.id,by:'label' as const})),...others.map(subject=>({id:subject.view.id,by:'salience' as const}))]
      .slice(0,Math.max(0,input.minimum-input.ids.length));
  return {trigger,reactions,added};
}
