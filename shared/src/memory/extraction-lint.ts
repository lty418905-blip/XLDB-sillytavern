import type {MemoryCandidate} from '../core/types.ts';
import {cueDropReasons,cueReport,maskLayer,retentionOf,sharedRuns,trimWholeDetailProtectedFacts,type CueDropReason} from './retention.ts';
import {compact,hasCJK,scriptOf,wordsOf,type StoryLanguage} from './text-units.ts';

/**
 * One extraction call. `raw` is the model output (`{memories:[...]}` or the memories array itself, with detailRef);
 * `decoded` holds the memoryOf results in the same order, or null when the batch failed. `detail` is the call's
 * source text, used when a decoded row is missing.
 */
export interface LintCall {
  raw:unknown;
  decoded:readonly MemoryCandidate[]|null;
  detail:string;
  character:{name:string;aliases?:readonly string[]};
  sourceLanguage:StoryLanguage;
}

/** `supplied` counts non-empty layers; `empty` counts empty ones, which the guard treats as blocked (rule 2). */
type LayerCounts={supplied:number;visible:number;masked:number;blocked:number;empty:number};
/**
 * How much of a shown (visible or masked) gist is copied from its detail: the share of the gist's compact characters
 * (zh) or words (en) inside runs shared with the detail of at least 4 characters or 2 words. Report-only; MR7a gates.
 */
export interface OverlapDistribution {count:number;mean:number|null;p50:number|null;p90:number|null;
  buckets:{'0-0.25':number;'0.25-0.5':number;'0.5-0.75':number;'0.75-1':number}}
export interface LintSummary {
  calls:number;
  memories:number;
  cues:{
    supplied:number;kept:number;dropped:Record<CueDropReason,number>;droppedTotal:number;dropRate:number|null;
    peripheral:number;peripheralWithCues:number;
    missingShortCue:{total:number;noneSupplied:number;allDropped:number};missingShortCueRate:number|null;
    retentionInvalid:number;
  };
  /** gistBlockedRate counts an empty gist as supplied and blocked. */
  guard:{gist:LayerCounts;feeling:LayerCounts;anchor:LayerCounts;gistBlockedRate:number|null;gistDetailOverlap:OverlapDistribution};
  language:{enSourceLayers:number;withCJK:number;enLayerRatio:number|null};
  ownName:{layers:number;withName:number;ownNameRate:number|null};
  anchorKeywordList:number;
  protectedFacts:{trimmed:number;dropped:number};
}

function summary():LintSummary {
  const layer=():LayerCounts=>({supplied:0,visible:0,masked:0,blocked:0,empty:0});
  return {calls:0,memories:0,
    cues:{supplied:0,kept:0,dropped:cueReport().dropped,droppedTotal:0,dropRate:null,peripheral:0,peripheralWithCues:0,
      missingShortCue:{total:0,noneSupplied:0,allDropped:0},missingShortCueRate:null,retentionInvalid:0},
    guard:{gist:layer(),feeling:layer(),anchor:layer(),gistBlockedRate:null,
      gistDetailOverlap:{count:0,mean:null,p50:null,p90:null,buckets:{'0-0.25':0,'0.25-0.5':0,'0.5-0.75':0,'0.75-1':0}}},
    language:{enSourceLayers:0,withCJK:0,enLayerRatio:null},
    ownName:{layers:0,withName:0,ownNameRate:null},
    anchorKeywordList:0,protectedFacts:{trimmed:0,dropped:0}};
}

const rate=(part:number,whole:number)=>whole>0?part/whole:null;
const escape=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

function namePatterns(character:LintCall['character']):RegExp[] {
  return [character.name,...(character.aliases??[])].map(name=>name.trim()).filter(Boolean).map(name=>
    // Latin names match on Latin word boundaries, so "Mara带Biscuit" counts and "Tamara" does not.
    hasCJK(name)?new RegExp(escape(name),'iu'):new RegExp(`(?<![\\p{Script=Latin}\\p{N}])${escape(name)}(?![\\p{Script=Latin}\\p{N}])`,'iu'));
}

/** Report-only heuristic: a separator list of at least three items with no verb-like word. */
function keywordListAnchor(anchor:string):boolean {
  if((anchor.match(/[、,，]/g)?.length??0)<2)return false;
  if(/[了过着把被给在]/u.test(anchor))return false;
  return !/\b(?:\w+ed|\w+ing|is|was|were|got|took|gave|made|came|went|saw|had)\b/i.test(anchor);
}

const ZH_OVERLAP_RUN=4,EN_OVERLAP_WORDS=2;
/** Share of the gist copied from the detail (see OverlapDistribution). */
export function gistDetailOverlap(detail:string,gist:string):number {
  if(scriptOf(gist)==='zh'){
    const items=[...compact(gist)];
    if(!items.length)return 0;
    return coverage(sharedRuns([...compact(detail)],items,ZH_OVERLAP_RUN,false),items.length);
  }
  const fold=(value:string)=>wordsOf(value).map(word=>word.word.normalize('NFKC').toLowerCase());
  const words=fold(gist);
  if(!words.length)return 0;
  return coverage(sharedRuns(fold(detail),words,EN_OVERLAP_WORDS,false),words.length);
}

/** Share of item indexes inside at least one run. */
function coverage(runs:readonly [number,number][],length:number):number {
  const covered=new Array<boolean>(length).fill(false);
  for(const [from,to] of runs)for(let index=from;index<to;index++)covered[index]=true;
  return covered.filter(Boolean).length/length;
}

