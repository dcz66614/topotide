/**
 * T010 tests for the stroke-transaction editor state and its 30-step
 * undo/redo history (PROJECT_BOOK.md §6.3, §9.3; IMPLEMENTATION_PLAN.md
 * P0001-T010).
 *
 * Scope, stated honestly: this file exercises the PURE state-machine core
 * exported from src/hooks/useTerrainEditor.ts (createEditorState +
 * editorStroke/editorUndo/editorRedo/editorReplace/editorReset). It does NOT
 * mount the React hook — there is no jsdom, no @testing-library, no React
 * rendering and no new dependency here, matching the node test environment of
 * this project. Verifying the mounted hook (useState wiring, re-render on
 * stroke, stable function identities, real pointer interactions) is left to
 * T011 (App integration unit tests) and T013 (Playwright e2e). About the hook
 * itself, only its export shape is asserted below.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_STEPS,
  createEditorState,
  editorCanRedo,
  editorCanUndo,
  editorRedo,
  editorReplace,
  editorReset,
  editorStroke,
  editorUndo,
  useTerrainEditor,
} from '../src/hooks/useTerrainEditor';
import { TerrainValidationError } from '../src/domain/validate';
import type { BrushCommand, TerrainV1 } from '../src/domain/types';

function makeTerrain(width: number, height: number, elevations: number[]): TerrainV1 {
  return { schemaVersion: 1, width, height, elevations, title: 't010-editor' };
}

/** Fresh 3x3 all-zero grid for every test. */
const GRID_3X3 = (): TerrainV1 => makeTerrain(3, 3, Array<number>(9).fill(0));

function raiseCmd(centers: number[], strength: 1 | 4 | 16 = 1): BrushCommand {
  return { mode: 'raise', radius: 1, strength, targetHeight: 0, centers };
}

function setCmd(targetHeight: number, centers: number[] = [4]): BrushCommand {
  return { mode: 'set', radius: 1, strength: 1, targetHeight, centers };
}

/** Carries runtime values the BrushCommand type forbids. */
function illegalCmd(overrides: Record<string, unknown>): BrushCommand {
  return {
    mode: 'raise',
    radius: 1,
    strength: 1,
    targetHeight: 0,
    centers: [4],
    ...overrides,
  } as unknown as BrushCommand;
}

/** 3x3 grid after `k` consecutive 'set' strokes of targetHeight k on cell 4. */
function plateauAfter(k: number): number[] {
  const elevations = Array<number>(9).fill(0);
  for (const id of [1, 3, 4, 5, 7]) {
    elevations[id] = k;
  }
  return elevations;
}

describe('editor state machine: stroke, undo and redo', () => {
  it('starts with empty history and no undo/redo available', () => {
    const state = createEditorState(GRID_3X3());
    expect(state.terrain).toEqual(GRID_3X3());
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([]);
    expect(editorCanUndo(state)).toBe(false);
    expect(editorCanRedo(state)).toBe(false);
  });

  it('commits one stroke as ONE history step and exposes undo/redo flags', () => {
    let state = createEditorState(GRID_3X3());
    state = editorStroke(state, setCmd(7));
    expect(state.terrain.elevations).toEqual(plateauAfter(7));
    expect(state.undoStack.length).toBe(1);
    expect(editorCanUndo(state)).toBe(true);
    expect(editorCanRedo(state)).toBe(false);

    state = editorUndo(state);
    expect(state.terrain.elevations).toEqual(Array<number>(9).fill(0));
    expect(editorCanUndo(state)).toBe(false);
    expect(editorCanRedo(state)).toBe(true);

    state = editorRedo(state);
    expect(state.terrain.elevations).toEqual(plateauAfter(7));
    expect(editorCanUndo(state)).toBe(true);
    expect(editorCanRedo(state)).toBe(false);
  });

  it('submits several centers of one stroke as a single undoable step', () => {
    let state = createEditorState(GRID_3X3());
    state = editorStroke(state, raiseCmd([0, 1, 2], 4));
    expect(state.undoStack.length).toBe(1);
    state = editorUndo(state);
    expect(state.terrain.elevations).toEqual(Array<number>(9).fill(0));
    expect(editorCanUndo(state)).toBe(false);
  });

  it('round-trips undo/redo repeatedly with stable terrain values', () => {
    let state = createEditorState(GRID_3X3());
    state = editorStroke(state, setCmd(9));
    const stroked = state.terrain.elevations;
    for (let round = 0; round < 3; round += 1) {
      state = editorUndo(state);
      expect(state.terrain.elevations).toEqual(Array<number>(9).fill(0));
      state = editorRedo(state);
      expect(state.terrain.elevations).toEqual(stroked);
    }
  });

  it('never mutates the state or terrain it receives', () => {
    const before = createEditorState(GRID_3X3());
    const stroked = editorStroke(before, setCmd(3));
    expect(before.terrain.elevations).toEqual(Array<number>(9).fill(0));
    expect(before.undoStack.length).toBe(0);
    expect(before).not.toBe(stroked);

    const undone = editorUndo(stroked);
    expect(stroked.terrain.elevations).toEqual(plateauAfter(3));
    expect(stroked.undoStack.length).toBe(1);
    expect(stroked.redoStack.length).toBe(0);
    expect(undone).not.toBe(stroked);
  });
});

