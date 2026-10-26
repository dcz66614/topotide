/**
 * H0 persistent homology (0-dimensional barcode) for TerrainV1
 * (implementation plan §4.2: two-phase union-find filtration).
 *
 * The 256 discrete elevation levels are processed from high to low. For every
 * level h four phases run:
 *
 *   1. activate - every cell with elevation === h becomes its own component.
 *   2. same-level - 4-adjacent same-height new cells are unioned. These
 *      new-new unions carry no metadata and never emit an event: plateaus
 *      must not spawn zero-lifetime pseudo-barcodes.
 *   3. bridge - every new cell is unioned with each strictly higher
 *      4-neighbour (up, right, down, left). Connecting a fresh patch to old
 *      components only transfers the existing metadata, never creates a peak.
 *      When the patch bridges two components that already carry DIFFERENT
 *      metadata, the younger peak dies: a finite persistence pair and a
 *      MergeEvent are emitted, witnessed by the new cell (it sits at the
 *      current level and is 4-adjacent to the old side). The elder meta
 *      (higher birth; tie: smaller peakCell) migrates onto the physical union
 *      root, which is chosen by component size and is NOT necessarily the
 *      metadata winner. A patch touching k old components therefore records
 *      exactly k-1 merges.
 *   4. birth - every resulting root reached from this level's cells that
 *      still carries no metadata gets { peakCell: smallest member id,
 *      birth: h }: peaks are born only at the end of their level.
 *
 * Both roots' metadata is always read before any parent pointer changes.
 * After level 0 exactly one component survives (a full rectangle is
 * 4-connected) and its metadata becomes the single essential pair.
 *
 * Complexity: O(N * alpha(N)) union-find work for N = width * height cells,
 * plus O(N) bucketing and O(K log K) sorting of the K emitted pairs and
 * merges - near-linear in N.
 *
 * The function is pure: validateTerrain() returns a fresh independent copy,
 * so the caller's terrain and elevations are never mutated, and the result
 * ordering is fully deterministic (buckets are built in ascending cell-id
 * order and every sort is total).
 */
import type {
  CellId,
  MergeEvent,
  PersistencePair,
  PersistenceResult,
  TerrainV1,
} from './types';
import { validateTerrain } from './validate';

/** Metadata carried by a DSU root: the peak born for its component. */
interface RootMeta {
  peakCell: CellId;
  birth: number;
}

/** Witness sentinel for same-level unions, which can never emit an event. */
const NO_WITNESS = -1;

const LEVELS = 256;
const MAX_LEVEL = 255;

