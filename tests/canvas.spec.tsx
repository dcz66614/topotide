/**
 * T008 tests — tests/canvas.spec.tsx (IMPLEMENTATION_PLAN.md task card P0001-T008).
 *
 * ENVIRONMENT LIMITATION (honest scope note): this repo has no jsdom and no
 * happy-dom, `vite.config.ts` pins `test.environment: "node"`, and `package.json`
 * must not be modified. So this suite exercises exactly what can be verified
 * without a DOM: the pure, exported helpers of the TerrainCanvas module (colour
 * ramp, client-rect/DPR coordinate mapping, land mask + 4-neighbour coastline
 * consistency, stroke accumulation with exactly-once commit, input immutability)
 * plus a non-mounting `createElement` contract check. No React component is
 * mounted and no real browser canvas is painted here; real-browser rendering /
 * screenshot evidence is deferred to T011 (wiring) and T013 (Playwright E2E) by
 * the plan.
 *
 * The component import below carries a `@ts-ignore`: the mandated strict tsc
 * pass for this spec runs WITHOUT `--jsx`, and any resolution that lands on a
 * `.tsx` module then raises TS6142 even when the module is valid. Vitest/Vite
 * resolves and transforms the import normally at runtime; the component's own
 * types are checked by `npm run typecheck` (tsconfig covers src/).
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
// @ts-ignore -- TS6142 (see file header): resolution to a .tsx module without --jsx
import {
  COAST_COLOR,
  GRID_MIN_CELL_PX,
  HEAT_RAMP_HIGH,
  HEAT_RAMP_LOW,
  HEAT_RAMP_MID,
  PEAK_COLOR,
  SEA_TONE,
  SEA_TONE_MIX,
  TerrainCanvas,
  WITNESS_COLOR,
  alignedCellSpan,
  backingStoreSize,
  brushDiamondCells,
  canvasPointToCellCoord,
  cellCenter,
  clientPointToCell,
  computeLandMask,
  createStrokeCollector,
  dataUrlToBlob,
  elevationRange,
  heatColor,
  isLandBoundaryCell,
  landBoundarySegments,
  lineCells,
  mixColor,
  normalizedElevation,
  rgbaToCss,
  rgbToCss,
  seaColor,
  strokeCancel,
  strokeCommit,
  strokeMove,
  strokeStart,
} from '../src/components/TerrainCanvas';
import type { BrushMode, CellId, PersistencePair, TerrainV1 } from '../src/domain/types';

/* ------------------------------------------------------------------ *
 * Local structural mirrors of the frozen §4.3 contracts (they pin the
 * shape this component must expose; see 'component contract' suite).
 * ------------------------------------------------------------------ */

interface TerrainCanvasProps {
  terrain: TerrainV1;
  level: number;
  selected: PersistencePair | null;
  brush: { mode: BrushMode; radius: 1 | 2 | 4; strength: 1 | 4 | 16; targetHeight: number };
  onStroke: (centers: CellId[]) => void;
}

interface TerrainCanvasHandle {
  toPngBlob(): Promise<Blob>;
}

/* ------------------------------------------------------------------ *
 * Local test helpers (independent of the component under test)
 * ------------------------------------------------------------------ */

