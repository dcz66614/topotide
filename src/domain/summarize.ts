/**
 * Visible-barcode filtering and A/B summary statistics
 * (PROJECT_BOOK.md §9.2; IMPLEMENTATION_PLAN.md P0001-T007).
 *
 * `tau` is the persistence threshold, an integer in 0..255: the essential pair
 * is always retained, a finite pair survives iff persistence >= tau.
 * `summarize()` reads beta0 from the ORIGINAL `beta0ByLevel[level]` array, so
 * the threshold only changes the finite feature statistics, never beta0.
 *
 * Both functions are pure: they only read `r` and return fresh arrays/objects.
 */
import type { PersistencePair, PersistenceResult } from './types';

const MIN_TAU = 0;
const MAX_TAU = 255;
const MIN_LEVEL = 0;
const MAX_LEVEL = 255;

/** Throws RangeError unless value is an integer in [min, max]. */
function assertIntegerInRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in ${min}..${max}`);
  }
}

/**
 * Returns the pairs visible at threshold `tau`, in the input order:
 * the essential pair (persistence === null) is always retained, a finite pair
 * is retained iff its persistence is not null and persistence >= tau.
 * Throws RangeError unless tau is an integer in 0..255.
 */
export function visiblePairs(r: PersistenceResult, tau: number): PersistencePair[] {
  assertIntegerInRange(tau, MIN_TAU, MAX_TAU, 'tau');
  const visible: PersistencePair[] = [];
  for (const pair of r.pairs) {
    if (pair.persistence === null || pair.persistence >= tau) {
      visible.push(pair);
    }
  }
  return visible;
}

/**
 * Summary statistics for one analysis at threshold `tau` and water level
 * `level`:
 *   - beta0 is taken from the ORIGINAL r.beta0ByLevel[level] and is never
 *     changed by the tau filtering;
 *   - finiteCountAtTau counts the visible finite pairs at tau;
 *   - longestFinitePersistence is the maximum persistence among the visible
 *     finite pairs, or 0 when none are visible.
 * Throws RangeError unless tau is an integer in 0..255 and level an integer
 * in 0..255.
 */
export function summarize(
  r: PersistenceResult,
  tau: number,
  level: number,
): { beta0: number; finiteCountAtTau: number; longestFinitePersistence: number } {
  assertIntegerInRange(tau, MIN_TAU, MAX_TAU, 'tau');
  assertIntegerInRange(level, MIN_LEVEL, MAX_LEVEL, 'level');

  // beta0 comes straight from the original array: filtering does not touch it.
  const beta0 = r.beta0ByLevel[level];

  let finiteCountAtTau = 0;
  let longestFinitePersistence = 0;
  for (const pair of visiblePairs(r, tau)) {
    const persistence = pair.persistence;
    if (persistence === null) {
      continue; // the essential pair is visible but never a finite feature
    }
    finiteCountAtTau += 1;
    if (persistence > longestFinitePersistence) {
      longestFinitePersistence = persistence;
    }
  }

  return { beta0, finiteCountAtTau, longestFinitePersistence };
}
