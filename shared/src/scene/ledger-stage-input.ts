import {foldForMatch, scriptQuoteSearch} from '../common/script-fold.ts';
import {
  scanAmounts,
  scanQuantities,
  scanRates,
  parseAmount,
  parseQuantity,
  type AmountExpression,
  type QuantityExpression,
  type RateExpression,
  type AmountUnit,
} from '../common/amount-expressions.ts';
import {ledgerReferenceValues, foldLedgerPrefix, accountsFromFold, ledgerEventText} from './world-ledger.ts';
import {projectEventConsumerSources} from './tavern-engine/perception.ts';
import type {EventConsumerSource, EventConsumerProjection} from './tavern-engine/perception.ts';
import {filterTavernEngineSnapshot} from './tavern-engine/store.ts';
import type {AcceptedTavernTurn, captureTavernEngineRows} from './tavern-engine/store.ts';
import type {
  LedgerAccount,
  LedgerDetail,
  LedgerFold,
  LedgerFoldOptions,
  LedgerFreeze,
  LedgerKey,
  LedgerMark,
  LedgerMarks,
  LedgerMarkPosition,
  LedgerReading,
  LedgerText,
  StoredLedgerEntry,
} from './world-ledger.ts';
import {foldWorldState, type WorldSettings, type WorldSourceEffects} from './world-state.ts';
import type {ReferenceValues, ReferenceValue, JsonValue} from '../core/calculation-requests.ts';
import type {SceneCharacter, SceneState} from './types.ts';

function consumerScopeIdentity(scope: SceneState['scope']): string {
  const values = [scope.worldId, scope.sessionId, scope.branchId, scope.characterId];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('invalid_projection_identity');
    }
  }
  return JSON.stringify(values);
}

/**
 * Selects current accepted ledger turns for component consumers, using the store's lifecycle filter.
 * The state and rows must be fresh reads in the same scope. No display text is read. Work is linear in
 * sources, dependencies and ledger bytes; corrupt rows/getters propagate, absent rows return an empty list.
 */
export function currentConsumerTurns(
  state: SceneState,
  rows: ReturnType<typeof captureTavernEngineRows> | null,
): AcceptedTavernTurn[] {
  const sources = state.sources.map(source => ({
    id: source.id,
    revision: source.revision,
    status: source.status,
    message: JSON.stringify({dependencies: source.dependencies ?? []}),
  }));
  const filtered = filterTavernEngineSnapshot(rows, sources);
  const turns = (filtered?.turns ?? []).map(row => JSON.parse(row.body) as AcceptedTavernTurn);
  const latest = new Map<string, number>();
  // Even a newer, subsequently invalidated interpretation supersedes the preceding NPC turn.
  for (const row of rows?.turns ?? []) {
    latest.set(row.turn_id, Math.max(latest.get(row.turn_id) ?? 0, row.turn_revision));
  }
  const scope = consumerScopeIdentity(state.scope);
  return turns.filter(turn => consumerScopeIdentity(turn.scope) === scope
    && turn.turnRevision === latest.get(turn.turnId));
}


/**
 * Resolves one reader's current accepted events before component consumption. Store lifecycle filtering
 * remains the single implementation; the engine's pure perception graph does not import storage or clocks.
 * No display text is read. Ownership comes from all same-scope ledger rows, independently of visible events
 * and lifecycle filtering. Absent rows produce no sources; malformed rows and getter errors propagate.
 * Work is linear in sources, ledger bytes and references, plus each source's event ordering.
 */
export function eventConsumerSources(
  state: SceneState,
  rows: ReturnType<typeof captureTavernEngineRows> | null,
  readerId: string,
): EventConsumerProjection {
  const currentTurns = currentConsumerTurns(state, rows);
  const ledgerTurns = (rows?.turns ?? []).map(row => JSON.parse(row.body) as AcceptedTavernTurn);
  return projectEventConsumerSources(state, currentTurns, readerId, ledgerTurns);
}

