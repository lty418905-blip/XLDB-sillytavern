import { calculate } from '../core/arithmetic.ts';
import type { PerspectivePlan } from './types.ts';

export const WORLD_PLAYER_ID = 'player' as const;

export type WorldMode = 'companion' | 'story';
export type TimeClassification = 'current' | 'plan' | 'recall' | 'hypothetical' | 'unknown';
export type WorldEffectKind = 'clock_absolute' | 'clock_advance' | 'purchase' | 'refund' | 'consume';

export interface WorldBalanceSetting {
  ownerId: string;
  unit: string;
  /** A non-negative decimal with exactly two fractional digits. */
  value: string;
  /** Omission means visible only to the player. */
  readerIds?: readonly string[];
}

export interface WorldInventorySetting {
  ownerId: string;
  item: string;
  count: number;
  /** Omission means visible only to the player. */
  readerIds?: readonly string[];
}

export interface WorldSettings {
  mode: WorldMode;
  startTimeMs: number;
  /** Keys are SceneRoster character ids; values are trusted exact names or aliases. */
  actorLabels: Readonly<Record<string, readonly string[]>>;
  playerName: string;
  publicTime: boolean;
  balances: readonly WorldBalanceSetting[];
  inventory: readonly WorldInventorySetting[];
}

export interface WorldEffectEvidence {
  /** Zero-based, end-exclusive source-text span for this exact effect quote. */
  start: number;
  end: number;
}

interface EffectBase {
  effectId: string;
  quote: string;
  timeClassification: TimeClassification;
  /** Required when the same quote occurs more than once in one source revision. */
  evidence?: WorldEffectEvidence;
}

export interface ClockAbsoluteCandidate extends EffectBase {
  kind: 'clock_absolute';
  timestamp: string;
  timestampQuote: string;
}

export interface ClockAdvanceCandidate extends EffectBase {
  kind: 'clock_advance';
  amount: { value: string; quote: string; unit: 'milliseconds' | 'seconds' | 'minutes' | 'hours' | 'days' };
}

export interface PurchaseCandidate extends EffectBase {
  kind: 'purchase';
  ownerId: string;
  ownerQuote: string;
  item: string;
  itemQuote: string;
  unit: string;
  unitPrice: { value: string; quote: string; unit: string };
  quantity: { value: string; quote: string };
}

export interface ConsumeCandidate extends EffectBase {
  kind: 'consume';
  ownerId: string;
  ownerQuote: string;
  item: string;
  itemQuote: string;
  quantity: { value: string; quote: string };
}

/** An accepted purchase is addressed by its immutable source revision and effect id. */
export interface PurchaseReference {
  sourceId: string;
  revision: number;
  effectId: string;
}

export interface RefundCandidate extends EffectBase {
  kind: 'refund';
  /** The earlier accepted purchase being returned; no amount is supplied by the model. */
  purchase: PurchaseReference;
  quantity: { value: string; quote: string };
}

/**
 * Supported model output is deliberately narrow: a zoned/relative clock event,
 * a purchase (one exact configured currency and item), a source-referenced
 * partial refund, or an inventory consume.
 * Every value carries a literal quote. `player` may be named by playerName, while
 * `我` is accepted only for a user source whose effect is the source prefix.
 * Transfers, final balances and newly invented assets are unsupported.
 */
export type WorldEffectCandidate = ClockAbsoluteCandidate | ClockAdvanceCandidate | PurchaseCandidate | RefundCandidate | ConsumeCandidate;

export interface WorldSourceEffects {
  sourceId: string;
  revision: number;
  role: 'user' | 'assistant';
  text: string;
  acceptedAtMs: number;
  plan: PerspectivePlan;
  candidates: readonly unknown[];
}

export interface WorldEffectReceipt {
  sourceId: string;
  revision: number;
  effectId: string;
  kind: WorldEffectKind;
  quote: string;
  readerIds: string[];
  timeClassification: TimeClassification;
  applied: boolean;
  ignoredReason?: 'non_current' | 'companion_clock';
  balanceDeltaCents?: string;
  inventoryDelta?: number;
  ownerId?: string;
  unit?: string;
  item?: string;
  clockDeltaMs?: number;
  clockSetMs?: number;
}

export interface WorldIssue {
  sourceId: string;
  revision: number;
  effectId?: string;
  code: string;
}

export interface WorldState {
  mode: WorldMode;
  timeMs: number;
  publicTime: boolean;
  actorIds: string[];
  balances: { ownerId: string; unit: string; value: string; readerIds: string[] }[];
  inventory: { ownerId: string; item: string; count: number; readerIds: string[] }[];
}

export interface WorldFoldResult {
  state: WorldState;
  receipts: WorldEffectReceipt[];
  issues: WorldIssue[];
}

export interface WorldProjection {
  mode: WorldMode;
  timeMs?: number;
  balances: { ownerId: string; unit: string; value: string }[];
  inventory: { ownerId: string; item: string; count: number }[];
  receipts: Omit<WorldEffectReceipt, 'readerIds' | 'quote' | 'effectId'>[];
}

