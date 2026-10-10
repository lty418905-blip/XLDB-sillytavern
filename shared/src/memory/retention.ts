import type {Access,Memory,MemorySnapshot} from './access.ts';
import {currentMemory} from './current-record.ts';
import {codeTokenRanges,compact,mappedText,numericRanges,scriptOf,units,wordsOf,type CodeToken} from './text-units.ts';
import {foldCue,visibleCueHits,restoredAccess,eventKey,TRACE_STRONG_CUES,type TraceTier} from './trace.ts';

export const emotionalReactions = {
  joy:'喜悦', gratitude:'感激', affection:'爱意', relief:'如释重负', pride:'自豪',
  sadness:'悲伤', grief:'悲痛', hurt:'委屈', anger:'愤怒', fear:'恐惧',
  worry:'担忧', shame:'羞耻', guilt:'内疚', disappointment:'失望',
  jealousy:'嫉妒', longing:'思念', loneliness:'孤独', disgust:'厌恶', awe:'震撼',
} as const;
export type EmotionalReactionKey=keyof typeof emotionalReactions;
/** Story-language labels for the stored reaction keys (final wording). */
export const emotionalReactionLabels:{readonly zh:Readonly<Record<EmotionalReactionKey,string>>;readonly en:Readonly<Record<EmotionalReactionKey,string>>}={
  zh:emotionalReactions,
  en:{
    joy:'joy', gratitude:'gratitude', affection:'affection', relief:'relief', pride:'pride',
    sadness:'sadness', grief:'grief', hurt:'hurt', anger:'anger', fear:'fear',
    worry:'worry', shame:'shame', guilt:'guilt', disappointment:'disappointment',
    jealousy:'jealousy', longing:'longing', loneliness:'loneliness', disgust:'disgust', awe:'awe',
  },
};
export interface EmotionalProtection {
  reactions:EmotionalReactionKey[];
  intensity:'strong';
  feelingBasis:'explicit'|'inferred';
  /** Stored evidence only; never copied into the faded emotional projection. */
  basisQuote:string;
}

/** Missing on legacy records means retain, never permission to forget. */
export interface Retention {
  kind:'retain'|'peripheral';
  basisQuote:string;
  cues:string[];
  emotionalProtection?:EmotionalProtection;
}

export const cueDropReasons=['cues_malformed','retain_has_cues','not_string','too_long_raw','empty','not_verbatim',
  'too_short','too_long','duplicate','no_short_cue','over_limit'] as const;
export type CueDropReason=typeof cueDropReasons[number];
/** Optional extraction collector. Counts only; nothing here is stored on a record. */
export interface CueReport {
  supplied:number;
  kept:number;
  dropped:Record<CueDropReason,number>;
  missingShortCue:number;
  protectedFactsTrimmed:number;
  protectedFactsDropped:number;
}
export function cueReport():CueReport {
  return {supplied:0,kept:0,dropped:Object.fromEntries(cueDropReasons.map(reason=>[reason,0])) as Record<CueDropReason,number>,
    missingShortCue:0,protectedFactsTrimmed:0,protectedFactsDropped:0};
}

/** Cue length bands in units(): [minimum, short maximum, maximum]. */
const CUE_BANDS={zh:[4,12,20],en:[2,5,12]} as const;
const CUE_RAW_LIMIT=1000;
const CUE_LIMIT=3;

/** Non-cue faults throw invalid_memory_retention; a bad cue is dropped and counted, never fatal. */
export function retentionOf(value:unknown,detail:string,report?:CueReport):Retention|undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_memory_retention');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['kind','basisQuote','cues','emotionalProtection'].includes(key))||
    !['retain','peripheral'].includes(String(input.kind))||typeof input.basisQuote!=='string'||
    !input.basisQuote.trim()||input.basisQuote.length>1000||!detail.includes(input.basisQuote))throw new Error('invalid_memory_retention');
  const emotionalProtection=emotionalProtectionOf(input.emotionalProtection,detail);
  const kind=input.kind as Retention['kind'];
  return {kind,basisQuote:input.basisQuote,cues:cuesOf(input.cues,kind,detail,report),
    ...(emotionalProtection?{emotionalProtection}:{})};
}

function cuesOf(value:unknown,kind:Retention['kind'],detail:string,report?:CueReport):string[] {
  const drop=(reason:CueDropReason,count=1)=>{if(report)report.dropped[reason]+=count;};
  const missingShort=()=>{if(report)report.missingShortCue++;};
  if(!Array.isArray(value)){
    drop('cues_malformed');
    if(kind==='peripheral')missingShort();
    return [];
  }
  if(report)report.supplied+=value.length;
  if(kind==='retain'){drop('retain_has_cues',value.length);return [];}
  const survivors:{cue:string;short:boolean}[]=[];
  const seen=new Set<string>();
  for(const cue of value){
    if(typeof cue!=='string'){drop('not_string');continue;}
    if(cue.length>CUE_RAW_LIMIT){drop('too_long_raw');continue;}
    if(!cue.trim()){drop('empty');continue;}
    // Verbatim is raw and case-sensitive: a cue is a key the source itself contains.
    if(!detail.includes(cue)){drop('not_verbatim');continue;}
    const [minimum,shortMaximum,maximum]=CUE_BANDS[scriptOf(cue)],size=units(cue);
    if(size<minimum){drop('too_short');continue;}
    if(size>maximum){drop('too_long');continue;}
    const key=compact(cue);
    if(seen.has(key)){drop('duplicate');continue;}
    seen.add(key);survivors.push({cue,short:size<=shortMaximum});
  }
  const firstShort=survivors.findIndex(item=>item.short);
  if(firstShort<0){drop('no_short_cue',survivors.length);missingShort();return [];}
  const keep=new Set([firstShort]);
  for(let index=0;index<survivors.length&&keep.size<CUE_LIMIT;index++)keep.add(index);
  drop('over_limit',survivors.length-keep.size);
  const cues=survivors.filter((_,index)=>keep.has(index)).map(item=>item.cue);
  if(report)report.kept+=cues.length;
  return cues;
}

