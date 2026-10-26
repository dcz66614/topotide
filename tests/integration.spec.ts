/**
 * T011 tests — tests/integration.spec.ts（IMPLEMENTATION_PLAN.md task card
 * P0001-T011；PROJECT_BOOK.md §6, §10.1, §10.6）。
 *
 * HONEST SCOPE (same environment limitation as T008/T009/T010): this repo has
 * no jsdom and no happy-dom, `vite.config.ts` pins `test.environment: "node"`,
 * and `package.json` must not be modified. NOTHING here mounts React, renders
 * components, touches a DOM or a real browser. What IS exercised:
 *   - the real domain layer (analyzePersistence / summarize / serialization /
 *     makePreset) on the §10.1 S-STRIP golden sample and on the presets;
 *   - the pure state-machine core of the T010 editor hook
 *     (createEditorState / editorStroke / editorUndo / editorRedo /
 *     editorReplace / editorReset), which models App's import/reset/preset
 *     wiring without a DOM;
 *   - the small exported pure helpers of the T011 modules
 *     (countLandCells / clampInt / clampLevel / selectPairLevel /
 *     formatTerrainError / describeSelectedPair) and the exported initial-state
 *     constants that App actually uses;
 *   - non-mounting `createElement` contract checks for App, EditToolbar and
 *     StatusBar.
 * The selection-clearing on terrain change is implemented in App as a
 * `useEffect` keyed on `terrain`; it is NOT mount-tested here — T013's
 * Playwright E2E owns that in a real browser. Its safety precondition (a
 * replaced terrain arrives with empty history stacks and old pair ids that no
 * longer resolve in the new analysis) is what the pure editor tests pin down.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import App, {
  INITIAL_BRUSH,
  INITIAL_LEVEL,
  INITIAL_PRESET_NAME,
  INITIAL_TAU,
  STATUS_TEXT,
  clampInt,
  clampLevel,
  countLandCells,
  formatTerrainError,
  selectPairLevel,
} from '../src/App';
import { EditToolbar, downloadBlob } from '../src/components/EditToolbar';
import type { EditToolbarProps, BrushSetting } from '../src/components/EditToolbar';
import { StatusBar, describeSelectedPair } from '../src/components/StatusBar';
import type { StatusBarProps } from '../src/components/StatusBar';
import { analyzePersistence } from '../src/domain/persistence';
import { makePreset } from '../src/domain/presets';
import { exportPairsCsv, exportTerrainJson, importTerrainJson } from '../src/domain/serialization';
import { summarize } from '../src/domain/summarize';
import { TerrainValidationError } from '../src/domain/validate';
import {
  createEditorState,
  editorRedo,
  editorReplace,
  editorReset,
  editorStroke,
  editorUndo,
} from '../src/hooks/useTerrainEditor';
import type { BrushCommand, PersistencePair, PersistenceResult, TerrainV1 } from '../src/domain/types';

/* ------------------------------------------------------------------ *
 * Local helpers (independent of the modules under test)
 * ------------------------------------------------------------------ */

/** The §10.1 S-STRIP golden sample: 1×5, elevations [5, 1, 4, 1, 3]. */
const S_STRIP = (): TerrainV1 => ({
  schemaVersion: 1,
  width: 5,
  height: 1,
  elevations: [5, 1, 4, 1, 3],
  title: 'S-STRIP',
});

const STRIP_RESULT = (): PersistenceResult => analyzePersistence(S_STRIP());

function finitePairsOf(result: PersistenceResult): PersistencePair[] {
  return result.pairs.filter((pair) => pair.death !== null);
}

function essentialPairOf(result: PersistenceResult): PersistencePair {
  const essential = result.pairs.find((pair) => pair.death === null);
  if (essential === undefined) {
    throw new Error('the essential pair is missing');
  }
  return essential;
}

function pairById(result: PersistenceResult, id: string): PersistencePair {
  const pair = result.pairs.find((candidate) => candidate.id === id);
  if (pair === undefined) {
    throw new Error(`pair ${id} missing`);
  }
  return pair;
}

function raiseCommand(centers: number[], strength: 1 | 4 | 16 = 4): BrushCommand {
  return { mode: 'raise', radius: 1, strength, targetHeight: 0, centers };
}

