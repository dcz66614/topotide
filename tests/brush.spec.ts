/**
 * T005 tests for the immutable brush rules (PROJECT_BOOK.md §6.3, §9.2;
 * IMPLEMENTATION_PLAN.md P0001-T005).
 *
 * Coverage: exact diamond reach with no out-of-bounds writes (corner brushes),
 * sequential accumulation of repeated centers, raise/lower/set value ranges
 * with clamping at 0 and 255, purity (input object and elevations array never
 * mutated, result is a new object/array), the deep-safe copy for an empty
 * stroke, and rejection of illegal commands (radius, strength, mode,
 * targetHeight, center ids).
 */
import { describe, expect, it } from 'vitest';
import { applyBrush } from '../src/domain/brush';
import { TerrainValidationError } from '../src/domain/validate';
import type { BrushCommand, TerrainV1 } from '../src/domain/types';

function makeTerrain(width: number, height: number, elevations: number[]): TerrainV1 {
  return { schemaVersion: 1, width, height, elevations, title: 't005-brush' };
}

const ZERO_5X5 = (): TerrainV1 => makeTerrain(5, 5, Array<number>(25).fill(0));

function makeCommand(overrides: Partial<BrushCommand> = {}): BrushCommand {
  return { mode: 'raise', radius: 1, strength: 1, targetHeight: 0, centers: [12], ...overrides };
}

