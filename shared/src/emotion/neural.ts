/*
 * Neural personality core ported from OpenHer's engine/genome/genome_engine.py
 * at ef5b2145c9c15582499ecc5fb9d10376d82eccdf.
 *
 * XLDB changes: camelCase boundary names, immutable transitions, complete
 * serializable local RNG state, and a strictly bounded persisted history.
 * The PRNG is intentionally not Python's random.Random, so equal numeric seeds
 * do not imply equal values across the two implementations.
 * Licensed under Apache-2.0; see third-party/OpenHer-LICENSE.
 */

export const NEURAL_DRIVE_NAMES = [
  "connection",
  "novelty",
  "expression",
  "safety",
  "play",
] as const;

export const NEURAL_SIGNAL_NAMES = [
  "directness",
  "vulnerability",
  "playfulness",
  "initiative",
  "depth",
  "warmth",
  "defiance",
  "curiosity",
] as const;

export const NEURAL_CONTEXT_NAMES = [
  "userEmotion",
  "topicIntimacy",
  "timeOfDay",
  "conversationDepth",
  "userEngagement",
  "conflictLevel",
  "noveltyLevel",
  "userVulnerability",
  "relationshipDepth",
  "emotionalValence",
  "trustLevel",
  "pendingForesight",
] as const;

export type NeuralDriveName = (typeof NEURAL_DRIVE_NAMES)[number];
export type NeuralSignalName = (typeof NEURAL_SIGNAL_NAMES)[number];
export type NeuralContextName = (typeof NEURAL_CONTEXT_NAMES)[number];
export type NeuralDrives = Record<NeuralDriveName, number>;
export type NeuralSignals = Record<NeuralSignalName, number>;

export const NEURAL_RECURRENT_SIZE = 8;
export const NEURAL_INPUT_SIZE = 25;
export const NEURAL_HIDDEN_SIZE = 24;
export const NEURAL_OUTPUT_SIZE = 8;
export const NEURAL_HISTORY_LIMIT = 100;

const WEIGHT_DECAY = 0.995;
const W1_LIMIT = 2;
const W2_LIMIT = 1.5;
const DEFAULT_HEBBIAN_LR = 0.02;
const DEFAULT_PHASE_THRESHOLD = 2;

export interface NeuralRngState {
  algorithm: "xoshiro128ss-box-muller-v1";
  words: [number, number, number, number];
  hasGaussianSpare: boolean;
  gaussianSpare: number;
}

export interface NeuralState {
  version: 1;
  seed: number;
  hebbianLr: number;
  phaseThreshold: number;
  driveBaseline: NeuralDrives;
  driveAccumulationRate: NeuralDrives;
  driveDecayRate: NeuralDrives;
  driveState: NeuralDrives;
  W1: number[][];
  b1: number[];
  W2: number[][];
  b2: number[];
  recurrentState: number[];
  lastHidden: number[] | null;
  lastInput: number[] | null;
  interactionCount: number;
  totalReward: number;
  age: number;
  frustration: number;
  lastPhaseTransition: boolean;
  signalHistory: NeuralSignals[];
  rng: NeuralRngState;
}

export interface NeuralFingerprint {
  traits: Partial<Record<NeuralSignalName, "high" | "low" | "neutral">>;
  avgSignals?: Partial<NeuralSignals>;
  contradictions: [NeuralSignalName, NeuralSignalName][];
}

function fail(path: string, expectation: string): never {
  throw new TypeError(`${path} must be ${expectation}`);
}

function recordOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "an object");
  }
  return value as Record<string, unknown>;
}

function finiteOf(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "a finite number");
  }
  return value;
}

function rangedOf(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  const number = finiteOf(value, path);
  if (number < minimum || number > maximum) {
    fail(path, `between ${minimum} and ${maximum}`);
  }
  return number;
}

function integerOf(value: unknown, path: string, minimum: number, maximum: number): number {
  const number = finiteOf(value, path);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(path, `an integer between ${minimum} and ${maximum}`);
  }
  return number;
}

function booleanOf(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean");
  return value;
}