function emotionalProtectionOf(value:unknown,detail:string):EmotionalProtection|undefined {
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_memory_retention');
  const input=value as Record<string,unknown>;
  if(Object.keys(input).some(key=>!['reactions','intensity','feelingBasis','basisQuote'].includes(key))||
    input.intensity!=='strong'||!['explicit','inferred'].includes(String(input.feelingBasis))||
    !Array.isArray(input.reactions)||input.reactions.length<1||input.reactions.length>3||
    input.reactions.some(key=>typeof key!=='string'||!Object.hasOwn(emotionalReactions,key))||
    typeof input.basisQuote!=='string'||!input.basisQuote.trim()||input.basisQuote.length>1000||
    !detail.includes(input.basisQuote))throw new Error('invalid_memory_retention');
  return {reactions:[...new Set(input.reactions)] as EmotionalProtection['reactions'],intensity:'strong',
    feelingBasis:input.feelingBasis as EmotionalProtection['feelingBasis'],basisQuote:input.basisQuote};
}

/** Protect the reaction, not the event's precise words or the character's current mood. */
export function protectedEmotionalReaction(memory:Memory) {
  const value=memory.retention?.emotionalProtection;
  if(!value||memory.kind!=='episode'||!memory.episode||memory.access==='hidden'||memory.access==='anchor')return undefined;
  const checked=emotionalProtectionOf(value,memory.detail)!;
  return {reactions:[...checked.reactions],intensity:checked.intensity,feelingBasis:checked.feelingBasis};
}

/** Fragment length bands in units(): [minimum, maximum], both inclusive. Uncertain; MR7a reports. */
export const FRAGMENT_BANDS={zh:[2,20],en:[1,12]} as const;
export const FRAGMENT_LIMIT=4;
/** All kept fragments together stay under this share of the compact detail. Uncertain; MR7a measures it. */
export const FRAGMENT_TOTAL_RATIO=0.5;
export const FRAGMENT_RAW_LIMIT=1000;

/**
 * Short verbatim scene and sensory fragments that stay with an emotionally protected episode after automatic fading.
 * A candidate that fails a rule is dropped whole, never cut or masked. Lexical index and foreground only: fragments
 * are neither a semantic basis nor an accessible layer for the exact-cue check.
 */
export function rememberedFragmentsOf(memory:Memory):string[] {
  if(!protectedEmotionalReaction(memory))return [];
  if(memory.access!=='gist'&&memory.access!=='feeling')return [];
  // A user-chosen granularity never re-exposes source text.
  if(memory.accessOverride)return [];
  const episode=memory.episode as {scene?:unknown;sensoryCues?:unknown}|undefined;
  // The scene comes first, then the sensory cues in stored order; a non-string candidate is skipped below.
  const candidates:unknown[]=[episode?.scene,...(Array.isArray(episode?.sensoryCues)?episode.sensoryCues:[])];
  const bound=FRAGMENT_TOTAL_RATIO*compact(memory.detail).length;
  // The emotional evidence quote is stored evidence only (EmotionalProtection.basisQuote); empty when it has no letters.
  const evidence=compact(memory.retention?.emotionalProtection?.basisQuote??'');
  const fragments:string[]=[];
  const seen=new Set<string>();
  let kept=0;
  for(const candidate of candidates){
    if(fragments.length>=FRAGMENT_LIMIT)break;
    if(typeof candidate!=='string')continue;
    if(candidate.length>FRAGMENT_RAW_LIMIT)continue;
    const fragment=candidate.trim();
    if(!fragment)continue;
    // Verbatim in the detail itself: extraction validates against any evidence quote, which is not enough here.
    if(!memory.detail.includes(fragment))continue;
    const [minimum,maximum]=FRAGMENT_BANDS[scriptOf(fragment)],size=units(fragment);
    if(size<minimum)continue;
    if(size>maximum)continue;
    const key=compact(fragment);
    // Punctuation only ('-', an apostrophe): a word for units(), nothing to show.
    if(!key)continue;
    // Half of the detail or more is the event, not a fragment; a dropped candidate adds nothing to the total.
    if(kept+key.length>=bound)continue;
    // A precise value of its own, whatever the detail contains.
    if(codeTokenRanges(fragment).length>0)continue;
    if(numericRanges(fragment).length>0)continue;
    // Defence in depth for hand-built or migrated episodes that carry protected facts.
    if(maskLayer(memory.detail,fragment,memory.protectedFacts).state!=='visible')continue;
    // The evidence quote never reaches the faded view: a candidate that contains it or lies inside it is dropped.
    if(evidence&&(key.includes(evidence)||evidence.includes(key)))continue;
    if(seen.has(key))continue;
    seen.add(key);fragments.push(fragment);kept+=key.length;
  }
  return fragments;
}

