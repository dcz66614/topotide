/**
 * T012 tests — tests/compare.spec.tsx (IMPLEMENTATION_PLAN.md task card
 * P0001-T012; PROJECT_BOOK.md §4.1, FR-09).
 *
 * HONEST SCOPE (same environment limitation as T008–T011): this repo has no
 * jsdom and no happy-dom, `vite.config.ts` pins `test.environment: "node"`, and
 * `package.json` must not be modified. NOTHING here mounts React, renders a
 * component, touches a DOM or takes a screenshot. What IS exercised, on the
 * real domain layer:
 *   - `freezeBaseline()` deep-copy semantics: mutating the original
 *     terrain.elevations and the original result (pairs/merges/beta0ByLevel)
 *     after freezing leaves the frozen baseline byte-identical, and nothing is
 *     shared by reference (FR-09: 基线数组不可被后续画笔改变);
 *   - the reproducible "frozen then edited" flow: twin-peaks preset → freeze →
 *     one `applyBrush` stroke (raise 16, radius 4, three passes at cell
 *     60*64+60) → re-analyze → `compareSummaries()` really differs on both
 *     sides (new finite pair peak-3644 63→15 p=48; β0(16..63) 1→2);
 *   - `compareSummaries()`: summary-only output (no peak correspondence
 *     anywhere in the shape), `baseline: null` instead of a fabricated zero
 *     side (无虚假 0 vs 0), and tau filtering changing ONLY the finite counts,
 *     never beta0 (β0 straight from each original beta0ByLevel[level]);
 *   - `beta0PolylinePoints()`: exactly 256 points, x = level mapped onto
 *     0..width, y normalized by the maximum value, max === 0 → flat bottom
 *     baseline (never NaN), no input mutation, hard failures on broken input;
 *   - undo/redo semantics: App holds the baseline in its own useState slot
 *     that ONLY `handleFreezeBaseline`/`handleClearBaseline` write, while every
 *     editor operation goes through `useTerrainEditor`'s separate state. Below
 *     that App-layer guarantee is modeled with the pure T010 state machine
 *     (createEditorState/editorStroke/editorUndo/editorRedo/editorReset/
 *     editorReplace) plus an `AppModel` whose `baseline` field is written by
 *     nothing except the two modeled freeze/clear handlers — after a stroke,
 *     undo, redo, reset, a preset replace and a no-op undo, the baseline
 *     object reference AND its contents are unchanged; undo restores the
 *     baseline's SHAPE as a fresh object (the editor clones, it never aliases
 *     the frozen arrays);
 *   - non-mounting `createElement` contract checks pinning the frozen §4.3
 *     ComparePanelProps shape (incl. a compile-time assignability check of a
 *     local structural mirror) and that props pass through by identity.
 * Real-browser rendering / screenshot evidence is T013's responsibility
 * ( Playwright E2E ).
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  BETA0_LEVEL_COUNT,
  CHART_HEIGHT,
  CHART_WIDTH,
  ComparePanel,
  NO_BASELINE_GUIDE,
  beta0PolylinePoints,
  compareSummaries,
  freezeBaseline,
  summaryValueText,
} from '../src/components/ComparePanel';
import type {
  BaselineSnapshot,
  ComparePanelProps,
  ComparedSummaries,
  SideSummary,
} from '../src/components/ComparePanel';
import { applyBrush } from '../src/domain/brush';
import { analyzePersistence } from '../src/domain/persistence';
import { makePreset } from '../src/domain/presets';
import { summarize } from '../src/domain/summarize';
import type { PersistenceResult, TerrainV1 } from '../src/domain/types';
import type { BrushCommand } from '../src/domain/types';
import {
  createEditorState,
  editorRedo,
  editorReplace,
  editorReset,
  editorStroke,
  editorUndo,
} from '../src/hooks/useTerrainEditor';
import type { EditorState } from '../src/hooks/useTerrainEditor';

/* ------------------------------------------------------------------ *
 * Local helpers (independent of the modules under test)
 * ------------------------------------------------------------------ */

