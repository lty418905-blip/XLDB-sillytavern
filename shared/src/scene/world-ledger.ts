import {foldForMatch, scriptQuoteSearch} from '../common/script-fold.ts';
import {amountExpressionWork,
  type AmountExpression, type QuantityExpression, type RateExpression, type AmountUnit} from '../common/amount-expressions.ts';
import {executeCalculation, replayCalculation, listCalculationLeaves,
  type CalculationExecution, type CalculationTree, type ReferenceValues, type ReferenceValue, type JsonValue} from '../core/calculation-requests.ts';
import type {WorldSettings, WorldSourceEffects, WorldFoldResult, WorldIssue, WorldEffectReceipt, WorldState} from './world-state.ts';

/** Bounds for persisted records and pairwise work; source prose has no length limit. */
export const LEDGER_LIMITS = Object.freeze({entries:64, unbooked:64, accounts:256, rows:256, aliases:8,
  labelCodePoints:40, history:4096, events:16384, jsonNodes:262144, jsonDepth:80, refLength:256, moneyDigits:18,
  // Provisional per-result diagnostic budget; the final slot counts omitted rows.
  diagnostics:1024});
export type LedgerSpan = {start:number; end:number};
export type LedgerRegion = {span:LedgerSpan} | {whole:true};
export type LedgerMark = LedgerRegion & {id:string; kind:'money'|'use'};
export type LedgerMarkPosition = LedgerSpan | {whole:true};
export interface LedgerMarks {contract:4; origin:'model'|'prefilter'|'unavailable'|'code'; money:LedgerMarkPosition[]; math:LedgerMarkPosition[]; use:LedgerMarkPosition[]}
export type LedgerKind = 'purchase'|'income'|'transfer'|'payment'|'refund'|'consume';
export type LedgerEntryKind = LedgerKind|'adjustment';
export type LedgerStatus = 'settled'|'committed'|'quoted';
export type LedgerTime = 'current'|'plan'|'recall'|'hypothetical';
export type LedgerCategory = 'general'|'not_transacted'|'restated'|'unconfigured'|'untracked'|'account_uncertain';
export type LedgerDisposition = 'posted'|'flagged'|'pending'|'unaffordable'|'void';
export type LedgerDoubt = 'payer_unsure'|'account_unsure'|'agency_unsure'|'direction_unsure'|'amount_unsure'
  |'unit_or_total_unsure'|'quantity_unsure'|'item_unsure'|'maybe_restates'|'maybe_not_settled';
export type LedgerRelationKind = 'refund_of'|'balance_of'|'settles'|'restates'|'in_addition_to'|'paired_with';
export interface LedgerSourceRef {sourceId:string; revision:number}
export interface LedgerText extends LedgerSourceRef {role:'user'|'assistant'; text:string; speakerId?:string; replyTo?:{id:string; revision:number}}
export interface LedgerQuote {span:LedgerSpan; quote:string}
export type LedgerParty = {account:string} | {external:LedgerQuote|null}
  | {unconfigured:{kind:'organisation'|'shared'|'private'; label:LedgerQuote|null}};
export type LedgerProposedParty = {account:string} | {external:string|null}
  | {unconfigured:{kind:'organisation'|'shared'|'private'; label:string|null}};
export type LedgerKey = [string,number,LedgerKind,string,string,string,[number,number]|null,string,number] | `user:${string}` | `legacy:${string}`;
export interface LedgerProposedEntry {
  id:string; mark:string; kind:LedgerKind; status:LedgerStatus; time:LedgerTime;
  actor:{id:string; basis:'name'|'self'|'speaker'|'addressee'; quote:string|null}; act:{quote:string}|null;
  payer:LedgerProposedParty|null; payee:LedgerProposedParty|null; receiver?:LedgerProposedParty|null;
  behalf?:{party:LedgerProposedParty; quote:string}|null;
  item?:{quote:string; in:string}|null; quantity?:string|null; amount?:string|null; stated?:string|null; tendered?:string|null; row?:string|null;
  relation?:{kind:LedgerRelationKind; entry:string; quote?:string}|null; doubts:LedgerDoubt[];
}
type NormalizedLedgerProposedEntry = Required<LedgerProposedEntry>;
export type LedgerReading =
  | {type:'amount'; source:LedgerSourceRef; expression:AmountExpression}
  | {type:'quantity'; source:LedgerSourceRef; expression:QuantityExpression}
  | {type:'rate'; source:LedgerSourceRef; expression:RateExpression}
  | {type:'number'; source:LedgerSourceRef; span:LedgerSpan; value:string}
  | {type:'money'; cents:string|bigint; unit:{key:string;display:string}; entry?:LedgerKey}
  | {type:'integer'; count:number; entry?:LedgerKey};
export type LedgerReadings = Readonly<Record<string,LedgerReading>>;
export interface LedgerProofLeaf {
  ref:string; base:string; kind:string; source:LedgerSourceRef|null; span:LedgerSpan|null;
  reading:number|null; endpoint:'min'|'max'|'midpoint'|null; quote:string|null; value:JsonValue;
}
export interface LedgerProof {tree:CalculationTree; leaves:LedgerProofLeaf[]; value:string; dimension:'money'|'quantity'}
export interface LedgerMoney {cents:string; unit:AmountUnit; approx:boolean; exact:boolean; range:{min:string|null;max:string|null}|null; proof:LedgerProof|null}
export interface LedgerQuantity {count:number; approx:boolean; proof:LedgerProof|null; ref:string|null}
export interface LedgerHistory {
  behalf:LedgerParty[]; accountDoubts:boolean; accountConfirm:('a'|'b'|'c')[];
  accountQuestioned?:boolean;
}
export interface LedgerChecks {
  codes:string[]; pending:LedgerCategory[]; returned:string[]; actorGrounded:boolean; explicitParty:boolean;
  first:{amount:string|null; quantity:number|null; payer:string; status:LedgerStatus}; history:LedgerHistory;
  /** Semantic questions returned by this version, with no subsequent proposal yet. */
  unanswered?:string[];
}
export interface StoredLedgerEntry extends LedgerSourceRef {
  key:LedgerKey; mark:LedgerMark; kind:LedgerEntryKind; status:LedgerStatus; time:LedgerTime;
  actor:{id:string|null; basis:'name'|'self'|'speaker'|'addressee'; span:LedgerSpan|null}; act:LedgerSpan|null;
  payer:LedgerParty|null; payee:LedgerParty|null; receiver:LedgerParty|null;
  externalQuotes?:{payer?:LedgerQuote;payee?:LedgerQuote;receiver?:LedgerQuote};
  behalf:{party:LedgerParty; span:LedgerSpan|null; located:boolean}|null;
  item:(LedgerQuote & LedgerSourceRef)|null; quantity:LedgerQuantity|null;
  amount:LedgerMoney|null; stated:LedgerMoney|null; tendered:LedgerMoney|null; row:string|null; unitPrice:string|null;
  relation:{kind:LedgerRelationKind; target:LedgerKey|null; span:LedgerSpan|null}|null;
  doubts:LedgerDoubt[]; checks:LedgerChecks; origin:'model'|'user';
}
export type LedgerUnbookedReason = 'inquiry_or_quote'|'plan_or_recall'|'restates'|'no_money_or_goods'|'not_our_parties'
  |'not_covered'|'stage_cap'|'stage_unavailable'|'stage_interrupted'|'stage_not_configured'|'turn_degraded'
  |'stage_not_available'|'recording'|'entry_dropped'|'entry_withdrawn'|'ledger_record_invalid';
export type LedgerUnbooked = LedgerSourceRef & LedgerRegion & {mark?:string; reason:LedgerUnbookedReason; by:'model'|'code'};
export interface StoredLedger {
  schema:1; contract:number; pin:JsonValue; outcome:'complete'|'partial'|'capped'|'skipped'|'not_run'|'deferred';
  stop?:string; deferred?:JsonValue; entries:StoredLedgerEntry[]; unbooked:LedgerUnbooked[]; facts:JsonValue; trace:JsonValue;
}
export interface LedgerAccountRow {unit:string; opening:string; tracked:boolean; readerIds?:string[]}
export interface LedgerAccountDefinition {
  id:string; kind:'private'|'organisation'|'shared'; label:string; aliases:string[]; actors:string[]; readers:string[];
  rows:LedgerAccountRow[]; items:{item:string;count:number;readerIds?:string[]}[]; status:'active'|'closed';
}
export type LedgerAfter = (LedgerSourceRef & {acceptedAtMs:number}) | null;
export type LedgerAccountEvent = {id:string;seq:number} & (
  | {kind:'create'; account:LedgerAccountDefinition}
  | {kind:'amend'; accountId:string; after:LedgerAfter; changes:{label?:string; aliases?:string[]; actors?:string[]; readers?:string[];
      rows?:{unit:string; opening?:string; tracked?:boolean; remove?:boolean; readerIds?:string[]}[]}}
  | {kind:'close'; accountId:string; after:LedgerAfter});
export interface LedgerUserValues {
  kind:LedgerKind|'adjustment'; payer:string|null; payee:string|null; receiver?:string|null;
  item:string|null; quantity:number|null; cents:string|null; unit:string|null;
  relation?:{kind:LedgerRelationKind;target:LedgerKey};
}
export type LedgerUnbookedAnchor = [string,number,LedgerRegion,LedgerUnbookedReason];
export interface LedgerCorrection {
  sourceId?:string; revision?:number;
  id:string; seq:number; action:'confirm'|'amend'|'post'|'void'|'clear'|'adjustment';
  anchor?:LedgerKey|LedgerUnbookedAnchor; values?:LedgerUserValues; fromMark?:(LedgerRegion & {id:string}); after?:LedgerAfter;
  /** Amount at the anchored version; null identifies the goods-only family. */
  anchorAmount?:string|null;
}
export interface LedgerFoldOptions {accountEvents?:readonly LedgerAccountEvent[]; corrections?:readonly LedgerCorrection[]; nowMs?:number; monotonicFloorMs?:number}
/** Deterministic operation counts; optional counters appear only when their work runs.
 * Paired visits cover <= J(J-1)/2 + 9J steps per proposal (2,592 at J=64), and <= 2E per folded source.
 * J and E are the proposal and source entry counts, each limited to 64 by the ledger contract.
 * Marked amount comparisons count valid unmarked/marked same-source pairs, at most floor(R^2/4)
 * (4,194,304 at R=4,096 readings), and appear only when at least one pair is examined. */
export interface LedgerWork {
    jsonNodes: number;
    text: number;
    scans: number;
    entries: number;
    pairs: number;
    events: number;
    sourceVisits: number;
    rowCopies: number;
    purchaseVisits?: number;
    correctionVisits?: number;
    positionVisits?: number;
    pairedVisits?: number;
    markedAmountComparisons?: number;
}
/** A diagnostic identifies a rejected row; a truncation summary also counts omitted diagnostics. */
export interface LedgerDiagnostic {
  code:string;
  id:string|null;
  index?:number;
  reason?:string;
  omitted?:number;
}
export interface LedgerAccount extends Omit<LedgerAccountDefinition,'rows'|'items'> {
  rows:{unit:string;value:string;tracked:boolean;readerIds:string[]}[];
  items:{item:string;count:number;readerIds:string[]}[];
}
export interface LedgerDetail extends StoredLedgerEntry {
  role:'user'|'assistant'; laterSources:number; disposition:LedgerDisposition; category:LedgerCategory|null; layer:'outer'|'inner';
  codes:string[]; readerIds:string[]; due:string|null; unitPrice:string|null;
  unaffordable:{variant:'self'|'account'|'other'|'user';shortfallCents:string|null;shortfallQuantity:number|null}|null;
  candidates:string[]; causedByCorrection:boolean;
  /** Derived observation permissions for each raw quote; absent metadata discloses no raw quote to characters. */
  quoteReaderIds?:{payer:string[];payee:string[];receiver:string[];item:string[]};
}
export type LedgerUnbookedDetail = LedgerUnbooked & {readerIds:string[];laterSources:number;dismissed:boolean;layer:'outer'|'inner'};
export interface LedgerFold {
  accounts:LedgerAccount[]; entries:LedgerDetail[]; unbooked:LedgerUnbookedDetail[]; unrecordedMarks:number;
  open:{pending:LedgerDetail[];unaffordable:LedgerDetail[];committed:LedgerDetail[];deposits:LedgerDetail[];quoted:LedgerDetail[]};
  director:{unpaid:LedgerDetail[];unposted:LedgerDetail[];committed:LedgerDetail[];unbooked:LedgerUnbookedDetail[]};
  unmatchedVoids:LedgerCorrection[]; unconfigured:{kind:string;label:string|null}[]; diagnostics:LedgerDiagnostic[]; work:LedgerWork;
}
export interface LedgerFact {
  sourceId:string;revision:number;kind:LedgerEntryKind;status:LedgerStatus;time:LedgerTime;actor:string|null;
  item:string|null;quantity:number|null;cents:string|null;unit:string|null;
  payer?:string;payee?:string;receiver?:string;payerQuote?:string;payeeQuote?:string;receiverQuote?:string;due?:string;unaffordable?:LedgerDetail['unaffordable'];
}
export interface LedgerProjection {
  entries:LedgerFact[]; open:{pending:LedgerFact[];unaffordable:LedgerFact[];committed:LedgerFact[];deposits:LedgerFact[];quoted:LedgerFact[]};
}
export type LedgerDecoded<T> = {ok:true;value:T}|{ok:false;code:string};

const KINDS:readonly string[]=['purchase','income','transfer','payment','refund','consume'];
const STATUSES:readonly string[]=['settled','committed','quoted'];
const TIMES:readonly string[]=['current','plan','recall','hypothetical'];
const RELATIONS:readonly string[]=['refund_of','balance_of','settles','restates','in_addition_to','paired_with'];
const DOUBTS:readonly string[]=['payer_unsure','account_unsure','agency_unsure','direction_unsure','amount_unsure','unit_or_total_unsure','quantity_unsure','item_unsure','maybe_restates','maybe_not_settled'];
const SEMANTIC_QUESTIONS:readonly string[]=['act_quote_not_found','actor_not_grounded','act_in_question','actor_not_authorised','possible_duplicate','identical_entries'];
const CATEGORIES:readonly LedgerCategory[]=['not_transacted','restated','unconfigured','general','untracked','account_uncertain'];
const MODEL_UNBOOKED:readonly string[]=['inquiry_or_quote','plan_or_recall','restates','no_money_or_goods','not_our_parties'];
const CODE_UNBOOKED:readonly string[]=['not_covered','stage_cap','stage_unavailable','stage_interrupted','stage_not_configured','turn_degraded','stage_not_available','recording','entry_dropped','entry_withdrawn','ledger_record_invalid'];
const INTEGER=/^(?:0|[1-9]\d*)$/;
const SIGNED_INTEGER=/^-?(?:0|[1-9]\d*)$/;
const DECIMAL=/^(?:0|[1-9]\d*)\.\d{2}$/;
const REF=/^([aqru])([1-9]\d*)(?:#([1-9]\d*)|\.(min|max))?$/;
const MONEY_REF=/^(?:a[1-9]\d*(?:#[1-9]\d*|\.(?:min|max))?|c[1-9]\d*(?:\.(?:min|max))?|e[1-9]\d*\.(?:amount|unitPrice|due)|b:[^\r\n]+:[^:\r\n]+)$/;
const QUANTITY_REF=/^q[1-9]\d*(?:\.(?:min|max))?$/;
const MARK=/^(?:k|y)[1-9]\d*$/;
const WS=/\s/u;
const QUOTE_CLOSE:Readonly<Record<string,string>>={'「':'」','『':'』','“':'”','‘':'’','"':'"',"'":"'"};
const ARRAY_KEY_LENGTH=9;
const MAX_COUNT=Number.MAX_SAFE_INTEGER;
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const safeInt=(v:unknown,min=0):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min;
const textId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=256;
const stringList=(v:unknown,max=256):v is string[]=>Array.isArray(v)&&v.length<=max&&v.every(textId);
const spanOK=(v:unknown):v is LedgerSpan=>record(v)&&safeInt(v.start)&&safeInt(v.end)&&v.start<v.end;
const regionOK=(v:unknown):v is LedgerRegion=>record(v)&&(v.whole===true&&!Object.hasOwn(v,'span')||spanOK(v.span)&&!Object.hasOwn(v,'whole'));
const sourceOK=(v:unknown):v is LedgerSourceRef=>record(v)&&textId(v.sourceId)&&safeInt(v.revision,1);
const centsOK=(v:unknown,signed=false):v is string=>typeof v==='string'&&v.length<=LEDGER_LIMITS.moneyDigits+(signed?1:0)&&(signed?SIGNED_INTEGER:INTEGER).test(v)&&v!=='-0';
const decimalOK=(v:unknown):v is string=>typeof v==='string'&&v.length<=LEDGER_LIMITS.moneyDigits+1&&DECIMAL.test(v);
const labelOK=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&[...v].length<=LEDGER_LIMITS.labelCodePoints;
const addCode=(codes:string[],code:string):void=>{if(!codes.includes(code))codes.push(code);};
const work=():LedgerWork=>({jsonNodes:0,text:0,scans:0,entries:0,pairs:0,events:0,sourceVisits:0,rowCopies:0,purchaseVisits:0});
const identity=(s:LedgerSourceRef):string=>JSON.stringify([s.sourceId,s.revision]);
const assetIdentity=(owner:string,label:string):string=>JSON.stringify([owner,label]);
const keyText=(key:LedgerKey|LedgerUnbookedAnchor):string=>typeof key==='string'?key:JSON.stringify(key);
const overlaps=(a:LedgerSpan,b:LedgerSpan):boolean=>a.start<b.end&&b.start<a.end;
const regionOverlap=(a:LedgerRegion,b:LedgerRegion):boolean=>'whole'in a||'whole'in b||overlaps(a.span,b.span);
const entryRegion=(e:StoredLedgerEntry):LedgerRegion=>e.act?{span:e.act}:('whole'in e.mark?{whole:true}:{span:e.mark.span});
const moneyOf=(e:StoredLedgerEntry):LedgerMoney|null=>e.stated??e.amount;
const unitKey=(u:AmountUnit):string|null=>u===null?null:u.kind==='yuan'?'yuan':foldForMatch(u.word);
const yuan=(label:string):boolean=>['元','圆','块'].includes(foldForMatch(label));
const decimalCents=(value:string):bigint=>BigInt(value.replace('.',''));
const moneyText=(value:bigint):string=>`${value/100n}.${(value%100n).toString().padStart(2,'0')}`;
const posted=(d:LedgerDetail):boolean=>d.disposition==='posted'||d.disposition==='flagged';
const partyAccount=(p:LedgerParty|null):string|null=>p&&'account'in p?p.account:null;
const sameUnit=(a:string,b:string):boolean=>yuan(a)&&yuan(b)||foldForMatch(a)===foldForMatch(b);

/** Read once into detached plain data. Accessors are rejected without invoking them.
 * O(J + sum(k log k)); object key counts are bounded by the JSON node budget. */
function snapshot(value:unknown,bigints=false,w:LedgerWork=work()):unknown {
  const seen=new Set<object>(),startNodes=w.jsonNodes;
  const visit=(v:unknown,depth:number):unknown=>{
    if(++w.jsonNodes-startNodes>LEDGER_LIMITS.jsonNodes)throw new Error('json_node_limit');
    if(depth>LEDGER_LIMITS.jsonDepth)throw new Error('json_depth_limit');
    if(v===null||typeof v==='string'||typeof v==='boolean')return v;
    if(typeof v==='number'&&Number.isFinite(v))return v;
    if(bigints&&typeof v==='bigint')return v;
    if(typeof v!=='object'||seen.has(v as object))throw new Error('non_json_value');
    seen.add(v as object);
    const out:unknown[]|Record<string,unknown>=Array.isArray(v)?[]:{};
    for(const key of Object.keys(v as object).sort()) {
      const d=Object.getOwnPropertyDescriptor(v,key);
      if(!d||!('value'in d))throw new Error('json_accessor');
      Object.defineProperty(out,key,{value:visit(d.value,depth+1),enumerable:true,writable:true,configurable:true});
    }
    if(Array.isArray(v)&&(!Array.isArray(out)||out.length!==v.length||Object.keys(out).length!==v.length))throw 0;
    seen.delete(v as object);return out;
  };
  return visit(value,0);
}
/** O(total JSON nodes). Chat-wide sequences have no node cap; each record keeps
 * its own node/depth budget. Accessors and sparse arrays remain invalid. */
function snapshotSequence(value:unknown,w:LedgerWork,bigints=false):unknown[] {
  if(!Array.isArray(value))throw 0;
  const out:unknown[]=[];
  if(Object.keys(value).length!==value.length)throw 0;
  for(let i=0;i<value.length;i++){
    const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d||!('value'in d))throw 0;
    out.push(snapshot(d.value,bigints,w));
  }
  return out;
}
function snapshotLedger(value:unknown,w:LedgerWork):LedgerFold {
  if(!record(value))throw 0;
  const out:Record<string,unknown>=Object.create(null);
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!('value'in d))throw 0;
    if(['entries','unbooked','unmatchedVoids','diagnostics'].includes(key))out[key]=snapshotSequence(d.value,w);
    else if(key==='open'||key==='director'){
      if(!record(d.value))throw 0;const group:Record<string,unknown>=Object.create(null);
      for(const [name,field] of Object.entries(Object.getOwnPropertyDescriptors(d.value))){
        if(!('value'in field))throw 0;group[name]=snapshotSequence(field.value,w);
      }
      out[key]=group;
    }else out[key]=snapshot(d.value,false,w);
  }
  return out as unknown as LedgerFold;
}
function snapshotContext(value:unknown,w:LedgerWork):unknown {
  if(!record(value))throw 0;
  const out:Record<string,unknown>=Object.create(null);
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!('value'in d))throw 0;
    Object.defineProperty(out,key,{value:key==='before'&&d.value!==null?snapshotLedger(d.value,w):snapshot(d.value,true,w),enumerable:true,writable:true});
  }
  return out;
}
/** O(total JSON nodes), with an independent budget for each historical record. */
function snapshotVerification(value:unknown):unknown {
  if(!record(value))throw 0;
  const out:Record<string,unknown>=Object.create(null),w=work();
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!('value'in d))throw 0;
    out[key]=['entries','previous','accounts'].includes(key)?snapshotSequence(d.value,w):snapshot(d.value,false,w);
  }
  return out;
}
function asJSON(value:unknown):JsonValue {
  if(typeof value==='bigint')return value.toString();
  if(Array.isArray(value))return value.map(asJSON);
  if(record(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,asJSON(value[k])]));
  return value as JsonValue;
}
function decode<T>(raw:unknown,check:(v:unknown)=>boolean,code:string):LedgerDecoded<T> {
  try {const value=snapshot(raw);return check(value)?{ok:true,value:value as T}:{ok:false,code};}catch{return {ok:false,code};}
}
function omitNull(value:Record<string,unknown>,keys:readonly string[]):void {
  for(const key of keys)if(value[key]===null)delete value[key];
}
function quoteOK(v:unknown):boolean {return v===null||record(v)&&spanOK(v.span)&&typeof v.quote==='string';}
function partyOK(v:unknown):v is LedgerParty {
  if(!record(v)||Object.keys(v).length!==1)return false;
  if('account'in v)return textId(v.account);
  if('external'in v)return quoteOK(v.external);
  return record(v.unconfigured)&&['private','organisation','shared'].includes(v.unconfigured.kind as string)&&quoteOK(v.unconfigured.label);
}

function keyOK(decodedObject: unknown): decodedObject is LedgerKey {
    if (typeof decodedObject === 'string')
        return decodedObject.length > 5 && decodedObject.length <= LEDGER_LIMITS.refLength &&
            (decodedObject.startsWith('user:') || decodedObject.startsWith('legacy:'));
    return Array.isArray(decodedObject) && decodedObject.length === ARRAY_KEY_LENGTH &&
        textId(decodedObject[0]) && safeInt(decodedObject[1], 1) && KINDS.includes(decodedObject[2])
        && [3, 4, 5, 7].every(i => typeof decodedObject[i] === 'string' &&
            decodedObject[i].length <= LEDGER_LIMITS.refLength) && (decodedObject[6] === null ||
        Array.isArray(decodedObject[6]) && decodedObject[6].length === 2 && spanOK({
            start: decodedObject[6][0], end: decodedObject[6][1]
        })) && safeInt(decodedObject[8], 1);
}
function proofOK(v:unknown):boolean {
  return v===null||record(v)&&record(v.tree)&&Array.isArray(v.leaves)&&v.leaves.length<=1023&&typeof v.value==='string'
    &&['money','quantity'].includes(v.dimension as string)&&v.leaves.every(l=>record(l)&&typeof l.ref==='string'&&typeof l.base==='string'
      &&typeof l.kind==='string'&&(l.source===null||sourceOK(l.source))&&(l.span===null||spanOK(l.span))
      &&(l.reading===null||safeInt(l.reading,1))&&[null,'min','max','midpoint'].includes(l.endpoint as null|string)
      &&(l.quote===null||typeof l.quote==='string')&&Object.hasOwn(l,'value'));
}
function unitOK(v:unknown):boolean {return v===null||record(v)&&(v.kind==='yuan'||v.kind==='named'&&textId(v.word));}
function moneyOK(v:unknown):v is LedgerMoney {
  return v===null||record(v)&&centsOK(v.cents)&&unitOK(v.unit)&&typeof v.approx==='boolean'&&typeof v.exact==='boolean'&&proofOK(v.proof)
    &&(v.range===null||record(v.range)&&(v.range.min===null||centsOK(v.range.min))&&(v.range.max===null||centsOK(v.range.max)));
}

