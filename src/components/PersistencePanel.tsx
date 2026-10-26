/**
 * T009 — 寿命条码面板 PersistencePanel (PROJECT_BOOK.md §6.2; IMPLEMENTATION_PLAN.md
 * task card P0001-T009).
 *
 * Turns `PersistenceResult.pairs` into a clickable, keyboard-operable barcode:
 *  - the horizontal axis is the abstract height `0..255`, left → right ascending;
 *  - a FINITE bar is drawn from x(death) to x(birth) and its label always lists
 *    `birth`, `death` and `persistence = birth - death`;
 *  - the ESSENTIAL pair (`death === null`) is drawn as a dashed, arrow-tipped bar
 *    from 0 to x(birth) with the side note 「持续到过滤末端，数学死亡未定义」.
 *    It is NEVER rendered as `death=0` and no negative lifetime is ever shown:
 *    a missing mathematical death is displayed as 未定义, not as a number.
 *  - the essential pair is always pinned to the top, finite bars follow sorted
 *    by persistence descending (`sortVisiblePairs`);
 *  - finite bars are filtered through `visiblePairs(result, tau)` (essential
 *    always retained, finite retained iff persistence >= tau); the tau control
 *    only reports intent via `onTauChange(tau)` — filtering itself never
 *    touches β0, the terrain or the full `pairs` array;
 *  - every bar is a native `<button>` that calls `onSelectPair(pair.id)`, so
 *    Tab focus and Enter/Space activation come for free; the selected pair is
 *    highlighted.
 *
 * Pure helpers (`barGeometry`, `sortVisiblePairs`, the label formatters) are
 * exported and DOM-free so this repo's plain `node` vitest environment (no
 * jsdom/happy-dom; `package.json` must not change) can test them without
 * mounting. Real-browser rendering evidence is T011/T013's responsibility.
 */
import type { ChangeEvent as ReactChangeEvent, CSSProperties } from 'react';
import { visiblePairs } from '../domain/summarize';
import type { PersistencePair, PersistenceResult } from '../domain/types';
import styles from './Charts.module.css';

/* ------------------------------------------------------------------ *
 * Frozen contract (IMPLEMENTATION_PLAN.md §4.3 / task card P0001-T009)
 * ------------------------------------------------------------------ */

export interface PersistencePanelProps {
  result: PersistenceResult;
  /** Persistence threshold, integer 0..255; essential always visible. */
  tau: number;
  /** Id of the highlighted pair, or null when nothing is selected. */
  selectedPairId: string | null;
  /** Called by every barcode bar button with the pair id. */
  onSelectPair(id: string): void;
  /** Called by the tau control with the requested integer threshold. */
  onTauChange(tau: number): void;
}

/* ------------------------------------------------------------------ *
 * Axis geometry (pure, DOM-free)
 * ------------------------------------------------------------------ */

/** The horizontal axis always spans the abstract heights 0..255. */
export const AXIS_MAX_LEVEL = 255;

/** Side note rendered next to the essential bar (exact §6.2 wording). */
export const ESSENTIAL_NOTE = '持续到过滤末端，数学死亡未定义';

export interface BarGeometry {
  /** Left edge in axis units: x(death) for finite bars, 0 for essential. */
  x0: number;
  /** Right edge in axis units: x(birth) for every bar. */
  x1: number;
  /** True only for the essential pair; its death is undefined, never 0. */
  isEssential: boolean;
  birth: number;
  /** null only for the essential pair — never fabricated as 0. */
  death: number | null;
  /** birth - death for finite bars; null for essential — never negative. */
  persistence: number | null;
}

/**
 * Maps an abstract height (0..255) onto `0..axisWidth` axis units
 * (px or %): x(level) = level / 255 * axisWidth.
 * With `axisWidth === 255` the mapping is the identity x(level) === level.
 */
export function levelToAxis(level: number, axisWidth: number): number {
  return (level / AXIS_MAX_LEVEL) * axisWidth;
}

/**
 * Barcode geometry for one pair over an axis `0..axisWidth` wide:
 *  - finite: x0 = x(death), x1 = x(birth), persistence = birth - death;
 *  - essential: x0 = 0, x1 = x(birth), isEssential = true and death/persistence
 *    stay null (a missing death is NEVER reported as 0).
 */
export function barGeometry(pair: PersistencePair, axisWidth: number): BarGeometry {
  const xBirth = levelToAxis(pair.birth, axisWidth);
  if (pair.death === null || pair.persistence === null) {
    return { x0: 0, x1: xBirth, isEssential: true, birth: pair.birth, death: null, persistence: null };
  }
  return {
    x0: levelToAxis(pair.death, axisWidth),
    x1: xBirth,
    isEssential: false,
    birth: pair.birth,
    death: pair.death,
    persistence: pair.persistence,
  };
}