/** Runs `fn` and returns the thrown TerrainValidationError, or fails. */
function expectValidationError(fn: () => unknown): TerrainValidationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TerrainValidationError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the call to throw TerrainValidationError');
}

function toolbarProps(): EditToolbarProps {
  const brush: BrushSetting = { ...INITIAL_BRUSH };
  return {
    brush,
    onBrushChange: () => undefined,
    canUndo: false,
    canRedo: false,
    onUndo: () => undefined,
    onRedo: () => undefined,
    presetName: INITIAL_PRESET_NAME,
    onPresetChange: () => undefined,
    onReset: () => undefined,
    onImportFile: () => undefined,
    onExportJson: () => undefined,
    onExportCsv: () => undefined,
    onExportPng: () => undefined,
    level: INITIAL_LEVEL,
    onLevelChange: () => undefined,
  };
}

function statusBarProps(): StatusBarProps {
  return {
    statusText: STATUS_TEXT.ready,
    statusIsError: false,
    statusMessage: null,
    level: INITIAL_LEVEL,
    beta0: 0,
    landCells: 0,
    finiteCountAtTau: 0,
    tau: INITIAL_TAU,
    selectedText: null,
  };
}

/* ------------------------------------------------------------------ *
 * S-STRIP golden analysis, β0, and the finite-pair selection rule
 * ------------------------------------------------------------------ */

describe('S-STRIP analysis and the pair selection rule', () => {
  it('analyzes to exactly two finite pairs plus one essential born at 5', () => {
    const result = STRIP_RESULT();

    const finite = finitePairsOf(result);
    expect(finite).toHaveLength(2);
    expect(result.pairs).toHaveLength(3);

    const younger = pairById(result, 'peak-2');
    expect(younger.birth).toBe(4);
    expect(younger.death).toBe(1);
    expect(younger.persistence).toBe(3);

    const middle = pairById(result, 'peak-4');
    expect(middle.birth).toBe(3);
    expect(middle.death).toBe(1);
    expect(middle.persistence).toBe(2);

    const essential = essentialPairOf(result);
    expect(essential.id).toBe('peak-0');
    expect(essential.birth).toBe(5);
    expect(essential.death).toBeNull();
    expect(essential.persistence).toBeNull();
  });

  it('matches the book β0 at levels 5, 4, 3, 2, 1 (1, 2, 3, 3, 1)', () => {
    const result = STRIP_RESULT();
    const levels = [5, 4, 3, 2, 1];
    const expected = [1, 2, 3, 3, 1];
    levels.forEach((level, index) => {
      expect(summarize(result, INITIAL_TAU, level).beta0).toBe(expected[index]);
    });
  });

  it('selecting a finite pair moves the level to its death; essential keeps it', () => {
    const result = STRIP_RESULT();
    for (const pair of result.pairs) {
      const applied = selectPairLevel(pair, INITIAL_LEVEL);
      if (pair.death === null) {
        expect(applied).toBe(INITIAL_LEVEL);
      } else {
        expect(applied).toBe(pair.death);
        expect(applied).toBeGreaterThanOrEqual(0);
        expect(applied).toBeLessThanOrEqual(255);
      }
    }
    expect(selectPairLevel(pairById(result, 'peak-2'), 7)).toBe(1);
    expect(selectPairLevel(pairById(result, 'peak-4'), 7)).toBe(1);
    expect(selectPairLevel(essentialPairOf(result), 7)).toBe(7);
  });

  it('opens on the documented initial state constants', () => {
    expect(INITIAL_LEVEL).toBe(160);
    expect(INITIAL_TAU).toBe(1);
    expect(INITIAL_PRESET_NAME).toBe('twin-peaks');
    expect(INITIAL_BRUSH).toEqual({ mode: 'raise', radius: 1, strength: 4, targetHeight: 128 });
    expect(STATUS_TEXT).toEqual({ ready: '就绪', computing: '计算中', error: '错误' });
  });
});

/* ------------------------------------------------------------------ *
 * β0 source independence from τ (§6.2: 筛选不改 β0)
 * ------------------------------------------------------------------ */