interface MutableBalance { ownerId: string; unit: string; cents: bigint; readerIds: Set<string> }
interface MutableInventory { ownerId: string; item: string; count: number; readerIds: Set<string> }
interface MutableState {
  timeMs: number;
  balances: Map<string, MutableBalance>;
  inventory: Map<string, MutableInventory>;
}
interface PurchaseIndexEntry {
  ownerId: string;
  unit: string;
  item: string;
  quantity: number;
  unitPriceCents: bigint;
  readers: Set<string>;
  refundedQuantity: number;
}

interface ValidatedSettings {
  settings: WorldSettings;
  actorIds: Set<string>;
  actorLabels: Map<string, readonly string[]>;
  initial: MutableState;
}

const MONEY = /^(?:0|[1-9]\d*)\.\d{2}$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const TEMPORAL_GUARD = /计划|打算|准备(?:要)?|将(?:要|来)|明天(?:要|会)?|下次|如果|假如|回忆|想起|曾经|过去(?!了)|那时|当时|以前|\b(?:plan(?:ned|ning)?|will|would|tomorrow|if|remember(?:ed)?|recall(?:ed)?|ago|formerly)\b/iu;
const TIME_FACTORS = new Map<string, number>([
  ['milliseconds', 1], ['seconds', 1_000], ['minutes', 60_000], ['hours', 3_600_000], ['days', 86_400_000],
]);
const TIME_LABELS = new Map<string, readonly string[]>([
  ['milliseconds',['milliseconds','millisecond','毫秒']], ['seconds',['seconds','second','秒']],
  ['minutes',['minutes','minute','分钟']], ['hours',['hours','hour','小时']], ['days',['days','day','天']],
]);

/** Fold trusted baseline settings and active accepted-source candidates into one deterministic state. */
export function foldWorldState(
  settings: WorldSettings,
  sources: readonly WorldSourceEffects[],
  options: { nowMs?: number; monotonicFloorMs?: number } = {},
): WorldFoldResult {
  const validated = validateSettings(settings);
  const issues: WorldIssue[] = [];
  const uniqueSources = uniqueSourceRevisions(sources, issues);
  const validSources: WorldSourceEffects[] = [];
  for (const source of uniqueSources) {
    const sourceIssues = validateSource(source);
    if (sourceIssues.length) issues.push(...sourceIssues);
    else validSources.push(source);
  }
  let state = cloneState(validated.initial);
  if (settings.mode === 'companion') {
    const bounds = [settings.startTimeMs, options.nowMs, options.monotonicFloorMs,
      ...validSources.map(source => source.acceptedAtMs)].filter((value): value is number => isTime(value));
    state.timeMs = bounds.reduce((latest,value)=>Math.max(latest,value),settings.startTimeMs);
  }
  const receipts: WorldEffectReceipt[] = [];
  let purchases = new Map<string, PurchaseIndexEntry>();

  for (const source of validSources) {
    const trial = cloneState(state);
    const trialPurchases = clonePurchaseIndex(purchases);
    const localReceipts: WorldEffectReceipt[] = [];
    const localIssues: WorldIssue[] = [];
    const candidates = uniqueCandidates(source, localIssues);
    for (const raw of candidates) {
      const result = applyCandidate(validated, trial, trialPurchases, source, raw);
      if ('issue' in result) localIssues.push(result.issue);
      else localReceipts.push(result.receipt);
    }
    if (localIssues.length) { issues.push(...localIssues); continue; }
    state = trial;
    purchases = trialPurchases;
    receipts.push(...localReceipts);
  }

  return { state: serializeState(settings, state), receipts, issues };
}

/** Project only state whose complete baseline-and-mutation history is visible to this reader. */
export function projectWorldState(result: WorldFoldResult, readerId: string): WorldProjection {
  const known = readerId === WORLD_PLAYER_ID
    || result.state.actorIds.includes(readerId);
  if (!known) throw new Error('invalid_world_reader');
  return {
    mode: result.state.mode,
    ...((readerId === WORLD_PLAYER_ID || result.state.publicTime) ? { timeMs: result.state.timeMs } : {}),
    balances: result.state.balances.filter(value => value.readerIds.includes(readerId))
      .map(({ ownerId, unit, value }) => ({ ownerId, unit, value })),
    inventory: result.state.inventory.filter(value => value.readerIds.includes(readerId))
      .map(({ ownerId, item, count }) => ({ ownerId, item, count })),
    receipts: result.receipts.filter(value => value.readerIds.includes(readerId))
      .map(({ readerIds: _readerIds, quote: _quote, effectId: _effectId, ...receipt }) => receipt),
  };
}

