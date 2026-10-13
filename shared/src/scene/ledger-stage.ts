import {foldForMatch, scriptQuoteSearch} from '../common/script-fold.ts';
import {scanAmounts, scanQuantities, scanRates, scanNumbers, overlapping} from '../common/amount-expressions.ts';
import {mayNeedCalculation} from '../core/calculation-intent.ts';
import {
  createCalculationExecution,
  executeCalculation,
  computeCalculations,
  listCalculationLeaves,
  type CalculationExecution,
  type JsonValue,
} from '../core/calculation-requests.ts';
import {
  createToolLoop,
  createJsonToolTransport,
  type ToolDefinition,
  type ToolObject,
  type ToolLoopOptions,
  type ToolLoopResult,
  type ToolLoopRun,
  type ProposalReply,
} from '../core/tool-loop.ts';
import type {Prompt, parseModelJson} from '../core/models.ts';
import {processingFingerprint} from './processing.ts';
import {
  checkLedgerProposal,
  finalizeLedgerRun,
  decodeLedger,
  ledgerEventPositions,
  type LedgerAccount,
  type LedgerAccountEvent,
  type LedgerCorrection,
  type LedgerDetail,
  type LedgerFreeze,
  type LedgerMark,
  type LedgerMarks,
  type LedgerMarkPosition,
  type LedgerProposalContext,
  type LedgerProposalResult,
  type LedgerReading,
  type LedgerSpan,
  type LedgerText,
  type LedgerUnbooked,
  type LedgerUnbookedReason,
  type StoredLedger,
} from './world-ledger.ts';
import type {WorldSettings, WorldSourceEffects} from './world-state.ts';
import type {WorldStageMarks} from './world-extraction.ts';
import {
  appendLedgerReading,
  ledgerEntryView,
  ledgerNumberReading,
  ledgerValueTable,
  LEDGER_RECENT_MESSAGE_COUNT,
  type LedgerInputBundle,
  type LedgerInputRequest,
  type LedgerSelection,
  type LedgerTables,
} from './ledger-stage-input.ts';
import {
  checkLedgerTool,
  ledgerProposalFeedback,
  trimLedgerItems,
  LEDGER_SYSTEM_PROMPT,
  LEDGER_CORRECTIONS,
} from './ledger-stage-tools.ts';

// Accept m0 and m-1 through m-N without leading zeros; N is LEDGER_RECENT_MESSAGE_COUNT.
// The character-class construction requires an integer N from 1 through 9.
const MESSAGE_CONTAINER_PATTERN = new RegExp(`^m(?:0|-[1-${LEDGER_RECENT_MESSAGE_COUNT}])$`);
// Ruled quote-search cap per read call, bounding repeated-occurrence parser work.
const READ_QUOTE_MATCH_COUNT = 64;
// Ruled readable-row and nearby-reference limits per read call; update the tool description with this cap.
const READ_RESULT_COUNT = 6;
// Ruled default entry count per lookup; the tool description states this value and must change with it.
const LOOKUP_DEFAULT_ENTRIES = 5;
// Ruled default source count per lookup; the tool description states this value and must change with it.
const LOOKUP_DEFAULT_SOURCES = 50;

/** Ledger-only contract, independent of the default world-stage version 3. */
export const LEDGER_STAGE_CONTRACT = 4;

/** Explicit loop limits: the first nine are provisional pending acceptance calibration.
 * The last two use the loop's hardened UTF-16 result limits. */
export const LEDGER_STAGE_LIMITS = Object.freeze(
  {
    requests: 8,
    totalMs: 120000,
    requestMs: 60000,
    minimumMs: 2000,
    transportFailures: 3,
    badFormats: 2,
    outputCharacters: 12000,
    replayCodePoints: 600,
    backoffMs: 250,
    resultCharacters: 12000,
    runResultCharacters: 48000,
  }
);

/** Pure prefilter inputs: units are account-row names; names excludes private-account personal names. */
export interface LedgerMarkRequest {
  decoded: WorldStageMarks | null;
  text: string;
  role: 'user' | 'assistant';
  units: readonly string[];
  names: readonly string[];
  bookable: boolean;
}

/** Collects active account units/names and bookability at an already-folded position. Bad input returns null. */
export function ledgerMarkContext(
  settings: WorldSettings | null,
  accounts: readonly LedgerAccount[]): {
    units: string[];
    names: string[];
    bookable: boolean;
  } | null {
  try {
    const active = accounts.filter(account => account.status !== 'closed');
    return {
      units: [...new Set(active.flatMap(account => account.rows.map(row => foldForMatch(row.unit))))],
      names: active.filter(account => account.kind !== 'private')
        .flatMap(account => [account.label, ...account.aliases]),
      bookable: Boolean(settings && (settings.balances.length || settings.inventory.length))
        || active.some(account => account.kind !== 'private'),
    };
  } catch {
    return null;
  }
}

