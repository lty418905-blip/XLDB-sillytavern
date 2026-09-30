import type {Access,Memory,MemorySnapshot} from './access.ts';
import {codeTokenRanges,compact,mappedText,numericRanges,scriptOf,units,wordsOf,type CodeToken} from './text-units.ts';

export const emotionalReactions = {
  joy:'喜悦', gratitude:'感激', affection:'爱意', relief:'如释重负', pride:'自豪',
  sadness:'悲伤', grief:'悲痛', hurt:'委屈', anger:'愤怒', fear:'恐惧',
  worry:'担忧', shame:'羞耻', guilt:'内疚', disappointment:'失望',
  jealousy:'嫉妒', longing:'思念', loneliness:'孤独', disgust:'厌恶', awe:'震撼',
} as const;
export type EmotionalReactionKey=keyof typeof emotionalReactions;
/** Story-language labels for the stored reaction keys (Appendix C; final strings in MR2-final-strings.md for approval). */
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
const ZH_FACT_RUN=6;
const EN_FACT_WORDS=3;
/** A masked remainder needs one intact clause of at least one short sentence; below that it is blocked. */
const ZH_RESIDUAL_UNITS=6;
const EN_RESIDUAL_UNITS=4;
/** Word boundaries for an English protected fact: Latin letters and digits only, so Han text next to it is a boundary. */
const WORD_END=/[\p{Script=Latin}\p{N}]\p{M}*$/u;
const WORD_START=/^[\p{Script=Latin}\p{N}]/u;

/** The single copy guard for faded access; one call per memory layer at projection. */
export function visibleLayer(memory:Pick<Memory,'detail'|'protectedFacts'|MemoryLayer>,layer:MemoryLayer):{text:string;state:LayerState} {
  return maskLayer(memory.detail,memory[layer],memory.protectedFacts);
}

type MaskResult={readonly text:string;readonly state:LayerState};
type DetailEntry={compact:string;tokens:readonly CodeToken[];results:Map<string,MaskResult>};
/**
 * Records are immutable and the guard is pure, so results are memoised by content: detail, then protectedFacts and
 * layer. Every context pass projects each faded memory several times; only the first pass pays for the guard. The
 * cache holds at most GUARD_CACHE_DETAILS details and drops the oldest insertion first. Review R3-3: the bound is a
 * count, not bytes, and entries leave only by eviction; 5,000 details still covers the 2,000-faded-memory scale that
 * R2-2 targeted; the review measured 33 MB at 20,000 audit-length details, so about a quarter of that is expected here.
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
export function maskLayer(detail:string,layer:string,protectedFacts:readonly string[]=[]):MaskResult {
  const entry=detailEntry(detail);
  const key=JSON.stringify(protectedFacts)+LAYER_SEPARATOR+layer;
  let result=entry.results.get(key);
  if(!result){result=Object.freeze(computeMask(entry,layer,protectedFacts));entry.results.set(key,result);}
  return result;
}

const BLOCKED:MaskResult=Object.freeze({text:'',state:'blocked'});

function computeMask(entry:DetailEntry,layer:string,protectedFacts:readonly string[]):MaskResult {
  if(isLegacyTemplate(layer)||!layer.trim())return BLOCKED;
  const compactLayer=compact(layer),compactDetail=entry.compact;
  if(compactLayer===compactDetail||(compactDetail.length>=6&&compactLayer.includes(compactDetail)))return BLOCKED;
  const spans:[number,number][]=[],factSpans:[number,number][]=[];
  const facts=protectedFacts.map(fact=>({fact,compactFact:compact(fact)})).filter(item=>item.compactFact.length>=2);
  if(facts.length){
    const loose=mappedText(layer,{dropPunctuation:true});
    const markLoose=(from:number,to:number)=>factSpans.push([loose.start[from]!,loose.end[to-1]!]);
    for(const {fact,compactFact} of facts){
      const zhFact=scriptOf(fact)==='zh';
      for(let at=loose.text.indexOf(compactFact);at>=0;at=loose.text.indexOf(compactFact,at+1)){
        // An English fact such as "No." matches whole words only, never the inside of "knows nothing".
        if(!zhFact&&!onWordBoundaries(layer,loose.start[at]!,loose.end[at+compactFact.length-1]!))continue;
        markLoose(at,at+compactFact.length);
      }
      if(zhFact){
        for(const [from,to] of sharedRuns([...compactFact],[...loose.text],ZH_FACT_RUN,true))markLoose(from,to);
      }else{
        const layerWords=wordsOf(layer);
        for(const [from,to] of sharedRuns(wordsOf(fact).map(word=>fold(word.word)),layerWords.map(word=>fold(word.word)),EN_FACT_WORDS,false))
          factSpans.push([layerWords[from]!.start,layerWords[to-1]!.end]);
      }
    }
  }
  const tokens=[...entry.tokens,...protectedFacts.flatMap(tokensOf)];
  // Digit-bearing codes (letter-digit mixes, digit runs): every case-insensitive occurrence, even inside A4729 or
  // Rm4729. Known limit (review R2-4, recorded, not changed): the code must appear as written, so a reformatted code
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

/** The original range neither starts nor ends inside a word. */
function onWordBoundaries(layer:string,start:number,end:number):boolean {
  return !WORD_END.test(layer.slice(0,start))&&!WORD_START.test(layer.slice(end));
}

