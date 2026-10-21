/**
 * Rounds a finite double to four decimal places using exact binary arithmetic and ties to even.
 * Returns the nearest double to that decimal value, preserving negative zero; nonnumbers throw TypeError.
 * The fixed-width double decomposition bounds the integer work independently of the input magnitude.
 */
export function roundFourDecimals(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('rounding requires a finite number');
  }
  // At this binary exponent, half a decimal step is smaller than half a double's spacing.
  if (value === 0 || Math.abs(value) >= 2 ** 39) return value;

  const negative = value < 0;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const significand = exponent === 0 ? fraction : fraction + (1n << 52n);
  const power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  const scaled = significand * 10_000n;
  const denominator = 1n << BigInt(-power);
  let integral = scaled / denominator;
  const twiceRemainder = (scaled % denominator) * 2n;
  if (twiceRemainder > denominator || (twiceRemainder === denominator && integral % 2n !== 0n)) {
    integral += 1n;
  }

  const rounded = Number(integral) / 10_000;
  return negative ? -rounded : rounded;
}