/** Preserves decoded marks and applies only the ruled fallback. Positions are UTF-16; empty/invalid results
 * return null.
 */
export function resolveLedgerMarks(
  request: LedgerMarkRequest): LedgerMarks | null {
  try {
    const decoded = request.decoded;
    let origin: LedgerMarks['origin'] = decoded?.origin ?? 'unavailable';
    const money = decoded?.money.map(mark => ({...mark})) ?? [];
    const math = decoded?.math.map(mark => ({...mark})) ?? [];
    const use = decoded?.use.map(mark => ({...mark})) ?? [];
    const unavailable = origin === 'unavailable';
    const empty = money.length === 0 && math.length === 0 && use.length === 0;
    if (unavailable || (empty && request.bookable)) {
      // Marked candidates retain a unit and intentionally participate in both prefilters.
      const amount = scanAmounts(request.text, {units: [...request.units]}).some(value => value.unit !== null);
      if (unavailable) {
        const named = [...request.units, ...request.names].some(
          name => name.trim() !== ''
            && scriptQuoteSearch(request.text, name, 1).matches.length > 0);
        if (amount || named) money.push({whole: true});
        if (mayNeedCalculation(request.text)) math.push({whole: true});
        if (money.length || math.length) origin = 'prefilter';
      } else if (amount) {
        money.push({whole: true});
        origin = 'code';
      }
    }
    return money.length || math.length || use.length
      ? {contract: LEDGER_STAGE_CONTRACT, origin, money, math, use}
      : null;
  } catch {
    return null;
  }
}

/** Ordered execution choice. A no-work decision neither hashes nor waits; invalid input returns none. */
export type LedgerRunDecision = {kind: 'none'} | {
  kind: 'not_run';
  stop: 'host' | 'turn_degraded' | 'not_configured';
  selection: LedgerSelection;
} | {kind: 'run'; selection: LedgerSelection};

/** Applies scope, work, host, perspective and configuration gates in that order; never starts a run. */
export function decideLedgerRun(
  request: {
    storyScope: boolean;
    tavern: boolean;
    perspectiveSkipped: boolean;
    selection: LedgerSelection;
    config: {baseUrl?: string; model?: string} | null;
  }): LedgerRunDecision {
  try {
    const {selection} = request;
    if (!request.storyScope || (!selection.mode.book && !selection.mode.calc)) return {kind: 'none'};
    if (!request.tavern) return {kind: 'not_run', stop: 'host', selection};
    if (request.perspectiveSkipped) return {kind: 'not_run', stop: 'turn_degraded', selection};
    if (!request.config?.baseUrl || !request.config.model) {
      return {kind: 'not_run', stop: 'not_configured', selection};
    }
    return {kind: 'run', selection};
  } catch {
    return {kind: 'none'};
  }
}

/** Stored fact with a calculation tree and current-prose UTF-16 regions.
 * Whole marks retain their explicit whole identity. */
export interface LedgerStageFact {
  tree: JsonValue;
  forSpan: LedgerSpan | null;
  mark: LedgerMarkPosition | null;
}

/** Successful pure finish: the authority record plus cache-only transcript/debug data. Failure is represented
 * by null.
 */
export interface LedgerFinished {
  ledger: StoredLedger;
  payload: {conversation: Prompt[]; ignoredFactRefs: string[]};
}

/** Opaque per-run closure. finish is memoized so repeated callers cannot answer a proposal twice. */
export interface LedgerRunHandle {
  finish(result: ToolLoopResult): LedgerFinished | null;
}

function cloneTables(
  input: LedgerTables): LedgerTables {
  return {
    readings: Object.assign(Object.create(null), input.readings),
    rows: new Map(input.rows),
    sources: new Map(input.sources),
    entries: new Map(input.entries),
    entryRefs: Object.assign(Object.create(null), input.entryRefs),
    entryNumbers: new Map(input.entryNumbers),
    identities: new Map(input.identities),
    counters: {...input.counters},
    units: [...input.units],
    work: {...input.work},
  };
}

function locate(
  text: string,
  quote: unknown): LedgerSpan | null {
  if (typeof quote !== 'string' || quote.trim() === '') return null;
  const match = scriptQuoteSearch(text, quote, 1).matches[0];
  return match ? {start: match.start, end: match.end} : null;
}