describe('editor state machine: 30-step history cap', () => {
  it('keeps 30 of 31 consecutive strokes and drops the oldest snapshot', () => {
    expect(MAX_HISTORY_STEPS).toBe(30);
    let state = createEditorState(GRID_3X3());
    for (let k = 1; k <= 31; k += 1) {
      state = editorStroke(state, setCmd(k));
    }
    expect(state.terrain.elevations).toEqual(plateauAfter(31));
    expect(state.undoStack.length).toBe(30);
    expect(state.redoStack.length).toBe(0);
    expect(editorCanUndo(state)).toBe(true);
    expect(editorCanRedo(state)).toBe(false);

    // Exactly 30 undos are possible; they land on the state after stroke 1,
    // proving the oldest snapshot (the initial all-zero grid) was dropped.
    for (let expected = 30; expected >= 1; expected -= 1) {
      state = editorUndo(state);
      expect(state.terrain.elevations).toEqual(plateauAfter(expected));
    }
    expect(editorCanUndo(state)).toBe(false);
    expect(state.terrain.elevations).not.toEqual(Array<number>(9).fill(0));

    // All 30 abandoned steps are on the redo branch.
    expect(editorCanRedo(state)).toBe(true);
    expect(state.redoStack.length).toBe(30);
    for (let expected = 2; expected <= 31; expected += 1) {
      state = editorRedo(state);
      expect(state.terrain.elevations).toEqual(plateauAfter(expected));
    }
    expect(editorCanRedo(state)).toBe(false);
    expect(state.terrain.elevations).toEqual(plateauAfter(31));
  });

  it('keeps every step undoable when there are at most 30 strokes', () => {
    let state = createEditorState(GRID_3X3());
    for (let k = 1; k <= 30; k += 1) {
      state = editorStroke(state, setCmd(k));
    }
    expect(state.undoStack.length).toBe(30);
    // All 30 snapshots survive, so undo reaches the initial all-zero grid.
    for (let expected = 29; expected >= 1; expected -= 1) {
      state = editorUndo(state);
      expect(state.terrain.elevations).toEqual(plateauAfter(expected));
    }
    state = editorUndo(state);
    expect(state.terrain.elevations).toEqual(Array<number>(9).fill(0));
    expect(editorCanUndo(state)).toBe(false);
  });
});

describe('editor state machine: no-op strokes stay out of history', () => {
  it('does not enter history for an empty centers list', () => {
    const state = createEditorState(GRID_3X3());
    const after = editorStroke(state, setCmd(5, []));
    expect(after).toBe(state);
    expect(after.undoStack.length).toBe(0);
    expect(editorCanUndo(after)).toBe(false);
    expect(after.terrain.elevations).toEqual(Array<number>(9).fill(0));
  });

  it('does not enter history when the stroke produces an equal terrain', () => {
    const flat = makeTerrain(3, 3, Array<number>(9).fill(7));
    const state = createEditorState(flat);
    const setToSame = editorStroke(state, setCmd(7));
    expect(setToSame).toBe(state);
    expect(setToSame.undoStack.length).toBe(0);

    const saturated = makeTerrain(3, 3, Array<number>(9).fill(255));
    const raiseAt255 = createEditorState(saturated);
    const after = editorStroke(raiseAt255, raiseCmd([4], 16));
    expect(after).toBe(raiseAt255);
    expect(after.undoStack.length).toBe(0);

    const drowned = createEditorState(GRID_3X3());
    const lowered = editorStroke(drowned, {
      mode: 'lower',
      radius: 1,
      strength: 4,
      targetHeight: 0,
      centers: [4],
    });
    expect(lowered).toBe(drowned);
    expect(lowered.undoStack.length).toBe(0);
  });
});