function storedEntryOK(decodedObject: unknown): decodedObject is StoredLedgerEntry {
    if (record(decodedObject)) {
        omitNull(decodedObject, ['externalQuotes']);
        if (record(decodedObject.externalQuotes))
            omitNull(decodedObject.externalQuotes, ['payer', 'payee', 'receiver']);
        if (record(decodedObject.checks)) {
            omitNull(decodedObject.checks, ['unanswered']);
            if (record(decodedObject.checks.history))
                omitNull(decodedObject.checks.history, ['accountQuestioned']);
        }
    }
    if (!sourceOK(decodedObject) || !record(decodedObject) || !keyOK(decodedObject.key) ||
        !record(decodedObject.mark) || typeof decodedObject.mark.id !== 'string' ||
        decodedObject.mark.id.length > LEDGER_LIMITS.refLength || !['money',
        'use'].includes(decodedObject.mark.kind as string) || !regionOK(decodedObject.mark)
        || !(KINDS.includes(decodedObject.kind as string) || decodedObject.kind === 'adjustment' &&
            decodedObject.origin === 'user') || !STATUSES.includes(decodedObject.status as string) ||
        !TIMES.includes(decodedObject.time as string)
        || !record(decodedObject.actor) || !(decodedObject.actor.id === null ||
        typeof decodedObject.actor.id === 'string' &&
            decodedObject.actor.id.length <= LEDGER_LIMITS.refLength) || !['name', 'self', 'speaker',
        'addressee'].includes(decodedObject.actor.basis as string)
        || !(decodedObject.actor.span === null || spanOK(decodedObject.actor.span)) ||
        !(decodedObject.act === null || spanOK(decodedObject.act))
        || ![decodedObject.payer, decodedObject.payee,
            decodedObject.receiver].every(proposedEntry => proposedEntry === null ||
            partyOK(proposedEntry)) || !['model', 'user'].includes(decodedObject.origin as string))
        return false;
    if (decodedObject.behalf !== null && (!record(decodedObject.behalf) ||
        !partyOK(decodedObject.behalf.party) || !(decodedObject.behalf.span === null ||
        spanOK(decodedObject.behalf.span)) || typeof decodedObject.behalf.located !== 'boolean'))
        return false;
    if (decodedObject.item !== null && (!sourceOK(decodedObject.item) || !quoteOK(decodedObject.item)))
        return false;
    if (decodedObject.quantity !== null && (!record(decodedObject.quantity) ||
        !safeInt(decodedObject.quantity.count, 1) || typeof decodedObject.quantity.approx !== 'boolean' ||
        !proofOK(decodedObject.quantity.proof)
        || !(decodedObject.quantity.ref === null || typeof decodedObject.quantity.ref === 'string')))
        return false;
    if (![decodedObject.amount, decodedObject.stated, decodedObject.tendered].every(moneyOK) ||
        !(decodedObject.row === null || textId(decodedObject.row)) || !(decodedObject.unitPrice === null ||
        centsOK(decodedObject.unitPrice)))
        return false;
    if (decodedObject.relation !== null && (!record(decodedObject.relation) ||
        !RELATIONS.includes(decodedObject.relation.kind as string) ||
        !(decodedObject.relation.target === null || keyOK(decodedObject.relation.target)) ||
        !(decodedObject.relation.span === null || spanOK(decodedObject.relation.span))))
        return false;
    if (decodedObject.externalQuotes !== undefined && (!record(decodedObject.externalQuotes) ||
        !Object.entries(decodedObject.externalQuotes).every(([key, quote]) => ['payer', 'payee',
            'receiver'].includes(key) && quote !== null && quoteOK(quote))))
        return false;
    const storedChecks = decodedObject.checks;
    return Array.isArray(decodedObject.doubts) && decodedObject.doubts.length <= DOUBTS.length &&
        decodedObject.doubts.every(decodedValue => DOUBTS.includes(decodedValue))
        && record(storedChecks) && stringList(storedChecks.codes, 128) &&
        Array.isArray(storedChecks.pending) &&
        storedChecks.pending.every(category => CATEGORIES.includes(category)) &&
        stringList(storedChecks.returned, 128)
        && (storedChecks.unanswered === undefined || stringList(storedChecks.unanswered, 6) &&
            storedChecks.unanswered.every(code => SEMANTIC_QUESTIONS.includes(code)))
        && typeof storedChecks.actorGrounded === 'boolean' &&
        typeof storedChecks.explicitParty === 'boolean' && record(storedChecks.first)
        && (storedChecks.first.amount === null || centsOK(storedChecks.first.amount)) &&
        (storedChecks.first.quantity === null || safeInt(storedChecks.first.quantity, 1)) &&
        typeof storedChecks.first.payer === 'string' &&
        storedChecks.first.payer.length <= LEDGER_LIMITS.refLength &&
        STATUSES.includes(storedChecks.first.status as string)
        && record(storedChecks.history) && Array.isArray(storedChecks.history.behalf) &&
        storedChecks.history.behalf.length <= 64 && storedChecks.history.behalf.every(partyOK)
        && typeof storedChecks.history.accountDoubts === 'boolean' &&
        (storedChecks.history.accountQuestioned === undefined ||
            typeof storedChecks.history.accountQuestioned === 'boolean') &&
        Array.isArray(storedChecks.history.accountConfirm) &&
        storedChecks.history.accountConfirm.every(candidate => ['a', 'b', 'c'].includes(candidate));
}
function unbookedOK(v:unknown):v is LedgerUnbooked {
  if(record(v))omitNull(v,['mark']);
  return sourceOK(v)&&record(v)&&regionOK(v)&&(v.mark===undefined||typeof v.mark==='string'&&MARK.test(v.mark))
    &&(v.by==='model'?MODEL_UNBOOKED.includes(v.reason as string):v.by==='code'&&CODE_UNBOOKED.includes(v.reason as string));
}
/** O(J), capped at 64 entries and 64 unbooked records; never verifies numeric proofs while loading. */
export function decodeLedger(raw:unknown):LedgerDecoded<StoredLedger> {
  return decode(raw,v=>{
    if(!record(v))return false;
    omitNull(v,['stop','deferred']);
    for(const key of ['pin','facts','trace'])if(!Object.hasOwn(v,key))v[key]=null;
    return v.schema===1&&safeInt(v.contract,1)&&['complete','partial','capped','skipped','not_run','deferred'].includes(v.outcome as string)
      &&(v.stop===undefined||typeof v.stop==='string')
      &&Array.isArray(v.entries)&&v.entries.length<=64&&v.entries.every(storedEntryOK)
      &&Array.isArray(v.unbooked)&&v.unbooked.length<=64&&v.unbooked.every(unbookedOK);
  },'ledger_record_invalid');
}
/** O(J); offsets use UTF-16 half-open spans. */
export function decodeLedgerMarks(raw:unknown):LedgerDecoded<LedgerMarks> {
  return decode(raw,v=>record(v)&&v.contract===4&&['model','prefilter','unavailable','code'].includes(v.origin as string)
    &&['money','math','use'].every(k=>Array.isArray(v[k])&&(v[k] as unknown[]).length<=(k==='use'?5:64)&&(v[k] as unknown[]).every(p=>spanOK(p)||record(p)&&p.whole===true)),'ledger_marks_invalid');
}
function afterOK(v:unknown):boolean {return v===null||sourceOK(v)&&record(v)&&safeInt(v.acceptedAtMs);}
function accountOK(v:unknown):boolean {
  if(record(v)){
    omitNull(v,['readers','actors']);
    for(const row of [...(Array.isArray(v.rows)?v.rows:[]),...(Array.isArray(v.items)?v.items:[])])if(record(row))omitNull(row,['readerIds']);
  }
  if(record(v)&&v.readers===undefined&&Array.isArray(v.actors))v.readers=[...v.actors];
  return record(v)&&textId(v.id)&&['private','organisation','shared'].includes(v.kind as string)&&labelOK(v.label)
    &&Array.isArray(v.aliases)&&v.aliases.length<=8&&v.aliases.every(labelOK)&&stringList(v.actors)&&stringList(v.readers)
    &&['active','closed'].includes(v.status as string)&&Array.isArray(v.rows)&&v.rows.length<=256&&v.rows.every(r=>record(r)&&textId(r.unit)&&decimalOK(r.opening)&&typeof r.tracked==='boolean'&&(r.readerIds===undefined||stringList(r.readerIds)))
    &&Array.isArray(v.items)&&v.items.length<=256&&v.items.every(i=>record(i)&&textId(i.item)&&safeInt(i.count)&&(i.readerIds===undefined||stringList(i.readerIds)));
}
/** O(J); account identity/roster and immutable openings are checked at the event's position. */
export function decodeLedgerAccountEvent(raw:unknown):LedgerDecoded<LedgerAccountEvent> {
  return decode(raw,v=>{
    if(!record(v)||!textId(v.id)||!safeInt(v.seq))return false;
    if(v.kind==='create')return accountOK(v.account);
    if(!textId(v.accountId)||!afterOK(v.after))return false;
    if(v.kind==='close')return true;
    const c=v.changes;
    if(record(c)){
      omitNull(c,['label','aliases','actors','readers','rows']);
      for(const r of Array.isArray(c.rows)?c.rows:[])if(record(r))omitNull(r,['opening','tracked','remove','readerIds']);
    }
    return v.kind==='amend'&&record(c)&&Object.keys(c).every(k=>['label','aliases','actors','readers','rows'].includes(k))
      &&(c.label===undefined||labelOK(c.label))&&(c.aliases===undefined||Array.isArray(c.aliases)&&c.aliases.length<=8&&c.aliases.every(labelOK))
      &&(c.actors===undefined||stringList(c.actors))&&(c.readers===undefined||stringList(c.readers))
      &&(c.rows===undefined||Array.isArray(c.rows)&&c.rows.length<=256&&c.rows.every(r=>record(r)&&textId(r.unit)
        &&(r.opening===undefined||decimalOK(r.opening))&&(r.tracked===undefined||typeof r.tracked==='boolean')
        &&(r.remove===undefined||typeof r.remove==='boolean')&&(r.readerIds===undefined||stringList(r.readerIds))));
  },'account_event_invalid');
}
function userValuesOK(v:unknown):v is LedgerUserValues {
  if(record(v)){
    omitNull(v,['receiver','relation']);
    for(const key of ['payer','payee','item','quantity','cents','unit'])if(!Object.hasOwn(v,key))v[key]=null;
  }
  return record(v)&&[...KINDS,'adjustment'].includes(v.kind as string)&&[v.payer,v.payee,v.receiver??null].every(p=>p===null||textId(p))
    &&(v.item===null||textId(v.item))&&(v.quantity===null||safeInt(v.quantity,1))&&(v.cents===null||centsOK(v.cents,v.kind==='adjustment'))
    &&(v.unit===null||textId(v.unit))&&(v.relation===undefined||record(v.relation)&&RELATIONS.includes(v.relation.kind as string)&&keyOK(v.relation.target));
}
function unbookedAnchorOK(v:unknown):v is LedgerUnbookedAnchor {
  return Array.isArray(v)&&v.length===4&&textId(v[0])&&safeInt(v[1],1)&&regionOK(v[2])&&[...MODEL_UNBOOKED,...CODE_UNBOOKED].includes(v[3]);
}
/** O(J); numeric and account-state validation is also available separately for panel writes. */
export function decodeLedgerCorrection(raw:unknown):LedgerDecoded<LedgerCorrection> {
  return decode(raw,v=>{
    if(record(v))omitNull(v,v.action==='adjustment'?['anchor','values','fromMark']:['anchor','values','fromMark','after']);
    return record(v)&&(v.action==='adjustment'||v.action==='clear'&&typeof v.anchor==='string'&&v.anchor.startsWith('user:')||sourceOK(v))&&textId(v.id)&&safeInt(v.seq)&&['confirm','amend','post','void','clear','adjustment'].includes(v.action as string)
    &&(v.anchor===undefined||keyOK(v.anchor)||unbookedAnchorOK(v.anchor))&&(v.values===undefined||userValuesOK(v.values))
    &&(v.anchorAmount===undefined||v.anchorAmount===null||centsOK(v.anchorAmount))
    &&(v.fromMark===undefined||record(v.fromMark)&&MARK.test(v.fromMark.id as string)&&regionOK(v.fromMark))
    &&(v.after===undefined||afterOK(v.after))
    &&(['confirm','amend','post','adjustment'].includes(v.action as string)?userValuesOK(v.values):v.anchor!==undefined)
    &&(['confirm','amend'].includes(v.action as string)?v.anchor!==undefined:true)
    &&(v.action==='adjustment'?v.values!==undefined&&(v.values as LedgerUserValues).kind==='adjustment'&&v.after!==undefined:true);
  },'ledger_correction_invalid');
}

/** Stable JSON for storage; failed validation is an explicit value, never a thrown exception. */
export function serializeLedger(raw: unknown): LedgerDecoded<string> {
    const decoded = decodeLedger(raw);
    // Decode inserts missing nullable fields, so key sorting must happen afterward.
    return decoded.ok ? {
        ok: true, value: JSON.stringify(asJSON(decoded.value))
    } : decoded;
}

function locate(text:string,quote:string|null,w:LedgerWork,region?:LedgerRegion,used:readonly LedgerSpan[]=[]):LedgerQuote|null {
  if(!quote)return null;
  const start=region&&'span'in region?region.span.start:0, end=region&&'span'in region?region.span.end:text.length;
  if(start<0||end>text.length||start>=end)return null;
  const found=scriptQuoteSearch(text.slice(start,end),quote,Math.min(65,used.length+1));w.text+=found.work;
  for(const m of found.matches) {
    const span={start:m.start+start,end:m.end+start};
    if(!used.some(s=>s.start===span.start&&s.end===span.end))return {span,quote:m.quote};
  }
  if(used.length&&found.matches.length===1){const m=found.matches[0]!;return {span:{start:m.start+start,end:m.end+start},quote:m.quote};}
  return null;
}
function partyKey(p:LedgerParty|null):string {
  if(!p)return '';
  if('account'in p)return `a/${p.account}`;
  if('external'in p)return `x/${p.external?foldForMatch(p.external.quote):''}`;
  return `u/${p.unconfigured.kind}/${p.unconfigured.label?foldForMatch(p.unconfigured.label.quote):''}`;
}
function itemKey(e:StoredLedgerEntry):string {return e.item?foldForMatch(e.item.quote):'';}
function leadingKey(e:StoredLedgerEntry):unknown[] {
  return [e.sourceId,e.revision,e.kind,partyKey(e.payer),partyKey(e.payee),partyKey(e.receiver),e.act?[e.act.start,e.act.end]:null,itemKey(e)];
}
function compareNullable(a:string|number|bigint|null,b:string|number|bigint|null):number {
  return a===b?0:a===null?-1:b===null?1:a<b?-1:1;
}
function entryCompare(a:StoredLedgerEntry,b:StoredLedgerEntry):number {
  const fields=(e:StoredLedgerEntry):(string|number|bigint|null)[]=>[moneyOf(e)?BigInt(moneyOf(e)!.cents):null,e.row??unitKey(moneyOf(e)?.unit??null),e.quantity?.count??null,
    e.status,e.time,e.relation?.kind??null,e.relation?.target?keyText(e.relation.target):null,'span'in e.mark?e.mark.span.start:null];
  const x=fields(a),y=fields(b);for(let i=0;i<x.length;i++){const n=compareNullable(x[i]!,y[i]!);if(n)return n;}return 0;
}
/** O(E log E), E <= 64. Existing keys can reserve ordinals without being rewritten. */
function assignKeys(entries:StoredLedgerEntry[],kept:readonly StoredLedgerEntry[]=[]):void {
  const groups=new Map<string,StoredLedgerEntry[]>(),max=new Map<string,number>();
  for(const e of kept)if(Array.isArray(e.key)) {const g=JSON.stringify(e.key.slice(0,8));max.set(g,Math.max(max.get(g)??0,e.key[8]));}
  for(const e of entries){const g=JSON.stringify(leadingKey(e));const list=groups.get(g)??[];list.push(e);groups.set(g,list);}
  for(const [g,list] of groups){list.sort(entryCompare);let n=max.get(g)??0;for(const e of list)e.key=[...leadingKey(e),++n] as LedgerKey;}
}

function readingBase(ref:string):string {const match=REF.exec(ref);return match?`${match[1]}${match[2]}`:ref;}
function referenceValues(readings:LedgerReadings):ReferenceValues {
  const out:Record<string,ReferenceValue>=Object.create(null);
  for(const [ref,r] of Object.entries(readings)) {
    if(r.type==='amount') {
      const e=r.expression,unit=e.unit===null?null:{key:unitKey(e.unit)!,display:e.unit.kind==='yuan'?'元':e.unit.word};
      out[ref]={...e,type:'amount',unit,source:{...r.source,start:e.start,end:e.end}};
    } else if(r.type==='quantity'||r.type==='rate')out[ref]={...r.expression,type:r.type,source:{...r.source,start:r.expression.start,end:r.expression.end}} as ReferenceValue;
    else if(r.type==='number')out[ref]={type:'number',value:r.value,source:{...r.source,start:r.span.start,end:r.span.end}};
    else if(r.type==='money')out[ref]={type:'money',cents:r.cents,unit:r.unit};
    else out[ref]={type:'integer',count:r.count};
  }
  return out;
}
/** The one unit-key adapter used by both stage calculations and proposal validation.
 * O(R + J), at most 4096 references; no text is scanned here. */
export function ledgerReferenceValues(raw:unknown):LedgerDecoded<ReferenceValues> {
  try {const r=snapshot(raw,true);if(!record(r)||Object.keys(r).length>4096)return {ok:false,code:'readings_invalid'};
    return {ok:true,value:referenceValues(r as unknown as LedgerReadings)};
  }catch{return {ok:false,code:'readings_invalid'};}
}
interface ResolvedNumber {money:LedgerMoney|null;quantity:LedgerQuantity|null;leaves:LedgerProofLeaf[];code:string|null}
function quantityPoint(value:string):number|null {
  const [whole,fraction='']=value.split('.');
  if(!whole||!INTEGER.test(whole))return null;
  const point=BigInt(whole)+(fraction[0]&&fraction[0]>='5'?1n:0n);
  return point>0n&&point<=BigInt(MAX_COUNT)?Number(point):null;
}
function resolveNumber(ref:string,readings:LedgerReadings,values:ReferenceValues,state:CalculationExecution,texts:Map<string,LedgerText>,dimension:'money'|'quantity',w:LedgerWork):ResolvedNumber {
  const fail=(code:string):ResolvedNumber=>({money:null,quantity:null,leaves:[],code});
  if(ref.length>256||!(dimension==='money'?MONEY_REF.test(ref):QUANTITY_REF.test(ref)))return fail('unknown_ref');
  const step=executeCalculation({op:'multiply',operands:[ref,'one']},values,state);
  if(!step.result.ok||!step.tree)return fail(!step.result.ok&&step.result.error==='unknown_ref'?'unknown_ref':dimension==='money'?'amount_not_grounded':'quantity_unreadable');
  const replay=replayCalculation(step.tree,values);
  if(!replay.result.ok||!replay.tree||dimension==='money'&&(!replay.result.money||!replay.amounts))return fail(dimension==='money'?'amount_not_grounded':'quantity_unreadable');
  const listed=listCalculationLeaves(replay.tree);
  if(!listed.ok)return fail('amount_not_grounded');
  const leaves:LedgerProofLeaf[]=[];
  for(const leaf of listed.leaves) {
    if(leaf.kind==='one')continue;
    const base=readingBase(leaf.ref),r=Object.hasOwn(readings,base)?readings[base]:undefined,v=Object.hasOwn(values,base)?values[base]:undefined;
    if(!r||!v)return fail('unknown_ref');
    let at:LedgerSpan|null=null,source:LedgerSourceRef|null=null,quote:string|null=null;
    if(r.type==='amount'||r.type==='quantity'||r.type==='rate'||r.type==='number') {
      source=r.source;
      const e=r.type==='number'?r.span:r.expression;
      let end=e.end;
      if(r.type==='amount'&&r.expression.kind==='readings') {
        const reading=r.expression.readings[(leaf.reading??1)-1];
        if(!reading)return fail('amount_not_grounded');end=reading.end;
      }
      at={start:e.start,end};
      const body=texts.get(identity(source));
      if(!body||!spanOK(at)||at.end>body.text.length)return fail('amount_not_grounded');
      quote=body.text.slice(at.start,at.end);
    }
    leaves.push({ref:leaf.ref,base,kind:leaf.kind,source,span:at,reading:leaf.reading,endpoint:leaf.endpoint,quote,value:asJSON(v)});
  }
  w.entries+=listed.leaves.length;
  const proof:LedgerProof={tree:replay.tree,leaves,value:dimension==='money'?replay.amounts!.cents.toString():replay.result.value,dimension};
  if(dimension==='quantity') {
    const count=quantityPoint(replay.result.value);
    return count===null?fail('quantity_unreadable'):{money:null,quantity:{count,approx:replay.result.approx,proof,ref},leaves,code:null};
  }
  if(replay.amounts!.cents<0n)return fail('amount_not_grounded');
  const amountLeaves=listed.leaves.filter(l=>l.dimension==='money');
  const selectedUnit=amountLeaves.find(l=>l.unitKey!==null);
  const unit:AmountUnit=selectedUnit?selectedUnit.unitKey==='yuan'?{kind:'yuan'}:{kind:'named',word:selectedUnit.unit!}:null;
  const range=replay.amounts!.range;
  return {money:{cents:replay.amounts!.cents.toString(),unit,approx:replay.result.approx,exact:replay.result.exact,
    range:range?{min:range.min?.toString()??null,max:range.max?.toString()??null}:null,proof},quantity:null,leaves,code:null};
}
/** Offline provenance check. Each complete source is scanned once per parser, never a saved slice.
 * O(total source length + 1023 tree nodes), with fixed bounded unit vocabulary. */
export function verifyLedgerProof(raw:unknown,rawSources:unknown,rawUnits:unknown):{ok:boolean;mismatches:string[];work:LedgerWork} {
  const w=work(),mismatches:string[]=[];
  try {
    const p=snapshot(raw,false,w) as LedgerProof,sources=snapshot(rawSources) as LedgerText[],units=snapshot(rawUnits) as string[];
    if(!proofOK(p)||!Array.isArray(sources)||!Array.isArray(units)||!stringList(units,256))return {ok:false,mismatches:['proof_invalid'],work:w};
    const bodies=new Map<string,LedgerText>();
    for(const s of sources)if(sourceOK(s)&&typeof s.text==='string')bodies.set(identity(s),s);
    const cache=new Map<string,{amounts:Map<number,AmountExpression>;quantities:Map<number,QuantityExpression>;rates:Map<number,RateExpression>;numbers:Map<number,LedgerSpan>}>();
    const values:Record<string,ReferenceValue>=Object.create(null);
    for(const leaf of p.leaves) {
      let value=leaf.value as unknown as ReferenceValue;
      if(leaf.source) {
        const id=identity(leaf.source),body=bodies.get(id);
        if(!body||!leaf.span){addCode(mismatches,'source_missing');continue;}
        let scans=cache.get(id);
        if(!scans) {
          const a=amountExpressionWork.scanAmounts(body.text,{units}),q=amountExpressionWork.scanQuantities(body.text),r=amountExpressionWork.scanRates(body.text),u=amountExpressionWork.scanNumbers(body.text);
          w.text+=a.work+q.work+r.work+u.work;w.scans+=4;
          scans={amounts:new Map(a.result.map(e=>[e.start,e])),quantities:new Map(q.result.map(e=>[e.start,e])),rates:new Map(r.result.map(e=>[e.start,e])),numbers:new Map(u.result.map(e=>[e.start,e]))};cache.set(id,scans);
        }
        if(body.text.slice(leaf.span.start,leaf.span.end)!==leaf.quote){addCode(mismatches,'source_slice_changed');continue;}
        if(leaf.kind==='number') {
          const e=scans.numbers.get(leaf.span.start);if(!e||e.end!==leaf.span.end)addCode(mismatches,'number_span_changed');
        } else {
          const type=leaf.kind==='amount'?'amount':leaf.kind==='quantity'?'quantity':'rate';
          const e=type==='amount'?scans.amounts.get(leaf.span.start):type==='quantity'?scans.quantities.get(leaf.span.start):scans.rates.get(leaf.span.start);
          if(!e){addCode(mismatches,'expression_missing');continue;}
          const selectedEnd=type==='amount'&&e.kind==='readings'?(e as AmountExpression&{kind:'readings'}).readings[(leaf.reading??1)-1]?.end:e.end;
          if(selectedEnd!==leaf.span.end){addCode(mismatches,'selection_changed');continue;}
          value=referenceValues({[leaf.base]:{type,expression:e,source:leaf.source} as LedgerReading})[leaf.base]!;
        }
      }
      if(Object.hasOwn(values,leaf.base)&&JSON.stringify(asJSON(values[leaf.base]))!==JSON.stringify(asJSON(value)))addCode(mismatches,'leaf_value_conflict');
      values[leaf.base]=value;
    }
    const replay=replayCalculation(p.tree,values);
    if(!replay.result.ok)addCode(mismatches,'replay_failed');
    else if(p.dimension==='money'?(!replay.result.money||replay.amounts?.cents.toString()!==p.value):quantityPoint(replay.result.value)!==quantityPoint(p.value))addCode(mismatches,'value_changed');
    return {ok:mismatches.length===0,mismatches,work:w};
  }catch{return {ok:false,mismatches:['proof_invalid'],work:w};}
}

export interface LedgerProposalContext {
  source:LedgerText; previous:LedgerText[]; marks:LedgerMark[]; readings:LedgerReadings; calculations:CalculationExecution;
  settings:WorldSettings; accounts:LedgerAccount[]; before:LedgerFold|null; state?:LedgerProposalState; entryRefs?:Record<string,LedgerKey>;keptEntries?:StoredLedgerEntry[];
}
/** One checked entry; returnedCodes contains only questions newly returned by this call, in order. */
export interface LedgerCheckedEntry {
  id:string;
  verdict:'returned'|'settled'|'flagged'|'accepted';
  codes:string[];
  returnedCodes:string[];
  read:Record<string,JsonValue>;
  entry:StoredLedgerEntry;
}
export interface LedgerProposalState {
  history:{id:string;mark:string;act:LedgerSpan|null;checks:LedgerChecks}[];
  returned:Record<string,string[]>; previous:{id:string;verdict:LedgerCheckedEntry['verdict'];entry:StoredLedgerEntry}[];
  everAccepted:{id:string;entry:StoredLedgerEntry}[]; withdrawalAsked:boolean; awaitingWithdrawal:string[]; confirmedWithdrawn:string[];
}
export interface LedgerProposalResult {
  entries:LedgerCheckedEntry[]; unbooked:LedgerUnbooked[]; uncovered:string[]; settled:boolean; withdrawn:string[];
  withdrawalReturned:boolean; state:LedgerProposalState; work:LedgerWork; error?:string;
}
function emptyProposalState():LedgerProposalState {return {history:[],returned:{},previous:[],everAccepted:[],withdrawalAsked:false,awaitingWithdrawal:[],confirmedWithdrawn:[]};}
function proposedPartyOK(v:unknown):boolean {
  return v===null||record(v)&&Object.keys(v).length===1&&('account'in v?textId(v.account):'external'in v?v.external===null||typeof v.external==='string':record(v.unconfigured)
    &&['private','organisation','shared'].includes(v.unconfigured.kind as string)&&(v.unconfigured.label===null||typeof v.unconfigured.label==='string'));
}
function proposedEntryOK(v:unknown):v is NormalizedLedgerProposedEntry {
  if(!record(v)||!textId(v.id)||typeof v.mark!=='string'||!KINDS.includes(v.kind as string)||!STATUSES.includes(v.status as string)||!TIMES.includes(v.time as string)
    ||!record(v.actor)||!textId(v.actor.id)||!['name','self','speaker','addressee'].includes(v.actor.basis as string)||(v.actor.quote!==null&&typeof v.actor.quote!=='string')
    ||!(v.act===null||record(v.act)&&typeof v.act.quote==='string')||![v.payer,v.payee,v.receiver??null].every(proposedPartyOK)
    ||!(v.behalf===null||record(v.behalf)&&v.behalf.party!==null&&proposedPartyOK(v.behalf.party)&&typeof v.behalf.quote==='string')
    ||!(v.item===null||record(v.item)&&typeof v.item.quote==='string'&&typeof v.item.in==='string')
    ||![v.quantity,v.amount,v.stated,v.tendered,v.row].every(x=>x===null||typeof x==='string')
    ||!(v.relation===null||record(v.relation)&&RELATIONS.includes(v.relation.kind as string)&&typeof v.relation.entry==='string'&&(v.relation.quote==null||typeof v.relation.quote==='string'))
    ||!Array.isArray(v.doubts)||v.doubts.length>DOUBTS.length||!v.doubts.every(d=>DOUBTS.includes(d)))return false;
  if(v.kind==='refund'&&(!v.relation||v.relation.kind!=='refund_of'))return false;
  if(v.kind==='consume')return v.item!==null&&v.quantity!==null&&v.amount===null&&v.stated===null&&v.tendered===null;
  return v.amount!==null||v.relation?.kind==='paired_with';
}
/** Optional whole-call boundary for the stage's tool adapter. O(J), <= 64 entries. */
export function decodeLedgerProposal(raw:unknown):LedgerDecoded<{entries:unknown[];unbooked:{mark:string;reason:string}[]}> {
  return decode(raw,v=>record(v)&&Array.isArray(v.entries)&&v.entries.length<=64&&Array.isArray(v.unbooked)&&v.unbooked.length<=64
    &&v.unbooked.every(u=>record(u)&&typeof u.mark==='string'&&MODEL_UNBOOKED.includes(u.reason as string)),'call_malformed');
}
function resolveParty(p:LedgerProposedParty|null,text:string,w:LedgerWork):LedgerParty|null {
  if(!p)return null;
  if('account'in p)return {account:p.account};
  if('external'in p)return {external:locate(text,p.external,w)};
  return {unconfigured:{kind:p.unconfigured.kind,label:locate(text,p.unconfigured.label,w)}};
}
function defaultChecks():LedgerChecks {return {codes:[],pending:[],returned:[],actorGrounded:false,explicitParty:false,
  first:{amount:null,quantity:null,payer:'',status:'settled'},history:{behalf:[],accountDoubts:false,accountConfirm:[]}};}
