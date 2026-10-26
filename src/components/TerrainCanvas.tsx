/**
 * T008 — 地貌舞台 TerrainCanvas (PROJECT_BOOK.md §6.1/§6.2; IMPLEMENTATION_PLAN.md
 * §4.3 / task card P0001-T008).
 *
 * A render-only Canvas 2D view of a `TerrainV1`:
 *  - heat ramp `#163C62` (low) → `#2FA9A0` (mid) → `#F1C36E` (high) with linear
 *    RGB interpolation between the three stops;
 *  - cells with `z >= level` are land at full ramp brightness, everything below
 *    is sea dimmed toward the deep-sea page tone, with a drawn coastline so the
 *    land/sea boundary is readable without relying on hue alone;
 *  - grid lines appear only when a cell is large enough on screen;
 *  - the selected persistence pair highlights `peakCell` (cyan star + ring) and
 *    `witnessCell` (gold diamond); an essential pair has no witness;
 *  - hovering shows `(x, y)`, the elevation and a dashed preview ring sized by
 *    the brush radius.
 *
 * Interaction contract — exactly one `onStroke(centers)` per stroke:
 *  - `pointerdown` starts a stroke and records the first cell;
 *  - `pointermove` accumulates cells in traversal order with consecutive
 *    duplicates removed; a Bresenham line between successive in-grid cells
 *    keeps fast drags gap-free;
 *  - `pointerup` commits the collected centers exactly once;
 *  - `pointercancel` / `pointerleave` discard the stroke WITHOUT calling
 *    `onStroke` (no ghost strokes);
 *  - `setPointerCapture` keeps the stroke alive while the pointer roams outside
 *    the canvas, and `touch-action: none` stops page scrolling while drawing.
 *
 * Ownership rules (plan §4.3): the component holds no copy of the terrain — it
 * renders straight from props, never writes to `terrain` / `elevations`, and
 * derives the land mask locally on every paint. It only reports stroke intent;
 * `applyBrush` and the undo stack live in the domain/hook layers.
 *
 * All geometry/colour/stroke helpers below are pure and DOM-free so they can be
 * unit-tested in the plain `node` vitest environment of this repo (there is no
 * jsdom/happy-dom here and `package.json` must not change). Real-browser
 * rendering evidence is T011/T013's responsibility per the plan.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { BrushMode, CellId, PersistencePair, TerrainV1 } from '../domain/types';
import styles from './TerrainCanvas.module.css';

/* ------------------------------------------------------------------ *
 * Frozen contracts (IMPLEMENTATION_PLAN.md §4.3)
 * ------------------------------------------------------------------ */

export interface TerrainCanvasProps {
  terrain: TerrainV1;
  level: number;
  selected: PersistencePair | null;
  brush: { mode: BrushMode; radius: 1 | 2 | 4; strength: 1 | 4 | 16; targetHeight: number };
  /** Called exactly once per stroke, on pointerup, with the ordered cell ids. */
  onStroke: (centers: CellId[]) => void;
}

export interface TerrainCanvasHandle {
  /** Exports the current canvas contents as a PNG blob. */
  toPngBlob(): Promise<Blob>;
}

/* ------------------------------------------------------------------ *
 * Colour ramp
 * ------------------------------------------------------------------ */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const HEAT_RAMP_LOW: Rgb = { r: 0x16, g: 0x3c, b: 0x62 }; // #163C62
export const HEAT_RAMP_MID: Rgb = { r: 0x2f, g: 0xa9, b: 0xa0 }; // #2FA9A0
export const HEAT_RAMP_HIGH: Rgb = { r: 0xf1, g: 0xc3, b: 0x6e }; // #F1C36E
/** Deep-sea page tone (#0A1421) sea cells are dimmed toward. */
export const SEA_TONE: Rgb = { r: 0x0a, g: 0x14, b: 0x21 };
/** How strongly sea cells are pushed toward {@link SEA_TONE} (0..1). */
export const SEA_TONE_MIX = 0.55;
export const COAST_COLOR: Rgb = { r: 0xe6, g: 0xef, b: 0xf7 }; // #E6EFF7
export const PEAK_COLOR: Rgb = { r: 0x46, g: 0xd6, b: 0xcd }; // #46D6CD accent cyan
export const WITNESS_COLOR: Rgb = { r: 0xf1, g: 0xbe, b: 0x60 }; // #F1BE60 event gold