// Ruled context on each side of a reading, in Unicode code points.
const READING_CONTEXT_CODE_POINTS = 12;
// Ruled maximum transaction quote in an input or lookup row, in Unicode code points.
const ENTRY_QUOTE_CODE_POINTS = 60;
// Ruled recent-message display threshold, in Unicode code points.
const RECENT_TEXT_CODE_POINTS = 600;
// Ruled retained head and tail of each shortened recent message, in Unicode code points.
const RECENT_TEXT_SIDE_CODE_POINTS = 300;
/** Ruled count of accepted messages shared by input selection, container access and the pin.
 * The model's recent-input explanation, read_amount container list and unknown_source condition,
 * and the ago hint also state this count; update their wording when the count changes.
 * Container patterns use a digit range, so this count must be an integer from 1 through 9. */
export const LEDGER_RECENT_MESSAGE_COUNT = 6;
// Ruled cap on previous-message amount rows; current-message rows remain unbounded.
const PREVIOUS_AMOUNT_ROW_COUNT = 24;
// Ruled limit on posted or flagged entry rows per model input.
const ENTRY_ROW_COUNT = 12;
// Ruled combined limit on all open groups per model input.
const OPEN_ROW_COUNT = 12;

/** Accepted-message identity and full prose; optional status is required for selection from history. Offsets
 * are UTF-16.
 */
export interface LedgerStageMessage {
  id: string;
  revision: number;
  role: 'user' | 'assistant';
  text: string;
  status?: 'accepted' | 'deleted' | 'needs_review';
  automatic?: boolean;
  speakerId?: string;
  replyTo?: {id: string; revision: number};
  /** When present, numeric text comes solely from this current accepted event, not text or speakerId above. */
  event?: EventConsumerSource;
}

/** Builds the inert ledger-stage message for one resolved event; no model is called and no state is written. */
export function ledgerEventMessage(event: EventConsumerSource): LedgerStageMessage {
  return {
    id: event.id,
    revision: event.revision,
    role: event.role,
    text: event.observation.quote,
    status: 'accepted',
    event,
  };
}

/** Program-selected marks and independent booking/calculation flags; no model-supplied numeric value is accepted. */
export interface LedgerSelection {
  mode: {book: boolean; calc: boolean};
  marks: LedgerMark[];
  math: {id: string; position: LedgerMarkPosition}[];
}

/** Current-prefix view from the ledger authority; accounts includes closed accounts for proposal checks. */
export interface LedgerStageView {
  settings: WorldSettings;
  accounts: LedgerAccount[];
  before: LedgerFold | null;
}

/** Pure input assembly parameters; sources is the complete accepted fold sequence, position counts earlier sources. */
export interface LedgerInputRequest {
  source: LedgerStageMessage;
  history: readonly LedgerStageMessage[];
  sources: readonly WorldSourceEffects[];
  position: number;
  settings: WorldSettings | null;
  playerName: string;
  characters: readonly Pick<SceneCharacter, 'id' | 'name' | 'aliases'>[];
  selection: LedgerSelection;
  options?: LedgerFoldOptions | null;
  frozen?: LedgerFreeze | null;
}

/** Public numeric row; decimal strings come only from parser readings. aside is present only on marked amounts. */
export interface LedgerReadingRow {
  ref: string;
  in: string;
  text: string;
  before: string;
  after: string;
  readings: string[];
  unit: string;
  range: {min: string | null; max: string | null} | null;
  approx: boolean;
  bare: boolean;
  aside?: true;
}

/** Deterministic adapter work: text passed to scans, visited candidates, quote-search work and generated rows. */
export interface LedgerStageWork {
  textUnits: number;
  candidates: number;
  searchWork: number;
  rows: number;
}

/** Per-run program tables. Map keys preserve prototype-like ids. Text and expressions never enter model
 * feedback wholesale.
 */
export interface LedgerTables {
  readings: Record<string, LedgerReading>;
  rows: Map<string, LedgerReadingRow>;
  sources: Map<string, LedgerText>;
  entries: Map<string, LedgerDetail>;
  entryRefs: Record<string, LedgerKey>;
  entryNumbers: Map<string, string>;
  identities: Map<string, JsonValue>;
  counters: {a: number; q: number; r: number; u: number; e: number};
  units: string[];
  work: LedgerStageWork;
}

/** Model input plus program-only tables and authority context; callers must send only input to the model. */
export interface LedgerInputBundle {
  input: Record<string, unknown>;
  tables: LedgerTables;
  view: LedgerStageView;
  source: LedgerText;
  previous: LedgerText[];
  selection: LedgerSelection;
  allMarks: LedgerMark[];
  frozen: LedgerFreeze | null;
}