function distribution(values:number[]):OverlapDistribution {
  const sorted=[...values].sort((a,b)=>a-b);
  const pick=(q:number)=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(q*sorted.length))]!:null;
  const buckets={'0-0.25':0,'0.25-0.5':0,'0.5-0.75':0,'0.75-1':0};
  for(const value of sorted)buckets[value<0.25?'0-0.25':value<0.5?'0.25-0.5':value<0.75?'0.5-0.75':'0.75-1']++;
  return {count:sorted.length,mean:sorted.length?sorted.reduce((sum,value)=>sum+value,0)/sorted.length:null,p50:pick(0.5),p90:pick(0.9),buckets};
}

function rawMemories(raw:unknown):unknown[] {
  if(Array.isArray(raw))return raw;
  if(raw&&typeof raw==='object'&&Array.isArray((raw as {memories?:unknown}).memories))return (raw as {memories:unknown[]}).memories;
  return [];
}

/** Pure counters over extraction calls, one summary per source language (card MR2 §5.3). */
export function extractionLint(calls:unknown):{zh:LintSummary;en:LintSummary} {
  if(!Array.isArray(calls))throw new Error('invalid_lint_input');
  const result={zh:summary(),en:summary()};
  const overlaps:{zh:number[];en:number[]}={zh:[],en:[]};
  for(const call of calls as LintCall[]){
    if(!call||typeof call!=='object'||(call.sourceLanguage!=='zh'&&call.sourceLanguage!=='en')||
      typeof call.character?.name!=='string'||typeof call.detail!=='string'||(call.decoded!==null&&!Array.isArray(call.decoded)))
      throw new Error('invalid_lint_input');
    const out=result[call.sourceLanguage];
    out.calls++;
    const names=namePatterns(call.character);
    const raws=rawMemories(call.raw);
    const decoded=call.decoded??[];
    for(const [index,item] of raws.entries()){
      const row=decoded[index];
      const detail=row?.detail??call.detail;
      const retention=item&&typeof item==='object'?(item as Record<string,unknown>).retention:undefined;
      if(retention===undefined)continue;
      const report=cueReport();
      let parsed;
      try{parsed=retentionOf(retention,detail,report);}catch{out.cues.retentionInvalid++;continue;}
      out.cues.supplied+=report.supplied;out.cues.kept+=report.kept;
      for(const reason of cueDropReasons)out.cues.dropped[reason]+=report.dropped[reason];
      if(parsed?.kind!=='peripheral')continue;
      out.cues.peripheral++;
      if(parsed.cues.length)out.cues.peripheralWithCues++;
      if(report.missingShortCue){
        out.cues.missingShortCue.total++;
        if(report.supplied===0)out.cues.missingShortCue.noneSupplied++;else out.cues.missingShortCue.allDropped++;
      }
      const facts=(item as Record<string,unknown>).protectedFacts;
      if(row?.kind==='fact'&&Array.isArray(facts)&&facts.every(fact=>typeof fact==='string')){
        trimWholeDetailProtectedFacts(row.detail,facts as string[],report);
        out.protectedFacts.trimmed+=report.protectedFactsTrimmed;out.protectedFacts.dropped+=report.protectedFactsDropped;
      }
    }
    for(const row of decoded){
      out.memories++;
      for(const layer of ['gist','feeling','anchor'] as const){
        const counts=out.guard[layer];
        if(!row[layer].trim()){counts.empty++;continue;}
        counts.supplied++;
        const guarded=maskLayer(row.detail,row[layer],row.protectedFacts);
        counts[guarded.state]++;
        if(layer==='gist'&&guarded.state!=='blocked')overlaps[call.sourceLanguage].push(gistDetailOverlap(row.detail,guarded.text));
      }
      if(row.anchor&&keywordListAnchor(row.anchor))out.anchorKeywordList++;
      for(const text of [row.gist,row.feeling,row.anchor,row.episode?.appraisal??''].filter(value=>value.trim())){
        out.ownName.layers++;
        if(names.some(pattern=>pattern.test(text)))out.ownName.withName++;
        if(call.sourceLanguage==='en'){
          out.language.enSourceLayers++;
          const withoutNames=names.reduce((value,pattern)=>value.replace(new RegExp(pattern.source,'giu'),''),text);
          if(hasCJK(withoutNames))out.language.withCJK++;
        }
      }
    }
  }
  for(const language of ['zh','en'] as const)result[language].guard.gistDetailOverlap=distribution(overlaps[language]);
  for(const out of Object.values(result)){
    out.cues.droppedTotal=cueDropReasons.filter(reason=>reason!=='cues_malformed').reduce((sum,reason)=>sum+out.cues.dropped[reason],0);
    out.cues.dropRate=rate(out.cues.droppedTotal,out.cues.supplied);
    out.cues.missingShortCueRate=rate(out.cues.missingShortCue.total,out.cues.peripheral);
    out.guard.gistBlockedRate=rate(out.guard.gist.blocked+out.guard.gist.empty,out.guard.gist.supplied+out.guard.gist.empty);
    out.language.enLayerRatio=rate(out.language.enSourceLayers-out.language.withCJK,out.language.enSourceLayers);
    out.ownName.ownNameRate=rate(out.ownName.withName,out.ownName.layers);
  }
  return result;
}
