import { createHash } from 'node:crypto';

/** Import limits, per preset, provisionally specified in UTF-16 code units (not bytes or tokens). */
export const PRESET_LIMITS = Object.freeze({
  prompts: 256,
  identifier: 200,
  content: 32_000,
  totalContent: 400_000,
  injectionDepth: 1000,
  classificationText: 64_000,
});

/** Host generation names; an omitted generation type selects normal. Unknown values are rejected. */
export type PresetGenerationType = 'normal' | 'continue' | 'impersonate' | 'swipe' | 'regenerate' | 'quiet';

const generationTypes = new Set(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']);

// Union of the reference host's settingsToUpdate is_connection column and sensitiveFields.
// Inspect keys before values: even an accessor on a discarded credential must not be evaluated.
const strippedFields = new Set([
  'chat_completion_source', 'group_models', 'sort_models', 'openai_model', 'claude_model',
  'openrouter_model', 'openrouter_use_fallback', 'openrouter_providers', 'openrouter_quantizations',
  'openrouter_allow_fallbacks', 'openrouter_middleout', 'ai21_model', 'mistralai_model', 'cohere_model',
  'perplexity_model', 'groq_model', 'chutes_model', 'siliconflow_model', 'siliconflow_endpoint',
  'minimax_model', 'minimax_endpoint', 'electronhub_model', 'nanogpt_model', 'nanogpt_provider',
  'nanogpt_payg_override', 'deepseek_model', 'aimlapi_model', 'xai_model', 'pollinations_model',
  'pollinations_endpoint', 'moonshot_model', 'fireworks_model', 'cometapi_model', 'custom_model',
  'custom_url', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers',
  'custom_prompt_post_processing', 'google_model', 'vertexai_model', 'zai_model', 'zai_endpoint',
  'workers_ai_model', 'workers_ai_account_id', 'reverse_proxy', 'show_external_models', 'proxy_password',
  'vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id', 'bypass_status_check',
  'azure_base_url', 'azure_deployment_name', 'azure_api_version', 'azure_openai_model',
]);

const numericSettings = [
  'temperature', 'frequency_penalty', 'presence_penalty', 'top_p', 'top_k', 'top_a', 'min_p',
  'repetition_penalty', 'openai_max_context', 'openai_max_tokens', 'seed', 'n', 'names_behavior',
  'tool_call_recurse_limit',
] as const;
const booleanSettings = [
  'max_context_unlocked', 'stream_openai', 'use_sysprompt', 'squash_system_messages', 'media_inlining',
  'continue_prefill', 'function_calling', 'show_thoughts', 'enable_web_search', 'request_images',
] as const;
const textSettings = [
  'send_if_empty', 'impersonation_prompt', 'new_chat_prompt', 'new_group_chat_prompt',
  'new_example_chat_prompt', 'continue_nudge_prompt', 'bias_preset_selected', 'wi_format',
  'scenario_format', 'personality_format', 'group_nudge_prompt', 'assistant_prefill',
  'assistant_impersonation', 'continue_postfix', 'reasoning_effort', 'verbosity', 'tool_reasoning_mode',
  'inline_image_quality', 'request_image_aspect_ratio', 'request_image_resolution', 'preset_settings_openai',
] as const;
type SettingName = typeof numericSettings[number] | typeof booleanSettings[number] | typeof textSettings[number];
type Settings = Partial<Record<SettingName, string | number | boolean>>;
const settingNames = [...numericSettings, ...booleanSettings, ...textSettings];
const numericNames = new Set<string>(numericSettings);
const booleanNames = new Set<string>(booleanSettings);
const promptKeys = new Set([
  'identifier', 'name', 'role', 'content', 'marker', 'system_prompt', 'injection_position',
  'injection_depth', 'injection_order', 'injection_trigger', 'forbid_overrides',
]);
const rootKeys = new Set(['prompts', 'prompt_order', ...settingNames]);
const envelopeKeys = new Set(['version', 'type', 'data']);
const orderKeys = new Set(['character_id', 'order']);
const entryKeys = new Set(['identifier', 'enabled']);
const markerIdentifiers = new Set([
  'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality', 'scenario',
  'personaDescription', 'dialogueExamples', 'chatHistory',
]);
const unusedSettings = new Set([
  'impersonation_prompt', 'assistant_impersonation', 'new_group_chat_prompt', 'group_nudge_prompt',
  'continue_nudge_prompt', 'continue_prefill', 'continue_postfix', 'function_calling',
  'tool_call_recurse_limit', 'tool_reasoning_mode', 'stream_openai', 'media_inlining', 'request_images',
  'inline_image_quality', 'request_image_aspect_ratio', 'request_image_resolution', 'enable_web_search',
  'bias_preset_selected', 'use_sysprompt', 'max_context_unlocked', 'preset_settings_openai',
]);

/** Sanitized host prompt. Text is verbatim; optional null fields are omitted, markers may have empty content. */
export interface TavernPresetPrompt {
  identifier: string;
  content: string;
  name?: string;
  role?: 'system' | 'user' | 'assistant';
  marker?: boolean;
  system_prompt?: boolean;
  injection_position?: 0 | 1;
  injection_depth?: number;
  injection_order?: number;
  injection_trigger?: PresetGenerationType[];
  forbid_overrides?: boolean;
}

type OrderEntry = { identifier: string; enabled: boolean };

/** Reimportable host-shaped snapshot: one canonical global order plus closed primitive settings. No credentials. */
export type TavernPresetSnapshot = Settings & {
  prompts: TavernPresetPrompt[];
  prompt_order: { character_id: number; order: OrderEntry[] }[];
};

/** Counts only. fieldsVisited measures one pass over recognized containers, without visiting dropped values. */
export interface PresetDiagnostics {
  strippedFields: number;
  unknownFields: number;
  ignoredFields: number;
  missingPrompts: number;
  disabledPrompts: number;
  triggerExcludedPrompts: number;
  fieldsVisited: number;
}

/** Sanitized snapshot and the host-equivalent active collection in selected order; no persistence or model calls. */
export interface NormalizedTavernPreset {
  snapshot: TavernPresetSnapshot;
  activePrompts: TavernPresetPrompt[];
  diagnostics: PresetDiagnostics;
}

function invalid(): never {
  throw new Error('invalid_tavern_preset');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return invalid();
  return value as Record<string, unknown>;
}

function pick(value: unknown, allowed: Set<string>, diagnostics: PresetDiagnostics): Record<string, unknown> {
  const source = record(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(source)) {
    diagnostics.fieldsVisited++;
    if (strippedFields.has(key)) {
      diagnostics.strippedFields++;
    } else if (allowed.has(key)) {
      result[key] = source[key];
    } else if (key === 'extensions') {
      diagnostics.ignoredFields++;
    } else {
      diagnostics.unknownFields++;
    }
  }
  return result;
}

function stringValue(value: unknown, maximum: number, nonempty = false): string {
  if (typeof value !== 'string' || value.length > maximum || (nonempty && !value.trim())) return invalid();
  return value;
}

function boundedArray(value: unknown, maximum: number = PRESET_LIMITS.prompts): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
}

