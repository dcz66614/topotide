/**
 * T012 — 基线对照面板 ComparePanel (PROJECT_BOOK.md §4.1, §6.1, FR-09;
 * IMPLEMENTATION_PLAN.md task card P0001-T012, props frozen in §4.3).
 *
 * Counterfactual A/B view over the CURRENT analysis and a FROZEN baseline:
 *   - the baseline is `{ terrain: deep copy, result: deep copy }`, produced once
 *     by `freezeBaseline()` when App's 冻结为基线 button is pressed. It is owned
 *     by App state and is structurally impossible to reach by undo/redo, a
 *     stroke, reset, a preset switch or an import: those only touch the editor;
 *     only re-freezing or clearing the baseline can change it.
 *   - the panel shows BOTH sides' `finiteCountAtTau`, `longestFinitePersistence`
 *     and `beta0(level)` (computed by the T007 `summarize()`: beta0 always comes
 *     from the ORIGINAL `beta0ByLevel[level]`, the tau threshold never touches
 *     it), plus two native SVG 256-point polylines over the horizontal axis
 *     0..255 — no chart library (task card: 不引入复杂图表库).
 *   - with no baseline the panel renders guidance text ONLY: no summary table
 *     and never a fake `0 vs 0` comparison (task card: 不输出虚假 0 vs 0).
 *   - ONLY summary statistics are compared. Peaks of two different terrains are
 *     never matched against each other (no peak-to-peak correspondence is
 *     claimed anywhere — FR-09: 未匹配峰时不声称对应).
 *
 * The component NEVER mutates the传入 terrain/result objects (§4.3: 组件不得
 * 改变传入的 terrain 和 result); it only reads them through pure helpers.
 *
 * Pure, DOM-free exports (`freezeBaseline`, `compareSummaries`,
 * `beta0PolylinePoints`, the `NO_BASELINE_GUIDE` text) exist so this repo's
 * plain `node` vitest environment (no jsdom/happy-dom; `package.json` must not
 * change) can pin the whole contract without mounting; real-browser rendering
 * and screenshots are T013's responsibility.
 */
import type { PersistenceResult, TerrainV1 } from '../domain/types';
import { summarize } from '../domain/summarize';
import styles from './ComparePanel.module.css';

/* ------------------------------------------------------------------ *
 * Frozen contract (IMPLEMENTATION_PLAN.md §4.3 / task card P0001-T012)
 * ------------------------------------------------------------------ */

/**
 * One side of the comparison: a terrain plus ITS OWN analysis. App freezes a
 * deep copy of both; `current` is the live editor terrain with its memoized
 * analysis. Structurally exactly the §4.3 inline type.
 */
export interface BaselineSnapshot {
  terrain: TerrainV1;
  result: PersistenceResult;
}

/** The §4.3 ComparePanelProps, verbatim. */
export interface ComparePanelProps {
  /** Frozen baseline or null before the first 冻结为基线. */
  baseline: BaselineSnapshot | null;
  /** Live editor terrain plus its current analysis. */
  current: BaselineSnapshot;
  /** Water level for the beta0 row (integer 0..255). */
  level: number;
  /** Persistence threshold for the finite-feature rows (integer 0..255). */
  tau: number;
}

/* ------------------------------------------------------------------ *
 * Pure helper 1 — freezeBaseline (deep copy, no mutation)
 * ------------------------------------------------------------------ */

/**
 * Deep copy of a terrain: TerrainV1's only nested storage is `elevations`, so
 * copying the scalars plus slicing that array is a full deep copy (same rule
 * the T010 editor uses). The input is only ever read.
 */
function cloneTerrain(terrain: TerrainV1): TerrainV1 {
  return {
    schemaVersion: terrain.schemaVersion,
    width: terrain.width,
    height: terrain.height,
    elevations: terrain.elevations.slice(),
    title: terrain.title,
  };
}

/**
 * Deep copy of an analysis result: `pairs`, `merges` and `beta0ByLevel` are
 * cloned (task card: 对 result 做 pairs/merges/beta0ByLevel 深拷贝); every
 * pair/merge field is a primitive, so per-item spreads are complete copies.
 * `maxHeight`/`minHeight` are primitives. The input is only ever read.
 */
function cloneResult(result: PersistenceResult): PersistenceResult {
  return {
    pairs: result.pairs.map((pair) => ({ ...pair })),
    merges: result.merges.map((merge) => ({ ...merge })),
    beta0ByLevel: result.beta0ByLevel.slice(),
    maxHeight: result.maxHeight,
    minHeight: result.minHeight,
  };
}