describe('editor state machine: redo branch invalidation', () => {
  it('clears redo when a new stroke follows an undo', () => {
    let state = createEditorState(GRID_3X3());
    state = editorStroke(state, setCmd(5));
    state = editorStroke(state, setCmd(9));
    state = editorUndo(state);
    expect(editorCanRedo(state)).toBe(true);
    expect(state.redoStack.length).toBe(1);

    state = editorStroke(state, setCmd(2));
    expect(editorCanRedo(state)).toBe(false);
    expect(state.redoStack.length).toBe(0);

    // Undo walks the new branch only: the abandoned future is unreachable.
    state = editorUndo(state);
    expect(state.terrain.elevations).toEqual(plateauAfter(5));
    state = editorUndo(state);
    expect(state.terrain.elevations).toEqual(Array<number>(9).fill(0));
    expect(editorCanUndo(state)).toBe(false);
  });

  it('is a no-op to undo or redo past the ends of history', () => {
    let state = createEditorState(GRID_3X3());
    expect(editorUndo(state)).toBe(state);
    expect(editorRedo(state)).toBe(state);
    state = editorStroke(state, setCmd(4));
    const atTop = editorRedo(state);
    expect(atTop).toBe(state);
  });
});

describe('editor state machine: replaceTerrain', () => {
  it('replaces the terrain and clears both undo and redo history', () => {
    let state = createEditorState(GRID_3X3());
    state = editorStroke(state, setCmd(5));
    state = editorUndo(state);
    expect(editorCanUndo(state)).toBe(false);
    expect(editorCanRedo(state)).toBe(true);

    const replacement = makeTerrain(2, 2, [1, 2, 3, 4]);
    state = editorReplace(state, replacement);
    expect(state.terrain).toEqual(replacement);
    expect(state.undoStack.length).toBe(0);
    expect(state.redoStack.length).toBe(0);
    expect(editorCanUndo(state)).toBe(false);
    expect(editorCanRedo(state)).toBe(false);

    state = editorUndo(state);
    state = editorRedo(state);
    expect(state.terrain.elevations).toEqual([1, 2, 3, 4]);

    // The incoming terrain is deep-copied: mutating the caller's object
    // afterwards must not leak into the editor.
    replacement.elevations[0] = 99;
    expect(state.terrain.elevations[0]).toBe(1);
  });
});

describe('editor state machine: reset', () => {
  it('restores the initial terrain and clears the whole history', () => {
    const initial = makeTerrain(3, 2, [1, 2, 3, 4, 5, 6]);
    let state = createEditorState(initial);
    state = editorStroke(state, setCmd(200, [0]));
    state = editorStroke(state, setCmd(10, [5]));
    state = editorUndo(state);
    expect(editorCanRedo(state)).toBe(true);

    state = editorReset(state);
    expect(state.terrain).toEqual(initial);
    expect(state.undoStack.length).toBe(0);
    expect(state.redoStack.length).toBe(0);
    expect(editorCanUndo(state)).toBe(false);
    expect(editorCanRedo(state)).toBe(false);

    const again = editorReset(state);
    expect(again).not.toBe(state);
    expect(again.terrain).toEqual(initial);
  });

  it('restores the original initial terrain even after replaceTerrain', () => {
    const initial = makeTerrain(3, 2, [1, 2, 3, 4, 5, 6]);
    let state = createEditorState(initial);
    state = editorReplace(state, makeTerrain(1, 1, [9]));
    state = editorReset(state);
    expect(state.terrain).toEqual(initial);
    expect(state.undoStack.length).toBe(0);
  });

  it('is immune to later mutation of the object passed as initial', () => {
    const initial = makeTerrain(2, 1, [3, 4]);
    const state = createEditorState(initial);
    initial.elevations[0] = 250;
    const edited = editorStroke(state, setCmd(1, [0]));
    expect(edited.terrain.elevations).toEqual([1, 1]);
    const reset = editorReset(edited);
    expect(reset.terrain.elevations).toEqual([3, 4]);
  });
});