/** A protected fact covering at least this share of the compact detail is trimmed on new peripheral facts. */
export const PROTECTED_WHOLE_DETAIL_RATIO=0.8;

/**
 * New peripheral facts only: a protected fact that covers the whole detail keeps just its precise fragments
 * (code tokens and numeric runs of 2+ digits, verbatim, in source order); without fragments it is dropped.
 */
export function trimWholeDetailProtectedFacts(detail:string,protectedFacts:readonly string[],report?:CueReport):string[] {
  const whole=compact(detail).length;
  const result:string[]=[];
  for(const fact of protectedFacts){
    if(compact(fact).length<PROTECTED_WHOLE_DETAIL_RATIO*whole){result.push(fact);continue;}
    const ranges=[...codeTokenRanges(fact),...numericRanges(fact)].sort((a,b)=>a.start-b.start||b.end-a.end);
    // A fragment inside a longer fragment (12 inside B12) adds nothing.
    const fragments=ranges.filter(range=>!ranges.some(other=>other.start<=range.start&&other.end>=range.end&&
      other.end-other.start>range.end-range.start)).map(range=>fact.slice(range.start,range.end));
    if(fragments.length){if(report)report.protectedFactsTrimmed++;result.push(...fragments);}
    else if(report)report.protectedFactsDropped++;
  }
  return [...new Set(result)];
}

/** Closed set of the old fixed Chinese substitutes. Kept only to recognise stored legacy rows; never emitted. */
const LEGACY_TEMPLATES=new Set([
  '记得曾发生过一件事，但具体内容已经模糊。',
  '这段经历仍留下感觉，但具体感受已经模糊。',
  '仍记得发生过一件事。',
]);
export function isLegacyTemplate(layer:string):boolean {return LEGACY_TEMPLATES.has(layer.trim());}

export type MemoryLayer='gist'|'feeling'|'anchor';
export type LayerState='visible'|'masked'|'blocked';
/** Shared-run lengths that count as a copy of a protected fact. */
export const ZH_FACT_RUN=6;
export const EN_FACT_WORDS=3;
/** A masked remainder needs one intact clause of at least one short sentence; below that it is blocked. */
const ZH_RESIDUAL_UNITS=6;
const EN_RESIDUAL_UNITS=4;

/**
 * Guard modes. `exact` differs from `standard` in one point: shared runs with a protected fact are not checked; whole
 * protected facts, codes, templates and whole-detail copies are handled the same.
 */
export type GuardMode='standard'|'exact';

/**
 * The single copy guard for faded access; one call per memory layer at projection. The feeling of a retain or
 * emotionally protected memory is checked for exact values only.
 */
export function visibleLayer(memory:Pick<Memory,'detail'|'protectedFacts'|MemoryLayer>&{retention?:Retention},layer:MemoryLayer):{text:string;state:LayerState} {
  const exact=layer==='feeling'&&(memory.retention?.kind==='retain'||memory.retention?.emotionalProtection!==undefined);
  return maskLayer(memory.detail,memory[layer],memory.protectedFacts,exact?'exact':'standard');
}

type MaskResult={readonly text:string;readonly state:LayerState};
type DetailEntry={compact:string;tokens:readonly CodeToken[];results:Map<string,MaskResult>};
/**
 * Records are immutable and the guard is pure, so results are memoised by content: detail, then protectedFacts and
 * layer. Every context pass projects each faded memory several times; only the first pass pays for the guard. The
 * cache holds at most GUARD_CACHE_DETAILS details and drops the oldest insertion first. The bound is a
 * count, not bytes, and entries leave only by eviction; 5,000 details still covers the 2,000-faded-memory scale that
 * the performance check targeted; that check measured 33 MB at 20,000 audit-length details, so about a quarter of that is expected here.
 */
export const GUARD_CACHE_DETAILS=5_000;
const guardCache=new Map<string,DetailEntry>();
/** Entry counts of the guard caches, for the eviction test. */
export function guardCacheSizes():{details:number;tokens:number} {return {details:guardCache.size,tokens:tokenCache.size};}
/** JSON escapes U+0001, so this separator never occurs in the facts part of a key and the key is unambiguous. */
const LAYER_SEPARATOR='\u0001';

/** Code tokens of a detail or protected fact; the same facts recur for every layer of a memory. Bounded like the guard. */
const tokenCache=new Map<string,readonly CodeToken[]>();
function tokensOf(value:string):readonly CodeToken[] {
  let tokens=tokenCache.get(value);
  if(tokens)return tokens;
  if(tokenCache.size>=GUARD_CACHE_DETAILS)tokenCache.delete(tokenCache.keys().next().value!);
  tokens=Object.freeze(codeTokenRanges(value));
  tokenCache.set(value,tokens);
  return tokens;
}

