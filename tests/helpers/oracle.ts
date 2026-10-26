/**
 * Independent BFS oracle for T004 QA review (PROJECT_BOOK.md §10.5).
 *
 * Written independently from src/domain/persistence.ts: no DSU, no pair
 * helpers, no shared solving code. For a given threshold h it counts the
 * 4-connected components of the super-level set { p | z(p) >= h } via an
 * explicit queue-based flood-fill over a visited bitset.
 */
import type { TerrainV1 } from '../../src/domain/types';

/**
 * Count 4-connected components of cells with elevation >= level.
 * Pure flood-fill: queue + Uint8 visited bitset, row-major scan for seeds.
 */
export function beta0ByBfs(terrain: TerrainV1, level: number): number {
  const { width, height, elevations } = terrain;
  const cellCount = width * height;
  const visited = new Uint8Array(cellCount);
  const queue = new Int32Array(cellCount);

  let components = 0;
  for (let seed = 0; seed < cellCount; seed += 1) {
    if (visited[seed] !== 0 || elevations[seed] < level) {
      continue;
    }
    components += 1;
    let head = 0;
    let tail = 0;
    queue[tail] = seed;
    tail += 1;
    visited[seed] = 1;
    while (head < tail) {
      const cell = queue[head];
      head += 1;
      const x = cell % width;
      const y = (cell - x) / width;
      // 4-neighbourhood only; diagonals never connect.
      // up
      if (y > 0) {
        const n = cell - width;
        if (visited[n] === 0 && elevations[n] >= level) {
          visited[n] = 1;
          queue[tail] = n;
          tail += 1;
        }
      }
      // right
      if (x + 1 < width) {
        const n = cell + 1;
        if (visited[n] === 0 && elevations[n] >= level) {
          visited[n] = 1;
          queue[tail] = n;
          tail += 1;
        }
      }
      // down
      if (y + 1 < height) {
        const n = cell + width;
        if (visited[n] === 0 && elevations[n] >= level) {
          visited[n] = 1;
          queue[tail] = n;
          tail += 1;
        }
      }
      // left
      if (x > 0) {
        const n = cell - 1;
        if (visited[n] === 0 && elevations[n] >= level) {
          visited[n] = 1;
          queue[tail] = n;
          tail += 1;
        }
      }
    }
  }
  return components;
}
