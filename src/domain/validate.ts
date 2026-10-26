/**
 * Safe input validation for TerrainV1 (PROJECT_BOOK.md §9.1-9.2).
 *
 * Classification priority:
 *   1. size guard      -> FILE_TOO_LARGE   (field 'input')
 *   2. field set       -> INVALID_SCHEMA   (field = the missing/unexpected field)
 *   3. schemaVersion   -> INVALID_SCHEMA   (field 'schemaVersion')
 *   4. width / height  -> INVALID_DIMENSIONS (field 'width' / 'height')
 *   5. elevations      -> INVALID_HEIGHTS  (field 'elevations')
 *   6. title           -> INVALID_SCHEMA   (field 'title')
 *
 * The size guard runs before any shape inspection: a raw JSON text string is
 * not an object at all, and importTerrainJson() must reject an oversized file
 * before parsing it, so both the string and the pre-parsed object form of the
 * same payload classify identically. Error messages name only the field and
 * the reason; they never echo the input content.
 *
 * validateTerrain() is pure: it never mutates its input and returns a fresh,
 * independent TerrainV1 (no sorting, no clamping, no implicit size repair).
 */
import type { TerrainV1 } from './types';

/** Stable machine-readable error codes thrown by {@link validateTerrain}. */
export type TerrainErrorCode =
  | 'INVALID_SCHEMA'
  | 'INVALID_DIMENSIONS'
  | 'INVALID_HEIGHTS'
  | 'FILE_TOO_LARGE';

/** Error thrown for every rejected terrain input. */
export class TerrainValidationError extends Error {
  readonly code: TerrainErrorCode;
  readonly field?: string;

  constructor(code: TerrainErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'TerrainValidationError';
    this.code = code;
    this.field = field;
    // Keep instanceof working under any TypeScript transpile target.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const MIN_DIMENSION = 1;
const MAX_DIMENSION = 128;
const MIN_ELEVATION = 0;
const MAX_ELEVATION = 255;
const MIN_TITLE_CODE_POINTS = 1;
const MAX_TITLE_CODE_POINTS = 80;
/** 250 KiB, measured in UTF-8 bytes. */
const MAX_INPUT_BYTES = 250 * 1024;
const EXPECTED_FIELDS = ['schemaVersion', 'width', 'height', 'elevations', 'title'] as const;

const textEncoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_DIMENSION &&
    value <= MAX_DIMENSION
  );
}

function isValidElevation(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ELEVATION &&
    value <= MAX_ELEVATION
  );
}

function tooLargeError(): TerrainValidationError {
  return new TerrainValidationError(
    'FILE_TOO_LARGE',
    `input exceeds the maximum size of ${MAX_INPUT_BYTES} UTF-8 bytes (250 KiB)`,
    'input',
  );
}

function notAnObjectError(): TerrainValidationError {
  return new TerrainValidationError('INVALID_SCHEMA', 'input must be a JSON object', 'input');
}

export function validateTerrain(input: unknown): TerrainV1 {
  // 1. Size guard, before any shape inspection.
  if (typeof input === 'string') {
    if (utf8ByteLength(input) > MAX_INPUT_BYTES) {
      throw tooLargeError();
    }
    // Raw JSON text is parsed by importTerrainJson(), not here.
    throw notAnObjectError();
  }
  if (!isPlainObject(input)) {
    throw notAnObjectError();
  }
  // JSON.stringify returns undefined for an object whose toJSON yields
  // undefined, and throws on cyclic structures or BigInt values.
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input) as string | undefined;
  } catch {
    throw new TerrainValidationError('INVALID_SCHEMA', 'input must be JSON-serializable', 'input');
  }
  if (serialized === undefined) {
    throw new TerrainValidationError('INVALID_SCHEMA', 'input must be JSON-serializable', 'input');
  }
  if (utf8ByteLength(serialized) > MAX_INPUT_BYTES) {
    throw tooLargeError();
  }

  // 2. Exact field set: every expected field present, nothing else.
  for (const name of EXPECTED_FIELDS) {
    if (!hasOwn(input, name)) {
      throw new TerrainValidationError(
        'INVALID_SCHEMA',
        `missing required field "${name}"`,
        name,
      );
    }
  }
  for (const key of Object.keys(input)) {
    if (!(EXPECTED_FIELDS as readonly string[]).includes(key)) {
      throw new TerrainValidationError('INVALID_SCHEMA', `unexpected field "${key}"`, key);
    }
  }

  // 3. schemaVersion must be exactly 1.
  if (input.schemaVersion !== 1) {
    throw new TerrainValidationError(
      'INVALID_SCHEMA',
      'schemaVersion must be exactly 1',
      'schemaVersion',
    );
  }

  // 4. Dimensions: integers in [1, 128], never repaired or truncated.
  if (!isDimension(input.width)) {
    throw new TerrainValidationError(
      'INVALID_DIMENSIONS',
      'width must be an integer in [1, 128]',
      'width',
    );
  }
  if (!isDimension(input.height)) {
    throw new TerrainValidationError(
      'INVALID_DIMENSIONS',
      'height must be an integer in [1, 128]',
      'height',
    );
  }
  const width: number = input.width;
  const height: number = input.height;

  // 5. Elevations: array of exactly width * height integers in [0, 255].
  if (!Array.isArray(input.elevations)) {
    throw new TerrainValidationError('INVALID_HEIGHTS', 'elevations must be an array', 'elevations');
  }
  const elevations: unknown[] = input.elevations;
  if (elevations.length !== width * height) {
    throw new TerrainValidationError(
      'INVALID_HEIGHTS',
      `elevations must contain exactly width * height = ${width * height} values, but ${elevations.length} were given`,
      'elevations',
    );
  }
  // Copy while validating: the returned array is a fresh, independent one and
  // the input array is only read, never sorted or clamped.
  const elevationsCopy: number[] = [];
  for (let index = 0; index < elevations.length; index += 1) {
    const value: unknown = elevations[index];
    if (!isValidElevation(value)) {
      throw new TerrainValidationError(
        'INVALID_HEIGHTS',
        `elevations[${index}] must be an integer in [0, 255]`,
        'elevations',
      );
    }
    elevationsCopy.push(value);
  }

  // 6. Title: 1..80 Unicode code points.
  if (typeof input.title !== 'string') {
    throw new TerrainValidationError('INVALID_SCHEMA', 'title must be a string', 'title');
  }
  const title: string = input.title;
  const titleCodePoints = Array.from(title).length;
  if (titleCodePoints < MIN_TITLE_CODE_POINTS || titleCodePoints > MAX_TITLE_CODE_POINTS) {
    throw new TerrainValidationError(
      'INVALID_SCHEMA',
      'title must contain 1 to 80 Unicode characters',
      'title',
    );
  }

  return {
    schemaVersion: 1,
    width,
    height,
    elevations: elevationsCopy,
    title,
  };
}