function detailEntry(detail:string):DetailEntry {
  let entry=guardCache.get(detail);
  if(entry)return entry;
  if(guardCache.size>=GUARD_CACHE_DETAILS)guardCache.delete(guardCache.keys().next().value!);
  entry={compact:compact(detail),tokens:tokensOf(detail),results:new Map()};
  guardCache.set(detail,entry);
  return entry;
}

/**
 * Masks precise values out of a layer; a layer that is a legacy template, empty, the whole detail, or too little
 * after masking is blocked. Pure; memoised by content.
 */
export function maskLayer(detail:string,layer:string,protectedFacts:readonly string[]=[],mode:GuardMode='standard'):MaskResult {
  const entry=detailEntry(detail);
  // The mode is part of the key: the two modes never share a cached result.
  const key=mode+LAYER_SEPARATOR+JSON.stringify(protectedFacts)+LAYER_SEPARATOR+layer;
  let result=entry.results.get(key);
  if(!result){result=Object.freeze(computeMask(entry,layer,protectedFacts,mode));entry.results.set(key,result);}
  return result;
}

/** Deterministic cold-work charges, optionally shared with a caller's record-level counters. */
export interface ProtectedFactWork {substring: number; protection: number; helpers: number}
const protectedTextWork = (text: string, work: ProtectedFactWork, passes = 1) => {work.helpers += passes * 163 * text.length;};
/**
 * Prepare facts once in O(f), query in O(p*n + n) with p <= twice the fact count; output O(p*n).
 * Six-code-point and three-word windows have fixed widths. No pairwise shared-run table or per-match prefix slice.
 * Both cluster and whole-string folds are retained, including their original word-boundary semantics.
 */
/** KMP: at most two character comparisons per haystack unit, including failed prefixes. */
class Pattern {
  key: string;
  failure: Uint32Array;
  work: ProtectedFactWork;
  constructor(key: string, work: ProtectedFactWork) {
    this.key = key; this.work = work; this.failure = new Uint32Array(key.length);
    work.substring += key.length;
    for (let i = 1, j = 0; i < key.length; i++) {
      while (j && key[i] !== key[j]) {work.substring++; j = this.failure[j - 1]!;}
      work.substring++; if (key[i] === key[j]) j++;
      this.failure[i] = j;
    }
  }
  contains(text: string, boundary?: (start: number, end: number) => boolean, spans?: [number, number][]): boolean {
    const key = this.key;
    for (let i = 0, j = 0; i < text.length; i++) {
      while (j && text[i] !== key[j]) {this.work.substring++; j = this.failure[j - 1]!;}
      this.work.substring++;
      if (text[i] === key[j]) j++;
      if (j === key.length) {
        if (!boundary || boundary(i + 1 - j, i + 1)) {
          if (!spans) return true;
          spans.push([i + 1 - j, i + 1]);
        }
        j = this.failure[j - 1]!;
      }
    }
    return false;
  }
}

