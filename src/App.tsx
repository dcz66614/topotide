/**
 * T011 — 主页面接线 App（PROJECT_BOOK.md §6, FR01–08/10/11/12；IMPLEMENTATION_PLAN.md
 * task card P0001-T011）。
 * T012 — 基线对照接入（IMPLEMENTATION_PLAN.md task card P0001-T012, §4.3/§4.4）：
 *   App owns the frozen baseline in its own `useState` (`baseline`, below),
 *   completely independent of the T010 editor history. undo/redo, strokes,
 *   reset, preset switches and imports never write it; ONLY the two handlers
 *   `handleFreezeBaseline` (re-freeze: `freezeBaseline()` deep copy of the
 *   current terrain + its memoized analysis) and `handleClearBaseline` change
 *   it. The freeze/clear buttons live inside the 基线对照 tab; ComparePanel
 *   receives the frozen snapshot plus the live `{ terrain, result }` pair and
 *   shows the A/B summary + the two β0 polylines (no peak correspondence).
 *
 * State owned here (all initial values from the task card):
 *   level = 160, tau = 1, selectedPairId = null,
 *   status ∈ { ready → 就绪, computing → 计算中, error → 错误 },
 *   brush = { mode 'raise', radius 1, strength 4, targetHeight 128 }.
 * The terrain lives in `useTerrainEditor` (T010) whose creation-time initial is
 * the twin-peaks preset; reset() therefore always returns to twin-peaks while
 * preset switching goes through replaceTerrain() and does NOT change that.
 *
 * Wiring rules implemented below:
 *   - `result = useMemo(() => analyzePersistence(terrain), [terrain])` — one
 *     analysis per terrain, recomputed once per committed stroke (§6.3);
 *   - a `useEffect` on `terrain` clears `selectedPairId`: pair/event ids derive
 *     from the current analysis, so old ids must not survive a stroke, an undo,
 *     a reset, a preset switch or a successful import (§6.2 事件跟随);
 *   - selecting a FINITE pair moves the water level to its death
 *     (`selectPairLevel`), selecting the essential pair only highlights it;
 *   - a pure level change (EventPanel 跳到合并高度/上一级, the toolbar slider
 *     and number input) never clears the selection;
 *   - a stroke with empty centers does nothing; a rejected one surfaces the
 *     TerrainValidationError code/field/message through the error status while
 *     the editor guarantees terrain and history stay untouched;
 *   - a failed import keeps the current terrain AND selection and only reports
 *     the error's field/reason — file content is never echoed (§9.2);
 *   - JSON/CSV/PNG exports go through `downloadBlob` (Blob → object URL →
 *     temporary `<a download>` click → revokeObjectURL); a failed PNG export
 *     sets the error status;
 *   - window keyboard shortcuts work only outside inputs/textareas/selects/
 *     contentEditable: Escape clears the selection, Ctrl/Cmd+Z undo,
 *     Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo (§6.3). Arrow keys on the native
 *     range input already step the level by 1 — no custom handler is added.
 *
 * The pure helpers `clampInt`/`clampLevel`/`countLandCells`/`selectPairLevel`/
 * `formatTerrainError` plus the initial-state constants are exported so the
 * node-mode integration suite (no jsdom, nothing mounted) can pin these
 * contracts; real-browser evidence is T013's job.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ComparePanel, freezeBaseline } from './components/ComparePanel';
import type { BaselineSnapshot } from './components/ComparePanel';
import compareStyles from './components/ComparePanel.module.css';
import { EditToolbar, downloadBlob } from './components/EditToolbar';
import type { BrushSetting } from './components/EditToolbar';
import { EventPanel } from './components/EventPanel';
import { PersistencePanel } from './components/PersistencePanel';
import { StatusBar, describeSelectedPair } from './components/StatusBar';
import { TerrainCanvas } from './components/TerrainCanvas';
import type { TerrainCanvasHandle } from './components/TerrainCanvas';
import { analyzePersistence } from './domain/persistence';
import { makePreset } from './domain/presets';
import type { PresetName } from './domain/presets';
import { exportPairsCsv, exportTerrainJson, importTerrainJson } from './domain/serialization';
import { summarize } from './domain/summarize';
import type { CellId, PersistencePair, TerrainV1 } from './domain/types';
import { TerrainValidationError } from './domain/validate';
import { useTerrainEditor } from './hooks/useTerrainEditor';

/* ------------------------------------------------------------------ *
 * Exported initial-state constants and small pure helpers
 * ------------------------------------------------------------------ */