function generationTypeOf(value: unknown): PresetGenerationType {
  if (value == null) return 'normal';
  if (typeof value !== 'string' || !generationTypes.has(value)) return invalid();
  return value as PresetGenerationType;
}

function normalizePrompt(value: unknown, diagnostics: PresetDiagnostics): TavernPresetPrompt {
  const input = pick(value, promptKeys, diagnostics);
  const identifier = stringValue(input.identifier, PRESET_LIMITS.identifier, true);
  const prompt: TavernPresetPrompt = {
    identifier,
    // Default.json omits marker content. A non-marker still requires an actual string.
    content: input.content == null && input.marker === true
      ? '' : stringValue(input.content, PRESET_LIMITS.content),
  };
  if (input.name != null) prompt.name = stringValue(input.name, PRESET_LIMITS.identifier);
  if (input.role != null) {
    if (input.role !== 'system' && input.role !== 'user' && input.role !== 'assistant') return invalid();
    prompt.role = input.role;
  }
  for (const key of ['marker', 'system_prompt', 'forbid_overrides'] as const) {
    const value = input[key];
    if (value == null) continue;
    if (typeof value !== 'boolean') return invalid();
    prompt[key] = value;
  }
  if (input.injection_position != null) {
    if (input.injection_position !== 0 && input.injection_position !== 1) return invalid();
    prompt.injection_position = input.injection_position;
  }
  for (const key of ['injection_depth', 'injection_order'] as const) {
    const value = input[key];
    if (value == null) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) return invalid();
    if (key === 'injection_depth' && (value < 0 || value > PRESET_LIMITS.injectionDepth)) return invalid();
    prompt[key] = value;
  }
  if (input.injection_trigger != null) {
    const triggers = boundedArray(input.injection_trigger, generationTypes.size);
    prompt.injection_trigger = triggers.map(value => {
      if (value == null) return invalid();
      return generationTypeOf(value);
    });
  }
  return prompt;
}