/** Fixed six-character / three-word windows are built once per record, never per clause. */
export class ProtectedFactDetector {
  exact: {pattern: Pattern; han: boolean}[] = [];
  hanRuns = new Set<string>();
  enRuns = new Set<string>();
  work: ProtectedFactWork;
  constructor(facts: readonly string[], work: ProtectedFactWork = {substring: 0, protection: 0, helpers: 0}) {
    this.work = work;
    // map skips sparse slots, as the guard has always done; candidate pools supply validated dense arrays.
    const prepared = facts.map(fact => {
      protectedTextWork(fact, work, 5); // compact, mappedText, scriptOf, wordsOf and per-word folding.
      const key = compact(fact), mapped = mappedText(fact, {dropPunctuation: true}).text;
      work.protection += 1 + key.length + mapped.length;
      return {fact, key, mapped};
    });
    for (const {fact, key, mapped} of prepared.filter(() => true)) {
      if (key.length < 2 || mapped.length < 2) continue;
      const han = scriptOf(fact) === 'zh', needles = mapped === key ? [mapped] : [mapped, key];
      for (const needle of needles) {
        this.exact.push({pattern: new Pattern(needle, work), han});
        if (han) {
          const chars = [...needle]; work.protection += needle.length;
          for (let i = 0; i + ZH_FACT_RUN <= chars.length; i++) {
            work.protection += 2 * ZH_FACT_RUN;
            this.hanRuns.add(chars.slice(i, i + ZH_FACT_RUN).join(''));
          }
        }
      }
      if (!han) {
        const words = wordsOf(fact).map(item => item.word.normalize('NFKC').toLowerCase());
        for (let i = 0; i + EN_FACT_WORDS <= words.length; i++) {
          const window = words.slice(i, i + EN_FACT_WORDS);
          work.protection += 2 * (EN_FACT_WORDS + window.join('').length);
          this.enRuns.add(JSON.stringify(window));
        }
      }
    }
  }
  /** Boolean query avoids allocating match ranges; neither query populates the copy-guard caches. */
  hits(text: string, mode: GuardMode = 'standard'): boolean {return this.scan(text, mode);}
  /** Raw UTF-16 ranges; overlapping windows cover exactly the same units as maximal shared runs. */
  spans(text: string, mode: GuardMode = 'standard'): [number, number][] {
    const result: [number, number][] = [];
    this.scan(text, mode, result);
    return result;
  }
  private scan(text: string, mode: GuardMode, result?: [number, number][]): boolean {
    const work = this.work;
    if (!this.exact.length) return false;
    protectedTextWork(text, work, 3); // mappedText, wordsOf and per-word folding.
    const loose = mappedText(text, {dropPunctuation: true});
    // A Latin/number followed by marks is still a word end, just as the copy guard's regex specifies.
    const wordEnd = new Uint8Array(text.length + 1), wordStart = new Uint8Array(text.length + 1);
    let last = false;
    for (let at = 0; at < text.length;) {
      const char = String.fromCodePoint(text.codePointAt(at)!);
      if (!/\p{M}/u.test(char)) last = /[\p{Script=Latin}\p{N}]/u.test(char);
      wordStart[at] = /[\p{Script=Latin}\p{N}]/u.test(char) ? 1 : 0;
      at += char.length; wordEnd[at] = last ? 1 : 0; work.protection += 4;
    }
    const mark = (from: number, to: number) => {result!.push([loose.start[from]!, loose.end[to - 1]!]);};
    for (const {pattern, han} of this.exact) {
      work.protection++;
      const matches: [number, number][] | undefined = result ? [] : undefined;
      if (pattern.contains(loose.text, han ? undefined : (from, to) => {
        work.protection += 3;
        return !wordEnd[loose.start[from]!] && !wordStart[loose.end[to - 1]!];
      }, matches)) return true;
      if (matches) for (const [from, to] of matches) mark(from, to);
    }
    if (mode === 'exact') return false;
    const chars = [...loose.text]; work.protection += loose.text.length;
    const offsets = [0]; if (result) for (const char of chars) offsets.push(offsets.at(-1)! + char.length);
    if (this.hanRuns.size) for (let i = 0; i + ZH_FACT_RUN <= chars.length; i++) {
      work.protection += 2 * ZH_FACT_RUN;
      if (this.hanRuns.has(chars.slice(i, i + ZH_FACT_RUN).join(''))) {
        if (!result) return true;
        mark(offsets[i]!, offsets[i + ZH_FACT_RUN]!);
      }
    }
    if (this.enRuns.size) {
      const sourceWords = wordsOf(text);
      const words = sourceWords.map(item => item.word.normalize('NFKC').toLowerCase());
      for (let i = 0; i + EN_FACT_WORDS <= words.length; i++) {
        const window = words.slice(i, i + EN_FACT_WORDS);
        work.protection += 2 * (EN_FACT_WORDS + window.join('').length);
        if (this.enRuns.has(JSON.stringify(window))) {
          if (!result) return true;
          result.push([sourceWords[i]!.start, sourceWords[i + EN_FACT_WORDS - 1]!.end]);
        }
      }
    }
    return false;
  }
}

const BLOCKED:MaskResult=Object.freeze({text:'',state:'blocked'});

function computeMask(entry:DetailEntry,layer:string,protectedFacts:readonly string[],mode:GuardMode):MaskResult {
  if(isLegacyTemplate(layer)||!layer.trim())return BLOCKED;
  const compactLayer=compact(layer),compactDetail=entry.compact;
  if(compactLayer===compactDetail||(compactDetail.length>=6&&compactLayer.includes(compactDetail)))return BLOCKED;
  const spans:[number,number][]=[],factSpans=new ProtectedFactDetector(protectedFacts).spans(layer,mode);
  const tokens=[...entry.tokens,...protectedFacts.flatMap(tokensOf)];
  // Digit-bearing codes (letter-digit mixes, digit runs): every case-insensitive occurrence, even inside A4729 or
  // Rm4729. Known limit (recorded, not changed): the code must appear as written, so a reformatted code
  // (B12 for B-12, HX7 for HX-7, 4-7-2-9 for 4729) is not found.
  const digitCodes=new Set(tokens.filter(token=>token.kind!=='caps').map(token=>token.token.toLowerCase()));
  if(digitCodes.size){
    const folded=mappedText(layer,{dropPunctuation:false});
    for(const code of digitCodes)
      for(let at=folded.text.indexOf(code);at>=0;at=folded.text.indexOf(code,at+1))spans.push([folded.start[at]!,folded.end[at+code.length-1]!]);
  }
  // All-caps codes: case-sensitive whole tokens only, so a shouted STOP in the source never masks "stop" or "rhythms".
  const capsCodes=new Set(tokens.filter(token=>token.kind==='caps').map(token=>token.token));
  if(capsCodes.size){
    const exact=mappedText(layer,{dropPunctuation:false,lower:false});
    for(const code of capsCodes)
      for(let at=exact.text.indexOf(code);at>=0;at=exact.text.indexOf(code,at+1)){
        const before=exact.text[at-1],after=exact.text[at+code.length];
        if((before!==undefined&&/[A-Za-z0-9]/.test(before))||(after!==undefined&&/[A-Za-z0-9]/.test(after)))continue;
        spans.push([exact.start[at]!,exact.end[at+code.length-1]!]);
      }
  }
  if(!spans.length&&!factSpans.length)return {text:layer,state:'visible'};
  const text=removeAndTidy(layer,spans,factSpans);
  if(!clausesOf(text).some(clause=>units(clause)>=(scriptOf(clause)==='zh'?ZH_RESIDUAL_UNITS:EN_RESIDUAL_UNITS)))return BLOCKED;
  return {text,state:'masked'};
}

