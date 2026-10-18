/* Arithmetic adapted from OpenHer's neural core; see third-party/OpenHer-LICENSE. */
import {
  NEURAL_CONTEXT_NAMES,
  NEURAL_DRIVE_NAMES,
  NEURAL_HIDDEN_SIZE,
  NEURAL_INPUT_SIZE,
  NEURAL_RECURRENT_SIZE,
  NEURAL_SIGNAL_NAMES,
  validateNeuralState,
} from './neural.ts';
import type {NeuralContextName, NeuralSignals, NeuralState} from './neural.ts';

/** Ordered dimensionless context names from the kernel; this immutable alias cannot fail. */
export const RESTING_CONTEXT_NAMES = Object.freeze([...NEURAL_CONTEXT_NAMES]);

/** Design-neutral dimensionless context: engagement and local-day phase are 0.5, all other entries are zero. */
export const RESTING_CONTEXT: Readonly<Record<NeuralContextName, number>> = Object.freeze({
  userEmotion: 0,
  topicIntimacy: 0,
  timeOfDay: 0.5,
  conversationDepth: 0,
  userEngagement: 0.5,
  conflictLevel: 0,
  noveltyLevel: 0,
  userVulnerability: 0,
  relationshipDepth: 0,
  emotionalValence: 0,
  trustLevel: 0,
  pendingForesight: 0,
});

/** Independent hidden activations, normalized pre-clamp logits and dimensionless signals in [0, 1]. */
export interface RestingForwardResult {
  hidden: number[];
  raw: number[];
  signals: NeuralSignals;
}

function forward(checked: NeuralState, input: readonly number[]): RestingForwardResult {
  const hidden = checked.W1.map((row, index) => {
    // Bias-first accumulation preserves the kernel's exact floating point order.
    let activation = checked.b1[index];
    for (let column = 0; column < NEURAL_INPUT_SIZE; column += 1) {
      activation += row[column] * input[column];
    }
    return Math.tanh(activation);
  });

  const normalizer = Math.sqrt(NEURAL_HIDDEN_SIZE / 3);
  const raw = checked.W2.map((row, index) => {
    let activation = checked.b2[index];
    for (let column = 0; column < NEURAL_HIDDEN_SIZE; column += 1) {
      activation += row[column] * hidden[column];
    }
    return activation / normalizer;
  });
  const signals = Object.fromEntries(NEURAL_SIGNAL_NAMES.map((name, index) => [
    name,
    1 / (1 + Math.exp(-Math.max(-10, Math.min(10, raw[index])))),
  ])) as NeuralSignals;
  return {hidden, raw, signals};
}

/**
 * Evaluates exactly 25 finite dimensionless inputs without noise or mutation. Invalid vectors throw TypeError;
 * neural validation errors propagate unchanged. Outputs own all arrays and records and never advance random state.
 */
export function noiseFreeForward(state: NeuralState, input: readonly number[]): RestingForwardResult {
  const checked = validateNeuralState(state);
  if (!Array.isArray(input) || input.length !== NEURAL_INPUT_SIZE) {
    throw new TypeError('input must contain 25 finite numbers');
  }
  for (let index = 0; index < NEURAL_INPUT_SIZE; index += 1) {
    if (typeof input[index] !== 'number' || !Number.isFinite(input[index])) {
      throw new TypeError('input must contain 25 finite numbers');
    }
  }
  return forward(checked, input);
}

function inputOf(checked: NeuralState): number[] {
  return [
    ...NEURAL_DRIVE_NAMES.map(name => checked.driveBaseline[name]),
    ...NEURAL_CONTEXT_NAMES.map(name => RESTING_CONTEXT[name]),
    ...Array<number>(NEURAL_RECURRENT_SIZE).fill(0),
  ];
}

/**
 * Builds a fresh 25-value dimensionless baseline/neutral/zero-recurrence vector. Invalid neural states propagate
 * validateNeuralState's TypeError; transient drive, recurrence and history values do not contribute to the vector.
 */
export function restingInput(state: NeuralState): number[] {
  return inputOf(validateNeuralState(state));
}

/**
 * Returns the noise-free resting evaluation of a validated neural state, without modifying it or drawing randomness.
 * Invalid states propagate validateNeuralState's TypeError; every returned container is independent.
 */
export function restingForward(state: NeuralState): RestingForwardResult {
  const checked = validateNeuralState(state);
  return forward(checked, inputOf(checked));
}