function validateSettings(settings: WorldSettings): ValidatedSettings {
  if (!isRecord(settings) || (settings.mode !== 'companion' && settings.mode !== 'story')
    || !isTime(settings.startTimeMs) || typeof settings.playerName !== 'string' || !settings.playerName
    || typeof settings.publicTime !== 'boolean' || !isRecord(settings.actorLabels)
    || !Array.isArray(settings.balances) || !Array.isArray(settings.inventory)) invalidSettings();
  const actorIds = new Set<string>();
  const actorLabels = new Map<string, readonly string[]>();
  const labelOwners = new Map<string,string>([[settings.playerName,WORLD_PLAYER_ID]]);
  for (const [id, rawLabels] of Object.entries(settings.actorLabels)) {
    if (!id || id === WORLD_PLAYER_ID || !Array.isArray(rawLabels) || !rawLabels.length
      || rawLabels.some(label => typeof label !== 'string' || !label || label==='我')) invalidSettings();
    for(const label of rawLabels) {
      const owner=labelOwners.get(label);
      if(owner!==undefined&&owner!==id) invalidSettings();
      labelOwners.set(label,id);
    }
    actorIds.add(id);
    actorLabels.set(id,[...rawLabels]);
  }
  const readerIds = new Set([WORLD_PLAYER_ID, ...actorIds]);
  const balances = new Map<string, MutableBalance>();
  for (const value of settings.balances) {
    if (!isRecord(value) || !knownOwner(value.ownerId, actorIds) || typeof value.unit !== 'string' || !value.unit
      || typeof value.value !== 'string' || !MONEY.test(value.value)) invalidSettings();
    const readers = baselineReaders(value.readerIds, readerIds);
    const key = pairKey(value.ownerId, value.unit);
    if (balances.has(key)) invalidSettings();
    balances.set(key, { ownerId:value.ownerId, unit:value.unit, cents:moneyToCents(value.value), readerIds:readers });
  }
  const inventory = new Map<string, MutableInventory>();
  for (const value of settings.inventory) {
    const count=value.count;
    if (!isRecord(value) || !knownOwner(value.ownerId, actorIds) || typeof value.item !== 'string' || !value.item
      || typeof count!=='number'||!Number.isSafeInteger(count) || count < 0) invalidSettings();
    const readers = baselineReaders(value.readerIds, readerIds);
    const key = pairKey(value.ownerId, value.item);
    if (inventory.has(key)) invalidSettings();
    inventory.set(key, { ownerId:value.ownerId, item:value.item, count, readerIds:readers });
  }
  return { settings, actorIds, actorLabels, initial:{timeMs:settings.startTimeMs, balances, inventory} };
}