/**
 * Ranges of `right` covered by a common run with `left` of at least `minimum` items. With `offsets` the ranges
 * are UTF-16 offsets into the joined right text; otherwise item indexes. One range per maximal run: a cell reports its
 * run only when the next cell on the diagonal does not continue it. A shorter range of the same run starts at the same
 * item and lies inside the maximal one, so the covered items are the same as with one range per cell. Time is
 * O(left*right) for the table; every cell lies in at most one maximal run, so the ranges together are at most left*right items long.
 */
export function sharedRuns(left:readonly string[],right:readonly string[],minimum:number,offsets:boolean):[number,number][] {
  const runs:[number,number][]=[];
  let previous=new Array<number>(right.length+1).fill(0);
  for(let i=1;i<=left.length;i++){
    const current=new Array<number>(right.length+1).fill(0);
    for(let j=1;j<=right.length;j++)if(left[i-1]===right[j-1]){
      current[j]=previous[j-1]!+1;
      // Maximal: the next cell on this diagonal (left[i], right[j]) does not continue the run, or one side has ended.
      if(current[j]!>=minimum&&(i===left.length||j===right.length||left[i]!==right[j]))runs.push([j-current[j]!,j]);
    }
    previous=current;
  }
  if(!offsets)return runs;
  const at=[0];for(const item of right)at.push(at.at(-1)!+item.length);
  return runs.map(([from,to])=>[at[from]!,at[to]!]);
}

const SEPARATORS=new Set(['，',',','、',';','；',':','：']);
const OPENING=new Set(['“','‘','「','『','（','(','【','《','[','{']);
const CLOSING=new Set(['”','’','」','』','）',')','】','》',']','}','"']);
const SENTENCE_FINAL=new Set(['。','．','.','!','！','?','？','…']);
/** The sentence-final marks that state; the only ones restored after a drop. */
const FULL_STOPS=new Set(['。','．','.']);
export const PAIRS=new Map([['“','”'],['‘','’'],['「','」'],['『','』'],['（','）'],['(',')'],['【','】'],['《','》'],['[',']'],['"','"'],['\'','\'']]);
/** Bracket pairs whose removal leaves an aside, not a hole in the clause (quotes usually carry an object). */
const ASIDES=new Set(['（','(','【','[']);
/** A removal inside one of these clauses drops the whole clause. The enumeration comma splits clauses here too. */
const CLAUSE_BOUNDARY=new Set([...SEPARATORS,...SENTENCE_FINAL,'\n']);
/** For the residual an enumeration (码头旧书摊、航海日志) is one clause. */
export const RESIDUAL_BOUNDARY=/[，,;；:：。．.!！?？…\n]/u;
type Piece={char:string}|{cut:true;aside?:true;fact?:true};

function clausesOf(text:string):string[] {return text.split(RESIDUAL_BOUNDARY).filter(clause=>clause.trim());}

/**
 * Removes the spans, then tidies what the removal left: (a) empty quote and bracket pairs; a clause the removal cut
 * into (anything of it left besides punctuation) is dropped whole, since its remnant is a fragment such as 叮嘱林岚油 or
 * 扉页写着; quote and bracket marks left without their partner; (b) one separator before a removal point that ends a
 * clause or meets another separator; (c) one separator after a removal point that starts the text or a quote; (d)
 * whitespace.
 */