function fallbackEntry(source:LedgerText,mark:LedgerMark):StoredLedgerEntry {
  return {sourceId:source.sourceId,revision:source.revision,key:[source.sourceId,source.revision,'payment','','','',null,'',1],mark,
    kind:'payment',status:'settled',time:'current',actor:{id:null,basis:'name',span:null},act:null,payer:null,payee:null,receiver:null,
    behalf:null,item:null,quantity:null,amount:null,stated:null,tendered:null,row:null,unitPrice:null,relation:null,doubts:[],checks:defaultChecks(),origin:'model'};
}
function accountLabelsPresent(account:LedgerAccount,text:string,w:LedgerWork):boolean {
  return [account.label,...account.aliases].some(name=>locate(text,name,w)!==null);
}
function knownActorLabels(settings:WorldSettings,id:string):readonly string[] {return id==='player'?[settings.playerName]:(Object.hasOwn(settings.actorLabels,id)?settings.actorLabels[id]!:[]);}
function partyExplicit(p:LedgerParty|null,e:StoredLedgerEntry,c:LedgerProposalContext,w:LedgerWork):boolean {
  if(!p||partyAccount(p)!==null&&partyAccount(p)===e.actor.id||e.behalf&&partyKey(p)===partyKey(e.behalf.party))return false;
  if('account'in p){const a=c.accounts.find(a=>a.id===p.account);return !!a&&accountLabelsPresent(a,c.source.text,w);}
  return 'external'in p?p.external!==null:p.unconfigured.label!==null;
}
// One pass for quote nesting; replacing quoted text preserves every UTF-16 offset.
function outsideQuotes(text:string,w:LedgerWork):string {
  const stack:string[]=[],out:string[]=[];
  for(const ch of text){w.text++;const last=stack.at(-1);if(last===ch){stack.pop();out.push(' '.repeat(ch.length));continue;}
    const close=Object.hasOwn(QUOTE_CLOSE,ch)?QUOTE_CLOSE[ch]:undefined;if(close){stack.push(close);out.push(' '.repeat(ch.length));continue;}out.push(stack.length?' '.repeat(ch.length):ch);}
  return out.join('');
}
function questionAct(text:string,act:LedgerSpan,w:LedgerWork):boolean {
  const last=text[act.end-1];if(last==='?'||last==='？')return true;
  for(let at=act.end;at<text.length;at++){w.text++;const ch=text[at]!;if(/[，。！？、；：,;:.!?…]/u.test(ch))return ch==='?'||ch==='？';}return false;
}
function pending(c:LedgerChecks,category:LedgerCategory):void {if(!c.pending.includes(category))c.pending.push(category);}
/** Bounded 64-entry cross-row comparison; each six-code-point window is fixed.
 * Number parsing visits at most the window's candidates, O(total source text). */
function checkQuantityWindows(entries:StoredLedgerEntry[],texts:Map<string,LedgerText>,
  scans:Map<string,{quantities:QuantityExpression[];numbers:LedgerSpan[]}>,w:LedgerWork):void {
  const used=new Map<string,LedgerSpan[]>();
  const quantityStarts=new Map<string,Map<number,QuantityExpression[]>>();
  for(const [key,scan] of scans){const starts=new Map<number,QuantityExpression[]>();
    for(const q of scan.quantities){const list=starts.get(q.start)??[];list.push(q);starts.set(q.start,list);w.pairs++;}quantityStarts.set(key,starts);}
  for(const e of entries)for(const proof of [e.quantity?.proof,e.amount?.proof,e.stated?.proof,e.tendered?.proof])for(const leaf of proof?.leaves??[]){
    if(!leaf.source||!leaf.span)continue;const key=identity(leaf.source),list=used.get(key)??[];list.push(leaf.span);used.set(key,list);
  }
  for(const e of entries)if(e.quantity?.ref==='one'&&e.item){
    const key=identity(e.item),body=texts.get(key);if(!body)continue;
    let left=e.item.span.start,right=e.item.span.end;
    for(let n=0;n<6&&left>0;n++){left--;if(left>0&&body.text.charCodeAt(left)>=0xdc00&&body.text.charCodeAt(left)<=0xdfff)left--;}
    for(let n=0;n<6&&right<body.text.length;n++)right+=(body.text.codePointAt(right)!>0xffff?2:1);
    for(const n of scans.get(key)?.numbers??[]){w.pairs++;
      if(!overlaps(n,{start:left,end:right})||(used.get(key)??[]).some(s=>s.start<=n.start&&s.end>=n.end))continue;
      const parsed=amountExpressionWork.parseQuantity(body.text.slice(n.start,n.end)),q=parsed.result;w.text+=parsed.work;
      const candidates=(quantityStarts.get(key)?.get(n.start)??[]).filter(q=>q.end>=n.end);
      if(q?.kind==='exact'&&q.count===1&&candidates.every(q=>q.kind==='exact'&&q.count===1))continue;
      addCode(e.checks.codes,'quantity_assumed_one');break;
    }
  }
}
function shapeParties(e:StoredLedgerEntry):boolean {
  const internal=(p:LedgerParty|null)=>!!p&&('account'in p||'unconfigured'in p),any=(p:LedgerParty|null)=>p!==null;
  switch(e.kind){case 'purchase':case 'payment':return internal(e.payer)&&any(e.payee);
    case 'income':return any(e.payer)&&internal(e.payee);
    case 'transfer':return internal(e.payer)&&internal(e.payee)&&(partyAccount(e.payer)!==null||partyAccount(e.payee)!==null);
    case 'refund':return any(e.payer)&&any(e.payee)&&(internal(e.payer)||internal(e.payee));
    case 'consume':return partyAccount(e.payer)!==null&&e.payee===null;case 'adjustment':return false;}
}
function availableCandidates(e:StoredLedgerEntry,accounts:readonly LedgerAccount[],other=false):string[] {
  const ids=new Set<string>();
  const payer=partyAccount(e.payer);if(payer)ids.add(payer);
  for(const a of accounts)if(a.status==='active'&&a.kind!=='private'&&e.actor.id!==null&&a.actors.includes(e.actor.id))ids.add(a.id);
  for(const p of e.checks.history.behalf){const id=partyAccount(p);if(id&&accounts.some(a=>a.id===id))ids.add(id);}
  if(other)ids.add('other');return [...ids];
}

function staticEntry(proposedEntry: NormalizedLedgerProposedEntry, proposalContext: LedgerProposalContext, used:
    Map<string, LedgerSpan[]>, texts: Map<string, LedgerText>, values: ReferenceValues, scans: Map<string, {
    quantities: QuantityExpression[];
    numbers: LedgerSpan[];
}>, outside: string, ledgerWork: LedgerWork): {
    entry: StoredLedgerEntry;
    returns: string[];
    sourceActExhausted: boolean;
} {
    const mark = proposalContext.marks.find(candidateMark => candidateMark.id === proposedEntry.mark) ?? {
        id: 'k0', kind: 'money' as const, whole: true as const
    };
    const storedEntry = fallbackEntry(proposalContext.source, mark);
    const checks = storedEntry.checks;
    const returns: string[] = [];
    const flag = (code: string) => addCode(checks.codes, code);
    const ret = (code: string, category?:
        LedgerCategory) => {
        flag(code);
        addCode(returns, code);
        if (category)
            pending(checks, category);
    };
    storedEntry.kind = proposedEntry.kind;
    storedEntry.status = proposedEntry.status;
    storedEntry.time = proposedEntry.time;
    storedEntry.doubts = [...new Set(proposedEntry.doubts)];
    for (const decodedValue of storedEntry.doubts)
        flag(decodedValue);
    if (mark.id === 'k0')
        ret('unknown_mark');
    const occupied = used.get(proposedEntry.mark) ?? [];
    const markedAct = locate(proposalContext.source.text, proposedEntry.act?.quote ?? null, ledgerWork, mark, occupied);
    const presentMarkedAct = markedAct
        ?? locate(proposalContext.source.text, proposedEntry.act?.quote ?? null, ledgerWork, mark);
    const act = presentMarkedAct ?? locate(proposalContext.source.text, proposedEntry.act?.quote ?? null, ledgerWork);
    // The locator permits one unique quote to be reused; that still exhausts its occurrence here.
    const sourceActExhausted = proposedEntry.status === 'settled' && Boolean(presentMarkedAct)
        && (!markedAct || occupied.some(span =>
            span.start === markedAct.span.start && span.end === markedAct.span.end));

    if (act) {
        storedEntry.act = act.span;
        occupied.push(act.span);
        used.set(proposedEntry.mark, occupied);
    }
    if (sourceActExhausted) {
        ret('identical_entries', 'restated');
        flag('identical_in_source');
    }
    if (proposedEntry.status === 'settled' && !presentMarkedAct) {
        ret('act_quote_not_found', 'not_transacted');
        if (!act)
            flag('no_transaction_act');
    }
    const actorQuote = locate(proposalContext.source.text, proposedEntry.actor.quote, ledgerWork);
    storedEntry.actor = {
        id: proposedEntry.actor.id, basis: proposedEntry.actor.basis, span: actorQuote?.span ?? null
    };
    const labels = knownActorLabels(proposalContext.settings, proposedEntry.actor.id);
    if (!labels.length)
        storedEntry.actor.id = null;
    checks.actorGrounded = labels.length > 0 && (proposedEntry.actor.basis === 'name' ? !!actorQuote &&
        labels.some(label => foldForMatch(label) === foldForMatch(actorQuote.quote)) :
        proposedEntry.actor.id === 'player' &&
            (proposedEntry.actor.basis === 'self' ? proposalContext.source.role === 'user' && !!actorQuote &&
                actorQuote.quote.includes('我') :
                proposedEntry.actor.basis === 'speaker' ? proposalContext.source.role === 'user' &&
                    proposedEntry.actor.quote === null : proposalContext.source.role === 'assistant' &&
                    !!actorQuote && ['你', '妳', '您'].includes(actorQuote.quote)));
    storedEntry.payer = resolveParty(proposedEntry.payer, proposalContext.source.text, ledgerWork);
    storedEntry.payee = resolveParty(proposedEntry.payee, proposalContext.source.text, ledgerWork);
    storedEntry.receiver = proposedEntry.receiver == null ? storedEntry.payer : resolveParty(proposedEntry.receiver,
        proposalContext.source.text, ledgerWork);
    if (proposedEntry.behalf) {
        const locatedQuote = locate(proposalContext.source.text, proposedEntry.behalf.quote, ledgerWork);
        storedEntry.behalf = {
            party: resolveParty(proposedEntry.behalf.party, proposalContext.source.text, ledgerWork)!,
            span: locatedQuote?.span ?? null, located: locatedQuote !== null
        };
        if (!locatedQuote) {
            ret('behalf_quote_not_found');
            flag('agency_unverified');
        }
    }
    // Storage normalization must not turn the acting account into an explicit other party.
    checks.explicitParty = [storedEntry.payer, storedEntry.payee,
        storedEntry.receiver].some(candidate => partyExplicit(candidate, {
        ...storedEntry, actor: {
            ...storedEntry.actor, id: proposedEntry.actor.id
        }
    }, proposalContext, ledgerWork));
    if (!checks.actorGrounded) {
        ret('actor_not_grounded');
        if (act && checks.explicitParty)
            flag('owner_weak');
        else {
            pending(checks, 'not_transacted');
            flag('owner_not_grounded');
        }
    }
    if (act && questionAct(proposalContext.source.text, act.span, ledgerWork)) {
        flag('act_in_question');
        if (proposalContext.source.role === 'assistant') {
            ret('act_in_question', 'not_transacted');
            flag('question_sentence');
        }
    }
    if (actorQuote && !locate(outside, proposedEntry.actor.quote, ledgerWork))
        flag('actor_in_quote');
    if (proposedEntry.item) {
        const body = [proposalContext.source,
            ...proposalContext.previous].find(candidate => candidate.sourceId === proposedEntry.item!.in);
        const locatedQuote = body ? locate(body.text, proposedEntry.item.quote, ledgerWork) : null;
        if (body && locatedQuote)
            storedEntry.item = {
                sourceId: body.sourceId, revision: body.revision, ...locatedQuote
            };
        else {
            ret('item_quote_not_found');
            flag('item_unverified');
        }
    }
    const qtyResult = proposedEntry.quantity &&
        proposedEntry.quantity !== 'one' ? resolveNumber(proposedEntry.quantity, proposalContext.readings, values,
            proposalContext.calculations, texts, 'quantity', ledgerWork) : null;
    const qty = proposedEntry.quantity === 'one' ? {
        count: 1, approx: false, proof: null, ref: 'one'
    } : qtyResult?.quantity ?? null;
    if (proposedEntry.quantity !== null) {
        storedEntry.quantity = qty ?? {
            count: 1, approx: false, proof: null, ref: proposedEntry.quantity
        };
        if (!qty) {
            ret(qtyResult?.code ?? 'quantity_unreadable');
            flag('quantity_assumed_one');
        }
    }
    if (storedEntry.quantity?.approx)
        flag('quantity_approximate');
    const resolved: ResolvedNumber[] = [];
    for (const field of ['amount', 'stated', 'tendered'] as const)
        if (proposedEntry[field] !== null) {
            const resolvedNumber = resolveNumber(proposedEntry[field]!, proposalContext.readings, values, proposalContext
                .calculations, texts, 'money', ledgerWork);
            resolved.push(resolvedNumber);
            storedEntry[field] = resolvedNumber.money;
            if (resolvedNumber.code) {
                ret(resolvedNumber.code, 'general');
                flag('amount_unreadable');
            }
        }
    for (const ledgerRow of resolved)
        for (const leaf of ledgerRow.leaves) {
            if (leaf.reading !== null && leaf.reading !== 1)
                flag('reading_ambiguous');
            if (leaf.kind !== 'amount' || !leaf.source || !leaf.span)
                continue;
            const body = texts.get(identity(leaf.source))!;
            if (storedEntry.item && identity(storedEntry.item) === identity(leaf.source) &&
                leaf.span.end <= storedEntry.item.span.start && foldForMatch(body.text.slice(leaf.span.start, leaf
                    .span.end)).endsWith('块')
                && [...body.text.slice(leaf.span.end, storedEntry.item.span.start)].every(ch => WS.test(ch)))
                flag('kuai_before_item');
        }
    const amount = moneyOf(storedEntry);
    if (amount?.approx)
        flag('amount_approximate');
    if ([storedEntry.amount, storedEntry.stated, storedEntry.tendered].some(ledgerAccount => ledgerAccount &&
        !ledgerAccount.exact))
        flag('rounded');
    if (storedEntry.amount && storedEntry.stated && storedEntry.amount.cents !== storedEntry.stated.cents)
        flag('stated_differs');
    if (amount && amount.proof?.leaves.filter(l => ['amount', 'entry_amount',
        'balance'].includes(l.kind)).every(l => l.kind === 'amount' && record(l.value) && l.value.unit === null))
        flag('no_unit_word');
    if (proposedEntry.status !== 'settled') {
        flag('not_settled');
        pending(checks, 'not_transacted');
    }
    if (proposedEntry.time !== 'current') {
        flag('non_current');
        pending(checks, 'not_transacted');
    }
    if (!shapeParties(storedEntry))
        ret('party_shape', 'general');
    storedEntry.row = proposedEntry.row;
    if (proposedEntry.relation)
        storedEntry.relation = {
            kind: proposedEntry.relation.kind, target: null, span: locate(proposalContext.source.text, proposedEntry
                .relation.quote ?? null, ledgerWork)?.span ?? null
        };
    const matching = proposalContext.state?.history.filter(h => h.id === proposedEntry.id ||
        h.mark === proposedEntry.mark && h.act !== null && storedEntry.act !== null && overlaps(h.act, storedEntry
            .act)) ?? [];
    for (const h of matching) {
        for (const historicalParty of h.checks.history.behalf)
            if (!checks.history.behalf.some(candidate => partyKey(candidate) === partyKey(historicalParty)))
                checks.history.behalf.push(historicalParty);
        checks.history.accountDoubts ||= h.checks.history.accountDoubts;
        if (h.checks.history.accountQuestioned ||
            h.checks.returned.some(code => code === 'actor_not_authorised' || code === 'payer_account_confirm'))
            checks.history.accountQuestioned = true;
        for (const candidate of h.checks.history.accountConfirm)
            if (!checks.history.accountConfirm.includes(candidate))
                checks.history.accountConfirm.push(candidate);
    }
    if (storedEntry.behalf &&
        !checks.history.behalf.some(candidate => partyKey(candidate) === partyKey(storedEntry.behalf!.party)))
        checks.history.behalf.push(storedEntry.behalf.party);
    checks.history.accountDoubts ||= storedEntry.doubts.some(decodedValue => ['payer_unsure',
        'account_unsure', 'agency_unsure'].includes(decodedValue));
    const ownPayer = proposalContext.accounts.find(ledgerAccount => ledgerAccount.id === partyAccount(storedEntry
        .payer) && ledgerAccount.kind === 'private' && ledgerAccount.id === storedEntry.actor.id);
    if (ownPayer) {
        if (checks.history.behalf.some(historicalParty => partyKey(historicalParty) !== partyKey(storedEntry.payer))
            && !checks.history.accountConfirm.includes('a'))
            checks.history.accountConfirm.push('a');
        if (checks.history.accountDoubts && !checks.history.accountConfirm.includes('b'))
            checks.history.accountConfirm.push('b');
        if (storedEntry.actor.id !== null &&
            proposalContext.accounts.some(ledgerAccount => ledgerAccount.status === 'active' &&
                ledgerAccount.kind !== 'private' && ledgerAccount.actors.includes(storedEntry.actor.id!)) &&
            !checks.history.accountConfirm.includes('c'))
            checks.history.accountConfirm.push('c');
        if (checks.history.accountConfirm.length) {
            ret('payer_account_confirm');
            if (checks.history.accountConfirm.some(candidate => candidate === 'a' || candidate === 'b'))
                flag('private_payer_kept');
        }
    }
    checks.first = matching.find(h => h.id === proposedEntry.id)?.checks.first ?? {
        amount: amount?.cents ?? null, quantity: storedEntry.quantity?.count ?? null,
        payer: partyKey(storedEntry.payer), status: storedEntry.status
    };
    if (checks.first.amount !== (amount?.cents ?? null) ||
        checks.first.quantity !== (storedEntry.quantity?.count ?? null) ||
        checks.first.payer !== partyKey(storedEntry.payer))
        flag('changed_after_return');
    return {
        entry: storedEntry, returns, sourceActExhausted
    };
}
type AmountConfirmationRule = {direct: boolean; overlapping: 'confirm' | 'unlessContains'};

// Keep the direct column explicit so each marker's two policies can change independently.
// The comma containment exception is provisional until usage data is available.
const AMOUNT_CONFIRMATION_RULES = {
    known: new Map<string, AmountConfirmationRule>([
        ['one', {direct: true, overlapping: 'confirm'}],
        ['two', {direct: true, overlapping: 'confirm'}],
        ['acrossWhitespace', {direct: true, overlapping: 'confirm'}],
        ['beforeYenSign', {direct: true, overlapping: 'confirm'}],
        ['beforeFullWidthComma', {direct: true, overlapping: 'unlessContains'}],
        ['beforeClockPoint', {direct: true, overlapping: 'confirm'}]
    ]),
    unknown: {direct: true, overlapping: 'confirm'} satisfies AmountConfirmationRule
};

function amountComparisonShape(
    reading: LedgerReading | undefined
): reading is Extract<LedgerReading, {type: 'amount'}> {
    if (reading?.type !== 'amount' || !record(reading.source) || !record(reading.expression)) return false;

    const {source, expression} = reading;
    return typeof source.sourceId === 'string' && Number.isSafeInteger(source.revision)
        && Number.isSafeInteger(expression.start) && Number.isSafeInteger(expression.end)
        && expression.start >= 0 && expression.start < expression.end;
}

/** Index only detached readings. Each unmarked base is compared once to valid same-source markers.
 * With U unmarked and M marked readings, comparisons are <= U*M <= floor(R^2/4),
 * or 4,194,304 at the existing R=4,096 table limit, regardless of proof leaf duplication. */
function checkMarkedAmountReferences(
    rows: {entry: StoredLedgerEntry; returns: string[]}[],
    readings: LedgerReadings,
    ledgerWork: LedgerWork
): void {
    const markers = new Map<string, string>();
    const bySource = new Map<string, Extract<LedgerReading, {type: 'amount'}>[]>();
    for (const [base, reading] of Object.entries(readings)) {
        const marker = markedAmountValue(reading);
        if (marker === null) continue;

        markers.set(base, marker);
        if (!amountComparisonShape(reading)) continue;

        const key = identity(reading.source);
        const candidates = bySource.get(key) ?? [];
        candidates.push(reading);
        bySource.set(key, candidates);
    }
    if (!markers.size) return;

    const confirmed = new Map<string, boolean>();
    for (const row of rows) {
        for (const money of [row.entry.amount, row.entry.stated, row.entry.tendered]) {
            for (const leaf of money?.proof?.leaves ?? []) {
                if (leaf.kind !== 'amount') continue;

                const confirm = markedLeafConfirmation(leaf, readings, markers, bySource, confirmed, ledgerWork);
                if (!confirm) continue;

                addCode(row.entry.checks.codes, 'amount_left_numeral_confirm');
                addCode(row.returns, 'amount_left_numeral_confirm');
            }
        }
    }
}

/** Cache a detached amount leaf's confirmation by candidate, not by reference spelling.
 * Visit every valid same-source marker, even after a match, to keep the work count exact. */
function markedLeafConfirmation(
    leaf: LedgerProofLeaf,
    readings: LedgerReadings,
    markers: Map<string, string>,
    bySource: Map<string, Extract<LedgerReading, {type: 'amount'}>[]>,
    confirmed: Map<string, boolean>,
    ledgerWork: LedgerWork
): boolean {
    let confirm = confirmed.get(leaf.base);
    if (confirm !== undefined) return confirm;

    const marker = markers.get(leaf.base);
    confirm = false;
    if (marker !== undefined) {
        confirm = (AMOUNT_CONFIRMATION_RULES.known.get(marker) ?? AMOUNT_CONFIRMATION_RULES.unknown).direct;
    } else {
        const reading = Object.hasOwn(readings, leaf.base) ? readings[leaf.base] : undefined;
        if (amountComparisonShape(reading)) {
            for (const candidate of bySource.get(identity(reading.source)) ?? []) {
                ledgerWork.markedAmountComparisons = (ledgerWork.markedAmountComparisons ?? 0) + 1;
                if (!overlaps(reading.expression, candidate.expression)) continue;

                const rule = AMOUNT_CONFIRMATION_RULES.known.get(markedAmountValue(candidate)!)
                    ?? AMOUNT_CONFIRMATION_RULES.unknown;
                const contains = reading.expression.start <= candidate.expression.start
                    && reading.expression.end >= candidate.expression.end;
                if (rule.overlapping === 'confirm' || !contains) confirm = true;
            }
        }
    }
    confirmed.set(leaf.base, confirm);
    return confirm;
}

function leftQuantityAllowed(marker: string | null, start: number, quantityStart: number): boolean {
    // Inline markers set aside exactly one or two UTF-16 code units; comma and clock have no left bound.
    switch (marker) {
        case 'one': return quantityStart === start - 1;
        case 'two': return quantityStart === start - 2;
        case 'beforeFullWidthComma':
        case 'beforeClockPoint': return quantityStart < start;
        default: return false;
    }
}

function markedAmountValue(reading: LedgerReading | undefined): string | null {
    if (reading?.type !== 'amount' || !record(reading.expression)) return null;

    const marker = reading.expression.setAsideLeftNumerals;
    return typeof marker === 'string' ? marker : null;
}

/** Each money leaf visits each same-source quantity once, including quantities later allowed.
 * A count becomes a referenced quantity only when a proposal row uses it as one. */
function checkAmountOverlaps(
    rows: {entry: StoredLedgerEntry; returns: string[]}[],
    readings: LedgerReadings,
    scans: Map<string, {quantities: QuantityExpression[]; numbers: LedgerSpan[]}>,
    ledgerWork: LedgerWork
): void {
    const references = new Map<string, {entry: StoredLedgerEntry; span: LedgerSpan}[]>();
    for (const {entry} of rows) {
        const ref = entry.quantity?.ref;
        const reading = ref && QUANTITY_REF.test(ref) && Object.hasOwn(readings, readingBase(ref))
            ? readings[readingBase(ref)] : undefined;
        if (!entry.quantity?.proof && reading?.type === 'quantity' && spanOK(reading.expression)) {
            const key = identity(reading.source);
            const list = references.get(key) ?? [];
            list.push({entry, span: {start: reading.expression.start, end: reading.expression.end}});
            references.set(key, list);
        }

        for (const proof of [entry.quantity?.proof, entry.amount?.proof, entry.stated?.proof, entry.tendered?.proof]) {
            for (const leaf of proof?.leaves ?? []) {
                if (leaf.kind !== 'quantity' || !leaf.source || !leaf.span) continue;

                const key = identity(leaf.source);
                const list = references.get(key) ?? [];
                list.push({entry, span: leaf.span});
                references.set(key, list);
            }
        }
    }

    const block = (row: {entry: StoredLedgerEntry; returns: string[]}, own: boolean) => {
        const code = own ? 'span_double_use' : 'amount_not_grounded';
        addCode(row.entry.checks.codes, code);
        pending(row.entry.checks, 'general');
        addCode(row.returns, code);
        if (!own) addCode(row.entry.checks.codes, 'amount_unreadable');
    };
    for (const row of rows) {
        for (const money of [row.entry.amount, row.entry.stated, row.entry.tendered]) {
            for (const leaf of money?.proof?.leaves ?? []) {
                if (leaf.kind !== 'amount' || !leaf.source || !leaf.span) continue;

                const key = identity(leaf.source);
                const reading = Object.hasOwn(readings, leaf.base) ? readings[leaf.base] : undefined;
                const expression = reading?.type === 'amount' ? reading.expression : null;
                const shortest = expression?.kind === 'readings'
                    ? Math.min(...expression.readings.map(candidate => candidate.end)) : expression?.end;
                const marker = markedAmountValue(reading);
                const direct = (references.get(key) ?? []).filter(reference => overlaps(leaf.span!, reference.span)
                    && !(scans.get(key)?.quantities ?? []).some(quantity => overlaps(quantity, reference.span)));
                // References not found by scanning keep their original treatment.
                if (direct.length) block(row, direct.some(reference => reference.entry === row.entry));

                for (const quantity of scans.get(key)?.quantities ?? []) {
                    ledgerWork.pairs++;
                    if (!overlaps(leaf.span, quantity)) continue;

                    const referenced = (references.get(key) ?? []).filter(reference =>
                        overlaps(reference.span, quantity));
                    if (!referenced.length && expression && quantity.end <= shortest! &&
                        (quantity.start >= expression.start ||
                            leftQuantityAllowed(marker, expression.start, quantity.start))) {
                        continue;
                    }
                    block(row, referenced.some(reference => reference.entry === row.entry));
                }
            }
        }
    }
}