function applyCandidate(validated: ValidatedSettings, state: MutableState, purchases: Map<string, PurchaseIndexEntry>, source: WorldSourceEffects, raw: unknown):
  { receipt: WorldEffectReceipt } | { issue: WorldIssue } {
  const base = readBase(raw, source);
  if ('code' in base) return {issue:issue(source, base.effectId, base.code)};
  const { candidate, effectId, quote, classification, evidence } = base;
  const kind = candidate.kind;
  if (kind !== 'clock_absolute' && kind !== 'clock_advance' && kind !== 'purchase' && kind !== 'refund' && kind !== 'consume') {
    return {issue:issue(source,effectId,'unsupported_world_effect')};
  }
  if (classification === 'current' && TEMPORAL_GUARD.test(quote)) return {issue:issue(source,effectId,'temporal_guard')};
  const readers = observedReaders(validated, source, evidence);
  if (classification === 'current' && !readers.length) return {issue:issue(source,effectId,'effect_not_observed')};
  const receipt: WorldEffectReceipt = {sourceId:source.sourceId,revision:source.revision,effectId,kind,quote,
    readerIds:readers,timeClassification:classification,applied:false};

  if (kind === 'clock_absolute') {
    if (!candidateKeys(candidate,['effectId','kind','quote','timeClassification','timestamp','timestampQuote'])
      || typeof candidate.timestamp !== 'string' || typeof candidate.timestampQuote !== 'string'
      || candidate.timestampQuote !== candidate.timestamp || !quote.includes(candidate.timestampQuote)) {
      return {issue:issue(source,effectId,'invalid_clock_effect')};
    }
    const timestamp = timestampMs(candidate.timestamp);
    if (timestamp === null) return {issue:issue(source,effectId,'invalid_clock_timestamp')};
    if (classification !== 'current') return {receipt:{...receipt,ignoredReason:'non_current'}};
    if (validated.settings.mode === 'companion') return {receipt:{...receipt,ignoredReason:'companion_clock'}};
    if (timestamp < state.timeMs) return {issue:issue(source,effectId,'world_time_backward')};
    state.timeMs=timestamp;
    return {receipt:{...receipt,applied:true,clockSetMs:timestamp}};
  }
  if (kind === 'clock_advance') {
    const amount=candidate.amount;
    if (!candidateKeys(candidate,['effectId','kind','quote','timeClassification','amount']) || !isRecord(amount)
      || !exactKeys(amount,['value','quote','unit']) || typeof amount.value !== 'string'
      || typeof amount.quote !== 'string' || typeof amount.unit !== 'string'
      || !TIME_FACTORS.has(amount.unit) || !timeAmountGrounded(amount.value,amount.quote,amount.unit,quote)) {
      return {issue:issue(source,effectId,'invalid_clock_effect')};
    }
    const amountValue=amount.value,amountQuote=amount.quote,amountUnit=amount.unit;
    const delta = safeProduct(amountValue, TIME_FACTORS.get(amountUnit)!);
    if (delta === null) return {issue:issue(source,effectId,'invalid_clock_effect')};
    if (classification !== 'current') return {receipt:{...receipt,ignoredReason:'non_current'}};
    if (validated.settings.mode === 'companion') return {receipt:{...receipt,ignoredReason:'companion_clock'}};
    if (!Number.isSafeInteger(state.timeMs + delta)) return {issue:issue(source,effectId,'world_time_overflow')};
    state.timeMs+=delta;
    return {receipt:{...receipt,applied:true,clockDeltaMs:delta}};
  }
  if (kind === 'purchase') {
    const purchase = validatePurchase(validated, source, candidate, quote);
    if ('code' in purchase) return {issue:issue(source,effectId,purchase.code)};
    if (classification !== 'current') return {receipt:{...receipt,ignoredReason:'non_current'}};
    const balance=state.balances.get(pairKey(purchase.ownerId,purchase.unit));
    const item=state.inventory.get(pairKey(purchase.ownerId,purchase.item));
    if (!balance || !item) return {issue:issue(source,effectId,'unconfigured_world_asset')};
    if (balance.cents<purchase.costCents) return {issue:issue(source,effectId,'insufficient_funds')};
    if (!Number.isSafeInteger(item.count+purchase.quantity)) return {issue:issue(source,effectId,'inventory_overflow')};
    balance.cents-=purchase.costCents;item.count+=purchase.quantity;
    restrictReaders(balance.readerIds,readers);restrictReaders(item.readerIds,readers);
    purchases.set(purchaseKey(source.sourceId,source.revision,effectId),{
      ownerId:purchase.ownerId,unit:purchase.unit,item:purchase.item,quantity:purchase.quantity,
      unitPriceCents:purchase.costCents/BigInt(purchase.quantity),readers:new Set(readers),refundedQuantity:0,
    });
    return {receipt:{...receipt,applied:true,ownerId:purchase.ownerId,unit:purchase.unit,item:purchase.item,balanceDeltaCents:`-${purchase.costCents}`,inventoryDelta:purchase.quantity}};
  }
  if (kind === 'refund') {
    const refund=validateRefund(source,candidate,quote);
    if ('code' in refund) return {issue:issue(source,effectId,refund.code)};
    if (classification !== 'current') return {receipt:{...receipt,ignoredReason:'non_current'}};
    const original=purchases.get(purchaseKey(refund.purchase.sourceId,refund.purchase.revision,refund.purchase.effectId));
    if (!original) return {issue:issue(source,effectId,'unknown_purchase_reference')};
    if (!readers.some(reader=>original.readers.has(reader))) return {issue:issue(source,effectId,'refund_not_authorized')};
    if (refund.quantity>original.quantity-original.refundedQuantity) return {issue:issue(source,effectId,'refund_quantity_exceeded')};
    const balance=state.balances.get(pairKey(original.ownerId,original.unit));
    const item=state.inventory.get(pairKey(original.ownerId,original.item));
    if (!balance || !item) return {issue:issue(source,effectId,'unconfigured_world_asset')};
    if (item.count<refund.quantity) return {issue:issue(source,effectId,'insufficient_inventory')};
    const amount=original.unitPriceCents*BigInt(refund.quantity);
    if (!Number.isSafeInteger(item.count-refund.quantity)) return {issue:issue(source,effectId,'inventory_overflow')};
    balance.cents+=amount;item.count-=refund.quantity;original.refundedQuantity+=refund.quantity;
    restrictReaders(balance.readerIds,readers);restrictReaders(item.readerIds,readers);
    return {receipt:{...receipt,readerIds:readers.filter(reader=>original.readers.has(reader)),applied:true,ownerId:original.ownerId,unit:original.unit,item:original.item,balanceDeltaCents:`${amount}`,inventoryDelta:-refund.quantity}};
  }
  const consume = validateConsume(validated, source, candidate, quote);
  if ('code' in consume) return {issue:issue(source,effectId,consume.code)};
  if (classification !== 'current') return {receipt:{...receipt,ignoredReason:'non_current'}};
  const item=state.inventory.get(pairKey(consume.ownerId,consume.item));
  if (!item) return {issue:issue(source,effectId,'unconfigured_world_asset')};
  if (item.count<consume.quantity) return {issue:issue(source,effectId,'insufficient_inventory')};
  item.count-=consume.quantity;restrictReaders(item.readerIds,readers);
  return {receipt:{...receipt,applied:true,ownerId:consume.ownerId,item:consume.item,inventoryDelta:-consume.quantity}};
}