function finiteVectorOf(value: unknown, length: number, path: string): number[] {
  if (!Array.isArray(value) || value.length !== length) {
    fail(path, `an array of length ${length}`);
  }
  return value.map((entry, index) => finiteOf(entry, `${path}[${index}]`));
}

function finiteMatrixOf(value: unknown, rows: number, columns: number, path: string): number[][] {
  if (!Array.isArray(value) || value.length !== rows) {
    fail(path, `an array of ${rows} rows`);
  }
  return value.map((row, index) => finiteVectorOf(row, columns, `${path}[${index}]`));
}

function driveRecordOf(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): NeuralDrives {
  const input = recordOf(value, path);
  return Object.fromEntries(NEURAL_DRIVE_NAMES.map((name) => [
    name,
    rangedOf(input[name], `${path}.${name}`, minimum, maximum),
  ])) as NeuralDrives;
}

function signalRecordOf(value: unknown, path: string): NeuralSignals {
  const input = recordOf(value, path);
  return Object.fromEntries(NEURAL_SIGNAL_NAMES.map((name) => [
    name,
    rangedOf(input[name], `${path}.${name}`, 0, 1),
  ])) as NeuralSignals;
}

function cloneDrives(drives: NeuralDrives): NeuralDrives {
  return { ...drives };
}