function fold(value:string):string {return value.normalize('NFKC').toLowerCase();}

/**
 * Ranges of `right` covered by a common run with `left` of at least `minimum` items. With `offsets` the ranges
 * are UTF-16 offsets into the joined right text; otherwise item indexes.
 */
export function sharedRuns(left:readonly string[],right:readonly string[],minimum:number,offsets:boolean):[number,number][] {
  const runs:[number,number][]=[];
  let previous=new Array<number>(right.length+1).fill(0);
  for(let i=1;i<=left.length;i++){
    const current=new Array<number>(right.length+1).fill(0);
    for(let j=1;j<=right.length;j++)if(left[i-1]===right[j-1]){
      current[j]=previous[j-1]!+1;
      if(current[j]!>=minimum)runs.push([j-current[j]!,j]);
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
/** The sentence-final marks that state; the only ones restored after a drop (review R4-3). */
const FULL_STOPS=new Set(['。','．','.']);
const PAIRS=new Map([['“','”'],['‘','’'],['「','」'],['『','』'],['（','）'],['(',')'],['【','】'],['《','》'],['[',']'],['"','"'],['\'','\'']]);
/** Bracket pairs whose removal leaves an aside, not a hole in the clause (quotes usually carry an object). */
const ASIDES=new Set(['（','(','【','[']);
/** A removal inside one of these clauses drops the whole clause. The enumeration comma splits clauses here too. */
const CLAUSE_BOUNDARY=new Set([...SEPARATORS,...SENTENCE_FINAL,'\n']);
/** For the residual an enumeration (码头旧书摊、航海日志) is one clause. */
const RESIDUAL_BOUNDARY=/[，,;；:：。．.!！?？…\n]/u;
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
        // Review R4-1: an emptied aside keeps its protected fact, so a fact that filled the brackets starts the drop too.
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
  // is not a dropped clause. A clause emptied by a protected fact does start the drop (review R3-1): the fact often
  // carried the subject and the request verb (Nell asked me to leave the parcel in locker B12, then wait by the ferry).
  // A bracket aside emptied by a protected fact starts the drop as well (review R4-1).
  // Once dropping, the boundaries after the drop go too; only a sentence-final mark that ends the layer comes back,
  // after a kept separator and as a full stop, so 那天风很大，[dropped]。[dropped]。 reads 那天风很大。 and never
  // 那天风很大。。, and 那天风很大，[dropped]？ reads 那天风很大。 (review R4-3).
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
    // Review R4-3: only a full stop comes back. The dropped text's ？！… would turn the kept statement into a question
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
  // A forgotten detail is never a hidden lookup key.  Exact cues may only
  // reactivate when the cue is also present in a currently accessible layer.
  const layers:('gist'|'feeling'|'anchor')[]=age<180*DAY?['gist','feeling','anchor']:['feeling','anchor'];
  const visible=layers.map(layer=>visibleLayer(memory,layer).text);
  if(cueText&&memory.retention.cues.some(cue=>cueText.includes(cue)&&visible.some(layer=>layer.includes(cue))))
    return {access:age<180*DAY?'clear':'gist',reactivated:true};
  return {access:age<180*DAY?'gist':'feeling'};
}

export interface SemanticCue {id:string;cue:string;basis:string;distance:number;margin:number}

/** Use the same effective granularity for retrieval and foreground context. */
export function retentionSnapshot(snapshot:MemorySnapshot,nowMs:number,cueText=''):MemorySnapshot {
  const clock=snapshot.memoryTimeMs??nowMs;
  return {...snapshot,memories:new Map([...snapshot.memories].map(([id,memory])=>{
    const result=retainedAccess(memory,clock,cueText);
    return [id,{...memory,access:result.access,...(result.reactivated?{reactivated:true}:{})}];
  }))};
}
