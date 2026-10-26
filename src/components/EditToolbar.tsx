/**
 * T011 — 左栏「雕塑工具」EditToolbar（PROJECT_BOOK.md §6.1/§6.3；IMPLEMENTATION_PLAN.md
 * task card P0001-T011）。
 *
 * The left toolbar renders the sculpting controls and the file actions and
 * reports every user intent upward — it owns no terrain, no history and no
 * analysis:
 *  - brush mode 抬高/降低/设定 as native radios, radius 1/2/4 and strength
 *    1/4/16 selects (strength is disabled in 设定 mode and its label says so);
 *  - the 设定 target height and the water level are numeric inputs that keep a
 *    local draft, show a hint while the draft is out of 0..255 and clamp on
 *    blur;
 *  - 撤销/重做 call `onUndo`/`onRedo` and are disabled from `canUndo`/`canRedo`;
 *  - the preset select reports `onPresetChange(makePreset name)`; the help line
 *    under it states that 重置 only returns to the start-up sample (the editor
 *    captures its initial once, so preset switching does NOT change what
 *    reset() restores);
 *  - the file input (accept .json) forwards the chosen `File` once and resets
 *    itself so re-selecting the same file fires again;
 *  - 导出 JSON / 导出 CSV / 导出 PNG buttons report intent; the actual bytes
 *    are built in App (JSON/CSV from the domain exporters, PNG from the canvas
 *    handle).
 *
 * `downloadBlob()` is the single save helper shared by App: Blob →
 * URL.createObjectURL → temporary `<a download>` click → revokeObjectURL.
 *
 * All interactive controls carry Chinese `aria-label`s (§6.2), and everything
 * here is a native focusable element, so Tab order and keyboard activation
 * come for free.
 */
import { useState } from 'react';
import type { ChangeEvent as ReactChangeEvent } from 'react';
import type { PresetName } from '../domain/presets';
import type { BrushCommand, BrushMode } from '../domain/types';

/** App-owned brush settings — a BrushCommand minus the stroke's `centers`. */
export type BrushSetting = Omit<BrushCommand, 'centers'>;

/** Props of the left toolbar. Every callback reports intent, none mutates state. */
export interface EditToolbarProps {
  brush: BrushSetting;
  onBrushChange(patch: Partial<BrushSetting>): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  presetName: PresetName;
  onPresetChange(name: PresetName): void;
  onReset(): void;
  onImportFile(file: File): void;
  onExportJson(): void;
  onExportCsv(): void;
  onExportPng(): void;
  /** Current water level, shared with the canvas and the status bar. */
  level: number;
  onLevelChange(level: number): void;
}

const BRUSH_MODES: ReadonlyArray<{ value: BrushMode; label: string }> = [
  { value: 'raise', label: '抬高' },
  { value: 'lower', label: '降低' },
  { value: 'set', label: '设定' },
];

const BRUSH_RADII = [1, 2, 4] as const;
const BRUSH_STRENGTHS = [1, 4, 16] as const;

const PRESET_OPTIONS: ReadonlyArray<{ value: PresetName; label: string }> = [
  { value: 'twin-peaks', label: '双峰 twin-peaks' },
  { value: 'ridge-gate', label: '山脊门 ridge-gate' },
  { value: 'plateau', label: '台地 plateau' },
];

/** One line of help that must match the reset() semantics of the editor hook. */
const RESET_HINT = '重置只回到启动时的双峰样例，与所选样例无关';

const LEVEL_HINT = '水位超出 0..255，离焦时自动纠正';
const TARGET_HEIGHT_HINT = '目标高度超出 0..255，离焦时自动纠正';

/**
 * Saves a Blob with a temporary `<a download>` click. The object URL is
 * revoked one task after the click; the anchor is never left in the DOM.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Parses a select value back into the frozen `radius` literal union. */
function parseRadius(value: string): 1 | 2 | 4 {
  const parsed = Number(value);
  return parsed === 2 ? 2 : parsed === 4 ? 4 : 1;
}

/** Parses a select value back into the frozen `strength` literal union. */
function parseStrength(value: string): 1 | 4 | 16 {
  const parsed = Number(value);
  return parsed === 1 ? 1 : parsed === 16 ? 16 : 4;
}

/** Anything but the three real preset names falls back to the start-up one. */
function parsePreset(value: string): PresetName {
  return value === 'ridge-gate' || value === 'plateau' ? value : 'twin-peaks';
}

/** `null` for empty or non-numeric drafts, the finite number otherwise. */
function parseDraftNumber(value: string): number | null {
  if (value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Rounds to an integer and clamps into [min, max]. */
function clampToRange(value: number, min: number, max: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : min;
  return rounded < min ? min : rounded > max ? max : rounded;
}

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  hint: string;
  testId: string;
  onCommit(next: number): void;
}

/**
 * Numeric input that edits a local draft: while the draft is out of
 * `[min, max]` (or not a number) a hint is shown, and blurring commits the
 * clamped value. The committed `value` prop is always in range, so the field
 * tracks external changes (e.g. the slider) whenever it is not being typed in.
 */
function NumberField({ value, min, max, ariaLabel, hint, testId, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const parsed = parseDraftNumber(shown);
  const outOfRange = parsed === null || parsed < min || parsed > max;
  return (
    <span className="numberField">
      <input
        className="numberInput"
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={shown}
        aria-label={ariaLabel}
        data-testid={testId}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (draft === null) {
            return;
          }
          const requested = parseDraftNumber(draft);
          onCommit(clampToRange(requested ?? value, min, max));
          setDraft(null);
        }}
      />
      {outOfRange ? <span className="fieldWarn">{hint}</span> : null}
    </span>
  );
}