export interface LedgerMutableBalance {ownerId:string;unit:string;cents:bigint;readerIds:Set<string>;tracked?:boolean}
export interface LedgerMutableInventory {ownerId:string;item:string;count:number;readerIds:Set<string>}
export interface LedgerMutableState {timeMs:number;balances:Map<string,LedgerMutableBalance>;inventory:Map<string,LedgerMutableInventory>}
interface LedgerLegs {money:{row:LedgerMutableBalance;delta:bigint}[];goods:{owner:string;item:string;delta:number;row:LedgerMutableInventory|undefined}[]}
interface BookIndex {
  keys:Map<string,LedgerDetail>;sources:Map<string,LedgerDetail[]>;refunds:Map<string,{cents:bigint;quantity:number}>;
}
interface VerifyContext {
  accounts:LedgerAccount[];source:LedgerText;previous:LedgerText[];counterpart:string|null;index:BookIndex;
  state:LedgerMutableState;work:LedgerWork;forced:boolean;mode:'proposal'|'fold';readers:string[];
  quoteReaderIds?:LedgerDetail['quoteReaderIds'];
  /** Only a resolved mutual pair's leader skips relation checks in a batch. */
  pairedLeader?:boolean;
  /** Canonical targets voided under their own source; fold-local and never persisted. */
  voidedRestatementTargets?: Set<string>;
}
interface Evaluated {detail:LedgerDetail;legs:LedgerLegs;returns:string[]}
function emptyIndex():BookIndex {return {keys:new Map(),sources:new Map(),refunds:new Map()};}
function indexDetail(index:BookIndex,d:LedgerDetail):void {
  index.keys.set(keyText(d.key),d);const id=identity(d),list=index.sources.get(id)??[];list.push(d);index.sources.set(id,list);
  if(posted(d)&&d.relation?.kind==='refund_of'&&d.relation.target){const key=keyText(d.relation.target),old=index.refunds.get(key)??{cents:0n,quantity:0};
    old.cents+=BigInt(moneyOf(d)?.cents??'0');old.quantity+=d.quantity?.count??0;index.refunds.set(key,old);}
}
function accountRow(a:LedgerAccount|undefined,row:string|null):LedgerAccount['rows'][number]|undefined {
  if(!a||row===null)return undefined;
  const exact=a.rows.find(r=>r.unit===row);if(exact)return exact;
  const matches=a.rows.filter(r=>sameUnit(r.unit,row));return matches.length===1?matches[0]:undefined;
}
function inventoryRow(state:LedgerMutableState,id:string|null,item:string|null):LedgerMutableInventory|undefined {
  if(!id||!item)return undefined;
  const exact=state.inventory.get(assetIdentity(id,item));if(exact)return exact;
  const folded=foldForMatch(item);let found:LedgerMutableInventory|undefined;
  for(const row of state.inventory.values())if(row.ownerId===id&&foldForMatch(row.item)===folded){if(found)return undefined;found=row;}
  return found;
}
function resolveConfigured(p:LedgerParty|null,accounts:LedgerAccount[]):LedgerParty|null {
  if(!p||!('unconfigured'in p)||!p.unconfigured.label)return p;
  const label=foldForMatch(p.unconfigured.label.quote),matches=accounts.filter(a=>a.status==='active'&&a.kind===p.unconfigured.kind
    &&[a.label,...a.aliases].some(n=>foldForMatch(n)===label));
  return matches.length===1?{account:matches[0]!.id}:p;
}
function matchingTransaction(a:StoredLedgerEntry,b:StoredLedgerEntry,comparePayer=true):boolean {
  if(a.kind!==b.kind||comparePayer&&partyKey(a.payer)!==partyKey(b.payer))return false;
  const x=itemKey(a),y=itemKey(b),am=moneyOf(a),bm=moneyOf(b);
  return !!x&&!!y&&(x===y||x.includes(y)||y.includes(x))||am!==null&&bm!==null&&am.cents===bm.cents;
}
function categoryOf(categories:readonly LedgerCategory[]):LedgerCategory|null {return CATEGORIES.find(c=>categories.includes(c))??null;}
function outerDetail(d:LedgerDetail):boolean {
  return d.disposition==='unaffordable'||d.disposition==='pending'&&['general','unconfigured','account_uncertain'].includes(d.category??'')
    ||d.category==='not_transacted'&&(d.role==='user'||d.checks.first.status==='settled'&&d.status==='committed')
    ||d.codes.some(c=>['identical_in_source','private_payer_kept','duplicate_of_user_entry','overlaps_voided_entry'].includes(c));
}
function moneyUnitWords(e:StoredLedgerEntry):AmountUnit[] {
  const m=moneyOf(e);if(!m)return [];
  if(!m.proof)return m.unit?[m.unit]:[];
  return m.proof.leaves.filter(l=>['amount','entry_amount','balance'].includes(l.kind)).map(l=>{
    if(!record(l.value)||!record(l.value.unit))return null;
    return l.value.unit.key==='yuan'?{kind:'yuan' as const}:{kind:'named' as const,word:l.value.unit.display as string};
  }).filter((u):u is Exclude<AmountUnit,null>=>u!==null);
}
function selectCurrency(e:StoredLedgerEntry,account:LedgerAccount|undefined):{row:string|null;codes:string[]} {
  if(!moneyOf(e))return {row:e.row,codes:[]};
  if(!account||!account.rows.length)return {row:e.row??(moneyOf(e)!.unit?.kind==='named'?(moneyOf(e)!.unit as {kind:'named';word:string}).word:moneyOf(e)!.unit?'元':null),codes:[]};
  const units=moneyUnitWords(e),keys=new Set(units.map(unitKey)),codes:string[]=[];
  if(keys.size>1)return {row:null,codes:['unit_conflict']};
  const word=units[0],chosen=e.row!==null?accountRow(account,e.row):undefined;
  if(word) {
    const matched=account.rows.filter(r=>word.kind==='yuan'?yuan(r.unit):foldForMatch(r.unit)===foldForMatch(word.word));
    if(e.row!==null&&!chosen)return {row:null,codes:['currency_not_configured']};
    if(chosen&&!matched.includes(chosen))return {row:null,codes:['unit_conflict']};
    if(!matched.length)return {row:null,codes:['currency_not_configured']};
    if(matched.length>1&&!chosen)return {row:null,codes:['currency_ambiguous']};
    return {row:(chosen??matched[0])!.unit,codes};
  }
  if(e.row!==null) {
    if(!chosen)return {row:null,codes:['currency_not_configured']};
    if(account.rows.length>1)codes.push('currency_assumed');return {row:chosen.unit,codes};
  }
  if(account.rows.length!==1)return {row:null,codes:[account.rows.length?'currency_ambiguous':'currency_not_configured']};
  return {row:account.rows[0]!.unit,codes};
}
function behalfMatches(p:LedgerParty,a:LedgerAccount):boolean {const id=partyAccount(p);return id===a.id||id!==null&&a.actors.includes(id);}

function affordability(storedEntry: StoredLedgerEntry, ledgerAccount: LedgerAccount | undefined, proposalContext:
    VerifyContext): 'self' | 'account' | 'other' | null {
    if (storedEntry.actor.id === null || !ledgerAccount || ledgerAccount.status !== 'active' ||
        storedEntry.checks.history.accountDoubts || storedEntry.checks.history.accountQuestioned ||
        storedEntry.checks.codes.includes('actor_not_authorised') ||
        storedEntry.checks.codes.includes('owner_weak') ||
        storedEntry.checks.codes.includes('account_basis_weak') ||
        storedEntry.checks.returned.some(code => code === 'actor_not_authorised' ||
            code === 'payer_account_confirm') ||
        storedEntry.checks.history.behalf.some(proposedEntry => !behalfMatches(proposedEntry, ledgerAccount)))
        return null;
    if (ledgerAccount.kind === 'private' && ledgerAccount.id === storedEntry.actor.id &&
        !proposalContext.accounts.some(candidate => candidate.kind !== 'private' &&
            candidate.status === 'active' && candidate.actors.includes(storedEntry.actor.id!)))
        return 'self';
    if (ledgerAccount.kind !== 'private' && ledgerAccount.actors.includes(storedEntry.actor.id))
        return 'account';
    if (ledgerAccount.id === storedEntry.actor.id || ledgerAccount.actors.includes(storedEntry.actor.id))
        return null;
    if (accountLabelsPresent(ledgerAccount, proposalContext.source.text, proposalContext.work))
        return 'other';
    if (ledgerAccount.kind !== 'private' && ledgerAccount.actors.some(id => id !== storedEntry.actor.id &&
        proposalContext.accounts.some(candidate => candidate.id === id && accountLabelsPresent(candidate,
            proposalContext.source.text, proposalContext.work))))
        return 'other';
    return null;
}

function verifyEntry(originalStoredEntry: StoredLedgerEntry, proposalContext: VerifyContext): Evaluated {
    const storedEntry: StoredLedgerEntry = {
        ...originalStoredEntry, payer: resolveConfigured(originalStoredEntry.payer, proposalContext.accounts),
        payee: resolveConfigured(originalStoredEntry.payee, proposalContext.accounts),
        receiver: resolveConfigured(originalStoredEntry.receiver, proposalContext.accounts)
    };
    const codes = proposalContext.forced ? [] : [...storedEntry.checks.codes];
    const categories = proposalContext.forced ? [] : [...storedEntry.checks.pending];
    const returns: string[] = [];
    const decodedValue: LedgerDetail = {
        ...storedEntry, role: proposalContext.source.role, laterSources: 0, disposition: 'posted',
        category: null, layer: 'inner', codes, readerIds: [...proposalContext.readers], due: null,
        unitPrice: storedEntry.unitPrice,
        unaffordable: null, candidates: [], causedByCorrection: false,
        ...(proposalContext.quoteReaderIds ? { quoteReaderIds: proposalContext.quoteReaderIds } : {})
    };
    const legs: LedgerLegs = {
        money: [], goods: []
    };
    const flag = (code: string) => addCode(codes, code);
    const pend = (code: string, category: LedgerCategory = 'general',
        returned = true) => {
        flag(code);
        if (!categories.includes(category))
            categories.push(category);
        if (returned)
            addCode(returns, code);
    };
    const account = (proposedEntry: LedgerParty | null) => proposalContext.accounts.find(ledgerAccount =>
        ledgerAccount.id === partyAccount(proposedEntry));
    const payer = account(storedEntry.payer);
    const payee = account(storedEntry.payee);
    const receiver = account(storedEntry.receiver);
    const target = storedEntry.relation?.target ? proposalContext.index.keys.get(keyText(storedEntry.relation
        .target)) : undefined;
    if (!proposalContext.forced) {
        for (const code of storedEntry.checks.unanswered ?? [])
            pend(code, code === 'possible_duplicate' ||
                code === 'identical_entries' ? 'restated' : code === 'actor_not_authorised' ? 'general' :
                    'not_transacted', false);
        for (const party of [storedEntry.payer, storedEntry.payee, storedEntry.receiver,
            storedEntry.behalf?.party ?? null]) {
            const id = partyAccount(party);
            if (id !== null) {
                const ledgerAccount = proposalContext.accounts.find(ledgerAccount => ledgerAccount.id === id);
                if (!ledgerAccount || ledgerAccount.status === 'closed')
                    pend('unknown_account');
            }
        }
        if ([storedEntry.payer, storedEntry.payee,
            storedEntry.receiver].some(proposedEntry => proposedEntry && 'unconfigured' in proposedEntry))
            pend('unconfigured_account', 'unconfigured', false);
        const currency = selectCurrency(storedEntry, storedEntry.kind === 'income' ? payee : payer ?? payee);
        decodedValue.row = currency.row;
        for (const code of currency.codes)
            if (code === 'currency_assumed')
                flag(code);
            else
                pend(code);
        if (['purchase', 'payment', 'transfer'].includes(storedEntry.kind) && payer &&
            (storedEntry.actor.id === null || !payer.actors.includes(storedEntry.actor.id))
            && !(storedEntry.behalf?.located && behalfMatches(storedEntry.behalf.party, payer))) {
            if (payer.kind === 'private' && proposalContext.mode === 'proposal' &&
                !storedEntry.checks.returned.includes('actor_not_authorised'))
                pend('actor_not_authorised');
            else
                flag('actor_not_authorised');
            storedEntry.checks.history.accountQuestioned = true;
        }
        if (payer && payer.kind !== 'private' && !storedEntry.behalf?.located && ![proposalContext.source,
            ...proposalContext.previous].some(currentSource => accountLabelsPresent(payer, currentSource.text,
                proposalContext.work)))
            flag('account_basis_weak');
        if (storedEntry.relation?.kind !== 'in_addition_to' && storedEntry.status === 'settled' &&
            proposalContext.counterpart) {
            const other = (proposalContext.index.sources.get(proposalContext.counterpart) ?? []).find(targetEntry => {
                proposalContext.work.pairs++;

                return posted(targetEntry) && matchingTransaction(storedEntry, targetEntry);
            });
            if (other) {
                if (proposalContext.mode === 'proposal' && !storedEntry.checks.returned.includes('possible_duplicate'))
                    pend('possible_duplicate', 'restated');
                else
                    flag('possible_duplicate');
            }
        }
        if (storedEntry.relation && !proposalContext.pairedLeader) {
            const relationKind = storedEntry.relation.kind;
            const relationTarget = storedEntry.relation.target;
            // The fold prepares the anchor set once. Each restatement needs at most one Set lookup.
            // A present, live target always takes precedence over a historical void anchor.
            const restatesVoidedTarget = proposalContext.mode === 'fold' && relationKind === 'restates'
                && relationTarget !== null && (target?.disposition === 'void'
                    || !target && proposalContext.voidedRestatementTargets?.has(keyText(relationTarget)) === true);
            if (restatesVoidedTarget) {
                pend('restates', 'restated', false);
                pend('restates_voided_entry', 'restated', false);
            }
            else if (!target || target.disposition === 'void') {
                if (proposalContext.mode === 'fold' && storedEntry.relation.target !== null) {
                    if (relationKind === 'refund_of' || relationKind === 'balance_of')
                        pend('relation_target_changed');
                    else if (relationKind === 'paired_with')
                        pend('relation_invalid');
                    else if (relationKind === 'settles' || relationKind === 'in_addition_to'
                        || relationKind === 'restates')
                        flag('relation_target_changed');
                }
                else
                    pend('relation_invalid');
            }
            else if (relationKind === 'restates')
                pend('restates', 'restated', false);
            else if (relationKind === 'refund_of') {
                if (!['purchase', 'payment'].includes(target.kind) || !posted(target) ||
                    typeof target.key === 'string' && target.key.startsWith('legacy:'))
                    pend('relation_invalid');
                const direction = (refundParty: LedgerParty | null, originalParty: LedgerParty | null) =>
                    refundParty !== null && originalParty !== null &&
                    ('account' in originalParty ? 'account' in refundParty &&
                        refundParty.account === originalParty.account : 'external' in originalParty
                            ? 'external' in refundParty : 'unconfigured' in refundParty);
                if (!direction(storedEntry.payer, target.payee) || !direction(storedEntry.payee, target.payer))
                    pend('refund_direction');
                const used = proposalContext.index.refunds.get(keyText(target.key)) ?? {
                    cents: 0n, quantity: 0
                };
                if (BigInt(moneyOf(storedEntry)?.cents ?? '0') > BigInt(moneyOf(target)?.cents ?? '0') - used.cents
                    || (storedEntry.quantity?.count ?? 0) > (target.quantity?.count ?? 0) - used.quantity)
                    pend('refund_exceeds');
            }
            else if (relationKind === 'balance_of' && target.kind !== 'payment' || relationKind === 'settles' &&
                target.status !== 'committed' && target.disposition !== 'pending'
                || relationKind === 'in_addition_to' && storedEntry.relation.span === null
                || relationKind === 'paired_with' &&
                moneyOf(storedEntry) === null && !posted(target))
                pend('relation_invalid');
        }
    }
    const moneyValue = moneyOf(storedEntry);
    const amount = moneyValue ? BigInt(moneyValue.cents) : null;
    if (amount !== null)
        for (const [ledgerAccount, sign] of [[payer, -1n], [payee, 1n]] as const) {
            const ledgerRow = accountRow(ledgerAccount, decodedValue.row), row = ledgerRow ? proposalContext.state
                .balances.get(assetIdentity(ledgerAccount!.id, ledgerRow.unit)) : undefined;
            if (row && row.tracked !== false && ledgerAccount?.status === 'active')
                legs.money.push({
                    row, delta: amount * sign
                });
        }
    let giver: LedgerAccount | undefined;
    let recipient: LedgerAccount | undefined;
    let item = storedEntry.item?.quote ?? null;
    const quantity = storedEntry.quantity?.count ?? 0;
    if (storedEntry.kind === 'consume')
        giver = payer;
    else if (storedEntry.kind === 'refund' && target) {
        giver = proposalContext.accounts.find(ledgerAccount => ledgerAccount.id === partyAccount(target.receiver));
        recipient = proposalContext.accounts.find(ledgerAccount => ledgerAccount.id === partyAccount(target.payee));
        item = target.item?.quote ?? item;
    }
    else if (storedEntry.kind === 'purchase' || storedEntry.kind === 'income') {
        giver = payee;
        recipient = receiver;
    }
    else if (storedEntry.kind === 'transfer' || storedEntry.kind === 'refund') {
        giver = payer;
        recipient = receiver;
    }
    const out = inventoryRow(proposalContext.state, giver?.id ?? null, item);
    const incoming = inventoryRow(proposalContext.state, recipient?.id ?? null, item);
    if (item && quantity > 0) {
        if (out && giver?.status === 'active')
            legs.goods.push({
                owner: giver.id, item: out.item, delta: -quantity, row: out
            });
        if (recipient?.status === 'active' && (incoming || recipient.rows.length + recipient.items.length > 0))
            legs.goods.push({
                owner: recipient.id, item: incoming?.item ?? item, delta: quantity, row: incoming
            });
    }
    if (!proposalContext.forced) {
        if (storedEntry.kind === 'consume' && !out)
            pend('unregistered_item', 'untracked', false);
        else if (!legs.money.length && !legs.goods.length)
            pend('untracked', 'untracked', false);
        else if (!legs.money.length && legs.goods.length && amount !== null)
            flag('payer_untracked');
    }
    decodedValue.category = categoryOf(categories);
    if (decodedValue.category)
        decodedValue.disposition = 'pending';
    if (proposalContext.mode === 'fold') {
        if (!decodedValue.readerIds.length) {
            if (!proposalContext.forced)
                flag('no_observer');
            decodedValue.readerIds = [...new Set([storedEntry.actor.id,
                    ...(partyAccount(storedEntry.payer) === 'player' ? ['player'] : [])])].filter((id):
                        id is string => id !== null && proposalContext.accounts.some(ledgerAccount => ledgerAccount
                        .kind === 'private' && ledgerAccount.id === id)).sort();
        }
        if (!decodedValue.category) {
            const fail = (ledgerAccount: LedgerAccount | undefined, cents: bigint | null, count: number | null):
                void => {
                if (proposalContext.forced) {
                    decodedValue.causedByCorrection = true;
                    flag('caused_by_correction');
                    decodedValue.disposition = 'unaffordable';
                    decodedValue.unaffordable = {
                        variant: 'user', shortfallCents: cents?.toString() ?? null, shortfallQuantity: count
                    };
                    flag(cents !== null ? 'insufficient_funds' : 'insufficient_inventory');
                    return;
                }
                // Grounding flags found during this fold also participate in account uncertainty.
                const variant = codes.includes('account_basis_weak') ? null : affordability(storedEntry,
                    ledgerAccount, proposalContext);
                if (variant) {
                    decodedValue.disposition = 'unaffordable';
                    decodedValue.unaffordable = {
                        variant, shortfallCents: cents?.toString() ?? null, shortfallQuantity: count
                    };
                    flag(cents !== null ? 'insufficient_funds' : 'insufficient_inventory');
                }
                else {
                    decodedValue.disposition = 'pending';
                    decodedValue.category = 'account_uncertain';
                    flag('account_uncertain');
                    decodedValue.candidates = availableCandidates(storedEntry, proposalContext.accounts, true);
                }
            };
            const shortage = legs.money.find(l => l.delta < 0n && l.row.cents < -l.delta);
            if (shortage) {
                if (!proposalContext.forced && moneyValue!.approx && moneyValue!.range &&
                    (moneyValue!.range.min === null || BigInt(moneyValue!.range.min) <= shortage.row.cents)) {
                    decodedValue.disposition = 'pending';
                    decodedValue.category = 'general';
                    flag('approximate_affordability');
                }
                else
                    fail(payer, -shortage.delta - shortage.row.cents, null);
            }
            if (storedEntry.kind === 'consume' && !out) {
                decodedValue.disposition = 'pending';
                decodedValue.category = 'untracked';
                flag('unregistered_item');
            }
            else if (storedEntry.kind === 'income' && item && quantity > 0 && (!out || out.count < quantity)) {
                flag('item_unverified_sale');
                legs.goods = [];
            }
            else if (storedEntry.kind === 'purchase' && out && out.count < quantity) {
                flag('seller_stock_short');
                legs.goods = legs.goods.filter(l => l.delta > 0);
            }
            else if (decodedValue.disposition === 'posted' && out && out.count < quantity)
                fail(giver, null, quantity - out.count);
            if (decodedValue.disposition === 'posted' && legs.goods.some(l => l.delta > 0 &&
                !Number.isSafeInteger((l.row?.count ?? 0) + l.delta))) {
                decodedValue.disposition = 'pending';
                decodedValue.category = 'general';
                flag('inventory_overflow');
            }
            if (decodedValue.disposition === 'posted' && !legs.money.length && !legs.goods.length) {
                decodedValue.disposition = 'pending';
                decodedValue.category = 'untracked';
                flag('untracked');
            }
        }
    }
    if (decodedValue.disposition === 'posted' && codes.some(code => code !== 'payer_account_confirm'))
        decodedValue.disposition = 'flagged';
    decodedValue.layer = outerDetail(decodedValue) ? 'outer' : 'inner';
    return {
        detail: decodedValue, legs, returns
    };
}

function stateFromAccounts(accounts:LedgerAccount[]):LedgerMutableState {
  const state:LedgerMutableState={timeMs:0,balances:new Map(),inventory:new Map()};
  for(const a of accounts){for(const r of a.rows)state.balances.set(assetIdentity(a.id,r.unit),{ownerId:a.id,unit:r.unit,cents:decimalCents(r.value),tracked:r.tracked,readerIds:new Set(r.readerIds)});
    for(const i of a.items)state.inventory.set(assetIdentity(a.id,i.item),{ownerId:a.id,item:i.item,count:i.count,readerIds:new Set(i.readerIds)});}
  return state;
}
function counterpartId(source:LedgerText,previous:readonly LedgerText[]):string|null {
  if(source.role==='assistant') {
    if(source.replyTo){const s=previous.find(s=>s.sourceId===source.replyTo!.id&&s.revision===source.replyTo!.revision&&s.role==='user');return s?identity(s):null;}
    const s=[...previous].reverse().find(s=>s.role==='user');return s?identity(s):null;
  }
  const s=previous.at(-1);return s?.role==='assistant'?identity(s):null;
}
/** Shared state-sensitive verifier. Proposal mode excludes all balance/stock comparisons.
 * O(J + E + A*L), with <= 64 counterpart entries, <= 256 accounts and <= 9 labels each. */
export function verifyLedgerEntry(raw:unknown,input:unknown,mode:'proposal'|'fold'='fold'):LedgerDecoded<LedgerDetail> {
  try {
    const e=snapshot(raw) as StoredLedgerEntry,c=snapshotVerification(input) as {source:LedgerText;previous:LedgerText[];accounts:LedgerAccount[];entries:LedgerDetail[];readers?:string[];forced?:boolean};
    if(!storedEntryOK(e)||!sourceOK(c.source)||typeof c.source.text!=='string'||!Array.isArray(c.accounts)||!Array.isArray(c.entries)||!Array.isArray(c.previous))return {ok:false,code:'ledger_entry_invalid'};
    const index=emptyIndex();for(const d of c.entries)indexDetail(index,d);
    return {ok:true,value:verifyEntry(e,{source:c.source,previous:c.previous,accounts:c.accounts,index,state:stateFromAccounts(c.accounts),counterpart:counterpartId(c.source,c.previous),
      work:work(),forced:c.forced===true,mode,readers:c.readers??[]}).detail};
  }catch{return {ok:false,code:'ledger_entry_invalid'};}
}

function proofUnitPrice(e:StoredLedgerEntry,values:ReferenceValues):string|null {
  const m=moneyOf(e);if(!m)return null;if(e.quantity?.count===1)return m.cents;
  let t=m.proof?.tree;if(!t||!e.quantity?.ref)return null;
  while(t.kind==='operation'&&t.op==='multiply'&&t.operands.length===2&&t.operands[1]?.kind==='leaf'&&t.operands[1].ref==='one')t=t.operands[0]!;
  if(t.kind!=='operation'||t.op!=='multiply'||t.operands.length!==2)return null;
  const side=t.operands.findIndex(child=>child.kind==='leaf'&&child.ref===e.quantity!.ref);
  if(side<0)return null;
  const r=replayCalculation(t.operands[1-side],values);return r.result.ok&&r.result.money&&r.amounts?r.amounts.cents.toString():null;
}
/** Count one bounded graph or comparison visit without adding the optional counter to unrelated work. */
function countPairedVisit(ledgerWork: LedgerWork): void {
    ledgerWork.pairedVisits = (ledgerWork.pairedVisits ?? 0) + 1;
}

/** Order at most 64 entries by their stored dependencies, preserving the existing cycle walk.
 * A mutual pair cuts only its leader's outgoing edge; all other edges retain their original order. */
function dependencyOrder<T extends StoredLedgerEntry>(entries: T[], ledgerWork: LedgerWork): {
    ordered: T[];
    cycles: Set<string>;
    leaders: Set<StoredLedgerEntry>;
} {
    const byKey = new Map(entries.map(entry => [keyText(entry.key), entry]));
    const leaders = new Set<StoredLedgerEntry>();
    // Presence detection is bounded by one source's 64 entries and does not count unrelated work.
    if (entries.some(entry => entry.relation?.kind === 'paired_with')) {
        const positions = new Map<T, number>();
        for (const [position, entry] of entries.entries()) {
            countPairedVisit(ledgerWork);
            positions.set(entry, position);
        }

        for (const entry of entries) {
            countPairedVisit(ledgerWork);
            if (entry.relation?.kind !== 'paired_with' || entry.relation.target === null) continue;
            const target = byKey.get(keyText(entry.relation.target));
            // Distinct resolved entries must both use paired links and point back to each other.
            if (!target || target === entry) continue;
            if (target.relation?.kind !== 'paired_with' || target.relation.target === null) continue;
            if (byKey.get(keyText(target.relation.target)) !== entry) continue;

            const entryHasMoney = moneyOf(entry) !== null;
            const targetHasMoney = moneyOf(target) !== null;
            // The sole money-bearing leg leads; equal money availability uses the earlier array position.
            let leader: T;
            if (entryHasMoney !== targetHasMoney) {
                leader = entryHasMoney ? entry : target;
            } else {
                leader = positions.get(entry)! < positions.get(target)! ? entry : target;
            }
            leaders.add(leader);
        }
    }

    const done = new Set<string>();
    const active = new Set<string>();
    const cycles = new Set<string>();
    const ordered: T[] = [];
    const visit = (entry: T): void => {
        const key = keyText(entry.key);
        if (done.has(key)) return;
        if (active.has(key)) {
            for (const activeKey of active) cycles.add(activeKey);
            return;
        }

        active.add(key);
        if (entry.relation?.target && !leaders.has(entry)) {
            const target = byKey.get(keyText(entry.relation.target));
            if (target) visit(target);
        }
        active.delete(key);
        done.add(key);
        ordered.push(entry);
    };

    for (const entry of entries) visit(entry);
    return {ordered, cycles, leaders};
}

/** A current proposal row carries its stored entry and the occurrence feedback that grouping may relax. */
interface PairedProposalRow {
    id: string;
    entry: StoredLedgerEntry;
    proposal: NormalizedLedgerProposedEntry | null;
    returns: string[];
    sourceActExhausted?: boolean;
}

