import {foldForMatch, scriptQuoteSearch} from '../common/script-fold.ts';
import {amountExpressionWork,
  type AmountExpression, type QuantityExpression, type RateExpression, type AmountUnit} from '../common/amount-expressions.ts';
import {executeCalculation, replayCalculation, listCalculationLeaves,
  type CalculationExecution, type CalculationTree, type ReferenceValues, type ReferenceValue, type JsonValue} from '../core/calculation-requests.ts';
import type {WorldSettings, WorldSourceEffects, WorldFoldResult, WorldIssue, WorldEffectReceipt, WorldState} from './world-state.ts';

/** Bounds for persisted records and pairwise work; source prose has no length limit. */
export const LEDGER_LIMITS = Object.freeze({entries:64, unbooked:64, accounts:256, rows:256, aliases:8,
  labelCodePoints:40, history:4096, events:16384, jsonNodes:262144, jsonDepth:80, refLength:256, moneyDigits:18});
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
export interface LedgerWork {jsonNodes:number; text:number; scans:number; entries:number; pairs:number; events:number; sourceVisits:number; rowCopies:number; purchaseVisits?:number; correctionVisits?:number; positionVisits?:number}
export interface LedgerDiagnostic {code:string; id:string|null; index?:number; reason?:string}
export interface LedgerAccount extends Omit<LedgerAccountDefinition,'rows'|'items'> {
  rows:{unit:string;value:string;tracked:boolean;readerIds:string[]}[];
  items:{item:string;count:number;readerIds:string[]}[];
}
export interface LedgerDetail extends StoredLedgerEntry {
  role:'user'|'assistant'; laterSources:number; disposition:LedgerDisposition; category:LedgerCategory|null; layer:'outer'|'inner';
  codes:string[]; readerIds:string[]; due:string|null; unitPrice:string|null;
  unaffordable:{variant:'self'|'account'|'other'|'user';shortfallCents:string|null;shortfallQuantity:number|null}|null;
  candidates:string[]; causedByCorrection:boolean;
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
function keyOK(v:unknown):v is LedgerKey {
  if(typeof v==='string')return v.length>5&&(v.startsWith('user:')||v.startsWith('legacy:'));
  return Array.isArray(v)&&v.length===ARRAY_KEY_LENGTH&&textId(v[0])&&safeInt(v[1],1)&&KINDS.includes(v[2])
    &&[3,4,5,7].every(i=>typeof v[i]==='string')&&(v[6]===null||Array.isArray(v[6])&&v[6].length===2&&spanOK({start:v[6][0],end:v[6][1]}))&&safeInt(v[8],1);
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
function storedEntryOK(v:unknown):v is StoredLedgerEntry {
  if(record(v)){omitNull(v,['externalQuotes']);if(record(v.checks)){omitNull(v.checks,['unanswered']);if(record(v.checks.history))omitNull(v.checks.history,['accountQuestioned']);}}
  if(!sourceOK(v)||!record(v)||!keyOK(v.key)||!record(v.mark)||typeof v.mark.id!=='string'||!['money','use'].includes(v.mark.kind as string)||!regionOK(v.mark)
    ||!(KINDS.includes(v.kind as string)||v.kind==='adjustment'&&v.origin==='user')||!STATUSES.includes(v.status as string)||!TIMES.includes(v.time as string)
    ||!record(v.actor)||!(v.actor.id===null||typeof v.actor.id==='string')||!['name','self','speaker','addressee'].includes(v.actor.basis as string)
    ||!(v.actor.span===null||spanOK(v.actor.span))||!(v.act===null||spanOK(v.act))
    ||![v.payer,v.payee,v.receiver].every(p=>p===null||partyOK(p))||!['model','user'].includes(v.origin as string))return false;
  if(v.behalf!==null&&(!record(v.behalf)||!partyOK(v.behalf.party)||!(v.behalf.span===null||spanOK(v.behalf.span))||typeof v.behalf.located!=='boolean'))return false;
  if(v.item!==null&&(!sourceOK(v.item)||!quoteOK(v.item)))return false;
  if(v.quantity!==null&&(!record(v.quantity)||!safeInt(v.quantity.count,1)||typeof v.quantity.approx!=='boolean'||!proofOK(v.quantity.proof)
    ||!(v.quantity.ref===null||typeof v.quantity.ref==='string')))return false;
  if(![v.amount,v.stated,v.tendered].every(moneyOK)||!(v.row===null||textId(v.row))||!(v.unitPrice===null||centsOK(v.unitPrice)))return false;
  if(v.relation!==null&&(!record(v.relation)||!RELATIONS.includes(v.relation.kind as string)||!(v.relation.target===null||keyOK(v.relation.target))||!(v.relation.span===null||spanOK(v.relation.span))))return false;
  if(v.externalQuotes!==undefined&&(!record(v.externalQuotes)||!Object.entries(v.externalQuotes).every(([key,quote])=>['payer','payee','receiver'].includes(key)&&quote!==null&&quoteOK(quote))))return false;
  const c=v.checks;
  return Array.isArray(v.doubts)&&v.doubts.length<=DOUBTS.length&&v.doubts.every(d=>DOUBTS.includes(d))
    &&record(c)&&stringList(c.codes,128)&&Array.isArray(c.pending)&&c.pending.every(p=>CATEGORIES.includes(p))&&stringList(c.returned,128)
    &&(c.unanswered===undefined||stringList(c.unanswered,6)&&c.unanswered.every(code=>SEMANTIC_QUESTIONS.includes(code)))
    &&typeof c.actorGrounded==='boolean'&&typeof c.explicitParty==='boolean'&&record(c.first)
    &&(c.first.amount===null||centsOK(c.first.amount))&&(c.first.quantity===null||safeInt(c.first.quantity,1))&&typeof c.first.payer==='string'&&STATUSES.includes(c.first.status as string)
    &&record(c.history)&&Array.isArray(c.history.behalf)&&c.history.behalf.length<=64&&c.history.behalf.every(partyOK)
    &&typeof c.history.accountDoubts==='boolean'&&(c.history.accountQuestioned===undefined||typeof c.history.accountQuestioned==='boolean')&&Array.isArray(c.history.accountConfirm)&&c.history.accountConfirm.every(x=>['a','b','c'].includes(x));
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
export function serializeLedger(raw:unknown):LedgerDecoded<string> {
  const decoded=decodeLedger(raw);return decoded.ok?{ok:true,value:JSON.stringify(decoded.value)}:decoded;
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
export interface LedgerCheckedEntry {id:string;verdict:'returned'|'settled'|'flagged'|'accepted';codes:string[];read:Record<string,JsonValue>;entry:StoredLedgerEntry}
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
function staticEntry(p:NormalizedLedgerProposedEntry,c:LedgerProposalContext,used:Map<string,LedgerSpan[]>,texts:Map<string,LedgerText>,values:ReferenceValues,
  scans:Map<string,{quantities:QuantityExpression[];numbers:LedgerSpan[]}>,outside:string,w:LedgerWork):{entry:StoredLedgerEntry;returns:string[]} {
  const mark=c.marks.find(m=>m.id===p.mark)??{id:'k0',kind:'money' as const,whole:true as const};
  const e=fallbackEntry(c.source,mark),s=e.checks,returns:string[]=[];
  const flag=(code:string)=>addCode(s.codes,code),ret=(code:string,category?:LedgerCategory)=>{flag(code);addCode(returns,code);if(category)pending(s,category);};
  e.kind=p.kind;e.status=p.status;e.time=p.time;e.doubts=[...new Set(p.doubts)];for(const d of e.doubts)flag(d);
  if(mark.id==='k0')ret('unknown_mark');
  const occupied=used.get(p.mark)??[],markedAct=locate(c.source.text,p.act?.quote??null,w,mark,occupied),presentMarkedAct=markedAct??locate(c.source.text,p.act?.quote??null,w,mark),act=presentMarkedAct??locate(c.source.text,p.act?.quote??null,w);
  if(act){e.act=act.span;occupied.push(act.span);used.set(p.mark,occupied);}
  if(p.status==='settled'&&!presentMarkedAct){ret('act_quote_not_found','not_transacted');if(!act)flag('no_transaction_act');}
  const actorQuote=locate(c.source.text,p.actor.quote,w);e.actor={id:p.actor.id,basis:p.actor.basis,span:actorQuote?.span??null};
  const labels=knownActorLabels(c.settings,p.actor.id);
  if(!labels.length)e.actor.id=null;
  s.actorGrounded=labels.length>0&&(p.actor.basis==='name'?!!actorQuote&&labels.some(n=>foldForMatch(n)===foldForMatch(actorQuote.quote)):
    p.actor.id==='player'&&(p.actor.basis==='self'?c.source.role==='user'&&!!actorQuote&&actorQuote.quote.includes('我'):
      p.actor.basis==='speaker'?c.source.role==='user'&&p.actor.quote===null:c.source.role==='assistant'&&!!actorQuote&&['你','妳','您'].includes(actorQuote.quote)));
  e.payer=resolveParty(p.payer,c.source.text,w);e.payee=resolveParty(p.payee,c.source.text,w);e.receiver=p.receiver==null?e.payer:resolveParty(p.receiver,c.source.text,w);
  if(p.behalf){const q=locate(c.source.text,p.behalf.quote,w);e.behalf={party:resolveParty(p.behalf.party,c.source.text,w)!,span:q?.span??null,located:q!==null};
    if(!q){ret('behalf_quote_not_found');flag('agency_unverified');}}
  s.explicitParty=[e.payer,e.payee,e.receiver].some(x=>partyExplicit(x,e,c,w));
  if(!s.actorGrounded){ret('actor_not_grounded');if(act&&s.explicitParty)flag('owner_weak');else{pending(s,'not_transacted');flag('owner_not_grounded');}}
  if(act&&questionAct(c.source.text,act.span,w)){flag('act_in_question');if(c.source.role==='assistant'){ret('act_in_question','not_transacted');flag('question_sentence');}}
  if(actorQuote&&!locate(outside,p.actor.quote,w))flag('actor_in_quote');
  if(p.item){const body=[c.source,...c.previous].find(x=>x.sourceId===p.item!.in);const q=body?locate(body.text,p.item.quote,w):null;
    if(body&&q)e.item={sourceId:body.sourceId,revision:body.revision,...q};else{ret('item_quote_not_found');flag('item_unverified');}}
  const qtyResult=p.quantity&&p.quantity!=='one'?resolveNumber(p.quantity,c.readings,values,c.calculations,texts,'quantity',w):null;
  const qty=p.quantity==='one'?{count:1,approx:false,proof:null,ref:'one'}:qtyResult?.quantity??null;
  if(p.quantity!==null){e.quantity=qty??{count:1,approx:false,proof:null,ref:p.quantity};if(!qty){ret(qtyResult?.code??'quantity_unreadable');flag('quantity_assumed_one');}}
  if(e.quantity?.approx)flag('quantity_approximate');
  const resolved:ResolvedNumber[]=[];
  for(const field of ['amount','stated','tendered'] as const)if(p[field]!==null){const n=resolveNumber(p[field]!,c.readings,values,c.calculations,texts,'money',w);resolved.push(n);e[field]=n.money;
    if(n.code){ret(n.code,'general');flag('amount_unreadable');}}
  for(const r of resolved)for(const leaf of r.leaves) {
    if(leaf.reading!==null&&leaf.reading!==1)flag('reading_ambiguous');
    if(leaf.kind!=='amount'||!leaf.source||!leaf.span)continue;
    const body=texts.get(identity(leaf.source))!;
    if(e.item&&identity(e.item)===identity(leaf.source)&&leaf.span.end<=e.item.span.start&&foldForMatch(body.text.slice(leaf.span.start,leaf.span.end)).endsWith('块')
      &&[...body.text.slice(leaf.span.end,e.item.span.start)].every(ch=>WS.test(ch)))flag('kuai_before_item');
  }
  const amount=moneyOf(e);
  if(amount?.approx)flag('amount_approximate');if([e.amount,e.stated,e.tendered].some(a=>a&&!a.exact))flag('rounded');
  if(e.amount&&e.stated&&e.amount.cents!==e.stated.cents)flag('stated_differs');
  if(amount&&amount.proof?.leaves.filter(l=>['amount','entry_amount','balance'].includes(l.kind)).every(l=>l.kind==='amount'&&record(l.value)&&l.value.unit===null))flag('no_unit_word');
  if(p.status!=='settled'){flag('not_settled');pending(s,'not_transacted');}if(p.time!=='current'){flag('non_current');pending(s,'not_transacted');}
  if(!shapeParties(e))ret('party_shape','general');
  e.row=p.row;
  if(p.relation)e.relation={kind:p.relation.kind,target:null,span:locate(c.source.text,p.relation.quote??null,w)?.span??null};
  const matching=c.state?.history.filter(h=>h.id===p.id||h.mark===p.mark&&h.act!==null&&e.act!==null&&overlaps(h.act,e.act))??[];
  for(const h of matching){for(const b of h.checks.history.behalf)if(!s.history.behalf.some(x=>partyKey(x)===partyKey(b)))s.history.behalf.push(b);
    s.history.accountDoubts ||= h.checks.history.accountDoubts;
    if(h.checks.history.accountQuestioned||h.checks.returned.some(code=>code==='actor_not_authorised'||code==='payer_account_confirm'))s.history.accountQuestioned=true;
    for(const x of h.checks.history.accountConfirm)if(!s.history.accountConfirm.includes(x))s.history.accountConfirm.push(x);}
  if(e.behalf&&!s.history.behalf.some(x=>partyKey(x)===partyKey(e.behalf!.party)))s.history.behalf.push(e.behalf.party);
  s.history.accountDoubts ||= e.doubts.some(d=>['payer_unsure','account_unsure','agency_unsure'].includes(d));
  const ownPayer=c.accounts.find(a=>a.id===partyAccount(e.payer)&&a.kind==='private'&&a.id===e.actor.id);
  if(ownPayer){
    if(s.history.behalf.some(b=>partyKey(b)!==partyKey(e.payer))&&!s.history.accountConfirm.includes('a'))s.history.accountConfirm.push('a');
    if(s.history.accountDoubts&&!s.history.accountConfirm.includes('b'))s.history.accountConfirm.push('b');
    if(e.actor.id!==null&&c.accounts.some(a=>a.status==='active'&&a.kind!=='private'&&a.actors.includes(e.actor.id!))&&!s.history.accountConfirm.includes('c'))s.history.accountConfirm.push('c');
    if(s.history.accountConfirm.length){ret('payer_account_confirm');if(s.history.accountConfirm.some(x=>x==='a'||x==='b'))flag('private_payer_kept');}
  }
  s.first=matching.find(h=>h.id===p.id)?.checks.first??{amount:amount?.cents??null,quantity:e.quantity?.count??null,payer:partyKey(e.payer),status:e.status};
  if(s.first.amount!==(amount?.cents??null)||s.first.quantity!==(e.quantity?.count??null)||s.first.payer!==partyKey(e.payer))flag('changed_after_return');
  return {entry:e,returns};
}
/** O(source quantity candidates * bounded proposal proof leaves). A candidate is
 * a quantity only when a proposal row actually references it as one. */
function checkAmountOverlaps(rows:{entry:StoredLedgerEntry;returns:string[]}[],readings:LedgerReadings,
  scans:Map<string,{quantities:QuantityExpression[];numbers:LedgerSpan[]}>,w:LedgerWork):void {
  const references=new Map<string,{entry:StoredLedgerEntry;span:LedgerSpan}[]>();
  for(const {entry} of rows){
    const ref=entry.quantity?.ref,reading=ref&&QUANTITY_REF.test(ref)&&Object.hasOwn(readings,readingBase(ref))?readings[readingBase(ref)]:undefined;
    if(!entry.quantity?.proof&&reading?.type==='quantity'&&spanOK(reading.expression)){
      const key=identity(reading.source),list=references.get(key)??[];list.push({entry,span:{start:reading.expression.start,end:reading.expression.end}});references.set(key,list);
    }
    for(const proof of [entry.quantity?.proof,entry.amount?.proof,entry.stated?.proof,entry.tendered?.proof])for(const leaf of proof?.leaves??[]){
    if(leaf.kind!=='quantity'||!leaf.source||!leaf.span)continue;
    const key=identity(leaf.source),list=references.get(key)??[];list.push({entry,span:leaf.span});references.set(key,list);
    }
  }
  for(const row of rows)for(const money of [row.entry.amount,row.entry.stated,row.entry.tendered])for(const leaf of money?.proof?.leaves??[]){
    if(leaf.kind!=='amount'||!leaf.source||!leaf.span)continue;
    const key=identity(leaf.source),reading=Object.hasOwn(readings,leaf.base)?readings[leaf.base]:undefined;
    const expression=reading?.type==='amount'?reading.expression:null;
    const shortest=expression?.kind==='readings'?Math.min(...expression.readings.map(r=>r.end)):expression?.end;
    const direct=(references.get(key)??[]).filter(reference=>overlaps(leaf.span!,reference.span)
      &&!(scans.get(key)?.quantities??[]).some(q=>overlaps(q,reference.span)));
    if(direct.length){
      const own=direct.some(reference=>reference.entry===row.entry),code=own?'span_double_use':'amount_not_grounded';
      addCode(row.entry.checks.codes,code);pending(row.entry.checks,'general');addCode(row.returns,code);
      if(!own)addCode(row.entry.checks.codes,'amount_unreadable');
    }
    for(const q of scans.get(key)?.quantities??[]){
      w.pairs++;if(!overlaps(leaf.span,q))continue;
      const referenced=(references.get(key)??[]).filter(r=>overlaps(r.span,q));
      if(!referenced.length&&expression&&q.start>=expression.start&&q.end<=shortest!)continue;
      const own=referenced.some(r=>r.entry===row.entry),code=own?'span_double_use':'amount_not_grounded';
      addCode(row.entry.checks.codes,code);pending(row.entry.checks,'general');addCode(row.returns,code);
      if(!own)addCode(row.entry.checks.codes,'amount_unreadable');
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
function affordability(e:StoredLedgerEntry,a:LedgerAccount|undefined,c:VerifyContext):'self'|'account'|'other'|null {
  if(e.actor.id===null||!a||a.status!=='active'||e.checks.history.accountDoubts||e.checks.history.accountQuestioned||e.checks.codes.includes('actor_not_authorised')||e.checks.codes.includes('owner_weak')||e.checks.returned.some(code=>code==='actor_not_authorised'||code==='payer_account_confirm')||e.checks.history.behalf.some(p=>!behalfMatches(p,a)))return null;
  if(a.kind==='private'&&a.id===e.actor.id&&!c.accounts.some(x=>x.kind!=='private'&&x.status==='active'&&x.actors.includes(e.actor.id!)))return 'self';
  if(a.kind!=='private'&&a.actors.includes(e.actor.id))return 'account';
  if(a.id===e.actor.id||a.actors.includes(e.actor.id))return null;
  if(accountLabelsPresent(a,c.source.text,c.work))return 'other';
  if(a.kind!=='private'&&a.actors.some(id=>id!==e.actor.id&&c.accounts.some(x=>x.id===id&&accountLabelsPresent(x,c.source.text,c.work))))return 'other';
  return null;
}
function verifyEntry(e0:StoredLedgerEntry,c:VerifyContext):Evaluated {
  const e:StoredLedgerEntry={...e0,payer:resolveConfigured(e0.payer,c.accounts),payee:resolveConfigured(e0.payee,c.accounts),receiver:resolveConfigured(e0.receiver,c.accounts)};
  const codes=c.forced?[]:[...e.checks.codes],categories=c.forced?[]:[...e.checks.pending],returns:string[]=[];
  const d:LedgerDetail={...e,role:c.source.role,laterSources:0,disposition:'posted',category:null,layer:'inner',codes,readerIds:[...c.readers],due:null,unitPrice:e.unitPrice,
    unaffordable:null,candidates:[],causedByCorrection:false};
  const legs:LedgerLegs={money:[],goods:[]};
  const flag=(code:string)=>addCode(codes,code),pend=(code:string,category:LedgerCategory='general',returned=true)=>{flag(code);if(!categories.includes(category))categories.push(category);if(returned)addCode(returns,code);};
  const account=(p:LedgerParty|null)=>c.accounts.find(a=>a.id===partyAccount(p));
  const payer=account(e.payer),payee=account(e.payee),receiver=account(e.receiver);
  const target=e.relation?.target?c.index.keys.get(keyText(e.relation.target)):undefined;
  if(!c.forced) {
    for(const code of e.checks.unanswered??[])pend(code,code==='possible_duplicate'||code==='identical_entries'?'restated':code==='actor_not_authorised'?'general':'not_transacted',false);
    for(const party of [e.payer,e.payee,e.receiver,e.behalf?.party??null]) {
      const id=partyAccount(party);if(id!==null){const a=c.accounts.find(a=>a.id===id);if(!a||a.status==='closed')pend('unknown_account');}
    }
    if([e.payer,e.payee,e.receiver].some(p=>p&&'unconfigured'in p))pend('unconfigured_account','unconfigured',false);
    const currency=selectCurrency(e,e.kind==='income'?payee:payer??payee);d.row=currency.row;
    for(const code of currency.codes)if(code==='currency_assumed')flag(code);else pend(code);
    if(['purchase','payment','transfer'].includes(e.kind)&&payer&&(e.actor.id===null||!payer.actors.includes(e.actor.id))
      &&!(e.behalf?.located&&behalfMatches(e.behalf.party,payer))) {
      if(payer.kind==='private'&&c.mode==='proposal'&&!e.checks.returned.includes('actor_not_authorised'))pend('actor_not_authorised');else flag('actor_not_authorised');
      e.checks.history.accountQuestioned=true;
    }
    if(payer&&payer.kind!=='private'&&!e.behalf?.located&&![c.source,...c.previous].some(s=>accountLabelsPresent(payer,s.text,c.work)))flag('account_basis_weak');
    if(e.relation?.kind!=='in_addition_to'&&e.status==='settled'&&c.counterpart) {
      const other=(c.index.sources.get(c.counterpart)??[]).find(t=>{c.work.pairs++;return posted(t)&&matchingTransaction(e,t);});
      if(other){if(c.mode==='proposal'&&!e.checks.returned.includes('possible_duplicate'))pend('possible_duplicate','restated');else flag('possible_duplicate');}
    }
    if(e.relation) {
      const k=e.relation.kind;
      if(!target||target.disposition==='void') {
        if(c.mode==='fold'&&e.relation.target!==null) {
          if(k==='refund_of'||k==='balance_of')pend('relation_target_changed');
          else if(k==='paired_with')pend('relation_invalid');
          else if(k==='settles'||k==='in_addition_to')flag('relation_target_changed');
        } else pend('relation_invalid');
      } else if(k==='restates')pend('restates','restated',false);
      else if(k==='refund_of') {
        if(!['purchase','payment'].includes(target.kind)||!posted(target)||typeof target.key==='string'&&target.key.startsWith('legacy:'))pend('relation_invalid');
        const direction=(a:LedgerParty|null,b:LedgerParty|null)=>a!==null&&b!==null&&('account'in b?'account'in a&&a.account===b.account:'external'in b?'external'in a:'unconfigured'in a);
        if(!direction(e.payer,target.payee)||!direction(e.payee,target.payer))pend('refund_direction');
        const used=c.index.refunds.get(keyText(target.key))??{cents:0n,quantity:0};
        if(BigInt(moneyOf(e)?.cents??'0')>BigInt(moneyOf(target)?.cents??'0')-used.cents||(e.quantity?.count??0)>(target.quantity?.count??0)-used.quantity)pend('refund_exceeds');
      } else if(k==='balance_of'&&target.kind!=='payment'||k==='settles'&&target.status!=='committed'&&target.disposition!=='pending'
        ||k==='in_addition_to'&&e.relation.span===null||k==='paired_with'&&moneyOf(e)===null&&!posted(target))pend('relation_invalid');
    }
  }
  const m=moneyOf(e),amount=m?BigInt(m.cents):null;
  if(amount!==null)for(const [a,sign] of [[payer,-1n],[payee,1n]] as const) {
    const r=accountRow(a,d.row),row=r?c.state.balances.get(assetIdentity(a!.id,r.unit)):undefined;
    if(row&&row.tracked!==false&&a?.status==='active')legs.money.push({row,delta:amount*sign});
  }
  let giver:LedgerAccount|undefined,recipient:LedgerAccount|undefined,item=e.item?.quote??null;
  const quantity=e.quantity?.count??0;
  if(e.kind==='consume')giver=payer;
  else if(e.kind==='refund'&&target) {giver=c.accounts.find(a=>a.id===partyAccount(target.receiver));recipient=c.accounts.find(a=>a.id===partyAccount(target.payee));item=target.item?.quote??item;}
  else if(e.kind==='purchase'||e.kind==='income'){giver=payee;recipient=receiver;}
  else if(e.kind==='transfer'||e.kind==='refund'){giver=payer;recipient=receiver;}
  const out=inventoryRow(c.state,giver?.id??null,item),incoming=inventoryRow(c.state,recipient?.id??null,item);
  if(item&&quantity>0) {
    if(out&&giver?.status==='active')legs.goods.push({owner:giver.id,item:out.item,delta:-quantity,row:out});
    if(recipient?.status==='active'&&(incoming||recipient.rows.length+recipient.items.length>0))legs.goods.push({owner:recipient.id,item:incoming?.item??item,delta:quantity,row:incoming});
  }
  if(!c.forced) {
    if(e.kind==='consume'&&!out)pend('unregistered_item','untracked',false);
    else if(!legs.money.length&&!legs.goods.length)pend('untracked','untracked',false);
    else if(!legs.money.length&&legs.goods.length&&amount!==null)flag('payer_untracked');
  }
  d.category=categoryOf(categories);
  if(d.category)d.disposition='pending';
  if(c.mode==='fold') {
    if(!d.readerIds.length) {if(!c.forced)flag('no_observer');d.readerIds=[...new Set([e.actor.id,...(partyAccount(e.payer)==='player'?['player']:[])])].filter((id):id is string=>id!==null&&c.accounts.some(a=>a.kind==='private'&&a.id===id)).sort();}
    if(!d.category) {
      const fail=(a:LedgerAccount|undefined,cents:bigint|null,count:number|null):void=>{
        if(c.forced){d.causedByCorrection=true;flag('caused_by_correction');d.disposition='unaffordable';d.unaffordable={variant:'user',shortfallCents:cents?.toString()??null,shortfallQuantity:count};flag(cents!==null?'insufficient_funds':'insufficient_inventory');return;}
        const variant=affordability(e,a,c);
        if(variant){d.disposition='unaffordable';d.unaffordable={variant,shortfallCents:cents?.toString()??null,shortfallQuantity:count};flag(cents!==null?'insufficient_funds':'insufficient_inventory');}
        else{d.disposition='pending';d.category='account_uncertain';flag('account_uncertain');d.candidates=availableCandidates(e,c.accounts,true);}
      };
      const shortage=legs.money.find(l=>l.delta<0n&&l.row.cents < -l.delta);
      if(shortage) {
        if(!c.forced&&m!.approx&&m!.range&&(m!.range.min===null||BigInt(m!.range.min)<=shortage.row.cents)) {d.disposition='pending';d.category='general';flag('approximate_affordability');}
        else fail(payer,-shortage.delta-shortage.row.cents,null);
      }
      if(e.kind==='consume'&&!out){d.disposition='pending';d.category='untracked';flag('unregistered_item');}
      else if(e.kind==='income'&&item&&quantity>0&&(!out||out.count<quantity)) {flag('item_unverified_sale');legs.goods=[];}
      else if(e.kind==='purchase'&&out&&out.count<quantity) {flag('seller_stock_short');legs.goods=legs.goods.filter(l=>l.delta>0);}
      else if(d.disposition==='posted'&&out&&out.count<quantity)fail(giver,null,quantity-out.count);
      if(d.disposition==='posted'&&legs.goods.some(l=>l.delta>0&&!Number.isSafeInteger((l.row?.count??0)+l.delta))) {d.disposition='pending';d.category='general';flag('inventory_overflow');}
      if(d.disposition==='posted'&&!legs.money.length&&!legs.goods.length){d.disposition='pending';d.category='untracked';flag('untracked');}
    }
  }
  if(d.disposition==='posted'&&codes.some(code=>code!=='payer_account_confirm'))d.disposition='flagged';
  d.layer=outerDetail(d)?'outer':'inner';
  return {detail:d,legs,returns};
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
function dependencyOrder<T extends StoredLedgerEntry>(entries:T[]):{ordered:T[];cycles:Set<string>} {
  const byKey=new Map(entries.map(e=>[keyText(e.key),e])),done=new Set<string>(),active=new Set<string>(),cycles=new Set<string>(),ordered:T[]=[];
  const visit=(e:T):void=>{const key=keyText(e.key);if(done.has(key))return;if(active.has(key)){for(const k of active)cycles.add(k);return;}
    active.add(key);if(e.relation?.target){const target=byKey.get(keyText(e.relation.target));if(target)visit(target);}active.delete(key);done.add(key);ordered.push(e);};
  for(const e of entries)visit(e);return {ordered,cycles};
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
 * O(J + 64*L + 64^2 + H*64); H <= 4096, at most seven source texts, no I/O. */
export function checkLedgerProposal(raw:unknown,rawContext:unknown):LedgerProposalResult {
  const w=work(),empty=():LedgerProposalResult=>({entries:[],unbooked:[],uncovered:[],settled:false,withdrawn:[],withdrawalReturned:false,state:emptyProposalState(),work:w});
  try {
    const c=snapshotContext(rawContext,w) as LedgerProposalContext;
    if(!sourceOK(c.source)||typeof c.source.text!=='string'||!['user','assistant'].includes(c.source.role)||!Array.isArray(c.previous)
      ||!Array.isArray(c.marks)||c.marks.length>64||!c.marks.every(m=>regionOK(m)&&MARK.test(m.id)&&m.kind===(m.id[0]==='k'?'money':'use'))
      ||!Array.isArray(c.accounts)||c.accounts.length>256||!record(c.settings)||!record(c.settings.actorLabels)||!record(c.readings)||Object.keys(c.readings).length>4096) return {...empty(),error:'context_invalid'};
    const old=c.state??emptyProposalState();
    if(!Array.isArray(old.history)||old.history.length>4096||!Array.isArray(old.previous)||!Array.isArray(old.everAccepted))return {...empty(),error:'history_invalid'};
    const state=snapshot(old) as LedgerProposalState;c.state=state;c.previous=c.previous.slice(-6);
    const initial=empty();initial.state=state;initial.uncovered=c.marks.map(m=>m.id);
    if(!record(raw))return {...initial,error:'call_malformed'};
    const descriptor=Object.getOwnPropertyDescriptor(raw,'entries'),ud=Object.getOwnPropertyDescriptor(raw,'unbooked');
    if(!descriptor||!('value'in descriptor)||!Array.isArray(descriptor.value)||descriptor.value.length>64
      ||!ud||!('value'in ud)||!Array.isArray(ud.value)||ud.value.length>64)return {...initial,error:'call_malformed'};
    const texts=new Map([c.source,...c.previous].map(s=>[identity(s),s])),values=referenceValues(c.readings);
    const scans=new Map<string,{quantities:QuantityExpression[];numbers:LedgerSpan[]}>();
    for(const [id,s] of texts){const q=amountExpressionWork.scanQuantities(s.text),n=amountExpressionWork.scanNumbers(s.text);w.text+=q.work+n.work;w.scans+=2;scans.set(id,{quantities:q.result,numbers:n.result});}
    const outside=outsideQuotes(c.source.text,w),used=new Map<string,LedgerSpan[]>(),ids=new Set<string>();
    const rows:{id:string;entry:StoredLedgerEntry;returns:string[];proposal:NormalizedLedgerProposedEntry|null;read:Record<string,JsonValue>}[]=[];
    for(let i=0;i<descriptor.value.length;i++) {
      let p:unknown;try{p=snapshot(descriptor.value[i]);if(record(p)){if(!Object.hasOwn(p,'act'))p.act=null;for(const key of ['behalf','item','quantity','amount','stated','tendered','row','relation'])if(!Object.hasOwn(p,key))p[key]=null;}} catch{p=null;}
      const id=record(p)&&textId(p.id)?p.id:`invalid:${i+1}`;
      if(!proposedEntryOK(p)||ids.has(id)) {
        const mark=record(p)&&typeof p.mark==='string'?c.marks.find(m=>m.id===p.mark):undefined;
        const e=fallbackEntry(c.source,mark??{id:'k0',kind:'money',whole:true});e.checks.codes=['entry_malformed'];e.checks.pending=['general'];
        rows.push({id,entry:e,returns:['entry_malformed'],proposal:null,read:{}});
      } else {const checked=staticEntry(p,c,used,texts,values,scans,outside,w);checked.entry.unitPrice=proofUnitPrice(checked.entry,values);rows.push({id,...checked,proposal:p,read:{}});}
      ids.add(id);w.entries++;
    }
    checkAmountOverlaps(rows,c.readings,scans,w);
    checkQuantityWindows(rows.map(r=>r.entry),texts,scans,w);
    if(c.keptEntries&&!entriesOK(c.keptEntries))return {...initial,error:'context_invalid'};
    assignKeys(rows.map(r=>r.entry),c.keptEntries);
    const link=()=>{for(const row of rows)if(row.proposal?.relation&&row.entry.relation){const ref=row.proposal.relation.entry;
      row.entry.relation.target=rows.find(r=>r.id===ref)?.entry.key??(c.entryRefs&&Object.hasOwn(c.entryRefs,ref)?c.entryRefs[ref]:null)??(Object.hasOwn(c.readings,ref)&&'entry'in c.readings[ref]?c.readings[ref].entry??null:null);}};
    link();assignKeys(rows.map(r=>r.entry),c.keptEntries);link();
    for(let i=0;i<rows.length;i++)for(let j=0;j<i;j++){w.pairs++;const a=rows[i]!,b=rows[j]!;
      if(JSON.stringify(leadingKey(a.entry))===JSON.stringify(leadingKey(b.entry))&&entryCompare(a.entry,b.entry)===0){
        addCode(a.entry.checks.codes,'identical_entries');addCode(a.entry.checks.codes,'identical_in_source');pending(a.entry.checks,'restated');addCode(a.returns,'identical_entries');a.read.same_as=b.id;break;}}
    const index=emptyIndex();for(const d of c.before?.entries??[])indexDetail(index,d);
    const mutable=stateFromAccounts(c.accounts),order=dependencyOrder(rows.map(r=>r.entry)),checks=new Map<StoredLedgerEntry,LedgerCheckedEntry>();
    const reply=c.source.role==='assistant'&&c.source.replyTo?JSON.stringify([c.source.replyTo.id,c.source.replyTo.revision]):null;
    const counterpart=reply&&index.sources.get(reply)?.some(e=>e.role==='user')?reply:counterpartId(c.source,c.previous);
    for(const e of order.ordered) {
      const row=rows.find(r=>r.entry===e)!;
      const primary=c.accounts.find(a=>a.id===partyAccount(e.kind==='income'?e.payee:e.payer??e.payee));
      const comparison={...e,row:selectCurrency(e,primary).row??e.row};
      const prior=[...new Set([...(Object.hasOwn(state.returned,row.id)?state.returned[row.id]!:[]),...state.previous.filter(p=>JSON.stringify(leadingKey(p.entry))===JSON.stringify(leadingKey(e))&&entryCompare(p.entry,comparison)===0).flatMap(p=>p.entry.checks.returned)])];
      acceptSemanticDecision(e,prior);
      if(order.cycles.has(keyText(e.key))){addCode(e.checks.codes,'relation_invalid');pending(e.checks,'general');addCode(row.returns,'relation_invalid');}
      const verified=verifyEntry(e,{source:c.source,previous:c.previous,accounts:c.accounts,index,state:mutable,counterpart,work:w,forced:false,mode:'proposal',readers:[]});
      if(verified.detail.row!==null)e.row=verified.detail.row;
      const allReturns=[...new Set([...row.returns,...verified.returns])];
      const fresh=allReturns.filter(code=>!prior.includes(code));
      Object.defineProperty(state.returned,row.id,{value:[...new Set([...prior,...allReturns])],enumerable:true,writable:true,configurable:true});
      e.checks.returned=[...state.returned[row.id]!];
      if(e.checks.returned.some(code=>code==='actor_not_authorised'||code==='payer_account_confirm'))e.checks.history.accountQuestioned=true;
      if(verified.detail.codes.includes('payer_account_confirm')) {
        row.read.payer=partyAccount(e.payer);row.read.behalf=e.behalf?.span?c.source.text.slice(e.behalf.span.start,e.behalf.span.end):null;
        row.read.candidates=availableCandidates(e,c.accounts).filter(id=>id!==partyAccount(e.payer));
      }
      if(verified.detail.codes.includes('possible_duplicate')&&counterpart){const other=index.sources.get(counterpart)?.find(d=>posted(d)&&matchingTransaction(e,d));if(other)row.read.same_as=asJSON(other.key);}
      const unanswered=fresh.filter(code=>SEMANTIC_QUESTIONS.includes(code));
      if(unanswered.length){e.checks.unanswered=unanswered;for(const code of unanswered){addCode(e.checks.codes,code);pending(e.checks,code==='possible_duplicate'||code==='identical_entries'?'restated':code==='actor_not_authorised'?'general':'not_transacted');}}
      const verdict:LedgerCheckedEntry['verdict']=fresh.length?'returned':verified.detail.disposition==='pending'?'settled':verified.detail.disposition==='flagged'?'flagged':'accepted';
      const checked={id:row.id,verdict,codes:verified.detail.codes,read:row.read,entry:e};checks.set(e,checked);indexDetail(index,verified.detail);
    }
    const entries=rows.map(r=>checks.get(r.entry)!);
    const unbooked:LedgerUnbooked[]=[];
    for(const rawU of ud.value){let u:unknown;try{u=snapshot(rawU);}catch{continue;}if(!record(u)||!MODEL_UNBOOKED.includes(u.reason as string))continue;
      const mark=c.marks.find(m=>m.id===u.mark);if(mark)unbooked.push({sourceId:c.source.sourceId,revision:c.source.revision,...('whole'in mark?{whole:true as const}:{span:mark.span}),mark:mark.id,reason:u.reason as LedgerUnbookedReason,by:'model'});}
    const covered=new Set([...entries.map(e=>e.entry.mark.id),...unbooked.map(u=>u.mark!)]),uncovered=c.marks.filter(m=>!covered.has(m.id)).map(m=>m.id);
    const withdrawn=state.previous.filter(e=>!ids.has(e.id)).map(e=>e.id);
    let settled=!entries.some(e=>e.verdict==='returned')&&!uncovered.length,withdrawalReturned=false;
    if(state.awaitingWithdrawal.length){for(const id of state.awaitingWithdrawal)if(!ids.has(id)&&!state.confirmedWithdrawn.includes(id))state.confirmedWithdrawn.push(id);state.awaitingWithdrawal=[];}
    if(settled&&!state.withdrawalAsked&&state.previous.some(e=>withdrawn.includes(e.id)&&['accepted','flagged'].includes(e.verdict))) {
      settled=false;withdrawalReturned=true;state.withdrawalAsked=true;state.awaitingWithdrawal=withdrawn;
    }
    for(const checked of entries) {
      state.history.push({id:checked.id,mark:checked.entry.mark.id,act:checked.entry.act,checks:checked.entry.checks});
      if(checked.verdict==='accepted'||checked.verdict==='flagged') {const oldIndex=state.everAccepted.findIndex(x=>x.id===checked.id);const row={id:checked.id,entry:checked.entry};
        if(oldIndex>=0)state.everAccepted[oldIndex]=row;else state.everAccepted.push(row);}
    }
    state.previous=entries.map(({id,verdict,entry})=>({id,verdict,entry}));
    if(state.history.length>4096)return {...initial,error:'history_limit'};
    return {entries,unbooked,uncovered,settled,withdrawn,withdrawalReturned,state,work:w};
  }catch{return {...empty(),error:'context_invalid'};}
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
function decodeEvents(raw:unknown,diagnostics:LedgerDiagnostic[]):LedgerAccountEvent[] {
  if(raw==null)return [];if(!Array.isArray(raw)){diagnostics.push({code:'account_events_invalid',id:null});return [];}
  const truncated=raw.length>LEDGER_LIMITS.events;if(truncated)diagnostics.push({code:'account_events_truncated',id:null});
  const out:LedgerAccountEvent[]=[],ids=new Map<string,string>(),conflicts=new Set<string>();
  for(let i=0;i<raw.length;i++){const field=Object.getOwnPropertyDescriptor(raw,String(i)),d=field&&'value'in field?decodeLedgerAccountEvent(field.value):{ok:false as const,code:'account_event_invalid'};if(!d.ok){diagnostics.push({code:d.code,id:null,index:i,reason:field&&'value'in field?rowFailure(field.value):'json_accessor'});continue;}const key=JSON.stringify(d.value),old=ids.get(d.value.id);
    if(old!==undefined){if(old!==key){conflicts.add(d.value.id);diagnostics.push({code:'account_event_id_conflict',id:d.value.id});}continue;}ids.set(d.value.id,key);out.push(d.value);}
  const ordered=out.filter(e=>!conflicts.has(e.id)).sort((a,b)=>a.seq-b.seq);
  return truncated?[...ordered.filter(e=>e.kind==='create'),...ordered.filter(e=>e.kind!=='create').slice(0,LEDGER_LIMITS.events)]:ordered;
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
function decodeCorrections(raw:unknown,diagnostics:LedgerDiagnostic[],w:LedgerWork=work()):LedgerCorrection[] {
  if(raw==null)return [];if(!Array.isArray(raw)){diagnostics.push({code:'ledger_corrections_invalid',id:null});return [];}
  const out:LedgerCorrection[]=[],ids=new Map<string,string>(),conflicts=new Set<string>();
  for(let i=0;i<raw.length;i++){w.correctionVisits=(w.correctionVisits??0)+1;const field=Object.getOwnPropertyDescriptor(raw,String(i)),d=field&&'value'in field?decodeLedgerCorrection(field.value):{ok:false as const,code:'ledger_correction_invalid'};if(!d.ok){diagnostics.push({code:d.code,id:null,index:i,reason:field&&'value'in field?rowFailure(field.value):'json_accessor'});continue;}const key=JSON.stringify(d.value),old=ids.get(d.value.id);
    if(old!==undefined){if(old!==key){conflicts.add(d.value.id);diagnostics.push({code:'correction_id_conflict',id:d.value.id});}continue;}ids.set(d.value.id,key);out.push(d.value);}
  const adjustmentIds=new Set(out.filter(c=>c.action==='adjustment'&&!conflicts.has(c.id)).map(c=>`user:${c.id}`)),active=new Map<string,LedgerCorrection>();
  for(const c of correctionOrder(out.filter(e=>!conflicts.has(e.id)),w)) {
    w.correctionVisits=(w.correctionVisits??0)+1;
    const adjustmentTarget=typeof c.anchor==='string'&&adjustmentIds.has(c.anchor);
    if(adjustmentTarget&&c.action==='void'){diagnostics.push({code:'adjustment_void_invalid',id:c.id});continue;}
    if(adjustmentTarget&&(c.action==='amend'||c.action==='confirm')){diagnostics.push({code:'adjustment_edit_invalid',id:c.id});continue;}
    const key=(c.action==='adjustment'||adjustmentTarget?'adjustment':identity(c as LedgerSourceRef))+'/'+(c.anchor?keyText(c.anchor):`user:${c.id}`);
    if(c.action==='clear')active.delete(key);else active.set(key,c);
  }
  return correctionOrder([...active.values()],w);
}
function implicitAccounts(settings:WorldSettings,state:LedgerMutableState):LedgerAccount[] {
  return [['player',[settings.playerName]],...Object.entries(settings.actorLabels)].map(([id,names])=>{
    const owner=id as string,labels=names as readonly string[],rows=[...state.balances.values()].filter(r=>r.ownerId===owner).map(r=>({unit:r.unit,value:moneyText(r.cents),tracked:true,readerIds:[...r.readerIds].sort()}));
    const items=[...state.inventory.values()].filter(r=>r.ownerId===owner).map(r=>({item:r.item,count:r.count,readerIds:[...r.readerIds].sort()}));
    return {id:owner,kind:'private' as const,label:labels[0]!,aliases:labels.slice(1) as string[],actors:[owner],readers:[...new Set(rows.flatMap(r=>r.readerIds).concat(items.flatMap(i=>i.readerIds)))].sort(),rows,items,status:'active' as const};
  });
}
function syncAccounts(accounts:LedgerAccount[],state:LedgerMutableState,w:LedgerWork):void {
  for(const a of accounts)if(a.status==='active'){
    for(const r of a.rows){w.rowCopies++;const row=state.balances.get(assetIdentity(a.id,r.unit));if(row){r.value=moneyText(row.cents);r.readerIds=[...row.readerIds].sort();r.tracked=row.tracked!==false;}}
    for(const i of a.items){w.rowCopies++;const row=state.inventory.get(assetIdentity(a.id,i.item));if(row){i.count=row.count;i.readerIds=[...row.readerIds].sort();}}
  }
}
function applyAccountEvent(event:LedgerAccountEvent,accounts:LedgerAccount[],state:LedgerMutableState,diagnostics:LedgerDiagnostic[],w:LedgerWork):boolean {
  w.events++;
  const invalid=(code:string)=>{diagnostics.push({code,id:event.id});return false;};
  const known=new Set(accounts.filter(a=>a.kind==='private').map(a=>a.id));
  const readersOK=(ids:readonly string[])=>ids.every(id=>known.has(id));
  if(event.kind==='create') {
    const v=event.account;
    if(v.kind==='private'||!v.id.startsWith('acct:')||known.has(v.id)||accounts.some(a=>a.id===v.id))return invalid('account_id_conflict');
    if(accounts.length>=256)return invalid('account_limit');
    if(!readersOK(v.actors)||!readersOK(v.readers)||v.rows.some(r=>!readersOK(r.readerIds??v.readers))||v.items.some(i=>!readersOK(i.readerIds??v.readers)))return invalid('account_reader_invalid');
    if(new Set(v.rows.map(r=>r.unit)).size!==v.rows.length||new Set(v.items.map(i=>i.item)).size!==v.items.length)return invalid('account_row_conflict');
    const a:LedgerAccount={...v,rows:v.rows.map(r=>({unit:r.unit,value:r.opening,tracked:r.tracked,readerIds:[...(r.readerIds??v.readers)].sort()})),items:v.items.map(i=>({...i,readerIds:[...(i.readerIds??v.readers)].sort()}))};
    accounts.push(a);
    if(a.status==='active'){for(const r of a.rows)state.balances.set(assetIdentity(a.id,r.unit),{ownerId:a.id,unit:r.unit,cents:decimalCents(r.value),tracked:r.tracked,readerIds:new Set(r.readerIds)});
      for(const i of a.items)state.inventory.set(assetIdentity(a.id,i.item),{ownerId:a.id,item:i.item,count:i.count,readerIds:new Set(i.readerIds)});}
    return true;
  }
  const a=accounts.find(a=>a.id===event.accountId);if(!a||a.status==='closed')return invalid('account_event_target_invalid');
  if(event.kind==='close') {
    if(a.kind==='private')return invalid('private_account_cannot_close');
    syncAccounts([a],state,w);a.status='closed';
    for(const r of a.rows)state.balances.delete(assetIdentity(a.id,r.unit));for(const i of a.items)state.inventory.delete(assetIdentity(a.id,i.item));return true;
  }
  const c=event.changes;
  if(c.actors&&!readersOK(c.actors)||c.readers&&!readersOK(c.readers)||c.rows?.some(r=>r.readerIds&&!readersOK(r.readerIds)))return invalid('account_reader_invalid');
  if(a.kind==='private'&&(c.label!==undefined||c.aliases!==undefined||c.actors!==undefined))return invalid('private_account_identity_immutable');
  if(c.rows) {
    if(new Set(c.rows.map(r=>r.unit)).size!==c.rows.length)return invalid('account_row_conflict');
    let n=a.rows.length;
    for(const change of c.rows){const old=a.rows.find(r=>r.unit===change.unit);
      if(old&&change.opening!==undefined)return invalid('account_opening_immutable');
      if(!old&&!change.remove&&change.opening===undefined)return invalid('account_opening_required');
      n+=change.remove?(old?-1:0):old?0:1;}
    if(n>256)return invalid('account_row_limit');
  }
  if(c.label!==undefined)a.label=c.label;if(c.aliases)a.aliases=[...c.aliases];if(c.actors)a.actors=[...c.actors];
  if(c.readers){a.readers=[...c.readers];for(const r of a.rows){r.readerIds=[...c.readers];const row=state.balances.get(assetIdentity(a.id,r.unit));if(row)row.readerIds=new Set(c.readers);}
    if(a.kind!=='private')for(const i of a.items){i.readerIds=[...c.readers];const row=state.inventory.get(assetIdentity(a.id,i.item));if(row)row.readerIds=new Set(c.readers);}}
  for(const change of c.rows??[]) {
    const at=a.rows.findIndex(r=>r.unit===change.unit),old=at>=0?a.rows[at]:undefined,key=assetIdentity(a.id,change.unit);
    if(change.remove){if(at>=0)a.rows.splice(at,1);state.balances.delete(key);continue;}
    if(old){if(change.tracked!==undefined){old.tracked=change.tracked;state.balances.get(key)!.tracked=change.tracked;}
      if(change.readerIds){old.readerIds=[...change.readerIds];state.balances.get(key)!.readerIds=new Set(change.readerIds);}}
    else{const row={unit:change.unit,value:change.opening!,tracked:change.tracked??true,readerIds:[...(change.readerIds??a.readers)]};a.rows.push(row);
      state.balances.set(key,{ownerId:a.id,unit:row.unit,cents:decimalCents(row.value),tracked:row.tracked,readerIds:new Set(row.readerIds)});}
  }
  return true;
}
function applyLegs(result:Evaluated,state:LedgerMutableState,accounts:LedgerAccount[]):void {
  if(!posted(result.detail))return;
  // This is the single debit boundary, after all funding and stock checks.
  for(const leg of result.legs.money)leg.row.cents+=leg.delta;
  for(const leg of result.legs.goods) {
    if(leg.row)leg.row.count+=leg.delta;
    else if(leg.delta>0){const a=accounts.find(a=>a.id===leg.owner)!;
      const ids=a.kind==='private'?[...new Set(a.rows.flatMap(r=>r.readerIds).concat(a.items.flatMap(i=>i.readerIds)))]:a.readers;
      const readers=ids.length?ids:['player'];const row={ownerId:leg.owner,item:leg.item,count:leg.delta,readerIds:new Set(readers)};
      state.inventory.set(assetIdentity(leg.owner,leg.item),row);a.items.push({item:leg.item,count:leg.delta,readerIds:[...readers]});}
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
/** Detects actual optional data; explicit undefined remains the legacy JSON trap. O(S). */
export function hasLedgerData(sources:unknown,options:unknown):boolean {
  try {if(record(options)&&['accountEvents','corrections'].some(k=>{const d=Object.getOwnPropertyDescriptor(options,k);
      return !!d&&(!('value'in d)||d.value!=null&&(!Array.isArray(d.value)||d.value.length>0));}))return true;
    return Array.isArray(sources)&&sources.some(s=>record(s)&&['ledger','ledgerMarks'].some(k=>{
      const d=Object.getOwnPropertyDescriptor(s,k);return !!d&&(!('value'in d)||d.value!=null);}));}catch{return true;}
}
function emptyLedger(w:LedgerWork=work()):LedgerFold {return {accounts:[],entries:[],unbooked:[],unrecordedMarks:0,
  open:{pending:[],unaffordable:[],committed:[],deposits:[],quoted:[]},director:{unpaid:[],unposted:[],committed:[],unbooked:[]},unmatchedVoids:[],unconfigured:[],diagnostics:[],work:w};}
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

/** Detach the new path's source boundary without invoking getters. Invalid JSON remains
 * an invalid source for the existing validator, with safely readable identity retained. */
export function prepareLedgerSources(raw:unknown):WorldSourceEffects[] {
  if(!Array.isArray(raw))return [];
  const out:WorldSourceEffects[]=[];
  for(let i=0;i<raw.length;i++)try{
    if(!record(raw[i])){out.push(raw[i] as WorldSourceEffects);continue;}
    const fields=Object.getOwnPropertyDescriptors(raw[i]),base:Record<string,unknown>={};
    for(const [key,d] of Object.entries(fields))if(key!=='ledger'&&key!=='ledgerMarks'){
      if(!('value'in d))throw 0;Object.defineProperty(base,key,{value:d.value,enumerable:true});}
    const detached=snapshot(base) as Record<string,unknown>;
    for(const key of ['ledger','ledgerMarks']){const d=fields[key];if(!d)continue;if('value'in d&&d.value===undefined)throw 0;
      let value:unknown={};try{if(!('value'in d))throw 0;value=snapshot(d.value);}catch{/* Invalid optional data is a ledger diagnostic, never a source issue. */}
      Object.defineProperty(detached,key,{value,enumerable:true});}
    out.push(detached as unknown as WorldSourceEffects);
  }catch{
    let id='',revision=0;try{const d=Object.getOwnPropertyDescriptors(raw[i]);if(textId(d.sourceId?.value))id=d.sourceId.value;if(safeInt(d.revision?.value,1))revision=d.revision.value;}catch{/* Keep invalid identity bounded. */}
    out.push({sourceId:id,revision,invalid:NaN} as unknown as WorldSourceEffects);
  }
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
  }catch{diagnostics.push({code:'ledger_options_invalid',id:null});return {};}
}
function regionSame(a:LedgerRegion,b:LedgerRegion):boolean {return 'whole'in a?'whole'in b:'span'in b&&overlaps(a.span,b.span);}
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
  open.pending=ledger.entries.filter(e=>e.disposition==='pending'&&['general','unconfigured','account_uncertain'].includes(e.category??'')&&!settled.has(keyText(e.key)));
  open.unaffordable=ledger.entries.filter(e=>e.disposition==='unaffordable'&&!e.causedByCorrection&&e.laterSources<=5);
  open.committed=ledger.entries.filter(e=>e.status==='committed'&&e.disposition!=='void'&&(e.due===null||BigInt(e.due)>0n)&&!['restated','untracked'].includes(e.category??''));
  open.quoted=ledger.entries.filter(e=>e.status==='quoted'&&e.disposition!=='void'&&e.laterSources<20);
  open.deposits=[];
  for(const e of ledger.entries)if(e.kind==='payment'&&posted(e)&&e.relation?.kind==='settles'&&e.relation.target&&!balances.has(keyText(e.key))) {
    const target=byKey.get(keyText(e.relation.target));if(target?.status==='committed'&&target.due!==null&&BigInt(target.due)>0n){e.due=target.due;open.deposits.push(e);}
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
    const ledger=emptyLedger();ledger.diagnostics.push({code:'ledger_bridge_invalid',id:null});
    return {state:{mode:'story',timeMs:0,publicTime:false,actorIds:[],balances:[],inventory:[]},receipts:[],issues:[],ledger};
  }
}
function foldLedgerWorldUnchecked(settings:WorldSettings,sources:readonly WorldSourceEffects[],rawOptions:unknown,bridge:LedgerFoldBridge):WorldFoldResult {
  const ledger=emptyLedger(),w=ledger.work,issues=[...bridge.issues],receipts:WorldEffectReceipt[]=[];
  let state=bridge.initial;
  try {
    const options=rawLedgerOptions(rawOptions,ledger.diagnostics),events=decodeEvents(options.accountEvents,ledger.diagnostics),corrections=decodeCorrections(options.corrections,ledger.diagnostics,w);
    const accounts=implicitAccounts(settings,state);ledger.accounts=accounts;
    let sideEffects=false;
    for(const event of events)if(event.kind==='create')sideEffects=applyAccountEvent(event,accounts,state,ledger.diagnostics,w)||sideEffects;
    const valid=new Set(bridge.validSources),validIds=new Set(bridge.validSources.map(identity)),activeCorrections=corrections.filter(c=>c.action==='adjustment'||validIds.has(identity(c as LedgerSourceRef)));
    const correctionsBySource=new Map<string,LedgerCorrection[]>();
    for(const c of activeCorrections.filter(c=>c.action!=='adjustment')){const id=identity(c as LedgerSourceRef),list=correctionsBySource.get(id)??[];list.push(c);correctionsBySource.set(id,list);}
    const userPostKeys=new Set<string>();
    if(Array.isArray(options.corrections))for(const raw of options.corrections){const c=decodeLedgerCorrection(raw);if(c.ok&&c.value.action==='post')userPostKeys.add(identity(c.value as LedgerSourceRef)+'/'+`user:${c.value.id}`);}
    const positioned=new Map<number,(LedgerAccountEvent|LedgerCorrection)[]>();
    const positions=events.some(e=>e.kind!=='create')||activeCorrections.some(c=>c.action==='adjustment')?positionIndex(sources,w):{at:()=>0};
    const at=(position:number,value:LedgerAccountEvent|LedgerCorrection)=>{const list=positioned.get(position)??[];list.push(value);positioned.set(position,list);};
    for(const e of events)if(e.kind!=='create')at(positions.at(e.after),e);
    for(const c of activeCorrections)if(c.action==='adjustment')at(positions.at(c.after??null),c);
    const index=emptyIndex(),previous:WorldSourceEffects[]=[],seenSources=new Map<string,WorldSourceEffects>();let lastUser:WorldSourceEffects|undefined;
    const getCounterpart=(source:WorldSourceEffects):string|null=>{const reply=source.replyTo?seenSources.get(JSON.stringify([source.replyTo.id,source.replyTo.revision])):undefined;
      const other=source.role==='user'?(previous.at(-1)?.role==='assistant'?previous.at(-1):undefined):source.replyTo?(reply?.role==='user'?reply:undefined):lastUser;return other?identity(other):null;};
    const getContext=(source:WorldSourceEffects,entry:StoredLedgerEntry,forced:boolean,targetState=state):VerifyContext=>({accounts,source,previous:previous.slice(-6),counterpart:getCounterpart(source),index,state:targetState,
      work:w,forced,mode:'fold',readers:safeReaders(bridge,source,entryRegion(entry))});
    const applyUser=(c:LedgerCorrection,source:WorldSourceEffects,targetState=state,original?:StoredLedgerEntry):LedgerDetail=>{
      const e=c.values?userEntry(c,source,original):original??fallbackEntry(source,{id:'k0',kind:'money',whole:true});
      const legacyReplacement=typeof original?.key==='string'&&original.key.startsWith('legacy:');
      if(c.action==='void')return {...e,origin:'user',role:source.role,laterSources:0,disposition:'void',category:null,layer:'inner',codes:legacyReplacement?['caused_by_correction']:[],readerIds:safeReaders(bridge,source,entryRegion(e)),due:null,unitPrice:e.unitPrice,unaffordable:null,candidates:[],causedByCorrection:false};
      const codes=c.values?userValuesStateCodes(c.values,accounts,index):['ledger_correction_invalid'];
      const evaluated=verifyEntry(e,getContext(source,e,true,targetState));
      if(codes.length){evaluated.detail.disposition='pending';evaluated.detail.category='general';evaluated.detail.codes=codes;evaluated.detail.layer='outer';}
      if(legacyReplacement){addCode(evaluated.detail.codes,'caused_by_correction');evaluated.detail.causedByCorrection=evaluated.detail.disposition==='unaffordable';}
      applyLegs(evaluated,targetState,accounts);return evaluated.detail;
    };
    const append=(d:LedgerDetail)=>{ledger.entries.push(d);indexDetail(index,d);w.entries++;sideEffects=true;};
    const boundary=(position:number,source:WorldSourceEffects|null,posts:LedgerCorrection[]=[])=>{
      const items=correctionOrder([...(positioned.get(position)??[]),...posts],w);
      for(const item of items)if('action'in item){const body=item.action==='adjustment'?{sourceId:'',revision:1,role:'user' as const,text:'',acceptedAtMs:0,plan:{observations:[],unresolved:[]},candidates:[]}:source??bridge.validSources.find(s=>identity(s)===identity(item as LedgerSourceRef));if(body)append(applyUser(item,body));}
      else sideEffects=applyAccountEvent(item,accounts,state,ledger.diagnostics,w)||sideEffects;
    };
    boundary(0,null);
    for(let position=0;position<sources.length;position++) {
      const source=sources[position]!;w.sourceVisits++;
      if(!valid.has(source)){boundary(position+1,null);bridge.step?.(position,state.timeMs,issues[0]?.code??null);continue;}
      const local=correctionsBySource.get(identity(source))??[],legacyCorrections=new Map<string,LedgerCorrection>();
      for(const c of local)if(typeof c.anchor==='string'&&c.anchor.startsWith('legacy:'))legacyCorrections.set(c.anchor,c);
      const legacy=bridge.legacy(state,source,{work:w,sideEffects,corrections:legacyCorrections,
        correct:(trial,raw,correction)=>applyUser(correction,source,trial,legacyDetail(source,raw,'',bridge)),
        demote:(raw,code)=>legacyDetail(source,raw,code,bridge)});
      state=legacy.state;receipts.push(...legacy.receipts);issues.push(...legacy.issues);for(const d of legacy.details)append(d);sideEffects ||= legacy.sideEffects;
      syncAccounts(accounts,state,w);
      const marks=source.ledgerMarks!=null?decodeLedgerMarks(source.ledgerMarks):null;
      const book=source.ledger!=null?decodeLedger(source.ledger):null;
      const modelEntries=book?.ok?book.value.entries.filter(e=>e.sourceId===source.sourceId&&e.revision===source.revision):[];
      const matched=matchLedgerCorrections(modelEntries,local),claims=matched.ok?matched.value:{claims:[],posts:[],unmatchedVoids:[],blocked:[]};
      ledger.unmatchedVoids.push(...claims.unmatchedVoids.filter(c=>!userPostKeys.has(identity(c as LedgerSourceRef)+'/'+String(c.anchor))));
      const ordered=dependencyOrder(modelEntries);
      for(const e of ordered.ordered) {
        const claim=claims.claims.find(c=>keyText(c.key)===keyText(e.key));
        if(claim){append(applyUser(claim.correction,source,state,e));continue;}
        const evaluated=verifyEntry(e,getContext(source,e,e.origin==='user'));
        const blocked=claims.blocked.find(b=>keyText(b.key)===keyText(e.key));
        if(blocked||ordered.cycles.has(keyText(e.key))){evaluated.detail.disposition='pending';evaluated.detail.category='general';evaluated.detail.layer='outer';
          for(const code of blocked?.codes??['relation_invalid'])addCode(evaluated.detail.codes,code);}
        applyLegs(evaluated,state,accounts);append(evaluated.detail);
      }
      // Index voids once so independent posts cost O(C), including user posts.
      const voidPostAnchors=new Set<string>();
      for(const c of local){w.correctionVisits=(w.correctionVisits??0)+1;if(c.action==='void'&&typeof c.anchor==='string')voidPostAnchors.add(c.anchor);}
      const posts=[...local.filter(c=>c.action==='post'&&!c.anchor&&!voidPostAnchors.has(`user:${c.id}`)),...claims.posts];boundary(position+1,source,posts);
      const unbooked:LedgerUnbooked[]=book?.ok?[...book.value.unbooked]:[];
      if(book&&!book.ok){ledger.diagnostics.push({code:book.code,id:source.sourceId});if(marks?.ok)for(let i=0;i<marks.value.money.length;i++){
        const m=marks.value.money[i]!;unbooked.push({sourceId:source.sourceId,revision:source.revision,...('whole'in m?{whole:true as const}:{span:m}),mark:`k${i+1}`,reason:'ledger_record_invalid',by:'code'});}}
      if(!book&&marks?.ok)ledger.unrecordedMarks+=marks.value.money.length;
      if(marks&&!marks.ok)ledger.diagnostics.push({code:marks.code,id:source.sourceId});
      for(const u of unbooked)if(u.sourceId===source.sourceId&&u.revision===source.revision) {
        const anchor:LedgerUnbookedAnchor=[u.sourceId,u.revision,'whole'in u?{whole:true}:{span:u.span},u.reason];
        const dismissed=local.some(c=>c.action==='void'&&c.anchor&&keyText(c.anchor)===keyText(anchor))
          ||posts.some(c=>c.fromMark&&regionSame(c.fromMark,u));
        ledger.unbooked.push({...u,readerIds:safeReaders(bridge,source,u),laterSources:0,dismissed,layer:u.by==='code'&&u.reason!=='entry_withdrawn'?'outer':'inner'});
      }
      previous.push(source);seenSources.set(identity(source),source);if(source.role==='user')lastUser=source;
      bridge.step?.(position,state.timeMs,issues[0]?.code??null);
    }
    syncAccounts(accounts,state,w);
    // Closed accounts are unavailable during the fold and retain their closing values in the final view.
    for(const a of accounts)if(a.status==='closed'){
      for(const r of a.rows)state.balances.set(assetIdentity(a.id,r.unit),{ownerId:a.id,unit:r.unit,cents:decimalCents(r.value),tracked:r.tracked,readerIds:new Set(r.readerIds)});
      for(const i of a.items)state.inventory.set(assetIdentity(a.id,i.item),{ownerId:a.id,item:i.item,count:i.count,readerIds:new Set(i.readerIds)});
    }
    closeLedger(ledger,bridge.validSources);
  }catch{ledger.diagnostics.push({code:'ledger_input_invalid',id:null});}
  let serialized:WorldState;
  try{serialized=bridge.serialize(state);}catch{serialized={mode:settings.mode,timeMs:state.timeMs,publicTime:settings.publicTime,actorIds:Object.keys(settings.actorLabels).sort(),balances:[],inventory:[]};ledger.diagnostics.push({code:'ledger_serialize_failed',id:null});}
  return {state:serialized,receipts,issues,ledger};
}

/** Prefix positions are resolved against the complete list before any slicing. The
 * injected fold is the public world-state fold; invalid settings keep its exception. */
export function foldLedgerPrefix(settings:WorldSettings,rawSources:unknown,count:number,rawOptions:unknown,
  fold:(settings:WorldSettings,sources:readonly WorldSourceEffects[],options?:LedgerFoldOptions)=>WorldFoldResult):LedgerDecoded<WorldFoldResult> {
  try {
    if(!Array.isArray(rawSources)||!safeInt(count)||count>rawSources.length)return {ok:false,code:'ledger_prefix_invalid'};
    const sources=rawSources as WorldSourceEffects[],diagnostics:LedgerDiagnostic[]=[],options=rawLedgerOptions(rawOptions,diagnostics),positions=positionIndex(sources);
    const events=decodeEvents(options.accountEvents,diagnostics).filter(e=>e.kind==='create'||positions.at(e.after)<=count);
    const corrections=decodeCorrections(options.corrections,diagnostics).filter(c=>{
      const position=positions.exact.get(identity(c as LedgerSourceRef))??0;
      return c.action==='adjustment'?positions.at(c.after??null)<=count:position>0&&position<=count;
    });
    const clock:LedgerFoldOptions={};
    if(record(rawOptions))for(const k of ['nowMs','monotonicFloorMs'] as const){const d=Object.getOwnPropertyDescriptor(rawOptions,k);if(d&&'value'in d&&safeInt(d.value))clock[k]=d.value;}
    const value=fold(settings,sources.slice(0,count),{...clock,accountEvents:events,corrections});
    if(value.ledger)value.ledger.diagnostics.push(...diagnostics);return {ok:true,value};
  }catch(error){if(error instanceof Error&&error.message==='invalid_world_settings')throw error;return {ok:false,code:'ledger_prefix_invalid'};}
}
/** Query account state at a prefix boundary; checkers include closed accounts, model inputs omit them. */
export function accountsAt(settings:WorldSettings,sources:unknown,count:number,options:unknown,
  fold:(settings:WorldSettings,sources:readonly WorldSourceEffects[],options?:LedgerFoldOptions)=>WorldFoldResult,includeClosed=false):LedgerDecoded<LedgerAccount[]> {
  try {const result=foldLedgerPrefix(settings,sources,count,options,fold);if(!result.ok)return result;
    const a=result.value.ledger?.accounts??implicitAccounts(settings,stateFromWorld(result.value.state));return {ok:true,value:a.filter(a=>includeClosed||a.status==='active')};
  }catch(error){if(error instanceof Error&&error.message==='invalid_world_settings')throw error;return {ok:false,code:'ledger_prefix_invalid'};}
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
function ledgerFact(e:LedgerDetail,ledger:LedgerFold,readerId:string):LedgerFact {
  const visible=(p:LedgerParty|null)=>{const id=partyAccount(p),a=ledger.accounts.find(a=>a.id===id);return a&&accountVisible(a,readerId)?a.id:null;};
  const payer=visible(e.payer),payee=visible(e.payee),receiver=visible(e.receiver),m=moneyOf(e);
  const quote=(field:'payer'|'payee'|'receiver')=>{const party=e[field];return party&&'external'in party&&party.external?party.external.quote:e.externalQuotes?.[field]?.quote;};
  const actor=e.actor.id==='player'||ledger.accounts.some(a=>a.kind==='private'&&a.id===e.actor.id)?e.actor.id:null;
  return {sourceId:e.sourceId,revision:e.revision,kind:e.kind,status:e.status,time:e.time,actor,
    item:e.item?.quote??null,quantity:e.quantity?.count??null,cents:m?.cents??null,unit:e.row,
    ...(payer?{payer}:{}),...(payee?{payee}:{}),...(receiver?{receiver}:{}),
    ...(quote('payer')?{payerQuote:quote('payer')}:{}),
    ...(quote('payee')?{payeeQuote:quote('payee')}:{}),
    ...(quote('receiver')?{receiverQuote:quote('receiver')}:{}),...(e.due!==null?{due:e.due}:{}),
    ...(e.unaffordable&&!e.causedByCorrection?{unaffordable:e.unaffordable}:{})};
}
/** Data-only character projection: no codes, doubts, proofs, raw quotes, or hidden account IDs.
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

/** Finish one proposal run, including uncovered use marks and confirmed withdrawals.
 * O(J+64^2+H); accepted-ID history H <= 4096. Exceeding either 64-record storage
 * budget is an explicit result; callers must retain the prior valid record. */
export function finalizeLedgerRun(raw:unknown):LedgerDecoded<LedgerFinalized> {
  try {
    const input=snapshot(raw) as LedgerFinalizationInput,{source,marks,last}=input,w=work();
    if(!sourceOK(source)||typeof source.text!=='string'||!marksOK(marks))return {ok:false,code:'ledger_finalization_invalid'};
    const frozen=input.frozen;
    if(frozen&&(!entriesOK(frozen.keptEntries)||!Array.isArray(frozen.keptUnbooked)||!frozen.keptUnbooked.every(unbookedOK)||!marksOK(frozen.frozenMarks)||identity(frozen.source)!==identity(source)))return {ok:false,code:'ledger_freeze_invalid'};
    if(frozen?.skip)return {ok:true,value:{entries:frozen.keptEntries,unbooked:frozen.keptUnbooked,skip:true,outcome:'complete',stop:'frozen',work:w}};
    if(last&&(!Array.isArray(last.entries)||last.entries.length>64||!last.entries.every(r=>textId(r.id)&&storedEntryOK(r.entry))
      ||!Array.isArray(last.unbooked)||!last.unbooked.every(unbookedOK)))return {ok:false,code:'ledger_finalization_invalid'};
    const fresh=last?.entries.map(r=>r.entry)??[],merged=mergeLedgerEntries(frozen?.keptEntries??[],fresh);
    if(!merged.ok)return merged;w.pairs+=merged.value.work.pairs;
    if(merged.value.entries.some(e=>identity(e)!==identity(source)))return {ok:false,code:'ledger_source_mismatch'};
    const unbooked=[...(frozen?.keptUnbooked??[]),...(last?.unbooked??[])];
    const covered=new Set([...merged.value.entries.map(e=>e.mark.id),...unbooked.map(u=>u.mark),...(frozen?.frozenMarks??[]).map(m=>m.id)]);
    for(const mark of marks)if(!covered.has(mark.id)) {
      const reason=input.uncoveredReasons?.[mark.id]??input.defaultReason??'not_covered';
      if(!CODE_UNBOOKED.includes(reason)||['entry_dropped','entry_withdrawn'].includes(reason))return {ok:false,code:'ledger_uncovered_reason_invalid'};
      unbooked.push({sourceId:source.sourceId,revision:source.revision,...('whole'in mark?{whole:true as const}:{span:mark.span}),mark:mark.id,by:'code',reason});
    }
    const passed=input.passed??last?.state.everAccepted??[],withdrawn=input.withdrawn??last?.state.confirmedWithdrawn??[];
    if(!Array.isArray(passed)||passed.length>4096||!passed.every(p=>textId(p.id)&&storedEntryOK(p.entry))||!stringList(withdrawn,4096))return {ok:false,code:'ledger_history_invalid'};
    const present=new Set(last?.entries.map(r=>r.id)??[]),confirmed=new Set(withdrawn),seen=new Set<string>();
    for(const p of passed)if(!present.has(p.id)&&!seen.has(p.id)) {
      seen.add(p.id);const e=p.entry;if(identity(e)!==identity(source))return {ok:false,code:'ledger_source_mismatch'};
      unbooked.push({sourceId:source.sourceId,revision:source.revision,...entryRegion(e),mark:e.mark.id,by:'code',reason:confirmed.has(p.id)?'entry_withdrawn':'entry_dropped'});
    }
    if(unbooked.length>64)return {ok:false,code:'ledger_rerun_limit'};
    return {ok:true,value:{entries:merged.value.entries,unbooked,skip:false,work:w}};
  }catch{return {ok:false,code:'ledger_finalization_invalid'};}
}