function removeAndTidy(layer:string,codeSpans:readonly [number,number][],factSpans:readonly [number,number][]):string {
  // 1 marks a code removal, 2 a protected-fact removal.
  const removed=new Uint8Array(layer.length);
  for(const [from,to] of codeSpans)for(let i=from;i<to;i++)removed[i]!|=1;
  for(const [from,to] of factSpans)for(let i=from;i<to;i++)removed[i]!|=2;
  let pieces:Piece[]=[];
  for(let i=0;i<layer.length;){
    if(removed[i]){
      let fact=false;
      while(i<layer.length&&removed[i]){fact||=(removed[i]!&2)!==0;i++;}
      pieces.push(fact?{cut:true,fact:true}:{cut:true});continue;
    }
    const char=String.fromCodePoint(layer.codePointAt(i)!);pieces.push({char});i+=char.length;
  }
  const isCut=(index:number)=>{const piece=pieces[index];return !!piece&&'cut' in piece;};
  const charAt=(index:number)=>{const piece=pieces[index];return piece&&'char' in piece?piece.char:undefined;};
  const blank=(index:number)=>isCut(index)||/^\s$/u.test(charAt(index)??'x');
  const leftOf=(index:number)=>{let at=index-1;while(at>=0&&blank(at))at--;return at;};
  const rightOf=(index:number)=>{let at=index+1;while(at<pieces.length&&blank(at))at++;return at;};
  // (a) Quote and bracket pairs left empty.
  const emptyPairs=()=>{
    for(let changed=true;changed;){
      changed=false;
      for(let index=0;index<pieces.length&&!changed;index++){
        if(!isCut(index))continue;
        const left=leftOf(index),right=rightOf(index),open=charAt(left),close=charAt(right);
        if(open===undefined||close===undefined||PAIRS.get(open)!==close)continue;
        const fact=pieces.slice(left,right+1).some(piece=>'cut' in piece&&piece.fact);
        const piece:Piece=ASIDES.has(open)?{cut:true,aside:true}:fact?{cut:true,fact:true}:{cut:true};
        // An emptied aside keeps its protected fact, so a fact that filled the brackets starts the drop too.
        if(fact&&'aside' in piece)piece.fact=true;
        pieces.splice(left,right-left+1,piece);changed=true;
      }
    }
  };
  emptyPairs();
  // Clauses the removal cut into are dropped whole rather than left as fragments. Every clause after the first dropped
  // one goes too: the dropped clause often carried the subject, the request verb, the quote opener or the condition,
  // and a subjectless continuation (然后很快地走出了灯塔, then wait by the ferry) would read as the character's own
  // action. Only the intact prefix survives. A clause that was nothing but a removed code leaves no words behind and
  // is not a dropped clause. A clause emptied by a protected fact does start the drop: the fact often
  // carried the subject and the request verb (Nell asked me to leave the parcel in locker B12, then wait by the ferry).
  // A bracket aside emptied by a protected fact starts the drop as well.
  // Once dropping, the boundaries after the drop go too; only a sentence-final mark that ends the layer comes back,
  // after a kept separator and as a full stop, so 那天风很大，[dropped]。[dropped]。 reads 那天风很大。 and never
  // 那天风很大。。, and 那天风很大，[dropped]？ reads 那天风很大。
  const kept:Piece[]=[];
  let dropping=false,lastBoundary:string|undefined;
  for(let start=0;start<pieces.length;){
    let end=start;
    while(end<pieces.length&&!CLAUSE_BOUNDARY.has(charAt(end)??''))end++;
    const clause=pieces.slice(start,end);
    const holed=clause.some(piece=>'cut' in piece&&!piece.aside);
    const remnant=clause.map(piece=>'char' in piece?piece.char:' ').join('');
    if(dropping||(holed&&/[\p{L}\p{N}]/u.test(remnant))){kept.push({cut:true});dropping=true;}
    else{
      kept.push(...clause);
      if(clause.some(piece=>'cut' in piece&&piece.fact))dropping=true;
    }
    if(end<pieces.length){if(dropping)lastBoundary=charAt(end);else kept.push(pieces[end]!);}
    start=end+1;
  }
  if(dropping&&lastBoundary!==undefined&&SENTENCE_FINAL.has(lastBoundary)){
    const previous=kept.findLast(piece=>'char' in piece&&!/^\s$/u.test(piece.char));
    // Only a full stop comes back. The dropped text's ？！… would turn the kept statement into a question
    // or an exclamation, so they become the full stop of the kept text's script.
    if(!FULL_STOPS.has(lastBoundary))lastBoundary=scriptOf(kept.map(piece=>'char' in piece?piece.char:'').join(''))==='zh'?'。':'.';
    if(previous&&'char' in previous&&SEPARATORS.has(previous.char))kept.push({char:lastBoundary});
  }
  pieces=kept;
  emptyPairs();
  // Quote and bracket marks that lost their partner. An unpaired ’ is an apostrophe and ASCII ' is ambiguous; both stay.
  const orphans=new Set<number>(),open:number[]=[];
  pieces.forEach((_,index)=>{
    const char=charAt(index);
    if(char===undefined)return;
    if(char==='"'){if(open.length&&charAt(open.at(-1)!)==='"')open.pop();else open.push(index);return;}
    if(OPENING.has(char)){open.push(index);return;}
    if(!CLOSING.has(char))return;
    const at=open.findLastIndex(item=>PAIRS.get(charAt(item)!)===char);
    if(at<0){if(char!=='’')orphans.add(index);return;}
    for(const item of open.splice(at).slice(1))orphans.add(item);
  });
  for(const item of open)orphans.add(item);
  pieces=pieces.filter((_,index)=>!orphans.has(index));
  // (b) One separator before a removal point that now ends a clause or meets another separator.
  for(let index=0;index<pieces.length;index++){
    if(!isCut(index))continue;
    const left=leftOf(index),next=charAt(rightOf(index));
    if(SEPARATORS.has(charAt(left)??'')&&(next===undefined||CLOSING.has(next)||SENTENCE_FINAL.has(next))){pieces.splice(left,1);index--;}
    else if(SEPARATORS.has(charAt(left)??'')&&next!==undefined&&SEPARATORS.has(next))pieces.splice(rightOf(index),1);
  }
  // (c) One separator after a removal point that now starts a clause.
  for(let index=0;index<pieces.length;index++){
    if(!isCut(index))continue;
    const right=rightOf(index),previous=charAt(leftOf(index));
    if(SEPARATORS.has(charAt(right)??'')&&(previous===undefined||OPENING.has(previous)))pieces.splice(right,1);
  }
  // (d) Whitespace, including a space the removal left before a separator or sentence-final mark (hand . I washed).
  return pieces.map(piece=>'char' in piece?piece.char:'').join('').replace(/\s+/gu,' ').trim()
    .replace(/ (?=[，,、;；:：。．.!！?？…])/gu,'');
}