/** Grid lines are drawn only when one cell is at least this many CSS px. */
export const GRID_MIN_CELL_PX = 8;

/** Clamps to [0, 1]; non-finite input maps to 0 so NaN can never reach a canvas call. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function mixColor(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clampUnit(t);
  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k),
  };
}

/** Three-stop ramp: low→mid for t<=0.5, mid→high above, clamped at both ends. */
export function heatColor(t: number): Rgb {
  const k = clampUnit(t);
  if (k <= 0.5) {
    return mixColor(HEAT_RAMP_LOW, HEAT_RAMP_MID, k * 2);
  }
  return mixColor(HEAT_RAMP_MID, HEAT_RAMP_HIGH, (k - 0.5) * 2);
}

export function rgbToCss(color: Rgb): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

export function rgbaToCss(color: Rgb, alpha: number): string {
  const a = clampUnit(alpha);
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.round(a * 1000) / 1000})`;
}

/** Elevation → ramp position; a flat field (max<=min) sits on the middle stop. */
export function normalizedElevation(z: number, minZ: number, maxZ: number): number {
  if (!Number.isFinite(z) || maxZ <= minZ) {
    return 0.5;
  }
  return clampUnit((z - minZ) / (maxZ - minZ));
}

/** `[min, max]` of the terrain; never mutates the input. */
export function elevationRange(terrain: TerrainV1): readonly [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const elevations = terrain.elevations;
  for (let index = 0; index < elevations.length; index += 1) {
    const z = elevations[index];
    if (z < min) {
      min = z;
    }
    if (z > max) {
      max = z;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return [0, 0];
  }
  return [min, max];
}

/** Sea shading: keep the depth cue, drop the brightness. */
export function seaColor(base: Rgb): Rgb {
  return mixColor(base, SEA_TONE, SEA_TONE_MIX);
}

/* ------------------------------------------------------------------ *
 * Coordinate mapping (clientRect + devicePixelRatio)
 * ------------------------------------------------------------------ */

/** A canvas client rect; all values are CSS pixels. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Backing-store size for a CSS size at a device pixel ratio. Non-positive or
 * non-finite ratios fall back to 1 so a broken DPR can never blank the canvas.
 */
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): { width: number; height: number } {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * ratio)),
    height: Math.max(1, Math.round(cssHeight * ratio)),
  };
}

/**
 * Pixel-aligned [start, end] span (in CSS px) of cell `index` out of `count`
 * cells across `cssSize`. Adjacent spans share an exact boundary, so painting
 * every cell leaves no seams, and every span edge lands on a device pixel.
 */
export function alignedCellSpan(
  index: number,
  count: number,
  cssSize: number,
  dpr: number,
): { start: number; end: number } {
  if (!(count > 0) || !(cssSize > 0)) {
    return { start: 0, end: 0 };
  }
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const deviceSize = cssSize * ratio;
  const startDevice = Math.round((index / count) * deviceSize);
  const endDevice = Math.round(((index + 1) / count) * deviceSize);
  return { start: startDevice / ratio, end: endDevice / ratio };
}

/** Fractional cell coordinates of a canvas-local point (values may be out of range). */
export function canvasPointToCellCoord(
  clientX: number,
  clientY: number,
  rect: Rect,
  gridWidth: number,
  gridHeight: number,
): { x: number; y: number } {
  if (gridWidth <= 0 || gridHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return { x: -1, y: -1 };
  }
  return {
    x: ((clientX - rect.left) / rect.width) * gridWidth,
    y: ((clientY - rect.top) / rect.height) * gridHeight,
  };
}

/**
 * Cell id under a pointer client point, or `null` when the point is outside the
 * grid (right/bottom edges included). DPR-independent by design: the client
 * rect is already in CSS pixels, so only the layout size can move cells.
 */
export function clientPointToCell(
  clientX: number,
  clientY: number,
  rect: Rect,
  gridWidth: number,
  gridHeight: number,
): CellId | null {
  const coord = canvasPointToCellCoord(clientX, clientY, rect, gridWidth, gridHeight);
  const x = Math.floor(coord.x);
  const y = Math.floor(coord.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  if (x < 0 || y < 0 || x >= gridWidth || y >= gridHeight) {
    return null;
  }
  return y * gridWidth + x;
}

/** Centre of a cell in cell units (x + 0.5, y + 0.5). */
export function cellCenter(cell: CellId, gridWidth: number): { x: number; y: number } {
  const x = cell % gridWidth;
  const y = Math.floor(cell / gridWidth);
  return { x: x + 0.5, y: y + 0.5 };
}

/* ------------------------------------------------------------------ *
 * Land mask, coastline and brush geometry
 * ------------------------------------------------------------------ */

/**
 * Land mask: `mask[id] === 1` iff `elevations[id] >= level`, 0 for sea.
 * One fresh array per call; the terrain is only ever read.
 */
export function computeLandMask(terrain: TerrainV1, level: number): Uint8Array {
  const size = terrain.width * terrain.height;
  const mask = new Uint8Array(size);
  const elevations = terrain.elevations;
  for (let id = 0; id < size; id += 1) {
    mask[id] = elevations[id] >= level ? 1 : 0;
  }
  return mask;
}

/**
 * True when a land cell touches sea or the grid edge along one of its four
 * neighbours (diagonals never make a coast, matching the 4-adjacency rule).
 */
export function isLandBoundaryCell(
  mask: Uint8Array,
  gridWidth: number,
  gridHeight: number,
  cell: CellId,
): boolean {
  if (mask[cell] !== 1) {
    return false;
  }
  const x = cell % gridWidth;
  const y = Math.floor(cell / gridWidth);
  if (x === 0 || x === gridWidth - 1 || y === 0 || y === gridHeight - 1) {
    return true;
  }
  return (
    mask[y * gridWidth + (x - 1)] !== 1 ||
    mask[y * gridWidth + (x + 1)] !== 1 ||
    mask[(y - 1) * gridWidth + x] !== 1 ||
    mask[(y + 1) * gridWidth + x] !== 1
  );
}

/** A coast edge in cell-edge coordinates (x in 0..width, y in 0..height). */
export interface BoundarySegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** All land/sea edges of the mask, ordered cell by cell (row-major). */
export function landBoundarySegments(
  mask: Uint8Array,
  gridWidth: number,
  gridHeight: number,
): BoundarySegment[] {
  const segments: BoundarySegment[] = [];
  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      if (mask[y * gridWidth + x] !== 1) {
        continue;
      }
      if (x === 0 || mask[y * gridWidth + (x - 1)] !== 1) {
        segments.push({ x1: x, y1: y, x2: x, y2: y + 1 }); // left edge
      }
      if (x === gridWidth - 1 || mask[y * gridWidth + (x + 1)] !== 1) {
        segments.push({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1 }); // right edge
      }
      if (y === 0 || mask[(y - 1) * gridWidth + x] !== 1) {
        segments.push({ x1: x, y1: y, x2: x + 1, y2: y }); // top edge
      }
      if (y === gridHeight - 1 || mask[(y + 1) * gridWidth + x] !== 1) {
        segments.push({ x1: x, y1: y + 1, x2: x + 1, y2: y + 1 }); // bottom edge
      }
    }
  }
  return segments;
}

/**
 * Diamond brush footprint: every cell with Manhattan distance <= radius from
 * the centre, clipped to the grid, row-major (same reach rule as applyBrush).
 */
export function brushDiamondCells(
  center: CellId,
  radius: number,
  gridWidth: number,
  gridHeight: number,
): CellId[] {
  const cells: CellId[] = [];
  const centerX = center % gridWidth;
  const centerY = Math.floor(center / gridWidth);
  const minY = Math.max(0, centerY - radius);
  const maxY = Math.min(gridHeight - 1, centerY + radius);
  for (let y = minY; y <= maxY; y += 1) {
    const reach = radius - Math.abs(y - centerY);
    const minX = Math.max(0, centerX - reach);
    const maxX = Math.min(gridWidth - 1, centerX + reach);
    for (let x = minX; x <= maxX; x += 1) {
      cells.push(y * gridWidth + x);
    }
  }
  return cells;
}

/**
 * 4-connected Bresenham line between two in-grid cells (inclusive, one axis per
 * step). Two in-grid endpoints always stay inside their bounding box, so no
 * extra clipping is needed; the staircase keeps the traversed centerline
 * 4-connected, matching the terrain's 4-adjacency rule. Used to bridge the gaps
 * left by fast pointer movement between successive pointermove samples.
 */
export function lineCells(from: CellId, to: CellId, gridWidth: number): CellId[] {
  let x = from % gridWidth;
  let y = Math.floor(from / gridWidth);
  const endX = to % gridWidth;
  const endY = Math.floor(to / gridWidth);
  const stepX = x < endX ? 1 : -1;
  const stepY = y < endY ? 1 : -1;
  const dx = Math.abs(endX - x);
  const dy = -Math.abs(endY - y);
  let error = dx + dy;
  const cells: CellId[] = [];
  for (;;) {
    cells.push(y * gridWidth + x);
    if (x === endX && y === endY) {
      break;
    }
    const doubled = 2 * error;
    // else-if: never move both axes in one step → strictly 4-connected path.
    // At least one branch always runs (doubled cannot be both < dy <= 0 and > dx >= 0).
    if (doubled >= dy) {
      error += dy;
      x += stepX;
    } else if (doubled <= dx) {
      error += dx;
      y += stepY;
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ *
 * Stroke collector (pure, DOM-free; exactly-once semantics)
 * ------------------------------------------------------------------ */

export type StrokePhase = 'idle' | 'active' | 'closed';

export interface StrokeCollector {
  readonly phase: StrokePhase;
  /** Ordered cells with consecutive duplicates removed. */
  readonly centers: readonly CellId[];
  readonly lastCell: CellId | null;
  readonly endedBy: 'none' | 'pointerup' | 'cancel';
}

export function createStrokeCollector(): StrokeCollector {
  return { phase: 'idle', centers: [], lastCell: null, endedBy: 'none' };
}

/** Opens a fresh active stroke, discarding whatever the previous one held. */
export function strokeStart(_previous: StrokeCollector): StrokeCollector {
  return { phase: 'active', centers: [], lastCell: null, endedBy: 'none' };
}

/**
 * Adds one cell to an active stroke. `null` (pointer outside the grid), moves
 * while idle, and consecutive repeats are all ignored; order is preserved.
 */
export function strokeMove(
  collector: StrokeCollector,
  cell: CellId | null,
): StrokeCollector {
  if (collector.phase !== 'active' || cell === null || collector.lastCell === cell) {
    return collector;
  }
  return { ...collector, centers: [...collector.centers, cell], lastCell: cell };
}

/**
 * Commits an active stroke exactly once: the first call returns the collected
 * centers (a private copy), any later call — or a commit of an idle/cancelled
 * collector — returns `centers: null` so a ghost stroke cannot be emitted.
 */
export function strokeCommit(
  collector: StrokeCollector,
): { collector: StrokeCollector; centers: CellId[] | null } {
  if (collector.phase !== 'active') {
    return { collector, centers: null };
  }
  const closed: StrokeCollector = {
    phase: 'closed',
    centers: collector.centers,
    lastCell: collector.lastCell,
    endedBy: 'pointerup',
  };
  return { collector: closed, centers: collector.centers.slice() };
}

/** Cancels an active stroke; never yields centers. */
export function strokeCancel(collector: StrokeCollector): StrokeCollector {
  if (collector.phase !== 'active') {
    return collector;
  }
  return { phase: 'closed', centers: [], lastCell: null, endedBy: 'cancel' };
}

/* ------------------------------------------------------------------ *
 * PNG export plumbing
 * ------------------------------------------------------------------ */

/**
 * Decodes a base64 data URL (e.g. from `canvas.toDataURL('image/png')`) into a
 * Blob without any network or library support. Throws on non-data or non-base64
 * input instead of guessing.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) {
    throw new Error('TerrainCanvas: not a data URL');
  }
  const header = dataUrl.slice(5, comma).split(';');
  const mime = header[0] || 'application/octet-stream';
  if (!header.slice(1).includes('base64')) {
    throw new Error('TerrainCanvas: only base64 data URLs are supported');
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mime });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Canvas → PNG blob, preferring `toBlob` and falling back to the data URL. */
function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  if (typeof canvas.toBlob === 'function') {
    return new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('TerrainCanvas: canvas.toBlob() produced no PNG blob'));
          }
        }, 'image/png');
      } catch (error) {
        reject(toError(error));
      }
    });
  }
  try {
    return Promise.resolve(dataUrlToBlob(canvas.toDataURL('image/png')));
  } catch (error) {
    return Promise.reject(toError(error));
  }
}

/* ------------------------------------------------------------------ *
 * Painting (DOM-bound; exercised in the browser, not in node tests)
 * ------------------------------------------------------------------ */

function drawPeakMark(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius * 1.45, 0, Math.PI * 2);
  ctx.strokeStyle = rgbaToCss(PEAK_COLOR, 0.95);
  ctx.lineWidth = Math.max(1.5, radius * 0.28);
  ctx.stroke();

  ctx.beginPath();
  for (let point = 0; point < 8; point += 1) {
    const angle = -Math.PI / 2 + (point * Math.PI) / 4;
    const distance = point % 2 === 0 ? radius : radius * 0.42;
    const px = centerX + Math.cos(angle) * distance;
    const py = centerY + Math.sin(angle) * distance;
    if (point === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
  ctx.fillStyle = rgbaToCss(PEAK_COLOR, 0.95);
  ctx.fill();
}

function drawWitnessMark(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(centerX, centerY - radius);
  ctx.lineTo(centerX + radius, centerY);
  ctx.lineTo(centerX, centerY + radius);
  ctx.lineTo(centerX - radius, centerY);
  ctx.closePath();
  ctx.fillStyle = rgbaToCss(WITNESS_COLOR, 0.92);
  ctx.fill();
  ctx.strokeStyle = rgbaToCss(SEA_TONE, 0.85);
  ctx.lineWidth = 1;
  ctx.stroke();
}

function paintScene(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  terrain: TerrainV1,
  level: number,
  selected: PersistencePair | null,
  hoverCell: CellId | null,
  brushRadius: 1 | 2 | 4,
): void {
  const gridWidth = terrain.width;
  const gridHeight = terrain.height;
  const cellPx = Math.min(cssWidth / gridWidth, cssHeight / gridHeight);
  const cellCssX = cssWidth / gridWidth;
  const cellCssY = cssHeight / gridHeight;
  const mask = computeLandMask(terrain, level);
  const [minZ, maxZ] = elevationRange(terrain);
  const elevations = terrain.elevations;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = rgbToCss(SEA_TONE);
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  // Heat-ramped cells; sea is dimmed toward the deep-sea tone so land and water
  // differ in brightness as well as hue (PROJECT_BOOK.md §6.2 accessibility).
  for (let y = 0; y < gridHeight; y += 1) {
    const spanY = alignedCellSpan(y, gridHeight, cssHeight, dpr);
    for (let x = 0; x < gridWidth; x += 1) {
      const id = y * gridWidth + x;
      const base = heatColor(normalizedElevation(elevations[id], minZ, maxZ));
      ctx.fillStyle = rgbToCss(mask[id] === 1 ? base : seaColor(base));
      const spanX = alignedCellSpan(x, gridWidth, cssWidth, dpr);
      ctx.fillRect(spanX.start, spanY.start, spanX.end - spanX.start, spanY.end - spanY.start);
    }
  }

  // Coastline: one edge segment per land/sea contact, always visible.
  ctx.beginPath();
  for (const segment of landBoundarySegments(mask, gridWidth, gridHeight)) {
    ctx.moveTo((segment.x1 * cssWidth) / gridWidth, (segment.y1 * cssHeight) / gridHeight);
    ctx.lineTo((segment.x2 * cssWidth) / gridWidth, (segment.y2 * cssHeight) / gridHeight);
  }
  ctx.strokeStyle = rgbaToCss(COAST_COLOR, 0.9);
  ctx.lineWidth = Math.max(1, Math.min(2.5, cellPx * 0.15));
  ctx.stroke();

  // Grid lines only when zoomed in enough to stay legible.
  if (cellPx >= GRID_MIN_CELL_PX) {
    ctx.beginPath();
    for (let x = 1; x < gridWidth; x += 1) {
      const px = x * cellCssX;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssHeight);
    }
    for (let y = 1; y < gridHeight; y += 1) {
      const py = y * cellCssY;
      ctx.moveTo(0, py);
      ctx.lineTo(cssWidth, py);
    }
    ctx.strokeStyle = rgbaToCss(COAST_COLOR, 0.14);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Selected pair: peakCell star + ring, witnessCell gold diamond.
  if (selected) {
    const markRadius = Math.max(3.5, cellPx * 0.42);
    const peak = cellCenter(selected.peakCell, gridWidth);
    drawPeakMark(
      ctx,
      (peak.x * cssWidth) / gridWidth,
      (peak.y * cssHeight) / gridHeight,
      markRadius,
    );
    if (selected.witnessCell !== null) {
      const witness = cellCenter(selected.witnessCell, gridWidth);
      drawWitnessMark(
        ctx,
        (witness.x * cssWidth) / gridWidth,
        (witness.y * cssHeight) / gridHeight,
        markRadius,
      );
    }
  }

  // Dashed preview ring sized by the brush radius at the hover position.
  if (hoverCell !== null) {
    const center = cellCenter(hoverCell, gridWidth);
    ctx.beginPath();
    ctx.setLineDash([4, 3]);
    ctx.arc(
      (center.x * cssWidth) / gridWidth,
      (center.y * cssHeight) / gridHeight,
      (brushRadius + 0.5) * cellPx,
      0,
      Math.PI * 2,
    );
    ctx.strokeStyle = rgbaToCss(COAST_COLOR, 0.8);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export const TerrainCanvas = forwardRef<TerrainCanvasHandle, TerrainCanvasProps>(
  function TerrainCanvas({ terrain, level, selected, brush, onStroke }, ref) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const collectorRef = useRef<StrokeCollector>(createStrokeCollector());
    const lastPointerCellRef = useRef<CellId | null>(null);
    const [hoverCell, setHoverCell] = useState<CellId | null>(null);

    const paint = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas || typeof window === 'undefined') {
        return;
      }
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return;
      }
      const dpr = window.devicePixelRatio || 1;
      const backing = backingStoreSize(rect.width, rect.height, dpr);
      if (canvas.width !== backing.width || canvas.height !== backing.height) {
        canvas.width = backing.width;
        canvas.height = backing.height;
      }
      paintScene(
        ctx,
        rect.width,
        rect.height,
        dpr,
        terrain,
        level,
        selected,
        hoverCell,
        brush.radius,
      );
    }, [terrain, level, selected, hoverCell, brush]);

    useEffect(() => {
      paint();
    }, [paint]);

    // Keep the backing store in sync with layout/DPR changes without props churn.
    useEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || typeof ResizeObserver === 'undefined') {
        return;
      }
      const observer = new ResizeObserver(() => paint());
      observer.observe(canvas);
      return () => observer.disconnect();
    }, [paint]);

    const cellFromEvent = useCallback(
      (event: ReactPointerEvent<HTMLCanvasElement>): CellId | null => {
        const canvas = canvasRef.current;
        if (!canvas) {
          return null;
        }
        const rect = canvas.getBoundingClientRect();
        return clientPointToCell(event.clientX, event.clientY, rect, terrain.width, terrain.height);
      },
      [terrain.width, terrain.height],
    );

    const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      if (!event.isPrimary) {
        return;
      }
      event.preventDefault();
      const cell = cellFromEvent(event);
      lastPointerCellRef.current = cell;
      collectorRef.current = strokeMove(strokeStart(collectorRef.current), cell);
      const target = event.currentTarget;
      if (typeof target.setPointerCapture === 'function') {
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          // The pointer may already be gone; the stroke still runs un-captured.
        }
      }
      setHoverCell(cell);
    };

    const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const current = collectorRef.current;
      const cell = cellFromEvent(event);
      if (current.phase !== 'active') {
        setHoverCell(cell);
        return;
      }
      event.preventDefault();
      const previous = lastPointerCellRef.current;
      let next = current;
      if (cell !== null) {
        if (previous !== null && previous !== cell) {
          // Bridge the gap left by fast pointer movement.
          for (const step of lineCells(previous, cell, terrain.width)) {
            next = strokeMove(next, step);
          }
        } else {
          next = strokeMove(next, cell);
        }
      }
      collectorRef.current = next;
      lastPointerCellRef.current = cell;
      setHoverCell(cell);
    };

    const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
      const current = collectorRef.current;
      if (current.phase !== 'active') {
        return;
      }
      event.preventDefault();
      const committed = strokeCommit(current);
      collectorRef.current = committed.collector;
      lastPointerCellRef.current = null;
      if (committed.centers !== null && committed.centers.length > 0) {
        onStroke(committed.centers);
      }
    };

    const cancelActiveStroke = useCallback((): void => {
      const current = collectorRef.current;
      if (current.phase !== 'active') {
        return;
      }
      collectorRef.current = strokeCancel(current);
      lastPointerCellRef.current = null;
    }, []);

    const handlePointerCancel = useCallback((): void => {
      cancelActiveStroke();
    }, [cancelActiveStroke]);

    const handlePointerLeave = useCallback((): void => {
      cancelActiveStroke();
      setHoverCell(null);
    }, [cancelActiveStroke]);

    useImperativeHandle(
      ref,
      () => ({
        toPngBlob: () => {
          const canvas = canvasRef.current;
          if (!canvas) {
            return Promise.reject(new Error('TerrainCanvas: canvas element is not mounted'));
          }
          return canvasToPngBlob(canvas);
        },
      }),
      [],
    );

    const hoverX = hoverCell === null ? null : hoverCell % terrain.width;
    const hoverY = hoverCell === null ? null : Math.floor(hoverCell / terrain.width);
    const hoverZ = hoverCell === null ? null : terrain.elevations[hoverCell];
    const seaChip = rgbToCss(seaColor(heatColor(0.25)));

    return (
      <div className={styles.stage}>
        <div className={styles.frame}>
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            style={{ aspectRatio: `${terrain.width} / ${terrain.height}` }}
            role="img"
            aria-label={`地貌画布 ${terrain.title}：${terrain.width}×${terrain.height} 格，水位 ${level}`}
            data-testid="terrain-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onPointerLeave={handlePointerLeave}
          />
          {hoverCell !== null && hoverX !== null && hoverY !== null && hoverZ !== null ? (
            <div
              className={styles.tooltip}
              style={{
                left: `${((hoverX + 1) / terrain.width) * 100}%`,
                top: `${((hoverY + 0.5) / terrain.height) * 100}%`,
              }}
              aria-hidden="true"
            >
              ({hoverX}, {hoverY}) z={hoverZ} · {hoverZ >= level ? '陆地' : '海洋'}
            </div>
          ) : null}
        </div>
        <div className={styles.legend}>
          <span className={styles.swatch} aria-hidden="true" />
          <span>高度 0→255</span>
          <span className={styles.chip} style={{ background: rgbToCss(heatColor(0.85)) }} aria-hidden="true" />
          <span>陆地 z ≥ {level}</span>
          <span className={styles.chip} style={{ background: seaChip }} aria-hidden="true" />
          <span>海洋 z &lt; {level}</span>
        </div>
        <p className={styles.note}>抽象高度 0–255 · 4 邻接 · 非物理洪水模拟</p>
      </div>
    );
  },
);

export default TerrainCanvas;