function normalizeOrder(value: unknown, diagnostics: PresetDiagnostics): OrderEntry[] {
  const identifiers = new Set<string>();
  return boundedArray(value).map(value => {
    const entry = pick(value, entryKeys, diagnostics);
    const identifier = stringValue(entry.identifier, PRESET_LIMITS.identifier, true);
    if (typeof entry.enabled !== 'boolean' || identifiers.has(identifier)) return invalid();
    identifiers.add(identifier);
    return { identifier, enabled: entry.enabled };
  });
}

/**
 * Validate either host export shape, stripping before copying, hashing or displaying any discarded value.
 * Returns a reimportable snapshot and an effective collection; malformed/oversized data rejects the entire import
 * with invalid_tavern_preset. Throwing caller getters propagate unchanged. O(keys + entries + text), no text regex.
 */
export function normalizeTavernPreset(value: unknown, generationType?: unknown): NormalizedTavernPreset {
  const generation = generationTypeOf(generationType);
  const diagnostics: PresetDiagnostics = {
    strippedFields: 0,
    unknownFields: 0,
    ignoredFields: 0,
    missingPrompts: 0,
    disabledPrompts: 0,
    triggerExcludedPrompts: 0,
    fieldsVisited: 0,
  };
  const original = record(value);
  const wrapped = !Object.hasOwn(original, 'prompts')
    && (Object.hasOwn(original, 'data') || Object.hasOwn(original, 'version') || Object.hasOwn(original, 'type'));
  let input: Record<string, unknown>;
  if (wrapped) {
    const envelope = pick(original, envelopeKeys, diagnostics);
    if (envelope.version !== 1 || (envelope.type !== 'full' && envelope.type !== 'character')) return invalid();
    input = pick(envelope.data, new Set(['prompts', 'prompt_order']), diagnostics);
  } else {
    input = pick(original, rootKeys, diagnostics);
  }

  const prompts = boundedArray(input.prompts).map(value => normalizePrompt(value, diagnostics));
  const byIdentifier = new Map<string, TavernPresetPrompt>();
  let contentUnits = 0;
  for (const prompt of prompts) {
    if (byIdentifier.has(prompt.identifier)) return invalid();
    byIdentifier.set(prompt.identifier, prompt);
    contentUnits += prompt.content.length;
  }
  if (contentUnits > PRESET_LIMITS.totalContent) return invalid();

  let selectedOrder: OrderEntry[];
  if (wrapped) {
    // Prompt manager exports a flat order array, not the preset's character group array.
    selectedOrder = normalizeOrder(input.prompt_order, diagnostics);
  } else {
    const groups = boundedArray(input.prompt_order).map(value => {
      const group = pick(value, orderKeys, diagnostics);
      const characterId = group.character_id;
      if ((typeof characterId !== 'number' || !Number.isSafeInteger(characterId))
        && (typeof characterId !== 'string' || !characterId.length || characterId.length > PRESET_LIMITS.identifier)) {
        return invalid();
      }
      return { characterId: String(characterId), order: normalizeOrder(group.order, diagnostics) };
    });
    if (groups.filter(group => group.characterId === '100001').length > 1) return invalid();
    selectedOrder = (groups.find(group => group.characterId === '100001') ?? groups[0])?.order ?? [];
  }

  const order: OrderEntry[] = [];
  const activePrompts: TavernPresetPrompt[] = [];
  for (const entry of selectedOrder) {
    const prompt = byIdentifier.get(entry.identifier);
    if (!prompt) {
      diagnostics.missingPrompts++;
      continue;
    }
    order.push(entry);
    const triggerMatches = !prompt.injection_trigger?.length || prompt.injection_trigger.includes(generation);
    if (entry.enabled && triggerMatches) {
      activePrompts.push(structuredClone(prompt));
    } else {
      if (!entry.enabled) diagnostics.disabledPrompts++;
      else diagnostics.triggerExcludedPrompts++;
      // The host retains an empty main anchor for relative extension inserts even when its trigger is excluded.
      if (entry.identifier === 'main') activePrompts.push({ ...structuredClone(prompt), content: '' });
    }
  }

  const snapshot: TavernPresetSnapshot = { prompts, prompt_order: [{ character_id: 100001, order }] };
  // Iterate the fixed schema order so input property insertion order cannot change the hash.
  for (const key of settingNames) {
    const value = input[key];
    if (value == null) continue;
    if (numericNames.has(key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return invalid();
      if (key === 'names_behavior' && ![-1, 0, 1, 2].includes(value)) return invalid();
      snapshot[key] = value;
    } else if (booleanNames.has(key)) {
      if (typeof value !== 'boolean') return invalid();
      snapshot[key] = value;
    } else {
      const content = stringValue(value, PRESET_LIMITS.content);
      contentUnits += content.length;
      if (contentUnits > PRESET_LIMITS.totalContent) return invalid();
      snapshot[key] = content;
    }
  }
  return { snapshot, activePrompts, diagnostics };
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function promptHashOf(content: string): string {
  // JSON escapes lone UTF-16 surrogates instead of UTF-8 silently replacing distinct strings with the same bytes.
  return hashText(JSON.stringify(content));
}

/** SHA-256 of the normalized snapshot only. Revalidates unknown input; secrets and diagnostic counts never enter it. */
export function presetHash(value: unknown): string {
  return hashText(JSON.stringify(normalizeTavernPreset(value).snapshot));
}

/** Closed semantic labels; unknown is an explicit valid label, not a fallback for misspelled labels. */
export type PresetClassificationLabel = 'prose_style' | 'content_permissions' | 'character_voice' | 'world_lore'
  | 'player_proxy' | 'format_addon' | 'reasoning_scaffold' | 'unknown';

const classificationLabels = new Set<string>([
  'prose_style', 'content_permissions', 'character_voice', 'world_lore', 'player_proxy',
  'format_addon', 'reasoning_scaffold', 'unknown',
]);

/** A model label or player correction bound to the SHA-256 of verbatim prompt content. */
export interface PresetClassification {
  promptHash: string;
  label: PresetClassificationLabel;
}

function classificationInvalid(): never {
  throw new Error('invalid_preset_classification');
}

function hashOf(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]+$/.test(value)) return classificationInvalid();
  return value;
}