/** Converts integer hundredths to exactly two decimals with BigInt. Invalid cents return null. O(digit count). */
export function ledgerDecimal(
  cents: string | bigint): string | null {
  try {
    const value = BigInt(cents);
    const digits = (value < 0n ? -value : value).toString().padStart(3, '0');
    return (value < 0n ? '-' : '') + digits.slice(0, -2) + '.' + digits.slice(-2);
  } catch {
    return null;
  }
}

/** Displays a parser unit; absent units are the empty string, never an invented currency. Invalid objects
 * return empty.
 */
export function ledgerUnitDisplay(
  unit: AmountUnit): string {
  try {
    return unit?.kind === 'yuan' ? '元' : unit?.kind === 'named' ? unit.word : '';
  } catch {
    return '';
  }
}

function sourceKey(
  source: {sourceId: string; revision: number}): string {
  return JSON.stringify([source.sourceId, source.revision]);
}

function textOf(
  message: LedgerStageMessage): LedgerText {
  if (message?.event != null) return ledgerEventText(message.event);
  if (!message || typeof message.id !== 'string' || !message.id || !Number.isSafeInteger(message.revision)
    || message.revision <= 0 || typeof message.text !== 'string'
    || !['user', 'assistant'].includes(message.role)) throw new Error('ledger_input_invalid');
  return {
    sourceId: message.id,
    revision: message.revision,
    role: message.role,
    text: message.text,
    ...(message.speakerId == null ? {} : {speakerId: message.speakerId}),
    ...(message.replyTo == null ? {} : {replyTo: {...message.replyTo}}),
  };
}

function normalizedSettings(
  request: Pick<LedgerInputRequest, 'settings' | 'playerName' | 'characters'>): WorldSettings {
  // Empty authority settings allow arithmetic without inventing balance or inventory rows.
  return request.settings ?? {
    mode: 'story',
    startTimeMs: 0,
    actorLabels: Object.fromEntries(
      request.characters.map(character => [character.id, [character.name, ...character.aliases]])
    ),
    playerName: request.playerName,
    publicTime: true,
    balances: [],
    inventory: [],
  };
}

/** Reads the complete-sequence prefix once and the corresponding accounts. Invalid input returns null; no
 * sequence truncation.
 */
export function ledgerStageView(
  request: Pick<LedgerInputRequest,
    'settings' | 'playerName' | 'characters' | 'sources' | 'position' | 'options'>): LedgerStageView | null {
  try {
    if (!Array.isArray(request.sources) || !Number.isSafeInteger(request.position) || request.position < 0
      || request.position > request.sources.length) return null;
    const settings = normalizedSettings(request);
    const options = {...request.options};
    const prefix = foldLedgerPrefix(settings, request.sources, request.position, options, foldWorldState);
    const accounts = accountsFromFold(settings, prefix, true);
    if (!prefix.ok || !accounts.ok) return null;
    return {settings, accounts: accounts.value, before: prefix.value.ledger ?? null};
  } catch {
    return null;
  }
}

/** Selects visible use marks by item names unless money is present. O(text × bounded marks × item names); bad
 * input returns null.
 */
export function selectLedgerMarks(
  marks: LedgerMarks | null,
  text: string,
  role: 'user' | 'assistant',
  accounts: readonly LedgerAccount[],
  bookable: boolean,
): LedgerSelection | null {
  try {
    if (typeof text !== 'string' || !['user', 'assistant'].includes(role) || !Array.isArray(accounts)) return null;
    const money = marks?.money ?? [];
    const uses = marks?.use ?? [];
    const activeItems = accounts.filter(account => account.status !== 'closed').flatMap(account => account.items);
    const selectedUse = money.length
      ? uses
      : uses.filter(
        position => {
          const span = 'whole' in position ? text : text.slice(position.start, position.end);
          return activeItems.some((
            {item}) => item.trim() !== '' && scriptQuoteSearch(
              span,
              item,
              1
            ).matches.length > 0);
        });
    const math = role === 'user' ? marks?.math ?? [] : [];
    const book = bookable && (money.length > 0 || selectedUse.length > 0);
    const toMark = (
      position: LedgerMarkPosition,
      index: number,
      kind: 'money' | 'use'): LedgerMark => ({
        id: `${kind === 'money' ? 'k' : 'y'}${index + 1}`,
        kind,
        ...('whole' in position ? {whole: true as const} : {span: {...position}}),
      });
    return {
      mode: {book, calc: math.length > 0},
      marks: book
        ? [
          ...money.map((position, index) => toMark(position, index, 'money')),
          ...selectedUse.map((position, index) => toMark(position, index, 'use')),
        ]
        : [],
      math: math.map((position, index) => ({id: `j${index + 1}`, position: {...position}})),
    };
  } catch {
    return null;
  }
}