/**
 * Total, deterministic display order: the essential pair first (pinned top),
 * then finite bars by persistence descending, ties broken by birth descending
 * and finally by peak cell id ascending. Returns a fresh array; the input is
 * never mutated.
 */
export function sortVisiblePairs(pairs: PersistencePair[]): PersistencePair[] {
  return [...pairs].sort((a, b) => {
    if (a.death === null || b.death === null) {
      // Exactly one essential pair exists; any essential outranks the finite.
      return (a.death === null ? 0 : 1) - (b.death === null ? 0 : 1);
    }
    const byPersistence = (b.persistence ?? 0) - (a.persistence ?? 0);
    if (byPersistence !== 0) {
      return byPersistence;
    }
    return b.birth - a.birth || a.peakCell - b.peakCell;
  });
}

/* ------------------------------------------------------------------ *
 * Label formatters (pure, testable without a DOM)
 * ------------------------------------------------------------------ */

/** Row title: peak identity of the bar. */
export function barTitle(pair: PersistencePair): string {
  return `峰 peak-${pair.peakCell}（格 ${pair.peakCell}）`;
}

/** Finite bar label — always names birth, death and persistence=birth-death. */
export function finiteBarText(pair: PersistencePair): string {
  if (pair.death === null || pair.persistence === null) {
    return essentialBarText(pair);
  }
  return `birth ${pair.birth} · death ${pair.death} · persistence=${pair.persistence}`;
}

/**
 * Essential bar label — the mathematical death is undefined, so no death
 * number (and never `death=0`) and no negative lifetime ever appear here.
 */
export function essentialBarText(pair: PersistencePair): string {
  return `birth ${pair.birth} · death 未定义（${ESSENTIAL_NOTE}）`;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function PersistencePanel({
  result,
  tau,
  selectedPairId,
  onSelectPair,
  onTauChange,
}: PersistencePanelProps) {
  // Percent units: the track is the whole axis, so geometry doubles as CSS %.
  const AXIS_WIDTH_PERCENT = 100;
  const visible = sortVisiblePairs(visiblePairs(result, tau));

  const handleTau = (event: ReactChangeEvent<HTMLInputElement>) => {
    onTauChange(Number(event.currentTarget.value));
  };

  return (
    <section className={styles.panel} aria-label="寿命条码">
      <header className={styles.panelHeader}>
        <h2 className={styles.panelTitle}>寿命条码</h2>
        <span className={styles.panelMeta}>
          有限 {visible.filter((pair) => pair.death !== null).length} 条 · τ={tau}
        </span>
      </header>

      <div className={styles.tauControl}>
        <label className={styles.tauLabel} htmlFor="persistence-tau">
          持久阈值 τ（persistence ≥ τ 的有限条码可见）
        </label>
        <input
          id="persistence-tau"
          className={styles.tauRange}
          type="range"
          min={0}
          max={255}
          step={1}
          value={tau}
          aria-label="持久阈值 tau，0 到 255"
          onChange={handleTau}
        />
        <output className={styles.tauValue} htmlFor="persistence-tau">
          τ = {tau}
        </output>
      </div>

      <ol className={styles.barList}>
        {visible.map((pair) => {
          const geometry = barGeometry(pair, AXIS_WIDTH_PERCENT);
          const widthPercent = Math.max(geometry.x1 - geometry.x0, 0);
          const spanStyle: CSSProperties = {
            left: `${geometry.x0}%`,
            width: `${widthPercent}%`,
          };
          const selected = pair.id === selectedPairId;
          const text = geometry.isEssential ? essentialBarText(pair) : finiteBarText(pair);
          return (
            <li key={pair.id} className={styles.barItem}>
              <button
                type="button"
                className={selected ? `${styles.barRow} ${styles.barRowSelected}` : styles.barRow}
                aria-pressed={selected}
                data-pair-id={pair.id}
                onClick={() => onSelectPair(pair.id)}
              >
                <span className={styles.barTitle}>{barTitle(pair)}</span>
                <span className={styles.barTrack} aria-hidden="true">
                  <span
                    className={
                      geometry.isEssential
                        ? `${styles.barFill} ${styles.barFillEssential}`
                        : styles.barFill
                    }
                    style={spanStyle}
                  />
                </span>
                <span
                  className={geometry.isEssential ? styles.barTextEssential : styles.barText}
                  data-pair-id={pair.id}
                >
                  {text}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