/**
 * Decode at most 256 closed {promptHash,label} rows against the current eligible hashes. Accept a JSON array or
 * its {classifications: array} JSON-mode envelope; reject the entire batch on unknown labels/hashes/keys/duplicates.
 * No model prose is returned on failure. Getters propagate; O(text + rows + known hashes), bounded regex inputs.
 */
export function decodePresetClassification(
  value: unknown,
  knownPromptHashes: readonly string[],
): PresetClassification[] {
  if (!Array.isArray(knownPromptHashes) || knownPromptHashes.length > PRESET_LIMITS.prompts) {
    return classificationInvalid();
  }
  const known = new Set(knownPromptHashes.map(hashOf));
  if (typeof value === 'string') {
    if (value.length > PRESET_LIMITS.classificationText) return classificationInvalid();
    try {
      value = JSON.parse(value);
    } catch {
      return classificationInvalid();
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'classifications') return classificationInvalid();
    value = (value as Record<string, unknown>).classifications;
  }
  if (!Array.isArray(value) || value.length > PRESET_LIMITS.prompts) return classificationInvalid();
  const seen = new Set<string>();
  return value.map(row => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return classificationInvalid();
    const keys = Object.keys(row);
    if (keys.length !== 2 || !Object.hasOwn(row, 'promptHash') || !Object.hasOwn(row, 'label')) {
      return classificationInvalid();
    }
    const promptHash = hashOf(row.promptHash);
    const label = row.label;
    if (!known.has(promptHash) || seen.has(promptHash)
      || typeof label !== 'string' || !classificationLabels.has(label)) {
      return classificationInvalid();
    }
    seen.add(promptHash);
    return { promptHash, label: label as PresetClassificationLabel };
  });
}

/** Eligible text sent once per content hash to the classifier; name and identifier remain unmodified host data. */
export type PresetClassificationPrompt = TavernPresetPrompt & { promptHash: string };

/** Mapping is descriptive only. B/M1/M2 are destinations, never model configuration or executable routing. */
export interface PresetPromptMapping {
  identifier: string;
  name?: string;
  promptHash: string;
  label: PresetClassificationLabel | null;
  source: 'identifier' | 'model' | 'player';
  destinations: ('B' | 'M1' | 'M2')[];
  modeTwoDestinations: ('B' | 'M1' | 'M2')[];
  flags: ('unclassified' | 'player_proxy' | 'costs_context' | 'unknown' | 'facts_conflict')[];
}

