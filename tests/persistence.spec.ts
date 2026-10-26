/**
 * T004 independent QA deep tests for the H0 persistence algorithm.
 *
 * Cross-validation strategy (PROJECT_BOOK.md §10.5): every β0 assertion is
 * checked against tests/helpers/oracle.ts, an independently written queue-
 * based BFS flood-fill that shares NO solving code with the DSU
 * implementation in src/domain/persistence.ts.
 */
import { describe, expect, it } from 'vitest';
import type { PersistencePair, PersistenceResult, TerrainV1 } from '../src/domain/types';
import { analyzePersistence } from '../src/domain/persistence';
import { beta0ByBfs } from './helpers/oracle';

const MAX_LEVEL = 255;

function makeTerrain(width: number, height: number, elevations: number[]): TerrainV1 {
  return { schemaVersion: 1, width, height, elevations, title: 't004-qa' };
}

const STRIP = (): TerrainV1 => makeTerrain(5, 1, [5, 1, 4, 1, 3]);
const DIAGONAL = (): TerrainV1 => makeTerrain(2, 2, [9, 0, 0, 8]);
const PLATEAU = (): TerrainV1 => makeTerrain(3, 3, [4, 4, 1, 4, 1, 1, 1, 1, 4]);
const CONSTANT7 = (): TerrainV1 => makeTerrain(2, 2, [7, 7, 7, 7]);
const ALL_ZERO = (): TerrainV1 => makeTerrain(3, 2, [0, 0, 0, 0, 0, 0]);
const ALL_255 = (): TerrainV1 => makeTerrain(2, 3, [255, 255, 255, 255, 255, 255]);

/** β0(h) reconstructed purely from the barcode (§8.4 invariant). */
function beta0FromPairs(pairs: PersistencePair[], level: number): number {
  return pairs.filter(
    (p) => p.birth >= level && (p.death === null || p.death < level),
  ).length;
}

/**
 * Deterministic xorshift32. The requested seed is offset by a fixed nonzero
 * constant so that seed 0 cannot collapse into the all-zero attractor.
 */