/**
 * Freezes the current state as the A/B baseline: returns `{ terrain, result }`
 * where NOTHING is shared by reference with the inputs. Later strokes, undo/
 * redo, resets, preset switches, imports and re-analyses therefore cannot
 * alter a frozen baseline (FR-09: 基线数组不可被后续画笔改变) — the frozen
 * arrays only change when App re-freezes or clears it.
 *
 * Pure: never mutates `terrain` or `result`.
 */
export function freezeBaseline(terrain: TerrainV1, result: PersistenceResult): BaselineSnapshot {
  return { terrain: cloneTerrain(terrain), result: cloneResult(result) };
}

/* ------------------------------------------------------------------ *
 * Pure helper 2 — compareSummaries (summary only, no peak matching)
 * ------------------------------------------------------------------ */

/** Summary of one side, exactly the T007 `summarize()` fields. */
export interface SideSummary {
  /** Original beta0ByLevel[level]; the tau threshold never changes it. */
  beta0: number;
  /** Visible finite pairs at tau (essential excluded, as in summarize()). */
  finiteCountAtTau: number;
  /** Longest visible finite persistence, 0 when none is visible. */
  longestFinitePersistence: number;
}

/** Both sides' summaries; `baseline` is null when no baseline was frozen. */
export interface ComparedSummaries {
  current: SideSummary;
  /** null — NOT a zeroed summary — when the baseline side does not exist. */
  baseline: SideSummary | null;
}

/**
 * Summarizes BOTH results at the same `tau`/`level` through the T007
 * `summarize()` (so beta0 comes from each ORIGINAL `beta0ByLevel[level]` and is
 * never influenced by tau). A null baseline result yields `baseline: null` —
 * the caller must render guidance instead of inventing `0 vs 0`.
 *
 * Summary statistics ONLY: no peak, merge or witness of one terrain is ever
 * paired with one of the other terrain (they are different topologies; FR-09).
 *
 * Pure: never mutates either result. Throws RangeError for tau/level outside
 * 0..255 (propagated from summarize()).
 */
export function compareSummaries(
  currentResult: PersistenceResult,
  baselineResult: PersistenceResult | null,
  tau: number,
  level: number,
): ComparedSummaries {
  return {
    current: summarize(currentResult, tau, level),
    baseline: baselineResult === null ? null : summarize(baselineResult, tau, level),
  };
}

/* ------------------------------------------------------------------ *
 * Pure helper 3 — beta0PolylinePoints (native SVG polyline)
 * ------------------------------------------------------------------ */

/** The beta0 curve domain: exactly 256 levels, index = level 0..255. */
export const BETA0_LEVEL_COUNT = 256;

/** Chart box used by the panel (viewBox units; scaled by CSS to fit). */
export const CHART_WIDTH = 512;
export const CHART_HEIGHT = 128;

/** Rounds to 2 decimals so integer mappings stay exact in the output string. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Builds the `points` attribute string of one native SVG `<polyline>` for a
 * beta0 curve: exactly BETA0_LEVEL_COUNT points, one per level i in 0..255,
 *   x(i) = (i / 255) * width          (horizontal axis 0..255),
 *   y(i) = height - (v(i)/max) * height  (normalized by the maximum value;
 *          larger beta0 is HIGHER on screen, SVG y grows downward),
 * and when max === 0 every y equals `height` (the bottom baseline) — a flat
 * curve, never NaN. Points are "x,y" pairs separated by single spaces.
 *
 * Pure: never mutates the input array. Throws RangeError unless the input is
 * an array of exactly 256 finite numbers and width/height are positive finite.
 */
export function beta0PolylinePoints(
  beta0ByLevel: readonly number[],
  width: number,
  height: number,
): string {
  if (!Array.isArray(beta0ByLevel) || beta0ByLevel.length !== BETA0_LEVEL_COUNT) {
    throw new RangeError(`beta0ByLevel must be an array of exactly ${BETA0_LEVEL_COUNT} levels`);
  }
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError('width and height must be positive finite numbers');
  }
  let max = 0;
  for (const value of beta0ByLevel) {
    if (!Number.isFinite(value)) {
      throw new RangeError('beta0ByLevel must contain only finite numbers');
    }
    if (value > max) {
      max = value;
    }
  }
  const points: string[] = [];
  for (let level = 0; level < BETA0_LEVEL_COUNT; level += 1) {
    const x = (level / (BETA0_LEVEL_COUNT - 1)) * width;
    const y =
      max > 0 ? height - (beta0ByLevel[level] / max) * height : height; // flat bottom
    points.push(`${round2(x)},${round2(y)}`);
  }
  return points.join(' ');
}

/* ------------------------------------------------------------------ *
 * Empty-state guidance (no fake 0 vs 0)
 * ------------------------------------------------------------------ */

