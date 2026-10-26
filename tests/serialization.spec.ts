/**
 * T007 tests: JSON export/import, pairs CSV export, tau filtering and summary
 * statistics (PROJECT_BOOK.md §9.2, §10.1, §10.6; IMPLEMENTATION_PLAN.md P0001-T007).
 *
 * The CSV snapshot below was cross-checked against the real analyzePersistence()
 * output for the S-STRIP golden sample before being hard-coded: essential
 * (peakCell 0, birth 5), finite (peakCell 2, birth 4, death 1, persistence 3,
 * witnessCell 1) and finite (peakCell 4, birth 3, death 1, persistence 2,
 * witnessCell 3) — exactly PROJECT_BOOK.md §10.1.
 */
import { describe, expect, it } from 'vitest';
import { analyzePersistence } from '../src/domain/persistence';
import { makePreset } from '../src/domain/presets';
import { exportPairsCsv, exportTerrainJson, importTerrainJson } from '../src/domain/serialization';
import { summarize, visiblePairs } from '../src/domain/summarize';
import { TerrainValidationError, validateTerrain } from '../src/domain/validate';
import type { PersistencePair, PersistenceResult, TerrainV1 } from '../src/domain/types';

const SIZE_LIMIT_BYTES = 250 * 1024;

/** The S-STRIP golden sample from PROJECT_BOOK.md §10.1. */
const S_STRIP: TerrainV1 = {
  schemaVersion: 1,
  width: 5,
  height: 1,
  elevations: [5, 1, 4, 1, 3],
  title: 'S-STRIP',
};

const CSV_HEADER = 'type,peak_x,peak_y,birth,death,persistence,witness_x,witness_y,essential';

