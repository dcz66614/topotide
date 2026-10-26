/**
 * Tests for the deterministic preset terrains (P0001-T006).
 *
 * Every expected height below is derived by hand from the fixed formulas in
 * IMPLEMENTATION_PLAN.md P0001-T006 (identical to PROJECT_BOOK.md §4 demo data),
 * never by re-running the implementation under test.
 */
import { describe, expect, it } from 'vitest';
import { PRESET_SIZE, makePreset } from '../src/domain/presets';
import type { PresetName } from '../src/domain/presets';
import type { TerrainV1 } from '../src/domain/types';
import { validateTerrain } from '../src/domain/validate';

const PRESET_NAMES: readonly PresetName[] = ['twin-peaks', 'ridge-gate', 'plateau'];

/** Row-major cell id on a 64x64 grid: id = y * 64 + x. */
function cellId(x: number, y: number): number {
  return y * PRESET_SIZE + x;
}

interface MinMax {
  readonly min: number;
  readonly max: number;
}

function minMax(elevations: readonly number[]): MinMax {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of elevations) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  return { min, max };
}

/** Counts occurrences of each distinct elevation value. */
function histogram(elevations: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of elevations) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** One instance of each preset, shared by the read-only assertions. */
const loaded: Readonly<Record<PresetName, TerrainV1>> = {
  'twin-peaks': makePreset('twin-peaks'),
  'ridge-gate': makePreset('ridge-gate'),
  plateau: makePreset('plateau'),
};

describe('makePreset — structural contract', () => {
  it.each(PRESET_NAMES)('%s: 64x64 with 4096 integer elevations in [0,255] and a 1..80 title', (name) => {
    const terrain = loaded[name];
    expect(terrain.schemaVersion).toBe(1);
    expect(terrain.width).toBe(64);
    expect(terrain.height).toBe(64);
    expect(terrain.elevations).toHaveLength(64 * 64);
    expect(
      terrain.elevations.every((z) => Number.isInteger(z) && z >= 0 && z <= 255),
    ).toBe(true);
    const titleCodePoints = [...terrain.title].length;
    expect(titleCodePoints).toBeGreaterThanOrEqual(1);
    expect(titleCodePoints).toBeLessThanOrEqual(80);
  });

  it.each(PRESET_NAMES)('%s: passes validateTerrain without throwing', (name) => {
    const terrain = makePreset(name);
    let validated: TerrainV1 | undefined;
    expect(() => {
      validated = validateTerrain(terrain);
    }).not.toThrow();
    expect(validated).toEqual(terrain);
    expect(validated?.elevations).not.toBe(terrain.elevations);
  });
});

describe('makePreset — exact formula spot checks: twin-peaks', () => {
  it('has its peak heights at (18,30) and (45,31)', () => {
    const { elevations } = loaded['twin-peaks'];
    // A=215-6*(0+0)=215; B=202-6*(27+1)=34; R=113-3*0-2*14=85; max(15,215,34,85)=215.
    expect(elevations[cellId(18, 30)]).toBe(215);
    // A=215-6*(27+1)=47; B=202-6*(0+0)=202; R=113-3*1-2*13=84; max(15,47,202,84)=202.
    expect(elevations[cellId(45, 31)]).toBe(202);
  });

  it('has the saddle height 131 on the ridge line at (32,30)', () => {
    const { elevations } = loaded['twin-peaks'];
    // A=215-6*(14+0)=131; B=202-6*(13+1)=118; R=113-3*0-2*0=113; max(15,131,118,113)=131.
    expect(elevations[cellId(32, 30)]).toBe(131);
  });

  it('falls off step by step and keeps the floor 15 far away', () => {
    const { elevations } = loaded['twin-peaks'];
    // One step off the first peak: A=215-6*(0+1)=209.
    expect(elevations[cellId(18, 29)]).toBe(209);
    expect(elevations[cellId(18, 31)]).toBe(209);
    // Far corners: A, B and R are all 0, so the floor 15 wins.
    expect(elevations[cellId(0, 0)]).toBe(15);
    expect(elevations[cellId(63, 63)]).toBe(15);
  });
});

describe('makePreset — exact formula spot checks: ridge-gate', () => {
  it('has its peak heights at (15,32) and (48,32)', () => {
    const { elevations } = loaded['ridge-gate'];
    // A=205-5*(0+0)=205; B=195-5*(33+0)=30; ridge=94; max(10,205,30,94)=205.
    expect(elevations[cellId(15, 32)]).toBe(205);
    // A=205-5*(33+0)=40; B=195-5*(0+0)=195; ridge=94; max(10,40,195,94)=195.
    expect(elevations[cellId(48, 32)]).toBe(195);
  });

  it('has height 120 on the gate strip at (32,32)', () => {
    const { elevations } = loaded['ridge-gate'];
    // On the strip: ridge=94; A=205-5*(17+0)=120; B=195-5*(16+0)=115; max(10,120,115,94)=120.
    expect(elevations[cellId(32, 32)]).toBe(120);
  });

  it('treats cells outside the gate strip and far away by their own terms', () => {
    const { elevations } = loaded['ridge-gate'];
    // Off-ridge (|34-32|=2>1): ridge=0; A=205-5*(17+2)=110; B=195-5*(16+2)=105; max=110.
    expect(elevations[cellId(32, 34)]).toBe(110);
    // One row above the west peak, still on the strip: ridge=94, A=205-5*(0+1)=200.
    expect(elevations[cellId(15, 31)]).toBe(200);
    // One column left of the strip: ridge=0, A=205-5*(1+0)=200.
    expect(elevations[cellId(14, 32)]).toBe(200);
    // Far corner: A, B and ridge are all 0, so the floor 10 wins.
    expect(elevations[cellId(0, 0)]).toBe(10);
  });
});