function surrounding(
  text: string,
  position: number,
  before: boolean): string {
  let boundary = position;
  // At most 12 code points per side, including surrogate pairs; never rescan the preceding source prefix.
  for (let count = 0; count < READING_CONTEXT_CODE_POINTS; count++) {
    if (before) {
      if (boundary <= 0) break;
      boundary--;
      const code = text.charCodeAt(boundary);
      if (code >= 0xdc00 && code <= 0xdfff && boundary > 0) {
        const previous = text.charCodeAt(boundary - 1);
        if (previous >= 0xd800 && previous <= 0xdbff) boundary--;
      }
    } else {
      if (boundary >= text.length) break;
      boundary += text.codePointAt(boundary)! > 0xffff ? 2 : 1;
    }
  }
  return before ? text.slice(boundary, position) : text.slice(position, boundary);
}

function ledgerReadingDisplay(reading: Exclude<LedgerReading, {type: 'money' | 'integer'}>) {
  let values: string[] = [];
  let range: LedgerReadingRow['range'] = null;
  let unit = '';
  let approx = false;
  let bare = true;
  if (reading.type === 'amount') {
    const amount = reading.expression;
    values = amount.kind === 'readings' ? amount.readings.map(value => ledgerDecimal(value.cents)!) : [];
    range = amount.kind === 'range'
      ? {
        min: amount.min === null ? null : ledgerDecimal(amount.min),
        max: amount.max === null ? null : ledgerDecimal(amount.max),
      }
      : null;
    unit = ledgerUnitDisplay(amount.unit);
    approx = amount.approx;
    bare = amount.bare;
  } else if (reading.type === 'quantity') {
    const quantity = reading.expression;
    if (quantity.kind === 'exact') values = [String(quantity.count)];
    if (quantity.kind === 'range') {
      range = {
        min: quantity.min === null ? null : String(quantity.min),
        max: quantity.max === null ? null : String(quantity.max)
      };
      approx = true;
    }
  } else if (reading.type === 'rate') {
    const rate = reading.expression;
    // The parser's rate denominator is exactly 100; formatting is integer hundredths, never float arithmetic.
    if (rate.denominator !== 100n) return null;
    values = rate.kind === 'exact' ? [ledgerDecimal(rate.numerator)!] : [];
    range = rate.kind === 'range'
      ? {
        min: rate.min === null ? null : ledgerDecimal(rate.min),
        max: rate.max === null ? null : ledgerDecimal(rate.max),
      }
      : null;
    approx = rate.kind === 'range';
  } else values = [reading.value];

  return {values, range, unit, approx, bare};
}

/** Appends one parser expression under a fresh family ref. O(expression text); inaccessible input returns null. */
export function appendLedgerReading(
  tables: LedgerTables,
  container: string,
  source: LedgerText,
  reading: LedgerReading,
): LedgerReadingRow | null {
  try {
    if (reading.type === 'money' || reading.type === 'integer') return null;
    if (reading.type === 'quantity' && reading.expression.kind === 'unsupported') return null;
    const family = {amount: 'a', quantity: 'q', rate: 'r', number: 'u'}[reading.type] as 'a' | 'q' | 'r' | 'u';
    const expression = reading.type === 'number' ? reading.span : reading.expression;
    const display = ledgerReadingDisplay(reading);
    if (!display) return null;
    const {values, range, unit, approx, bare} = display;

    const ref = `${family}${tables.counters[family] + 1}`;
    const row: LedgerReadingRow = {
      ref,
      in: container,
      text: source.text.slice(expression.start, expression.end),
      before: surrounding(source.text, expression.start, true),
      after: surrounding(source.text, expression.end, false),
      readings: values,
      unit,
      range,
      approx,
      bare,
    };
    if (reading.type === 'amount' && Object.hasOwn(reading.expression, 'setAsideLeftNumerals')) row.aside = true;
    tables.counters[family]++;
    tables.readings[ref] = reading;
    tables.rows.set(ref, row);
    tables.work.rows++;
    return row;
  } catch {
    return null;
  }
}