function makeTerrain(width: number, height: number, elevations: number[]): TerrainV1 {
  return { schemaVersion: 1, width, height, elevations, title: 't008-canvas' };
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

/** Deterministic xorshift32 (no shared code with the component or the oracle). */
function makeRng(seed: number): () => number {
  let state = (seed + 0x9e3779b9) >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Independent flood fill over `elevations >= level` with 4-neighbour moves. */
function countIslandsByFloodFill(
  elevations: number[],
  width: number,
  height: number,
  level: number,
): number {
  const size = width * height;
  const visited = new Array<boolean>(size).fill(false);
  const stack: number[] = [];
  let components = 0;
  for (let start = 0; start < size; start += 1) {
    if (visited[start] || elevations[start] < level) {
      continue;
    }
    components += 1;
    visited[start] = true;
    stack.push(start);
    while (stack.length > 0) {
      const cell = stack.pop() as number;
      const x = cell % width;
      const y = Math.floor(cell / width);
      const neighbours: number[] = [];
      if (x > 0) neighbours.push(cell - 1);
      if (x < width - 1) neighbours.push(cell + 1);
      if (y > 0) neighbours.push(cell - width);
      if (y < height - 1) neighbours.push(cell + width);
      for (const neighbour of neighbours) {
        if (!visited[neighbour] && elevations[neighbour] >= level) {
          visited[neighbour] = true;
          stack.push(neighbour);
        }
      }
    }
  }
  return components;
}

/** Same flood fill driven by the mask instead of the raw elevations. */
function countIslandsFromMask(mask: Uint8Array, width: number, height: number): number {
  const visited = new Array<boolean>(width * height).fill(false);
  const stack: number[] = [];
  let components = 0;
  for (let start = 0; start < width * height; start += 1) {
    if (visited[start] || mask[start] !== 1) {
      continue;
    }
    components += 1;
    visited[start] = true;
    stack.push(start);
    while (stack.length > 0) {
      const cell = stack.pop() as number;
      const x = cell % width;
      const y = Math.floor(cell / width);
      const neighbours: number[] = [];
      if (x > 0) neighbours.push(cell - 1);
      if (x < width - 1) neighbours.push(cell + 1);
      if (y > 0) neighbours.push(cell - width);
      if (y < height - 1) neighbours.push(cell + width);
      for (const neighbour of neighbours) {
        if (!visited[neighbour] && mask[neighbour] === 1) {
          visited[neighbour] = true;
          stack.push(neighbour);
        }
      }
    }
  }
  return components;
}

/** Feeds a sequence of pointer cells into a fresh active stroke. */
function feedStroke(sequence: Array<CellId | null>) {
  let collector = strokeStart(createStrokeCollector());
  for (const cell of sequence) {
    collector = strokeMove(collector, cell);
  }
  return collector;
}

const S_DIAGONAL = (): TerrainV1 => makeTerrain(2, 2, [9, 0, 0, 8]);
const S_STRIP = (): TerrainV1 => makeTerrain(5, 1, [5, 1, 4, 1, 3]);

/* ------------------------------------------------------------------ *
 * Colour ramp
 * ------------------------------------------------------------------ */

describe('heat colour ramp (#163C62 → #2FA9A0 → #F1C36E)', () => {
  it('pins the three ramp stops at t = 0, 0.5 and 1', () => {
    expect(HEAT_RAMP_LOW).toEqual({ r: 22, g: 60, b: 98 });
    expect(HEAT_RAMP_MID).toEqual({ r: 47, g: 169, b: 160 });
    expect(HEAT_RAMP_HIGH).toEqual({ r: 241, g: 195, b: 110 });
    expect(heatColor(0)).toEqual(HEAT_RAMP_LOW);
    expect(heatColor(0.5)).toEqual(HEAT_RAMP_MID);
    expect(heatColor(1)).toEqual(HEAT_RAMP_HIGH);
  });

  it('interpolates monotonically inside each half of the ramp', () => {
    expect(heatColor(0.25).r).toBeGreaterThan(HEAT_RAMP_LOW.r);
    expect(heatColor(0.25).r).toBeLessThan(HEAT_RAMP_MID.r);
    expect(heatColor(0.75).r).toBeGreaterThan(HEAT_RAMP_MID.r);
    expect(heatColor(0.75).r).toBeLessThan(HEAT_RAMP_HIGH.r);
    // t=0.25 is the midpoint of the low→mid leg (rounding tolerance of 1).
    for (const channel of ['r', 'g', 'b'] as const) {
      const midpoint = (HEAT_RAMP_LOW[channel] + HEAT_RAMP_MID[channel]) / 2;
      expect(Math.abs(heatColor(0.25)[channel] - midpoint)).toBeLessThanOrEqual(1);
    }
  });

  it('clamps out-of-range t to the ramp ends', () => {
    expect(heatColor(-5)).toEqual(heatColor(0));
    expect(heatColor(42)).toEqual(heatColor(1));
    expect(heatColor(Number.NaN)).toEqual(heatColor(0));
  });

  it('maps elevation onto 0..1 and keeps a flat field on the middle stop', () => {
    expect(normalizedElevation(0, 0, 255)).toBe(0);
    expect(normalizedElevation(255, 0, 255)).toBe(1);
    expect(normalizedElevation(128, 0, 255)).toBeCloseTo(0.5, 2);
    expect(normalizedElevation(7, 7, 7)).toBe(0.5);
    expect(normalizedElevation(-3, 0, 255)).toBe(0);
    expect(normalizedElevation(300, 0, 255)).toBe(1);
    expect(normalizedElevation(Number.NaN, 0, 255)).toBe(0.5);
  });

  it('returns the exact elevation range without touching the terrain', () => {
    const terrain = S_STRIP();
    const before = Array.from(terrain.elevations);
    expect(elevationRange(terrain)).toEqual([1, 5]);
    expect(Array.from(terrain.elevations)).toEqual(before);
    expect(elevationRange(makeTerrain(1, 1, [42]))).toEqual([42, 42]);
  });

  it('renders css colours and dims sea while keeping the depth cue', () => {
    expect(rgbToCss(HEAT_RAMP_LOW)).toBe('rgb(22, 60, 98)');
    expect(rgbaToCss(PEAK_COLOR, 0.5)).toBe('rgba(70, 214, 205, 0.5)');
    expect(rgbaToCss(WITNESS_COLOR, 9)).toBe('rgba(241, 190, 96, 1)'); // alpha clamped
    expect(rgbaToCss(COAST_COLOR, -1)).toBe('rgba(230, 239, 247, 0)');
    const seaMid = seaColor(HEAT_RAMP_MID);
    expect(SEA_TONE_MIX).toBe(0.55);
    expect(seaMid).toEqual({ r: 27, g: 87, b: 90 }); // mix(mid, #0A1421, 0.55)
    expect(seaMid.r).toBeLessThan(HEAT_RAMP_MID.r);
    expect(seaMid.g).toBeLessThan(HEAT_RAMP_MID.g);
    expect(seaMid.b).toBeLessThan(HEAT_RAMP_MID.b);
    expect(seaMid.r).toBeGreaterThanOrEqual(SEA_TONE.r);
    expect(seaColor(SEA_TONE)).toEqual(SEA_TONE);
    expect(mixColor(HEAT_RAMP_LOW, HEAT_RAMP_HIGH, 1)).toEqual(HEAT_RAMP_HIGH);
  });
});

/* ------------------------------------------------------------------ *
 * Coordinate mapping (client rect + devicePixelRatio)
 * ------------------------------------------------------------------ */

describe('coordinate mapping (clientRect + DPR)', () => {
  const RECT = { left: 40, top: 25, width: 320, height: 160 }; // 64×32 grid → 5px cells

  it('maps client points to row-major cell ids', () => {
    expect(clientPointToCell(RECT.left, RECT.top, RECT, 64, 32)).toBe(0);
    expect(clientPointToCell(RECT.left + 5 * 10 + 2, RECT.top + 5 * 4 + 3, RECT, 64, 32)).toBe(
      4 * 64 + 10,
    );
    expect(clientPointToCell(RECT.left + 159, RECT.top + 159, RECT, 64, 32)).toBe(31 * 64 + 31);
    expect(clientPointToCell(RECT.left + 2, RECT.top + 7, RECT, 64, 32)).toBe(64); // (x=0, y=1)
  });

  it('returns null outside the grid, including the right/bottom edges', () => {
    expect(clientPointToCell(RECT.left - 0.1, RECT.top, RECT, 64, 32)).toBeNull();
    expect(clientPointToCell(RECT.left, RECT.top - 1, RECT, 64, 32)).toBeNull();
    expect(clientPointToCell(RECT.left + RECT.width, RECT.top, RECT, 64, 32)).toBeNull();
    expect(clientPointToCell(RECT.left, RECT.top + RECT.height, RECT, 64, 32)).toBeNull();
    expect(clientPointToCell(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 64, 32)).toBeNull();
    expect(clientPointToCell(0, 0, RECT, 0, 32)).toBeNull();
  });

  it('exposes fractional cell coordinates', () => {
    expect(canvasPointToCellCoord(RECT.left + 7.5, RECT.top + 2.5, RECT, 64, 32)).toEqual({
      x: 1.5,
      y: 0.5,
    });
    expect(canvasPointToCellCoord(0, 0, { left: 0, top: 0, width: 0, height: 0 }, 8, 8)).toEqual({
      x: -1,
      y: -1,
    });
  });

  it('works with fractional rects and keeps the mapping DPR-independent', () => {
    const fractional = { left: 12.5, top: 3.25, width: 100.5, height: 60.75 };
    // 40 CSS px into a 100.5 px wide 3-cell grid → floor(1.194) = 1; 20 px into a
    // 60.75 px tall 2-cell grid → floor(0.658) = 0, so id = y * 3 + x = 1.
    expect(clientPointToCell(12.5 + 40, 3.25 + 20, fractional, 3, 2)).toBe(1);
    // The client rect is already in CSS pixels: no DPR argument exists at all.
    expect(clientPointToCell(RECT.left + 11, RECT.top + 7, RECT, 64, 32)).toBe(1 * 64 + 2);
  });

  it('scales the backing store with the device pixel ratio', () => {
    expect(backingStoreSize(320, 160, 1)).toEqual({ width: 320, height: 160 });
    expect(backingStoreSize(320, 160, 2)).toEqual({ width: 640, height: 320 });
    expect(backingStoreSize(320, 160, 1.5)).toEqual({ width: 480, height: 240 });
    expect(backingStoreSize(320.4, 160, 2)).toEqual({ width: 641, height: 320 });
    // Broken DPRs fall back to 1 instead of zeroing the canvas.
    expect(backingStoreSize(320, 160, 0)).toEqual({ width: 320, height: 160 });
    expect(backingStoreSize(320, 160, Number.NaN)).toEqual({ width: 320, height: 160 });
  });

  it('produces seam-free, device-pixel-aligned cell spans', () => {
    expect(alignedCellSpan(0, 64, 320, 1)).toEqual({ start: 0, end: 5 });
    expect(alignedCellSpan(63, 64, 320, 1)).toEqual({ start: 315, end: 320 });
    for (const dpr of [1, 2, 1.5, 3, 2.625]) {
      const count = 64;
      const cssSize = 320;
      let previousEnd: number | null = null;
      for (let index = 0; index < count; index += 1) {
        const span = alignedCellSpan(index, count, cssSize, dpr);
        expect(span.end).toBeGreaterThan(span.start);
        if (previousEnd !== null) {
          expect(span.start).toBe(previousEnd); // shared boundary → no seams
        }
        const deviceSpan = (span.end - span.start) * dpr;
        expect(Math.abs(deviceSpan - Math.round(deviceSpan))).toBeLessThan(1e-6);
        previousEnd = span.end;
      }
      expect(alignedCellSpan(0, count, cssSize, dpr).start).toBe(0);
      expect(Math.abs(previousEnd! - cssSize)).toBeLessThan(1e-6);
    }
    expect(alignedCellSpan(0, 0, 320, 2)).toEqual({ start: 0, end: 0 });
  });

  it('gives cell centres in cell units', () => {
    expect(cellCenter(0, 5)).toEqual({ x: 0.5, y: 0.5 });
    expect(cellCenter(7, 5)).toEqual({ x: 2.5, y: 1.5 });
    expect(cellCenter(24, 5)).toEqual({ x: 4.5, y: 4.5 });
  });
});

/* ------------------------------------------------------------------ *
 * Land mask, 4-neighbour rule and coastline
 * ------------------------------------------------------------------ */

describe('land mask and 4-neighbour coastline', () => {
  it('marks exactly the cells with z >= level', () => {
    expect(Array.from(computeLandMask(S_DIAGONAL(), 1))).toEqual([1, 0, 0, 1]);
    expect(Array.from(computeLandMask(S_DIAGONAL(), 8))).toEqual([1, 0, 0, 1]);
    expect(Array.from(computeLandMask(S_DIAGONAL(), 9))).toEqual([1, 0, 0, 0]);
    expect(Array.from(computeLandMask(S_DIAGONAL(), 10))).toEqual([0, 0, 0, 0]);
    expect(Array.from(computeLandMask(S_DIAGONAL(), 0))).toEqual([1, 1, 1, 1]);
  });

  it('uses row-major ids (y * width + x), never transposed indices', () => {
    const elevations = new Array<number>(12).fill(0);
    elevations[1 * 4 + 2] = 9; // single land cell at (x=2, y=1) of a 4×3 grid
    const mask = computeLandMask(makeTerrain(4, 3, elevations), 5);
    for (let id = 0; id < 12; id += 1) {
      expect(mask[id]).toBe(id === 6 ? 1 : 0);
    }
    expect(isLandBoundaryCell(mask, 4, 3, 6)).toBe(true);
    expect(isLandBoundaryCell(mask, 4, 3, 0)).toBe(false);
  });

  it('matches an independent 4-neighbour flood fill on random fields', () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const rng = makeRng(seed);
      const width = 1 + Math.floor(rng() * 8);
      const height = 1 + Math.floor(rng() * 8);
      const size = width * height;
      const elevations = new Array<number>(size);
      for (let id = 0; id < size; id += 1) {
        elevations[id] = Math.floor(rng() * 16);
      }
      const terrain = makeTerrain(width, height, elevations);
      for (let level = 0; level <= 15; level += 1) {
        const mask = computeLandMask(terrain, level);
        for (let id = 0; id < size; id += 1) {
          expect(mask[id]).toBe(elevations[id] >= level ? 1 : 0);
        }
        expect(countIslandsFromMask(mask, width, height)).toBe(
          countIslandsByFloodFill(elevations, width, height, level),
        );
      }
    }
  });

  it('keeps S-DIAGONAL islands separate (4-connectivity, no diagonal shortcuts)', () => {
    const terrain = S_DIAGONAL();
    expect(countIslandsFromMask(computeLandMask(terrain, 1), 2, 2)).toBe(2);
    expect(countIslandsFromMask(computeLandMask(terrain, 0), 2, 2)).toBe(1);
    expect(countIslandsFromMask(computeLandMask(terrain, 10), 2, 2)).toBe(0);
  });

  it('draws a closed coastline around land, sea edges only', () => {
    const elevations = new Array<number>(9).fill(0);
    elevations[4] = 7; // one land cell in the middle of a 3×3 sea
    const segments = landBoundarySegments(computeLandMask(makeTerrain(3, 3, elevations), 3), 3, 3);
    expect(segments).toEqual([
      { x1: 1, y1: 1, x2: 1, y2: 2 }, // left
      { x1: 2, y1: 1, x2: 2, y2: 2 }, // right
      { x1: 1, y1: 1, x2: 2, y2: 1 }, // top
      { x1: 1, y1: 2, x2: 2, y2: 2 }, // bottom
    ]);
    // All-land 2×2: only the outer grid edges are coast.
    expect(landBoundarySegments(computeLandMask(makeTerrain(2, 2, [9, 9, 9, 9]), 1), 2, 2)).toHaveLength(8);
    // All-sea and empty coastlines.
    expect(landBoundarySegments(computeLandMask(makeTerrain(3, 3, new Array<number>(9).fill(0)), 1), 3, 3)).toHaveLength(0);
    expect(landBoundarySegments(computeLandMask(makeTerrain(1, 1, [5]), 5), 1, 1)).toEqual([
      { x1: 0, y1: 0, x2: 0, y2: 1 },
      { x1: 1, y1: 0, x2: 1, y2: 1 },
      { x1: 0, y1: 0, x2: 1, y2: 0 },
      { x1: 0, y1: 1, x2: 1, y2: 1 },
    ]);
  });

  it('flags boundary cells exactly where the coastline is drawn', () => {
    const elevations = [9, 9, 0, 9, 0, 0, 0, 0, 0]; // L-shaped land in a 3×3
    const mask = computeLandMask(makeTerrain(3, 3, elevations), 1);
    expect(Array.from(mask)).toEqual([1, 1, 0, 1, 0, 0, 0, 0, 0]);
    // cell (0,0): left + top grid edges = 2; cell (1,0): sea right + top edge
    // + sea below = 3; cell (0,1): left edge + sea right + sea below = 3.
    expect(landBoundarySegments(mask, 3, 3)).toHaveLength(8);
    for (let id = 0; id < 9; id += 1) {
      expect(isLandBoundaryCell(mask, 3, 3, id)).toBe(mask[id] === 1);
    }
  });

  it('exposes a grid-line zoom threshold that only triggers on large cells', () => {
    expect(GRID_MIN_CELL_PX).toBeGreaterThanOrEqual(4);
  });
});