function validatePurchase(validated:ValidatedSettings,source:WorldSourceEffects,candidate:Record<string,unknown>,quote:string):
  {ownerId:string;unit:string;item:string;quantity:number;costCents:bigint}|{code:string} {
  if (!candidateKeys(candidate,['effectId','kind','quote','timeClassification','ownerId','ownerQuote','item','itemQuote','unit','unitPrice','quantity'])
    || typeof candidate.ownerId!=='string'||typeof candidate.ownerQuote!=='string'||typeof candidate.item!=='string'
    || typeof candidate.itemQuote!=='string'||candidate.itemQuote!==candidate.item||!quote.includes(candidate.itemQuote)
    || typeof candidate.unit!=='string'||!isRecord(candidate.unitPrice)||!isRecord(candidate.quantity)
    || !exactKeys(candidate.unitPrice,['value','quote','unit'])||!exactKeys(candidate.quantity,['value','quote'])
    || typeof candidate.unitPrice.value!=='string'||typeof candidate.unitPrice.quote!=='string'||typeof candidate.unitPrice.unit!=='string'
    || candidate.unitPrice.unit!==candidate.unit||!MONEY.test(candidate.unitPrice.value)
    || typeof candidate.quantity.value!=='string'||typeof candidate.quantity.quote!=='string') return {code:'invalid_purchase_effect'};
  if (!ownerGrounded(validated,source,candidate.ownerId,candidate.ownerQuote,quote)) return {code:'owner_not_grounded'};
  if (!positiveInteger(candidate.quantity.value,candidate.quantity.quote,quote)) return {code:'quantity_not_grounded'};
  if (!moneyGrounded(candidate.unitPrice.value,candidate.unitPrice.quote,candidate.unit,quote)) return {code:'price_not_grounded'};
  const calculated=calculate({operation:'multiply',operands:[
    {value:candidate.unitPrice.value,quote:candidate.unitPrice.quote,unit:candidate.unit},
    {value:candidate.quantity.value,quote:candidate.quantity.quote,unit:null},
  ],scale:2},quote);
  if (!calculated.ok||!calculated.exact||calculated.unit!==candidate.unit) return {code:'price_not_grounded'};
  const quantity=positiveSafeInteger(candidate.quantity.value);const costCents=decimalToCents(calculated.value);
  if (quantity===null||costCents===null||costCents<=0n) return {code:'invalid_purchase_effect'};
  return {ownerId:candidate.ownerId,unit:candidate.unit,item:candidate.item,quantity,costCents};
}

function validateConsume(validated:ValidatedSettings,source:WorldSourceEffects,candidate:Record<string,unknown>,quote:string):
  {ownerId:string;item:string;quantity:number}|{code:string} {
  if (!candidateKeys(candidate,['effectId','kind','quote','timeClassification','ownerId','ownerQuote','item','itemQuote','quantity'])
    || typeof candidate.ownerId!=='string'||typeof candidate.ownerQuote!=='string'||typeof candidate.item!=='string'
    || typeof candidate.itemQuote!=='string'||candidate.itemQuote!==candidate.item||!quote.includes(candidate.itemQuote)
    || !isRecord(candidate.quantity)||!exactKeys(candidate.quantity,['value','quote'])
    || typeof candidate.quantity.value!=='string'||typeof candidate.quantity.quote!=='string') return {code:'invalid_consume_effect'};
  if (!ownerGrounded(validated,source,candidate.ownerId,candidate.ownerQuote,quote)) return {code:'owner_not_grounded'};
  if (!positiveInteger(candidate.quantity.value,candidate.quantity.quote,quote)) return {code:'quantity_not_grounded'};
  const quantity=positiveSafeInteger(candidate.quantity.value);
  return quantity===null?{code:'invalid_consume_effect'}:{ownerId:candidate.ownerId,item:candidate.item,quantity};
}

function validateRefund(source:WorldSourceEffects,candidate:Record<string,unknown>,quote:string):
  {purchase:PurchaseReference;quantity:number}|{code:string} {
  const rawPurchase=candidate.purchase;
  const purchaseSourceId=isRecord(rawPurchase)?rawPurchase.sourceId:undefined;
  const purchaseRevision=isRecord(rawPurchase)?rawPurchase.revision:undefined;
  const purchaseEffectId=isRecord(rawPurchase)?rawPurchase.effectId:undefined;
  if (!candidateKeys(candidate,['effectId','kind','quote','timeClassification','purchase','quantity'])
    || !isRecord(rawPurchase)||!exactKeys(rawPurchase,['sourceId','revision','effectId'])
    || typeof purchaseSourceId!=='string'||!purchaseSourceId
    || typeof purchaseRevision!=='number'||!Number.isSafeInteger(purchaseRevision)||purchaseRevision<1
    || typeof purchaseEffectId!=='string'||!purchaseEffectId
    || !isRecord(candidate.quantity)||!exactKeys(candidate.quantity,['value','quote'])
    || typeof candidate.quantity.value!=='string'||typeof candidate.quantity.quote!=='string') return {code:'invalid_refund_effect'};
  if (!positiveInteger(candidate.quantity.value,candidate.quantity.quote,quote)) return {code:'quantity_not_grounded'};
  const quantity=positiveSafeInteger(candidate.quantity.value);
  return quantity===null?{code:'invalid_refund_effect'}:{purchase:{
    sourceId:purchaseSourceId,revision:purchaseRevision,effectId:purchaseEffectId,
  },quantity};
}

function readBase(raw:unknown,source:WorldSourceEffects):
  {candidate:Record<string,unknown>;effectId:string;quote:string;classification:TimeClassification;evidence:WorldEffectEvidence}|{code:string;effectId?:string} {
  if (!isRecord(raw)) return {code:'invalid_world_effect'};
  const effectId=typeof raw.effectId==='string'?raw.effectId:undefined;
  if (!effectId||typeof raw.quote!=='string'||!raw.quote
    || !isClassification(raw.timeClassification)) return {code:'invalid_world_effect',effectId};
  const evidence=resolveEffectEvidence(source.text,raw.quote,raw.evidence);
  if ('code' in evidence) return {code:evidence.code,effectId};
  return {candidate:raw,effectId,quote:raw.quote,classification:raw.timeClassification,evidence};
}