/** Reads one number span via existing parsers only. Fragments beyond their 40-code-point bound or ambiguity
 * return null.
 */
export function ledgerNumberReading(
  source: LedgerText,
  span: {start: number; end: number}): LedgerReading | null {
  try {
    const fragment = source.text.slice(span.start, span.end);
    const amount = parseAmount(fragment);
    let value: string | null = null;
    if (amount?.kind === 'readings' && amount.start === 0 && amount.end === fragment.length
      && amount.readings.length === 1 && amount.readings[0].end === fragment.length) {
      value = ledgerDecimal(amount.readings[0].cents);
    } else {
      const quantity = parseQuantity(fragment);
      if (quantity?.kind === 'exact' && quantity.start === 0 && quantity.end === fragment.length) value = String(
        quantity.count
      );
    }
    return value === null
      ? null
      : {
        type: 'number',
        source: {
          sourceId: source.sourceId,
          revision: source.revision
        },
        span,
        value
      };
  } catch {
    return null;
  }
}

function moneyUnit(
  row: string | null,
  unit: AmountUnit): {key: string; display: string} | null {
  const display = row ?? ledgerUnitDisplay(unit);
  if (!display) return null;
  const folded = foldForMatch(display);
  return {key: unit?.kind === 'yuan' || ['元', '圆', '块'].includes(folded) ? 'yuan' : folded, display};
}

/** Assigns a stable e number and authority-derived values. Missing monetary units omit money refs, never the detail. */
export function ledgerEntryReference(
  tables: LedgerTables,
  entry: LedgerDetail): string | null {
  try {
    if (entry.kind === 'adjustment') return null;
    const key = JSON.stringify(entry.key);
    const existing = tables.entryNumbers.get(key);
    if (existing) return existing;
    const ref = `e${++tables.counters.e}`;
    tables.entryNumbers.set(key, ref);
    tables.entries.set(ref, entry);
    tables.entryRefs[ref] = entry.key;
    const money = entry.stated ?? entry.amount;
    const unit = moneyUnit(entry.row, money?.unit ?? null);
    for (const [field, cents] of [
      [
        'amount',
        money?.cents
      ],
      [
        'unitPrice',
        entry.unitPrice
      ],
      [
        'due',
        entry.due
      ]
    ] as const) {
      if (cents == null || unit === null) continue;
      tables.readings[`${ref}.${field}`] = {type: 'money', cents, unit, entry: entry.key};
      tables.identities.set(`${ref}.${field}`, {entry: entry.key});
    }
    if (entry.quantity !== null) {
      tables.readings[`${ref}.quantity`] = {type: 'integer', count: entry.quantity.count, entry: entry.key};
      tables.identities.set(`${ref}.quantity`, {entry: entry.key});
    }
    return ref;
  } catch {
    return null;
  }
}

/** Converts only through the ledger adapter, then adds e/b source identity. Invalid tables return null, not a
 * model number error.
 */
export function ledgerValueTable(
  tables: LedgerTables,
  readings: Record<string, LedgerReading> = tables.readings): ReferenceValues | null {
  try {
    const converted = ledgerReferenceValues(readings);
    if (!converted.ok) return null;
    const values: Record<string, ReferenceValue> = Object.create(null);
    for (const [ref, value] of Object.entries(converted.value)) {
      const expected = ref.startsWith('a')
        ? 'amount'
        : ref.startsWith('q')
          ? 'quantity'
          : ref.startsWith('r')
            ? 'rate'
            : ref.startsWith('u')
              ? 'number'
              : ref.startsWith('b:') || /^e[1-9]\d*\.(amount|unitPrice|due)$/.test(ref)
                ? 'money'
                : /^e[1-9]\d*\.quantity$/.test(ref) ? 'integer' : null;
      if (value.type !== expected) return null;
      if (value.type === 'money' || value.type === 'amount') {
        if (value.unit !== null && (!value.unit.key || !value.unit.display)) return null;
        if (value.type === 'money' && !value.unit) return null;
        if (value.type === 'amount' && !value.bare && value.unit === null) return null;
      }
      const identity = tables.identities.get(ref);
      values[ref] = identity ? {...value, source: identity} : value;
    }
    return values;
  } catch {
    return null;
  }
}