describe('β0 comes from the original array, the τ filter only changes counts', () => {
  it('β0 at a fixed level is identical for τ 0 and τ 255 while counts differ', () => {
    const result = STRIP_RESULT();
    const level = 1;

    const atTau0 = summarize(result, 0, level);
    const atTau255 = summarize(result, 255, level);

    expect(atTau0.beta0).toBe(1);
    expect(atTau255.beta0).toBe(1);
    expect(atTau0.beta0).toBe(atTau255.beta0);
    expect(atTau0.beta0).toBe(result.beta0ByLevel[level]);

    expect(atTau0.finiteCountAtTau).toBe(2);
    expect(atTau255.finiteCountAtTau).toBe(0);
    expect(atTau0.finiteCountAtTau).not.toBe(atTau255.finiteCountAtTau);
  });

  it('reports β0 = 0 at the initial level 160 for S-STRIP', () => {
    const result = STRIP_RESULT();
    const atInitialLevel = summarize(result, INITIAL_TAU, INITIAL_LEVEL);
    expect(atInitialLevel.beta0).toBe(result.beta0ByLevel[INITIAL_LEVEL]);
    expect(atInitialLevel.beta0).toBe(0);
    expect(atInitialLevel.finiteCountAtTau).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Terrain replacement: history reset and stale selection ids
 * (selection clearing itself is App's useEffect on terrain — unmountable here)
 * ------------------------------------------------------------------ */

describe('terrain replacement resets history and invalidates old selection ids', () => {
  it('editorReplace swaps the terrain and empties both stacks after a stroke', () => {
    const state = createEditorState(S_STRIP());
    const stroked = editorStroke(state, raiseCommand([0]));
    expect(stroked).not.toBe(state);
    expect(stroked.undoStack).toHaveLength(1);

    const plateau = makePreset('plateau');
    const replaced = editorReplace(stroked, plateau);
    expect(replaced).not.toBe(stroked);
    expect(replaced.terrain.title).toBe('Plateau');
    expect(replaced.terrain.elevations).toEqual(plateau.elevations);
    expect(replaced.terrain.elevations).not.toBe(plateau.elevations);
    expect(replaced.undoStack).toHaveLength(0);
    expect(replaced.redoStack).toHaveLength(0);
  });

  it('an old analysis pair id no longer resolves in the replaced analysis', () => {
    const oldResult = STRIP_RESULT();
    expect(oldResult.pairs.some((pair) => pair.id === 'peak-2')).toBe(true);

    const replaced = editorReplace(createEditorState(S_STRIP()), makePreset('twin-peaks'));
    const newResult = analyzePersistence(replaced.terrain);
    expect(newResult.pairs.find((pair) => pair.id === 'peak-2')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Import errors never clobber the editor state (FR-08)
 * ------------------------------------------------------------------ */

describe('a failed import keeps terrain, history and selection model intact', () => {
  it('rejects unparseable JSON as INVALID_SCHEMA without echoing the content', () => {
    const error = expectValidationError(() =>
      importTerrainJson('SENTINEL-42 not a json document'),
    );
    expect(error.code).toBe('INVALID_SCHEMA');
    expect(error.message).not.toContain('SENTINEL-42');
  });

  it('rejects a schema-violating document and names the offending field', () => {
    const error = expectValidationError(() =>
      importTerrainJson('{"schemaVersion":1,"width":2,"height":2,"elevations":[0,0,0,0]}'),
    );
    expect(error.code).toBe('INVALID_SCHEMA');
    expect(error.field).toBe('title');
  });

  it('leaves the editor state byte-identical when no replaceTerrain is called', () => {
    const state = createEditorState(S_STRIP());
    const terrainBefore = state.terrain;

    expect(() => importTerrainJson('SENTINEL-42 not a json document')).toThrow(
      TerrainValidationError,
    );

    expect(state.terrain).toBe(terrainBefore);
    expect(state.terrain.elevations).toEqual([5, 1, 4, 1, 3]);
    expect(state.terrain.title).toBe('S-STRIP');
    expect(state.undoStack).toHaveLength(0);
    expect(state.redoStack).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Export roundtrip and CSV layout (FR-08, FR-11, §10.6)
 * ------------------------------------------------------------------ */

describe('JSON/CSV exports roundtrip and match the book layout', () => {
  it('exportTerrainJson → importTerrainJson returns an equal terrain', () => {
    const terrain = S_STRIP();
    const text = exportTerrainJson(terrain);
    const reparsed = importTerrainJson(text);
    expect(reparsed).not.toBe(terrain);
    expect(reparsed).toEqual(terrain);
  });

  it('the CSV keeps the exact §10.6 header and the two S-STRIP finite rows', () => {
    const csv = exportPairsCsv(STRIP_RESULT(), 5);
    const lines = csv.split('\n');

    expect(lines[0]).toBe('type,peak_x,peak_y,birth,death,persistence,witness_x,witness_y,essential');
    expect(csv).toContain('essential,0,0,5,,,,,true');
    expect(csv).toContain('finite,2,0,4,1,3,1,0,false');
    expect(csv).toContain('finite,4,0,3,1,2,3,0,false');
    expect(lines[lines.length - 1]).toBe('');
    // header + essential + two finite rows + the trailing '' of the final LF
    expect(lines).toHaveLength(5);
  });
});

/* ------------------------------------------------------------------ *
 * Stroke + undo + redo, and no-op strokes (FR-06, FR-07)
 * ------------------------------------------------------------------ */

describe('stroke, undo and redo through the editor core', () => {
  it('a raise stroke changes the terrain, undo restores it, redo re-applies it', () => {
    const state = createEditorState(S_STRIP());
    // radius 1 covers the Manhattan-distance-1 disk, so cells 0, 1, 2 all rise.
    const stroked = editorStroke(state, raiseCommand([1]));
    expect(stroked.terrain.elevations).toEqual([9, 5, 8, 1, 3]);

    const undone = editorUndo(stroked);
    expect(undone.terrain.elevations).toEqual([5, 1, 4, 1, 3]);

    const redone = editorRedo(undone);
    expect(redone.terrain.elevations).toEqual([9, 5, 8, 1, 3]);
  });

  it('a no-op stroke (empty centers, or set to the same height) returns the same object', () => {
    const state = createEditorState(S_STRIP());
    expect(editorStroke(state, raiseCommand([]))).toBe(state);

    // A flat terrain where every cell within the radius already has the
    // requested height: the result equals the current terrain, so the very
    // same state object comes back and history stays empty.
    const flat: TerrainV1 = {
      schemaVersion: 1,
      width: 5,
      height: 1,
      elevations: [3, 3, 3, 3, 3],
      title: 'FLAT',
    };
    const flatState = createEditorState(flat);
    expect(
      editorStroke(flatState, { mode: 'set', radius: 1, strength: 1, targetHeight: 3, centers: [2] }),
    ).toBe(flatState);

    expect(state.terrain.elevations).toEqual([5, 1, 4, 1, 3]);
    expect(state.undoStack).toHaveLength(0);
    expect(flatState.undoStack).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Reset semantics (FR-01): reset() returns to the CREATION-TIME initial
 * ------------------------------------------------------------------ */

describe('reset returns to the creation-time terrain, not the latest replacement', () => {
  it('reset after switching to plateau restores twin-peaks explicitly', () => {
    const twinPeaks = makePreset('twin-peaks');
    const plateau = makePreset('plateau');

    const state = createEditorState(twinPeaks);
    const replaced = editorReplace(state, plateau);
    expect(replaced.terrain.elevations).toEqual(plateau.elevations);

    const reset = editorReset(replaced);
    expect(reset.terrain.title).toBe('Twin Peaks');
    expect(reset.terrain.elevations).toEqual(twinPeaks.elevations);
    expect(reset.terrain.elevations).not.toEqual(plateau.elevations);
    expect(reset.terrain.elevations).not.toBe(twinPeaks.elevations);
    expect(reset.initial.elevations).toEqual(twinPeaks.elevations);
    expect(reset.undoStack).toHaveLength(0);
    expect(reset.redoStack).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * Land cell count (FR-02): same `z >= level` rule as the canvas land mask
 * ------------------------------------------------------------------ */

describe('countLandCells agrees with the z >= level land rule', () => {
  it('S-STRIP land counts at levels 5, 4, 3, 1 are 1, 2, 3, 5', () => {
    const strip = S_STRIP();
    expect(countLandCells(strip, 5)).toBe(1);
    expect(countLandCells(strip, 4)).toBe(2);
    expect(countLandCells(strip, 3)).toBe(3);
    expect(countLandCells(strip, 1)).toBe(5);
  });

  it('cross-checks against a computed filter on real preset data', () => {
    const twinPeaks = makePreset('twin-peaks');
    const level = 160;
    const computed = twinPeaks.elevations.filter((z) => z >= level).length;
    expect(countLandCells(twinPeaks, level)).toBe(computed);
    expect(computed).toBeGreaterThan(0);

    const strip = S_STRIP();
    expect(countLandCells(strip, 2)).toBe(strip.elevations.filter((z) => z >= 2).length);
  });
});

/* ------------------------------------------------------------------ *
 * Small pure helpers of the T011 modules
 * ------------------------------------------------------------------ */

describe('level clamping helpers', () => {
  it('clamps into 0..255 and rounds fractional requests', () => {
    expect(clampLevel(300)).toBe(255);
    expect(clampLevel(255)).toBe(255);
    expect(clampLevel(160)).toBe(160);
    expect(clampLevel(-5)).toBe(0);
    expect(clampLevel(0)).toBe(0);
    expect(clampInt(254.4, 0, 255)).toBe(254);
    expect(clampInt(Number.NaN, 0, 255)).toBe(0);
  });
});

describe('formatTerrainError', () => {
  it('renders code, field and reason, and nothing else', () => {
    const error = new TerrainValidationError(
      'INVALID_SCHEMA',
      'missing required field "title"',
      'title',
    );
    expect(formatTerrainError(error)).toBe('INVALID_SCHEMA · 字段 title：missing required field "title"');
  });

  it('renders without a field part when the error has none', () => {
    const error = new TerrainValidationError('FILE_TOO_LARGE', 'input exceeds the maximum size');
    expect(formatTerrainError(error)).toBe('FILE_TOO_LARGE：input exceeds the maximum size');
  });
});

describe('describeSelectedPair', () => {
  it('describes a finite pair with real coordinates, birth, death, persistence', () => {
    const result = STRIP_RESULT();
    const text = describeSelectedPair(pairById(result, 'peak-2'), 5);
    expect(text).not.toBeNull();
    expect(text).toContain('峰 (2,0)');
    expect(text).toContain('birth 4');
    expect(text).toContain('death 1');
    expect(text).toContain('persistence 3');
  });

  it('describes the essential pair with 未定义, never a fabricated number', () => {
    const text = describeSelectedPair(essentialPairOf(STRIP_RESULT()), 5);
    expect(text).not.toBeNull();
    expect(text).toContain('峰 (0,0)');
    expect(text).toContain('birth 5');
    expect(text).toContain('death 未定义');
    expect(text).toContain('persistence 未定义');
    expect(text).not.toMatch(/death \d/);
    expect(text).not.toMatch(/persistence \d/);
  });

  it('maps peakCell through x = cell % width and y = floor(cell / width)', () => {
    const pair: PersistencePair = {
      id: 'peak-7',
      peakCell: 7,
      birth: 9,
      death: 2,
      persistence: 7,
      winnerPeakCell: 0,
      witnessCell: 1,
    };
    const text = describeSelectedPair(pair, 5);
    expect(text).not.toBeNull();
    expect(text).toContain('峰 (2,1)');
    expect(describeSelectedPair(null, 5)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * createElement contract checks (no mounting, no rendering)
 * ------------------------------------------------------------------ */

describe('createElement contract checks', () => {
  it('createElement(App) is a valid element of the App component', () => {
    const element = createElement(App);
    expect(element).toBeTruthy();
    expect(typeof element.type).toBe('function');
    expect(element.type).toBe(App);
  });

  it('createElement(EditToolbar, props) is a valid element carrying its props', () => {
    const props = toolbarProps();
    const element = createElement(EditToolbar, props);
    expect(element).toBeTruthy();
    expect(element.type).toBe(EditToolbar);
    // React 19's createElement always builds a fresh props object.
    expect(element.props).toEqual(props);
    expect(element.props.brush).toEqual(INITIAL_BRUSH);
    expect(element.props.level).toBe(INITIAL_LEVEL);
    expect(typeof downloadBlob).toBe('function');
  });

  it('createElement(StatusBar, props) is a valid element carrying its props', () => {
    const props = statusBarProps();
    const element = createElement(StatusBar, props);
    expect(element).toBeTruthy();
    expect(element.type).toBe(StatusBar);
    expect(element.props).toEqual(props);
    expect(element.props.statusText).toBe(STATUS_TEXT.ready);
  });
});
