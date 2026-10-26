/**
 * Smoke tests for the H0 DSU persistence algorithm (plan §5 samples).
 *
 * These are exact-value checks only: no independent oracle implementation and
 * no sample-specific branches inside the algorithm under test.
 */
import { describe, expect, it } from 'vitest';
import type { PersistencePair, PersistenceResult, TerrainV1 } from '../src/domain/types';
import { analyzePersistence } from '../src/domain/persistence';

/** Build a TerrainV1 that keeps the caller's elevations array by identity. */
function makeTerrain(width: number, height: number, elevations: number[]): TerrainV1 {
  return { schemaVersion: 1, width, height, elevations, title: 'smoke' };
}

const STRIP = (): TerrainV1 => makeTerrain(5, 1, [5, 1, 4, 1, 3]);
const DIAGONAL = (): TerrainV1 => makeTerrain(2, 2, [9, 0, 0, 8]);
const PLATEAU = (): TerrainV1 => makeTerrain(3, 3, [4, 4, 1, 4, 1, 1, 1, 1, 4]);
const CONSTANT = (): TerrainV1 => makeTerrain(2, 2, [7, 7, 7, 7]);

const essentialPair = (peakCell: number, birth: number) => ({
  id: `peak-${peakCell}`,
  peakCell,
  birth,
  death: null,
  persistence: null,
  winnerPeakCell: null,
  witnessCell: null,
});

const finitePair = (
  peakCell: number,
  birth: number,
  death: number,
  winnerPeakCell: number,
  witnessCell: number,
) => ({
  id: `peak-${peakCell}`,
  peakCell,
  birth,
  death,
  persistence: birth - death,
  winnerPeakCell,
  witnessCell,
});

const mergeEvent = (
  peakCell: number,
  level: number,
  winnerPeakCell: number,
  loserPeakCell: number,
  witnessCell: number,
) => ({
  id: `peak-${peakCell}`,
  level,
  winnerPeakCell,
  loserPeakCell,
  witnessCell,
});

/** Structural invariants that must hold for every analysis result. */
function checkInvariants(result: PersistenceResult, terrain: TerrainV1): void {
  expect(result.beta0ByLevel.length).toBe(256);

  const essential = result.pairs.filter((pair) => pair.death === null);
  expect(essential.length).toBe(1);
  expect(essential[0].persistence).toBeNull();
  expect(essential[0].winnerPeakCell).toBeNull();
  expect(essential[0].witnessCell).toBeNull();

  const finite = result.pairs.filter(
    (pair): pair is PersistencePair & { death: number } => pair.death !== null,
  );
  for (const pair of finite) {
    expect(pair.id).toBe(`peak-${pair.peakCell}`);
    expect(pair.persistence).toBe(pair.birth - pair.death);
    expect(pair.persistence).not.toBe(0); // no zero-lifetime barcodes
    expect(pair.winnerPeakCell).not.toBe(pair.peakCell);
  }

  // merges correspond one-to-one with finite pairs.
  expect(result.merges.length).toBe(finite.length);
  const byId = new Map(finite.map((pair) => [pair.id, pair]));
  for (const merge of result.merges) {
    const pair = byId.get(merge.id);
    if (pair === undefined) {
      throw new Error(`merge ${merge.id} has no matching finite pair`);
    }
    expect(merge.level).toBe(pair.death);
    expect(merge.winnerPeakCell).toBe(pair.winnerPeakCell);
    expect(merge.loserPeakCell).toBe(pair.peakCell);
    expect(merge.witnessCell).toBe(pair.witnessCell);
    expect(terrain.elevations[merge.witnessCell]).toBe(merge.level);
  }
}