/** Only valid current rows form undirected components; first-id resolution includes malformed rows.
 * O(J) graph visits followed by at most J*(J-1)/2 occurrence comparisons, J <= 64 per proposal. */
function relaxPairedOccurrences(rows: PairedProposalRow[], ledgerWork: LedgerWork): void {
    // This uncounted presence scan visits at most 64 rows and leaves unrelated proposals untouched.
    if (!rows.some(row => row.proposal?.relation?.kind === 'paired_with')) return;

    const firstById = new Map<string, PairedProposalRow>();
    const neighbours = new Map<PairedProposalRow, PairedProposalRow[]>();
    for (const row of rows) {
        countPairedVisit(ledgerWork);
        if (!firstById.has(row.id)) firstById.set(row.id, row);
        if (row.proposal) neighbours.set(row, []);
    }

    for (const row of rows) {
        countPairedVisit(ledgerWork);
        if (row.proposal?.relation?.kind !== 'paired_with') continue;
        const target = firstById.get(row.proposal.relation.entry);
        if (!target?.proposal || target === row) continue;

        neighbours.get(row)!.push(target);
        neighbours.get(target)!.push(row);
    }

    const groups = new Map<PairedProposalRow, PairedProposalRow>();
    for (const row of rows) {
        countPairedVisit(ledgerWork);
        if (!row.proposal || groups.has(row)) continue;
        const waiting = [row];
        groups.set(row, row);
        while (waiting.length) {
            countPairedVisit(ledgerWork);
            const current = waiting.pop()!;
            for (const neighbour of neighbours.get(current)!) {
                countPairedVisit(ledgerWork);
                if (groups.has(neighbour)) continue;
                groups.set(neighbour, row);
                waiting.push(neighbour);
            }
        }
    }

    for (let i = 0; i < rows.length; i++) {
        countPairedVisit(ledgerWork);
        const current = rows[i]!;
        if (!current.sourceActExhausted || !current.proposal || !current.entry.act) continue;
        let firstOccupant: PairedProposalRow | null = null;
        let identicalMember = false;
        for (let j = 0; j < i; j++) {
            countPairedVisit(ledgerWork);
            const previous = rows[j]!;
            if (!previous.proposal || previous.proposal.mark !== current.proposal.mark
                || previous.entry.act?.start !== current.entry.act.start
                || previous.entry.act.end !== current.entry.act.end) continue;

            firstOccupant ??= previous;
            if (groups.get(previous) === groups.get(current)
                && JSON.stringify(leadingKey(previous.entry)) === JSON.stringify(leadingKey(current.entry))
                && entryCompare({...previous.entry, relation: null}, {...current.entry, relation: null}) === 0) {
                identicalMember = true;
            }
        }
        if (!firstOccupant || groups.get(firstOccupant) !== groups.get(current) || identicalMember) continue;

        // Static validation is the only producer of these marks so far; later duplicate checks still run.
        current.sourceActExhausted = false;
        current.returns = current.returns.filter(code => code !== 'identical_entries');
        current.entry.checks.codes = current.entry.checks.codes.filter(code =>
            code !== 'identical_entries' && code !== 'identical_in_source');
        current.entry.checks.pending = current.entry.checks.pending.filter(category => category !== 'restated');
    }
}
/** After one semantic question, the model's final settled version is authoritative. */
function acceptSemanticDecision(e:StoredLedgerEntry,prior:readonly string[]):void {
  const checks=e.checks;
  const actOK=!checks.codes.includes('act_quote_not_found')||prior.includes('act_quote_not_found')&&e.act!==null&&!checks.codes.includes('no_transaction_act');
  const actorOK=!checks.codes.includes('actor_not_grounded')||prior.includes('actor_not_grounded');
  const questionOK=!checks.codes.includes('question_sentence')||prior.includes('act_in_question');
  if(e.status==='settled'&&e.time==='current'&&actOK&&actorOK&&questionOK){
    checks.pending=checks.pending.filter(category=>category!=='not_transacted');
    checks.codes=checks.codes.filter(code=>code!=='owner_not_grounded'&&code!=='question_sentence');
  }
  if(prior.includes('act_quote_not_found')&&actOK&&checks.codes.includes('act_quote_not_found'))addCode(checks.codes,'act_outside_mark');
  if(prior.includes('actor_not_grounded')&&checks.codes.includes('actor_not_grounded'))addCode(checks.codes,'owner_weak');
  if(prior.includes('identical_entries'))checks.pending=checks.pending.filter(category=>category!=='restated');
  checks.returned=[...prior];
  if(prior.some(code=>code==='actor_not_authorised'||code==='payer_account_confirm'))checks.history.accountQuestioned=true;
}

/** Validate a complete proposal without consulting balances or stock quantities.
 * O(J + 64*L + 64^2 + H*64); H <= 4096, at most seven source texts, no I/O.
 * Paired graphs add <= 6J grouping visits, <= J^2 occurrence visits and <= 2J leader visits, J <= 64. */
export function checkLedgerProposal(raw: unknown, rawContext: unknown): LedgerProposalResult {
    const ledgerWork = work();
    const empty = (): LedgerProposalResult => ({
        entries: [], unbooked: [], uncovered: [], settled: false, withdrawn: [], withdrawalReturned: false,
        state: emptyProposalState(), work: ledgerWork
    });
    try {
        const proposalContext = snapshotContext(rawContext, ledgerWork) as LedgerProposalContext;
        if (!sourceOK(proposalContext.source) || typeof proposalContext.source.text !== 'string' || !['user',
            'assistant'].includes(proposalContext.source.role) || !Array.isArray(proposalContext.previous)
            || !Array.isArray(proposalContext.marks) || proposalContext.marks.length > 64 ||
            !proposalContext.marks.every(candidateMark => regionOK(candidateMark) && MARK.test(candidateMark.id) &&
                candidateMark.kind === (candidateMark.id[0] === 'k' ? 'money' : 'use'))
            || !Array.isArray(proposalContext.accounts) || proposalContext.accounts.length > 256 ||
            !record(proposalContext.settings) || !record(proposalContext.settings.actorLabels) ||
            !record(proposalContext.readings) || Object.keys(proposalContext.readings).length > 4096)
            return {
                ...empty(), error: 'context_invalid'
            };
        const old = proposalContext.state ?? emptyProposalState();
        if (!Array.isArray(old.history) || old.history.length > 4096 || !Array.isArray(old.previous) ||
            !Array.isArray(old.everAccepted))
            return {
                ...empty(), error: 'history_invalid'
            };
        const state = snapshot(old) as LedgerProposalState;
        proposalContext.state = state;
        proposalContext.previous = proposalContext.previous.slice(-6);
        const initial = empty();
        initial.state = state;
        initial.uncovered = proposalContext.marks.map(candidateMark => candidateMark.id);
        if (!record(raw))
            return {
                ...initial, error: 'call_malformed'
            };
        const descriptor = Object.getOwnPropertyDescriptor(raw, 'entries');
        const unbookedDescriptor = Object.getOwnPropertyDescriptor(raw, 'unbooked');
        if (!descriptor || !('value' in descriptor) || !Array.isArray(descriptor.value) || descriptor.value.length > 64
            || !unbookedDescriptor || !('value' in unbookedDescriptor) || !Array.isArray(unbookedDescriptor.value) || unbookedDescriptor.value.length > 64)
            return {
                ...initial, error: 'call_malformed'
            };
        const texts = new Map([proposalContext.source,
            ...proposalContext.previous].map(source => [identity(source), source]));
        const values = referenceValues(proposalContext.readings);
        const scans = new Map<string, {
            quantities: QuantityExpression[];
            numbers: LedgerSpan[];
        }>();
        for (const [id, currentSource] of texts) {
            const quantityScan = amountExpressionWork.scanQuantities(currentSource.text);
            const numberScan = amountExpressionWork.scanNumbers(currentSource.text);
            ledgerWork.text += quantityScan.work + numberScan.work;
            ledgerWork.scans += 2;
            scans.set(id, {
                quantities: quantityScan.result, numbers: numberScan.result
            });
        }
        const outside = outsideQuotes(proposalContext.source.text, ledgerWork);
        const used = new Map<string, LedgerSpan[]>();
        const ids = new Set<string>();
        const rows: {
            id: string;
            entry: StoredLedgerEntry;
            returns: string[];
            sourceActExhausted?: boolean;
            proposal: NormalizedLedgerProposedEntry | null;
            read: Record<string, JsonValue>;
        }[] = [];
        for (let i = 0; i < descriptor.value.length; i++) {
            let proposedEntry: unknown;
            try {
                proposedEntry = snapshot(descriptor.value[i]);
                if (record(proposedEntry)) {
                    if (!Object.hasOwn(proposedEntry, 'act'))
                        proposedEntry.act = null;
                    for (const key of ['behalf', 'item', 'quantity', 'amount', 'stated', 'tendered', 'row', 'relation'])
                        if (!Object.hasOwn(proposedEntry, key))
                            proposedEntry[key] = null;
                }
            }
            catch {
                proposedEntry = null;
            }
            const id = record(proposedEntry) && textId(proposedEntry.id) ? proposedEntry.id : `invalid:${i + 1}`;
            if (!proposedEntryOK(proposedEntry) || ids.has(id)) {
                const mark = record(proposedEntry) &&
                    typeof proposedEntry.mark === 'string' ? proposalContext.marks.find(candidateMark => candidateMark.id
                        === proposedEntry.mark) : undefined;
                const storedEntry = fallbackEntry(proposalContext.source, mark ?? {
                    id: 'k0', kind: 'money', whole: true
                });
                storedEntry.checks.codes = ['entry_malformed'];
                storedEntry.checks.pending = ['general'];
                rows.push({
                    id, entry: storedEntry, returns: ['entry_malformed'], proposal: null, read: {}
                });
            }
            else {
                const checked = staticEntry(proposedEntry, proposalContext, used, texts, values, scans, outside,
                    ledgerWork);
                checked.entry.unitPrice = proofUnitPrice(checked.entry, values);
                rows.push({
                    id, ...checked, proposal: proposedEntry, read: {}
                });
            }
            ids.add(id);
            ledgerWork.entries++;
        }
        checkAmountOverlaps(rows, proposalContext.readings, scans, ledgerWork);
        checkMarkedAmountReferences(rows, proposalContext.readings, ledgerWork);
        checkQuantityWindows(rows.map(ledgerRow => ledgerRow.entry), texts, scans, ledgerWork);
        if (proposalContext.keptEntries && !entriesOK(proposalContext.keptEntries))
            return {
                ...initial, error: 'context_invalid'
            };
        assignKeys(rows.map(ledgerRow => ledgerRow.entry), proposalContext.keptEntries);
        const link = () => {
            for (const row of rows)
                if (row.proposal?.relation && row.entry.relation) {
                    const ref = row.proposal.relation.entry;
                    row.entry.relation.target = rows.find(ledgerRow => ledgerRow.id === ref)?.entry.key ?? (
                        proposalContext.entryRefs && Object.hasOwn(proposalContext.entryRefs, ref) ? proposalContext
                        .entryRefs[ref] : null) ?? (Object.hasOwn(proposalContext.readings, ref)
                        && 'entry' in proposalContext.readings[ref] ? proposalContext.readings[ref].entry ?? null :
                        null);
                }
        };
        link();
        assignKeys(rows.map(ledgerRow => ledgerRow.entry), proposalContext.keptEntries);
        link();
        relaxPairedOccurrences(rows, ledgerWork);
        for (let i = 0; i < rows.length; i++)
            for (let j = 0; j < i; j++) {
                ledgerWork.pairs++;
                const currentRow = rows[i]!;
                const previousRow = rows[j]!;
                if (JSON.stringify(leadingKey(currentRow.entry)) === JSON.stringify(leadingKey(previousRow
                    .entry)) && entryCompare(currentRow.entry, previousRow.entry) === 0) {
                    addCode(currentRow.entry.checks.codes, 'identical_entries');
                    addCode(currentRow.entry.checks.codes, 'identical_in_source');
                    pending(currentRow.entry.checks, 'restated');
                    addCode(currentRow.returns, 'identical_entries');
                    currentRow.read.same_as = previousRow.id;
                    break;
                }
            }
        const index = emptyIndex();
        for (const decodedValue of proposalContext.before?.entries ?? [])
            indexDetail(index, decodedValue);
        const mutable = stateFromAccounts(proposalContext.accounts);
        const order = dependencyOrder(rows.map(ledgerRow => ledgerRow.entry), ledgerWork);
        const checks = new Map<StoredLedgerEntry, LedgerCheckedEntry>();
        const reply = proposalContext.source.role === 'assistant' &&
            proposalContext.source.replyTo ? JSON.stringify([proposalContext.source.replyTo.id,
            proposalContext.source.replyTo.revision]) : null;
        const counterpart = reply &&
            index.sources.get(reply)?.some(storedEntry => storedEntry.role === 'user') ? reply : counterpartId(
                proposalContext.source, proposalContext.previous);
        for (const storedEntry of order.ordered) {
            const row = rows.find(ledgerRow => ledgerRow.entry === storedEntry)!;
            const primary = proposalContext.accounts.find(ledgerAccount => ledgerAccount.id === partyAccount(
                storedEntry.kind === 'income' ? storedEntry.payee : storedEntry.payer ?? storedEntry.payee));
            const comparison = {
                ...storedEntry, row: selectCurrency(storedEntry, primary).row ?? storedEntry.row
            };
            const prior = [...new Set([...(Object.hasOwn(state.returned, row.id) ? state.returned[row.id]! : []),
                    ...state.previous.filter(proposedEntry => JSON.stringify(leadingKey(proposedEntry.entry))
                        === JSON.stringify(leadingKey(storedEntry)) && entryCompare(proposedEntry.entry,
                        comparison) === 0).flatMap(proposedEntry => proposedEntry.entry.checks.returned)])];
            acceptSemanticDecision(storedEntry, prior);
            if (order.cycles.has(keyText(storedEntry.key))) {
                addCode(storedEntry.checks.codes, 'relation_invalid');
                pending(storedEntry.checks, 'general');
                addCode(row.returns, 'relation_invalid');
            }
            const verified = verifyEntry(storedEntry, {
                source: proposalContext.source, previous: proposalContext.previous,
                accounts: proposalContext.accounts, index, state: mutable, counterpart, work: ledgerWork,
                forced: false, mode: 'proposal', readers: [], pairedLeader: order.leaders.has(storedEntry)
            });
            if (verified.detail.row !== null)
                storedEntry.row = verified.detail.row;
            const allReturns = [...new Set([...row.returns, ...verified.returns])];
            const fresh = allReturns.filter(code => !prior.includes(code));
            Object.defineProperty(state.returned, row.id, {
                value: [...new Set([...prior, ...allReturns])], enumerable: true, writable: true, configurable: true
            });
            storedEntry.checks.returned = [...state.returned[row.id]!];
            if (storedEntry.checks.returned.some(code => code === 'actor_not_authorised' ||
                code === 'payer_account_confirm'))
                storedEntry.checks.history.accountQuestioned = true;
            if (verified.detail.codes.includes('payer_account_confirm')) {
                row.read.payer = partyAccount(storedEntry.payer);
                row.read.behalf = storedEntry.behalf?.span ? proposalContext.source.text.slice(storedEntry.behalf
                    .span.start, storedEntry.behalf.span.end) : null;
                row.read.candidates = availableCandidates(storedEntry, proposalContext.accounts).filter(id => id
                    !== partyAccount(storedEntry.payer));
            }
            if (verified.detail.codes.includes('possible_duplicate') && counterpart) {
                const other = index.sources.get(counterpart)?.find(decodedValue => posted(decodedValue) &&
                    matchingTransaction(storedEntry, decodedValue));
                if (other)
                    row.read.same_as = asJSON(other.key);
            }
            const unanswered = fresh.filter(code => SEMANTIC_QUESTIONS.includes(code));
            if (unanswered.length) {
                storedEntry.checks.unanswered = unanswered;
                for (const code of unanswered) {
                    addCode(storedEntry.checks.codes, code);
                    pending(storedEntry.checks, code === 'possible_duplicate' ||
                        code === 'identical_entries' ? 'restated' : code === 'actor_not_authorised' ? 'general' :
                            'not_transacted');
                }
            }
            const verdict: LedgerCheckedEntry['verdict'] = fresh.length ? 'returned' : verified.detail.disposition
                === 'pending' ? 'settled' : verified.detail.disposition === 'flagged' ? 'flagged' : 'accepted';
            const checked = {
                id: row.id,
                verdict,
                codes: verified.detail.codes,
                // Storage retains the six-question duplicate group; feedback names this occurrence failure precisely.
                returnedCodes: fresh.map(code => row.sourceActExhausted && code === 'identical_entries'
                    ? 'identical_in_source' : code),
                read: row.read,
                entry: storedEntry
            };
            checks.set(storedEntry, checked);
            indexDetail(index, verified.detail);
        }
        const entries = rows.map(ledgerRow => checks.get(ledgerRow.entry)!);
        const unbooked: LedgerUnbooked[] = [];
        for (const rawU of unbookedDescriptor.value) {
            let u: unknown;
            try {
                u = snapshot(rawU);
            }
            catch {
                continue;
            }
            if (!record(u) || !MODEL_UNBOOKED.includes(u.reason as string))
                continue;
            const mark = proposalContext.marks.find(candidateMark => candidateMark.id === u.mark);
            if (mark)
                unbooked.push({
                    sourceId: proposalContext.source.sourceId, revision: proposalContext.source.revision,
                    ...('whole' in mark ? { whole: true as const } : { span: mark.span }), mark: mark.id,
                    reason: u.reason as LedgerUnbookedReason, by: 'model'
                });
        }
        const covered = new Set([...entries.map(storedEntry => storedEntry.entry.mark.id),
            ...unbooked.map(u => u.mark!)]);
        const uncovered = proposalContext.marks.filter(candidateMark => !covered.has(
                candidateMark.id)).map(candidateMark => candidateMark.id);
        const withdrawn = state.previous.filter(storedEntry => !ids.has(storedEntry.id)).map(storedEntry =>
            storedEntry.id);
        let settled = !entries.some(storedEntry => storedEntry.verdict === 'returned') && !uncovered.length;
        let withdrawalReturned = false;
        if (state.awaitingWithdrawal.length) {
            for (const id of state.awaitingWithdrawal)
                if (!ids.has(id) && !state.confirmedWithdrawn.includes(id))
                    state.confirmedWithdrawn.push(id);
            state.awaitingWithdrawal = [];
        }
        if (settled && !state.withdrawalAsked &&
            state.previous.some(storedEntry => withdrawn.includes(storedEntry.id) && ['accepted',
                'flagged'].includes(storedEntry.verdict))) {
            settled = false;
            withdrawalReturned = true;
            state.withdrawalAsked = true;
            state.awaitingWithdrawal = withdrawn;
        }
        // A failed call must preserve every part of the previous usable state.
        if (state.history.length + entries.length > LEDGER_LIMITS.history) {
            return {
                ...initial, state: snapshot(old) as LedgerProposalState, error: 'history_limit'
            };
        }
        for (const checked of entries) {
            state.history.push({
                id: checked.id, mark: checked.entry.mark.id, act: checked.entry.act, checks: checked.entry.checks
            });
            if (checked.verdict === 'accepted' || checked.verdict === 'flagged') {
                const oldIndex = state.everAccepted.findIndex(candidate => candidate.id === checked.id);
                const row = {
                    id: checked.id, entry: checked.entry
                };
                if (oldIndex >= 0)
                    state.everAccepted[oldIndex] = row;
                else
                    state.everAccepted.push(row);
            }
        }
        state.previous = entries.map(({ id, verdict, entry }) => ({
            id, verdict, entry
        }));
        return {
            entries, unbooked, uncovered, settled, withdrawn, withdrawalReturned, state, work: ledgerWork
        };
    }
    catch {
        return {
            ...empty(), error: 'context_invalid'
        };
    }
}

/** Canonical anchor for an existing legacy effect. O(identifier bytes). */
export function legacyLedgerKey(sourceId:string,revision:number,effectId:string):LedgerKey|null {
  try {return textId(sourceId)&&safeInt(revision,1)&&textId(effectId)?`legacy:${JSON.stringify({effectId,revision,sourceId})}`:null;}catch{return null;}
}
/** One source index, O(S log S) preparation and O(1) exact / O(log S) fallback lookup. */
function positionIndex(sources:readonly WorldSourceEffects[],w:LedgerWork=work()):{exact:Map<string,number>;at:(after:LedgerAfter)=>number} {
  const exact=new Map<string,number>(),times:{time:number;position:number}[]=[];
  for(let i=0;i<sources.length;i++){
    w.positionVisits=(w.positionVisits??0)+1;const s=sources[i];if(!s)continue;
    const key=identity(s);if(!exact.has(key))exact.set(key,i+1);
    if(safeInt(s.acceptedAtMs))times.push({time:s.acceptedAtMs,position:i+1});
  }
  times.sort((a,b)=>a.time-b.time);let max=0;
  for(const t of times){max=Math.max(max,t.position);t.position=max;}
  return {exact,at:after=>{
    w.positionVisits=(w.positionVisits??0)+1;if(after===null)return 0;
    const found=exact.get(identity(after));if(found!==undefined)return found;
    let lo=0,hi=times.length;
    while(lo<hi){w.positionVisits=(w.positionVisits??0)+1;const mid=(lo+hi)>>>1;if(times[mid]!.time<=after.acceptedAtMs)lo=mid+1;else hi=mid;}
    return lo?times[lo-1]!.position:0;
  }};
}

/** O(own keys); holes are rejected without walking the array's declared length. */
function denseArray(raw: unknown): raw is unknown[] {
    if (!Array.isArray(raw))
        return false;
    const indices = Object.keys(raw).filter(key => INTEGER.test(key) && Number(key) < raw.length);
    return indices.length === raw.length;
}

/** Append in O(rows), retaining at most the per-result diagnostic budget.
 * The final summary counts the displaced visible row as well as later omissions. */
function appendDiagnostics(diagnostics: LedgerDiagnostic[], ...rows: LedgerDiagnostic[]): void {
    for (const row of rows) {
        const weight = row.code === 'diagnostics_truncated' ? row.omitted ?? 1 : 1;
        const summary = diagnostics.at(-1);
        if (summary?.code === 'diagnostics_truncated') {
            summary.omitted = (summary.omitted ?? 1) + weight;
        }
        else if (diagnostics.length < LEDGER_LIMITS.diagnostics) {
            diagnostics.push(row);
        }
        else {
            diagnostics[diagnostics.length - 1] = {
                code: 'diagnostics_truncated', id: null, omitted: 1 + weight
            };
        }
    }
}

/** Positions are source counts: zero is before the first source, N is after source N. */
export interface LedgerEventPositions {
  accountEvents:{event:LedgerAccountEvent;position:number}[];
  adjustments:{correction:LedgerCorrection;position:number}[];
}

/** Resolve decoded event/adjustment positions against the complete sequence, O(S log S + E log S).
 * Exact source/revision wins; a missing anchor uses the maximum position accepted by its timestamp.
 * Invalid or unreadable inputs return ledger_positions_invalid; no caller objects are modified. */
export function ledgerEventPositions(sources: readonly WorldSourceEffects[], accountEvents:
    readonly LedgerAccountEvent[], corrections: readonly LedgerCorrection[], ledgerWork: LedgerWork = work()):
    LedgerDecoded<LedgerEventPositions> {
    try {
        if (!denseArray(sources) || !denseArray(accountEvents) || !denseArray(corrections)) {
            return {
                ok: false, code: 'ledger_positions_invalid'
            };
        }
        const adjustments = corrections.filter(correction => correction.action === 'adjustment');
        const needsIndex = accountEvents.some(event => event.kind !== 'create') || adjustments.length > 0;
        const positions = needsIndex ? positionIndex(sources, ledgerWork) : { at: () => 0 };
        return {
            ok: true,
            value: {
                accountEvents: accountEvents.map(event => ({
                    event, position: event.kind === 'create' ? 0 : positions.at(event.after)
                })),
                adjustments: adjustments.map(correction => ({
                    correction, position: positions.at(correction.after ?? null)
                })),
            },
        };
    }
    catch {
        return {
            ok: false, code: 'ledger_positions_invalid'
        };
    }
}

function decodeEvents(raw: unknown, diagnostics: LedgerDiagnostic[]): LedgerAccountEvent[] {
    if (raw == null)
        return [];
    if (!denseArray(raw)) {
        appendDiagnostics(diagnostics, {
            code: 'account_events_invalid', id: null
        });
        return [];
    }
    const truncated = raw.length > LEDGER_LIMITS.events;
    if (truncated)
        appendDiagnostics(diagnostics, {
            code: 'account_events_truncated', id: null
        });
    const events: LedgerAccountEvent[] = [];
    const identities = new Map<string, string>();
    for (let index = 0; index < raw.length; index++) {
        const field = Object.getOwnPropertyDescriptor(raw, String(index));
        const decoded = field && 'value' in field
            ? decodeLedgerAccountEvent(field.value)
            : {
                ok: false as const, code: 'account_event_invalid'
            };
        if (!decoded.ok) {
            appendDiagnostics(diagnostics, {
                code: decoded.code,
                id: null,
                index,
                reason: field && 'value' in field ? rowFailure(field.value) : 'json_accessor',
            });
            continue;
        }
        const fingerprint = JSON.stringify(decoded.value);
        const previous = identities.get(decoded.value.id);
        if (previous !== undefined) {
            if (previous !== fingerprint)
                appendDiagnostics(diagnostics, {
                    code: 'account_event_id_conflict', id: decoded.value.id
                });
            continue;
        }
        identities.set(decoded.value.id, fingerprint);
        events.push(decoded.value);
    }
    const ordered = events.sort((left, right) => left.seq - right.seq);
    return truncated
        ? [
            ...ordered.filter(event => event.kind === 'create'),
            ...ordered.filter(event => event.kind !== 'create').slice(0, LEDGER_LIMITS.events),
        ]
        : ordered;
}
/** Stable radix ordering of nonnegative safe-integer sequence numbers: O(7*C). */
function correctionOrder<T extends {seq:number}>(rows:T[],w:LedgerWork,descending=false):T[] {
  if(rows.length<2)return rows;
  if(rows.length<=64)return [...rows].sort((a,b)=>{w.correctionVisits=(w.correctionVisits??0)+1;return descending?b.seq-a.seq:a.seq-b.seq;});
  let ordered=rows;
  for(let pass=0;pass<7;pass++){
    const divisor=2**(pass*8),buckets:T[][]=Array.from({length:256},()=>[]);
    for(const row of ordered){w.correctionVisits=(w.correctionVisits??0)+1;buckets[Math.floor(row.seq/divisor)%256]!.push(row);}
    ordered=(descending?buckets.reverse():buckets).flat();
  }
  return ordered;
}
/** O(total row JSON + C), no chat-wide correction limit. Latest seq wins per anchor. */
function rowFailure(raw:unknown):string {
  try{snapshot(raw);return 'shape_invalid';}catch(error){return error instanceof Error?error.message:'non_json_value';}
}