describe('editor state machine: no aliasing', () => {
  it('deep-copies the terrain handed to createEditorState', () => {
    const initial = GRID_3X3();
    const state = createEditorState(initial);
    expect(state.terrain).not.toBe(initial);
    expect(state.terrain.elevations).not.toBe(initial.elevations);
    expect(state.initial).not.toBe(initial);
    expect(state.initial.elevations).not.toBe(initial.elevations);
    state.terrain.elevations[0] = 77;
    expect(initial.elevations[0]).toBe(0);
  });

  it('keeps the history intact when a returned terrain is mutated', () => {
    let state = createEditorState(GRID_3X3());
    state = editorStroke(state, setCmd(4));
    const returned = state.terrain;
    returned.elevations[4] = 250;

    // Undo still returns the pre-stroke terrain, untouched by the mutation.
    const undone = editorUndo(state);
    expect(undone.terrain.elevations).toEqual(Array<number>(9).fill(0));
    // Past snapshots are unaffected as well.
    for (const snapshot of state.undoStack) {
      expect(snapshot.elevations).toEqual(Array<number>(9).fill(0));
    }
    // The redo branch holds an independent copy of the current (mutated)
    // terrain, and redo restores it without sharing arrays with the state.
    const redoSnapshot = undone.redoStack[undone.redoStack.length - 1];
    expect(redoSnapshot.elevations).not.toBe(returned.elevations);
    const redone = editorRedo(undone);
    expect(redone.terrain.elevations[4]).toBe(250);
    expect(redone.terrain.elevations).not.toBe(redoSnapshot.elevations);
  });

  it('never shares an elevations array between current terrain and snapshots', () => {
    let state = createEditorState(GRID_3X3());
    for (let k = 1; k <= 5; k += 1) {
      state = editorStroke(state, setCmd(k));
    }
    const arrays = [state.terrain, ...state.undoStack, ...state.redoStack].map(
      (terrain) => terrain.elevations,
    );
    for (let i = 0; i < arrays.length; i += 1) {
      for (let j = i + 1; j < arrays.length; j += 1) {
        expect(arrays[i]).not.toBe(arrays[j]);
      }
    }
    // Each snapshot holds its own values, so mutating one snapshot leaks nowhere.
    state.undoStack[0].elevations[4] = 123;
    expect(state.terrain.elevations[4]).toBe(5);
    expect(state.undoStack[1].elevations[4]).toBe(1);
    expect(state.undoStack[2].elevations[4]).toBe(2);
    expect(state.undoStack[4].elevations[4]).toBe(4);
  });
});

describe('editor state machine: invalid commands', () => {
  it('throws the applyBrush validation error naming the offending field', () => {
    const state = editorStroke(createEditorState(GRID_3X3()), setCmd(5));
    let thrown: unknown = null;
    try {
      editorStroke(state, illegalCmd({ radius: 3 }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TerrainValidationError);
    expect((thrown as TerrainValidationError).field).toBe('radius');
  });

  it('leaves terrain and history completely unchanged when a command throws', () => {
    let state = editorStroke(createEditorState(GRID_3X3()), setCmd(5));
    const before = state;
    expect(() => editorStroke(state, illegalCmd({ radius: 3 }))).toThrow(
      TerrainValidationError,
    );
    expect(() => editorStroke(state, illegalCmd({ strength: 2 }))).toThrow(
      TerrainValidationError,
    );
    expect(() => editorStroke(state, illegalCmd({ mode: 'paint' }))).toThrow(
      TerrainValidationError,
    );
    expect(() => editorStroke(state, illegalCmd({ centers: [99] }))).toThrow(
      TerrainValidationError,
    );
    expect(() => editorStroke(state, illegalCmd({ centers: [-1] }))).toThrow(
      TerrainValidationError,
    );
    expect(() =>
      editorStroke(state, illegalCmd({ mode: 'set', targetHeight: 300 })),
    ).toThrow(TerrainValidationError);

    expect(state).toBe(before);
    expect(state.terrain.elevations).toEqual(plateauAfter(5));
    expect(state.undoStack.length).toBe(1);
    expect(state.redoStack.length).toBe(0);
    expect(editorCanUndo(state)).toBe(true);
    expect(editorCanRedo(state)).toBe(false);

    // The state is still fully usable after the rejected commands.
    state = editorUndo(state);
    expect(state.terrain.elevations).toEqual(Array<number>(9).fill(0));
  });
});

describe('useTerrainEditor hook export shape', () => {
  // Honest scope note (repeated from the file header): mounting the hook and
  // asserting its rendered behaviour is NOT done here — no jsdom, no React
  // rendering, no new dependency. That verification belongs to T011
  // (integration unit tests on the wired App) and T013 (Playwright e2e).
  it('exports the hook as a single-argument function', () => {
    expect(typeof useTerrainEditor).toBe('function');
    expect(useTerrainEditor.length).toBe(1);
  });
});