/**
 * Ordered prompt/setting destinations and validated cached labels for a single import.
 * Cached labels may name known inactive prompts; needsClassification contains only unresolved active text.
 */
export interface PresetMapping {
  prompts: PresetPromptMapping[];
  settings: { identifier: SettingName; destinations: 'B'[] }[];
  classifications: PresetClassification[];
  needsClassification: PresetClassificationPrompt[];
}

function classifiable(prompt: TavernPresetPrompt): boolean {
  return !prompt.marker && !markerIdentifiers.has(prompt.identifier) && prompt.content.length > 0;
}

function labelDestinations(label: PresetClassificationLabel): PresetPromptMapping['destinations'] {
  if (label === 'content_permissions') return ['B', 'M1', 'M2'];
  if (label === 'character_voice') return ['B', 'M2'];
  if (label === 'player_proxy') return [];
  // Preset lore is authored text, never public world knowledge for M2.
  return ['B'];
}

/**
 * Normalize first, then map by identifier and closed labels; player corrections win over model rows.
 * Invalid labels reject the whole call. No cache or storage is consulted. O(keys + text + prompt/order/label rows).
 */
export function deterministicPresetMapping(
  value: unknown,
  options: { generationType?: unknown; classifications?: unknown; corrections?: unknown } = {},
): PresetMapping {
  const generationType = options.generationType;
  const modelRows = options.classifications;
  const playerRows = options.corrections;
  const normalized = normalizeTavernPreset(value, generationType);
  // Cache identity belongs to the whole pinned snapshot. Switching generation type must not invalidate a known
  // inactive row, but inactive rows must neither reach the classifier nor change any active prompt's routing.
  const knownHashes = [...new Set(normalized.snapshot.prompts
    .filter(classifiable)
    .map(prompt => promptHashOf(prompt.content)))];
  const eligible = new Map<string, PresetClassificationPrompt>();
  for (const prompt of normalized.activePrompts) {
    if (classifiable(prompt)) {
      const promptHash = promptHashOf(prompt.content);
      if (!eligible.has(promptHash)) eligible.set(promptHash, { ...prompt, promptHash });
    }
  }
  const decodedClassifications = decodePresetClassification(modelRows ?? [], knownHashes);
  const classifications = new Map(
    decodedClassifications.map(row => [row.promptHash, row.label]),
  );
  const corrections = new Map(
    decodePresetClassification(playerRows ?? [], knownHashes).map(row => [row.promptHash, row.label]),
  );
  const prompts = normalized.activePrompts.map(prompt => {
    const promptHash = promptHashOf(prompt.content);
    const isEligible = classifiable(prompt);
    const corrected = isEligible ? corrections.get(promptHash) : undefined;
    const classified = isEligible ? classifications.get(promptHash) : undefined;
    const label = corrected ?? classified ?? null;
    const source = corrected !== undefined ? 'player' : classified !== undefined ? 'model' : 'identifier';
    let destinations: PresetPromptMapping['destinations'] = label === null ? ['B'] : labelDestinations(label);
    const flags: PresetPromptMapping['flags'] = [];
    if (isEligible && label === null) flags.push('unclassified');
    if (label === 'player_proxy') flags.push('player_proxy');
    if (label === 'format_addon') flags.push('costs_context');
    if (label === 'unknown') flags.push('unknown');
    // The identifier table reserves jailbreak for prose and requires an explicit player override for enhancement.
    if (prompt.identifier === 'jailbreak') destinations = destinations.filter(destination => destination === 'B');
    if (prompt.identifier === 'enhanceDefinitions') {
      flags.push('facts_conflict');
      destinations = corrected !== undefined ? destinations.filter(destination => destination === 'B') : [];
    }
    const modeTwoDestinations: PresetPromptMapping['destinations'] = [
      'B', ...destinations.filter(destination => destination !== 'B'),
    ];
    return {
      identifier: prompt.identifier,
      ...(prompt.name === undefined ? {} : { name: prompt.name }),
      promptHash,
      label,
      source,
      destinations,
      modeTwoDestinations,
      flags,
    } satisfies PresetPromptMapping;
  });
  return {
    prompts,
    classifications: decodedClassifications,
    settings: settingNames.filter(key => Object.hasOwn(normalized.snapshot, key)).map(identifier => ({
      identifier,
      destinations: unusedSettings.has(identifier) ? [] : ['B'],
    })),
    needsClassification: [...eligible.values()].filter(prompt =>
      !classifications.has(prompt.promptHash) && !corrections.has(prompt.promptHash)),
  };
}