/** Initial water level (task card P0001-T011). */
export const INITIAL_LEVEL = 160;
/** Initial persistence threshold (task card P0001-T011). */
export const INITIAL_TAU = 1;
/** The preset the editor is created with; reset() always returns to it. */
export const INITIAL_PRESET_NAME: PresetName = 'twin-peaks';
/** Initial brush settings (task card P0001-T011). */
export const INITIAL_BRUSH: BrushSetting = {
  mode: 'raise',
  radius: 1,
  strength: 4,
  targetHeight: 128,
};

/** Calculation status of the page; display texts stay in Chinese (§6.1). */
export type AppStatusKind = 'ready' | 'computing' | 'error';

/** Chinese display text for every status kind. */
export const STATUS_TEXT: Readonly<Record<AppStatusKind, string>> = {
  ready: '就绪',
  computing: '计算中',
  error: '错误',
};

/** Status plus the (optional) human-readable reason shown with role="alert". */
export interface AppStatus {
  kind: AppStatusKind;
  message: string | null;
}

const READY_STATUS: AppStatus = { kind: 'ready', message: null };

/** Which right-panel tab is open; 基线对照 stays an empty state until T012. */
type PanelTab = 'barcode' | 'events' | 'baseline';

const PANEL_TABS: ReadonlyArray<{ id: PanelTab; label: string }> = [
  { id: 'barcode', label: '寿命条码' },
  { id: 'events', label: '事件解释' },
  { id: 'baseline', label: '基线对照' },
];

/**
 * Rounds to the nearest integer and clamps into [min, max]. Used to keep
 * `level` and `tau` inside the ranges the domain layer asserts (integers
 * 0..255); non-finite input falls back to `min`.
 */
export function clampInt(value: number, min: number, max: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : min;
  return rounded < min ? min : rounded > max ? max : rounded;
}

/** Clamps a requested water level into the filtration range 0..255. */
export function clampLevel(value: number): number {
  return clampInt(value, 0, 255);
}

/**
 * Land cells at `level`: elevations with z >= level — the exact same rule the
 * canvas land mask uses, so the status bar and the picture never disagree.
 */
export function countLandCells(terrain: TerrainV1, level: number): number {
  let count = 0;
  const elevations = terrain.elevations;
  for (let index = 0; index < elevations.length; index += 1) {
    if (elevations[index] >= level) {
      count += 1;
    }
  }
  return count;
}

/**
 * Water level to apply when the user selects a pair: a finite pair's death
 * (finite pairs always have a non-null death), the current level for the
 * essential pair — selecting it only highlights, it never moves the water.
 */
export function selectPairLevel(pair: PersistencePair, currentLevel: number): number {
  return pair.death ?? currentLevel;
}

/**
 * One-line rendering of a TerrainValidationError: code, field and reason only.
 * Domain messages never echo input content, so nothing here can leak the
 * rejected file's text either.
 */
export function formatTerrainError(error: TerrainValidationError): string {
  const prefix = error.field === undefined ? error.code : `${error.code} · 字段 ${error.field}`;
  return `${prefix}：${error.message}`;
}