/* ------------------------------------------------------------------ *
 * Brush diamond + stroke line geometry
 * ------------------------------------------------------------------ */

describe('brush diamond and stroke line geometry', () => {
  it('returns the Manhattan diamond, clipped to the grid, row-major', () => {
    expect(brushDiamondCells(12, 1, 5, 5)).toEqual([7, 11, 12, 13, 17]);
    expect(brushDiamondCells(12, 2, 5, 5)).toEqual([
      2, 6, 7, 8, 10, 11, 12, 13, 14, 16, 17, 18, 22,
    ]);
    // Corner brush must never leave the grid (same reach rule as applyBrush).
    expect(brushDiamondCells(0, 4, 5, 5)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 15, 16, 20]);
    expect(brushDiamondCells(0, 4, 1, 1)).toEqual([0]);
  });

  it('walks a 4-connected line between two cells', () => {
    expect(lineCells(0, 3, 8)).toEqual([0, 1, 2, 3]);
    expect(lineCells(3, 0, 8)).toEqual([3, 2, 1, 0]);
    expect(lineCells(1, 9, 4)).toEqual([1, 5, 9]); // vertical (width 4)
    expect(lineCells(0, 18, 8)).toEqual([0, 1, 9, 10, 18]); // 4-connected staircase
    expect(lineCells(5, 5, 8)).toEqual([5]);
  });

  it('keeps line paths inside the grid and 4-adjacent step by step', () => {
    const width = 6;
    const height = 5;
    const pairs: Array<[CellId, CellId]> = [
      [0, 29],
      [29, 0],
      [4, 5],
      [7, 22],
      [14, 15],
      [12, 12],
      [0, 5],
    ];
    for (const [from, to] of pairs) {
      const path = lineCells(from, to, width);
      expect(path[0]).toBe(from);
      expect(path[path.length - 1]).toBe(to);
      for (let index = 1; index < path.length; index += 1) {
        const previous = path[index - 1];
        const current = path[index];
        expect(current).toBeGreaterThanOrEqual(0);
        expect(current).toBeLessThan(width * height);
        const dx = Math.abs((current % width) - (previous % width));
        const dy = Math.abs(Math.floor(current / width) - Math.floor(previous / width));
        expect(dx + dy).toBeLessThanOrEqual(1);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Stroke collector — exactly-once per stroke
 * ------------------------------------------------------------------ */

describe('stroke collector (exactly-once semantics)', () => {
  it('starts idle and empty', () => {
    const collector = createStrokeCollector();
    expect(collector.phase).toBe('idle');
    expect(collector.centers).toEqual([]);
    expect(collector.lastCell).toBeNull();
    expect(collector.endedBy).toBe('none');
  });

  it('collects cells in order, dropping only consecutive repeats', () => {
    const collector = feedStroke([12, 12, 13, 13, 14, 13, 13, 15, null, 15]);
    expect(collector.phase).toBe('active');
    expect(Array.from(collector.centers)).toEqual([12, 13, 14, 13, 15]);
    expect(collector.lastCell).toBe(15);
  });

  it('ignores null cells and moves outside an active stroke', () => {
    expect(Array.from(feedStroke([null, null, 8, null]).centers)).toEqual([8]);
    let collector = createStrokeCollector();
    collector = strokeMove(collector, 5);
    expect(collector.phase).toBe('idle');
    expect(Array.from(collector.centers)).toEqual([]);
  });

  it('is a pure reducer: move never mutates the previous collector', () => {
    const base = feedStroke([1, 2]);
    const next = strokeMove(base, 3);
    expect(Array.from(base.centers)).toEqual([1, 2]);
    expect(base.lastCell).toBe(2);
    expect(next).not.toBe(base);
    expect(Array.from(next.centers)).toEqual([1, 2, 3]);
  });

  it('commits the centers exactly once and then stays closed', () => {
    const active = feedStroke([4, 5, 6]);
    const first = strokeCommit(active);
    expect(first.centers).toEqual([4, 5, 6]);
    expect(first.collector.phase).toBe('closed');
    expect(first.collector.endedBy).toBe('pointerup');
    expect(strokeCommit(first.collector).centers).toBeNull();
    // A commit of an idle collector can never emit a ghost stroke either.
    expect(strokeCommit(createStrokeCollector()).centers).toBeNull();
  });

  it('hands the caller a private copy of the centers', () => {
    const committed = strokeCommit(feedStroke([7, 8]));
    expect(committed.centers).not.toBeNull();
    committed.centers!.push(99);
    expect(Array.from(committed.collector.centers)).toEqual([7, 8]);
  });

  it('cancels without emitting centers (no ghost strokes)', () => {
    const cancelled = strokeCancel(feedStroke([3, 4, 5]));
    expect(cancelled.phase).toBe('closed');
    expect(cancelled.endedBy).toBe('cancel');
    expect(cancelled.centers).toEqual([]);
    expect(strokeCommit(cancelled).centers).toBeNull();
    // Cancelling an idle/closed collector is a no-op.
    expect(strokeCancel(createStrokeCollector()).endedBy).toBe('none');
  });

  it('can start a fresh stroke after commit or cancel', () => {
    let collector = strokeCancel(feedStroke([1, 2]));
    collector = strokeStart(collector);
    expect(collector.phase).toBe('active');
    expect(collector.centers).toEqual([]);
    collector = strokeMove(collector, 9);
    expect(strokeCommit(collector).centers).toEqual([9]);

    let restarted = strokeCommit(feedStroke([1, 2, 3])).collector;
    restarted = strokeStart(restarted);
    restarted = strokeMove(restarted, 30);
    restarted = strokeMove(restarted, 30);
    expect(strokeCommit(restarted).centers).toEqual([30]);
  });
});

/* ------------------------------------------------------------------ *
 * PNG export plumbing
 * ------------------------------------------------------------------ */

describe('PNG export plumbing', () => {
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  function bytesToBase64(bytes: number[]): string {
    let binary = '';
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  it('decodes a base64 PNG data URL into a Blob with identical bytes', async () => {
    const blob = dataUrlToBlob(`data:image/png;base64,${bytesToBase64(PNG_MAGIC)}`);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(PNG_MAGIC.length);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes)).toEqual(PNG_MAGIC);
  });

  it('rejects non-base64 and non-data URLs instead of guessing', () => {
    expect(() => dataUrlToBlob('data:image/png;charset=utf8,hello')).toThrow();
    expect(() => dataUrlToBlob('data:,plain')).toThrow();
    expect(() => dataUrlToBlob('https://example.com/image.png')).toThrow();
    expect(() => dataUrlToBlob('')).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Component contract (no DOM, no mounting)
 * ------------------------------------------------------------------ */

describe('component contract without a DOM', () => {
  const sampleProps = (): TerrainCanvasProps => ({
    terrain: S_STRIP(),
    level: 2,
    selected: null,
    brush: { mode: 'raise', radius: 2, strength: 4, targetHeight: 0 },
    onStroke: () => {},
  });

  it('accepts exactly the §4.3 props via createElement (never mounted)', () => {
    const element = createElement(TerrainCanvas, sampleProps());
    expect(element).toBeTruthy();
  });

  it('accepts a selected finite pair with peak and witness cells', () => {
    const selected: PersistencePair = {
      id: 'peak-2',
      peakCell: 2,
      birth: 4,
      death: 1,
      persistence: 3,
      winnerPeakCell: 0,
      witnessCell: 1,
    };
    const props = sampleProps();
    props.selected = selected;
    props.level = selected.death as number;
    const element = createElement(TerrainCanvas, props);
    expect(element).toBeTruthy();
    expect(props.brush.radius).toBe(2);
  });

  it('honours the TerrainCanvasHandle contract (toPngBlob(): Promise<Blob>)', async () => {
    const handle: TerrainCanvasHandle = {
      toPngBlob: () =>
        Promise.resolve(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })),
    };
    const blob = await handle.toPngBlob();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');
  });
});

/* ------------------------------------------------------------------ *
 * Input immutability
 * ------------------------------------------------------------------ */

describe('input immutability', () => {
  it('never mutates a deeply frozen terrain through any helper', () => {
    const terrain = deepFreeze(S_DIAGONAL());
    expect(Object.isFrozen(terrain)).toBe(true);
    expect(Object.isFrozen(terrain.elevations)).toBe(true);
    const before = Array.from(terrain.elevations);
    expect(() => computeLandMask(terrain, 1)).not.toThrow();
    expect(() => elevationRange(terrain)).not.toThrow();
    const mask = computeLandMask(terrain, 1);
    expect(() => landBoundarySegments(mask, terrain.width, terrain.height)).not.toThrow();
    expect(() => brushDiamondCells(0, 2, terrain.width, terrain.height)).not.toThrow();
    expect(Array.from(terrain.elevations)).toEqual(before);
  });

  it('returns a fresh mask every call and never aliases the input', () => {
    const terrain = S_STRIP();
    const first = computeLandMask(terrain, 2);
    const second = computeLandMask(terrain, 2);
    expect(first).not.toBe(second);
    first[0] = 0;
    expect(second[0]).toBe(1);
    expect(terrain.elevations[0]).toBe(5);
  });

  it('never mutates the client rect it maps through', () => {
    const rect = deepFreeze({ left: 10, top: 20, width: 320, height: 160 });
    expect(clientPointToCell(rect.left + 12, rect.top + 7, rect, 64, 32)).toBe(1 * 64 + 2);
    expect(rect).toEqual({ left: 10, top: 20, width: 320, height: 160 });
  });
});