function observedReaders(validated:ValidatedSettings,source:WorldSourceEffects,evidence:WorldEffectEvidence):string[] {
  const readers=new Set<string>();
  if (!source.plan||!Array.isArray(source.plan.observations)) return [];
  for (const observation of source.plan.observations) {
    if (!observation||observation.kind!=='observed'||typeof observation.quote!=='string'
      || !isTime(observation.start)||!isTime(observation.end)||observation.start>=observation.end
      || observation.end>source.text.length||source.text.slice(observation.start,observation.end)!==observation.quote
      || observation.start>evidence.start||observation.end<evidence.end) continue;
    if (Array.isArray(observation.readers)) for (const id of observation.readers) if (validated.actorIds.has(id)) readers.add(id);
    if (observation.playerVisible===true && typeof observation.playerEvidence==='string'
      && playerEvidenceCovers(source.text,observation.start,observation.end,observation.playerEvidence,evidence)) readers.add(WORLD_PLAYER_ID);
  }
  return [...readers].sort();
}
function playerEvidenceCovers(text:string,observationStart:number,observationEnd:number,playerEvidence:string,evidence:WorldEffectEvidence):boolean {
  if(!playerEvidence) return false;
  let occurrences=0;let coversEffect=false;
  for(let start=text.indexOf(playerEvidence,observationStart);start>=0;start=text.indexOf(playerEvidence,start+1)) {
    const end=start+playerEvidence.length;
    if(start>=observationEnd) break;
    if(end>observationEnd) continue;
    occurrences++;
    if(start<=evidence.start&&evidence.end<=end) coversEffect=true;
  }
  return occurrences===1&&coversEffect;
}

function ownerGrounded(validated:ValidatedSettings,source:WorldSourceEffects,ownerId:string,ownerQuote:string,effectQuote:string):boolean {
  if (!effectQuote.includes(ownerQuote)) return false;
  if (ownerId===WORLD_PLAYER_ID) {
    if (ownerQuote===validated.settings.playerName) return true;
    return ownerQuote==='我'&&source.role==='user'&&source.text.startsWith('我')&&source.text.startsWith(effectQuote);
  }
  return validated.actorLabels.get(ownerId)?.includes(ownerQuote)===true;
}

function uniqueSourceRevisions(sources:readonly WorldSourceEffects[],issues:WorldIssue[]):WorldSourceEffects[] {
  const seen=new Map<string,{fingerprint:string;source:WorldSourceEffects}>();const conflicts=new Set<string>();
  for (const source of sources) {
    const sourceId=isRecord(source)&&typeof source.sourceId==='string'?source.sourceId:'';
    const revision=isRecord(source)&&Number.isSafeInteger(source.revision)?source.revision:0;
    const key=pairKey(sourceId,String(revision));let fingerprint:string;
    try { fingerprint=canonical(source); } catch { issues.push({sourceId,revision,code:'invalid_world_source'});continue; }
    const prior=seen.get(key);
    if (!prior) seen.set(key,{fingerprint,source});
    else if (prior.fingerprint!==fingerprint) {
      conflicts.add(key);issues.push({sourceId,revision,code:'duplicate_source_conflict'});
    }
  }
  return [...seen.entries()].filter(([key])=>!conflicts.has(key)).map(([,value])=>value.source);
}

function uniqueCandidates(source:WorldSourceEffects,issues:WorldIssue[]):unknown[] {
  const seen=new Map<string,{fingerprint:string;candidate:unknown;effectId:string;kind:string;evidence:WorldEffectEvidence}>();
  const conflicts=new Set<string>();const anonymous:unknown[]=[];
  for (const candidate of source.candidates) {
    const base=readBase(candidate,source);
    if ('code' in base) {anonymous.push(candidate);continue;}
    let fingerprint:string;try{fingerprint=canonicalBusinessCandidate(base.candidate);}catch{anonymous.push(candidate);continue;}
    const kind=typeof base.candidate.kind==='string'?base.candidate.kind:'__invalid__';
    const key=canonical({sourceId:source.sourceId,revision:source.revision,kind,evidence:base.evidence});
    const prior=seen.get(key);
    if (!prior) seen.set(key,{fingerprint,candidate,effectId:base.effectId,kind,evidence:base.evidence});
    else if (prior.fingerprint!==fingerprint) {conflicts.add(key);issues.push(issue(source,base.effectId,'duplicate_effect_conflict'));}
  }
  const entries=[...seen.entries()];
  for(let left=0;left<entries.length;left++) for(let right=left+1;right<entries.length;right++) {
    const [leftKey,leftValue]=entries[left]!;const [rightKey,rightValue]=entries[right]!;
    if(leftValue.kind!==rightValue.kind||leftValue.fingerprint!==rightValue.fingerprint
      ||!spansOverlap(leftValue.evidence,rightValue.evidence)) continue;
    conflicts.add(leftKey);conflicts.add(rightKey);
    issues.push(issue(source,rightValue.effectId,'overlapping_effect_evidence'));
  }
  return entries.filter(([key])=>!conflicts.has(key)).map(([,value])=>value.candidate).concat(anonymous);
}