/** True while keyboard focus sits in a text-entry control (§6.3 shortcuts off). */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export function App() {
  // Created once; `reset()` restores this twin-peaks terrain forever.
  const [initialTerrain] = useState<TerrainV1>(() => makePreset(INITIAL_PRESET_NAME));
  const editor = useTerrainEditor(initialTerrain);
  const terrain = editor.terrain;

  const [level, setLevel] = useState(INITIAL_LEVEL);
  const [tau, setTau] = useState(INITIAL_TAU);
  const [selectedPairId, setSelectedPairId] = useState<string | null>(null);
  const [status, setStatus] = useState<AppStatus>(READY_STATUS);
  const [brush, setBrush] = useState<BrushSetting>(INITIAL_BRUSH);
  const [presetName, setPresetName] = useState<PresetName>(INITIAL_PRESET_NAME);
  const [activeTab, setActiveTab] = useState<PanelTab>('barcode');

  // Frozen A/B baseline (T012). Deliberately NOT part of the editor: no
  // undo/redo, stroke, reset, preset switch or import writes this state —
  // only handleFreezeBaseline / handleClearBaseline below ever call
  // setBaseline, so a frozen baseline cannot be polluted by history (§4.4).
  const [baseline, setBaseline] = useState<BaselineSnapshot | null>(null);

  const canvasRef = useRef<TerrainCanvasHandle | null>(null);

  // One analysis per terrain; strokes commit on pointerup, so this runs once
  // per committed stroke (§6.3), never per pointermove.
  const result = useMemo(() => analyzePersistence(terrain), [terrain]);

  // Pair/event ids derive from the current analysis: any terrain change makes
  // every old id stale, so the selection must not survive it (§6.2 事件跟随).
  useEffect(() => {
    setSelectedPairId(null);
  }, [terrain]);

  const selected = useMemo<PersistencePair | null>(
    () => result.pairs.find((pair) => pair.id === selectedPairId) ?? null,
    [result, selectedPairId],
  );

  // β0 comes from the ORIGINAL beta0ByLevel[level] inside summarize(); the tau
  // filter only changes finiteCountAtTau (§6.2 筛选).
  const summary = useMemo(() => summarize(result, tau, level), [result, tau, level]);
  const landCells = useMemo(() => countLandCells(terrain, level), [terrain, level]);
  const selectedText = describeSelectedPair(selected, terrain.width);

  /* ---------------- handlers (all intents, no local domain logic) ---------- */

  const handleBrushChange = useCallback((patch: Partial<BrushSetting>) => {
    setBrush((previous) => ({ ...previous, ...patch }));
  }, []);

  const handleStroke = useCallback(
    (centers: CellId[]) => {
      if (centers.length === 0) {
        return; // nothing was drawn — not a history step, not an error
      }
      try {
        editor.stroke({ ...brush, centers });
        setStatus(READY_STATUS);
      } catch (error) {
        // The editor applies the command before touching any state, so terrain
        // and history are untouched; App's job is to surface the reason.
        if (error instanceof TerrainValidationError) {
          setStatus({ kind: 'error', message: formatTerrainError(error) });
          return;
        }
        throw error;
      }
    },
    [brush, editor],
  );

  const handleUndo = useCallback(() => {
    editor.undo();
  }, [editor]);

  const handleRedo = useCallback(() => {
    editor.redo();
  }, [editor]);

  const handleReset = useCallback(() => {
    editor.reset(); // back to the creation-time twin-peaks terrain
    setSelectedPairId(null);
    setStatus(READY_STATUS);
  }, [editor]);

  const handlePresetChange = useCallback(
    (name: PresetName) => {
      setPresetName(name);
      editor.replaceTerrain(makePreset(name));
      setSelectedPairId(null);
      setStatus(READY_STATUS);
      // Deliberately NOT the editor's initial: reset() still returns to the
      // start-up twin-peaks terrain (hook contract, see the toolbar hint line).
    },
    [editor],
  );

  const handleSelectPair = useCallback(
    (id: string) => {
      setSelectedPairId(id);
      const pair = result.pairs.find((candidate) => candidate.id === id);
      if (pair !== undefined) {
        // Finite pair → jump to its death; essential pair → keep the level.
        setLevel((current) => selectPairLevel(pair, current));
      }
    },
    [result.pairs],
  );

  const handleSetLevel = useCallback((next: number) => {
    setLevel(clampLevel(next));
  }, []);

  const handleTauChange = useCallback((next: number) => {
    setTau(clampInt(next, 0, 255));
  }, []);

  // Freeze NOW: deep copy of the current terrain (elevations included) and of
  // its memoized analysis (pairs/merges/beta0ByLevel) — the frozen snapshot
  // shares no reference with the editor, so every later edit is invisible to
  // it (FR-09). Re-freezing over an existing baseline is allowed on purpose.
  const handleFreezeBaseline = useCallback(() => {
    setBaseline(freezeBaseline(terrain, result));
    setStatus(READY_STATUS);
  }, [terrain, result]);

  const handleClearBaseline = useCallback(() => {
    setBaseline(null);
    setStatus(READY_STATUS);
  }, []);

  const handleImportFile = useCallback(
    async (file: File) => {
      setStatus({ kind: 'computing', message: null });
      let text: string;
      try {
        text = await file.text();
      } catch {
        setStatus({ kind: 'error', message: '导入失败：无法读取所选文件' });
        return;
      }
      try {
        const parsed = importTerrainJson(text);
        editor.replaceTerrain(parsed);
        setSelectedPairId(null);
        setStatus(READY_STATUS);
      } catch (error) {
        // Failure keeps the current terrain and the current selection; only the
        // code/field/reason is reported, never any file content.
        setStatus({
          kind: 'error',
          message:
            error instanceof TerrainValidationError
              ? formatTerrainError(error)
              : '导入失败：无法读取所选文件',
        });
      }
    },
    [editor],
  );

  const handleExportJson = useCallback(() => {
    try {
      const text = exportTerrainJson(terrain);
      downloadBlob(new Blob([text], { type: 'application/json' }), 'topotide-terrain.json');
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus({
        kind: 'error',
        message: `JSON 导出失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [terrain]);

  const handleExportCsv = useCallback(() => {
    try {
      const text = exportPairsCsv(result, terrain.width);
      downloadBlob(new Blob([text], { type: 'text/csv' }), 'topotide-pairs.csv');
      setStatus(READY_STATUS);
    } catch (error) {
      setStatus({
        kind: 'error',
        message: `CSV 导出失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [result, terrain.width]);

  const handleExportPng = useCallback(() => {
    const handle = canvasRef.current;
    if (handle === null) {
      setStatus({ kind: 'error', message: 'PNG 导出失败：画布尚未就绪' });
      return;
    }
    setStatus({ kind: 'computing', message: null });
    handle
      .toPngBlob()
      .then((blob) => {
        downloadBlob(blob, 'topotide-canvas.png');
        setStatus(READY_STATUS);
      })
      .catch((error: unknown) => {
        setStatus({
          kind: 'error',
          message: `PNG 导出失败：${error instanceof Error ? error.message : String(error)}`,
        });
      });
  }, []);

  // Window-level shortcuts, disabled while a text-entry control has focus
  // (§6.3). Native range arrows already step the level; Escape only clears.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }
      if (event.key === 'Escape') {
        setSelectedPairId(null);
        return;
      }
      if (event.altKey || !(event.ctrlKey || event.metaKey)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          editor.redo();
        } else {
          editor.undo();
        }
      } else if (key === 'y') {
        event.preventDefault();
        editor.redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editor]);

  /* ---------------- render ---------------- */

  return (
    <div className="appShell">
      <header className="appHeader">
        <h1 className="appTitle">TopoTide</h1>
        <p className="headerSubtitle">岛屿谱 · 地貌拓扑实验室</p>
        <span
          className={status.kind === 'error' ? 'statusChip statusChipError' : 'statusChip'}
          role="status"
          data-testid="calc-status"
        >
          计算状态：{STATUS_TEXT[status.kind]}
        </span>
      </header>

      <div className="appColumns">
        <EditToolbar
          brush={brush}
          onBrushChange={handleBrushChange}
          canUndo={editor.canUndo}
          canRedo={editor.canRedo}
          onUndo={handleUndo}
          onRedo={handleRedo}
          presetName={presetName}
          onPresetChange={handlePresetChange}
          onReset={handleReset}
          onImportFile={handleImportFile}
          onExportJson={handleExportJson}
          onExportCsv={handleExportCsv}
          onExportPng={handleExportPng}
          level={level}
          onLevelChange={handleSetLevel}
        />

        <main className="stageColumn" aria-label="地貌舞台">
          <div className="canvasHolder">
            <TerrainCanvas
              ref={canvasRef}
              terrain={terrain}
              level={level}
              selected={selected}
              brush={brush}
              onStroke={handleStroke}
            />
          </div>
        </main>

        <section className="sidePanel" aria-label="实验面板">
          <div className="tabRow" role="group" aria-label="实验面板选项卡">
            {PANEL_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={activeTab === tab.id ? 'tabButton tabButtonActive' : 'tabButton'}
                aria-pressed={activeTab === tab.id}
                data-testid={`panel-tab-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="panelBody">
            {activeTab === 'barcode' ? (
              <PersistencePanel
                result={result}
                tau={tau}
                selectedPairId={selectedPairId}
                onSelectPair={handleSelectPair}
                onTauChange={handleTauChange}
              />
            ) : null}
            {activeTab === 'events' ? (
              <EventPanel
                result={result}
                selectedPairId={selectedPairId}
                width={terrain.width}
                level={level}
                onSelectPair={handleSelectPair}
                onSetLevel={handleSetLevel}
              />
            ) : null}
            {activeTab === 'baseline' ? (
              <div className={compareStyles.baselineTab}>
                {/* T012 冻结/清除按钮只放在基线对照 tab 内（任务卡要求，
                    不改 EditToolbar）。清除在无基线时禁用。 */}
                <div className="buttonRow">
                  <button
                    type="button"
                    className="toolButton"
                    data-testid="baseline-freeze"
                    onClick={handleFreezeBaseline}
                  >
                    冻结为基线
                  </button>
                  <button
                    type="button"
                    className="toolButton"
                    data-testid="baseline-clear"
                    disabled={baseline === null}
                    onClick={handleClearBaseline}
                  >
                    清除基线
                  </button>
                </div>
                <ComparePanel
                  baseline={baseline}
                  current={{ terrain, result }}
                  level={level}
                  tau={tau}
                />
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <StatusBar
        statusText={STATUS_TEXT[status.kind]}
        statusIsError={status.kind === 'error'}
        statusMessage={status.message}
        level={level}
        beta0={summary.beta0}
        landCells={landCells}
        finiteCountAtTau={summary.finiteCountAtTau}
        tau={tau}
        selectedText={selectedText}
      />
    </div>
  );
}

export default App;