function partyView(
  party: StoredLedgerEntry['payer']): unknown {
  if (party === null) return null;
  if ('account' in party) return party.account;
  if ('external' in party) return {external: party.external?.quote ?? null};
  return {unconfigured: {kind: party.unconfigured.kind, label: party.unconfigured.label?.quote ?? null}};
}

/** Formats one authority detail for entries/open/lookup; no proof or affordability calculation is exposed.
 * Invalid input returns null.
 */
export function ledgerEntryView(
  tables: LedgerTables,
  entry: LedgerDetail,
  lookup = false): Record<string, unknown> | null {
  try {
    const ref = ledgerEntryReference(tables, entry);
    if (ref === null) return null;
    const source = tables.sources.get(sourceKey(entry));
    const money = entry.stated ?? entry.amount;
    const row: Record<string, unknown> = {
      ref,
      kind: entry.kind,
      ...(lookup
        ? {
          state: entry.status === 'committed' || entry.status === 'quoted' ? entry.status : entry.disposition
        }
        : {}),
      payer: partyView(entry.payer),
      payee: partyView(entry.payee),
      actor: entry.actor.id,
      item: entry.item?.quote ?? null,
      quantity: entry.quantity?.count ?? null,
      amount: money === null ? null : ledgerDecimal(money.cents),
      unit: entry.row ?? ledgerUnitDisplay(money?.unit ?? null),
      ...(lookup && entry.unitPrice !== null ? {unitPrice: ledgerDecimal(entry.unitPrice)} : {}),
      ...(lookup && entry.due !== null ? {due: ledgerDecimal(entry.due)} : {}),
      ago: entry.laterSources + 1,
      quote: entry.act === null || !source
        ? null
        : [...source.text.slice(entry.act.start, entry.act.end)].slice(0, ENTRY_QUOTE_CODE_POINTS).join(''),
    };
    if (typeof entry.key === 'string' && entry.key.startsWith('legacy:')) row.legacy = true;
    return row;
  } catch {
    return null;
  }
}

function recentText(
  text: string): string {
  const points = [...text];
  return points.length <= RECENT_TEXT_CODE_POINTS
    ? text
    : points.slice(0, RECENT_TEXT_SIDE_CODE_POINTS).join('')
      + '\n…\n' + points.slice(-RECENT_TEXT_SIDE_CODE_POINTS).join('');
}

function speaker(
  message: LedgerStageMessage,
  request: LedgerInputRequest): string | null {
  if (message.event != null) {
    const actorId = message.event.observation.actorId;
    return actorId === 'player' ? request.playerName
      : request.characters.find(character => character.id === actorId)?.name ?? null;
  }
  if (message.role === 'user') return request.playerName;
  if (message.automatic) return null;
  return request.characters.find(character => character.id === message.speakerId)?.name ?? null;
}

function createLedgerTables(
  request: LedgerInputRequest,
  source: LedgerText,
  previous: LedgerText[],
  accounts: LedgerAccount[],
): LedgerTables {
  const tables: LedgerTables = {
    readings: Object.create(null),
    rows: new Map(),
    sources: new Map(),
    entries: new Map(),
    entryRefs: Object.create(null),
    entryNumbers: new Map(),
    identities: new Map(),
    counters: {a: 0, q: 0, r: 0, u: 0, e: 0},
    units: [...new Set(accounts.flatMap(account => account.rows.map(row => foldForMatch(row.unit))))],
    work: {textUnits: 0, candidates: 0, searchWork: 0, rows: 0},
  };
  for (const item of request.sources) tables.sources.set(sourceKey(item), item);
  tables.sources.set(sourceKey(source), source);
  tables.sources.set('m0', source);
  previous.forEach((item, index) => {
    tables.sources.set(sourceKey(item), item);
    tables.sources.set(`m-${previous.length - index}`, item);
  });
  return tables;
}

function scanLedgerExpressions(tables: LedgerTables, source: LedgerText, type: 'amount' | 'quantity' | 'rate') {
  tables.work.textUnits += source.text.length;
  const expressions = type === 'amount'
    ? scanAmounts(source.text, {units: tables.units})
    : type === 'quantity' ? scanQuantities(source.text) : scanRates(source.text);
  tables.work.candidates += expressions.length;
  return expressions;
}

