/**
 * Deterministic preset terrains (PROJECT_BOOK.md §9.1, IMPLEMENTATION_PLAN.md P0001-T006).
 *
 * All three presets are 64x64 with cell id = y * 64 + x (row-major), x/y in 0..63.
 * Every height is the fixed formula sample rounded to the nearest integer and then
 * clamped into [0, 255]. No network access, no randomness, no third-party assets.
 *
 * makePreset() builds a fresh elevations array on every call, so the same name
 * always yields byte-identical output and mutating one result never affects a
 * later call.
 */
import type { TerrainV1 } from './types';

/** Side length of every preset grid. */
export const PRESET_SIZE = 64;

/** The fixed preset names; anything else must throw. */
export type PresetName = 'twin-peaks' | 'ridge-gate' | 'plateau';

/** Round to the nearest integer, then clamp into [0, 255]. */
function clampRounded(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Samples one preset height at cell (x, y), both in 0..63. */
type HeightSample = (x: number, y: number) => number;

/** Builds a fresh row-major 64x64 elevations array for one preset formula. */
function buildElevations(sample: HeightSample): number[] {
  const elevations: number[] = [];
  for (let y = 0; y < PRESET_SIZE; y += 1) {
    for (let x = 0; x < PRESET_SIZE; x += 1) {
      elevations.push(clampRounded(sample(x, y)));
    }
  }
  return elevations;
}

/** TWIN PEAKS: two diamond cones over a raised saddle ridge line (floor 15). */
function sampleTwinPeaks(x: number, y: number): number {
  const a = Math.max(0, 215 - 6 * (Math.abs(x - 18) + Math.abs(y - 30)));
  const b = Math.max(0, 202 - 6 * (Math.abs(x - 45) + Math.abs(y - 31)));
  const r = Math.max(0, 113 - 3 * Math.abs(y - 30) - 2 * Math.abs(x - 32));
  return Math.max(15, a, b, r);
}

/** RIDGE GATE: two diamond cones flanking a fixed-height gate strip (floor 10). */
function sampleRidgeGate(x: number, y: number): number {
  const a = Math.max(0, 205 - 5 * (Math.abs(x - 15) + Math.abs(y - 32)));
  const b = Math.max(0, 195 - 5 * (Math.abs(x - 48) + Math.abs(y - 32)));
  const ridge = x >= 15 && x <= 48 && Math.abs(y - 32) <= 1 ? 94 : 0;
  return Math.max(10, a, b, ridge);
}

/**
 * PLATEAU: flat background with rectangular mesas and a lower bridge strip.
 * The rules apply in the listed order, so the last matching rule wins: the
 * bridge columns x=24 and x=39 (y=18..20) override the mesa heights.
 */
function samplePlateau(x: number, y: number): number {
  let z = 18;
  if (x >= 8 && x <= 24 && y >= 10 && y <= 29) {
    z = 205;
  }
  if (x >= 39 && x <= 55 && y >= 10 && y <= 29) {
    z = 185;
  }
  if (x >= 24 && x <= 39 && y >= 18 && y <= 20) {
    z = 80;
  }
  return z;
}

interface PresetDefinition {
  readonly title: string;
  readonly sample: HeightSample;
}

const PRESETS: Readonly<Record<PresetName, PresetDefinition>> = {
  'twin-peaks': { title: 'Twin Peaks', sample: sampleTwinPeaks },
  'ridge-gate': { title: 'Ridge Gate', sample: sampleRidgeGate },
  plateau: { title: 'Plateau', sample: samplePlateau },
};

/** Builds one deterministic, fully independent preset terrain. */
export function makePreset(name: PresetName): TerrainV1 {
  // Widen the key type so an out-of-contract name at runtime throws instead of
  // silently returning a default preset.
  const lookup: Readonly<Record<string, PresetDefinition | undefined>> = PRESETS;
  const definition = lookup[name];
  if (definition === undefined) {
    throw new Error(`makePreset: unknown preset name ${JSON.stringify(String(name))}`);
  }
  return {
    schemaVersion: 1,
    width: PRESET_SIZE,
    height: PRESET_SIZE,
    elevations: buildElevations(definition.sample),
    title: definition.title,
  };
}
