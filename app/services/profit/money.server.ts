/**
 * High-precision financial rounding and integer-safe money helpers.
 * All monetary amounts are integers in minor units (e.g., cents).
 * Percentages are integer basis points (1% = 100 bps, 40% = 4000 bps).
 * Uses BigInt integer division with "Round Half Away From Zero" to eliminate floating-point drift.
 */

/**
 * Validates and converts a safe integer number or BigInt into a BigInt.
 * @throws RangeError if val is a non-integer float (e.g. 10.5) or exceeds safe integer bounds.
 */
export function toMinorBigInt(val: number | bigint): bigint {
  if (typeof val === "bigint") {
    return val;
  }
  if (typeof val === "number") {
    if (!Number.isInteger(val)) {
      throw new RangeError(`Amount must be an integer minor unit; decimal float ${val} is not allowed.`);
    }
    if (!Number.isSafeInteger(val)) {
      throw new RangeError(`Amount exceeds safe integer range: ${val}.`);
    }
    return BigInt(val);
  }
  throw new TypeError(`Expected number or bigint, got ${typeof val}`);
}

/**
 * Validates and converts a BigInt back into a safe Number.
 * @throws RangeError if BigInt exceeds Number safe integer bounds.
 */
export function fromMinorBigInt(val: bigint): number {
  if (val > BigInt(Number.MAX_SAFE_INTEGER) || val < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`BigInt ${val} exceeds JavaScript Number.isSafeInteger range.`);
  }
  return Number(val);
}

/**
 * Rounds half away from zero using pure BigInt integer arithmetic:
 * - 0.5 rounds to 1, 1.5 rounds to 2
 * - -0.5 rounds to -1, -1.5 rounds to -2
 *
 * @throws RangeError if denominator is zero
 */
export function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("Division by zero in roundHalfAwayFromZero");
  }

  // Normalize sign so denominator is always positive
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;

  // If 2 * remainder >= denominator, round away from zero
  const shouldRoundUp = 2n * remainder >= d;
  const rounded = shouldRoundUp ? quotient + 1n : quotient;

  return sign * rounded;
}

/**
 * Number-friendly wrapper around roundHalfAwayFromZero.
 * Accepts safe integer numbers or BigInts and returns an integer number.
 */
export function roundHalfAwayFromZeroInt(
  numerator: number | bigint,
  denominator: number | bigint
): number {
  const n = toMinorBigInt(numerator);
  const d = toMinorBigInt(denominator);
  return fromMinorBigInt(roundHalfAwayFromZero(n, d));
}

/**
 * Calculates basis points on an integer minor unit amount:
 * result = roundHalfAwayFromZero(amountMinor * bps / 10000)
 * @throws RangeError if bps is negative
 */
export function calcBasisPoints(amountMinor: number, bps: number): number {
  if (bps < 0) {
    throw new RangeError(`Basis points cannot be negative, got ${bps}`);
  }
  if (amountMinor === 0 || bps === 0) return 0;
  const n = toMinorBigInt(amountMinor) * BigInt(bps);
  return fromMinorBigInt(roundHalfAwayFromZero(n, 10000n));
}

/**
 * Calculates payment gateway processing fee:
 * - If total charged <= 0: fee is strictly 0 (no percentage fee, no fixed fee).
 * - If total charged > 0: roundHalfAwayFromZero(totalCharged * feeBps / 10000) + fixedFeeMinor.
 */
export function calcPaymentFee(
  totalChargedMinor: number,
  feeBps: number,
  fixedFeeMinor: number
): number {
  if (totalChargedMinor <= 0) {
    return 0;
  }
  return calcBasisPoints(totalChargedMinor, feeBps) + fixedFeeMinor;
}

/**
 * Proportionally allocates an integer amount (totalMinor) across multiple line items based on shares.
 * Guarantees that the sum of allocated amounts strictly equals totalMinor down to the exact cent.
 *
 * Handling:
 * 1. If totalMinor is 0: returns all zeros.
 * 2. If sum(shares) == 0 ($0 order revenue / 100% discount promo):
 *    Allocates totalMinor evenly across items, with any odd remainder cent added to the first item (lowest index).
 * 3. If sum(shares) > 0:
 *    Proportionally divides using roundHalfAwayFromZero, and adds any remainder cent difference
 *    to the item with the largest share (tie-breaking: lowest index) so sum(allocated) === totalMinor.
 *
 * @throws RangeError if shares array is empty or any share is negative.
 */
export function allocateProportional(totalMinor: number, shares: number[]): number[] {
  const n = shares.length;
  if (n === 0) {
    throw new RangeError("Shares array cannot be empty in allocateProportional");
  }
  for (let i = 0; i < n; i++) {
    if (shares[i] < 0) {
      throw new RangeError(`Weights/shares cannot be negative: share at index ${i} is ${shares[i]}`);
    }
  }

  if (n === 1) return [totalMinor];
  if (totalMinor === 0) return new Array(n).fill(0);

  const totalShares = shares.reduce((acc, s) => acc + s, 0);

  // Case A: Total shares is 0 (e.g., $0 revenue order with 100% discount promo)
  if (totalShares === 0) {
    const baseShare = Math.trunc(totalMinor / n);
    const remainder = totalMinor - baseShare * n;

    const result = new Array(n).fill(baseShare);
    // Formula 81: Add remainder to the first item (lowest index 0)
    result[0] += remainder;
    return result;
  }

  // Case B: Standard proportional allocation (Largest Remainder / Hamilton method)
  // Handles positive and negative totalMinor cleanly
  const sign = totalMinor < 0 ? -1 : 1;
  const absTotal = Math.abs(totalMinor);

  const allocated = new Array(n).fill(0);
  const remainders: Array<{ index: number; remainder: bigint }> = [];
  let allocatedSum = 0;

  for (let i = 0; i < n; i++) {
    const share = BigInt(shares[i]);
    const num = BigInt(absTotal) * share;
    const den = BigInt(totalShares);

    const base = Number(num / den);
    const rem = num % den;

    allocated[i] = base;
    allocatedSum += base;
    remainders.push({ index: i, remainder: rem });
  }

  // Sort remainders descending. On tie, preserve ascending index order (lowest index first)
  remainders.sort((a, b) => {
    if (b.remainder > a.remainder) return 1;
    if (b.remainder < a.remainder) return -1;
    return a.index - b.index;
  });

  let centsToDistribute = absTotal - allocatedSum;
  let remIdx = 0;
  while (centsToDistribute > 0 && remIdx < remainders.length) {
    allocated[remainders[remIdx].index] += 1;
    centsToDistribute--;
    remIdx++;
  }

  return sign === -1 ? allocated.map((v) => -v) : allocated;
}