/**
 * Guidance shown when no baseline is frozen. Pure data, so the node test suite
 * can pin that the empty state instructs the user instead of comparing
 * anything — it contains no `0 vs 0`-style fabricated numbers.
 */
export const NO_BASELINE_GUIDE =
  '尚未冻结基线：点击上方「冻结为基线」，把当前地貌与其持久性分析结果' +
  '（地形高程、条码对、合并事件、β0 曲线）完整深拷贝保存为对照基准。' +
  '之后继续编辑当前地图（笔划、撤销/重做、重置、切样例、导入都不会改动基线），' +
  '这里将并排显示当前与基线的有限条码数、最长有限寿命和 β0 曲线。' +
  '只有「冻结为基线」重新冻结或「清除基线」会改变基线。';

/* ------------------------------------------------------------------ *
 * Small display helpers (pure, shared with the node tests)
 * ------------------------------------------------------------------ */

/** Text of one summary value; a missing side renders —, never a fake 0. */
export function summaryValueText(value: number | null): string {
  return value === null ? '—' : String(value);
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function ComparePanel({ baseline, current, level, tau }: ComparePanelProps) {
  // No mutation anywhere below: both snapshots are only read.
  if (baseline === null) {
    return (
      <div className={styles.panel} data-testid="compare-panel-empty">
        <h3 className={styles.title}>基线对照</h3>
        <p className={styles.guide}>{NO_BASELINE_GUIDE}</p>
        <p className={styles.hint}>
          对照仅在冻结基线后出现；不会显示「0 vs 0」之类的虚构对照。
        </p>
      </div>
    );
  }

  const compared = compareSummaries(current.result, baseline.result, tau, level);
  const currentPoints = beta0PolylinePoints(current.result.beta0ByLevel, CHART_WIDTH, CHART_HEIGHT);
  const baselinePoints = beta0PolylinePoints(
    baseline.result.beta0ByLevel,
    CHART_WIDTH,
    CHART_HEIGHT,
  );

  const rows: ReadonlyArray<{ label: string; hint: string; key: keyof SideSummary }> = [
    {
      key: 'finiteCountAtTau',
      label: `有限条码数（τ=${tau}）`,
      hint: 'persistence ≥ τ 的有限条码数；essential 不计入',
    },
    {
      key: 'longestFinitePersistence',
      label: '最长有限寿命',
      hint: '可见有限条码的最大 persistence，无可见条码时为 0',
    },
    {
      key: 'beta0',
      label: `β0（水位 h=${level}）`,
      hint: '取各自原始 beta0ByLevel[level]，不受 τ 筛选影响',
    },
  ];

  return (
    <div className={styles.panel} data-testid="compare-panel">
      <h3 className={styles.title}>基线对照</h3>
      <p className={styles.meta}>
        基线地形：{baseline.terrain.title}（{baseline.terrain.width}×{baseline.terrain.height}）·
        当前地形：{current.terrain.title}（{current.terrain.width}×{current.terrain.height}）
      </p>
      <p className={styles.meta}>
        只比较两组摘要统计；两幅地形不做任何峰到峰的对应。
      </p>

      <table className={styles.summaryTable}>
        <thead>
          <tr>
            <th scope="col" className={styles.metricHead}>指标</th>
            <th scope="col" className={styles.currentHead}>当前</th>
            <th scope="col" className={styles.baselineHead}>基线</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} title={row.hint}>
              <th scope="row" className={styles.metricCell}>{row.label}</th>
              <td className={styles.currentCell}>
                {summaryValueText(compared.current[row.key])}
              </td>
              <td className={styles.baselineCell}>
                {summaryValueText(compared.baseline === null ? null : compared.baseline[row.key])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <figure className={styles.chartBlock}>
        <svg
          className={styles.chart}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          role="img"
          aria-label={`β0 曲线对比（横轴 0..255）：当前与基线两条折线，纵轴为 β0 值，按各线最大值归一化`}
        >
          <polyline
            className={styles.lineBaseline}
            points={baselinePoints}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <polyline
            className={styles.lineCurrent}
            points={currentPoints}
            fill="none"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
        <figcaption className={styles.legend}>
          <span className={styles.legendItem}>
            <span className={styles.swatchCurrent} aria-hidden="true" /> 当前
          </span>
          <span className={styles.legendItem}>
            <span className={styles.swatchBaseline} aria-hidden="true" /> 基线（冻结）
          </span>
          <span className={styles.axisNote}>横轴 0..255 · 纵轴 β0（各线按最大值归一化）</span>
        </figcaption>
      </figure>
    </div>
  );
}

export default ComparePanel;