function validateSource(source:WorldSourceEffects):WorldIssue[] {
  if (!isRecord(source)||typeof source.sourceId!=='string'||!source.sourceId||!Number.isSafeInteger(source.revision)||source.revision<1
    ||(source.role!=='user'&&source.role!=='assistant')||typeof source.text!=='string'||!isTime(source.acceptedAtMs)
    ||!isRecord(source.plan)||!Array.isArray(source.plan.observations)||!Array.isArray(source.candidates)||source.candidates.length>64) {
    return [{sourceId:isRecord(source)&&typeof source.sourceId==='string'?source.sourceId:'',revision:isRecord(source)&&Number.isSafeInteger(source.revision)?source.revision:0,code:'invalid_world_source'}];
  }
  return [];
}

function serializeState(settings:WorldSettings,state:MutableState):WorldState {
  return {mode:settings.mode,timeMs:state.timeMs,publicTime:settings.publicTime,actorIds:Object.keys(settings.actorLabels).sort(),
    balances:[...state.balances.values()].map(value=>({ownerId:value.ownerId,unit:value.unit,value:centsToMoney(value.cents),readerIds:[...value.readerIds].sort()})),
    inventory:[...state.inventory.values()].map(value=>({ownerId:value.ownerId,item:value.item,count:value.count,readerIds:[...value.readerIds].sort()}))};
}

function cloneState(state:MutableState):MutableState {
  return {timeMs:state.timeMs,
    balances:new Map([...state.balances].map(([key,value])=>[key,{...value,readerIds:new Set(value.readerIds)}])),
    inventory:new Map([...state.inventory].map(([key,value])=>[key,{...value,readerIds:new Set(value.readerIds)}]))};
}
function clonePurchaseIndex(source:Map<string,PurchaseIndexEntry>):Map<string,PurchaseIndexEntry> {
  return new Map([...source].map(([key,value])=>[key,{...value,readers:new Set(value.readers)}]));
}

function baselineReaders(value:unknown,allowed:Set<string>):Set<string> {
  if (value===undefined) return new Set([WORLD_PLAYER_ID]);
  if (!Array.isArray(value)||value.some(id=>typeof id!=='string'||!allowed.has(id))) invalidSettings();
  return new Set(value as string[]);
}
function restrictReaders(target:Set<string>,readers:string[]):void { for(const id of [...target]) if(!readers.includes(id)) target.delete(id); }
function knownOwner(value:unknown,actors:Set<string>):value is string { return value===WORLD_PLAYER_ID||(typeof value==='string'&&actors.has(value)); }
function pairKey(left:string,right:string):string { return JSON.stringify([left,right]); }
function purchaseKey(sourceId:string,revision:number,effectId:string):string { return canonical({sourceId,revision,effectId}); }
function issue(source:WorldSourceEffects,effectId:string|undefined,code:string):WorldIssue {
  return {sourceId:source.sourceId,revision:source.revision,...(effectId?{effectId}:{}),code};
}
function isClassification(value:unknown):value is TimeClassification { return value==='current'||value==='plan'||value==='recall'||value==='hypothetical'||value==='unknown'; }
function isTime(value:unknown):value is number { return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0; }
function isRecord(value:unknown):value is Record<string,unknown> { return !!value&&typeof value==='object'&&!Array.isArray(value); }
function exactKeys(value:Record<string,unknown>,keys:string[]):boolean { const allowed=new Set(keys);return keys.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>allowed.has(key)); }
function candidateKeys(value:Record<string,unknown>,keys:string[]):boolean {
  const allowed=new Set([...keys,'evidence']);
  return keys.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>allowed.has(key));
}
function invalidSettings():never { throw new Error('invalid_world_settings'); }

