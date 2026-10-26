/**
 * Shared domain contracts for TopoTide (PROJECT_BOOK.md §9.1).
 *
 * This module must stay dependency-free: it never imports from validate.ts
 * (validate.ts may import these types).
 */

/** Flat cell index: id = y * width + x (row-major). */
export type CellId = number; // id=y*width+x

/** Versioned terrain field; the only schema version is 1. */
export interface TerrainV1 {
  schemaVersion: 1;
  width: number;
  height: number;
  /** Row-major integer heights, each in [0, 255]. */
  elevations: number[]; // row-major, int [0,255]
  /** 1..80 Unicode characters (counted as code points, not UTF-16 units). */
  title: string; // 1..80 Unicode characters
}

export interface PeakMeta {
  peakCell: CellId;
  birth: number;
}

export interface PersistencePair {
  /** `peak-${peakCell}` within one analysis. */
  id: string;
  peakCell: CellId;
  birth: number;
  /** null only for the essential pair. */
  death: number | null;
  /** null only for the essential pair. */
  persistence: number | null;
  /** null only for the essential pair. */
  winnerPeakCell: CellId | null;
  /** null only for the essential pair. */
  witnessCell: CellId | null;
}

export interface MergeEvent {
  /** Same as the finite pair id. */
  id: string;
  level: number;
  winnerPeakCell: CellId;
  loserPeakCell: CellId;
  /** z(witnessCell) === level. */
  witnessCell: CellId;
}

export interface PersistenceResult {
  /** One essential + all finite nonzero pairs. */
  pairs: PersistencePair[];
  merges: MergeEvent[];
  /** Length 256; index = threshold. */
  beta0ByLevel: number[];
  maxHeight: number;
  minHeight: number;
}

export type BrushMode = 'raise' | 'lower' | 'set';

export interface BrushCommand {
  mode: BrushMode;
  radius: 1 | 2 | 4;
  strength: 1 | 4 | 16;
  /** Used only for mode='set'. */
  targetHeight: number;
  /** Ordered positions traversed by one stroke. */
  centers: CellId[];
}
