/**
 * T011 — 底部状态区 StatusBar（PROJECT_BOOK.md §6.1/§6.2；IMPLEMENTATION_PLAN.md
 * task card P0001-T011）。
 *
 * One presentational strip with the numbers a reader needs to trust the
 * analysis, all values received as props and computed in App from the real
 * domain layer:
 *  - the calculation status chip 就绪/计算中/错误 (§6.1 顶栏状态);
 *  - the current water level and β0(level) — β0 comes from the ORIGINAL
 *    `beta0ByLevel[level]` via `summarize()`, never from the τ-filtered
 *    feature count;
 *  - the land cell count (elevations with z ≥ level, matching the canvas
 *    `z >= level` land rule cell for cell);
 *  - the finite feature count at τ, labelled 「非 β0」 so the two counts can
 *    never be confused (§6.2: 筛选不改 β0);
 *  - the selected pair line via `describeSelectedPair`: peak cell as real
 *    grid coordinates (x = peakCell % width, y = floor(peakCell / width)),
 *    birth, and death/persistence rendered as 未定义 when they are
 *    mathematically undefined (essential pair) — never as 0, never negative;
 *  - the error message with `role="alert"` (§6.2 无障碍) whenever App holds
 *    one, e.g. a rejected import or a failed PNG export.
 */
import type { PersistencePair } from '../domain/types';

/** Props of the bottom status strip; App computes every number. */
export interface StatusBarProps {
  statusText: string;
  statusIsError: boolean;
  statusMessage: string | null;
  level: number;
  beta0: number;
  landCells: number;
  finiteCountAtTau: number;
  tau: number;
  selectedText: string | null;
}

/**
 * The selected-event line: `null` when nothing is selected, otherwise one
 * sentence naming the peak's real (x, y) coordinates, its birth and its
 * death/persistence — 未定义 for the essential pair's undefined quantities.
 */
export function describeSelectedPair(pair: PersistencePair | null, width: number): string | null {
  if (pair === null) {
    return null;
  }
  const x = pair.peakCell % width;
  const y = Math.floor(pair.peakCell / width);
  const death = pair.death === null ? '未定义' : String(pair.death);
  const persistence = pair.persistence === null ? '未定义' : String(pair.persistence);
  return `已选事件：峰 (${x},${y}) · birth ${pair.birth} · death ${death} · persistence ${persistence}`;
}

/** The bottom status strip. Purely presentational, no domain imports. */
export function StatusBar({
  statusText,
  statusIsError,
  statusMessage,
  level,
  beta0,
  landCells,
  finiteCountAtTau,
  tau,
  selectedText,
}: StatusBarProps) {
  return (
    <section className="statusBar" aria-label="底部状态区">
      <span
        className={statusIsError ? 'statusChip statusChipError' : 'statusChip'}
        role="status"
      >
        {statusText}
      </span>
      <span className="statItem">
        <span className="statLabel">当前水位</span>
        <span className="statValue" data-testid="level-value">
          {level}
        </span>
      </span>
      <span className="statItem">
        <span className="statLabel">β0（当前水位连通数）</span>
        <span className="statValue" data-testid="beta0-value">
          {beta0}
        </span>
      </span>
      <span className="statItem">
        <span className="statLabel">陆地格数（z ≥ 水位）</span>
        <span className="statValue" data-testid="land-cells-value">
          {landCells}
        </span>
      </span>
      <span className="statItem">
        <span className="statLabel">有限条码数（τ = {tau}，非 β0）</span>
        <span className="statValue" data-testid="finite-count-value">
          {finiteCountAtTau}
        </span>
      </span>
      <span className="statSelected">
        {selectedText ?? '未选中条码/事件'}
      </span>
      {statusMessage !== null ? (
        <span className="statusAlert" role="alert" data-testid="import-error">
          {statusMessage}
        </span>
      ) : null}
    </section>
  );
}

export default StatusBar;
