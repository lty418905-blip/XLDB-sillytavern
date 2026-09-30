import type {MemorySnapshot} from './access.ts';

/** Story and per-string language. A string with any CJK code point counts as zh. */
export type StoryLanguage='zh'|'en';

/** A story is English when its accepted memory details carry more than this many Latin letters per CJK code point. */
export const EN_LETTER_RATIO=2;

const CJK=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_ALL=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const COMPACT_DROP=/[\p{P}\p{S}\s]/u;
const EN_WORD=/[\p{L}\p{N}'’-]+/gu;

/** NFKC, lowercase, without punctuation, symbols or whitespace. */
export function compact(value:string):string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu,'');
}

export function hasCJK(value:string):boolean {return CJK.test(value);}

export function scriptOf(value:string):StoryLanguage {return hasCJK(value)?'zh':'en';}

/** zh: CJK code points plus Latin/digit runs; en: words. */
export function units(value:string):number {
  const text=value.normalize('NFKC');
  if(scriptOf(text)==='zh')return (text.match(CJK_ALL)?.length??0)+(text.match(/[A-Za-z0-9]+/g)?.length??0);
  return text.match(EN_WORD)?.length??0;
}

/** Words of an English string with their original UTF-16 offsets. */
export function wordsOf(value:string):{word:string;start:number;end:number}[] {
  return [...value.matchAll(EN_WORD)].map(match=>({word:match[0],start:match.index,end:match.index+match[0].length}));
}

/** Decided once per context from accepted, non-reference memory details; empty stories keep today's zh. */
export function storyLanguageOf(snapshot:Pick<MemorySnapshot,'memories'>):StoryLanguage {
  let han=0,latin=0;
  for(const memory of snapshot.memories.values()){
    if(memory.status!=='accepted'||memory.source.reference)continue;
    han+=memory.detail.match(CJK_ALL)?.length??0;
    latin+=memory.detail.match(/[A-Za-z]/g)?.length??0;
  }
  return latin>EN_LETTER_RATIO*han?'en':'zh';
}

/**
 * A code token in NFKC form with the original UTF-16 range it was read from. `kind` names its rule: letter-digit
 * mixes (i) and digit runs (ii) are matched case-insensitively anywhere; all-caps runs (iii) only as whole all-caps
 * tokens, so a shouted word in the source never masks the ordinary lowercase word.
 */
export type CodeKind='mixed'|'digits'|'caps';
export interface CodeToken {token:string;start:number;end:number;kind:CodeKind}

/**
 * Precise-value tokens: letter-and-digit Latin tokens, digit runs of 4 or more and all-caps runs of 3 or more
 * Latin letters. Capitalised names never qualify. Read after NFKC; ranges point back into the original string.
 */
export function codeTokenRanges(value:string):CodeToken[] {
  const mapped=mappedText(value,{dropPunctuation:false,lower:false});
  const found:CodeToken[]=[];
  const add=(match:RegExpMatchArray,kind:CodeKind)=>found.push({token:match[0],start:mapped.start[match.index!]!,
    end:mapped.end[match.index!+match[0].length-1]!,kind});
  for(const match of mapped.text.matchAll(/[A-Za-z0-9](?:[A-Za-z0-9._/:-]*[A-Za-z0-9])?/g))
    if(/[A-Za-z]/.test(match[0])&&/[0-9]/.test(match[0]))add(match,'mixed');
  for(const match of mapped.text.matchAll(/[0-9]{4,}/g))add(match,'digits');
  for(const match of mapped.text.matchAll(/(?<![A-Za-z])[A-Z]{3,}(?![A-Za-z])/g))add(match,'caps');
  return found.sort((a,b)=>a.start-b.start||b.end-a.end);
}

export function codeTokens(value:string):string[] {return [...new Set(codeTokenRanges(value).map(item=>item.token))];}

/** Numeric runs such as 12.50 or 1,000 with at least two digits, as original ranges (read after NFKC). */
export function numericRanges(value:string):{start:number;end:number}[] {
  const mapped=mappedText(value,{dropPunctuation:false,lower:false});
  return [...mapped.text.matchAll(/[0-9]+(?:[.,][0-9]+)*/g)].filter(match=>(match[0].match(/[0-9]/g)?.length??0)>=2)
    .map(match=>({start:mapped.start[match.index]!,end:mapped.end[match.index+match[0].length-1]!}));
}

/**
 * A normalised view of a string that remembers, for every normalised UTF-16 unit, the original range it came from.
 * Base characters are normalised together with their combining marks so NFKC composition matches compact().
 */
export interface MappedText {text:string;start:number[];end:number[]}

/**
 * Per code point facts, memoised by code point: whether it is a combining mark, and the characters its NFKC form (and
 * the lowercase of that) yields, each with whether compact() drops it. The
 * table is bounded; past the bound entries are computed each time and give the same answer.
 */
type Emitted={char:string;dropCompact:boolean};
type CodePoint={mark:boolean;normal:readonly Emitted[];lower:readonly Emitted[]};
const CODE_POINT_LIMIT=65_536;
const codePoints=new Map<number,CodePoint>();
const emitted=(value:string):Emitted[]=>[...value].map(char=>({char,dropCompact:COMPACT_DROP.test(char)}));
function codePoint(code:number):CodePoint {
  let entry=codePoints.get(code);
  if(entry)return entry;
  const char=String.fromCodePoint(code),normal=char.normalize('NFKC');
  entry={mark:/\p{M}/u.test(char),normal:emitted(normal),lower:emitted(normal.toLowerCase())};
  if(codePoints.size<CODE_POINT_LIMIT)codePoints.set(code,entry);
  return entry;
}

/**
 * `dropPunctuation` removes what compact() removes; `lower` (default) lowercases after NFKC.
 */
export function mappedText(value:string,{dropPunctuation,lower=true}:{dropPunctuation:boolean;lower?:boolean}):MappedText {
  const text:string[]=[],start:number[]=[],end:number[]=[];
  const emit=(items:readonly Emitted[],from:number,to:number)=>{
    for(const item of items){
      if(dropPunctuation&&item.dropCompact)continue;
      text.push(item.char);
      for(let i=0;i<item.char.length;i++){start.push(from);end.push(to);}
    }
  };
  // Clusters as /\P{M}\p{M}*|\p{M}+/u reads them: a base with its combining marks, or a leading run of marks.
  let ahead:CodePoint|undefined;
  for(let index=0;index<value.length;){
    const code=value.codePointAt(index)!,entry=ahead??codePoint(code);
    ahead=undefined;
    let to=index+(code>0xffff?2:1);
    const single=to;
    while(to<value.length){
      const next=value.codePointAt(to)!,nextEntry=codePoint(next);
      if(!nextEntry.mark){ahead=nextEntry;break;}
      to+=next>0xffff?2:1;
    }
    if(to===single)emit(lower?entry.lower:entry.normal,index,to);
    else{
      let normal=value.slice(index,to).normalize('NFKC');
      if(lower)normal=normal.toLowerCase();
      emit(emitted(normal),index,to);
    }
    index=to;
  }
  return {text:text.join(''),start,end};
}
