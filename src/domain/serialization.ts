/**
 * Terrain JSON import/export and persistence-pair CSV export
 * (PROJECT_BOOK.md §9.2, §10.6, §12; IMPLEMENTATION_PLAN.md P0001-T007).
 *
 * Import order of defense (never reordered):
 *   1. UTF-8 byte length of the raw text (TextEncoder) against the 250 KiB
 *      limit -> FILE_TOO_LARGE, BEFORE JSON.parse ever sees the input.
 *   2. JSON.parse -> any parse failure is INVALID_SCHEMA (never a SyntaxError).
 *   3. validateTerrain() -> the exact codes of §9.1 (INVALID_SCHEMA,
 *      INVALID_DIMENSIONS, INVALID_HEIGHTS).
 *
 * There is no implicit size repair, no truncation and no silent field fixing,
 * and error messages name only the field and the reason: they never echo any
 * part of the input content.
 *
 * Every function here is pure: inputs are only read, never mutated. Sorting
 * for the CSV happens on a freshly filtered array, so `r.pairs` keeps its own
 * order.
 */
import type { PersistencePair, PersistenceResult, TerrainV1 } from './types';
import { TerrainValidationError, validateTerrain } from './validate';

/** 250 KiB, measured in UTF-8 bytes (PROJECT_BOOK.md §12). */
const MAX_INPUT_BYTES = 250 * 1024;

const MIN_DIMENSION = 1;
const MAX_DIMENSION = 128;

/** Exact CSV header from PROJECT_BOOK.md §10.6. */
const CSV_HEADER = 'type,peak_x,peak_y,birth,death,persistence,witness_x,witness_y,essential';

const textEncoder = new TextEncoder();

/** A finite pair with all nullable contract fields filled in. */
interface FiniteRow {
  readonly pair: PersistencePair;
  readonly death: number;
  readonly persistence: number;
  readonly witnessCell: number;
}

/**
 * Serializes a terrain to JSON with the fixed key order
 * `schemaVersion,width,height,elevations,title` and one trailing LF.
 * The terrain is validated first, so invalid input never produces output.
 */
export function exportTerrainJson(t: TerrainV1): string {
  const clean = validateTerrain(t);
  return `${JSON.stringify({
    schemaVersion: clean.schemaVersion,
    width: clean.width,
    height: clean.height,
    elevations: clean.elevations,
    title: clean.title,
  })}\n`;
}

/**
 * Parses and validates a TerrainV1 JSON document.
 * Throws TerrainValidationError FILE_TOO_LARGE before parsing when the raw
 * text exceeds 250 KiB of UTF-8 bytes, INVALID_SCHEMA for unparseable text,
 * and otherwise exactly the codes validateTerrain() uses.
 */
export function importTerrainJson(text: string): TerrainV1 {
  // 1. Size guard FIRST: rejects oversized input before JSON.parse runs.
  if (textEncoder.encode(text).length > MAX_INPUT_BYTES) {
    throw new TerrainValidationError(
      'FILE_TOO_LARGE',
      `input exceeds the maximum size of ${MAX_INPUT_BYTES} UTF-8 bytes (250 KiB)`,
      'input',
    );
  }
  // 2. Parse. Any SyntaxError is reported as INVALID_SCHEMA, and the message
  //    never quotes the offending input.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new TerrainValidationError('INVALID_SCHEMA', 'input is not valid JSON', 'input');
  }
  // 3. Full validation: same codes as validateTerrain(), no repair.
  return validateTerrain(parsed);
}

/** Throws unless width is an integer in [1, 128] (the TerrainV1 grid rule). */
function assertCsvWidth(width: number): void {
  if (!Number.isInteger(width) || width < MIN_DIMENSION || width > MAX_DIMENSION) {
    throw new TerrainValidationError(
      'INVALID_DIMENSIONS',
      'width must be an integer in [1, 128]',
      'width',
    );
  }
}

/** Row-major cell id -> (x, y); x = id % width, y = floor(id / width). */
function cellX(cell: number, width: number): number {
  return cell % width;
}

function cellY(cell: number, width: number): number {
  return Math.floor(cell / width);
}

/** Essential row: death, persistence and witness columns stay empty. */
function essentialRow(pair: PersistencePair, width: number): string {
  return `essential,${cellX(pair.peakCell, width)},${cellY(pair.peakCell, width)},${pair.birth},,,,,true`;
}

/** Finite row: every numeric column is filled, essential is lowercase false. */
function finiteRow(row: FiniteRow, width: number): string {
  const { pair } = row;
  return (
    `finite,${cellX(pair.peakCell, width)},${cellY(pair.peakCell, width)},${pair.birth},` +
    `${row.death},${row.persistence},` +
    `${cellX(row.witnessCell, width)},${cellY(row.witnessCell, width)},false`
  );
}

/**
 * Exports the pairs of one analysis as CSV text (PROJECT_BOOK.md §10.6):
 * LF line endings, one trailing LF after the last row, the exact §10.6 header,
 * essential rows first, then finite rows by persistence descending and
 * peakCell ascending (stable). Cells contain only fixed literals and integer
 * numbers — no free text, hence no formula-injection risk.
 */
export function exportPairsCsv(r: PersistenceResult, width: number): string {
  assertCsvWidth(width);

  const essentialRows: string[] = [];
  const finiteRows: FiniteRow[] = [];
  for (const pair of r.pairs) {
    if (pair.death === null) {
      // The essential pair: nullable columns stay empty.
      essentialRows.push(essentialRow(pair, width));
    } else if (pair.persistence !== null && pair.witnessCell !== null) {
      finiteRows.push({
        pair,
        death: pair.death,
        persistence: pair.persistence,
        witnessCell: pair.witnessCell,
      });
    } else {
      throw new Error(
        'exportPairsCsv: pair has a death level but null persistence or witness, ' +
          'which violates the PersistencePair contract',
      );
    }
  }

  // Filter() returned a fresh array, so this sort never touches r.pairs.
  finiteRows.sort((a, b) => b.persistence - a.persistence || a.pair.peakCell - b.pair.peakCell);

  const lines = [CSV_HEADER, ...essentialRows];
  for (const row of finiteRows) {
    lines.push(finiteRow(row, width));
  }
  return `${lines.join('\n')}\n`;
}