function readingBase(
  ref: string): string {
  const amount = /^([aqru][1-9]\d*)(?:#[1-9]\d*|\.(?:min|max))?$/.exec(ref);
  return amount ? amount[1] : ref;
}

function selectedReadings(
  tables: LedgerTables,
  references: readonly string[],
  state: CalculationExecution): {
    readings: Record<string, LedgerReading>;
    entryRefs: LedgerProposalContext['entryRefs'];
  } {
  const readings: Record<string, LedgerReading> = Object.create(null);
  const entryRefs: NonNullable<LedgerProposalContext['entryRefs']> = Object.create(null);
  const add = (
    reference: string) => {
    const base = readingBase(reference);
    if (Object.hasOwn(tables.readings, base)) readings[base] = tables.readings[base];
    const entry = /^(e[1-9]\d*)(?:\.|$)/.exec(base)?.[1];
    if (entry && Object.hasOwn(tables.entryRefs, entry)) entryRefs[entry] = tables.entryRefs[entry];
  };
  for (const reference of references) {
    const computed = /^c([1-9]\d*)(?:\.(?:min|max))?$/.exec(reference);
    if (!computed) {
      add(reference);
      continue;
    }
    const tree = state.results[Number(computed[1]) - 1];
    const leaves = listCalculationLeaves(tree);
    if (leaves.ok) for (const leaf of leaves.leaves) add(leaf.ref);
  }
  return {readings, entryRefs};
}

function proposalReferences(
  args: ToolObject): string[] {
  const references: string[] = [];
  for (const entry of args.entries as ToolObject[]) {
    for (const field of ['quantity', 'amount', 'stated', 'tendered']) {
      if (typeof entry[field] === 'string') references.push(entry[field]);
    }
    const relation = entry.relation as ToolObject | null;
    if (relation && typeof relation.entry === 'string') references.push(relation.entry);
  }
  return references;
}

function proposalInput(
  args: ToolObject,
  bundle: LedgerInputBundle): ToolObject {
  // The world-ledger proposal checker binds item.in by persistent source id; the model sees local message aliases.
  const sources = new Map<string, string>([['m0', bundle.source.sourceId]]);
  bundle.previous.forEach((source, index) => sources.set(`m-${bundle.previous.length - index}`, source.sourceId));
  return {
    entries: (args.entries as ToolObject[]).map(
      entry => {
        const item = entry.item as ToolObject | null;
        if (!item || typeof item.in !== 'string' || !sources.has(item.in)) return entry;
        return {...entry, item: {...item, in: sources.get(item.in)!}};
      }),
    unbooked: args.unbooked ?? [],
  };
}

function readSource(
  tables: LedgerTables,
  container: string): LedgerText | null {
  if (MESSAGE_CONTAINER_PATTERN.test(container)) return tables.sources.get(container) ?? null;
  if (!/^e[1-9]\d*$/.test(container)) return null;
  const entry = tables.entries.get(container);
  if (!entry) return null;
  const current = tables.sources.get('m0');
  if (current?.sourceId === entry.sourceId && current.revision === entry.revision) return null;

  // History aliases and folded distance can disagree; only the visible source identity grants access.
  for (let index = 1; index <= LEDGER_RECENT_MESSAGE_COUNT; index++) {
    const source = tables.sources.get(`m-${index}`);
    if (source?.sourceId === entry.sourceId && source.revision === entry.revision) return source;
  }
  return null;
}

function nearbyReadings(
  tables: LedgerTables,
  source: LedgerText,
  quote: LedgerSpan): string[] {
  // Sentence scope ends at Chinese/Latin terminal punctuation or a newline; cap at six existing refs.
  const boundary = /[。！？.!?\r\n]/;
  let start = quote.start;
  let end = quote.end;
  while (start > 0 && !boundary.test(source.text[start - 1])) start--;
  while (end < source.text.length && !boundary.test(source.text[end])) end++;
  const result: string[] = [];
  for (const [ref, reading] of Object.entries(tables.readings)) {
    if (reading.type === 'money' || reading.type === 'integer') continue;
    if (reading.source.sourceId !== source.sourceId || reading.source.revision !== source.revision) continue;
    const span = reading.type === 'number' ? reading.span : reading.expression;
    if (span.start < end && start < span.end) result.push(ref);
    if (result.length === READ_RESULT_COUNT) break;
  }
  return result;
}

function readAmount(
  tables: LedgerTables,
  args: ToolObject): ToolObject {
  const source = readSource(tables, args.in as string);
  if (!source) return {ok: false, error: 'unknown_source'};
  const quote = args.quote as string;
  if (quote.trim() === '') return {ok: false, error: 'quote_not_found'};
  // Ruled bounded search: repeated quote occurrences cannot multiply parser scans.
  const matches = scriptQuoteSearch(source.text, quote, READ_QUOTE_MATCH_COUNT);
  if (!matches.matches.length) return {ok: false, error: 'quote_not_found'};
  const kind = args.kind as string;
  if (!['amount', 'quantity', 'rate', 'number'].includes(kind)) return {ok: false, error: 'unsupported_kind'};
  const expressions = kind === 'amount'
    ? scanAmounts(source.text, {units: tables.units})
    : kind === 'quantity'
      ? scanQuantities(source.text)
      : kind === 'rate' ? scanRates(source.text) : scanNumbers(source.text);
  const candidates = new Map<number, {start: number; end: number}>();
  for (const match of matches.matches) {
    for (const expression of overlapping(expressions, match.start, match.end)) {
      candidates.set(expression.start, expression);
    }
  }
  const found: ToolObject[] = [];
  for (const expression of [...candidates.values()].sort((left, right) => left.start - right.start)) {
    const reading = kind === 'number'
      ? ledgerNumberReading(source, expression)
      : {
        type: kind,
        source: {sourceId: source.sourceId, revision: source.revision},
        expression,
      } as LedgerReading;
    if (!reading) continue;
    const row = appendLedgerReading(tables, args.in as string, source, reading);
    if (!row) continue;
    const {in: _container, ...feedback} = row;
    found.push(feedback);
    if (found.length === READ_RESULT_COUNT) break;
  }
  if (!found.length) return {
    ok: false,
    error: 'nothing_readable',
    nearby: nearbyReadings(tables, source, matches.matches[0]),
  };
  return trimLedgerItems({ok: true, found}, 'found');
}

function parties(
  entry: LedgerDetail): NonNullable<LedgerDetail['payer']>[] {
  return [entry.payer, entry.payee, entry.receiver].filter(value => value !== null);
}

function matchesParty(
  entry: LedgerDetail,
  filter: string,
  bundle: LedgerInputBundle): boolean {
  const roster = bundle.input.roster as {id: string}[];
  if (filter === 'player' || roster.some(character => character.id === filter)) {
    return entry.actor.id === filter || parties(entry).some(party => 'account' in party && party.account === filter);
  }
  const folded = foldForMatch(filter);
  const quotes = parties(entry).map(
    party => 'external' in party
      ? party.external?.quote ?? ''
      : 'unconfigured' in party ? party.unconfigured.label?.quote ?? '' : '');
  for (const quote of Object.values(entry.externalQuotes ?? {})) {
    if (quote) quotes.push(quote.quote);
  }
  return quotes.some(quote => foldForMatch(quote).includes(folded));
}

function ledgerLookup(
  tables: LedgerTables,
  bundle: LedgerInputBundle,
  args: ToolObject): ToolObject {
  const party = args.party === '' ? null : args.party;
  const item = args.item === '' ? null : args.item;
  const kind = (args.kind as string[] | null)?.length ? args.kind as string[] : null;
  const state = (args.state as string[] | null)?.length ? args.state as string[] : null;
  if ([party, item, args.account, kind, state].every(value => value == null)) {
    return {ok: false, error: 'no_filter'};
  }
  const accounts = bundle.view.accounts.filter(account => account.status !== 'closed');
  if (args.account != null && !accounts.some(account => account.id === args.account)) {
    return {ok: false, error: 'unknown_account'};
  }
  const limit = args.limit as number ?? LOOKUP_DEFAULT_ENTRIES;
  const lastSources = args.lastSources as number ?? LOOKUP_DEFAULT_SOURCES;
  const entries = (bundle.view.before?.entries ?? []).filter(
    entry => {
      if (entry.kind === 'adjustment' || entry.laterSources >= lastSources) return false;
      if (args.account != null && !parties(entry).some(entryParty =>
        'account' in entryParty && entryParty.account === args.account)) {
        return false;
      }
      if (party != null && !matchesParty(entry, party as string, bundle)) return false;
      if (item != null && !foldForMatch(entry.item?.quote ?? '').includes(foldForMatch(item as string))) {
        return false;
      }
      if (kind != null && !kind.includes(entry.kind)) return false;
      const entryState = entry.status === 'committed' || entry.status === 'quoted' ? entry.status : entry.disposition;
      return state == null || state.includes(entryState);
    }).reverse();
  const rows = entries.slice(0, limit).map(entry => ledgerEntryView(tables, entry, true));
  if (rows.some(row => row === null)) return {ok: false, error: 'ledger_internal'};
  return trimLedgerItems({ok: true, entries: rows, more: entries.length > limit}, 'entries');
}

function factsFrom(
  args: ToolObject,
  state: CalculationExecution,
  bundle: LedgerInputBundle,
  calculationSpans: Map<string, LedgerSpan>,
): {facts: LedgerStageFact[]; ignored: string[]} {
  const facts: LedgerStageFact[] = [];
  const ignored: string[] = [];
  for (const fact of (args.facts ?? []) as ToolObject[]) {
    const ref = fact.ref as string;
    const match = /^c([1-9]\d*)$/.exec(ref);
    const tree = match ? state.results[Number(match[1]) - 1] : null;
    if (!tree) {
      ignored.push(ref);
      continue;
    }
    const money = bundle.allMarks.find(mark => mark.id.startsWith('k') && mark.id === fact.mark);
    const math = bundle.selection.math.find(mark => mark.id.startsWith('j') && mark.id === fact.mark);
    const mark = money ? ('whole' in money ? {whole: true as const} : {...money.span}) : math?.position ?? null;
    facts.push(
      {
        tree: tree as unknown as JsonValue,
        forSpan: fact.for == null ? calculationSpans.get(ref) ?? null : locate(bundle.source.text, fact.for),
        mark,
      }
    );
  }
  return {facts, ignored};
}

function traceOf(
  result: ToolLoopResult): JsonValue {
  return {transport: 'json', requests: result.log.requests, calls: result.log.calls.map(call => ({...call}))};
}

function validRecord(
  record: StoredLedger): StoredLedger | null {
  const decoded = decodeLedger(record);
  // Validate without returning the decoder's key-sorted copy: the stage's public key order is specified.
  return decoded.ok ? record : null;
}

interface LedgerToolState {
  bundle: LedgerInputBundle;
  pin: string;
  checkProposal: typeof checkLedgerProposal;
  tables: LedgerTables;
  calculations: CalculationExecution;
  calculationSpans: Map<string, LedgerSpan>;
  last: LedgerProposalResult | null;
  lastContext: LedgerProposalContext | null;
  previousItems: {id: string; passed: boolean}[];
  confirmationUsed: boolean;
  finished: boolean;
  finishedValue: LedgerFinished | null;
}

function calculateLedgerTool(runtime: LedgerToolState, args: ToolObject): ToolObject {
  const used = selectedReadings(runtime.tables, args.operands as string[], runtime.calculations);
  const values = ledgerValueTable(runtime.tables, used.readings);
  if (!values) return {ok: false, error: 'ledger_values_invalid'};

  const step = executeCalculation({op: args.op, operands: args.operands}, values, runtime.calculations);
  if (step.result.ok) {
    runtime.calculations = step.state;
    const span = locate(runtime.bundle.source.text, args.for);
    if (span) runtime.calculationSpans.set(step.result.ref, span);
  }
  return {...step.result};
}

function proposalContext(runtime: LedgerToolState, args: ToolObject): LedgerProposalContext {
  const {bundle, tables, calculations, last} = runtime;
  const used = selectedReadings(tables, proposalReferences(args), calculations);
  return {
    source: bundle.source,
    previous: bundle.previous,
    marks: bundle.selection.marks,
    readings: used.readings,
    calculations,
    settings: bundle.view.settings,
    accounts: bundle.view.accounts,
    before: bundle.view.before,
    ...(last ? {state: last.state} : {}),
    entryRefs: used.entryRefs,
    ...(bundle.frozen ? {keptEntries: bundle.frozen.keptEntries} : {}),
  };
}

function postLedgerEntries(runtime: LedgerToolState, args: ToolObject): ProposalReply {
  const compute = (args.compute ?? []) as ToolObject[];
  const operands = compute.flatMap(item => item.operands as string[]);
  const selected = selectedReadings(runtime.tables, operands, runtime.calculations);
  const values = ledgerValueTable(runtime.tables, selected.readings);
  if (!values) throw new Error('ledger_values_invalid');

  const computed = computeCalculations(compute, values, runtime.calculations);
  runtime.calculations = computed.state;
  const context = proposalContext(runtime, args);
  const checked = runtime.checkProposal(proposalInput(args, runtime.bundle), context);
  if (checked.error) throw new Error(checked.error);

  const items = checked.entries.map(entry => ({
    id: entry.id,
    passed: entry.verdict === 'accepted' || entry.verdict === 'flagged',
  }));
  const settled = checked.entries.every(entry => entry.verdict !== 'returned') && checked.uncovered.length === 0;
  const present = new Set(items.map(item => item.id));
  const confirmation = settled && !runtime.confirmationUsed
    && runtime.previousItems.some(item => item.passed && !present.has(item.id));
  const result = ledgerProposalFeedback(checked, computed.steps.map(step => step.result), !settled || confirmation);

  // Feedback can still be rejected by the loop; finish discards all versions on failure.
  runtime.last = checked;
  runtime.lastContext = context;
  runtime.previousItems = items;
  if (confirmation) runtime.confirmationUsed = true;
  return {result, items, settled};
}

function finishLedgerRecord(runtime: LedgerToolState, result: ToolLoopResult): LedgerFinished | null {
  const {bundle, last, calculations, calculationSpans, pin} = runtime;
  const defaultReason = result.stop === 'done' || result.stop === 'kept'
    ? 'not_covered'
    : result.stop === 'requests' || result.stop === 'time' ? 'stage_cap' : 'stage_unavailable';
  const finalized = finalizeLedgerRun({
    source: bundle.source,
    marks: bundle.allMarks,
    last: result.lastProposal ? last : null,
    ...(bundle.frozen ? {frozen: bundle.frozen} : {}),
    withdrawn: result.withdrawn,
    defaultReason,
  });
  if (!finalized.ok) return null;

  // Facts resolve against the final calculation state, including results produced after the last proposal.
  const facts = result.lastProposal
    ? factsFrom(result.lastProposal.args, calculations, bundle, calculationSpans)
    : {facts: [], ignored: []};
  const record = validRecord({
    schema: 1,
    contract: LEDGER_STAGE_CONTRACT,
    pin,
    outcome: result.outcome,
    stop: result.stop,
    entries: finalized.value.entries,
    unbooked: finalized.value.unbooked,
    facts: facts.facts as unknown as JsonValue,
    trace: traceOf(result),
  });
  if (!record) return null;

  return {
    ledger: record,
    payload: {conversation: result.conversation, ignoredFactRefs: facts.ignored},
  };
}

function finishLedgerState(runtime: LedgerToolState, result: ToolLoopResult): LedgerFinished | null {
  if (runtime.finished) return runtime.finishedValue;
  runtime.finished = true;
  try {
    if (result.state === 'cancelled' || result.state === 'failed') return null;
    if (result.stop === 'kept') {
      const {last, lastContext, bundle, calculations} = runtime;
      if (!last || !lastContext || !result.lastProposal) return null;

      // The loop skipped execution for this answer; recheck without recomputing or recording another request.
      runtime.last = runtime.checkProposal(proposalInput(result.lastProposal.args, bundle), {
        ...lastContext,
        calculations,
        state: last.state,
      });
      if (runtime.last.error) return null;
    }
    runtime.finishedValue = finishLedgerRecord(runtime, result);
    return runtime.finishedValue;
  } catch {
    return null;
  }
}

function ordinaryLedgerTool(execute: (args: ToolObject) => ToolObject): (args: ToolObject) => ToolObject {
  return args => {
    try {
      return execute(args);
    } catch {
      return {ok: false, error: 'ledger_internal'};
    }
  };
}

/** Creates four synchronous tools and a memoized finish closure with copied per-run tables.
 * Checker errors and proposal exceptions escape to the loop; invalid construction returns null. */
export function createLedgerTools(
  bundle: LedgerInputBundle,
  pin: string,
  checkProposal: typeof checkLedgerProposal = checkLedgerProposal,
): {tools: ToolDefinition[]; handle: LedgerRunHandle} | null {
  try {
    const runtime: LedgerToolState = {
      bundle,
      pin,
      checkProposal,
      tables: cloneTables(bundle.tables),
      calculations: createCalculationExecution(),
      calculationSpans: new Map(),
      last: null,
      lastContext: null,
      previousItems: [],
      confirmationUsed: false,
      finished: false,
      finishedValue: null,
    };
    const tools: ToolDefinition[] = [
      {
        name: 'calculate',
        check: args => checkLedgerTool('calculate', args),
        execute: ordinaryLedgerTool(args => calculateLedgerTool(runtime, args)),
      },
      {
        name: 'read_amount',
        check: args => checkLedgerTool('read_amount', args),
        execute: ordinaryLedgerTool(args => readAmount(runtime.tables, args)),
      },
      {
        name: 'ledger_lookup',
        check: args => checkLedgerTool('ledger_lookup', args),
        execute: ordinaryLedgerTool(args => ledgerLookup(runtime.tables, bundle, args)),
      },
      {
        name: 'post_entries',
        proposal: true,
        check: args => checkLedgerTool('post_entries', args),
        // Proposal failure must end the loop rather than count as a processed version.
        execute: args => postLedgerEntries(runtime, args),
      },
    ];
    return {tools, handle: {finish: result => finishLedgerState(runtime, result)}};
  } catch {
    return null;
  }
}

/** Caller-owned transport and monotonic clock. Only input is sent; all values/state remain in the closure. */
export interface LedgerStartContext {
  bundle: LedgerInputBundle;
  pin: string;
  provider: {baseUrl: string; model: string};
  send: ToolLoopOptions<Prompt[]>['send'];
  parse: typeof parseModelJson;
  now: () => number;
  wait: NonNullable<ToolLoopOptions<Prompt[]>['wait']>;
  alive: () => boolean;
  jsonModeMemory?: Set<string>;
}

/** Starts the JSON loop synchronously without registering it. Invalid construction returns null; done never rejects. */
export function startLedgerRun(
  context: LedgerStartContext): {run: ToolLoopRun; handle: LedgerRunHandle} | null {
  try {
    const prepared = createLedgerTools(context.bundle, context.pin);
    if (!prepared) return null;
    const run = createToolLoop(
      {
        system: LEDGER_SYSTEM_PROMPT,
        input: context.bundle.input,
        tools: prepared.tools,
        transport: createJsonToolTransport(context.parse),
        send: context.send,
        provider: context.provider,
        sentences: LEDGER_CORRECTIONS,
        limits: LEDGER_STAGE_LIMITS,
        now: context.now,
        wait: context.wait,
        alive: context.alive,
        ...(context.jsonModeMemory ? {jsonModeMemory: context.jsonModeMemory} : {}),
      }
    );
    return {run, handle: prepared.handle};
  } catch {
    return null;
  }
}

/** Finalizes a matching run once, including the kept recheck. Failed/cancelled runs and invalid data return null. */
export function finishLedgerRun(
  handle: LedgerRunHandle,
  result: ToolLoopResult): LedgerFinished | null {
  try {
    return handle.finish(result);
  } catch {
    return null;
  }
}

function codeUnbooked(
  source: LedgerText,
  marks: readonly LedgerMark[],
  reason: LedgerUnbookedReason): LedgerUnbooked[] {
  return marks.map(
    mark => ({
      sourceId: source.sourceId,
      revision: source.revision,
      ...('whole' in mark ? {whole: true as const} : {span: {...mark.span}}),
      reason,
      by: 'code' as const,
    }));
}

/** Builds a zero-request not-run record. All selected money/use marks get the stop's code; invalid data
 * returns null.
 */
export function ledgerNotRun(
  stop: 'host' | 'turn_degraded' | 'not_configured',
  source: LedgerText,
  marks: readonly LedgerMark[],
  pin: string,
): StoredLedger | null {
  try {
    const reasons = {
      host: 'stage_not_available',
      turn_degraded: 'turn_degraded',
      not_configured: 'stage_not_configured'
    } as const;
    return validRecord(
      {
        schema: 1,
        contract: LEDGER_STAGE_CONTRACT,
        pin,
        outcome: 'not_run',
        stop,
        entries: [],
        unbooked: codeUnbooked(source, marks, reasons[stop]),
        facts: [],
        trace: {transport: 'json', requests: 0, calls: []},
      }
    );
  } catch {
    return null;
  }
}

/** Deferred snapshot inputs; retry retains caller-provided history, and waiting always records zero requests. */
export interface LedgerDeferredInput {
  cause: 'timeout' | 'waiting' | 'retry';
  source: LedgerText;
  marks: readonly LedgerMark[];
  pin: string;
  fingerprint: string;
  base: string;
  restarts?: number;
  trace: ToolLoopResult['log'];
  previous?: Pick<StoredLedger, 'entries' | 'unbooked'>;
}

/** Builds a deferred record without interruption handling. Invalid restarts/history/JSON return null. */
export function ledgerDeferred(
  input: LedgerDeferredInput): StoredLedger | null {
  try {
    const restarts = input.restarts ?? 0;
    if (!Number.isSafeInteger(restarts) || restarts < 0 || (input.cause === 'retry' && !input.previous)) return null;
    return validRecord(
      {
        schema: 1,
        contract: LEDGER_STAGE_CONTRACT,
        pin: input.pin,
        outcome: 'deferred',
        deferred: {fingerprint: input.fingerprint, base: input.base, cause: input.cause, restarts},
        entries: input.cause === 'retry' ? input.previous!.entries : [],
        unbooked: input.cause === 'retry'
          ? input.previous!.unbooked
          : codeUnbooked(
            input.source,
            input.marks,
            'recording'
          ),
        facts: [],
        trace: {
          transport: 'json',
          requests: input.cause === 'waiting' ? 0 : input.trace.requests,
          calls: input.trace.calls.map(call => ({...call})),
        },
      }
    );
  } catch {
    return null;
  }
}

/** Serializes a fully frozen authority selection with no requests.
 * Non-skippable or invalid frozen data returns null. */
export function ledgerFrozen(
  frozen: LedgerFreeze,
  pin: string): StoredLedger | null {
  try {
    if (!frozen.skip) return null;
    return validRecord(
      {
        schema: 1,
        contract: LEDGER_STAGE_CONTRACT,
        pin,
        outcome: 'complete',
        stop: 'frozen',
        entries: frozen.keptEntries,
        unbooked: frozen.keptUnbooked,
        facts: [],
        trace: {transport: 'json', requests: 0, calls: []},
      }
    );
  } catch {
    return null;
  }
}

/** Pins current prose, accepted identities within LEDGER_RECENT_MESSAGE_COUNT, roster and active account metadata.
 * Excludes balances/config/marks. */
export function ledgerPin(
  request: Pick<LedgerInputRequest, 'source' | 'history' | 'playerName' | 'characters'>,
  accounts: readonly LedgerAccount[]): string | null {
  try {
    return processingFingerprint(
      {
        source: {id: request.source.id, revision: request.source.revision, text: request.source.text},
        recent: request.history.filter(message => message.status === 'accepted').slice(-LEDGER_RECENT_MESSAGE_COUNT)
          .map(message => [message.id, message.revision]),
        roster: [
          {id: 'player', names: [request.playerName]},
          ...request.characters.map(
            character => ({
              id: character.id,
              names: [character.name, ...character.aliases],
            }))
        ],
        accounts: accounts.filter(account => account.status !== 'closed').slice()
          .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(
            account => ({
              id: account.id,
              kind: account.kind,
              label: account.label,
              aliases: account.aliases,
              actors: account.actors,
              units: account.rows.map(row => row.unit),
            })),
        contract: LEDGER_STAGE_CONTRACT,
      }
    );
  } catch {
    return null;
  }
}

/** Base snapshot with original serialized bodies, decoded rows and the full accepted source sequence. Position
 * counts sources.
 */
export interface LedgerBaseInput {
  settings: WorldSettings | null;
  sources: readonly WorldSourceEffects[];
  position: number;
  accountEvents: readonly {body: string; event: LedgerAccountEvent}[];
  corrections: readonly {body: string; correction: LedgerCorrection}[];
}

// Use authority event positions rather than deriving a second ordering for account and correction rows.
function ledgerBaseAuthorityRows(input: LedgerBaseInput) {
  const positions = ledgerEventPositions(
    input.sources,
    input.accountEvents.map(row => row.event),
    input.corrections.map(row => row.correction)
  );
  if (!positions.ok) return null;
  const accountPositions = new Map(positions.value.accountEvents.map(row => [row.event.id, row.position]));
  const adjustmentPositions = new Map(positions.value.adjustments.map(row => [
    `user:${row.correction.id}`,
    row.position,
  ]));
  const sourcePositions = new Map(input.sources.map((source, index) => [
    JSON.stringify([source.sourceId, source.revision]),
    index + 1,
  ]));
  const correctionPosition = (correction: LedgerCorrection): number | null => {
    if (correction.action === 'adjustment') return adjustmentPositions.get(`user:${correction.id}`) ?? null;
    if (correction.action === 'clear' && typeof correction.anchor === 'string'
      && adjustmentPositions.has(correction.anchor)) return adjustmentPositions.get(correction.anchor)!;
    return sourcePositions.get(JSON.stringify([correction.sourceId, correction.revision])) ?? null;
  };

  return {
    accountEvents: input.accountEvents.filter(row => {
      const position = accountPositions.get(row.event.id);
      return position !== undefined && position <= input.position;
    }).slice().sort((left, right) => left.event.seq - right.event.seq)
      .map(row => [row.event.id, row.event.seq, row.event.kind, processingFingerprint(row.body)]),
    corrections: input.corrections.filter(row => {
      const position = correctionPosition(row.correction);
      return position !== null && position <= input.position;
    }).slice().sort((left, right) => left.correction.seq - right.correction.seq)
      .map(row => [row.correction.seq, processingFingerprint(row.body)]),
  };
}

function sortBaseRows(rows: [string, string, string | number, readonly string[] | null][]) {
  return rows.sort((left, right) => {
    if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
    return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
  });
}

/** Hashes only authority data before the source position, including original serialized event bodies.
 * Invalid positions or body data return null. */
export function ledgerBase(input: LedgerBaseInput): string | null {
  try {
    if (!Number.isSafeInteger(input.position) || input.position < 0 || input.position > input.sources.length) {
      return null;
    }
    if (!input.accountEvents.every(row => typeof row.body === 'string')
      || !input.corrections.every(row => typeof row.body === 'string')) return null;
    const authority = ledgerBaseAuthorityRows(input);
    if (!authority) return null;
    return processingFingerprint({
      balances: sortBaseRows((input.settings?.balances ?? []).map(row => [
        row.ownerId,
        row.unit,
        row.value,
        row.readerIds ?? null,
      ])),
      inventory: sortBaseRows((input.settings?.inventory ?? []).map(row => [
        row.ownerId,
        row.item,
        row.count,
        row.readerIds ?? null,
      ])),
      sources: input.sources.slice(0, input.position).map(
        source => [
          source.sourceId,
          source.revision,
          processingFingerprint(source.candidates ?? []),
          source.ledger == null
            ? null
            : processingFingerprint(
              {
                outcome: source.ledger.outcome,
                entries: source.ledger.entries,
                unbooked: source.ledger.unbooked,
              }
            ),
        ]),
      accountEvents: authority.accountEvents,
      corrections: authority.corrections,
    });
  } catch {
    return null;
  }
}

/** Returns the cache-key input, without hashing or reading configuration. Caller hashes with processingFingerprint. */
export function ledgerFingerprintInput(
  input: Record<string, unknown>,
  config: unknown): {
    schema: 1;
    contract: 4;
    input: Record<string, unknown>;
    config: unknown;
  } {
  return {schema: 1, contract: LEDGER_STAGE_CONTRACT, input, config};
}