function makeXorshift32(requestedSeed: number): () => number {
  let state = (requestedSeed + 0x9e3779b9) >>> 0;
  if (state === 0) {
    state = 0x6d2b79f5;
  }
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function randomTerrain(rand: () => number, index: number): TerrainV1 {
  const width = 1 + (rand() % 16);
  const height = 1 + (rand() % 16);
  const cellCount = width * height;
  const elevations: number[] = new Array<number>(cellCount);
  for (let cell = 0; cell < cellCount; cell += 1) {
    elevations[cell] = rand() % 16;
  }
  return {
    schemaVersion: 1,
    width,
    height,
    elevations,
    title: `xorshift-${index}`,
  };
}

/** Generic invariants that must hold for every terrain (§8.4). */
function checkInvariants(terrain: TerrainV1, result: PersistenceResult): void {
  const { pairs, merges, beta0ByLevel } = result;

  expect(beta0ByLevel).toHaveLength(256);

  // Exactly one essential pair, placed first, with all null fields.
  const essentials = pairs.filter((p) => p.death === null);
  expect(essentials).toHaveLength(1);
  expect(pairs[0]).toBe(essentials[0]);
  const essential = essentials[0];
  expect(essential.persistence).toBeNull();
  expect(essential.winnerPeakCell).toBeNull();
  expect(essential.witnessCell).toBeNull();
  expect(essential.id).toBe(`peak-${essential.peakCell}`);

  // Finite pairs: persistence is nonzero and equals birth - death.
  const finitePairs = pairs.filter((p) => p.death !== null);
  for (const pair of finitePairs) {
    expect(pair.death).not.toBeNull();
    const death = pair.death as number;
    expect(pair.birth).toBeGreaterThan(death);
    expect(pair.persistence).toBe(pair.birth - death);
    expect(pair.id).toBe(`peak-${pair.peakCell}`);
    // Peak elevation equals birth; witness elevation equals death.
    expect(terrain.elevations[pair.peakCell]).toBe(pair.birth);
    expect(pair.witnessCell).not.toBeNull();
    expect(terrain.elevations[pair.witnessCell as number]).toBe(death);
    expect(pair.winnerPeakCell).not.toBeNull();
  }
  // Essential peak elevation equals its birth too.
  expect(terrain.elevations[essential.peakCell]).toBe(essential.birth);

  // Merges correspond one-to-one with finite pairs.
  expect(merges).toHaveLength(finitePairs.length);
  const mergesById = new Map(merges.map((m) => [m.id, m]));
  expect(mergesById.size).toBe(merges.length);
  for (const pair of finitePairs) {
    const merge = mergesById.get(pair.id);
    expect(merge).toBeDefined();
    expect(merge?.level).toBe(pair.death);
    expect(merge?.loserPeakCell).toBe(pair.peakCell);
    expect(merge?.winnerPeakCell).toBe(pair.winnerPeakCell);
    expect(merge?.witnessCell).toBe(pair.witnessCell);
    expect(terrain.elevations[merge?.witnessCell as number]).toBe(merge?.level);
  }

  // β0 curve agrees with the independent BFS oracle and with the barcode.
  for (let level = 0; level <= MAX_LEVEL; level += 1) {
    expect(beta0ByLevel[level]).toBe(beta0ByBfs(terrain, level));
    expect(beta0ByLevel[level]).toBe(beta0FromPairs(pairs, level));
  }
}

describe('T004 §10 deterministic samples', () => {
  it('S-STRIP: exact pairs, witnesses and β0 curve', () => {
    const terrain = STRIP();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([
      {
        id: 'peak-0',
        peakCell: 0,
        birth: 5,
        death: null,
        persistence: null,
        winnerPeakCell: null,
        witnessCell: null,
      },
      {
        id: 'peak-2',
        peakCell: 2,
        birth: 4,
        death: 1,
        persistence: 3,
        winnerPeakCell: 0,
        witnessCell: 1,
      },
      {
        id: 'peak-4',
        peakCell: 4,
        birth: 3,
        death: 1,
        persistence: 2,
        winnerPeakCell: 0,
        witnessCell: 3,
      },
    ]);

    expect(result.merges).toEqual([
      { id: 'peak-2', level: 1, winnerPeakCell: 0, loserPeakCell: 2, witnessCell: 1 },
      { id: 'peak-4', level: 1, winnerPeakCell: 0, loserPeakCell: 4, witnessCell: 3 },
    ]);

    const expected: Record<number, number> = { 6: 0, 5: 1, 4: 2, 3: 3, 2: 3, 1: 1, 0: 1 };
    for (const [level, count] of Object.entries(expected)) {
      expect(result.beta0ByLevel[Number(level)]).toBe(count);
    }
    checkInvariants(terrain, result);
  });

  it('S-DIAGONAL: diagonal cells do not connect', () => {
    const terrain = DIAGONAL();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([
      {
        id: 'peak-0',
        peakCell: 0,
        birth: 9,
        death: null,
        persistence: null,
        winnerPeakCell: null,
        witnessCell: null,
      },
      {
        id: 'peak-3',
        peakCell: 3,
        birth: 8,
        death: 0,
        persistence: 8,
        winnerPeakCell: 0,
        witnessCell: result.pairs[1].witnessCell,
      },
    ]);
    const finite = result.pairs[1];
    // Witness sits at level 0 and is 4-adjacent to both peaks; cells 1 or 2.
    expect([1, 2]).toContain(finite.witnessCell);
    expect(terrain.elevations[finite.witnessCell as number]).toBe(0);

    expect(result.beta0ByLevel[9]).toBe(1);
    expect(result.beta0ByLevel[8]).toBe(2);
    expect(result.beta0ByLevel[1]).toBe(2);
    expect(result.beta0ByLevel[0]).toBe(1);
    checkInvariants(terrain, result);
  });

  it('S-PLATEAU: plateau births exactly one peak, no zero-lifetime barcode', () => {
    const terrain = PLATEAU();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([
      {
        id: 'peak-0',
        peakCell: 0,
        birth: 4,
        death: null,
        persistence: null,
        winnerPeakCell: null,
        witnessCell: null,
      },
      {
        id: 'peak-8',
        peakCell: 8,
        birth: 4,
        death: 1,
        persistence: 3,
        winnerPeakCell: 0,
        witnessCell: result.pairs[1].witnessCell,
      },
    ]);
    const finite = result.pairs[1];
    expect(terrain.elevations[finite.witnessCell as number]).toBe(1);
    expect(result.pairs.every((p) => p.birth !== p.death)).toBe(true);

    expect(result.beta0ByLevel[4]).toBe(2);
    expect(result.beta0ByLevel[2]).toBe(2);
    expect(result.beta0ByLevel[1]).toBe(1);
    checkInvariants(terrain, result);
  });

  it('S-CONSTANT: all-7 2x2 yields one essential pair only', () => {
    const terrain = CONSTANT7();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([
      {
        id: 'peak-0',
        peakCell: 0,
        birth: 7,
        death: null,
        persistence: null,
        winnerPeakCell: null,
        witnessCell: null,
      },
    ]);
    expect(result.merges).toEqual([]);
    expect(result.beta0ByLevel[8]).toBe(0);
    expect(result.beta0ByLevel[7]).toBe(1);
    expect(result.beta0ByLevel[0]).toBe(1);
    checkInvariants(terrain, result);
  });

  it('all-zero terrain: single essential pair at birth 0, β0(0)=1, β0(1)=0', () => {
    const terrain = ALL_ZERO();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([
      {
        id: 'peak-0',
        peakCell: 0,
        birth: 0,
        death: null,
        persistence: null,
        winnerPeakCell: null,
        witnessCell: null,
      },
    ]);
    expect(result.merges).toEqual([]);
    expect(result.beta0ByLevel[0]).toBe(1);
    expect(result.beta0ByLevel[1]).toBe(0);
    expect(result.beta0ByLevel[255]).toBe(0);
    expect(result.minHeight).toBe(0);
    expect(result.maxHeight).toBe(0);
    checkInvariants(terrain, result);
  });

  it('all-255 terrain: single essential pair at birth 255, β0(255)=1', () => {
    const terrain = ALL_255();
    const result = analyzePersistence(terrain);

    expect(result.pairs).toEqual([
      {
        id: 'peak-0',
        peakCell: 0,
        birth: 255,
        death: null,
        persistence: null,
        winnerPeakCell: null,
        witnessCell: null,
      },
    ]);
    expect(result.merges).toEqual([]);
    expect(result.beta0ByLevel[255]).toBe(1);
    expect(result.beta0ByLevel[0]).toBe(1);
    expect(result.minHeight).toBe(255);
    expect(result.maxHeight).toBe(255);
    checkInvariants(terrain, result);
  });
});

describe('T004 §10.5 pseudo-random cross-validation (xorshift32)', () => {
  const SEED_COUNT = 120;
  const terrains: TerrainV1[] = [];
  for (let seed = 0; seed < SEED_COUNT; seed += 1) {
    terrains.push(randomTerrain(makeXorshift32(seed), seed));
  }

  it('generator is deterministic and never stuck at zero (seed 0 included)', () => {
    const a = makeXorshift32(0);
    const b = makeXorshift32(0);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(seqA.some((v) => v !== 0)).toBe(true);
  });

  it.each(terrains.map((t, i) => [i, t] as const))(
    'seed %i: β0 curve equals independent BFS oracle at every level 0..255',
    (_seed, terrain) => {
      const result = analyzePersistence(terrain);
      for (let level = 0; level <= 15; level += 1) {
        expect(result.beta0ByLevel[level]).toBe(beta0ByBfs(terrain, level));
      }
      // 255-tier boundary: heights only reach 15, so β0(255) must be 0.
      expect(result.beta0ByLevel[255]).toBe(0);
      expect(result.beta0ByLevel[255]).toBe(beta0ByBfs(terrain, 255));
      // Full curve still verified inside checkInvariants.
      checkInvariants(terrain, result);
    },
  );

  it.each(terrains.map((t, i) => [i, t] as const))(
    'seed %i: repeated analyzePersistence() calls are strictly equal',
    (_seed, terrain) => {
      const first = analyzePersistence(terrain);
      const second = analyzePersistence(terrain);
      expect(second).toStrictEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    },
  );

  it.each(terrains.map((t, i) => [i, t] as const))(
    'seed %i: input terrain is not mutated',
    (_seed, terrain) => {
      const snapshot = terrain.elevations.slice();
      analyzePersistence(terrain);
      expect(terrain.elevations).toEqual(snapshot);
      expect(terrain.width).toBeGreaterThanOrEqual(1);
      expect(terrain.height).toBeGreaterThanOrEqual(1);
    },
  );

  it('covers the intended distributions (grids 1-16, heights 0..15)', () => {
    expect(terrains).toHaveLength(SEED_COUNT);
    const sizes = new Set(terrains.map((t) => `${t.width}x${t.height}`));
    expect(sizes.size).toBeGreaterThan(40);
    expect(terrains.some((t) => t.width === 1 || t.height === 1)).toBe(true);
    expect(terrains.some((t) => t.width * t.height >= 200)).toBe(true);
    for (const t of terrains) {
      expect(t.width).toBeGreaterThanOrEqual(1);
      expect(t.width).toBeLessThanOrEqual(16);
      expect(t.height).toBeGreaterThanOrEqual(1);
      expect(t.height).toBeLessThanOrEqual(16);
      for (const value of t.elevations) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(15);
      }
    }
  });
});