function addLedgerExpression(
  tables: LedgerTables,
  container: string,
  source: LedgerText,
  type: 'amount' | 'quantity' | 'rate',
  expression: unknown,
): LedgerReadingRow | null {
  return appendLedgerReading(tables, container, source, {
    type,
    source: {sourceId: source.sourceId, revision: source.revision},
    expression,
  } as LedgerReading);
}

function collectLedgerReadings(tables: LedgerTables, source: LedgerText, previous: LedgerText[]) {
  const amounts: LedgerReadingRow[] = [];
  const quantities: LedgerReadingRow[] = [];
  const rates: LedgerReadingRow[] = [];
  for (const expression of scanLedgerExpressions(tables, source, 'amount')) {
    const row = addLedgerExpression(tables, 'm0', source, 'amount', expression);
    if (row) amounts.push(row);
  }
  const previousAmounts = previous.flatMap((item, index) =>
    scanLedgerExpressions(tables, item, 'amount').map(expression => ({
      container: `m-${previous.length - index}`,
      item,
      expression,
    }))).slice(-PREVIOUS_AMOUNT_ROW_COUNT);
  for (const {container, item, expression} of previousAmounts) {
    const row = addLedgerExpression(tables, container, item, 'amount', expression);
    if (row) amounts.push(row);
  }
  for (const [type, target] of [['quantity', quantities], ['rate', rates]] as const) {
    for (const expression of scanLedgerExpressions(tables, source, type)) {
      const row = addLedgerExpression(tables, 'm0', source, type, expression);
      if (row) target.push(row);
    }
  }
  return {amounts, quantities, rates};
}

function appendLedgerBalances(tables: LedgerTables, accounts: LedgerAccount[]): boolean {
  for (const account of accounts) {
    for (const row of account.rows) {
      if (!row.tracked) continue;
      const parsed = parseAmount(row.value);
      // The parser deliberately omits zero. The authority's canonical zero still supplies a valid balance leaf.
      const cents = row.value === '0.00'
        ? '0'
        : parsed?.kind === 'readings' && parsed.readings.length === 1 ? parsed.readings[0].cents : null;
      if (cents === null) return false;
      const unit = moneyUnit(row.unit, null);
      if (unit === null) return false;
      const ref = `b:${account.id}:${row.unit}`;
      tables.readings[ref] = {type: 'money', cents, unit};
      tables.identities.set(ref, {account: account.id, unit: row.unit});
    }
  }
  return true;
}

function ledgerDetailLists(tables: LedgerTables, view: LedgerStageView) {
  const details = view.before?.entries ?? [];
  const entries = details.filter(entry => entry.kind !== 'adjustment'
    && (entry.disposition === 'posted' || entry.disposition === 'flagged'))
    .slice(-ENTRY_ROW_COUNT).reverse()
    .map(entry => ledgerEntryView(tables, entry));
  const open: Record<string, unknown[]> = {pending: [], unaffordable: [], committed: [], deposits: [], quoted: []};
  const order = new Map(details.map((entry, index) => [JSON.stringify(entry.key), index]));
  const openItems = Object.entries(view.before?.open ?? {}).flatMap(([group, rows]) => rows
    .filter(entry => entry.kind !== 'adjustment')
    .map(entry => ({group, entry})))
    .sort((left, right) => (order.get(JSON.stringify(right.entry.key)) ?? -1)
      - (order.get(JSON.stringify(left.entry.key)) ?? -1))
    .slice(0, OPEN_ROW_COUNT);
  for (const {group, entry} of openItems) {
    const row = ledgerEntryView(tables, entry);
    if (!row || !Object.hasOwn(open, group)) return null;
    open[group].push({
      ...row,
      state: entry.status === 'committed' || entry.status === 'quoted' ? entry.status : entry.disposition,
      codes: entry.codes,
      ...(entry.due === null ? {} : {due: ledgerDecimal(entry.due)}),
    });
  }
  return {entries, open};
}

function keptLedgerRows(tables: LedgerTables, frozen: LedgerFreeze | null) {
  return (frozen?.keptEntries ?? []).map((entry, index) => {
    const entrySource = tables.sources.get(sourceKey(entry));
    const money = entry.stated ?? entry.amount;
    return {
      ref: `x${index + 1}`,
      kind: entry.kind,
      payer: partyView(entry.payer),
      payee: partyView(entry.payee),
      item: entry.item?.quote ?? null,
      quantity: entry.quantity?.count ?? null,
      amount: money ? ledgerDecimal(money.cents) : null,
      unit: entry.row ?? ledgerUnitDisplay(money?.unit ?? null),
      quote: entry.act === null || !entrySource ? null : entrySource.text.slice(entry.act.start, entry.act.end),
    };
  });
}