function decodeCorrections(raw: unknown, diagnostics: LedgerDiagnostic[], ledgerWork: LedgerWork = work(), history:
    LedgerCorrection[] = []): LedgerCorrection[] {
    if (raw == null)
        return [];
    if (!denseArray(raw)) {
        appendDiagnostics(diagnostics, {
            code: 'ledger_corrections_invalid', id: null
        });
        return [];
    }
    const candidates: unknown[] = [];
    try {
        // Read the entire boundary before adopting any row; proxy failures reject the whole input.
        for (let index = 0; index < raw.length; index++)
            candidates.push(raw[index]);
    }
    catch {
        appendDiagnostics(diagnostics, {
            code: 'ledger_corrections_invalid', id: null
        });
        return [];
    }
    const corrections: LedgerCorrection[] = [];
    const identities = new Map<string, string>();
    for (let index = 0; index < raw.length; index++) {
        ledgerWork.correctionVisits = (ledgerWork.correctionVisits ?? 0) + 1;
        const field = Object.getOwnPropertyDescriptor(raw, String(index));
        const decoded = field && 'value' in field
            ? decodeLedgerCorrection(candidates[index])
            : {
                ok: false as const, code: 'ledger_correction_invalid'
            };
        if (!decoded.ok) {
            appendDiagnostics(diagnostics, {
                code: decoded.code,
                id: null,
                index,
                reason: field && 'value' in field ? rowFailure(field.value) : 'json_accessor',
            });
            continue;
        }
        const fingerprint = JSON.stringify(decoded.value);
        const previous = identities.get(decoded.value.id);
        if (previous !== undefined) {
            if (previous !== fingerprint)
                appendDiagnostics(diagnostics, {
                    code: 'correction_id_conflict', id: decoded.value.id
                });
            continue;
        }
        identities.set(decoded.value.id, fingerprint);
        corrections.push(decoded.value);
    }
    const adjustmentIds = new Set(corrections.filter(correction => correction.action === 'adjustment')
        .map(correction => `user:${correction.id}`));
    const active = new Map<string, LedgerCorrection>();
    for (const correction of correctionOrder(corrections, ledgerWork)) {
        ledgerWork.correctionVisits = (ledgerWork.correctionVisits ?? 0) + 1;
        const adjustmentTarget = typeof correction.anchor === 'string' && adjustmentIds.has(correction.anchor);
        if (adjustmentTarget && correction.action === 'void') {
            appendDiagnostics(diagnostics, {
                code: 'adjustment_void_invalid', id: correction.id
            });
            continue;
        }
        if (adjustmentTarget && correction.action !== 'clear') {
            appendDiagnostics(diagnostics, {
                code: 'adjustment_edit_invalid', id: correction.id
            });
            continue;
        }
        history.push(correction);
        const group = correction.action === 'adjustment' ||
            adjustmentTarget ? 'adjustment' : identity(correction as LedgerSourceRef);
        const key = group + '/' + (correction.anchor ? keyText(correction.anchor) : `user:${correction.id}`);
        if (correction.action === 'clear') {
            if (!active.delete(key))
                appendDiagnostics(diagnostics, {
                    code: 'clear_unmatched', id: correction.id
                });
        }
        else {
            active.set(key, correction);
        }
    }
    return correctionOrder([...active.values()], ledgerWork);
}

/** O(balance rows + inventory rows); only equal script-folded labels share a row.
 * Totals retain the first spelling and the intersection of readers who know every component. */
function mergeFoldedRows(state: LedgerMutableState, diagnostics: LedgerDiagnostic[]): void {
    const balances = new Map<string, LedgerMutableBalance>();
    for (const [key, row] of state.balances) {
        const folded = assetIdentity(row.ownerId, foldForMatch(row.unit));
        const first = balances.get(folded);
        if (!first) {
            balances.set(folded, row);
            continue;
        }
        first.cents += row.cents;
        first.readerIds = new Set([...first.readerIds].filter(reader => row.readerIds.has(reader)));
        state.balances.delete(key);
        appendDiagnostics(diagnostics, {
            code: 'folded_currency_duplicate', id: row.ownerId
        });
    }
    const inventory = new Map<string, LedgerMutableInventory>();
    let inventoryIndex = -1;
    for (const [key, row] of state.inventory) {
        inventoryIndex++;
        const folded = assetIdentity(row.ownerId, foldForMatch(row.item));
        const first = inventory.get(folded);
        if (!first) {
            inventory.set(folded, row);
            continue;
        }
        const count = first.count + row.count;
        if (!Number.isSafeInteger(count)) {
            // An invalid later row must not erase earlier rows or unrelated transactions.
            state.inventory.delete(key);
            appendDiagnostics(diagnostics, {
                code: 'folded_inventory_overflow', id: row.ownerId, index: inventoryIndex, reason: row.item
            });
            continue;
        }
        first.count = count;
        first.readerIds = new Set([...first.readerIds].filter(reader => row.readerIds.has(reader)));
        state.inventory.delete(key);
        appendDiagnostics(diagnostics, {
            code: 'folded_item_duplicate', id: row.ownerId
        });
    }
}

function implicitAccounts(settings: WorldSettings, state: LedgerMutableState, diagnostics: LedgerDiagnostic[] =
    []): LedgerAccount[] {
    mergeFoldedRows(state, diagnostics);
    return [['player', [settings.playerName]], ...Object.entries(settings.actorLabels)].map(([id, names]) => {
        const owner = id as string;
        const labels = names as readonly string[];
        const rows = [...state.balances.values()].filter(
            ledgerRow => ledgerRow.ownerId === owner).map(ledgerRow => ({
            unit: ledgerRow.unit, value: moneyText(ledgerRow.cents), tracked: true,
            readerIds: [...ledgerRow.readerIds].sort()
        }));
        const items = [...state.inventory.values()].filter(ledgerRow => ledgerRow.ownerId === owner).map(ledgerRow => ({
            item: ledgerRow.item, count: ledgerRow.count, readerIds: [...ledgerRow.readerIds].sort()
        }));
        return {
            id: owner, kind: 'private' as const, label: labels[0]!, aliases: labels.slice(1) as string[],
            actors: [owner],
            readers: [...new Set(rows.flatMap(ledgerRow => ledgerRow.readerIds).concat(items.flatMap(i => i
                .readerIds)))].sort(), rows, items, status: 'active' as const
        };
    });
}
function syncAccounts(accounts:LedgerAccount[],state:LedgerMutableState,w:LedgerWork):void {
  for(const a of accounts)if(a.status==='active'){
    for(const r of a.rows){w.rowCopies++;const row=state.balances.get(assetIdentity(a.id,r.unit));if(row){r.value=moneyText(row.cents);r.readerIds=[...row.readerIds].sort();r.tracked=row.tracked!==false;}}
    for(const i of a.items){w.rowCopies++;const row=state.inventory.get(assetIdentity(a.id,i.item));if(row){i.count=row.count;i.readerIds=[...row.readerIds].sort();}}
  }
}

function applyAccountEvent(event: LedgerAccountEvent, accounts: LedgerAccount[], state: LedgerMutableState,
    diagnostics: LedgerDiagnostic[], ledgerWork: LedgerWork): boolean {
    ledgerWork.events++;
    const invalid = (code: string) => {
        appendDiagnostics(diagnostics, {
            code, id: event.id
        });
        return false;
    };
    const known = new Set(accounts.filter(ledgerAccount => ledgerAccount.kind === 'private').map(ledgerAccount =>
        ledgerAccount.id));
    const readersOK = (ids: readonly string[]) => ids.every(id => known.has(id));
    if (event.kind === 'create') {
        const decodedObject = event.account;
        if (decodedObject.kind === 'private' || !decodedObject.id.startsWith('acct:') ||
            known.has(decodedObject.id) || accounts.some(ledgerAccount => ledgerAccount.id === decodedObject.id))
            return invalid('account_id_conflict');
        if (accounts.length >= 256)
            return invalid('account_limit');
        if (!readersOK(decodedObject.actors) || !readersOK(decodedObject.readers) ||
            decodedObject.rows.some(ledgerRow => !readersOK(ledgerRow.readerIds ?? decodedObject.readers)) ||
            decodedObject.items.some(i => !readersOK(i.readerIds ?? decodedObject.readers)))
            return invalid('account_reader_invalid');
        const ledgerAccount: LedgerAccount = {
            ...decodedObject, rows: decodedObject.rows.map(ledgerRow => ({
                unit: ledgerRow.unit, value: ledgerRow.opening, tracked: ledgerRow.tracked,
                readerIds: [...(ledgerRow.readerIds ?? decodedObject.readers)].sort()
            })), items: decodedObject.items.map(i => ({
                ...i, readerIds: [...(i.readerIds ?? decodedObject.readers)].sort()
            }))
        };
        // Preserve the first occurrence even when the two incoming spellings are literally identical.
        const openings: LedgerMutableState = {
            timeMs: 0, balances: new Map(), inventory: new Map()
        };
        for (let index = 0; index < ledgerAccount.rows.length; index++) {
            const row = ledgerAccount.rows[index]!;
            openings.balances.set(String(index), {
                ownerId: ledgerAccount.id, unit: row.unit, cents: decimalCents(row.value),
                tracked: row.tracked, readerIds: new Set(row.readerIds),
            });
        }
        for (let index = 0; index < ledgerAccount.items.length; index++) {
            const row = ledgerAccount.items[index]!;
            openings.inventory.set(String(index), {
                ownerId: ledgerAccount.id, item: row.item, count: row.count, readerIds: new Set(row.readerIds)
            });
        }
        try {
            mergeFoldedRows(openings, diagnostics);
        }
        catch {
            return invalid('folded_inventory_overflow');
        }
        ledgerAccount.rows = [...openings.balances.values()].map(row => ({
            unit: row.unit, value: moneyText(row.cents), tracked: row.tracked !== false,
            readerIds: [...row.readerIds].sort(),
        }));
        ledgerAccount.items = [...openings.inventory.values()].map(row => ({
            item: row.item, count: row.count, readerIds: [...row.readerIds].sort(),
        }));
        accounts.push(ledgerAccount);
        if (ledgerAccount.status === 'active') {
            for (const ledgerRow of ledgerAccount.rows)
                state.balances.set(assetIdentity(ledgerAccount.id, ledgerRow.unit), {
                    ownerId: ledgerAccount.id, unit: ledgerRow.unit, cents: decimalCents(ledgerRow.value),
                    tracked: ledgerRow.tracked, readerIds: new Set(ledgerRow.readerIds)
                });
            for (const i of ledgerAccount.items)
                state.inventory.set(assetIdentity(ledgerAccount.id, i.item), {
                    ownerId: ledgerAccount.id, item: i.item, count: i.count, readerIds: new Set(i.readerIds)
                });
        }
        return true;
    }
    const ledgerAccount = accounts.find(ledgerAccount => ledgerAccount.id === event.accountId);
    if (!ledgerAccount || ledgerAccount.status === 'closed')
        return invalid('account_event_target_invalid');
    if (event.kind === 'close') {
        if (ledgerAccount.kind === 'private')
            return invalid('private_account_cannot_close');
        syncAccounts([ledgerAccount], state, ledgerWork);
        ledgerAccount.status = 'closed';
        for (const ledgerRow of ledgerAccount.rows)
            state.balances.delete(assetIdentity(ledgerAccount.id, ledgerRow.unit));
        for (const i of ledgerAccount.items)
            state.inventory.delete(assetIdentity(ledgerAccount.id, i.item));
        return true;
    }
    const changes = event.changes;
    if (changes.actors && !readersOK(changes.actors) || changes.readers &&
        !readersOK(changes.readers) || changes.rows?.some(ledgerRow => ledgerRow.readerIds &&
        !readersOK(ledgerRow.readerIds)))
        return invalid('account_reader_invalid');
    if (ledgerAccount.kind === 'private' && (changes.label !== undefined ||
        changes.aliases !== undefined || changes.actors !== undefined))
        return invalid('private_account_identity_immutable');
    if (changes.rows) {
        if (new Set(changes.rows.map(ledgerRow => ledgerRow.unit)).size !== changes.rows.length)
            return invalid('account_row_conflict');
        let rowCount = ledgerAccount.rows.length;
        for (const change of changes.rows) {
            const old = ledgerAccount.rows.find(ledgerRow => ledgerRow.unit === change.unit);
            if (old && change.opening !== undefined)
                return invalid('account_opening_immutable');
            if (!old && !change.remove && change.opening === undefined)
                return invalid('account_opening_required');
            rowCount += change.remove ? (old ? -1 : 0) : old ? 0 : 1;
        }
        if (rowCount > 256)
            return invalid('account_row_limit');
    }
    if (changes.label !== undefined)
        ledgerAccount.label = changes.label;
    if (changes.aliases)
        ledgerAccount.aliases = [...changes.aliases];
    if (changes.actors)
        ledgerAccount.actors = [...changes.actors];
    if (changes.readers) {
        ledgerAccount.readers = [...changes.readers];
        for (const ledgerRow of ledgerAccount.rows) {
            ledgerRow.readerIds = [...changes.readers];
            const row = state.balances.get(assetIdentity(ledgerAccount.id, ledgerRow.unit));
            if (row)
                row.readerIds = new Set(changes.readers);
        }
        if (ledgerAccount.kind !== 'private')
            for (const i of ledgerAccount.items) {
                i.readerIds = [...changes.readers];
                const row = state.inventory.get(assetIdentity(ledgerAccount.id, i.item));
                if (row)
                    row.readerIds = new Set(changes.readers);
            }
    }
    for (const change of changes.rows ?? []) {
        const at = ledgerAccount.rows.findIndex(ledgerRow => ledgerRow.unit === change.unit);
        const old = at >= 0 ? ledgerAccount.rows[at] : undefined;
        const key = assetIdentity(ledgerAccount.id, change.unit);
        if (change.remove) {
            if (at >= 0)
                ledgerAccount.rows.splice(at, 1);
            state.balances.delete(key);
            continue;
        }
        if (old) {
            if (change.tracked !== undefined) {
                old.tracked = change.tracked;
                state.balances.get(key)!.tracked = change.tracked;
            }
            if (change.readerIds) {
                old.readerIds = [...change.readerIds];
                state.balances.get(key)!.readerIds = new Set(change.readerIds);
            }
        }
        else {
            const row = {
                unit: change.unit, value: change.opening!, tracked: change.tracked ?? true,
                readerIds: [...(change.readerIds ?? ledgerAccount.readers)]
            };
            ledgerAccount.rows.push(row);
            state.balances.set(key, {
                ownerId: ledgerAccount.id, unit: row.unit, cents: decimalCents(row.value),
                tracked: row.tracked, readerIds: new Set(row.readerIds)
            });
        }
    }
    return true;
}

function applyLegs(result: Evaluated, state: LedgerMutableState, accounts: LedgerAccount[]): void {
    if (!posted(result.detail))
        return;
    // This is the single debit boundary, after all funding and stock checks.
    for (const leg of result.legs.money)
        leg.row.cents += leg.delta;
    for (const leg of result.legs.goods) {
        if (leg.row)
            leg.row.count += leg.delta;
        else if (leg.delta > 0) {
            const ledgerAccount = accounts.find(ledgerAccount => ledgerAccount.id === leg.owner)!;
            const ids = ledgerAccount.kind === 'private'
                ? [...new Set(ledgerAccount.rows.flatMap(ledgerRow => ledgerRow.readerIds)
                        .concat(ledgerAccount.items.flatMap(item => item.readerIds)))]
                : ledgerAccount.readers;
            const visible = ids.length ? ids : ['player'];
            const readers = result.detail.quoteReaderIds
                ? visible.filter(reader => reader === 'player' || result.detail.quoteReaderIds!.item.includes(reader))
                : visible;
            const row = {
                ownerId: leg.owner, item: leg.item, count: leg.delta, readerIds: new Set(readers)
            };
            state.inventory.set(assetIdentity(leg.owner, leg.item), row);
            ledgerAccount.items.push({
                item: leg.item, count: leg.delta, readerIds: [...readers]
            });
        }
    }
}
function userEntry(c:LedgerCorrection,source:LedgerText,original?:StoredLedgerEntry):StoredLedgerEntry {
  const v=c.values!,mark=c.fromMark?{...c.fromMark,kind:c.fromMark.id[0]==='y'?'use' as const:'money' as const}:original?.mark??{id:'k0',kind:'money' as const,whole:true as const};
  const e=original?{...original,checks:defaultChecks()}:fallbackEntry(source,mark);
  if(!original&&c.anchor&&Array.isArray(c.anchor)&&c.anchor.length===9)e.act=keySpan(c.anchor as LedgerKey);
  e.origin='user';e.key=original?.key??`user:${c.id}`;e.status='settled';e.time='current';e.doubts=[];
  e.actor=original?.actor??{id:v.payer&&!v.payer.startsWith('acct:')?v.payer:'player',basis:'speaker',span:null};e.kind=v.kind;
  e.payer=v.payer?{account:v.payer}:original?.payer&&'external'in original.payer?original.payer:{external:null};e.payee=v.payee?{account:v.payee}:original?.payee&&'external'in original.payee?original.payee:{external:null};e.receiver=v.receiver==null?e.payer:v.receiver?{account:v.receiver}:{external:null};
  if(original){
    const quotes={...original.externalQuotes};
    for(const field of ['payer','payee','receiver'] as const){const party=original[field];if(party&&'external'in party&&party.external&&partyAccount(e[field])!==null)quotes[field]=party.external;}
    if(Object.keys(quotes).length)e.externalQuotes=quotes;
  }
  if(v.kind==='adjustment'){const target=v.payer??v.payee!;e.payer=v.cents?.startsWith('-')?{account:target}:{external:null};e.payee=v.cents?.startsWith('-')?{external:null}:{account:target};e.receiver={external:null};}
  const value=v.cents===null?null:(v.cents.startsWith('-')?v.cents.slice(1):v.cents);
  e.amount=value===null?null:{cents:value,unit:v.unit?yuan(v.unit)?{kind:'yuan'}:{kind:'named',word:v.unit}:null,approx:false,exact:true,range:null,proof:null};
  e.stated=null;e.tendered=null;e.row=v.unit;e.unitPrice=v.quantity===1?value:null;
  e.item=v.item?{sourceId:source.sourceId,revision:source.revision,span:original?.item?.span??{start:0,end:Math.max(1,source.text.length)},quote:v.item}:null;
  e.quantity=v.quantity===null?null:{count:v.quantity,approx:false,proof:null,ref:null};
  e.relation=v.relation?{kind:v.relation.kind,target:v.relation.target,span:null}:null;
  e.checks.actorGrounded=true;e.checks.explicitParty=true;
  return e;
}
function userValuesStateCodes(v:LedgerUserValues,accounts:LedgerAccount[],index:BookIndex):string[] {
  const codes:string[]=[];
  const primary=v.kind==='income'?v.payee:v.payer??v.payee;
  for(const id of [v.payer,v.payee,v.receiver??null])if(id!==null){const a=accounts.find(a=>a.id===id);
    if(!a||a.status!=='active')addCode(codes,'correction_account_unavailable');
    else if(v.cents!==null&&id===primary&&(!v.unit||!accountRow(a,v.unit)))addCode(codes,'correction_row_missing');}
  if(v.kind==='consume'&&(!v.item||!v.quantity||!v.payer))addCode(codes,'correction_item_invalid');
  if(v.kind!=='consume'&&v.kind!=='transfer'&&v.cents===null)addCode(codes,'correction_amount_invalid');
  if(v.cents!==null&&!v.unit)addCode(codes,'correction_unit_invalid');
  if(v.kind==='adjustment'&&(!v.payer&&!v.payee||v.item!==null||v.quantity!==null||v.cents===null))addCode(codes,'correction_adjustment_invalid');
  if(v.kind==='refund'){
    const target=v.relation?.kind==='refund_of'?index.keys.get(keyText(v.relation.target)):undefined;
    if(!target||!posted(target)||!['purchase','payment'].includes(target.kind))addCode(codes,'relation_invalid');
    else{const used=index.refunds.get(keyText(target.key))??{cents:0n,quantity:0};
      if(BigInt(v.cents??'0')>BigInt(moneyOf(target)?.cents??'0')-used.cents||(v.quantity??0)>(target.quantity?.count??0)-used.quantity)addCode(codes,'refund_exceeds');}
  }
  return codes;
}
/** Panel validation for a proposed correction. O(J + entries + accounts/rows).
 * It checks row existence and refund remainder, but affordability is still folded. */
export function validateLedgerCorrection(raw:unknown,rawLedger:unknown):{ok:boolean;codes:string[]} {
  try {const d=decodeLedgerCorrection(raw),ledger=snapshotLedger(rawLedger,work());if(!d.ok)return {ok:false,codes:[d.code]};
    if(!Array.isArray(ledger.accounts)||!Array.isArray(ledger.entries))return {ok:false,codes:['ledger_invalid']};
    const index=emptyIndex();for(const e of ledger.entries)indexDetail(index,e);
    const codes=d.value.values?userValuesStateCodes(d.value.values,ledger.accounts,index):[];return {ok:codes.length===0,codes};
  }catch{return {ok:false,codes:['ledger_correction_invalid']};}
}
function sameParties(a:StoredLedgerEntry,key:Extract<LedgerKey,unknown[]>):boolean {return [partyKey(a.payer),partyKey(a.payee),partyKey(a.receiver)].every((p,i)=>p===key[i+3]);}
function keySpan(key:LedgerKey):LedgerSpan|null {return Array.isArray(key)&&key[6]?{start:key[6][0],end:key[6][1]}:null;}
function spanPair(a:LedgerSpan|null,b:LedgerSpan|null):boolean {return a===null?b===null:b!==null&&overlaps(a,b);}
function directionFamily(kind:string,amount:boolean):'money'|'goods' {return kind==='consume'||!amount?'goods':'money';}
function correctionOverlap(e:StoredLedgerEntry,c:LedgerCorrection):boolean {
  if(!Array.isArray(c.anchor)||c.anchor.length!==9)return false;
  const k=c.anchor as Extract<LedgerKey,unknown[]>;
  const giver=c.anchorAmount===null&&['purchase','income'].includes(k[2])?k[4]:k[3];
  return directionFamily(e.kind,moneyOf(e)!==null)===directionFamily(k[2],c.anchorAmount!==null&&k[2]!=='consume')&&directionParty(e)===giver
    &&spanPair(e.act,keySpan(k))&&(partyKey(e.payee)===k[4]||partyAccount(e.payee)===null);
}
export interface LedgerClaims {claims:{key:LedgerKey;correction:LedgerCorrection}[];posts:LedgerCorrection[];unmatchedVoids:LedgerCorrection[];blocked:{key:LedgerKey;codes:string[]}[]}
/** One-to-one correction rematching, latest sequence first. O(C*64), no row cap.
 * Exact keys win; fuzzy matches must retain kind, all parties and overlapping evidence. */
export function matchLedgerCorrections(rawEntries:unknown,rawCorrections:unknown):LedgerDecoded<LedgerClaims> {
  try {
    const entries=snapshot(rawEntries) as StoredLedgerEntry[];if(!Array.isArray(entries)||entries.length>64||!entries.every(storedEntryOK))return {ok:false,code:'ledger_record_invalid'};
    const corrections=correctionOrder(decodeCorrections(rawCorrections,[]).filter(c=>c.anchor&&!unbookedAnchorOK(c.anchor)&&!(typeof c.anchor==='string'&&c.anchor.startsWith('legacy:'))),work(),true);
    const claimed=new Set<string>(),claims:LedgerClaims['claims']=[],posts:LedgerCorrection[]=[],unmatchedVoids:LedgerCorrection[]=[],blocked:LedgerClaims['blocked']=[];
    for(const c of corrections) {
      let target=entries.find(e=>keyText(e.key)===keyText(c.anchor!)&&!claimed.has(keyText(e.key)));
      if(!target&&Array.isArray(c.anchor)) {
        const k=c.anchor as Extract<LedgerKey,unknown[]>,span=keySpan(k),amount=c.anchorAmount===undefined?c.values?.cents??null:c.anchorAmount;
        const candidates=entries.filter(e=>!claimed.has(keyText(e.key))&&e.kind===k[2]&&sameParties(e,k)&&spanPair(e.act,span)
          &&(itemKey(e)===k[7]||!!itemKey(e)&&!!k[7]&&(itemKey(e).includes(k[7])||k[7].includes(itemKey(e)))));
        const overlap=(e:StoredLedgerEntry)=>e.act&&span?Math.min(e.act.end,span.end)-Math.max(e.act.start,span.start):0;
        candidates.sort((a,b)=>overlap(b)-overlap(a)||Number(moneyOf(b)?.cents===amount)-Number(moneyOf(a)?.cents===amount)
          ||(Array.isArray(a.key)?a.key[8]:0)-(Array.isArray(b.key)?b.key[8]:0));target=candidates[0];
      }
      if(target){claimed.add(keyText(target.key));claims.push({key:target.key,correction:c});}
      else if(c.action==='void')unmatchedVoids.push(c);else if(c.values)posts.push(c);
    }
    for(const c of [...posts,...unmatchedVoids])for(const e of entries)if(!claimed.has(keyText(e.key))&&correctionOverlap(e,c)) {
      let row=blocked.find(x=>keyText(x.key)===keyText(e.key));if(!row){row={key:e.key,codes:[]};blocked.push(row);}addCode(row.codes,c.action==='void'?'overlaps_voided_entry':'duplicate_of_user_entry');
    }
    return {ok:true,value:{claims,posts,unmatchedVoids,blocked}};
  }catch{return {ok:false,code:'ledger_corrections_invalid'};}
}

export interface LedgerLegacyHooks {
  work:LedgerWork; sideEffects:boolean; corrections:ReadonlyMap<string,LedgerCorrection>;
  correct:(state:LedgerMutableState,raw:unknown,correction:LedgerCorrection)=>LedgerDetail;
  demote:(raw:unknown,code:string)=>LedgerDetail;
}
export interface LedgerLegacyResult {state:LedgerMutableState;receipts:WorldEffectReceipt[];issues:WorldIssue[];details:LedgerDetail[];sideEffects:boolean}
export interface LedgerFoldBridge {
  initial:LedgerMutableState;validSources:readonly WorldSourceEffects[];issues:WorldIssue[];
  legacy:(state:LedgerMutableState,source:WorldSourceEffects,hooks:LedgerLegacyHooks)=>LedgerLegacyResult;
  readers:(source:WorldSourceEffects,region:LedgerRegion)=>string[];
  serialize:(state:LedgerMutableState)=>WorldState;
  /** Internal running observer, called once at each complete source boundary. */
  step?:(position:number,timeMs:number,firstIssue:string|null)=>void;
}
interface SourceLayout {
    positions: readonly number[];
    length: number;
}

// Transient positions preserve source boundaries while the fold uses compact records.
const sourceLayouts = new WeakMap<readonly WorldSourceEffects[], SourceLayout>();

/** Enumerate present array indices in O(own properties + P log P), independent of declared length. */
function sourceIndices(raw: unknown[]): number[] {
    const length = raw.length;
    const indices = Object.getOwnPropertyNames(raw)
        .filter(key => INTEGER.test(key) && Number(key) < raw.length)
        .map(Number)
        .sort((left, right) => left - right);
    if (raw.length !== length)
        throw new Error('source_array_changed');
    return indices;
}

/** Read transient source positions: zero-based original indices and original array length.
 * Prepared arrays return their retained layout; ordinary arrays enumerate present positions.
 * Unreadable arrays return an empty layout. No persistent state is changed. */
export function ledgerSourceLayout(sources: readonly WorldSourceEffects[]): SourceLayout {
    const prepared = sourceLayouts.get(sources);
    if (prepared)
        return prepared;
    try {
        return {positions: sourceIndices(sources as WorldSourceEffects[]), length: sources.length};
    }
    catch {
        return {positions: [], length: 0};
    }
}

/** Detect optional ledger data in O(own properties + P log P), without scanning absent indices.
 * Missing source positions require a diagnostic, but never activate account folding.
 * Unreadable array boundaries enter the guarded ledger path rather than escaping validation. */
export function hasLedgerData(sources: unknown, options: unknown): boolean {
    try {
        if (record(options) && ['accountEvents', 'corrections'].some(key => {
            const field = Object.getOwnPropertyDescriptor(options, key);
            return Boolean(field && (!('value' in field) || field.value != null &&
                (!Array.isArray(field.value) || field.value.length > 0)));
        }))
            return true;
        if (!Array.isArray(sources))
            return false;
        const positions = sourceIndices(sources);
        return positions.some(position => {
            const source = sources[position];
            return record(source) && ['ledger', 'ledgerMarks'].some(key => {
                const field = Object.getOwnPropertyDescriptor(source, key);
                return Boolean(field && (!('value' in field) || field.value != null));
            });
        });
    }
    catch {
        return true;
    }
}