function moneyToCents(value:string):bigint { const [whole,fraction]=value.split('.') as [string,string];return BigInt(whole)*100n+BigInt(fraction); }
function decimalToCents(value:string):bigint|null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole,fraction='']=value.split('.');return BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));
}
function centsToMoney(value:bigint):string { const whole=value/100n;const fraction=(value%100n).toString().padStart(2,'0');return `${whole}.${fraction}`; }
function positiveSafeInteger(value:string):number|null {
  if(!POSITIVE_INTEGER.test(value))return null;const parsed=Number(value);return Number.isSafeInteger(parsed)?parsed:null;
}
function positiveInteger(value:string,valueQuote:string,effectQuote:string):boolean {
  return positiveSafeInteger(value)!==null&&groundedNumeric(value,valueQuote,effectQuote);
}
function groundedNumeric(value:string,valueQuote:string,effectQuote:string):boolean {
  const quoteStart=effectQuote.indexOf(valueQuote);
  if(quoteStart<0||effectQuote.indexOf(valueQuote,quoteStart+1)>=0) return false;
  for(let start=valueQuote.indexOf(value);start>=0;start=valueQuote.indexOf(value,start+1)) {
    if(numericTokenAt(value,valueQuote,start)&&numericTokenAt(value,effectQuote,quoteStart+start)) return true;
  }
  return false;
}
function moneyGrounded(value:string,valueQuote:string,unit:string,effectQuote:string):boolean {
  if(!groundedNumeric(value,valueQuote,effectQuote)) return false;
  const quoteStart=effectQuote.indexOf(valueQuote);
  const valueStart=valueQuote.indexOf(value);
  if(valueStart<0||valueQuote.indexOf(value,valueStart+1)>=0) return false;
  let unitStart=valueStart+value.length;
  while(unitStart<valueQuote.length&&/\s/u.test(valueQuote[unitStart]!)) unitStart++;
  if(!valueQuote.startsWith(unit,unitStart)||!completeQuoteTail(valueQuote.slice(unitStart+unit.length))) return false;
  return currencyEffectTailAllowed(effectQuote.slice(quoteStart+valueQuote.length));
}
function timeAmountGrounded(value:string,amountQuote:string,unit:string,effectQuote:string):boolean {
  if (positiveSafeInteger(value)===null) return false;
  const effectStart=effectQuote.indexOf(amountQuote);
  if(effectStart<0||effectQuote.indexOf(amountQuote,effectStart+1)>=0) return false;
  for(let start=amountQuote.indexOf(value);start>=0;start=amountQuote.indexOf(value,start+1)) {
    if (!numericTokenAt(value,amountQuote,start)||!numericTokenAt(value,effectQuote,effectStart+start)) continue;
    let unitStart=start+value.length;
    while(unitStart<amountQuote.length&&/\s/u.test(amountQuote[unitStart]!)) unitStart++;
    let longest=0;const units=new Set<string>();
    for(const [candidateUnit,labels] of TIME_LABELS) for(const label of labels) {
      if (!amountQuote.startsWith(label,unitStart)) continue;
      if(!completeQuoteTail(amountQuote.slice(unitStart+label.length))) continue;
      if(label.length>longest){longest=label.length;units.clear();}
      if(label.length===longest) units.add(candidateUnit);
    }
    if(longest>0&&units.has(unit)&&timeEffectTailAllowed(effectQuote.slice(effectStart+amountQuote.length))) return true;
  }
  return false;
}
function completeQuoteTail(tail:string):boolean { return /^[\s，。！？、；：,;.!?]*$/u.test(tail); }
function timeEffectTailAllowed(tail:string):boolean {
  return tail===''||/^[\s，。！？、；：,;.!?]/u.test(tail)||/^(?:后|过去|了)/u.test(tail);
}
function currencyEffectTailAllowed(tail:string):boolean {
  return tail===''||/^[\s，。！？、；：,;.!?]/u.test(tail)||/^[买购花付支给收后]/u.test(tail);
}
function numericTokenAt(value:string,quote:string,start:number):boolean {
  const before=start===0?'':quote[start-1]!;
  const after=quote[start+value.length]??'';
  if(/[\d.A-Za-z_,:/+\-＋－−\p{Pd}]/u.test(before)||/[\d.A-Za-z_,:/+\-＋－−\p{Pd}]/u.test(after)) return false;
  let previous=start-1;
  while(previous>=0&&/\s/u.test(quote[previous]!)) previous--;
  return previous<0||!/[+\-＋－−\p{Pd}]/u.test(quote[previous]!);
}
function resolveEffectEvidence(text:string,quote:string,raw:unknown):WorldEffectEvidence|{code:string} {
  if(raw!==undefined) {
    if(!isRecord(raw)||!exactKeys(raw,['start','end'])||!isTime(raw.start)||!isTime(raw.end)||raw.start>=raw.end||raw.end>text.length
      ||text.slice(raw.start,raw.end)!==quote) return {code:'invalid_world_effect'};
    return {start:raw.start,end:raw.end};
  }
  let start=text.indexOf(quote);if(start<0) return {code:'invalid_world_effect'};
  if(text.indexOf(quote,start+1)>=0) return {code:'ambiguous_effect_evidence'};
  return {start,end:start+quote.length};
}
function canonicalBusinessCandidate(candidate:Record<string,unknown>):string {
  const {effectId:_effectId,evidence:_evidence,quote:_quote,...business}=candidate;
  return canonical(business);
}
function spansOverlap(left:WorldEffectEvidence,right:WorldEffectEvidence):boolean {
  return left.start<right.end&&right.start<left.end;
}
function safeProduct(value:string,factor:number):number|null {
  if(!POSITIVE_INTEGER.test(value))return null;const result=BigInt(value)*BigInt(factor);return result<=BigInt(Number.MAX_SAFE_INTEGER)?Number(result):null;
}
function timestampMs(value:string):number|null {
  const match=ISO_WITH_ZONE.exec(value);if(!match)return null;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]);
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)return null;
  if(match[8]!=='Z'){const [zoneHour,zoneMinute]=match[8]!.slice(1).split(':').map(Number);if(zoneHour!>23||zoneMinute!>59)return null;}
  const parsed=Date.parse(value);return isTime(parsed)?parsed:null;
}
function canonical(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('invalid');return JSON.stringify(value);}
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(isRecord(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw new Error('invalid');
}