function ledgerAccountRows(accounts: LedgerAccount[]) {
  return accounts.map(account => ({
    id: account.id,
    kind: account.kind,
    label: account.label,
    aliases: account.aliases,
    actors: account.actors,
    rows: account.rows.map(row => row.tracked
      ? {unit: row.unit, balance: row.value}
      : {unit: row.unit, tracked: false}),
    items: account.items.map(item => ({item: item.item, count: item.count})),
  }));
}

function ledgerModelMarks(source: LedgerText, selection: LedgerSelection) {
  const rows = (kind: 'money' | 'use') => selection.marks.filter(mark => mark.kind === kind).map(mark => ({
    ref: mark.id,
    quote: 'whole' in mark ? null : source.text.slice(mark.span.start, mark.span.end),
  }));
  return {
    money: rows('money'),
    math: selection.math.map(({id, position}) => ({
      ref: id,
      quote: 'whole' in position ? null : source.text.slice(position.start, position.end),
    })),
    use: rows('use'),
  };
}

function ledgerModelInput(
  request: LedgerInputRequest,
  bundle: Pick<LedgerInputBundle, 'tables' | 'view' | 'source' | 'selection' | 'frozen'>,
  recent: readonly LedgerStageMessage[],
  accounts: LedgerAccount[],
  readings: ReturnType<typeof collectLedgerReadings>,
  details: NonNullable<ReturnType<typeof ledgerDetailLists>>,
): Record<string, unknown> {
  const {tables, view, source, selection, frozen} = bundle;
  const kept = keptLedgerRows(tables, frozen);
  return {
    message: {ref: 'm0', role: source.role, speaker: speaker(request.source, request), text: source.text},
    marks: ledgerModelMarks(source, selection),
    recent: recent.map((message, index) => ({
      ref: `m-${recent.length - index}`,
      role: message.role,
      speaker: speaker(message, request),
      text: recentText(message.event == null ? message.text : message.event.observation.quote),
    })),
    amounts: readings.amounts,
    quantities: readings.quantities,
    rates: readings.rates,
    roster: [
      {id: 'player', names: [request.playerName]},
      ...request.characters.map(character => ({id: character.id, names: [character.name, ...character.aliases]})),
    ],
    accounts: ledgerAccountRows(accounts),
    entries: details.entries,
    open: details.open,
    unconfigured: view.before?.unconfigured ?? [],
    ...(kept.length ? {kept} : {}),
    mode: {...selection.mode},
  };
}

/** Assembles the sole model input and full-source read tables. O(prose + candidate rows), plus the authority's
 * prefix fold cost; invalid input or unavailable authority data returns null. A supplied view must come from
 * the same request's settings, sources, position and options. Null or omission computes that view here. */
export function buildLedgerInput(
  request: LedgerInputRequest,
  suppliedView?: LedgerStageView | null,
): LedgerInputBundle | null {
  try {
    const view = suppliedView ?? ledgerStageView(request);
    if (!view || !Array.isArray(request.history) || !Array.isArray(request.characters)) return null;

    const source = textOf(request.source);
    const recent = request.history.filter(message => message.status === 'accepted').slice(-LEDGER_RECENT_MESSAGE_COUNT);
    const previous = recent.map(textOf);
    const accounts = view.accounts.filter(account => account.status !== 'closed');
    const tables = createLedgerTables(request, source, previous, accounts);
    const readings = collectLedgerReadings(tables, source, previous);
    if (!appendLedgerBalances(tables, accounts)) return null;
    const details = ledgerDetailLists(tables, view);
    if (!details) return null;

    const frozen = request.frozen ?? null;
    const selection = {...request.selection, marks: frozen ? frozen.sendMarks : request.selection.marks};
    const context = {tables, view, source, selection, frozen};
    const input = ledgerModelInput(request, context, recent, accounts, readings, details);
    return {input, tables, view, source, previous, selection, allMarks: request.selection.marks, frozen};
  } catch {
    return null;
  }
}