const DAY=86_400_000;

/** A view-only time decision; it neither changes history nor writes on recall. */
export function retainedAccess(memory:Memory,nowMs:number,cueText=''): {access:Access;reactivated?:true} {
  if(memory.accessOverride||memory.access!=='clear'||memory.source.reference||memory.retention?.kind!=='peripheral')return {access:memory.access};
  if(memory.reactivated)return {access:memory.access,reactivated:true};
  const since=memory.retentionAtMs??memory.source.knownAtMs;
  const age=Math.max(0,nowMs-since);
  // Only explicitly peripheral memories participate. Anchors and protected
  // facts survive every stage, and absence of a safe classification retains.
  const first=memory.kind==='episode'?30*DAY:60*DAY;
  if(age<first)return {access:'clear'};
  const tier:Access=age<180*DAY?'gist':'feeling';
  // A cue of the memory in the text restores one stage; two or more restore to clear. The cue need not be in a
  // visible layer: the trace is a reminder key, never text shown to anyone.
  if(cueText&&restorableStage(memory,nowMs,tier)){
    const hits=visibleCueHits(memory.retention.cues,foldCue(cueText));
    if(hits>0)return {access:restoredAccess(tier,hits>=TRACE_STRONG_CUES),reactivated:true};
  }
  return {access:tier};
}

function restorableStage(_memory:Memory,_nowMs:number,tier:Access):tier is TraceTier {
  if(tier==='clear')return false;
  // No automatic hidden stage exists yet; when one is added, this branch takes its trace window.
  if(tier==='hidden')return false;
  return true;
}
/** Whether the recall trace may restore this record at this clock. The raw authority record goes in. */
export function traceEligible(memory:Memory,nowMs:number):boolean {
  if(memory.accessOverride||memory.access!=='clear'||memory.source.reference||memory.retention?.kind!=='peripheral'||memory.reactivated)return false;
  return restorableStage(memory,nowMs,retainedAccess(memory,nowMs).access);
}

/** One event a cue of the text recalls: its restorable records, and whether the recall jumps to clear. */
export interface CueRecall {event:string;strong:boolean;ids:string[]}

/**
 * The events a cue in the text recalls, in the order of the snapshot. Twins are restored together: a cue of any
 * restorable record of an event recalls all of them. The jump to clear needs two cues of one record (cues are counted
 * per memory); every twin then follows. One fold for the text and one per cue of a restorable record; none without a text.
 */
export function cueRecalls(snapshot:MemorySnapshot,nowMs:number,cueText:string):CueRecall[] {
  const clock=snapshot.memoryTimeMs??nowMs;
  const folded=cueText?foldCue(cueText):'';
  const events=new Map<string,{hit:boolean;strong:boolean;members:string[]}>();
  if(folded)for(const [id,memory] of snapshot.memories){
    if(!currentMemory(snapshot,id,nowMs)||!traceEligible(memory,clock))continue;
    const key=eventKey(memory),group=events.get(key)??{hit:false,strong:false,members:[]};
    const hits=visibleCueHits(memory.retention!.cues,folded);
    if(hits>0)group.hit=true;
    if(hits>=TRACE_STRONG_CUES)group.strong=true;
    group.members.push(id);events.set(key,group);
  }
  const recalls:CueRecall[]=[];
  for(const [event,group] of events)if(group.hit)recalls.push({event,strong:group.strong,ids:group.members});
  return recalls;
}

/**
 * The staged snapshot with the given recalls applied: each of their records moves one stage back from its own stage,
 * or to clear for a strong recall. An id that names no restorable record is left at its stage.
 */
export function restoredSnapshot(snapshot:MemorySnapshot,nowMs:number,recalls:readonly Pick<CueRecall,'strong'|'ids'>[]):MemorySnapshot {
  const clock=snapshot.memoryTimeMs??nowMs;
  const recalled=new Map<string,boolean>();
  for(const recall of recalls)for(const id of recall.ids)recalled.set(id,recall.strong);
  return {...snapshot,memories:new Map([...snapshot.memories].map(([id,memory])=>{
    const result=retainedAccess(memory,clock);
    if(!recalled.has(id)||memory.status!=='accepted'||!traceEligible(memory,clock))return [id,{...memory,access:result.access,...(result.reactivated?{reactivated:true}:{})}];
    return [id,{...memory,access:restoredAccess(result.access as TraceTier,recalled.get(id)!),reactivated:true}];
  }))};
}

/** Use the same effective granularity for retrieval and foreground context. */
export function retentionSnapshot(snapshot:MemorySnapshot,nowMs:number,cueText=''):MemorySnapshot {
  return restoredSnapshot(snapshot,nowMs,cueRecalls(snapshot,nowMs,cueText));
}