/** The left column 「雕塑工具」. Pure intent reporter, no local domain state. */
export function EditToolbar({
  brush,
  onBrushChange,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  presetName,
  onPresetChange,
  onReset,
  onImportFile,
  onExportJson,
  onExportCsv,
  onExportPng,
  level,
  onLevelChange,
}: EditToolbarProps) {
  const handleImportChange = (event: ReactChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const files = input.files;
    const file = files !== null && files.length > 0 ? files[0] : null;
    // Reset first so selecting the very same file again fires change again.
    input.value = '';
    if (file !== null) {
      onImportFile(file);
    }
  };

  return (
    <aside className="toolbarPanel" aria-label="雕塑工具">
      <h2 className="panelHeading">雕塑工具</h2>

      <fieldset className="fieldGroup">
        <legend>画笔</legend>
        <div className="radioColumn">
          {BRUSH_MODES.map((mode) => (
            <label key={mode.value} className="radioRow">
              <input
                type="radio"
                name="brush-mode"
                value={mode.value}
                checked={brush.mode === mode.value}
                onChange={() => onBrushChange({ mode: mode.value })}
                aria-label={`画笔模式：${mode.label}`}
              />
              {mode.label}
            </label>
          ))}
        </div>

        <label className="fieldLabel">
          画笔半径（格）
          <select
            className="fieldSelect"
            value={brush.radius}
            aria-label="画笔半径，1、2 或 4 格"
            data-testid="brush-radius"
            onChange={(event) => onBrushChange({ radius: parseRadius(event.currentTarget.value) })}
          >
            {BRUSH_RADII.map((radius) => (
              <option key={radius} value={radius}>
                {radius}
              </option>
            ))}
          </select>
        </label>

        <label className="fieldLabel">
          力度 1/4/16（设定模式忽略）
          <select
            className="fieldSelect"
            value={brush.strength}
            disabled={brush.mode === 'set'}
            aria-label="画笔力度，1、4 或 16，设定模式下忽略"
            data-testid="brush-strength"
            onChange={(event) => onBrushChange({ strength: parseStrength(event.currentTarget.value) })}
          >
            {BRUSH_STRENGTHS.map((strength) => (
              <option key={strength} value={strength}>
                {strength}
              </option>
            ))}
          </select>
        </label>

        <NumberField
          value={brush.targetHeight}
          min={0}
          max={255}
          ariaLabel="设定模式目标高度，0 到 255"
          hint={TARGET_HEIGHT_HINT}
          testId="brush-target-height"
          onCommit={(next) => onBrushChange({ targetHeight: next })}
        />
      </fieldset>

      <div className="buttonRow">
        <button
          type="button"
          className="toolButton"
          disabled={!canUndo}
          onClick={onUndo}
          aria-label="撤销上一笔（Ctrl+Z）"
          data-testid="undo"
        >
          撤销
        </button>
        <button
          type="button"
          className="toolButton"
          disabled={!canRedo}
          onClick={onRedo}
          aria-label="重做下一笔（Ctrl+Shift+Z 或 Ctrl+Y）"
          data-testid="redo"
        >
          重做
        </button>
      </div>

      <fieldset className="fieldGroup">
        <legend>样例</legend>
        <label className="fieldLabel">
          内置确定性样例
          <select
            className="fieldSelect"
            value={presetName}
            aria-label="内置确定性样例选择"
            data-testid="preset-select"
            onChange={(event) => onPresetChange(parsePreset(event.currentTarget.value))}
          >
            {PRESET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="fieldHint">{RESET_HINT}</p>
        <button
          type="button"
          className="toolButton"
          onClick={onReset}
          aria-label="重置为启动时的双峰样例"
          data-testid="reset"
        >
          重置
        </button>
      </fieldset>

      <fieldset className="fieldGroup">
        <legend>水位与文件</legend>
        <label className="fieldLabel" htmlFor="water-level-range">
          水位滑块（0..255）
        </label>
        <input
          id="water-level-range"
          className="levelRange"
          type="range"
          min={0}
          max={255}
          step={1}
          value={level}
          aria-label="当前水位 level，0 到 255"
          data-testid="level-slider"
          onChange={(event) => onLevelChange(Number(event.currentTarget.value))}
        />
        <NumberField
          value={level}
          min={0}
          max={255}
          ariaLabel="当前水位数字输入，0 到 255"
          hint={LEVEL_HINT}
          testId="level-number"
          onCommit={onLevelChange}
        />

        <input
          className="fileInput"
          type="file"
          accept=".json,application/json"
          aria-label="导入地形 JSON 文件"
          data-testid="import-file"
          onChange={handleImportChange}
        />

        <div className="buttonRow">
          <button
            type="button"
            className="toolButton"
            onClick={onExportJson}
            aria-label="导出当前地形 JSON 文件"
            data-testid="export-json"
          >
            导出 JSON
          </button>
          <button
            type="button"
            className="toolButton"
            onClick={onExportCsv}
            aria-label="导出条码 CSV 文件"
            data-testid="export-csv"
          >
            导出 CSV
          </button>
          <button
            type="button"
            className="toolButton"
            onClick={onExportPng}
            aria-label="导出画布 PNG 图片"
            data-testid="export-png"
          >
            导出 PNG
          </button>
        </div>
      </fieldset>
    </aside>
  );
}

export default EditToolbar;
