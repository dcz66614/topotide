/**
 * Immutable brush editing for TerrainV1 (PROJECT_BOOK.md §6.3, §9.1-9.2).
 *
 * applyBrush() applies one stroke: cmd.centers are traversed strictly in the
 * given order, and each center updates every cell within Manhattan distance
 * |dx| + |dy| <= radius (a diamond). Cells outside the grid are skipped, so a
 * brush at a corner never reaches out of bounds. 'raise' adds strength,
 * 'lower' subtracts it and 'set' assigns targetHeight; every update is
 * clamped to the integer range [0, 255] immediately. Each center sees the
 * result of the previous one, so repeated centers accumulate within one
 * stroke (§6.3: same cell passed several times is acted on several times).
 * The stroke history stack itself is T010, not this module.
 *
 * The whole command is validated before any cell is touched: radius must be
 * exactly 1, 2 or 4, strength exactly 1, 4 or 16, mode exactly 'raise' |
 * 'lower' | 'set', targetHeight (required only for mode='set') an integer in
 * [0, 255], and every center an integer cell id inside the grid. Illegal
 * commands throw TerrainValidationError with code 'INVALID_SCHEMA' and the
 * offending BrushCommand field; nothing is clamped, truncated or silently
 * repaired. The terrain itself is assumed to be a valid TerrainV1
 * (validateTerrain()'s contract) and is not re-validated here.
 *
 * applyBrush() is pure: the input terrain and its elevations array are never
 * mutated. It always returns a new TerrainV1 with a fresh elevations array;
 * an empty centers list therefore returns an equal deep-safe copy, never the
 * input object itself.
 */
import type { BrushCommand, BrushMode, TerrainV1 } from './types';
import { TerrainValidationError } from './validate';

const MIN_ELEVATION = 0;
const MAX_ELEVATION = 255;

function isBrushMode(value: unknown): value is BrushMode {
  return value === 'raise' || value === 'lower' || value === 'set';
}

function isAllowedRadius(value: unknown): boolean {
  return value === 1 || value === 2 || value === 4;
}

function isAllowedStrength(value: unknown): boolean {
  return value === 1 || value === 4 || value === 16;
}

function isValidTargetHeight(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ELEVATION &&
    value <= MAX_ELEVATION
  );
}

/** Validates the whole command up front; throws before any cell is touched. */
function assertValidCommand(t: TerrainV1, cmd: BrushCommand): void {
  if (cmd === null || typeof cmd !== 'object') {
    throw new TerrainValidationError('INVALID_SCHEMA', 'brush command must be an object', 'cmd');
  }
  if (!isBrushMode(cmd.mode)) {
    throw new TerrainValidationError(
      'INVALID_SCHEMA',
      "mode must be exactly 'raise', 'lower' or 'set'",
      'mode',
    );
  }
  if (!isAllowedRadius(cmd.radius)) {
    throw new TerrainValidationError('INVALID_SCHEMA', 'radius must be exactly 1, 2 or 4', 'radius');
  }
  if (!isAllowedStrength(cmd.strength)) {
    throw new TerrainValidationError(
      'INVALID_SCHEMA',
      'strength must be exactly 1, 4 or 16',
      'strength',
    );
  }
  if (cmd.mode === 'set' && !isValidTargetHeight(cmd.targetHeight)) {
    throw new TerrainValidationError(
      'INVALID_SCHEMA',
      "targetHeight must be an integer in [0, 255] when mode is 'set'",
      'targetHeight',
    );
  }
  if (!Array.isArray(cmd.centers)) {
    throw new TerrainValidationError(
      'INVALID_SCHEMA',
      'centers must be an array of cell ids',
      'centers',
    );
  }
  const maxCellId: number = t.width * t.height - 1;
  for (let index = 0; index < cmd.centers.length; index += 1) {
    const center: number = cmd.centers[index];
    if (!Number.isInteger(center) || center < 0 || center > maxCellId) {
      throw new TerrainValidationError(
        'INVALID_SCHEMA',
        `centers[${index}] must be an integer cell id in [0, ${maxCellId}]`,
        'centers',
      );
    }
  }
}

/** Height produced by one brush hit on one cell, before clamping. */
function nextElevation(current: number, cmd: BrushCommand): number {
  switch (cmd.mode) {
    case 'raise':
      return current + cmd.strength;
    case 'lower':
      return current - cmd.strength;
    case 'set':
      return cmd.targetHeight;
  }
}

function clampElevation(value: number): number {
  if (value < MIN_ELEVATION) {
    return MIN_ELEVATION;
  }
  if (value > MAX_ELEVATION) {
    return MAX_ELEVATION;
  }
  return value;
}

export function applyBrush(t: TerrainV1, cmd: BrushCommand): TerrainV1 {
  assertValidCommand(t, cmd);
  // A fresh array from the start: the input elevations are only ever read.
  const elevations: number[] = t.elevations.slice();
  const width: number = t.width;
  for (const center of cmd.centers) {
    const centerX: number = center % width;
    const centerY: number = Math.floor(center / width);
    // Row-by-row walk over the diamond: row y is reachable iff
    // |y - centerY| <= radius, and spans the remaining reach in x. Both
    // ranges are clipped to the grid, so no write can land out of bounds.
    const minY: number = Math.max(0, centerY - cmd.radius);
    const maxY: number = Math.min(t.height - 1, centerY + cmd.radius);
    for (let y = minY; y <= maxY; y += 1) {
      const remaining: number = cmd.radius - Math.abs(y - centerY);
      const minX: number = Math.max(0, centerX - remaining);
      const maxX: number = Math.min(width - 1, centerX + remaining);
      for (let x = minX; x <= maxX; x += 1) {
        const id: number = y * width + x;
        elevations[id] = clampElevation(nextElevation(elevations[id], cmd));
      }
    }
  }
  return {
    schemaVersion: t.schemaVersion,
    width: t.width,
    height: t.height,
    elevations,
    title: t.title,
  };
}