/** A command carrying values the BrushCommand type forbids (runtime input). */
function illegalCommand(overrides: Record<string, unknown>): BrushCommand {
  return { ...makeCommand(), ...overrides } as unknown as BrushCommand;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function expectBrushError(cmd: unknown, field: string): TerrainValidationError {
  let caught: unknown;
  try {
    applyBrush(ZERO_5X5(), cmd as BrushCommand);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TerrainValidationError);
  expect(caught).toBeInstanceOf(Error);
  const error = caught as TerrainValidationError;
  expect(error.name).toBe('TerrainValidationError');
  expect(error.code).toBe('INVALID_SCHEMA');
  expect(error.field).toBe(field);
  expect(typeof error.message).toBe('string');
  expect(error.message.length).toBeGreaterThan(0);
  return error;
}

describe('applyBrush — diamond reach', () => {
  it('updates exactly the cells within Manhattan distance <= radius (radius 1)', () => {
    const expected = Array<number>(25).fill(0);
    for (const id of [7, 11, 12, 13, 17]) {
      expected[id] = 16;
    }
    const out = applyBrush(ZERO_5X5(), makeCommand({ mode: 'raise', strength: 16, centers: [12] }));
    expect(out.elevations).toEqual(expected);
  });

  it('updates exactly the diamond cells for radius 2 (13 cells)', () => {
    const expected = Array<number>(25).fill(0);
    for (const id of [2, 6, 7, 8, 10, 11, 12, 13, 14, 16, 17, 18, 22]) {
      expected[id] = 4;
    }
    const out = applyBrush(
      ZERO_5X5(),
      makeCommand({ mode: 'raise', strength: 4, radius: 2, centers: [12] }),
    );
    expect(out.elevations).toEqual(expected);
  });

  it('updates exactly 41 diamond cells for radius 4 on a 9x9 grid', () => {
    const out = applyBrush(
      makeTerrain(9, 9, Array<number>(81).fill(0)),
      makeCommand({ mode: 'raise', strength: 16, radius: 4, centers: [40] }),
    );
    expect(out.elevations.filter((value) => value === 16)).toHaveLength(41);
    expect(out.elevations.filter((value) => value === 0)).toHaveLength(40);
  });

  it('keeps schemaVersion, width, height and title unchanged', () => {
    const out = applyBrush(ZERO_5X5(), makeCommand());
    expect(out.schemaVersion).toBe(1);
    expect(out.width).toBe(5);
    expect(out.height).toBe(5);
    expect(out.title).toBe('t005-brush');
  });
});

describe('applyBrush — corner brushes never go out of bounds', () => {
  it('reaches only the three in-grid cells for a radius-1 corner brush', () => {
    const expected = Array<number>(25).fill(0);
    expected[0] = 16;
    expected[1] = 16;
    expected[5] = 16;
    const out = applyBrush(ZERO_5X5(), makeCommand({ mode: 'raise', strength: 16, centers: [0] }));
    expect(out.elevations).toEqual(expected);
  });

  it('clips a radius-4 corner brush to the grid without leaving it', () => {
    const input = deepFreeze(ZERO_5X5());
    const snapshot = structuredClone(input);
    const out = applyBrush(
      input,
      makeCommand({ mode: 'raise', strength: 16, radius: 4, centers: [0] }),
    );
    // Cells with x + y <= 4: a clipped triangle of 15 cells. The frozen input
    // makes any out-of-bounds or aliased write throw instead of passing.
    expect(out.elevations.filter((value) => value === 16)).toHaveLength(15);
    expect(out.elevations[24]).toBe(0);
    expect(out.elevations).toHaveLength(25);
    expect(Object.isFrozen(input)).toBe(true);
    expect(input).toEqual(snapshot);
  });

  it('clips a radius-4 brush at the last cell symmetrically', () => {
    const out = applyBrush(
      makeTerrain(5, 5, Array<number>(25).fill(16)),
      makeCommand({ mode: 'lower', strength: 16, radius: 4, centers: [24] }),
    );
    // Cells with (4 - x) + (4 - y) <= 4, i.e. x + y >= 4: 15 cells drop to 0.
    expect(out.elevations.filter((value) => value === 0)).toHaveLength(15);
    expect(out.elevations[0]).toBe(16);
  });

  it('clips an off-center brush that hangs over the right edge', () => {
    const out = applyBrush(
      ZERO_5X5(),
      makeCommand({ mode: 'raise', strength: 16, radius: 2, centers: [4] }),
    );
    // Center (4,0): the diamond minus the columns x >= 5 and the rows
    // y < 0 leaves 6 cells.
    expect(out.elevations.filter((value) => value === 16)).toHaveLength(6);
    expect(out.elevations).toHaveLength(25);
  });

  it('updates only the single cell of a 1x1 grid even for radius 4', () => {
    const out = applyBrush(
      makeTerrain(1, 1, [0]),
      makeCommand({ mode: 'raise', strength: 16, radius: 4, centers: [0] }),
    );
    expect(out.elevations).toEqual([16]);
  });
});

describe('applyBrush — sequential centers and accumulation', () => {
  it('applies a repeated center once per occurrence, clamping at the ceiling', () => {
    const out = applyBrush(
      makeTerrain(1, 1, [250]),
      makeCommand({ mode: 'raise', strength: 4, centers: [0, 0, 0, 0, 0] }),
    );
    // 250 + 4 = 254, + 4 -> 255 (clamped), every further pass stays at 255.
    expect(out.elevations).toEqual([255]);
  });

  it('accumulates from zero exactly once per pass', () => {
    const out = applyBrush(
      makeTerrain(1, 1, [0]),
      makeCommand({ mode: 'raise', strength: 16, centers: [0, 0, 0] }),
    );
    expect(out.elevations).toEqual([48]);
  });

  it('accumulates downward, clamping at the floor', () => {
    const out = applyBrush(
      makeTerrain(1, 1, [3]),
      makeCommand({ mode: 'lower', strength: 4, centers: [0, 0, 0] }),
    );
    // 3 - 4 -> 0 (clamped), every further pass stays at 0.
    expect(out.elevations).toEqual([0]);
  });

  it('accumulates on every shared cell of overlapping centers', () => {
    const out = applyBrush(
      makeTerrain(3, 1, [10, 10, 10]),
      makeCommand({ mode: 'raise', strength: 4, radius: 1, centers: [0, 1, 0] }),
    );
    // pass 1 (center 0): [14, 14, 10]; pass 2 (center 1): [18, 18, 14];
    // pass 3 (center 0): [22, 22, 14].
    expect(out.elevations).toEqual([22, 22, 14]);
  });

  it('equals the sequential composition of its single-center strokes', () => {
    const terrain = makeTerrain(5, 5, Array.from({ length: 25 }, (_unused, i) => (i * 11) % 256));
    const cmd = makeCommand({
      mode: 'lower',
      radius: 2,
      strength: 4,
      centers: [12, 7, 17, 12, 0],
    });
    const once = applyBrush(terrain, cmd);
    const folded = cmd.centers.reduce<TerrainV1>(
      (acc, center) =>
        applyBrush(acc, makeCommand({ mode: 'lower', radius: 2, strength: 4, centers: [center] })),
      terrain,
    );
    expect(once.elevations).toEqual(folded.elevations);
  });
});

describe('applyBrush — raise / lower / set value ranges', () => {
  it.each([1, 4, 16] as const)('raise adds exactly strength %i', (strength) => {
    const out = applyBrush(
      makeTerrain(1, 1, [128]),
      makeCommand({ mode: 'raise', strength, centers: [0] }),
    );
    expect(out.elevations).toEqual([128 + strength]);
  });

  it.each([1, 4, 16] as const)('lower subtracts exactly strength %i', (strength) => {
    const out = applyBrush(
      makeTerrain(1, 1, [128]),
      makeCommand({ mode: 'lower', strength, centers: [0] }),
    );
    expect(out.elevations).toEqual([128 - strength]);
  });

  it('clamps raise at 255 and never exceeds it', () => {
    expect(
      applyBrush(
        makeTerrain(1, 1, [255]),
        makeCommand({ mode: 'raise', strength: 16, centers: [0] }),
      ).elevations,
    ).toEqual([255]);
    expect(
      applyBrush(
        makeTerrain(1, 1, [254]),
        makeCommand({ mode: 'raise', strength: 4, centers: [0] }),
      ).elevations,
    ).toEqual([255]);
  });

  it('clamps lower at 0 and never goes below it', () => {
    expect(
      applyBrush(
        makeTerrain(1, 1, [0]),
        makeCommand({ mode: 'lower', strength: 16, centers: [0] }),
      ).elevations,
    ).toEqual([0]);
    expect(
      applyBrush(
        makeTerrain(1, 1, [1]),
        makeCommand({ mode: 'lower', strength: 4, centers: [0] }),
      ).elevations,
    ).toEqual([0]);
  });

  it('set assigns targetHeight exactly, whatever the current value is', () => {
    expect(
      applyBrush(
        makeTerrain(1, 1, [0]),
        makeCommand({ mode: 'set', targetHeight: 200, centers: [0] }),
      ).elevations,
    ).toEqual([200]);
    expect(
      applyBrush(
        makeTerrain(1, 1, [255]),
        makeCommand({ mode: 'set', targetHeight: 200, centers: [0] }),
      ).elevations,
    ).toEqual([200]);
  });

  it('accepts the boundary target heights 0 and 255 for set', () => {
    expect(
      applyBrush(
        makeTerrain(1, 1, [9]),
        makeCommand({ mode: 'set', targetHeight: 0, centers: [0] }),
      ).elevations,
    ).toEqual([0]);
    expect(
      applyBrush(
        makeTerrain(1, 1, [9]),
        makeCommand({ mode: 'set', targetHeight: 255, centers: [0] }),
      ).elevations,
    ).toEqual([255]);
  });

  it('ignores targetHeight for raise and lower (it is only used by set)', () => {
    expect(
      applyBrush(
        makeTerrain(1, 1, [128]),
        makeCommand({ mode: 'raise', strength: 1, targetHeight: -1, centers: [0] }),
      ).elevations,
    ).toEqual([129]);
    expect(
      applyBrush(
        makeTerrain(1, 1, [128]),
        makeCommand({ mode: 'lower', strength: 1, targetHeight: 999, centers: [0] }),
      ).elevations,
    ).toEqual([127]);
  });
});

describe('applyBrush — value range invariant', () => {
  it('keeps every elevation an integer in [0, 255] for all mode/radius/strength combinations', () => {
    const edgeValues = Array.from({ length: 25 }, (_unused, i) => [0, 255, 128, 1, 254][i % 5]);
    for (const mode of ['raise', 'lower', 'set'] as const) {
      for (const radius of [1, 2, 4] as const) {
        for (const strength of [1, 4, 16] as const) {
          const cmd = makeCommand({ mode, radius, strength, targetHeight: 200, centers: [0, 7, 12, 17, 24] });
          const out = applyBrush(makeTerrain(5, 5, [...edgeValues]), cmd);
          for (const value of out.elevations) {
            expect(Number.isInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(255);
          }
        }
      }
    }
  });

  it('accepts every legal radius and strength combination', () => {
    for (const radius of [1, 2, 4] as const) {
      for (const strength of [1, 4, 16] as const) {
        const out = applyBrush(ZERO_5X5(), makeCommand({ radius, strength, centers: [12] }));
        expect(out.elevations[12]).toBe(strength);
      }
    }
  });
});

describe('applyBrush — immutability', () => {
  it('never mutates the input object or its elevations array', () => {
    const input = deepFreeze(
      makeTerrain(5, 5, Array.from({ length: 25 }, (_unused, i) => (i * 7) % 256)),
    );
    const snapshot = structuredClone(input);
    // Five radius-4 centers cover the whole grid; 'set' is the strongest
    // possible write, and the frozen input makes any mutation throw.
    const out = applyBrush(
      input,
      makeCommand({ mode: 'set', targetHeight: 3, radius: 4, centers: [0, 6, 12, 18, 24] }),
    );
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.elevations)).toBe(true);
    expect(input).toEqual(snapshot);
    expect(out.elevations).toEqual(Array<number>(25).fill(3));
  });

  it('returns a new object and a new elevations array, independent of the input', () => {
    const input = makeTerrain(3, 2, [0, 255, 128, 1, 254, 7]);
    const out = applyBrush(input, makeCommand({ mode: 'raise', strength: 16, centers: [0] }));
    expect(out).not.toBe(input);
    expect(out.elevations).not.toBe(input.elevations);
    out.elevations[0] = 999;
    expect(input.elevations).toEqual([0, 255, 128, 1, 254, 7]);
  });
});