describe('makePreset — exact formula spot checks: plateau', () => {
  it('fills the west mesa with 205 and the east mesa with 185', () => {
    const { elevations } = loaded.plateau;
    // Rule 1 (8<=x<=24, 10<=y<=29): z=205, corners included.
    expect(elevations[cellId(10, 15)]).toBe(205);
    expect(elevations[cellId(8, 10)]).toBe(205);
    expect(elevations[cellId(24, 29)]).toBe(205);
    // Rule 2 (39<=x<=55, 10<=y<=29): z=185, corners included.
    expect(elevations[cellId(45, 15)]).toBe(185);
    expect(elevations[cellId(55, 29)]).toBe(185);
    expect(elevations[cellId(39, 10)]).toBe(185);
  });

  it('lays the 80 bridge and lets the last matching rule win in the overlap', () => {
    const { elevations } = loaded.plateau;
    // Rule 3 (24<=x<=39, 18<=y<=20): z=80.
    expect(elevations[cellId(30, 19)]).toBe(80);
    // Overlap columns x=24 and x=39 for y=18..20: rule 3 is applied last and wins.
    expect(elevations[cellId(24, 19)]).toBe(80);
    expect(elevations[cellId(39, 19)]).toBe(80);
    expect(elevations[cellId(24, 18)]).toBe(80);
    expect(elevations[cellId(24, 20)]).toBe(80);
    expect(elevations[cellId(39, 18)]).toBe(80);
    expect(elevations[cellId(39, 20)]).toBe(80);
    // Same columns one row outside the bridge keep the mesa heights.
    expect(elevations[cellId(24, 17)]).toBe(205);
    expect(elevations[cellId(39, 21)]).toBe(185);
  });

  it('keeps the background at 18 outside every rectangle', () => {
    const { elevations } = loaded.plateau;
    expect(elevations[cellId(0, 0)]).toBe(18);
    expect(elevations[cellId(63, 63)]).toBe(18);
    // Below the bridge rows but outside both mesas.
    expect(elevations[cellId(30, 31)]).toBe(18);
  });
});

describe('makePreset — elevation ranges', () => {
  it('twin-peaks: min 15 (floor) and max 215 (first peak)', () => {
    expect(minMax(loaded['twin-peaks'].elevations)).toEqual({ min: 15, max: 215 });
  });

  it('ridge-gate: min 10 (floor) and max 205 (west peak)', () => {
    expect(minMax(loaded['ridge-gate'].elevations)).toEqual({ min: 10, max: 205 });
  });

  it('plateau: min 18 (background), max 205 (west mesa) with exact area counts', () => {
    const { elevations } = loaded.plateau;
    expect(minMax(elevations)).toEqual({ min: 18, max: 205 });
    const counts = histogram(elevations);
    // Each mesa is 17x20=340 cells and loses its 3 bridge column cells (x=24 / x=39, y=18..20).
    expect(counts.get(205)).toBe(337);
    expect(counts.get(185)).toBe(337);
    // The bridge is 16x3=48 cells.
    expect(counts.get(80)).toBe(48);
    expect(counts.get(18)).toBe(4096 - 337 - 337 - 48);
  });
});

describe('makePreset — the three presets are pairwise distinguishable', () => {
  it('serializes to three different JSON strings', () => {
    const serialized: Record<PresetName, string> = {
      'twin-peaks': JSON.stringify(loaded['twin-peaks']),
      'ridge-gate': JSON.stringify(loaded['ridge-gate']),
      plateau: JSON.stringify(loaded.plateau),
    };
    expect(new Set(Object.values(serialized)).size).toBe(3);
    expect(serialized['twin-peaks']).not.toBe(serialized['ridge-gate']);
    expect(serialized['twin-peaks']).not.toBe(serialized.plateau);
    expect(serialized['ridge-gate']).not.toBe(serialized.plateau);
  });

  it('has pairwise different elevations arrays', () => {
    expect(loaded['twin-peaks'].elevations).not.toEqual(loaded['ridge-gate'].elevations);
    expect(loaded['twin-peaks'].elevations).not.toEqual(loaded.plateau.elevations);
    expect(loaded['ridge-gate'].elevations).not.toEqual(loaded.plateau.elevations);
  });
});

describe('makePreset — determinism and independence', () => {
  it.each(PRESET_NAMES)('%s: two calls are deep-equal but do not share the elevations array', (name) => {
    const first = makePreset(name);
    const second = makePreset(name);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).not.toBe(first);
    expect(second.elevations).not.toBe(first.elevations);
  });

  it.each(PRESET_NAMES)('%s: mutating one result never affects a fresh call', (name) => {
    const snapshot = JSON.stringify(makePreset(name));
    const mutated = makePreset(name);
    mutated.elevations[cellId(0, 0)] = 255;
    mutated.elevations[cellId(63, 63)] = 0;
    mutated.title = 'mutated';
    expect(JSON.stringify(mutated)).not.toBe(snapshot);
    const fresh = makePreset(name);
    expect(JSON.stringify(fresh)).toBe(snapshot);
    expect(() => validateTerrain(fresh)).not.toThrow();
  });
});

describe('makePreset — unknown name', () => {
  it('throws an Error for a name outside the fixed set', () => {
    expect(() => makePreset('volcano' as unknown as PresetName)).toThrow(Error);
    expect(() => makePreset('volcano' as unknown as PresetName)).toThrow(/volcano/);
  });

  it('is case-sensitive: the exact lowercase names are required', () => {
    expect(() => makePreset('TWIN-PEAKS' as unknown as PresetName)).toThrow(/TWIN-PEAKS/);
    expect(() => makePreset('' as unknown as PresetName)).toThrow(Error);
  });
});