export function analyzePersistence(terrain: TerrainV1): PersistenceResult {
  // Fresh validated copy: the caller's terrain/elevations are never mutated.
  const clean = validateTerrain(terrain);
  const width = clean.width;
  const height = clean.height;
  const elevations = clean.elevations;
  const cellCount = width * height;

  // Bucket cell ids by elevation; scanning ids in ascending order keeps every
  // bucket sorted, which makes the whole filtration deterministic.
  const buckets: number[][] = Array.from({ length: LEVELS }, () => [] as number[]);
  for (let cell = 0; cell < cellCount; cell += 1) {
    buckets[elevations[cell]].push(cell);
  }

  // DSU state. parent === -1 marks a not-yet-activated cell; parent === self
  // marks an activated root.
  const parent = new Int32Array(cellCount).fill(-1);
  const componentSize = new Int32Array(cellCount);
  const minCandidate = new Int32Array(cellCount);
  for (let cell = 0; cell < cellCount; cell += 1) {
    minCandidate[cell] = cell;
  }
  const meta: (RootMeta | null)[] = new Array<RootMeta | null>(cellCount).fill(null);

  const find = (start: number): number => {
    let root = start;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let node = start;
    while (parent[node] !== root) {
      const next: number = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };

  let components = 0;
  const finitePairs: PersistencePair[] = [];
  const merges: MergeEvent[] = [];

  /**
   * Union the components of `a` and `b`. `witness` is the current-level cell
   * whose adjacency caused the connection (NO_WITNESS for same-level unions,
   * which can never emit an event). Both roots' metadata is read before any
   * parent changes; the metadata winner (elder) is independent of the
   * size-chosen physical root.
   */
  const union = (a: number, b: number, level: number, witness: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) {
      return;
    }
    // Read both roots' old meta BEFORE changing parent.
    const metaA: RootMeta | null = meta[rootA];
    const metaB: RootMeta | null = meta[rootB];

    // Physical root by component size; ties keep a's root (deterministic).
    let physical = rootA;
    let attached = rootB;
    if (componentSize[physical] < componentSize[attached]) {
      const swap = physical;
      physical = attached;
      attached = swap;
    }
    parent[attached] = physical;
    componentSize[physical] += componentSize[attached];
    if (minCandidate[attached] < minCandidate[physical]) {
      minCandidate[physical] = minCandidate[attached];
    }
    components -= 1;

    if (metaA !== null && metaB !== null && metaA.peakCell !== metaB.peakCell) {
      // Two different existing peaks meet: the younger one dies here.
      if (witness === NO_WITNESS) {
        throw new Error('internal error: peak merge without a witness cell');
      }
      const elderIsA =
        metaA.birth > metaB.birth ||
        (metaA.birth === metaB.birth && metaA.peakCell < metaB.peakCell);
      const elder = elderIsA ? metaA : metaB;
      const younger = elderIsA ? metaB : metaA;
      const id = `peak-${younger.peakCell}`;
      finitePairs.push({
        id,
        peakCell: younger.peakCell,
        birth: younger.birth,
        death: level,
        persistence: younger.birth - level,
        winnerPeakCell: elder.peakCell,
        witnessCell: witness,
      });
      merges.push({
        id,
        level,
        winnerPeakCell: elder.peakCell,
        loserPeakCell: younger.peakCell,
        witnessCell: witness,
      });
      // Migrate the elder meta onto the physical union root; the attached
      // root is no longer a root, so drop its stale meta.
      meta[physical] = elder;
      meta[attached] = null;
    } else if (metaA !== null || metaB !== null) {
      // New-old connection: only transfer existing meta, never create a peak.
      meta[physical] = metaA !== null ? metaA : metaB;
      meta[attached] = null;
    }
    // Both sides null (new-new): no event; birth is assigned in phase 4.
  };

  const beta0ByLevel: number[] = new Array<number>(LEVELS);
  const stampedRoot = new Int32Array(cellCount).fill(-1);

  for (let level = MAX_LEVEL; level >= 0; level -= 1) {
    const bucket = buckets[level];

    // Phase 1: activate this level's cells.
    for (const cell of bucket) {
      parent[cell] = cell;
      componentSize[cell] = 1;
      meta[cell] = null;
      minCandidate[cell] = cell;
      components += 1;
    }

    // Phase 2: same-height unions between new cells; no events, no peaks.
    for (const cell of bucket) {
      const x = cell % width;
      const y = (cell - x) / width;
      if (x + 1 < width && elevations[cell + 1] === level) {
        union(cell, cell + 1, level, NO_WITNESS); // right
      }
      if (y + 1 < height && elevations[cell + width] === level) {
        union(cell, cell + width, level, NO_WITNESS); // down
      }
    }

    // Phase 3: bridge new cells to strictly higher (already active) cells.
    for (const cell of bucket) {
      const x = cell % width;
      const y = (cell - x) / width;
      if (y > 0 && elevations[cell - width] > level) {
        union(cell, cell - width, level, cell); // up
      }
      if (x + 1 < width && elevations[cell + 1] > level) {
        union(cell, cell + 1, level, cell); // right
      }
      if (y + 1 < height && elevations[cell + width] > level) {
        union(cell, cell + width, level, cell); // down
      }
      if (x > 0 && elevations[cell - 1] > level) {
        union(cell, cell - 1, level, cell); // left
      }
    }

    // Phase 4: peaks are born only now, for roots that carry no meta yet.
    for (const cell of bucket) {
      const root = find(cell);
      if (stampedRoot[root] === level) {
        continue;
      }
      stampedRoot[root] = level;
      if (meta[root] === null) {
        meta[root] = { peakCell: minCandidate[root], birth: level };
      }
    }

    beta0ByLevel[level] = components;
  }

  // Exactly one component survives (a full rectangle is 4-connected); its
  // metadata becomes the single essential pair.
  const essentialMetas: RootMeta[] = [];
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (parent[cell] === cell) {
      const rootMeta = meta[cell];
      if (rootMeta === null) {
        throw new Error('internal error: surviving root without peak metadata');
      }
      essentialMetas.push(rootMeta);
    }
  }
  if (essentialMetas.length !== 1) {
    throw new Error(
      `internal error: expected exactly one essential component, found ${essentialMetas.length}`,
    );
  }
  const essential = essentialMetas[0];

  finitePairs.sort((a, b) => {
    const persistenceA = a.persistence ?? 0;
    const persistenceB = b.persistence ?? 0;
    return persistenceB - persistenceA || a.peakCell - b.peakCell;
  });
  merges.sort(
    (a, b) =>
      b.level - a.level ||
      a.loserPeakCell - b.loserPeakCell ||
      a.witnessCell - b.witnessCell,
  );

  let maxHeight = elevations[0];
  let minHeight = elevations[0];
  for (let cell = 1; cell < cellCount; cell += 1) {
    const value = elevations[cell];
    if (value > maxHeight) {
      maxHeight = value;
    }
    if (value < minHeight) {
      minHeight = value;
    }
  }

  const essentialPair: PersistencePair = {
    id: `peak-${essential.peakCell}`,
    peakCell: essential.peakCell,
    birth: essential.birth,
    death: null,
    persistence: null,
    winnerPeakCell: null,
    witnessCell: null,
  };

  return {
    pairs: [essentialPair, ...finitePairs],
    merges,
    beta0ByLevel,
    maxHeight,
    minHeight,
  };
}