describe('applyBrush — empty centers', () => {
  it('returns equal values but a new object and a new elevations array', () => {
    const input = makeTerrain(3, 2, [0, 255, 128, 1, 254, 7]);
    const out = applyBrush(
      input,
      makeCommand({ mode: 'set', targetHeight: 0, radius: 4, strength: 16, centers: [] }),
    );
    expect(out).not.toBe(input);
    expect(out.elevations).not.toBe(input.elevations);
    expect(out).toEqual(input);
    expect(out.elevations).toEqual([0, 255, 128, 1, 254, 7]);
    out.elevations[0] = 999;
    expect(input.elevations[0]).toBe(0);
  });

  it('still validates the command when centers is empty', () => {
    expectBrushError(illegalCommand({ centers: [], radius: 3 }), 'radius');
    expectBrushError(illegalCommand({ centers: [], strength: 2 }), 'strength');
  });
});

describe('applyBrush — rejected commands', () => {
  const illegalRadii = [0, 3, 5, -1, -4, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined];

  it.each(illegalRadii)('rejects illegal radius %p', (value) => {
    expectBrushError(illegalCommand({ radius: value }), 'radius');
  });

  const illegalStrengths = [0, 2, 3, 8, 17, 32, 64, -4, 0.5, Number.NaN, '16', null];

  it.each(illegalStrengths)('rejects illegal strength %p', (value) => {
    expectBrushError(illegalCommand({ strength: value }), 'strength');
  });

  const illegalModes = ['smooth', 'RAISE', '', 'flatten', 'raise ', 42, 0, null, undefined];

  it.each(illegalModes)('rejects illegal mode %p', (value) => {
    expectBrushError(illegalCommand({ mode: value }), 'mode');
  });

  const illegalTargetHeights = [-1, 256, -0.5, 255.5, Number.NaN, Number.POSITIVE_INFINITY, '100', null];

  it.each(illegalTargetHeights)('rejects out-of-range targetHeight %p for set', (value) => {
    expectBrushError(illegalCommand({ mode: 'set', targetHeight: value }), 'targetHeight');
  });

  it('rejects an out-of-range center id above the grid size', () => {
    const error = expectBrushError(illegalCommand({ centers: [25] }), 'centers');
    expect(error.message).toContain('centers[0]');
  });

  it('rejects a negative or fractional center id', () => {
    expectBrushError(illegalCommand({ centers: [-1] }), 'centers');
    expectBrushError(illegalCommand({ centers: [2.5] }), 'centers');
    expectBrushError(illegalCommand({ centers: [Number.NaN] }), 'centers');
  });

  it('names the exact index of the first illegal center', () => {
    const error = expectBrushError(illegalCommand({ centers: [12, 30] }), 'centers');
    expect(error.message).toContain('centers[1]');
  });

  it('rejects centers that is not an array', () => {
    expectBrushError(illegalCommand({ centers: '012' }), 'centers');
    expectBrushError(illegalCommand({ centers: 42 }), 'centers');
    expectBrushError(illegalCommand({ centers: null }), 'centers');
    expectBrushError(illegalCommand({ centers: undefined }), 'centers');
  });

  it('rejects a command that is not an object', () => {
    expectBrushError(null, 'cmd');
    expectBrushError(undefined, 'cmd');
    expectBrushError(42, 'cmd');
    expectBrushError('brush', 'cmd');
  });

  it('rejects an illegal command without mutating the input', () => {
    const input = deepFreeze(ZERO_5X5());
    const snapshot = structuredClone(input);
    expect(() => applyBrush(input, illegalCommand({ radius: 3 }))).toThrow(
      TerrainValidationError,
    );
    expect(input).toEqual(snapshot);
  });
});
