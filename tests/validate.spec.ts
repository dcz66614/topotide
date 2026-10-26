import { describe, expect, it } from 'vitest';
import { TerrainValidationError, validateTerrain } from '../src/domain/validate';
import type { TerrainErrorCode } from '../src/domain/validate';
import type {
  BrushCommand,
  BrushMode,
  CellId,
  MergeEvent,
  PeakMeta,
  PersistencePair,
  PersistenceResult,
  TerrainV1,
} from '../src/domain/types';

const SIZE_LIMIT_BYTES = 250 * 1024;

/** Base fixture: the S-STRIP golden sample from PROJECT_BOOK.md §10.1. */
function makeTerrain(overrides: Record<string, unknown> = {}): TerrainV1 {
  return {
    schemaVersion: 1,
    width: 5,
    height: 1,
    elevations: [5, 1, 4, 1, 3],
    title: 'S-STRIP',
    ...overrides,
  } as TerrainV1;
}

function withoutField(key: keyof TerrainV1): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...makeTerrain() };
  delete clone[key];
  return clone;
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

interface ErrorCase {
  readonly name: string;
  readonly input: unknown;
  readonly code: TerrainErrorCode;
  readonly field: string;
}

function expectTerrainError(
  input: unknown,
  code: TerrainErrorCode,
  field: string,
): TerrainValidationError {
  let caught: unknown;
  try {
    validateTerrain(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TerrainValidationError);
  expect(caught).toBeInstanceOf(Error);
  const error = caught as TerrainValidationError;
  expect(error.code).toBe(code);
  expect(error.field).toBe(field);
  expect(typeof error.message).toBe('string');
  expect(error.message.length).toBeGreaterThan(0);
  return error;
}

describe('validateTerrain — valid input', () => {
  it('accepts the S-STRIP sample and returns an equal, independent copy', () => {
    const input = makeTerrain();
    const out = validateTerrain(input);
    expect(out).not.toBe(input);
    expect(out).toEqual(input);
    expect(out.elevations).not.toBe(input.elevations);
    expect(Array.isArray(out.elevations)).toBe(true);

    out.elevations[0] = 255;
    expect(input.elevations).toEqual([5, 1, 4, 1, 3]);
    input.elevations[1] = 250;
    expect(out.elevations[1]).toBe(1);
  });

  it('returns elevations in the exact input order without sorting or clamping', () => {
    const input = makeTerrain({ width: 2, height: 2, elevations: [255, 0, 200, 3], title: 'order' });
    const out = validateTerrain(input);
    expect(out.elevations).toEqual([255, 0, 200, 3]);
  });

  it('accepts a 1x1 terrain', () => {
    const out = validateTerrain({
      schemaVersion: 1,
      width: 1,
      height: 1,
      elevations: [0],
      title: 'a',
    });
    expect(out.elevations).toEqual([0]);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
  });

  it('accepts a 128x128 terrain filled with a constant', () => {
    const input = {
      schemaVersion: 1,
      width: 128,
      height: 128,
      elevations: Array<number>(128 * 128).fill(7),
      title: 'big',
    };
    const out = validateTerrain(input);
    expect(out.width).toBe(128);
    expect(out.height).toBe(128);
    expect(out.elevations).toHaveLength(128 * 128);
    expect(new Set(out.elevations).size).toBe(1);
  });

  it('accepts every elevation value 0..255', () => {
    const values = Array.from({ length: 256 }, (_unused, index) => index);
    const out = validateTerrain({
      schemaVersion: 1,
      width: 16,
      height: 16,
      elevations: values,
      title: 'range',
    });
    expect(out.elevations).toEqual(values);
  });

  it('accepts a 1-character and an 80-character title', () => {
    expect(validateTerrain(makeTerrain({ title: 'a' })).title).toBe('a');
    expect(validateTerrain(makeTerrain({ title: 'x'.repeat(80) })).title).toHaveLength(80);
  });

  it('counts Unicode code points, not UTF-16 units, for the title', () => {
    // 80 astral code points = 160 UTF-16 units, still within the 80 limit.
    const waves = '🌊'.repeat(80);
    expect(waves.length).toBe(160);
    expect(validateTerrain(makeTerrain({ title: waves })).title).toBe(waves);
  });
});

describe('validateTerrain — invalid schema', () => {
  const cases: readonly ErrorCase[] = [
    { name: 'unknown schemaVersion 2', input: makeTerrain({ schemaVersion: 2 }), code: 'INVALID_SCHEMA', field: 'schemaVersion' },
    { name: 'string schemaVersion "1"', input: makeTerrain({ schemaVersion: '1' }), code: 'INVALID_SCHEMA', field: 'schemaVersion' },
    { name: 'missing schemaVersion', input: withoutField('schemaVersion'), code: 'INVALID_SCHEMA', field: 'schemaVersion' },
    { name: 'missing width', input: withoutField('width'), code: 'INVALID_SCHEMA', field: 'width' },
    { name: 'missing elevations', input: withoutField('elevations'), code: 'INVALID_SCHEMA', field: 'elevations' },
    { name: 'missing title', input: withoutField('title'), code: 'INVALID_SCHEMA', field: 'title' },
    { name: 'extra unexpected field', input: { ...makeTerrain(), bonus: true }, code: 'INVALID_SCHEMA', field: 'bonus' },
    { name: 'null input', input: null, code: 'INVALID_SCHEMA', field: 'input' },
    { name: 'array input', input: [5, 1, 4, 1, 3], code: 'INVALID_SCHEMA', field: 'input' },
    { name: 'string-number input', input: '5', code: 'INVALID_SCHEMA', field: 'input' },
    { name: 'number input', input: 42, code: 'INVALID_SCHEMA', field: 'input' },
    { name: 'JSON text input (validateTerrain does not parse strings)', input: JSON.stringify(makeTerrain()), code: 'INVALID_SCHEMA', field: 'input' },
    { name: 'empty title', input: makeTerrain({ title: '' }), code: 'INVALID_SCHEMA', field: 'title' },
    { name: '81-character title', input: makeTerrain({ title: 'x'.repeat(81) }), code: 'INVALID_SCHEMA', field: 'title' },
    { name: '81-code-point astral title', input: makeTerrain({ title: '🌊'.repeat(81) }), code: 'INVALID_SCHEMA', field: 'title' },
    { name: 'non-string title', input: makeTerrain({ title: 42 }), code: 'INVALID_SCHEMA', field: 'title' },
    { name: 'null title', input: makeTerrain({ title: null }), code: 'INVALID_SCHEMA', field: 'title' },
  ];

  it.each(cases)('rejects $name', ({ input, code, field }) => {
    expectTerrainError(input, code, field);
  });
});

describe('validateTerrain — invalid dimensions', () => {
  const cases: readonly ErrorCase[] = [
    { name: 'width 0', input: makeTerrain({ width: 0 }), code: 'INVALID_DIMENSIONS', field: 'width' },
    { name: 'width 129', input: makeTerrain({ width: 129 }), code: 'INVALID_DIMENSIONS', field: 'width' },
    { name: 'fractional width 1.5', input: makeTerrain({ width: 1.5 }), code: 'INVALID_DIMENSIONS', field: 'width' },
    { name: 'negative width', input: makeTerrain({ width: -1 }), code: 'INVALID_DIMENSIONS', field: 'width' },
    { name: 'string width', input: makeTerrain({ width: '5' }), code: 'INVALID_DIMENSIONS', field: 'width' },
    { name: 'NaN width', input: makeTerrain({ width: Number.NaN }), code: 'INVALID_DIMENSIONS', field: 'width' },
    { name: 'height 0', input: makeTerrain({ height: 0 }), code: 'INVALID_DIMENSIONS', field: 'height' },
    { name: 'height 129', input: makeTerrain({ height: 129 }), code: 'INVALID_DIMENSIONS', field: 'height' },
    { name: 'fractional height 1.5', input: makeTerrain({ height: 1.5 }), code: 'INVALID_DIMENSIONS', field: 'height' },
  ];

  it.each(cases)('rejects $name', ({ input, code, field }) => {
    expectTerrainError(input, code, field);
  });
});

describe('validateTerrain — invalid heights', () => {
  const cases: readonly ErrorCase[] = [
    { name: 'short elevations array', input: makeTerrain({ elevations: [5, 1, 4] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'long elevations array', input: makeTerrain({ elevations: [5, 1, 4, 1, 3, 9] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'empty elevations array on 1x1', input: makeTerrain({ width: 1, height: 1, elevations: [] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'elevation 256', input: makeTerrain({ elevations: [5, 1, 256, 1, 3] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'negative elevation', input: makeTerrain({ elevations: [5, -1, 4, 1, 3] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'fractional elevation 1.5', input: makeTerrain({ elevations: [5, 1.5, 4, 1, 3] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'NaN elevation', input: makeTerrain({ elevations: [Number.NaN, 1, 4, 1, 3] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'Infinity elevation', input: makeTerrain({ elevations: [Number.POSITIVE_INFINITY, 1, 4, 1, 3] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'string elevation', input: makeTerrain({ elevations: ['5', 1, 4, 1, 3] }), code: 'INVALID_HEIGHTS', field: 'elevations' },
    { name: 'elevations not an array', input: makeTerrain({ elevations: '51413' }), code: 'INVALID_HEIGHTS', field: 'elevations' },
  ];

  it.each(cases)('rejects $name', ({ input, code, field }) => {
    expectTerrainError(input, code, field);
  });
});

describe('validateTerrain — size limit (250 KiB, UTF-8 bytes)', () => {
  it('rejects a raw JSON text string over 250 KiB with FILE_TOO_LARGE and no content echo', () => {
    const payload = 'SECRET_MARKER' + 'x'.repeat(SIZE_LIMIT_BYTES);
    expect(payload.length).toBeGreaterThan(SIZE_LIMIT_BYTES);
    const error = expectTerrainError(payload, 'FILE_TOO_LARGE', 'input');
    expect(error.message).not.toContain('SECRET_MARKER');
    expect(error.message).not.toContain(payload.slice(0, 32));
  });

  it('accepts a string of exactly 250 KiB as a non-object (limit is strictly exceeded)', () => {
    expectTerrainError('x'.repeat(SIZE_LIMIT_BYTES), 'INVALID_SCHEMA', 'input');
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // 'é' is 1 UTF-16 unit but 2 UTF-8 bytes: 128000 units = exactly 256000 bytes.
    expectTerrainError('é'.repeat(SIZE_LIMIT_BYTES / 2), 'INVALID_SCHEMA', 'input');
    expectTerrainError('é'.repeat(SIZE_LIMIT_BYTES / 2 + 1), 'FILE_TOO_LARGE', 'input');
  });

  it('rejects object input whose JSON serialization exceeds 250 KiB', () => {
    const big = {
      schemaVersion: 1,
      width: 1,
      height: 1,
      elevations: Array<number>(200000).fill(1),
      title: 'x',
    };
    expect(JSON.stringify(big).length).toBeGreaterThan(SIZE_LIMIT_BYTES);
    expectTerrainError(big, 'FILE_TOO_LARGE', 'input');
  });
});

describe('validateTerrain — purity', () => {
  it('does not mutate a deep-frozen input', () => {
    const input = deepFreeze(makeTerrain({ width: 2, height: 2, elevations: [9, 0, 8, 7] }));
    const snapshot = structuredClone(input);
    const out = validateTerrain(input);
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.elevations)).toBe(true);
    expect(out).not.toBe(input);
    expect(out).toEqual(snapshot);
    expect(input).toEqual(snapshot);
  });
});

describe('error contract', () => {
  it('throws a TerrainValidationError that is a real Error with code, message and field', () => {
    const error = expectTerrainError(
      makeTerrain({ schemaVersion: 2 }),
      'INVALID_SCHEMA',
      'schemaVersion',
    );
    expect(error.name).toBe('TerrainValidationError');
    expect(String(error)).toContain('TerrainValidationError');
  });

  it('exports the contract types with the exact fields from PROJECT_BOOK.md §9.1', () => {
    const peakCell: CellId = 2;
    const meta: PeakMeta = { peakCell, birth: 4 };
    const finite: PersistencePair = {
      id: `peak-${peakCell}`,
      peakCell,
      birth: 4,
      death: 1,
      persistence: 3,
      winnerPeakCell: 0,
      witnessCell: 1,
    };
    const essential: PersistencePair = {
      id: 'peak-0',
      peakCell: 0,
      birth: 5,
      death: null,
      persistence: null,
      winnerPeakCell: null,
      witnessCell: null,
    };
    const merge: MergeEvent = {
      id: finite.id,
      level: 1,
      winnerPeakCell: 0,
      loserPeakCell: 2,
      witnessCell: 1,
    };
    const result: PersistenceResult = {
      pairs: [essential, finite],
      merges: [merge],
      beta0ByLevel: Array<number>(256).fill(0),
      maxHeight: 5,
      minHeight: 1,
    };
    const mode: BrushMode = 'raise';
    const command: BrushCommand = {
      mode,
      radius: 2,
      strength: 4,
      targetHeight: 9,
      centers: [0, 1, 2],
    };
    expect(finite.id).toBe('peak-2');
    expect(meta.peakCell).toBe(2);
    expect(essential.death).toBeNull();
    expect(essential.persistence).toBeNull();
    expect(result.beta0ByLevel).toHaveLength(256);
    expect(command.mode).toBe('raise');
  });
});