function emptyLedger(ledgerWork: LedgerWork = work()): LedgerFold {
    return {
        accounts: [], entries: [], unbooked: [], unrecordedMarks: 0,
        open: {
            pending: [], unaffordable: [], committed: [], deposits: [], quoted: []
        }, director: {
            unpaid: [], unposted: [], committed: [], unbooked: []
        }, unmatchedVoids: [], unconfigured: [], diagnostics: [], work: ledgerWork
    };
}

/** Create an empty ledger carrying only a missing-source diagnostic in O(1).
 * holeCount is the positive number of missing array positions, supplied by the source layout.
 * No accounts or entries are created; the result has zero work and does not validate its internal count. */
export function createSourceHoleLedger(holeCount: number): LedgerFold {
    // Missing source positions create no ledger work, including no purchase-visit counter.
    const ledger = emptyLedger({
        jsonNodes: 0,
        text: 0,
        scans: 0,
        entries: 0,
        pairs: 0,
        events: 0,
        sourceVisits: 0,
        rowCopies: 0,
    });
    ledger.diagnostics.push({code: 'ledger_source_holes', id: null, reason: String(holeCount)});
    return ledger;
}

/** Identify an empty container carrying exactly one missing-source diagnostic in O(1).
 * Accepts a folded ledger or an absent value; returns false for absent values and real ledgers with accounts.
 * This internal classification does not validate persisted ledger records. */
export function isSourceHoleLedger(ledger: LedgerFold | undefined): boolean {
    return ledger?.accounts.length === 0 && ledger.diagnostics.length === 1
        && ledger.diagnostics[0]?.code === 'ledger_source_holes';
}

function safeReaders(bridge:LedgerFoldBridge,source:WorldSourceEffects,region:LedgerRegion):string[] {
  try {const ids=bridge.readers(source,region);return stringList(ids)?[...new Set(ids)].sort():[];}catch{return [];}
}
function legacyDetail(source:WorldSourceEffects,raw:unknown,code:string,bridge:LedgerFoldBridge):LedgerDetail {
  let r:Record<string,unknown>={};try{const v=snapshot(raw);if(record(v))r=v;}catch{/* Invalid candidates keep a data-only record. */}
  const e=fallbackEntry(source,{id:'k0',kind:'money',whole:true});e.key=legacyLedgerKey(source.sourceId,source.revision,String(r.effectId??''))??`legacy:${identity(source)}`;
  e.kind=KINDS.includes(r.kind as string)?r.kind as LedgerKind:'purchase';e.actor.id=typeof r.ownerId==='string'?r.ownerId:'player';e.payer={account:e.actor.id};e.receiver=e.payer;
  const located=typeof r.quote==='string'?locate(source.text,r.quote,work()):null;e.act=spanOK(r.evidence)?r.evidence:located?.span??null;
  e.item=typeof r.item==='string'?{sourceId:source.sourceId,revision:source.revision,span:e.act??{start:0,end:Math.max(1,source.text.length)},quote:r.item}:null;
  e.origin='user';
  return {...e,role:source.role,laterSources:0,disposition:'unaffordable',category:null,layer:'outer',codes:[code,'caused_by_correction'],
    readerIds:safeReaders(bridge,source,entryRegion(e)),due:null,unitPrice:null,unaffordable:null,candidates:[],causedByCorrection:true};
}

/** Detach source records without invoking their accessors. Invalid JSON remains
 * an invalid source for the existing validator, with safely readable identity retained.
 * O(present records and their JSON); original positions are retained without visiting holes. */
export function prepareLedgerSources(raw: unknown): WorldSourceEffects[] {
    let layout: SourceLayout;
    let positions: number[];
    // A proxy can throw even while reading length, before any per-source guard runs.
    try {
        if (!Array.isArray(raw))
            return [];
        positions = sourceIndices(raw);
        layout = sourceLayouts.get(raw) ?? {positions, length: raw.length};
    }
    catch {
        return [];
    }
    const out: WorldSourceEffects[] = [];
    // Enumerated positions remain bounded even when the array contains billions of holes.
    for (const i of positions)
        try {
            if (!record(raw[i])) {
                out.push(raw[i] as WorldSourceEffects);
                continue;
            }
            const fields = Object.getOwnPropertyDescriptors(raw[i]);
            const base: Record<string, unknown> = {};
            for (const [key, decodedValue] of Object.entries(fields))
                if (key !== 'ledger' && key !== 'ledgerMarks') {
                    if (!('value' in decodedValue))
                        throw 0;
                    Object.defineProperty(base, key, {
                        value: decodedValue.value, enumerable: true
                    });
                }
            const detached = snapshot(base) as Record<string, unknown>;
            for (const key of ['ledger', 'ledgerMarks']) {
                const decodedValue = fields[key];
                if (!decodedValue)
                    continue;
                if ('value' in decodedValue && decodedValue.value === undefined)
                    throw 0;
                let value: unknown = {};
                try {
                    if (!('value' in decodedValue))
                        throw 0;
                    value = snapshot(decodedValue.value);
                }
                catch { /* Invalid optional data is a ledger diagnostic, never a source issue. */ }
                Object.defineProperty(detached, key, {
                    value, enumerable: true
                });
            }
            out.push(detached as unknown as WorldSourceEffects);
        }
        catch {
            let id = '';
            let revision = 0;
            try {
                const decodedValue = Object.getOwnPropertyDescriptors(raw[i]);
                if (textId(decodedValue.sourceId?.value))
                    id = decodedValue.sourceId.value;
                if (safeInt(decodedValue.revision?.value, 1))
                    revision = decodedValue.revision.value;
            }
            catch { /* Keep invalid identity bounded. */ }
            out.push({
                sourceId: id, revision, invalid: NaN
            } as unknown as WorldSourceEffects);
        }
    sourceLayouts.set(out, layout);
    return out;
}
/** Detach the options boundary before the host reads clocks or correction arrays. O(J).
 * Bad optional data becomes a visible ledger diagnostic, without invoking accessors. */
export function prepareLedgerOptions(raw:unknown,readClocks=true):LedgerFoldOptions {
  if(raw===undefined)return {};
  try {
  if(!record(raw))return {accountEvents:{} as LedgerAccountEvent[]};
  const out:Record<string,unknown>={};
  if(readClocks)for(const key of ['nowMs','monotonicFloorMs']){const value=raw[key];if(value!==undefined)out[key]=value;}
  for(const key of ['accountEvents','corrections']){
    const d=Object.getOwnPropertyDescriptor(raw,key);if(!d)continue;
    // Rows are detached and validated independently by their decoders.
    if(!('value'in d))out[key]={};else if(d.value!=null)out[key]=d.value;
  }
  return out as LedgerFoldOptions;
  }catch{return {};}
}
function rawLedgerOptions(raw:unknown,diagnostics:LedgerDiagnostic[]):LedgerFoldOptions {
  if(raw===undefined)return {};
  try {if(!record(raw))throw 0;const out:LedgerFoldOptions={};
    for(const k of ['accountEvents','corrections'] as const){const d=Object.getOwnPropertyDescriptor(raw,k);if(d){if(!('value'in d))throw 0;if(d.value!==undefined)Object.defineProperty(out,k,{value:d.value,enumerable:true});}}
    return out;
  }catch{appendDiagnostics(diagnostics, {code:'ledger_options_invalid',id:null});return {};}
}
function regionSame(a:LedgerRegion,b:LedgerRegion):boolean {return 'whole'in a?'whole'in b:'span'in b&&overlaps(a.span,b.span);}
/** Test a decoded void's anchor ownership in O(1); legacy and unbooked anchors cannot identify a target here. */
function ownsRestatementAnchor(correction: LedgerCorrection,
    playerPostSources: ReadonlyMap<string, string>): boolean {
    const anchor = correction.anchor;
    if (Array.isArray(anchor)) {
        return anchor.length === 9 && anchor[0] === correction.sourceId;
    }

    return typeof anchor === 'string' && anchor.startsWith('user:')
        && playerPostSources.get(anchor.slice(5)) === correction.sourceId;
}

function closeLedger(ledger:LedgerFold,sources:readonly WorldSourceEffects[]):void {
  const indices=new Map(sources.map((s,i)=>[identity(s),i]));
  for(const e of ledger.entries)e.laterSources=Math.max(0,sources.length-1-(indices.get(identity(e))??sources.length-1));
  for(const u of ledger.unbooked)u.laterSources=Math.max(0,sources.length-1-(indices.get(identity(u))??sources.length-1));
  const bySource=new Map<string,LedgerDetail[]>(),byKey=new Map<string,LedgerDetail>();
  for(const e of ledger.entries){const id=identity(e),list=bySource.get(id)??[];list.push(e);bySource.set(id,list);byKey.set(keyText(e.key),e);}
  // Each source has at most one counterpart edge. Each side contains at most
  // 64 model entries, 64 demoted legacy effects, plus the source's user
  // corrections. The pair bound includes those user and legacy records.
  const pendingRestates=new Map<LedgerDetail,LedgerDetail>();
  const counterparts=new Map<string,string|null>(),seen=new Map<string,WorldSourceEffects>();let previous:WorldSourceEffects|undefined,lastUser:WorldSourceEffects|undefined;
  for(const s of sources){const reply=s.replyTo?seen.get(JSON.stringify([s.replyTo.id,s.replyTo.revision])):undefined;
    const other=s.role==='user'?(previous?.role==='assistant'?previous:undefined):s.replyTo?(reply?.role==='user'?reply:undefined):lastUser;
    counterparts.set(identity(s),other?identity(other):null);seen.set(identity(s),s);previous=s;if(s.role==='user')lastUser=s;}
  for(let i=0;i<sources.length;i++) {
    const s=sources[i]!,other=counterparts.get(identity(s));if(!other)continue;
    const a=bySource.get(identity(s))??[],b=bySource.get(other)??[];
    for(const [left,right] of [[a,b],[b,a]])for(const e of left)if(e.disposition==='pending'&&['general','unconfigured','account_uncertain'].includes(e.category??'')) {
      const match=right.find(t=>{ledger.work.pairs++;return posted(t)&&matchingTransaction(e,t,e.category==='general');});
      if(match&&!pendingRestates.has(e))pendingRestates.set(e,match);
    }
  }
  for(const [e,target] of pendingRestates){e.category='restated';e.relation={kind:'restates',target:target.key,span:null};addCode(e.codes,'restates');e.layer=outerDetail(e)?'outer':'inner';}
  const settled=new Map<string,bigint>(),balances=new Set<string>();
  for(const e of ledger.entries)if(posted(e)&&e.relation?.target){const key=keyText(e.relation.target);
    if(e.relation.kind==='settles')settled.set(key,(settled.get(key)??0n)+BigInt(moneyOf(e)?.cents??'0'));
    if(e.relation.kind==='balance_of')balances.add(key);}
  for(const e of ledger.entries)if(e.status==='committed'&&moneyOf(e)){const due=BigInt(moneyOf(e)!.cents)-(settled.get(keyText(e.key))??0n);e.due=(due>0n?due:0n).toString();}
  const open=ledger.open;
  const visibleOpenEntries = ledger.entries.filter(entry => !entry.codes.includes('restates_voided_entry'));
  open.pending = visibleOpenEntries.filter(entry => entry.disposition === 'pending'
    && ['general', 'unconfigured', 'account_uncertain'].includes(entry.category ?? '')
    && !settled.has(keyText(entry.key)));
  open.unaffordable = visibleOpenEntries.filter(entry => entry.disposition === 'unaffordable'
    && !entry.causedByCorrection && entry.laterSources <= 5);
  open.committed = visibleOpenEntries.filter(entry => entry.status === 'committed' && entry.disposition !== 'void'
    && (entry.due === null || BigInt(entry.due) > 0n) && !['restated', 'untracked'].includes(entry.category ?? ''));
  open.quoted = visibleOpenEntries.filter(entry => entry.status === 'quoted'
    && entry.disposition !== 'void' && entry.laterSources < 20);
  open.deposits = [];
  for (const entry of visibleOpenEntries) {
    if (entry.kind !== 'payment' || !posted(entry) || entry.relation?.kind !== 'settles'
      || !entry.relation.target || balances.has(keyText(entry.key))) continue;

    const targetEntry = byKey.get(keyText(entry.relation.target));
    if (targetEntry?.status === 'committed' && targetEntry.due !== null && BigInt(targetEntry.due) > 0n) {
      entry.due = targetEntry.due;
      open.deposits.push(entry);
    }
  }
  ledger.director={unpaid:open.unaffordable,unposted:open.pending,committed:open.committed,unbooked:ledger.unbooked.filter(u=>u.layer==='outer'&&!u.dismissed)};
  const unconfigured=new Map<string,{kind:string;label:string|null}>();
  for(const e of ledger.entries)for(const p of [e.payer,e.payee,e.receiver])if(p&&'unconfigured'in p){const value={kind:p.unconfigured.kind,label:p.unconfigured.label?.quote??null};unconfigured.set(JSON.stringify(value),value);}
  ledger.unconfigured=[...unconfigured.values()];
}
/** Fold only the ledger-enabled branch, sharing the caller's legacy state and validators.
 * At fixed settings and event limits, text and counterpart work are linear in
 * total prose and sources. A counterpart side has <= 128+C records; event
 * position lookup uses one O(S log S) index. Trial state/index copies cost O(rows+purchases)
 * per source; work.rowCopies counts account-view synchronization, not trial clones.
 * Rows include the baseline, <= 256 per new account, and <= 64*sourceCount plus
 * user-post item rows. Total row work is the sum of those per-source row counts. */
export function foldLedgerWorld(settings:WorldSettings,sources:readonly WorldSourceEffects[],rawOptions:unknown,bridge:LedgerFoldBridge):WorldFoldResult {
  try {
    const step=Object.getOwnPropertyDescriptor(bridge,'step');if(step&&(!('value'in step)||typeof step.value!=='function'))throw 0;
    const fields=Object.getOwnPropertyDescriptors(bridge);
    if(['initial','validSources','issues','legacy','readers','serialize'].some(k=>!fields[k]||!('value'in fields[k]!)))throw 0;
    return foldLedgerWorldUnchecked(settings,sources,rawOptions,bridge);
  }catch {
    const ledger=emptyLedger();appendDiagnostics(ledger.diagnostics, {code:'ledger_bridge_invalid',id:null});
    return {state:{mode:'story',timeMs:0,publicTime:false,actorIds:[],balances:[],inventory:[]},receipts:[],issues:[],ledger};
  }
}

function foldLedgerWorldUnchecked(settings: WorldSettings, sources: readonly WorldSourceEffects[], rawOptions:
    unknown, bridge: LedgerFoldBridge): WorldFoldResult {
    const ledger = emptyLedger();
    const ledgerWork = ledger.work;
    const layout = ledgerSourceLayout(sources);
    const holes = layout.length - layout.positions.length;
    if (holes > 0)
        appendDiagnostics(ledger.diagnostics, {
            code: 'ledger_source_holes', id: null, reason: String(holes)
        });
    const issues = [...bridge.issues];
    const receipts: WorldEffectReceipt[] = [];
    let state = bridge.initial;
    try {
        const correctionHistory: LedgerCorrection[] = [];
        const options = rawLedgerOptions(rawOptions, ledger.diagnostics);
        const events = decodeEvents(options.accountEvents, ledger.diagnostics);
        const corrections = decodeCorrections(options.corrections, ledger.diagnostics, ledgerWork, correctionHistory);
        const accounts = implicitAccounts(settings, state, ledger.diagnostics);
        ledger.accounts = accounts;
        let sideEffects = false;
        for (const event of events)
            if (event.kind === 'create')
                sideEffects = applyAccountEvent(event, accounts, state, ledger.diagnostics, ledgerWork) || sideEffects;
        const valid = new Set(bridge.validSources);
        const validIds = new Set(bridge.validSources.map(identity));
        const activeCorrections = corrections.filter(correction => correction.action === 'adjustment'
            || validIds.has(identity(correction as LedgerSourceRef)));
        const userPostKeys = new Set<string>();
        const playerPostSources = new Map<string, string>();
        // O(history): visit each decoded historical correction once, including inactive posts.
        // Source ownership deliberately ignores revision; post IDs are unique in decoded history.
        for (const correction of correctionHistory) {
            if (correction.action === 'post') {
                userPostKeys.add(identity(correction as LedgerSourceRef) + '/' + `user:${correction.id}`);
                playerPostSources.set(correction.id, correction.sourceId!);
            }
        }
        const voidedRestatementTargets = new Set<string>();
        const correctionsBySource = new Map<string, LedgerCorrection[]>();
        for (const correction of activeCorrections.filter(correction => correction.action
            !== 'adjustment')) {
            const id = identity(correction as LedgerSourceRef);
            const list = correctionsBySource.get(id) ?? [];
            list.push(correction);
            correctionsBySource.set(id, list);
            // Reuse the existing active-correction pass; each anchor takes constant Map/Set lookups.
            if (correction.action === 'void' && ownsRestatementAnchor(correction, playerPostSources)) {
                voidedRestatementTargets.add(keyText(correction.anchor!));
            }
        }
        const positioned = new Map<number, (LedgerAccountEvent | LedgerCorrection)[]>();
        const positions = ledgerEventPositions(sources, events, correctionHistory, ledgerWork);
        if (!positions.ok)
            throw 0;
        const historicalBoundaries = new Set<number>();
        const at = (position: number, value: LedgerAccountEvent | LedgerCorrection) => {
            const list = positioned.get(position) ?? [];
            list.push(value);
            positioned.set(position, list);
        };
        for (const row of positions.value.accountEvents)
            if (row.event.kind !== 'create')
                at(row.position, row.event);
        const activeAdjustmentIds = new Set(activeCorrections.filter(correction => correction.action
            === 'adjustment').map(correction => correction.id));
        for (const row of positions.value.adjustments) {
            historicalBoundaries.add(row.position);
            if (activeAdjustmentIds.has(row.correction.id))
                at(row.position, row.correction);
        }
        const historicalSources = new Set(correctionHistory.filter(correction => correction.action
            !== 'adjustment' && validIds.has(identity(correction as LedgerSourceRef)))
            .map(correction => identity(correction as LedgerSourceRef)));
        const index = emptyIndex();
        const previous: WorldSourceEffects[] = [];
        const seenSources = new Map<string, WorldSourceEffects>();
        let lastUser: WorldSourceEffects | undefined;
        const getCounterpart = (source: WorldSourceEffects): string | null => {
            const reply = source.replyTo ? seenSources.get(JSON.stringify([source.replyTo.id,
                source.replyTo.revision])) : undefined;
            const other = source.role === 'user' ? (previous.at(-1)?.role === 'assistant' ? previous.at(-1) :
                undefined) : source.replyTo ? (reply?.role === 'user' ? reply : undefined) : lastUser;
            return other ? identity(other) : null;
        };
        const quoteReaders = (source: WorldSourceEffects, entry: StoredLedgerEntry):
            NonNullable<LedgerDetail['quoteReaderIds']> => {
            const partyReaders = (field: 'payer' | 'payee' | 'receiver'): string[] => {
                const party = entry[field];
                const quote = party && 'external' in party ? party.external : entry.externalQuotes?.[field];
                return quote ? safeReaders(bridge, source, { span: quote.span }) : [];
            };
            const itemSource = entry.item &&
                (identity(entry.item) === identity(source) ? source : seenSources.get(identity(entry.item)));
            return {
                payer: partyReaders('payer'), payee: partyReaders('payee'), receiver: partyReaders('receiver'),
                item: itemSource && entry.item ? safeReaders(bridge, itemSource, { span: entry.item.span }) : [],
            };
        };
        const getContext = (source: WorldSourceEffects, entry: StoredLedgerEntry, forced: boolean, targetState =
            state): VerifyContext => ({
            accounts, source, previous: previous.slice(-6), counterpart: getCounterpart(source), index,
            state: targetState,
            work: ledgerWork, forced, mode: 'fold', readers: safeReaders(bridge, source, entryRegion(entry)),
            quoteReaderIds: quoteReaders(source, entry), voidedRestatementTargets
        });
        const applyUser = (correction: LedgerCorrection, source: WorldSourceEffects, targetState = state,
            original?: StoredLedgerEntry): LedgerDetail => {
            const storedEntry = correction.values ? userEntry(correction, source, original) : original
                ?? fallbackEntry(source, {
                id: 'k0', kind: 'money', whole: true
            });
            const legacyReplacement = typeof original?.key === 'string' && original.key.startsWith('legacy:');
            if (correction.action === 'void')
                return {
                    ...storedEntry, origin: 'user', role: source.role, laterSources: 0, disposition: 'void',
                    category: null, layer: 'inner',
                    codes: legacyReplacement ? ['caused_by_correction'] : [],
                    readerIds: safeReaders(bridge, source, entryRegion(storedEntry)), due: null,
                    unitPrice: storedEntry.unitPrice, unaffordable: null, candidates: [], causedByCorrection: false
                };
            const codes = correction.values ? userValuesStateCodes(correction.values, accounts, index) :
                ['ledger_correction_invalid'];
            const evaluated = verifyEntry(storedEntry, getContext(source, storedEntry, true, targetState));
            if (codes.length) {
                evaluated.detail.disposition = 'pending';
                evaluated.detail.category = 'general';
                evaluated.detail.codes = codes;
                evaluated.detail.layer = 'outer';
            }
            if (legacyReplacement) {
                addCode(evaluated.detail.codes, 'caused_by_correction');
                evaluated.detail.causedByCorrection = evaluated.detail.disposition === 'unaffordable';
            }
            applyLegs(evaluated, targetState, accounts);
            return evaluated.detail;
        };
        const append = (decodedValue: LedgerDetail) => {
            ledger.entries.push(decodedValue);
            indexDetail(index, decodedValue);
            ledgerWork.entries++;
            sideEffects = true;
        };
        const boundary = (position: number, source: WorldSourceEffects | null, posts: LedgerCorrection[] = []) => {
            // Withdrawal changes balances, but cannot remove an earlier ledger-side event from history.
            sideEffects ||= historicalBoundaries.has(position) || source !== null &&
                historicalSources.has(identity(source));
            const items = correctionOrder([...(positioned.get(position) ?? []), ...posts], ledgerWork);
            for (const item of items)
                if ('action' in item) {
                    const body = item.action === 'adjustment' ? {
                        sourceId: '', revision: 1, role: 'user' as const, text: '', acceptedAtMs: 0, plan: {
                            observations: [], unresolved: []
                        }, candidates: []
                    } : source ?? bridge.validSources.find(currentSource => identity(currentSource) === identity(
                        item as LedgerSourceRef));
                    if (body)
                        append(applyUser(item, body));
                }
                else
                    sideEffects = applyAccountEvent(item, accounts, state, ledger.diagnostics, ledgerWork) ||
                        sideEffects;
        };
        boundary(0, null);
        for (let position = 0; position < sources.length; position++) {
            const source = sources[position]!;
            ledgerWork.sourceVisits++;
            if (!valid.has(source)) {
                boundary(position + 1, null);
                bridge.step?.(position, state.timeMs, issues[0]?.code ?? null);
                continue;
            }
            const local = correctionsBySource.get(identity(source)) ?? [];
            const legacyCorrections = new Map<string, LedgerCorrection>();
            for (const correction of local)
                if (typeof correction.anchor === 'string' && correction.anchor.startsWith('legacy:'))
                    legacyCorrections.set(correction.anchor, correction);
            const legacy = bridge.legacy(state, source, {
                work: ledgerWork, sideEffects, corrections: legacyCorrections,
                correct: (trial, raw, correction) => applyUser(correction, source, trial, legacyDetail(source, raw,
                    '', bridge)),
                demote: (raw, code) => legacyDetail(source, raw, code, bridge)
            });
            state = legacy.state;
            receipts.push(...legacy.receipts);
            issues.push(...legacy.issues);
            for (const decodedValue of legacy.details)
                append(decodedValue);
            sideEffects ||= legacy.sideEffects;
            syncAccounts(accounts, state, ledgerWork);
            const marks = source.ledgerMarks != null ? decodeLedgerMarks(source.ledgerMarks) : null;
            const book = source.ledger != null ? decodeLedger(source.ledger) : null;
            const modelEntries = book?.ok ? book.value.entries.filter(storedEntry => storedEntry.sourceId === source
                .sourceId && storedEntry.revision === source.revision) : [];
            const matched = matchLedgerCorrections(modelEntries, local);
            const claims = matched.ok ? matched.value : {
                claims: [], posts: [], unmatchedVoids: [], blocked: []
            };
            ledger.unmatchedVoids.push(...claims.unmatchedVoids.filter(correction => !userPostKeys.has(
                identity(correction as LedgerSourceRef) + '/' + String(correction.anchor))));
            const ordered = dependencyOrder(modelEntries, ledgerWork);
            for (const storedEntry of ordered.ordered) {
                const claim = claims.claims.find(correction => keyText(correction.key) === keyText(
                    storedEntry.key));
                if (claim) {
                    append(applyUser(claim.correction, source, state, storedEntry));
                    continue;
                }
                const evaluated = verifyEntry(storedEntry, {
                    ...getContext(source, storedEntry, storedEntry.origin === 'user'),
                    pairedLeader: ordered.leaders.has(storedEntry)
                });
                const blocked = claims.blocked.find(blockedClaim =>
                    keyText(blockedClaim.key) === keyText(storedEntry.key));
                if (blocked || ordered.cycles.has(keyText(storedEntry.key))) {
                    evaluated.detail.disposition = 'pending';
                    evaluated.detail.category = 'general';
                    evaluated.detail.layer = 'outer';
                    for (const code of blocked?.codes ?? ['relation_invalid'])
                        addCode(evaluated.detail.codes, code);
                }
                applyLegs(evaluated, state, accounts);
                append(evaluated.detail);
            }
            // Index voids once so independent posts cost O(C), including user posts.
            const voidPostAnchors = new Set<string>();
            for (const correction of local) {
                ledgerWork.correctionVisits = (ledgerWork.correctionVisits ?? 0) + 1;
                if (correction.action === 'void' && typeof correction.anchor === 'string')
                    voidPostAnchors.add(correction.anchor);
            }
            const posts = [...local.filter(correction => correction.action === 'post' &&
                    !correction.anchor && !voidPostAnchors.has(`user:${correction.id}`)), ...claims.posts];
            boundary(position + 1, source, posts);
            const unbooked: LedgerUnbooked[] = book?.ok ? [...book.value.unbooked] : [];
            if (book && !book.ok) {
                appendDiagnostics(ledger.diagnostics, {
                    code: book.code, id: source.sourceId
                });
                if (marks?.ok)
                    for (let i = 0; i < marks.value.money.length; i++) {
                        const markedRegion = marks.value.money[i]!;
                        unbooked.push({
                            sourceId: source.sourceId, revision: source.revision,
                            ...('whole' in markedRegion ? { whole: true as const } : { span: markedRegion }),
                            mark: `k${i + 1}`, reason: 'ledger_record_invalid', by: 'code'
                        });
                    }
            }
            if (!book && marks?.ok)
                ledger.unrecordedMarks += marks.value.money.length;
            if (marks && !marks.ok)
                appendDiagnostics(ledger.diagnostics, {
                    code: marks.code, id: source.sourceId
                });
            for (const u of unbooked)
                if (u.sourceId === source.sourceId && u.revision === source.revision) {
                    const anchor: LedgerUnbookedAnchor = [u.sourceId, u.revision,
                        'whole' in u ? { whole: true } : { span: u.span }, u.reason];
                    const dismissed = local.some(correction => correction.action === 'void' &&
                        correction.anchor && keyText(correction.anchor) === keyText(anchor))
                        || posts.some(correction => correction.fromMark &&
                            regionSame(correction.fromMark, u));
                    ledger.unbooked.push({
                        ...u, readerIds: safeReaders(bridge, source, u), laterSources: 0, dismissed,
                        layer: u.by === 'code' && u.reason !== 'entry_withdrawn' ? 'outer' : 'inner'
                    });
                }
            previous.push(source);
            seenSources.set(identity(source), source);
            if (source.role === 'user')
                lastUser = source;
            bridge.step?.(position, state.timeMs, issues[0]?.code ?? null);
        }
        syncAccounts(accounts, state, ledgerWork);
        // Closed accounts are unavailable during the fold and retain their closing values in the final view.
        for (const ledgerAccount of accounts)
            if (ledgerAccount.status === 'closed') {
                for (const ledgerRow of ledgerAccount.rows)
                    state.balances.set(assetIdentity(ledgerAccount.id, ledgerRow.unit), {
                        ownerId: ledgerAccount.id, unit: ledgerRow.unit, cents: decimalCents(ledgerRow.value),
                        tracked: ledgerRow.tracked, readerIds: new Set(ledgerRow.readerIds)
                    });
                for (const i of ledgerAccount.items)
                    state.inventory.set(assetIdentity(ledgerAccount.id, i.item), {
                        ownerId: ledgerAccount.id, item: i.item, count: i.count, readerIds: new Set(i.readerIds)
                    });
            }
        closeLedger(ledger, bridge.validSources);
    }
    catch {
        appendDiagnostics(ledger.diagnostics, {
            code: 'ledger_input_invalid', id: null
        });
    }
    let serialized: WorldState;
    try {
        serialized = bridge.serialize(state);
    }
    catch {
        serialized = {
            mode: settings.mode, timeMs: state.timeMs, publicTime: settings.publicTime,
            actorIds: Object.keys(settings.actorLabels).sort(), balances: [], inventory: []
        };
        appendDiagnostics(ledger.diagnostics, {
            code: 'ledger_serialize_failed', id: null
        });
    }
    return {
        state: serialized, receipts, issues, ledger
    };
}