function cloneSignals(signals: NeuralSignals): NeuralSignals {
  return { ...signals };
}

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function seedWords(seed: number): [number, number, number, number] {
  // Hashing the decimal spelling preserves every safe integer even though the
  // generator itself operates on four uint32 words.
  let hash = 0x811c9dc5;
  for (const codeUnit of seed.toString()) {
    hash ^= codeUnit.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let cursor = hash;
  const next = (): number => {
    cursor = (cursor + 0x9e3779b9) >>> 0;
    let value = cursor;
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
    return (value ^ (value >>> 15)) >>> 0;
  };
  const words: [number, number, number, number] = [next(), next(), next(), next()];
  if (words.every((word) => word === 0)) words[0] = 1;
  return words;
}

function uniform(rng: NeuralRngState): number {
  const [s0, s1, s2, s3] = rng.words;
  const result = Math.imul(rotl32(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
  const temporary = (s1 << 9) >>> 0;
  let next2 = (s2 ^ s0) >>> 0;
  let next3 = (s3 ^ s1) >>> 0;
  const next1 = (s1 ^ next2) >>> 0;
  const next0 = (s0 ^ next3) >>> 0;
  next2 = (next2 ^ temporary) >>> 0;
  next3 = rotl32(next3, 11);
  rng.words = [next0, next1, next2, next3];
  return result / 0x1_0000_0000;
}

function gaussian(rng: NeuralRngState, mean = 0, standardDeviation = 1): number {
  if (rng.hasGaussianSpare) {
    rng.hasGaussianSpare = false;
    return mean + rng.gaussianSpare * standardDeviation;
  }
  let first = uniform(rng);
  while (first === 0) first = uniform(rng);
  const second = uniform(rng);
  const magnitude = Math.sqrt(-2 * Math.log(first));
  const angle = 2 * Math.PI * second;
  rng.gaussianSpare = magnitude * Math.sin(angle);
  rng.hasGaussianSpare = true;
  return mean + magnitude * Math.cos(angle) * standardDeviation;
}

function randomDriveRecord(
  rng: NeuralRngState,
  minimum: number,
  maximum: number,
): NeuralDrives {
  return Object.fromEntries(NEURAL_DRIVE_NAMES.map((name) => [
    name,
    minimum + uniform(rng) * (maximum - minimum),
  ])) as NeuralDrives;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Validate persisted state and return a detached normalized copy. Initial
 * Gaussian weights are only required to be finite because OpenHer does not
 * clamp them until the first learning pass.
 */
export function validateNeuralState(input: unknown): NeuralState {
  const value = recordOf(input, "neuralState");
  if (value.version !== 1) fail("neuralState.version", "1");
  const seed = integerOf(value.seed, "neuralState.seed", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const rngInput = recordOf(value.rng, "neuralState.rng");
  if (rngInput.algorithm !== "xoshiro128ss-box-muller-v1") {
    fail("neuralState.rng.algorithm", "xoshiro128ss-box-muller-v1");
  }
  if (!Array.isArray(rngInput.words) || rngInput.words.length !== 4) {
    fail("neuralState.rng.words", "an array of length 4");
  }
  const rngWords = rngInput.words.map((word, index) =>
    integerOf(word, `neuralState.rng.words[${index}]`, 0, 0xffff_ffff));
  if (rngWords.every((word) => word === 0)) fail("neuralState.rng.words", "a nonzero RNG state");
  const hasGaussianSpare = booleanOf(
    rngInput.hasGaussianSpare,
    "neuralState.rng.hasGaussianSpare",
  );
  const gaussianSpare = finiteOf(rngInput.gaussianSpare, "neuralState.rng.gaussianSpare");

  const rawHistory = value.signalHistory;
  if (!Array.isArray(rawHistory) || rawHistory.length > NEURAL_HISTORY_LIMIT) {
    fail("neuralState.signalHistory", `an array of at most ${NEURAL_HISTORY_LIMIT} entries`);
  }

  const nullableVector = (raw: unknown, length: number, path: string): number[] | null => {
    if (raw === null) return null;
    return finiteVectorOf(raw, length, path);
  };

  return {
    version: 1,
    seed,
    hebbianLr: rangedOf(value.hebbianLr, "neuralState.hebbianLr", 0, 1),
    phaseThreshold: rangedOf(value.phaseThreshold, "neuralState.phaseThreshold", 0, 1_000_000),
    driveBaseline: driveRecordOf(value.driveBaseline, "neuralState.driveBaseline", 0, 1),
    driveAccumulationRate: driveRecordOf(
      value.driveAccumulationRate,
      "neuralState.driveAccumulationRate",
      0,
      1,
    ),
    driveDecayRate: driveRecordOf(value.driveDecayRate, "neuralState.driveDecayRate", 0, 1),
    driveState: driveRecordOf(value.driveState, "neuralState.driveState", 0, 1),
    W1: finiteMatrixOf(value.W1, NEURAL_HIDDEN_SIZE, NEURAL_INPUT_SIZE, "neuralState.W1"),
    b1: finiteVectorOf(value.b1, NEURAL_HIDDEN_SIZE, "neuralState.b1"),
    W2: finiteMatrixOf(value.W2, NEURAL_OUTPUT_SIZE, NEURAL_HIDDEN_SIZE, "neuralState.W2"),
    b2: finiteVectorOf(value.b2, NEURAL_OUTPUT_SIZE, "neuralState.b2"),
    recurrentState: finiteVectorOf(
      value.recurrentState,
      NEURAL_RECURRENT_SIZE,
      "neuralState.recurrentState",
    ),
    lastHidden: nullableVector(value.lastHidden, NEURAL_HIDDEN_SIZE, "neuralState.lastHidden"),
    lastInput: nullableVector(value.lastInput, NEURAL_INPUT_SIZE, "neuralState.lastInput"),
    interactionCount: integerOf(
      value.interactionCount,
      "neuralState.interactionCount",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    totalReward: finiteOf(value.totalReward, "neuralState.totalReward"),
    age: integerOf(value.age, "neuralState.age", 0, Number.MAX_SAFE_INTEGER),
    frustration: rangedOf(value.frustration, "neuralState.frustration", 0, 1_000_000),
    lastPhaseTransition: booleanOf(
      value.lastPhaseTransition,
      "neuralState.lastPhaseTransition",
    ),
    signalHistory: rawHistory.map((signals, index) =>
      signalRecordOf(signals, `neuralState.signalHistory[${index}]`)),
    rng: {
      algorithm: "xoshiro128ss-box-muller-v1",
      words: rngWords as [number, number, number, number],
      hasGaussianSpare,
      gaussianSpare,
    },
  };
}

export function createNeural(
  seed: number,
  params: { hebbianLr?: number; phaseThreshold?: number } = {},
): NeuralState {
  const validSeed = integerOf(seed, "seed", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const hebbianLr = params.hebbianLr === undefined
    ? DEFAULT_HEBBIAN_LR
    : rangedOf(params.hebbianLr, "params.hebbianLr", 0, 1);
  const phaseThreshold = params.phaseThreshold === undefined
    ? DEFAULT_PHASE_THRESHOLD
    : rangedOf(params.phaseThreshold, "params.phaseThreshold", 0, 1_000_000);
  const rng: NeuralRngState = {
    algorithm: "xoshiro128ss-box-muller-v1",
    words: seedWords(validSeed),
    hasGaussianSpare: false,
    gaussianSpare: 0,
  };
  const driveBaseline = randomDriveRecord(rng, 0.2, 0.8);
  const driveAccumulationRate = randomDriveRecord(rng, 0.01, 0.05);
  const driveDecayRate = randomDriveRecord(rng, 0.05, 0.15);
  const W1 = Array.from({ length: NEURAL_HIDDEN_SIZE }, () =>
    Array.from({ length: NEURAL_INPUT_SIZE }, () => gaussian(rng, 0, 0.6)));
  const b1 = Array.from({ length: NEURAL_HIDDEN_SIZE }, () => gaussian(rng, 0, 0.3));
  const W2 = Array.from({ length: NEURAL_OUTPUT_SIZE }, () =>
    Array.from({ length: NEURAL_HIDDEN_SIZE }, () => gaussian(rng, 0, 0.2)));
  const b2 = Array.from({ length: NEURAL_OUTPUT_SIZE }, () => gaussian(rng, 0, 0.2));
  const recurrentState = Array.from(
    { length: NEURAL_RECURRENT_SIZE },
    () => gaussian(rng, 0, 0.1),
  );

  return {
    version: 1,
    seed: validSeed,
    hebbianLr,
    phaseThreshold,
    driveBaseline,
    driveAccumulationRate,
    driveDecayRate,
    driveState: cloneDrives(driveBaseline),
    W1,
    b1,
    W2,
    b2,
    recurrentState,
    lastHidden: null,
    lastInput: null,
    interactionCount: 0,
    totalReward: 0,
    age: 0,
    frustration: 0,
    lastPhaseTransition: false,
    signalHistory: [],
    rng,
  };
}

function syncDrives(state: NeuralState, drives?: Record<string, number>): void {
  if (drives === undefined) return;
  recordOf(drives, "drives");
  for (const name of NEURAL_DRIVE_NAMES) {
    if (drives[name] !== undefined) {
      state.driveState[name] = rangedOf(drives[name], `drives.${name}`, 0, 1);
    }
  }
}

function contextVector(context: Record<string, number>): number[] {
  recordOf(context, "context");
  return NEURAL_CONTEXT_NAMES.map((name) => {
    const value = context[name];
    return value === undefined ? 0 : finiteOf(value, `context.${name}`);
  });
}

export function neuralForward(
  state: NeuralState,
  context: Record<string, number>,
  drives?: Record<string, number>,
): { state: NeuralState; signals: NeuralSignals } {
  const next = validateNeuralState(state);
  syncDrives(next, drives);
  const fullInput = [
    ...NEURAL_DRIVE_NAMES.map((name) => next.driveState[name]),
    ...contextVector(context),
    ...next.recurrentState,
  ].map((value) => value + gaussian(next.rng, 0, 0.03));

  const hidden = next.W1.map((row, index) => {
    let activation = next.b1[index];
    for (let column = 0; column < NEURAL_INPUT_SIZE; column += 1) {
      activation += row[column] * fullInput[column];
    }
    return Math.tanh(activation);
  });

  next.recurrentState = hidden.slice(0, NEURAL_RECURRENT_SIZE);
  next.lastHidden = [...hidden];
  next.lastInput = [...fullInput];

  const normalizer = Math.sqrt(NEURAL_HIDDEN_SIZE / 3);
  const signals = Object.fromEntries(next.W2.map((row, index) => {
    let raw = next.b2[index];
    for (let column = 0; column < NEURAL_HIDDEN_SIZE; column += 1) {
      raw += row[column] * hidden[column];
    }
    raw /= normalizer;
    return [NEURAL_SIGNAL_NAMES[index], 1 / (1 + Math.exp(-clamp(raw, -10, 10)))];
  })) as NeuralSignals;

  next.signalHistory.push(cloneSignals(signals));
  if (next.signalHistory.length > NEURAL_HISTORY_LIMIT) {
    next.signalHistory = next.signalHistory.slice(-NEURAL_HISTORY_LIMIT);
  }
  return { state: next, signals };
}

/**
 * Apply DriveMetabolism's saturating thermodynamic noise with the same local
 * RNG used by initialization, perception noise, and phase transitions.
 */
export function neuralThermodynamic(
  state: NeuralState,
  signals: Record<string, number>,
  totalFrustration: number,
  tempCoeff = 0.12,
  tempFloor = 0.03,
): { state: NeuralState; signals: NeuralSignals } {
  const next = validateNeuralState(state);
  const checkedSignals = signalRecordOf(signals, "signals");
  const total = rangedOf(totalFrustration, "totalFrustration", 0, 1_000_000);
  const coefficient = rangedOf(tempCoeff, "tempCoeff", 0, 1);
  const floor = rangedOf(tempFloor, "tempFloor", 0, 1);
  const maximumTemperature = coefficient * 2.5;
  const temperature = maximumTemperature === 0
    ? floor
    : maximumTemperature * Math.tanh(total * coefficient / maximumTemperature) + floor;
  const noisySignals = Object.fromEntries(NEURAL_SIGNAL_NAMES.map((name) => [
    name,
    clamp(checkedSignals[name] + gaussian(next.rng, 0, temperature), 0, 1),
  ])) as NeuralSignals;
  return { state: next, signals: noisySignals };
}

function satisfactionOf(value?: Record<string, number>): Partial<NeuralDrives> {
  if (value === undefined) return {};
  recordOf(value, "driveSatisfaction");
  const result: Partial<NeuralDrives> = {};
  for (const name of NEURAL_DRIVE_NAMES) {
    if (value[name] !== undefined) {
      result[name] = rangedOf(value[name], `driveSatisfaction.${name}`, 0, 1);
    }
  }
  return result;
}

export function neuralLearn(
  state: NeuralState,
  signals: Record<string, number>,
  reward: number,
  driveSatisfaction?: Record<string, number>,
): NeuralState {
  const next = validateNeuralState(state);
  const checkedSignals = signalRecordOf(signals, "signals");
  const checkedReward = finiteOf(reward, "reward");
  const checkedSatisfaction = satisfactionOf(driveSatisfaction);
  const learningRate = next.hebbianLr * (1 + Math.abs(checkedReward));
  next.lastPhaseTransition = false;
  const hidden = next.lastHidden ?? [
    ...next.recurrentState,
    ...Array(NEURAL_HIDDEN_SIZE - NEURAL_RECURRENT_SIZE).fill(0),
  ];

  for (let signalIndex = 0; signalIndex < NEURAL_OUTPUT_SIZE; signalIndex += 1) {
    const signalValue = checkedSignals[NEURAL_SIGNAL_NAMES[signalIndex]];
    for (let hiddenIndex = 0; hiddenIndex < NEURAL_HIDDEN_SIZE; hiddenIndex += 1) {
      if (Math.abs(hidden[hiddenIndex]) > 0.05) {
        next.W2[signalIndex][hiddenIndex] += learningRate
          * checkedReward
          * hidden[hiddenIndex]
          * (signalValue - 0.5);
      }
    }
  }

  if (Math.abs(checkedReward) > 0.05 && next.lastInput !== null) {
    for (let hiddenIndex = 0; hiddenIndex < NEURAL_HIDDEN_SIZE; hiddenIndex += 1) {
      if (Math.abs(hidden[hiddenIndex]) <= 0.15) continue;
      for (let inputIndex = 0; inputIndex < NEURAL_INPUT_SIZE; inputIndex += 1) {
        if (Math.abs(next.lastInput[inputIndex]) > 0.05) {
          next.W1[hiddenIndex][inputIndex] += learningRate
            * 0.3
            * checkedReward
            * next.lastInput[inputIndex]
            * hidden[hiddenIndex];
        }
      }
    }
  }

  if (checkedReward < -0.1) next.frustration += Math.abs(checkedReward);
  else next.frustration = Math.max(0, next.frustration - checkedReward * 0.5);

  if (next.frustration > next.phaseThreshold) {
    for (let index = 0; index < NEURAL_OUTPUT_SIZE; index += 1) {
      const signalValue = checkedSignals[NEURAL_SIGNAL_NAMES[index]];
      next.b2[index] += -0.3 * (signalValue - 0.5) + gaussian(next.rng, 0, 0.15);
    }
    for (let index = 0; index < NEURAL_HIDDEN_SIZE; index += 1) {
      next.b1[index] += gaussian(next.rng, 0, 0.1);
    }
    next.frustration = 0;
    next.lastPhaseTransition = true;
  }

  for (const name of NEURAL_DRIVE_NAMES) {
    next.driveState[name] = Math.max(
      0,
      next.driveState[name] - (checkedSatisfaction[name] ?? 0),
    );
  }
  next.totalReward += checkedReward;
  next.interactionCount += 1;

  for (let row = 0; row < NEURAL_OUTPUT_SIZE; row += 1) {
    for (let column = 0; column < NEURAL_HIDDEN_SIZE; column += 1) {
      next.W2[row][column] = clamp(next.W2[row][column] * WEIGHT_DECAY, -W2_LIMIT, W2_LIMIT);
    }
  }
  for (let row = 0; row < NEURAL_HIDDEN_SIZE; row += 1) {
    for (let column = 0; column < NEURAL_INPUT_SIZE; column += 1) {
      next.W1[row][column] = clamp(next.W1[row][column] * WEIGHT_DECAY, -W1_LIMIT, W1_LIMIT);
    }
  }
  return next;
}

export function neuralStep(
  state: NeuralState,
  context: Record<string, number>,
  reward = 0,
  driveSatisfaction?: Record<string, number>,
  drives?: Record<string, number>,
): { state: NeuralState; signals: NeuralSignals } {
  const forward = neuralForward(state, context, drives);
  const next = neuralLearn(forward.state, forward.signals, reward, driveSatisfaction);
  for (const name of NEURAL_DRIVE_NAMES) {
    next.driveState[name] = Math.min(
      1,
      next.driveState[name] + next.driveAccumulationRate[name],
    );
  }
  next.age += 1;
  return { state: next, signals: forward.signals };
}

export function neuralFingerprint(state: NeuralState, windowSize = 30): NeuralFingerprint {
  const checked = validateNeuralState(state);
  const size = integerOf(windowSize, "windowSize", 1, NEURAL_HISTORY_LIMIT);
  const recent = checked.signalHistory.slice(-size);
  if (recent.length === 0) return { traits: {}, contradictions: [] };

  const averages = Object.fromEntries(NEURAL_SIGNAL_NAMES.map((name) => [
    name,
    recent.reduce((total, signals) => total + signals[name], 0) / recent.length,
  ])) as NeuralSignals;
  const traits = Object.fromEntries(NEURAL_SIGNAL_NAMES.map((name) => [
    name,
    averages[name] > 0.7 ? "high" : averages[name] < 0.3 ? "low" : "neutral",
  ])) as Record<NeuralSignalName, "high" | "low" | "neutral">;
  const contradictions: [NeuralSignalName, NeuralSignalName][] = [];
  for (let first = 0; first < NEURAL_OUTPUT_SIZE; first += 1) {
    for (let second = first + 1; second < NEURAL_OUTPUT_SIZE; second += 1) {
      const firstName = NEURAL_SIGNAL_NAMES[first];
      const secondName = NEURAL_SIGNAL_NAMES[second];
      let highLow = 0;
      let lowHigh = 0;
      for (let index = 0; index < recent.length - 1; index += 1) {
        const current = recent[index];
        const following = recent[index + 1];
        if (
          current[firstName] > 0.7 && following[firstName] < 0.3
          && current[secondName] < 0.3 && following[secondName] > 0.7
        ) highLow += 1;
        else if (
          current[firstName] < 0.3 && following[firstName] > 0.7
          && current[secondName] > 0.7 && following[secondName] < 0.3
        ) lowHigh += 1;
      }
      if (highLow > recent.length * 0.1 && lowHigh > recent.length * 0.1) {
        contradictions.push([firstName, secondName]);
      }
    }
  }
  return { traits, avgSignals: averages, contradictions };
}