/** The exact §10.6 export for the S-STRIP analysis (trailing LF included). */
const S_STRIP_CSV_SNAPSHOT = [
  CSV_HEADER,
  'essential,0,0,5,,,,,true',
  'finite,2,0,4,1,3,1,0,false',
  'finite,4,0,3,1,2,3,0,false',
  '',
].join('\n');

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Calls importTerrainJson and returns the caught TerrainValidationError. */
function expectImportError(text: string, code: string): TerrainValidationError {
  let caught: unknown;
  try {
    importTerrainJson(text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TerrainValidationError);
  const error = caught as TerrainValidationError;
  expect(error.code).toBe(code);
  return error;
}

/** The code validateTerrain() assigns to an already-parsed value. */
function referenceValidateCode(value: unknown): string {
  try {
    validateTerrain(value);
    return 'accepted';
  } catch (error) {
    return (error as TerrainValidationError).code;
  }
}

function finitePair(
  peakCell: number,
  persistence: number,
  witnessCell: number,
  birth = 10,
  death = 1,
): PersistencePair {
  return {
    id: `peak-${peakCell}`,
    peakCell,
    birth,
    death,
    persistence,
    winnerPeakCell: 0,
    witnessCell,
  };
}

function essentialPair(peakCell = 0, birth = 12): PersistencePair {
  return {
    id: `peak-${peakCell}`,
    peakCell,
    birth,
    death: null,
    persistence: null,
    winnerPeakCell: null,
    witnessCell: null,
  };
}

function makeResult(pairs: PersistencePair[]): PersistenceResult {
  return {
    pairs,
    merges: [],
    beta0ByLevel: Array<number>(256).fill(0),
    maxHeight: 12,
    minHeight: 0,
  };
}

/** "x,y" of a row-major cell id; fails loudly on a contract-violating null. */
function cellCoord(cell: number | null, width: number): string {
  if (cell === null) {
    throw new Error('expected a non-null cell id');
  }
  return `${cell % width},${Math.floor(cell / width)}`;
}

describe('exportTerrainJson — fixed key order and trailing LF', () => {
  it('exports S-STRIP byte-exactly: schemaVersion,width,height,elevations,title + LF', () => {
    const json = exportTerrainJson(S_STRIP);
    expect(json).toBe(
      '{"schemaVersion":1,"width":5,"height":1,"elevations":[5,1,4,1,3],"title":"S-STRIP"}\n',
    );
    expect(json.endsWith('\n')).toBe(true);
    expect(json.endsWith('\n\n')).toBe(false);
    expect(json.includes('\r')).toBe(false);
  });

  it('emits exactly the key order schemaVersion,width,height,elevations,title', () => {
    const keys = Object.keys(JSON.parse(exportTerrainJson(S_STRIP)) as Record<string, unknown>);
    expect(keys).toEqual(['schemaVersion', 'width', 'height', 'elevations', 'title']);
  });

  it('normalizes a scrambled input key order to the same output', () => {
    const scrambled = {
      title: S_STRIP.title,
      elevations: [...S_STRIP.elevations],
      height: S_STRIP.height,
      width: S_STRIP.width,
      schemaVersion: S_STRIP.schemaVersion,
    } as unknown as TerrainV1;
    expect(exportTerrainJson(scrambled)).toBe(exportTerrainJson(S_STRIP));
  });

  it('validates before exporting: invalid terrain never produces output', () => {
    const extraField = { ...S_STRIP, extra: true } as unknown as TerrainV1;
    let caught: unknown;
    try {
      exportTerrainJson(extraField);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TerrainValidationError);
    expect((caught as TerrainValidationError).code).toBe('INVALID_SCHEMA');

    const shortHeights: TerrainV1 = { ...S_STRIP, elevations: [5, 1, 4, 1] };
    try {
      exportTerrainJson(shortHeights);
      expect.unreachable('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(TerrainValidationError);
      expect((error as TerrainValidationError).code).toBe('INVALID_HEIGHTS');
    }
  });

  it('does not mutate a frozen input terrain', () => {
    const input = deepFreeze({
      schemaVersion: 1,
      width: 2,
      height: 2,
      elevations: [9, 0, 8, 7],
      title: 'frozen',
    } satisfies TerrainV1);
    const snapshot = structuredClone(input);
    expect(exportTerrainJson(input)).toContain('"elevations":[9,0,8,7]');
    expect(input).toEqual(snapshot);
  });
});

describe('JSON roundtrip', () => {
  it('import(export(S-STRIP)) is deep-equal to the original terrain', () => {
    const exported = exportTerrainJson(S_STRIP);
    const back = importTerrainJson(exported);
    expect(back).not.toBe(S_STRIP);
    expect(back.elevations).not.toBe(S_STRIP.elevations);
    expect(back).toEqual(S_STRIP);
  });

  it('re-exporting a roundtripped terrain is byte-identical', () => {
    const once = exportTerrainJson(S_STRIP);
    expect(exportTerrainJson(importTerrainJson(once))).toBe(once);
  });

  it('roundtrips every preset terrain deep-equal', () => {
    const names = ['twin-peaks', 'ridge-gate', 'plateau'] as const;
    for (const name of names) {
      const preset = makePreset(name);
      const back = importTerrainJson(exportTerrainJson(preset));
      expect(back).toEqual(preset);
      expect(exportTerrainJson(back)).toBe(exportTerrainJson(preset));
    }
  });

  it('roundtrips a non-ASCII title without escaping damage', () => {
    const terrain: TerrainV1 = {
      schemaVersion: 1,
      width: 2,
      height: 1,
      elevations: [7, 3],
      title: '潮汐🌊 Tide',
    };
    expect(importTerrainJson(exportTerrainJson(terrain))).toEqual(terrain);
  });

  it('the imported terrain is an independent copy', () => {
    const back = importTerrainJson(JSON.stringify(S_STRIP));
    back.elevations[0] = 255;
    expect(S_STRIP.elevations[0]).toBe(5);
    expect(back.elevations).toEqual([255, 1, 4, 1, 3]);
  });
});

describe('importTerrainJson — size guard before parsing (250 KiB UTF-8 bytes)', () => {
  it('rejects oversized text with FILE_TOO_LARGE even when it is also unparseable', () => {
    // Over the limit AND invalid JSON: a FILE_TOO_LARGE result proves the size
    // guard ran before JSON.parse (a parse-first order would give INVALID_SCHEMA).
    const marker = 'SECRET_OVERSIZE_MARKER';
    const oversized = `{"title":"${marker}"${'x'.repeat(SIZE_LIMIT_BYTES)}`;
    expect(oversized.length).toBeGreaterThan(SIZE_LIMIT_BYTES);
    const error = expectImportError(oversized, 'FILE_TOO_LARGE');
    expect(error.field).toBe('input');
    expect(error.message).not.toContain(marker);
  });

  it('rejects plain oversized text with FILE_TOO_LARGE and no content echo', () => {
    const payload = `SECRET_MARKER${'x'.repeat(SIZE_LIMIT_BYTES)}`;
    expect(payload.length).toBeGreaterThan(SIZE_LIMIT_BYTES);
    const error = expectImportError(payload, 'FILE_TOO_LARGE');
    expect(error.message).not.toContain('SECRET_MARKER');
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // 'é' is 1 UTF-16 unit but 2 UTF-8 bytes: 128001 units = 256002 bytes.
    const over = 'é'.repeat(SIZE_LIMIT_BYTES / 2 + 1);
    expect(over.length).toBeLessThan(SIZE_LIMIT_BYTES);
    expectImportError(over, 'FILE_TOO_LARGE');
    // Exactly 256000 UTF-8 bytes is not over the limit: it reaches the parser.
    expectImportError('é'.repeat(SIZE_LIMIT_BYTES / 2), 'INVALID_SCHEMA');
  });

  it('still parses a valid-shaped document just under the limit', () => {
    const base = JSON.stringify({ ...S_STRIP, pad: '' });
    const padded = JSON.stringify({
      ...S_STRIP,
      pad: 'p'.repeat(Math.max(0, SIZE_LIMIT_BYTES - base.length)),
    });
    expect(new TextEncoder().encode(padded).length).toBeLessThanOrEqual(SIZE_LIMIT_BYTES);
    // Fails on the unexpected field, which proves parsing happened.
    expectImportError(padded, 'INVALID_SCHEMA');
  });
});

describe('importTerrainJson — malformed JSON', () => {
  const malformedTexts: readonly string[] = [
    '',
    '   ',
    'not json',
    'undefined',
    '{',
    '{"schemaVersion":1,}',
    '{"schemaVersion":1,SECRET_MARKER}',
    '[1, 2',
  ];

  it.each(malformedTexts.map((text) => ({ text })))(
    'rejects malformed JSON with INVALID_SCHEMA: $text',
    ({ text }) => {
      let caught: unknown;
      try {
        importTerrainJson(text);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TerrainValidationError);
      const error = caught as TerrainValidationError;
      expect(error.code).toBe('INVALID_SCHEMA');
      expect(error.message).not.toContain('SECRET_MARKER');
    },
  );

  it('classifies parsed non-objects as INVALID_SCHEMA too', () => {
    expectImportError('null', 'INVALID_SCHEMA');
    expectImportError('[]', 'INVALID_SCHEMA');
    expectImportError('"S-STRIP"', 'INVALID_SCHEMA');
    expectImportError('42', 'INVALID_SCHEMA');
  });
});

describe('importTerrainJson — same codes as validateTerrain', () => {
  const cases: readonly { readonly name: string; readonly text: string }[] = [
    { name: 'unexpected extra field', text: JSON.stringify({ ...S_STRIP, extra: 1 }) },
    {
      name: 'missing title (wrong field set)',
      text: JSON.stringify({ schemaVersion: 1, width: 5, height: 1, elevations: [5, 1, 4, 1, 3] }),
    },
    { name: 'wrong schemaVersion', text: JSON.stringify({ ...S_STRIP, schemaVersion: 2 }) },
    { name: 'string schemaVersion', text: JSON.stringify({ ...S_STRIP, schemaVersion: '1' }) },
    { name: 'width 0', text: JSON.stringify({ ...S_STRIP, width: 0 }) },
    { name: 'width 129', text: JSON.stringify({ ...S_STRIP, width: 129 }) },
    { name: 'fractional width', text: JSON.stringify({ ...S_STRIP, width: 2.5 }) },
    { name: 'height 0', text: JSON.stringify({ ...S_STRIP, height: 0 }) },
    {
      name: 'elevations length mismatch',
      text: JSON.stringify({ ...S_STRIP, elevations: [5, 1, 4, 1] }),
    },
    { name: 'elevation 256', text: JSON.stringify({ ...S_STRIP, elevations: [5, 1, 4, 1, 256] }) },
    { name: 'negative elevation', text: JSON.stringify({ ...S_STRIP, elevations: [5, -1, 4, 1, 3] }) },
    { name: 'fractional elevation', text: JSON.stringify({ ...S_STRIP, elevations: [5, 1.5, 4, 1, 3] }) },
    { name: 'empty title', text: JSON.stringify({ ...S_STRIP, title: '' }) },
  ];

  it.each(cases)('rejects $name with the code validateTerrain uses', ({ text }) => {
    const parsed: unknown = JSON.parse(text);
    const reference = referenceValidateCode(parsed);
    expect(reference).not.toBe('accepted');
    expectImportError(text, reference);
  });

  it('keeps the concrete codes for field set, version, dimensions and heights', () => {
    expectImportError(JSON.stringify({ ...S_STRIP, extra: 1 }), 'INVALID_SCHEMA');
    expectImportError(JSON.stringify({ ...S_STRIP, schemaVersion: 2 }), 'INVALID_SCHEMA');
    expectImportError(JSON.stringify({ ...S_STRIP, width: 0 }), 'INVALID_DIMENSIONS');
    expectImportError(JSON.stringify({ ...S_STRIP, height: 129 }), 'INVALID_DIMENSIONS');
    expectImportError(JSON.stringify({ ...S_STRIP, elevations: [5, 1, 4, 1] }), 'INVALID_HEIGHTS');
    expectImportError(JSON.stringify({ ...S_STRIP, elevations: [5, 1, 4, 1, 999] }), 'INVALID_HEIGHTS');
  });
});

describe('exportPairsCsv — S-STRIP golden snapshot', () => {
  const sStripResult = analyzePersistence(S_STRIP);

  it('matches the PROJECT_BOOK.md §10.6 export byte for byte', () => {
    expect(exportPairsCsv(sStripResult, S_STRIP.width)).toBe(S_STRIP_CSV_SNAPSHOT);
  });

  it('snapshot rows agree with the live analyzePersistence() pairs', () => {
    // Independent cross-check so a fudged snapshot cannot hide a real change.
    const lines = exportPairsCsv(sStripResult, S_STRIP.width).split('\n');
    expect(lines).toHaveLength(5); // header + 3 rows + empty entry after the trailing LF
    expect(lines[4]).toBe('');
    const [essential, first, second] = sStripResult.pairs;
    expect(sStripResult.pairs).toHaveLength(3);
    expect(essential.death).toBeNull();
    expect(lines[1]).toBe(
      `essential,${cellCoord(essential.peakCell, 5)},${essential.birth},,,,,true`,
    );
    expect(first.peakCell).toBe(2);
    expect(first.witnessCell).toBe(1);
    expect(lines[2]).toBe(
      `finite,${cellCoord(first.peakCell, 5)},${first.birth},` +
        `${first.death},${first.persistence},${cellCoord(first.witnessCell, 5)},false`,
    );
    expect(second.peakCell).toBe(4);
    expect(second.witnessCell).toBe(3);
    expect(lines[3]).toBe(
      `finite,${cellCoord(second.peakCell, 5)},${second.birth},` +
        `${second.death},${second.persistence},${cellCoord(second.witnessCell, 5)},false`,
    );
  });

  it('uses LF line endings with exactly one trailing LF and no CR', () => {
    const csv = exportPairsCsv(sStripResult, S_STRIP.width);
    expect(csv.endsWith('\n')).toBe(true);
    expect(csv.includes('\r')).toBe(false);
  });

  it('maps row-major ids to y != 0 (S-DIAGONAL, verified against analyzePersistence)', () => {
    // analyzePersistence gives: finite peakCell 3 (x=1,y=1), birth 8, death 0,
    // persistence 8, witnessCell 1 (x=1,y=0); essential peakCell 0.
    const diagonal: TerrainV1 = {
      schemaVersion: 1,
      width: 2,
      height: 2,
      elevations: [9, 0, 0, 8],
      title: 'S-DIAGONAL',
    };
    const result = analyzePersistence(diagonal);
    expect(result.pairs[1]).toMatchObject({
      peakCell: 3,
      birth: 8,
      death: 0,
      persistence: 8,
      witnessCell: 1,
    });
    expect(exportPairsCsv(result, 2).split('\n')[2]).toBe('finite,1,1,8,0,8,1,0,false');
  });

  it('emits only fixed literals and integers — no free text in cells', () => {
    const csv = exportPairsCsv(analyzePersistence(makePreset('plateau')), 64);
    const rows = csv.slice(0, -1).split('\n').slice(1).map((line) => line.split(','));
    expect(rows.length).toBeGreaterThan(0);
    for (const cells of rows) {
      expect(cells).toHaveLength(9);
      expect(['essential', 'finite']).toContain(cells[0]);
      expect(['true', 'false']).toContain(cells[8]);
      for (const cell of cells.slice(1, 8)) {
        expect(cell).toMatch(/^\d*$/);
      }
    }
  });
});

describe('exportPairsCsv — ordering, width validation and purity', () => {
  it('puts essential first, then finite by persistence desc and peakCell asc', () => {
    const result = makeResult([
      finitePair(3, 2, 13),
      essentialPair(0, 12),
      finitePair(1, 9, 11),
      finitePair(2, 2, 12),
    ]);
    const lines = exportPairsCsv(result, 4).split('\n');
    expect(lines[0]).toBe(CSV_HEADER);
    expect(lines[1]).toBe('essential,0,0,12,,,,,true');
    expect(lines[2]).toBe('finite,1,0,10,1,9,3,2,false'); // highest persistence first
    expect(lines[3]).toBe('finite,2,0,10,1,2,0,3,false'); // tie: smaller peakCell first
    expect(lines[4]).toBe('finite,3,0,10,1,2,1,3,false');
    expect(lines[5]).toBe('');
  });

  it('rejects a non-positive-integer width with INVALID_DIMENSIONS', () => {
    const result = analyzePersistence(S_STRIP);
    const widths: readonly unknown[] = [0, -1, 1.5, 129, Number.NaN, Number.POSITIVE_INFINITY, '5'];
    for (const width of widths) {
      let caught: unknown;
      try {
        exportPairsCsv(result, width as number);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TerrainValidationError);
      const error = caught as TerrainValidationError;
      expect(error.code).toBe('INVALID_DIMENSIONS');
      expect(error.field).toBe('width');
    }
  });

  it('accepts width 1 and width 128', () => {
    const result = makeResult([essentialPair(0, 5), finitePair(0, 3, 0)]);
    expect(exportPairsCsv(result, 1).split('\n')[2]).toBe('finite,0,0,10,1,3,0,0,false');
    expect(() => exportPairsCsv(result, 128)).not.toThrow();
  });

  it('never mutates the input result (sorting happens on a filtered copy)', () => {
    const result = analyzePersistence(S_STRIP);
    const snapshot = structuredClone(result);
    const orderBefore = result.pairs.map((pair) => pair.id).join(',');
    exportPairsCsv(result, S_STRIP.width);
    expect(result).toEqual(snapshot);
    expect(result.pairs.map((pair) => pair.id).join(',')).toBe(orderBefore);
  });

  it('works on a deep-frozen result', () => {
    const frozen = deepFreeze(
      makeResult([finitePair(3, 2, 13), essentialPair(0, 12), finitePair(1, 9, 11)]),
    );
    const lines = exportPairsCsv(frozen, 4).split('\n');
    expect(lines[1]).toBe('essential,0,0,12,,,,,true');
    expect(lines[2]).toBe('finite,1,0,10,1,9,3,2,false');
    expect(lines[3]).toBe('finite,3,0,10,1,2,1,3,false');
  });
});

describe('visiblePairs — tau filtering', () => {
  const result = analyzePersistence(S_STRIP);

  it('keeps every pair at tau=0 (finite persistences are 3 and 2)', () => {
    expect(visiblePairs(result, 0).map((pair) => pair.id)).toEqual(['peak-0', 'peak-2', 'peak-4']);
  });

  it('keeps only persistence >= tau finite pairs plus the essential pair at tau=3', () => {
    expect(visiblePairs(result, 3).map((pair) => pair.id)).toEqual(['peak-0', 'peak-2']);
  });

  it('keeps both finite pairs at tau=2', () => {
    expect(visiblePairs(result, 2).map((pair) => pair.id)).toEqual(['peak-0', 'peak-2', 'peak-4']);
  });

  it('keeps the essential pair only at tau=255 and tau=4', () => {
    expect(visiblePairs(result, 255).map((pair) => pair.id)).toEqual(['peak-0']);
    expect(visiblePairs(result, 4).map((pair) => pair.id)).toEqual(['peak-0']);
  });

  it('always retains the essential pair and preserves the input order', () => {
    const unsorted = makeResult([finitePair(1, 0, 5), essentialPair(0, 12), finitePair(2, 7, 6)]);
    expect(visiblePairs(unsorted, 0).map((pair) => pair.id)).toEqual([
      'peak-1',
      'peak-0',
      'peak-2',
    ]);
    expect(visiblePairs(unsorted, 1).map((pair) => pair.id)).toEqual(['peak-0', 'peak-2']);
    expect(visiblePairs(unsorted, 255).map((pair) => pair.id)).toEqual(['peak-0']);
  });

  it('accepts the boundary taus 0 and 255', () => {
    expect(() => visiblePairs(result, 0)).not.toThrow();
    expect(() => visiblePairs(result, 255)).not.toThrow();
  });

  it('throws RangeError for out-of-range or non-integer tau', () => {
    for (const tau of [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => visiblePairs(result, tau)).toThrow(RangeError);
    }
  });

  it('is pure: returns a fresh array and never mutates the input', () => {
    const snapshot = structuredClone(result);
    const visible = visiblePairs(result, 0);
    expect(visible).not.toBe(result.pairs);
    visible.pop();
    expect(result.pairs).toHaveLength(3);
    expect(result).toEqual(snapshot);
    expect(() => visiblePairs(deepFreeze(result), 3)).not.toThrow();
  });
});

describe('summarize — beta0, finite counts and longest persistence', () => {
  const result = analyzePersistence(S_STRIP);

  it('reports beta0ByLevel[1] = 1 for S-STRIP regardless of tau', () => {
    expect(result.beta0ByLevel[1]).toBe(1);
    for (const tau of [0, 1, 2, 3, 4, 128, 255]) {
      expect(summarize(result, tau, 1).beta0).toBe(result.beta0ByLevel[1]);
      expect(summarize(result, tau, 1).beta0).toBe(1);
    }
  });

  it('reads beta0 from the original beta0ByLevel array at every level', () => {
    expect(result.beta0ByLevel.slice(0, 7)).toEqual([1, 1, 3, 3, 2, 1, 0]); // §10.1
    for (const level of [0, 1, 2, 3, 4, 5, 6, 7, 128, 255]) {
      expect(summarize(result, 0, level).beta0).toBe(result.beta0ByLevel[level]);
      expect(summarize(result, 255, level).beta0).toBe(result.beta0ByLevel[level]);
    }
  });

  it('never lets tau change beta0', () => {
    for (const level of [0, 1, 3, 5, 255]) {
      const low = summarize(result, 0, level).beta0;
      const high = summarize(result, 255, level).beta0;
      expect(low).toBe(high);
      expect(low).toBe(result.beta0ByLevel[level]);
    }
  });

  it('changes finiteCountAtTau and longestFinitePersistence correctly with tau', () => {
    expect(summarize(result, 0, 1)).toEqual({
      beta0: 1,
      finiteCountAtTau: 2,
      longestFinitePersistence: 3,
    });
    expect(summarize(result, 2, 1)).toEqual({
      beta0: 1,
      finiteCountAtTau: 2,
      longestFinitePersistence: 3,
    });
    expect(summarize(result, 3, 1)).toEqual({
      beta0: 1,
      finiteCountAtTau: 1,
      longestFinitePersistence: 3,
    });
    expect(summarize(result, 4, 1)).toEqual({
      beta0: 1,
      finiteCountAtTau: 0,
      longestFinitePersistence: 0,
    });
    expect(summarize(result, 255, 1)).toEqual({
      beta0: 1,
      finiteCountAtTau: 0,
      longestFinitePersistence: 0,
    });
  });

  it('accepts the boundary levels 0 and 255', () => {
    expect(summarize(result, 0, 0).beta0).toBe(result.beta0ByLevel[0]);
    expect(summarize(result, 0, 255).beta0).toBe(result.beta0ByLevel[255]);
  });

  it('throws RangeError for out-of-range tau or level', () => {
    for (const tau of [-1, 256, 2.5]) {
      expect(() => summarize(result, tau, 1)).toThrow(RangeError);
    }
    for (const level of [-1, 256, 1.5]) {
      expect(() => summarize(result, 0, level)).toThrow(RangeError);
    }
  });

  it('is pure and never mutates the input result', () => {
    const snapshot = structuredClone(result);
    summarize(result, 3, 2);
    expect(result).toEqual(snapshot);
  });
});