describe('analyzePersistence (H0 DSU filtration, plan §5 samples)', () => {
  it('S-STRIP: 5x1 [5,1,4,1,3]', () => {
    const terrain = STRIP();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([
      essentialPair(0, 5),
      finitePair(2, 4, 1, 0, 1),
      finitePair(4, 3, 1, 0, 3),
    ]);
    expect(result.merges).toEqual([mergeEvent(2, 1, 0, 2, 1), mergeEvent(4, 1, 0, 4, 3)]);
    expect(result.beta0ByLevel[5]).toBe(1);
    expect(result.beta0ByLevel[4]).toBe(2);
    expect(result.beta0ByLevel[3]).toBe(3);
    expect(result.beta0ByLevel[2]).toBe(3);
    expect(result.beta0ByLevel[1]).toBe(1);
    expect(result.beta0ByLevel[0]).toBe(1);
    expect(result.maxHeight).toBe(5);
    expect(result.minHeight).toBe(1);

    checkInvariants(result, terrain);
  });

  it('S-DIAGONAL: 2x2 [9,0,0,8] - diagonals never connect (4-connectivity)', () => {
    const terrain = DIAGONAL();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([essentialPair(0, 9), finitePair(3, 8, 0, 0, 1)]);
    expect(result.merges).toEqual([mergeEvent(3, 0, 0, 3, 1)]);
    expect(result.beta0ByLevel[9]).toBe(1);
    expect(result.beta0ByLevel[8]).toBe(2);
    expect(result.beta0ByLevel[0]).toBe(1);
    expect(result.maxHeight).toBe(9);
    expect(result.minHeight).toBe(0);

    checkInvariants(result, terrain);
  });

  it('S-PLATEAU: 3x3 [4,4,1,4,1,1,1,1,4] - plateau spawns no pseudo-event', () => {
    const terrain = PLATEAU();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([essentialPair(0, 4), finitePair(8, 4, 1, 0, 5)]);
    expect(result.merges).toEqual([mergeEvent(8, 1, 0, 8, 5)]);
    expect(result.beta0ByLevel[4]).toBe(2);
    expect(result.beta0ByLevel[1]).toBe(1);
    expect(result.maxHeight).toBe(4);
    expect(result.minHeight).toBe(1);

    checkInvariants(result, terrain);
  });

  it('S-CONSTANT: 2x2 [7,7,7,7] - one essential pair, no finite pairs', () => {
    const terrain = CONSTANT();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([essentialPair(0, 7)]);
    expect(result.merges).toEqual([]);
    expect(result.beta0ByLevel[8]).toBe(0);
    expect(result.beta0ByLevel[7]).toBe(1);
    expect(result.beta0ByLevel[0]).toBe(1);
    expect(result.maxHeight).toBe(7);
    expect(result.minHeight).toBe(7);

    checkInvariants(result, terrain);
  });

  it('does not mutate the input terrain or elevations', () => {
    const elevations = [5, 1, 4, 1, 3];
    const terrain = makeTerrain(5, 1, elevations);
    const snapshot = structuredClone(terrain);

    analyzePersistence(terrain);

    expect(terrain).toEqual(snapshot);
    expect(elevations).toEqual([5, 1, 4, 1, 3]);
  });

  it('is deterministic across repeated calls', () => {
    const first = analyzePersistence(PLATEAU());
    const second = analyzePersistence(PLATEAU());
    const third = analyzePersistence(STRIP());

    expect(second).toEqual(first);
    expect(first).not.toEqual(third);
    expect(second.pairs).toEqual(first.pairs);
    expect(second.merges).toEqual(first.merges);
    expect(second.beta0ByLevel).toEqual(first.beta0ByLevel);
  });

  it('reports beta0ByLevel of length 256 and level semantics on every sample', () => {
    for (const make of [STRIP, DIAGONAL, PLATEAU, CONSTANT]) {
      const result = analyzePersistence(make());
      expect(result.beta0ByLevel.length).toBe(256);
      // Above maxHeight nothing is active; at/below minHeight the full
      // rectangle is one connected component.
      expect(result.beta0ByLevel[255]).toBe(0);
      expect(result.beta0ByLevel[result.maxHeight + 1]).toBe(0);
      expect(result.beta0ByLevel[result.minHeight]).toBe(1);
      expect(result.beta0ByLevel[0]).toBe(1);
    }
  });
});