/** Prefix positions are resolved against the complete list before any slicing. The
 * injected fold is the public world-state fold; invalid settings keep its exception. */
export function foldLedgerPrefix(settings: WorldSettings, rawSources: unknown, count: number, rawOptions: unknown,
    fold: (settings: WorldSettings, sources: readonly WorldSourceEffects[], options?: LedgerFoldOptions) =>
    WorldFoldResult): LedgerDecoded<WorldFoldResult> {
    try {
        if (!Array.isArray(rawSources) || !safeInt(count) || count > ledgerSourceLayout(rawSources).length)
            return {
                ok: false, code: 'ledger_prefix_invalid'
            };
        const sources = prepareLedgerSources(rawSources);
        const layout = ledgerSourceLayout(sources);
        const presentCount = layout.positions.filter(position => position < count).length;
        const diagnostics: LedgerDiagnostic[] = [];
        const options = rawLedgerOptions(rawOptions, diagnostics);
        const positions = positionIndex(sources);
        const events = decodeEvents(options.accountEvents, diagnostics).filter(storedEntry => storedEntry.kind
            === 'create' ||
            positions.at(storedEntry.after) <= presentCount);
        const correctionHistory: LedgerCorrection[] = [];
        decodeCorrections(options.corrections, diagnostics, work(), correctionHistory);
        const adjustmentPositions = new Map(correctionHistory.filter(correction => correction.action
            === 'adjustment')
            .map(correction => [`user:${correction.id}`, positions.at(correction.after ?? null)]));
        const corrections = correctionHistory.filter(correction => {
            const position = positions.exact.get(identity(correction as LedgerSourceRef)) ?? 0;
            if (correction.action === 'adjustment')
                return (adjustmentPositions.get(`user:${correction.id}`) ?? 0) <= presentCount;
            if (correction.action === 'clear' && typeof correction.anchor === 'string' &&
                adjustmentPositions.has(correction.anchor)) {
                return adjustmentPositions.get(correction.anchor)! <= presentCount;
            }
            return position > 0 && position <= presentCount;
        });
        const clock: LedgerFoldOptions = {};
        if (record(rawOptions))
            for (const k of ['nowMs', 'monotonicFloorMs'] as const) {
                const decodedValue = Object.getOwnPropertyDescriptor(rawOptions, k);
                if (decodedValue && 'value' in decodedValue && safeInt(decodedValue.value))
                    clock[k] = decodedValue.value;
            }
        const prefixSources = sources.slice(0, presentCount);
        sourceLayouts.set(prefixSources, {positions: layout.positions.slice(0, presentCount), length: count});
        const value = fold(settings, prefixSources, {
            ...clock, accountEvents: events, corrections
        });
        if (value.ledger) {
            const merged: LedgerDiagnostic[] = [];
            appendDiagnostics(merged, ...value.ledger.diagnostics);
            const seen = new Set(value.ledger.diagnostics.map(decodedValue => JSON.stringify(decodedValue)));
            appendDiagnostics(merged, ...diagnostics.filter(decodedValue => !seen.has(JSON.stringify(decodedValue))));
            value.ledger.diagnostics = merged;
        }
        return {
            ok: true, value
        };
    }
    catch (error) {
        if (error instanceof Error && error.message === 'invalid_world_settings')
            throw error;
        return {
            ok: false, code: 'ledger_prefix_invalid'
        };
    }
}
/** Query accounts at a zero-based prefix boundary measured in source positions.
 * Closed accounts are omitted unless requested. Invalid prefixes return ledger_prefix_invalid;
 * invalid settings retain the injected fold's exception. Source-hole diagnostics create no accounts. */
export function accountsAt(
  settings: WorldSettings,
  sources: unknown,
  count: number,
  options: unknown,
  fold: (settings: WorldSettings, sources: readonly WorldSourceEffects[], options?: LedgerFoldOptions) => WorldFoldResult,
  includeClosed = false,
): LedgerDecoded<LedgerAccount[]> {
  try {
    const result = foldLedgerPrefix(settings, sources, count, options, fold);
    return accountsFromFold(settings, result, includeClosed);
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_world_settings') throw error;
    return {ok: false, code: 'ledger_prefix_invalid'};
  }
}
/** Derives accounts from an existing world prefix without folding it again. O(account rows).
 * Closed accounts are omitted unless requested; a failed prefix retains its decoded error.
 * Invalid settings retain their exception, while malformed fold data returns ledger_prefix_invalid. */
export function accountsFromFold(
  settings: WorldSettings,
  result: LedgerDecoded<WorldFoldResult>,
  includeClosed = false,
): LedgerDecoded<LedgerAccount[]> {
  try {
    if (!result.ok)
      return result;

    const ledger = result.value.ledger;
    const diagnosticOnly = isSourceHoleLedger(ledger);
    // Diagnostic-only and legacy folds expose the same implicit account query.
    const accounts = ledger && !diagnosticOnly
      ? ledger.accounts
      : implicitAccounts(settings, stateFromWorld(result.value.state));
    return {ok: true, value: accounts.filter(account => includeClosed || account.status === 'active')};
  } catch (error) {
    if (error instanceof Error && error.message === 'invalid_world_settings')
      throw error;
    return {ok: false, code: 'ledger_prefix_invalid'};
  }
}

function stateFromWorld(s:WorldState):LedgerMutableState {return {timeMs:s.timeMs,
  balances:new Map(s.balances.map(r=>[assetIdentity(r.ownerId,r.unit),{ownerId:r.ownerId,unit:r.unit,cents:decimalCents(r.value),readerIds:new Set(r.readerIds)}])),
  inventory:new Map(s.inventory.map(i=>[assetIdentity(i.ownerId,i.item),{ownerId:i.ownerId,item:i.item,count:i.count,readerIds:new Set(i.readerIds)}]))};}
/** Counterfactual attribution never changes posting decisions and never affects proposal feedback. */
export function markLedgerCorrections(result:WorldFoldResult,withoutCorrections:WorldFoldResult,w:LedgerWork=work()):WorldFoldResult {
  try {
    if(!result.ledger||!withoutCorrections.ledger)return result;
    result={...result,ledger:snapshotLedger(result.ledger,w)};
    const booked=new Set(withoutCorrections.ledger.entries.filter(posted).map(e=>keyText(e.key)));
    for(const e of result.ledger!.entries)if(e.disposition==='unaffordable'&&booked.has(keyText(e.key))){e.causedByCorrection=true;addCode(e.codes,'caused_by_correction');}
    result.ledger!.open.unaffordable=result.ledger!.entries.filter(e=>e.disposition==='unaffordable'&&!e.causedByCorrection&&e.laterSources<=5);
    result.ledger!.director.unpaid=result.ledger!.open.unaffordable;return result;
  }catch{return result;}
}

function accountVisible(a:LedgerAccount,readerId:string):boolean {return a.readers.includes(readerId)||a.actors.includes(readerId);}

function ledgerFact(storedEntry: LedgerDetail, ledger: LedgerFold, readerId: string, allQuotes = false): LedgerFact {
    const visible = (proposedEntry: LedgerParty | null) => {
        const id = partyAccount(proposedEntry);
        const ledgerAccount = ledger.accounts.find(account => account.id === id);
        return ledgerAccount && accountVisible(ledgerAccount, readerId) ? ledgerAccount.id : null;
    };
    const payer = visible(storedEntry.payer);
    const payee = visible(storedEntry.payee);
    const receiver = visible(storedEntry.receiver);
    const moneyValue = moneyOf(storedEntry);
    const canRead = (field: 'payer' | 'payee' | 'receiver' | 'item') => allQuotes || readerId === 'player' ||
        storedEntry.quoteReaderIds?.[field].includes(readerId);
    const quote = (field: 'payer' | 'payee' | 'receiver') => {
        if (!canRead(field))
            return undefined;
        const party = storedEntry[field];
        return party && 'external' in party &&
            party.external ? party.external.quote : storedEntry.externalQuotes?.[field]?.quote;
    };
    const actor = storedEntry.actor.id === 'player' ||
        ledger.accounts.some(ledgerAccount => ledgerAccount.kind === 'private' &&
            ledgerAccount.id === storedEntry.actor.id) ? storedEntry.actor.id : null;
    return {
        sourceId: storedEntry.sourceId, revision: storedEntry.revision, kind: storedEntry.kind,
        status: storedEntry.status, time: storedEntry.time, actor,
        item: canRead('item') ? storedEntry.item?.quote ?? null : null,
        quantity: storedEntry.quantity?.count ?? null, cents: moneyValue?.cents ?? null, unit: storedEntry.row,
        ...(payer ? { payer } : {}), ...(payee ? { payee } : {}), ...(receiver ? { receiver } : {}),
        ...(quote('payer') ? { payerQuote: quote('payer') } : {}),
        ...(quote('payee') ? { payeeQuote: quote('payee') } : {}),
        ...(quote('receiver') ? { receiverQuote: quote('receiver') } : {}),
        ...(storedEntry.due !== null ? { due: storedEntry.due } : {}),
        ...(storedEntry.unaffordable &&
            !storedEntry.causedByCorrection ? { unaffordable: storedEntry.unaffordable } : {})
    };
}
/** Data-only character projection: no codes, doubts, proofs, unobserved quotes, or hidden account IDs.
 * O(J + entries * bounded accounts). Private totals remain in world-state's row projection. */
export function projectLedger(raw:unknown,readerId:string,w:LedgerWork=work()):{ledger:LedgerProjection;accounts:{id:string;kind:'organisation'|'shared';label:string}[]} {
  const empty=()=>({ledger:{entries:[],open:{pending:[],unaffordable:[],committed:[],deposits:[],quoted:[]}},accounts:[]});
  try {
    const ledger=snapshotLedger(raw,w);
    const facts=(entries:LedgerDetail[])=>entries.filter(e=>e.readerIds.includes(readerId)&&!e.causedByCorrection&&e.kind!=='adjustment'&&e.disposition!=='void'&&e.category!=='untracked').map(e=>ledgerFact(e,ledger,readerId));
    return {ledger:{entries:facts(ledger.entries.filter(posted)),open:{pending:facts(ledger.open.pending),unaffordable:facts(ledger.open.unaffordable),committed:facts(ledger.open.committed),
      deposits:facts(ledger.open.deposits),quoted:facts(ledger.open.quoted)}},accounts:ledger.accounts.filter(a=>a.kind!=='private'&&accountVisible(a,readerId)).map(a=>({id:a.id,kind:a.kind as 'organisation'|'shared',label:a.label}))};
  }catch{return empty();}
}
/** Player panel facts include observed transactions and controlled accounts. O(J+E*A).
 * Admin mode returns a detached complete ledger; ordinary panel rows carry safe numeric handles. */
export function ledgerPanelView(raw:unknown,readerId='player',admin=false,w:LedgerWork=work()):LedgerDecoded<LedgerFold|{
  entries:(LedgerFact&{handle:number;key:LedgerKey|null;disposition:LedgerDisposition;category:LedgerCategory|null;layer:'outer'|'inner';codes:string[];candidates:string[]})[];
  accounts:LedgerAccount[];unbooked:LedgerUnbookedDetail[];unrecordedMarks:number}> {
  try {
    const ledger=snapshotLedger(raw,w);if(admin)return {ok:true,value:ledger};
    const controls=(p:LedgerParty|null)=>{const a=ledger.accounts.find(a=>a.id===partyAccount(p));return !!a&&accountVisible(a,readerId);};
    const entries=ledger.entries.flatMap((e,handle)=>{
      if(e.kind==='adjustment'&&readerId!=='player')return [];
      const parties=[e.payer,e.payee,e.receiver,e.behalf?.party??null];
      if(!e.readerIds.includes(readerId)&&!parties.some(controls))return [];
      const key=parties.every(p=>partyAccount(p)===null||controls(p))?e.key:null;
      return [{...ledgerFact(e,ledger,readerId),handle,key,disposition:e.disposition,category:e.category,layer:e.layer,codes:e.codes,
        candidates:e.candidates.filter(id=>id==='other'||ledger.accounts.some(a=>a.id===id&&accountVisible(a,readerId)))}];
    });
    const accounts=ledger.accounts.filter(a=>accountVisible(a,readerId)).map(a=>({...a,rows:a.rows.filter(r=>r.readerIds.includes(readerId)),items:a.items.filter(i=>i.readerIds.includes(readerId))}));
    return {ok:true,value:{entries,accounts,unbooked:ledger.unbooked.filter(u=>u.readerIds.includes(readerId)),unrecordedMarks:ledger.unrecordedMarks}};
  }catch{return {ok:false,code:'ledger_invalid'};}
}

export interface LedgerProtectedEntry {entry:StoredLedgerEntry;correctionId:string;action:LedgerCorrection['action']}
export interface LedgerFreeze {
  source:LedgerSourceRef; S:LedgerProtectedEntry[];
  keptEntries:StoredLedgerEntry[];keptUnbooked:LedgerUnbooked[];
  frozenMarks:LedgerMark[];sendMarks:LedgerMark[];skip:boolean;
  outcome?:'complete';stop?:'frozen';work:LedgerWork;
}
export interface LedgerMerged {entries:StoredLedgerEntry[];work:LedgerWork}
export interface LedgerFinalized {entries:StoredLedgerEntry[];unbooked:LedgerUnbooked[];skip:boolean;outcome?:'complete';stop?:'frozen';work:LedgerWork}
export interface LedgerFinalizationInput {
  source:LedgerText;marks:LedgerMark[];last:LedgerProposalResult|null;frozen?:LedgerFreeze;
  passed?:{id:string;entry:StoredLedgerEntry}[];withdrawn?:string[];
  uncoveredReasons?:Record<string,LedgerUnbookedReason>;defaultReason?:LedgerUnbookedReason;
}
function marksOK(m:unknown):m is LedgerMark[] {
  return Array.isArray(m)&&m.length<=64&&new Set(m.map(x=>record(x)?x.id:null)).size===m.length
    &&m.every(x=>record(x)&&typeof x.id==='string'&&MARK.test(x.id)&&x.kind===(x.id[0]==='k'?'money':'use')&&regionOK(x));
}
function entriesOK(e:unknown):e is StoredLedgerEntry[] {return Array.isArray(e)&&e.length<=64&&e.every(storedEntryOK);}
function directionParty(e:StoredLedgerEntry):string {
  return partyKey(directionFamily(e.kind,moneyOf(e)!==null)==='goods'&&['purchase','income'].includes(e.kind)?e.payee:e.payer);
}
function sameFamily(a:StoredLedgerEntry,b:StoredLedgerEntry):boolean {
  return directionFamily(a.kind,moneyOf(a)!==null)===directionFamily(b.kind,moneyOf(b)!==null);
}
function duplicateDuringMerge(a:StoredLedgerEntry,b:StoredLedgerEntry):boolean {
  return sameFamily(a,b)&&directionParty(a)===directionParty(b)
    &&(partyKey(a.payee)===partyKey(b.payee)||partyAccount(a.payee)===null||partyAccount(b.payee)===null)
    &&(a.act===null||b.act===null||overlaps(a.act,b.act))
    &&(itemKey(a)===itemKey(b)||moneyOf(a)!==null&&moneyOf(b)!==null&&moneyOf(a)!.cents===moneyOf(b)!.cents);
}
function blockStored(e:StoredLedgerEntry,code:string):void {addCode(e.checks.codes,code);pending(e.checks,'general');}

/** Freeze current money/use marks against the current correction set. O(J+C*64+64^2).
 * S is a read-only view of corrected entries and user posts for the stage. The saved
 * keptEntries remain byte-for-byte equivalent under serializeLedger; correction
 * values and posts are never copied into a second write authority. */
export function freezeLedger(rawOld:unknown,rawMarks:unknown,rawCorrections:unknown,rawSource:unknown):LedgerDecoded<LedgerFreeze> {
  try {
    const old=rawOld===null?null:decodeLedger(rawOld),marks=snapshot(rawMarks) as LedgerMark[],source=snapshot(rawSource) as LedgerText;
    if(old&&!old.ok||!marksOK(marks)||!sourceOK(source)||typeof source.text!=='string')return {ok:false,code:'ledger_freeze_invalid'};
    const entries=old?.ok?old.value.entries:[],unbooked=old?.ok?old.value.unbooked:[];
    if(entries.some(e=>identity(e)!==identity(source))||unbooked.some(e=>identity(e)!==identity(source)))return {ok:false,code:'ledger_source_mismatch'};
    const w=work(),corrections=decodeCorrections(rawCorrections,[],w).filter(c=>c.action!=='adjustment'&&identity(c as LedgerSourceRef)===identity(source)),matched=matchLedgerCorrections(entries,corrections);
    if(!matched.ok)return matched;
    const S:LedgerProtectedEntry[]=[],claimed=new Set<string>();
    for(const claim of matched.value.claims){const original=entries.find(e=>keyText(e.key)===keyText(claim.key))!;claimed.add(keyText(original.key));
      S.push({entry:claim.correction.values?userEntry(claim.correction,source,original):original,correctionId:claim.correction.id,action:claim.correction.action});}
    for(const c of [...corrections.filter(c=>c.action==='post'),...matched.value.posts])if(c.values)S.push({entry:userEntry(c,source),correctionId:c.id,action:c.action});
    const frozenMarks=marks.filter(m=>{
      if('whole'in m&&S.length>0)return true;
      return S.some(s=>{w.pairs++;return regionOverlap(m,entryRegion(s.entry));})
        ||corrections.some(c=>{w.pairs++;return c.action==='post'&&!!c.fromMark&&regionSame(c.fromMark,m);});
    });
    const frozenIds=new Set(frozenMarks.map(m=>m.id)),sendMarks=marks.filter(m=>!frozenIds.has(m.id));
    const preserve=(region:LedgerRegion)=>frozenMarks.some(m=>{w.pairs++;return regionOverlap(region,m);})||!marks.some(m=>{w.pairs++;return regionOverlap(region,m);});
    const keptEntries=entries.filter(e=>claimed.has(keyText(e.key))||preserve(entryRegion(e)));
    const keptUnbooked=unbooked.filter(preserve),skip=sendMarks.length===0;
    return {ok:true,value:{source:{sourceId:source.sourceId,revision:source.revision},S,keptEntries,keptUnbooked,frozenMarks,sendMarks,skip,
      ...(skip?{outcome:'complete' as const,stop:'frozen' as const}:{}),work:w}};
  }catch{return {ok:false,code:'ledger_freeze_invalid'};}
}

/** Append deterministically keyed entries without rewriting any kept key or value.
 * O(J+64 log 64+64^2); total stored entries, including kept ones, must fit 64. */
export function mergeLedgerEntries(rawKept:unknown,rawNew:unknown):LedgerDecoded<LedgerMerged> {
  try {
    const kept=snapshot(rawKept) as StoredLedgerEntry[],entries=snapshot(rawNew) as StoredLedgerEntry[],w=work();
    if(!entriesOK(kept)||!entriesOK(entries))return {ok:false,code:'ledger_merge_invalid'};
    if(kept.length+entries.length>64)return {ok:false,code:'ledger_rerun_limit'};
    const previous=entries.map(e=>keyText(e.key));assignKeys(entries,kept);
    const remap=new Map(entries.map((e,i)=>[previous[i]!,e.key]));
    for(const e of entries)if(e.relation?.target){const target=remap.get(keyText(e.relation.target));if(target)e.relation={...e.relation,target};}
    for(const e of entries)if(kept.some(k=>{w.pairs++;return duplicateDuringMerge(e,k);}))blockStored(e,'duplicate_of_user_entry');
    return {ok:true,value:{entries:[...kept,...entries],work:w}};
  }catch{return {ok:false,code:'ledger_merge_invalid'};}
}

/** Settle parked entries against posts created after run start. Call once, before
 * storing the result. O(J+P*64), no correction row cap. Normal corrections are rematched on fold. */
export function settleLedgerEntries(rawEntries:unknown,rawNewPosts:unknown):LedgerDecoded<LedgerMerged> {
  try {
    const entries=snapshot(rawEntries) as StoredLedgerEntry[],w=work();if(!entriesOK(entries))return {ok:false,code:'ledger_record_invalid'};
    const posts=decodeCorrections(rawNewPosts,[]).filter(c=>c.action==='post');
    for(const e of entries)for(const c of posts)if(identity(e)===identity(c as LedgerSourceRef)&&c.values){w.pairs++;
      let duplicate=false;
      if(c.fromMark)duplicate=regionOverlap(entryRegion(e),c.fromMark);
      else {const p=userEntry(c,{sourceId:c.sourceId!,revision:c.revision!,role:'user',text:''});
        duplicate=sameFamily(e,p)&&directionParty(e)===directionParty(p)
          &&(partyKey(e.payee)===partyKey(p.payee)||partyAccount(e.payee)===null)
          &&moneyOf(e)!==null&&moneyOf(p)!==null&&moneyOf(e)!.cents===moneyOf(p)!.cents;}
      if(duplicate)blockStored(e,'duplicate_of_user_entry');
    }
    return {ok:true,value:{entries,work:w}};
  }catch{return {ok:false,code:'ledger_settlement_invalid'};}
}

/** Write merged entries and unbooked rows for uncovered marks and previously accepted entries
 * that disappeared, whether dropped or confirmed withdrawn. Regions use UTF-16 offsets.
 * A disappeared entry's invalid mark id is omitted: retaining it would make the decoder reject the record.
 * Returns detached entries and unbooked rows, or the existing validation/limit error code.
 * O(J + 64^2 + H); accepted-ID history H is capped at the existing 4096-row budget.
 * Exceeding either 64-row storage budget requires callers to retain the prior valid record. */
export function finalizeLedgerRun(raw:unknown):LedgerDecoded<LedgerFinalized> {
    try {
        const input = snapshot(raw) as LedgerFinalizationInput;
        const {source, marks, last} = input;
        const ledgerWork = work();
        if (!sourceOK(source) || typeof source.text !== 'string' || !marksOK(marks)) {
            return {ok: false, code: 'ledger_finalization_invalid'};
        }

        const frozen = input.frozen;
        if (frozen && (!entriesOK(frozen.keptEntries) || !Array.isArray(frozen.keptUnbooked) ||
            !frozen.keptUnbooked.every(unbookedOK) || !marksOK(frozen.frozenMarks) ||
            identity(frozen.source) !== identity(source))) {
            return {ok: false, code: 'ledger_freeze_invalid'};
        }
        if (frozen?.skip) {
            return {ok: true, value: {
                entries: frozen.keptEntries,
                unbooked: frozen.keptUnbooked,
                skip: true,
                outcome: 'complete',
                stop: 'frozen',
                work: ledgerWork
            }};
        }
        if (last && (!Array.isArray(last.entries) || last.entries.length > 64 ||
            !last.entries.every(checked => textId(checked.id) && storedEntryOK(checked.entry)) ||
            !Array.isArray(last.unbooked) || !last.unbooked.every(unbookedOK))) {
            return {ok: false, code: 'ledger_finalization_invalid'};
        }

        const fresh = last?.entries.map(checked => checked.entry) ?? [];
        const merged = mergeLedgerEntries(frozen?.keptEntries ?? [], fresh);
        if (!merged.ok) return merged;
        ledgerWork.pairs += merged.value.work.pairs;
        if (merged.value.entries.some(entry => identity(entry) !== identity(source))) {
            return {ok: false, code: 'ledger_source_mismatch'};
        }

        const unbooked = [...(frozen?.keptUnbooked ?? []), ...(last?.unbooked ?? [])];
        // Historical dropped rows must not change which delivered marks are uncovered.
        const covered = new Set([
            ...merged.value.entries.map(entry => entry.mark.id),
            ...unbooked.map(item => item.mark),
            ...(frozen?.frozenMarks ?? []).map(mark => mark.id)
        ]);
        for (const mark of marks) {
            if (covered.has(mark.id)) continue;

            const reason = input.uncoveredReasons?.[mark.id] ?? input.defaultReason ?? 'not_covered';
            if (!CODE_UNBOOKED.includes(reason) || ['entry_dropped', 'entry_withdrawn'].includes(reason)) {
                return {ok: false, code: 'ledger_uncovered_reason_invalid'};
            }
            unbooked.push({
                sourceId: source.sourceId,
                revision: source.revision,
                ...('whole' in mark ? {whole: true as const} : {span: mark.span}),
                mark: mark.id,
                by: 'code',
                reason
            });
        }

        const passed = input.passed ?? last?.state.everAccepted ?? [];
        const withdrawn = input.withdrawn ?? last?.state.confirmedWithdrawn ?? [];
        if (!Array.isArray(passed) || passed.length > 4096 ||
            !passed.every(previous => textId(previous.id) && storedEntryOK(previous.entry)) ||
            !stringList(withdrawn, 4096)) {
            return {ok: false, code: 'ledger_history_invalid'};
        }

        const present = new Set(last?.entries.map(checked => checked.id) ?? []);
        const confirmed = new Set(withdrawn);
        const seen = new Set<string>();
        for (const previous of passed) {
            if (present.has(previous.id) || seen.has(previous.id)) continue;

            seen.add(previous.id);
            const entry = previous.entry;
            if (identity(entry) !== identity(source)) return {ok: false, code: 'ledger_source_mismatch'};

            // Reuse the decoder's grammar: mark ids may contain a whole-source fallback.
            // Matching is linear in the ID length, already bounded by storedEntryOK.
            unbooked.push({
                sourceId: source.sourceId,
                revision: source.revision,
                ...entryRegion(entry),
                ...(MARK.test(entry.mark.id) ? {mark: entry.mark.id} : {}),
                by: 'code',
                reason: confirmed.has(previous.id) ? 'entry_withdrawn' : 'entry_dropped'
            });
        }
        if (unbooked.length > 64) return {ok: false, code: 'ledger_rerun_limit'};

        return {ok: true, value: {entries: merged.value.entries, unbooked, skip: false, work: ledgerWork}};
    } catch {
        return {ok: false, code: 'ledger_finalization_invalid'};
    }
}