function makeTerrain(width: number, height: number, elevations: number[], title = 't012-compare'): TerrainV1 {
  return { schemaVersion: 1, width, height, elevations, title };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** The §10.1 S-STRIP golden sample: 1×5, elevations [5, 1, 4, 1, 3]. */
const S_STRIP = (): TerrainV1 => makeTerrain(5, 1, [5, 1, 4, 1, 3], 'S-STRIP');

/**
 * The reproducible T012 stroke on the twin-peaks preset: three passes of a
 * radius-4, strength-16 raise centred on the far corner cell 60*64+60 = 3900
 * (floor height 15 there). Every cell of that diamond gains 3×16 = 48 → 63,
 * which is separated from the rest of the map by floor-level (15) water for
 * all levels 16..63 — a brand-new island, i.e. a genuinely different topology.
 */
const T012_STROKE: BrushCommand = {
  mode: 'raise',
  radius: 4,
  strength: 16,
  targetHeight: 128,
  centers: [60 * 64 + 60, 60 * 64 + 60, 60 * 64 + 60],
};
const T012_CORNER = 60 * 64 + 60;

/** Freezes the pristine twin-peaks state, then edits the CURRENT map only. */
function frozenThenEdited(): {
  baseline: BaselineSnapshot;
  currentTerrain: TerrainV1;
  currentResult: PersistenceResult;
} {
  const terrain = makePreset('twin-peaks');
  const baseline = freezeBaseline(terrain, analyzePersistence(terrain));
  const currentTerrain = applyBrush(terrain, T012_STROKE); // pure; the editor does the same
  const currentResult = analyzePersistence(currentTerrain);
  return { baseline, currentTerrain, currentResult };
}

/** A synthetic 256-level β0 curve with the given peaks (0 elsewhere). */
function curveWith(peaks: ReadonlyArray<readonly [number, number]>): number[] {
  const curve = new Array<number>(BETA0_LEVEL_COUNT).fill(0);
  for (const [level, value] of peaks) {
    curve[level] = value;
  }
  return curve;
}

/* ------------------------------------------------------------------ *
 * freezeBaseline: deep copy of terrain AND result, no mutation
 * ------------------------------------------------------------------ */

describe('freezeBaseline (deep copy, inputs never mutated)', () => {
  it('copies the terrain elevations so later edits of the original cannot leak in', () => {
    const terrain = makePreset('twin-peaks');
    const result = analyzePersistence(terrain);
    const frozen = freezeBaseline(terrain, result);
    const pristine = Array.from(terrain.elevations);

    expect(frozen.terrain).not.toBe(terrain);
    expect(frozen.terrain.elevations).not.toBe(terrain.elevations);
    expect(frozen.terrain.elevations).toEqual(terrain.elevations);

    // The exact FR-09 attack: the original array is changed after freezing.
    terrain.elevations[T012_CORNER] = 255;
    terrain.elevations[0] = 0;
    expect(terrain.elevations[T012_CORNER]).toBe(255);
    // The frozen snapshot still holds the pristine heights.
    expect(frozen.terrain.elevations).toEqual(pristine);
    expect(frozen.terrain.elevations[T012_CORNER]).toBe(15);
    expect(frozen.terrain.elevations[0]).toBe(pristine[0]);
  });

  it('deep-copies pairs/merges/beta0ByLevel of the result (task card requirement)', () => {
    const terrain = S_STRIP();
    const result = analyzePersistence(terrain);
    const frozen = freezeBaseline(terrain, result);

    expect(frozen.result).not.toBe(result);
    expect(frozen.result.pairs).not.toBe(result.pairs);
    expect(frozen.result.merges).not.toBe(result.merges);
    expect(frozen.result.beta0ByLevel).not.toBe(result.beta0ByLevel);
    for (let index = 0; index < result.pairs.length; index += 1) {
      expect(frozen.result.pairs[index]).not.toBe(result.pairs[index]);
      expect(frozen.result.pairs[index]).toEqual(result.pairs[index]);
    }
    for (let index = 0; index < result.merges.length; index += 1) {
      expect(frozen.result.merges[index]).not.toBe(result.merges[index]);
    }
    expect(frozen.result.beta0ByLevel).toEqual(result.beta0ByLevel);

    // In-place mutation of the ORIGINAL result after freezing: no leak.
    result.pairs.push({
      id: 'peak-999',
      peakCell: 999,
      birth: 9,
      death: 9,
      persistence: 0,
      winnerPeakCell: null,
      witnessCell: null,
    });
    result.beta0ByLevel[3] = 999;
    if (result.merges.length > 0) {
      result.merges[0].level = 999;
    }
    expect(frozen.result.pairs).toHaveLength(3); // essential + the two finite bars
    expect(frozen.result.pairs.some((pair) => pair.id === 'peak-999')).toBe(false);
    expect(frozen.result.beta0ByLevel[3]).toBe(3);
    expect(frozen.result.merges[0].level).toBe(1);
  });

  it('never mutates its inputs while freezing', () => {
    const terrain = S_STRIP();
    const result = analyzePersistence(terrain);
    const terrainSnapshot = Array.from(terrain.elevations);
    const beta0Snapshot = Array.from(result.beta0ByLevel);
    const pairIds = result.pairs.map((pair) => pair.id);

    freezeBaseline(terrain, result);

    expect(Array.from(terrain.elevations)).toEqual(terrainSnapshot);
    expect(Array.from(result.beta0ByLevel)).toEqual(beta0Snapshot);
    expect(result.pairs.map((pair) => pair.id)).toEqual(pairIds);
  });

  it('keeps the frozen analysis byte-identical while a real stroke edits the current map', () => {
    const { baseline, currentTerrain } = frozenThenEdited();
    // The stroke raised the corner on the CURRENT map only…
    expect(currentTerrain.elevations[T012_CORNER]).toBe(63);
    // …and the frozen terrain still holds the pristine heights.
    expect(baseline.terrain.elevations[T012_CORNER]).toBe(15);
    expect(baseline.terrain.elevations).not.toEqual(currentTerrain.elevations);
    expect(baseline.terrain.title).toBe('Twin Peaks');
  });
});

/* ------------------------------------------------------------------ *
 * Frozen baseline vs edited current: genuinely different summaries
 * ------------------------------------------------------------------ */

describe('frozen then edited: compareSummaries really differs (reproducible example)', () => {
  it('turns the far corner into a new island: 15 → 63 on the current map only', () => {
    const { baseline, currentTerrain, currentResult } = frozenThenEdited();
    expect(baseline.terrain.elevations[T012_CORNER]).toBe(15);
    expect(currentTerrain.elevations[T012_CORNER]).toBe(63);
    // The new island exists only in the CURRENT analysis.
    expect(baseline.result.pairs.some((pair) => pair.id === 'peak-3644')).toBe(false);
    expect(currentResult.pairs.some((pair) => pair.id === 'peak-3644')).toBe(true);
    const newPair = currentResult.pairs.find((pair) => pair.id === 'peak-3644');
    expect(newPair).toMatchObject({ birth: 63, death: 15, persistence: 48 });
  });

  it('produces two genuinely different summaries at the same tau/level', () => {
    const { baseline, currentResult } = frozenThenEdited();
    const compared = compareSummaries(currentResult, baseline.result, 1, 20);

    // Both sides exist and are real numbers — no fabricated zeros anywhere.
    expect(compared.baseline).not.toBeNull();
    expect(compared.current).toEqual({ beta0: 2, finiteCountAtTau: 2, longestFinitePersistence: 77 });
    expect(compared.baseline).toEqual({ beta0: 1, finiteCountAtTau: 1, longestFinitePersistence: 77 });
    expect(compared.current).not.toEqual(compared.baseline);
    // β0(20) on each ORIGINAL beta0ByLevel: 1 island before the stroke, 2 after.
    expect(baseline.result.beta0ByLevel[20]).toBe(1);
    expect(currentResult.beta0ByLevel[20]).toBe(2);
  });

  it('changes β0 exactly on the levels where the new island exists (16..63)', () => {
    const { baseline, currentResult } = frozenThenEdited();
    for (let level = 0; level <= 255; level += 1) {
      if (level < 16 || level > 63) {
        expect(currentResult.beta0ByLevel[level]).toBe(baseline.result.beta0ByLevel[level]);
      } else {
        expect(currentResult.beta0ByLevel[level]).toBe(baseline.result.beta0ByLevel[level] + 1);
      }
    }
  });

  it('compares SUMMARIES only — the result shape offers no peak correspondence', () => {
    const { baseline, currentResult } = frozenThenEdited();
    const compared: ComparedSummaries = compareSummaries(currentResult, baseline.result, 1, 20);
    // Exactly two sides, each with exactly the three summary numbers: there is
    // no field that could even express a peak-to-peak match (FR-09).
    expect(Object.keys(compared).sort()).toEqual(['baseline', 'current']);
    expect(Object.keys(compared.current).sort()).toEqual([
      'beta0',
      'finiteCountAtTau',
      'longestFinitePersistence',
    ]);
    expect(Object.keys(compared.baseline as SideSummary).sort()).toEqual([
      'beta0',
      'finiteCountAtTau',
      'longestFinitePersistence',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * compareSummaries: tau filtering vs beta0; missing baseline side
 * ------------------------------------------------------------------ */

describe('compareSummaries (STRIP golden numbers; tau changes counts, never β0)', () => {
  it('summarizes both sides through the T007 summarize() at the same tau/level', () => {
    const terrain = S_STRIP();
    const baseline = freezeBaseline(terrain, analyzePersistence(terrain));
    const compared = compareSummaries(baseline.result, baseline.result, 1, 3);
    // β0(3) = 3 on the STRIP; two finite bars (p=3 and p=2) at tau=1.
    expect(compared.current).toEqual({ beta0: 3, finiteCountAtTau: 2, longestFinitePersistence: 3 });
    expect(compared.baseline).toEqual({ beta0: 3, finiteCountAtTau: 2, longestFinitePersistence: 3 });
    // Equal numbers, but never the same summary object.
    expect(compared.current).not.toBe(compared.baseline);
  });

  it('changes ONLY finiteCountAtTau/longestFinitePersistence with tau; β0 stays 3', () => {
    const terrain = S_STRIP();
    const result = analyzePersistence(terrain);
    for (const tau of [0, 1, 2, 3, 4, 255]) {
      const summary = summarize(result, tau, 3);
      expect(summary.beta0).toBe(3); // β0 never reacts to tau
      expect(summary.finiteCountAtTau).toBe(tau <= 2 ? 2 : tau === 3 ? 1 : 0);
      expect(summary.longestFinitePersistence).toBe(tau <= 3 ? 3 : 0);
    }
    // The same asymmetry on the comparison helper, both sides at once.
    const baseline = freezeBaseline(terrain, result);
    expect(compareSummaries(result, baseline.result, 4, 3)).toEqual({
      current: { beta0: 3, finiteCountAtTau: 0, longestFinitePersistence: 0 },
      baseline: { beta0: 3, finiteCountAtTau: 0, longestFinitePersistence: 0 },
    });
    expect(compareSummaries(result, baseline.result, 1, 3).current.finiteCountAtTau).toBe(2);
  });

  it('returns baseline: null — never a fabricated 0 vs 0 — when no baseline exists', () => {
    const terrain = S_STRIP();
    const result = analyzePersistence(terrain);
    const compared = compareSummaries(result, null, 4, 3);
    expect(compared.baseline).toBeNull();
    // The current side is still real data (β0(3)=3 ≠ 0): nothing is faked.
    expect(compared.current).toEqual({ beta0: 3, finiteCountAtTau: 0, longestFinitePersistence: 0 });
  });

  it('rejects out-of-contract tau/level like the domain layer, without mutating inputs', () => {
    const terrain = S_STRIP();
    const result = analyzePersistence(terrain);
    const baseline = freezeBaseline(terrain, result);
    expect(() => compareSummaries(result, baseline.result, -1, 3)).toThrow(RangeError);
    expect(() => compareSummaries(result, baseline.result, 1.5, 3)).toThrow(RangeError);
    expect(() => compareSummaries(result, baseline.result, 1, 256)).toThrow(RangeError);
    expect(() => compareSummaries(result, null, 1, -1)).toThrow(RangeError);

    const beta0Snapshot = Array.from(result.beta0ByLevel);
    const pairIds = result.pairs.map((pair) => pair.id);
    compareSummaries(result, baseline.result, 2, 4);
    expect(Array.from(result.beta0ByLevel)).toEqual(beta0Snapshot);
    expect(result.pairs.map((pair) => pair.id)).toEqual(pairIds);
  });
});

/* ------------------------------------------------------------------ *
 * beta0PolylinePoints: 256 points, axis 0..255, max normalization
 * ------------------------------------------------------------------ */

describe('beta0PolylinePoints (native SVG polyline, horizontal axis 0..255)', () => {
  it('emits exactly 256 well-formed points for a real β0 curve', () => {
    const terrain = makePreset('twin-peaks');
    const { beta0ByLevel } = analyzePersistence(terrain);
    const points = beta0PolylinePoints(beta0ByLevel, 255, 100);
    const list = points.split(' ');
    expect(list).toHaveLength(256);
    expect(BETA0_LEVEL_COUNT).toBe(256);
    for (const point of list) {
      expect(point).toMatch(/^-?\d+(\.\d{1,2})?,-?\d+(\.\d{1,2})?$/);
    }
    expect(points).not.toContain('NaN');
    expect(points).not.toContain('Infinity');
    expect(CHART_WIDTH).toBeGreaterThan(0);
    expect(CHART_HEIGHT).toBeGreaterThan(0);
  });

  it('maps level i onto x = i at width 255 and onto width*i/255 otherwise', () => {
    const curve = curveWith([[20, 10], [10, 5]]);
    const at255 = beta0PolylinePoints(curve, 255, 100).split(' ');
    for (const level of [0, 1, 63, 128, 254, 255]) {
      expect(at255[level].startsWith(`${level},`)).toBe(true);
    }
    expect(at255[0]).toBe('0,100');
    expect(at255[255]).toBe('255,100');

    const at510 = beta0PolylinePoints(curve, 510, 100).split(' ');
    expect(at510[0].startsWith('0,')).toBe(true);
    expect(at510[64].startsWith('128,')).toBe(true);
    expect(at510[128].startsWith('256,')).toBe(true);
    expect(at510[255].startsWith('510,')).toBe(true);

    const at100 = beta0PolylinePoints(curve, 100, 100).split(' ');
    expect(at100[255].startsWith('100,')).toBe(true);
    expect(at100[1].startsWith('0.39,')).toBe(true); // 100/255 → 0.39
  });

  it('normalizes y by the maximum: max → top (0), half → middle, zero → bottom', () => {
    const curve = curveWith([[20, 10], [10, 5]]);
    const points = beta0PolylinePoints(curve, 255, 100).split(' ');
    expect(points[20]).toBe('20,0'); // maximum value → top edge
    expect(points[10]).toBe('10,50'); // half of max → middle
    expect(points[0]).toBe('0,100'); // zero value → bottom edge
  });

  it('uses the flat bottom baseline (y = height) for every point when max = 0', () => {
    const flat = new Array<number>(256).fill(0);
    const points = beta0PolylinePoints(flat, 255, 100);
    const list = points.split(' ');
    expect(list).toHaveLength(256);
    for (const point of list) {
      expect(point.endsWith(',100')).toBe(true);
    }
    expect(points).not.toContain('NaN');
  });

  it('is deterministic, never mutates the input, and rejects broken input', () => {
    const curve = curveWith([[20, 10]]);
    const snapshot = Array.from(curve);
    expect(beta0PolylinePoints(curve, 255, 100)).toBe(beta0PolylinePoints(curve, 255, 100));
    expect(Array.from(curve)).toEqual(snapshot);

    expect(() => beta0PolylinePoints(new Array<number>(255).fill(0), 255, 100)).toThrow(RangeError);
    expect(() => beta0PolylinePoints(new Array<number>(257).fill(0), 255, 100)).toThrow(RangeError);
    expect(() => beta0PolylinePoints(curveWith([[7, Number.NaN]]), 255, 100)).toThrow(RangeError);
    expect(() => beta0PolylinePoints(curveWith([[7, Number.POSITIVE_INFINITY]]), 255, 100)).toThrow(RangeError);
    expect(() => beta0PolylinePoints(curve, 0, 100)).toThrow(RangeError);
    expect(() => beta0PolylinePoints(curve, -5, 100)).toThrow(RangeError);
    expect(() => beta0PolylinePoints(curve, 255, 0)).toThrow(RangeError);
    expect(() => beta0PolylinePoints(curve, Number.NaN, 100)).toThrow(RangeError);
  });

  it('draws two DIFFERENT curves for the frozen baseline and the edited current map', () => {
    const { baseline, currentResult } = frozenThenEdited();
    const baselinePoints = beta0PolylinePoints(baseline.result.beta0ByLevel, CHART_WIDTH, CHART_HEIGHT);
    const currentPoints = beta0PolylinePoints(currentResult.beta0ByLevel, CHART_WIDTH, CHART_HEIGHT);
    expect(baselinePoints.split(' ')).toHaveLength(256);
    expect(currentPoints.split(' ')).toHaveLength(256);
    expect(currentPoints).not.toBe(baselinePoints);
  });
});

/* ------------------------------------------------------------------ *
 * undo/redo semantics: the baseline survives every editor operation
 * ------------------------------------------------------------------ */

/**
 * APP-LAYER GUARANTEE (why the assertions below are meaningful): in
 * `src/App.tsx` the baseline lives in its OWN `useState` slot; the only two
 * call sites of its setter are `handleFreezeBaseline` (→ freezeBaseline deep
 * copy) and `handleClearBaseline` (→ null). Every editor operation — stroke,
 * undo, redo, reset, preset switch (replaceTerrain), import (replaceTerrain) —
 * is routed through `useTerrainEditor`, i.e. through a DIFFERENT state slot,
 * and can never reach the baseline setter. The `AppModel` here mirrors exactly
 * those two write paths, and the pure T010 state machine mirrors the editor
 * slot, so the suite pins the data-level mechanism (deep copies + a pure
 * editor) that makes the App-level independence claim true.
 */
interface AppModel {
  /** App's `const [baseline, setBaseline] = useState(...)` slot. */
  baseline: BaselineSnapshot | null;
  /** The useTerrainEditor-owned state (pure T010 core stands in for it). */
  editor: EditorState;
}

/** Mirrors App's handleFreezeBaseline: the ONLY writer #1 of model.baseline. */
function appFreezeBaseline(model: AppModel): void {
  model.baseline = freezeBaseline(model.editor.terrain, analyzePersistence(model.editor.terrain));
}

/** Mirrors App's handleClearBaseline: the ONLY writer #2 of model.baseline. */
function appClearBaseline(model: AppModel): void {
  model.baseline = null;
}

describe('undo/redo/reset/replace/import cannot touch the frozen baseline', () => {
  it('keeps the SAME baseline object reference and contents after a full editor session', () => {
    const model: AppModel = { baseline: null, editor: createEditorState(makePreset('twin-peaks')) };
    appFreezeBaseline(model);
    const frozen = model.baseline;
    expect(frozen).not.toBeNull();
    const frozenElevations = Array.from((frozen as BaselineSnapshot).terrain.elevations);
    const frozenBeta0 = Array.from((frozen as BaselineSnapshot).result.beta0ByLevel);
    const frozenPairIds = (frozen as BaselineSnapshot).result.pairs.map((pair) => pair.id);

    // Everything a user can do to the CURRENT map, in one session.
    model.editor = editorStroke(model.editor, T012_STROKE); // a stroke…
    model.editor = editorUndo(model.editor); // …undone…
    model.editor = editorRedo(model.editor); // …redone…
    model.editor = editorReset(model.editor); // reset to the initial preset…
    model.editor = editorReplace(model.editor, makePreset('plateau')); // sample switch / import…
    model.editor = editorUndo(model.editor); // …whose history was cleared → no-op

    // The baseline was not re-frozen and not cleared, so it must be the very
    // same object with the very same contents (undo/redo never pollutes it).
    expect(model.baseline).toBe(frozen);
    expect(model.baseline === null).toBe(false);
    expect(Array.from((model.baseline as BaselineSnapshot).terrain.elevations)).toEqual(frozenElevations);
    expect(Array.from((model.baseline as BaselineSnapshot).result.beta0ByLevel)).toEqual(frozenBeta0);
    expect((model.baseline as BaselineSnapshot).result.pairs.map((pair) => pair.id)).toEqual(frozenPairIds);
    // …while the current map really did change under the editor.
    expect(model.editor.terrain.title).toBe('Plateau');
  });

  it('restores the baseline SHAPE on undo as a fresh object (no aliasing of frozen arrays)', () => {
    const terrain = makePreset('twin-peaks');
    const baseline = freezeBaseline(terrain, analyzePersistence(terrain));
    const afterStroke = editorStroke(createEditorState(terrain), T012_STROKE);
    const afterUndo = editorUndo(afterStroke);

    // The editor clones on every transition: the restored terrain equals the
    // frozen one structurally but shares NOTHING with the frozen snapshot.
    expect(afterUndo.terrain).not.toBe(baseline.terrain);
    expect(afterUndo.terrain.elevations).not.toBe(baseline.terrain.elevations);
    expect(afterUndo.terrain.elevations).toEqual(baseline.terrain.elevations);
    // And the frozen snapshot still holds the pristine corner height.
    expect(baseline.terrain.elevations[T012_CORNER]).toBe(15);
    expect(afterStroke.terrain.elevations[T012_CORNER]).toBe(63);
  });

  it('changes the baseline ONLY through re-freeze or clear — the two allowed paths', () => {
    const model: AppModel = { baseline: null, editor: createEditorState(makePreset('twin-peaks')) };
    expect(model.baseline).toBeNull(); // no baseline → guidance state, no fake 0 vs 0

    appFreezeBaseline(model);
    const first = model.baseline;
    expect(first).not.toBeNull();

    // Editing the current map, then re-freezing produces a NEW snapshot.
    model.editor = editorStroke(model.editor, T012_STROKE);
    appFreezeBaseline(model);
    expect(model.baseline).not.toBe(first);
    expect(model.baseline?.terrain.elevations[T012_CORNER]).toBe(63);
    expect(first?.terrain.elevations[T012_CORNER]).toBe(15);

    appClearBaseline(model);
    expect(model.baseline).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Empty-state guidance: instructs, never fakes 0 vs 0
 * ------------------------------------------------------------------ */

describe('no-baseline guidance (no fabricated 0 vs 0)', () => {
  it('guides toward freezing/clearing without any comparison numbers', () => {
    expect(NO_BASELINE_GUIDE).toContain('冻结为基线');
    expect(NO_BASELINE_GUIDE).toContain('清除基线');
    expect(NO_BASELINE_GUIDE).toContain('深拷贝');
    // The empty state must not display a fake comparison: no “0 vs 0”, no
    // paired β0/finite numbers of any kind.
    expect(NO_BASELINE_GUIDE).not.toMatch(/0\s*vs\s*0/i);
    expect(NO_BASELINE_GUIDE).not.toMatch(/β0[^。]*vs/i);
    expect(NO_BASELINE_GUIDE).toMatch(/撤销|重做|笔划|重置|样例|导入/);
  });

  it('renders a missing side as —, never as 0', () => {
    expect(summaryValueText(null)).toBe('—');
    expect(summaryValueText(0)).toBe('0');
    expect(summaryValueText(3)).toBe('3');
  });

  it('pairs the guidance with a null baseline summary (data-level no-fake check)', () => {
    const compared = compareSummaries(analyzePersistence(S_STRIP()), null, 1, 3);
    expect(compared.baseline).toBeNull(); // guidance branch, NOT {0,0,0}
    expect(compared.current.beta0).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * Component contract without a DOM (createElement, never mounted)
 * ------------------------------------------------------------------ */

/**
 * Local structural mirror of the frozen §4.3 contract. `asContract` below
 * compiles ONLY if this mirror is assignable to the real ComparePanelProps —
 * a compile-time pin of the props shape, independent of this file's imports.
 */
interface ComparePanelPropsMirror {
  baseline: { terrain: TerrainV1; result: PersistenceResult } | null;
  current: { terrain: TerrainV1; result: PersistenceResult };
  level: number;
  tau: number;
}
function asContract(mirror: ComparePanelPropsMirror): ComparePanelProps {
  return mirror;
}

describe('ComparePanel contract without a DOM', () => {
  const stripBaseline = (): BaselineSnapshot => freezeBaseline(S_STRIP(), analyzePersistence(S_STRIP()));

  it('accepts exactly the §4.3 props with baseline null (empty state)', () => {
    const current = { terrain: S_STRIP(), result: analyzePersistence(S_STRIP()) };
    const props = asContract({ baseline: null, current, level: 3, tau: 1 });
    const element = createElement(ComparePanel, props);
    expect(element).toBeTruthy();
    expect(element.type).toBe(ComparePanel);
    expect(element.props.baseline).toBeNull();
    expect(element.props.current).toBe(current);
    expect(element.props.level).toBe(3);
    expect(element.props.tau).toBe(1);
    // createElement with props only: nothing passed as children (never mounted).
    expect((element.props as { children?: unknown }).children).toBeUndefined();
  });

  it('passes the frozen snapshot and live pair through by identity', () => {
    const baseline = stripBaseline();
    const terrain = S_STRIP();
    const current = { terrain, result: analyzePersistence(terrain) };
    const element = createElement(ComparePanel, asContract({ baseline, current, level: 4, tau: 3 }));
    expect(element.props.baseline).toBe(baseline); // the exact frozen object
    expect(element.props.current.terrain).toBe(terrain);
    expect(element.props.current.result).toBe(current.result);
    expect((element.props as { children?: unknown }).children).toBeUndefined();
  });

  it('runs every pure helper on a deeply frozen baseline snapshot without throwing', () => {
    const frozen = deepFreeze(stripBaseline());
    expect(Object.isFrozen(frozen.terrain)).toBe(true);
    expect(Object.isFrozen(frozen.terrain.elevations)).toBe(true);
    expect(Object.isFrozen(frozen.result.beta0ByLevel)).toBe(true);
    expect(() => {
      const compared = compareSummaries(frozen.result, frozen.result, 1, 3);
      expect(compared.current.beta0).toBe(3);
      expect(compared.baseline?.finiteCountAtTau).toBe(2);
      const points = beta0PolylinePoints(frozen.result.beta0ByLevel, CHART_WIDTH, CHART_HEIGHT);
      expect(points.split(' ')).toHaveLength(256);
    }).not.toThrow();
  });
});
