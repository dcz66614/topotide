/**
 * T009 — 事件解释面板 EventPanel (PROJECT_BOOK.md §6.2; IMPLEMENTATION_PLAN.md
 * task card P0001-T009).
 *
 * Turns `PersistenceResult.merges` into an explanation list sorted by water
 * level descending (`sortEvents`: level desc, then loserPeakCell asc, then
 * witnessCell asc — a total order, input never mutated). Each row shows:
 *  - the loser peak (the younger peak that dies in this merge),
 *  - the winner peak (the elder peak that survives),
 *  - the witness cell as real grid coordinates `(x, y)` with
 *    `x = cell % width` and `y = Math.floor(cell / width)` — the cell that
 *    first connected the two existing islands at height `level`.
 *
 * Every row offers exactly three native `<button>`s (all Tab-focusable):
 *  1. 选中条码 → `onSelectPair(event.id)` (the event id IS the finite pair id);
 *  2. 跳到合并高度 → `onSetLevel(event.level)`;
 *  3. 上一级 h+1 → `onSetLevel(level + 1)`, disabled at level 255 because
 *     the previous level of 255 does not exist (`nextLevel` returns null).
 *
 * Pure helpers (`sortEvents`, `cellToXY`, `nextLevel`) are exported and
 * DOM-free so this repo's plain `node` vitest environment (no jsdom/happy-dom;
 * `package.json` must not change) can test them without mounting. Real-browser
 * rendering evidence is T011/T013's responsibility.
 */
import type { MergeEvent, PersistenceResult } from '../domain/types';
import styles from './Charts.module.css';

/* ------------------------------------------------------------------ *
 * Frozen contract (IMPLEMENTATION_PLAN.md §4.3 / task card P0001-T009)
 * ------------------------------------------------------------------ */

export interface EventPanelProps {
  result: PersistenceResult;
  /** Id of the highlighted pair/event, or null when nothing is selected. */
  selectedPairId: string | null;
  /** Grid width used to turn flat cell ids into (x, y) coordinates. */
  width: number;
  /** Current water level of the canvas (shown for orientation). */
  level: number;
  /** Called by the row's "选中条码" button with the event/pair id. */
  onSelectPair(id: string): void;
  /** Called by the level buttons with the requested water level. */
  onSetLevel(h: number): void;
}

/* ------------------------------------------------------------------ *
 * Pure, DOM-free helpers
 * ------------------------------------------------------------------ */

/**
 * Flattens a row-major cell id into grid coordinates:
 * x = cell % width, y = Math.floor(cell / width).
 * Throws RangeError unless cell is a non-negative integer and width >= 1.
 */
export function cellToXY(cell: number, width: number): { x: number; y: number } {
  if (!Number.isInteger(cell) || cell < 0) {
    throw new RangeError('cell must be a non-negative integer');
  }
  if (!Number.isInteger(width) || width < 1) {
    throw new RangeError('width must be an integer >= 1');
  }
  const x = cell % width;
  return { x, y: Math.floor(cell / width) };
}

/**
 * The previous filtration level h+1 — one step BEFORE the merge happened, so
 * the two peaks are still separate islands there: null at 255 and beyond,
 * because level 255 has no previous level; otherwise level + 1.
 */
export function nextLevel(level: number): number | null {
  return level >= 255 ? null : level + 1;
}

/**
 * Total, deterministic display order for merge events: level descending, then
 * loserPeakCell ascending, then witnessCell ascending. Returns a fresh array;
 * the input is never mutated.
 */
export function sortEvents(events: MergeEvent[]): MergeEvent[] {
  return [...events].sort(
    (a, b) =>
      b.level - a.level ||
      a.loserPeakCell - b.loserPeakCell ||
      a.witnessCell - b.witnessCell,
  );
}

/* ------------------------------------------------------------------ *
 * Row text (pure, testable without a DOM)
 * ------------------------------------------------------------------ */

/** One event row's explanation, including real witness coordinates. */
export function eventRowText(event: MergeEvent, width: number): string {
  const loser = cellToXY(event.loserPeakCell, width);
  const winner = cellToXY(event.winnerPeakCell, width);
  const witness = cellToXY(event.witnessCell, width);
  return (
    `高度 ${event.level}：峰 (${loser.x},${loser.y}) 被峰 (${winner.x},${winner.y}) 吞并；` +
    `witness (${witness.x},${witness.y}) — 在高度 ${event.level}，连接层某格首次使两个既存岛屿连通，较年轻山峰在此配对终止`
  );
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function EventPanel({
  result,
  selectedPairId,
  width,
  level,
  onSelectPair,
  onSetLevel,
}: EventPanelProps) {
  const events = sortEvents(result.merges);

  return (
    <section className={styles.panel} aria-label="事件解释">
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>事件解释</h2>
        <span className={styles.panelMeta}>
          {events.length} 次合并 · 当前水位 {level}
        </span>
      </header>

      <ol className={styles.eventList}>
        {events.map((event) => {
          const selected = event.id === selectedPairId;
          const previous = nextLevel(event.level);
          return (
            <li key={event.id} className={styles.eventItem}>
              <div
                className={selected ? `${styles.eventRow} ${styles.eventRowSelected}` : styles.eventRow}
                data-event-id={event.id}
              >
                <p className={styles.eventText}>{eventRowText(event, width)}</p>
                <div className={styles.eventActions}>
                  <button
                    type="button"
                    className={styles.eventButton}
                    data-event-id={event.id}
                    onClick={() => onSelectPair(event.id)}
                  >
                    选中条码 peak-{event.loserPeakCell}
                  </button>
                  <button
                    type="button"
                    className={styles.eventButton}
                    onClick={() => onSetLevel(event.level)}
                  >
                    跳到合并高度 h={event.level}
                  </button>
                  <button
                    type="button"
                    className={styles.eventButton}
                    disabled={previous === null}
                    onClick={() => {
                      if (previous !== null) {
                        onSetLevel(previous);
                      }
                    }}
                  >
                    上一级 {previous === null ? '不可用' : `h=${previous}`}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
