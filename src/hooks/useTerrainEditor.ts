/**
 * Stroke-transaction editor state with a 30-step undo/redo history
 * (PROJECT_BOOK.md §6.3, §9.3; IMPLEMENTATION_PLAN.md P0001-T010).
 *
 * One call to `stroke(cmd)` is ONE history step, no matter how many `centers`
 * the command carries: `applyBrush` (T005) is applied exactly once and the
 * terrain that was current before the stroke is pushed onto the undo stack.
 * This is the `pointerup` commit described in §6.3 — the stroke itself is the
 * transaction, intermediate pointers never enter history.
 *
 * The module is split in two halves so the history rules are testable without
 * a DOM (IMPLEMENTATION_PLAN.md P0001-T010; PROJECT_BOOK.md §9: the main
 * business API stays pure and React-free):
 *
 *   1. A pure state-machine core: `createEditorState()` plus the
 *      `editorStroke` / `editorUndo` / `editorRedo` / `editorReplace` /
 *      `editorReset` transitions and the `editorCanUndo` / `editorCanRedo`
 *      predicates. Every transition returns a NEW `EditorState` and never
 *      mutates the state it receives; it also never mutates any terrain.
 *   2. `useTerrainEditor(initial)`, a thin React wrapper that owns one
 *      `EditorState` in component state and delegates every operation to the
 *      pure functions above.
 *
 * History rules implemented here:
 *   - Snapshots are independent deep copies: every terrain held by the state
 *     owns a fresh `elevations` array (the only nested storage a TerrainV1
 *     has), so no snapshot ever shares an array with another snapshot, with
 *     the current terrain, or with the object a caller passed in.
 *   - The undo stack holds at most MAX_HISTORY_STEPS (30) entries; pushing a
 *     31st drops the oldest snapshot, which becomes permanently unreachable.
 *   - A no-op stroke does NOT enter history: `centers` empty, or a stroke
 *     whose result is equal to the current terrain (e.g. 'set' to the height
 *     the cell already has, or 'raise' on a cell already at 255). Such a
 *     stroke returns the very same EditorState object.
 *   - A new stroke clears the redo branch.
 *   - `replaceTerrain(valid)` swaps the current terrain (deep-copied) and
 *     clears BOTH stacks; the caller validates the terrain first
 *     (validateTerrain / importTerrainJson, T002/T007) so an import error
 *     never reaches the editor and can never clobber the current terrain.
 *   - `reset()` restores the terrain the editor was created with and clears
 *     BOTH stacks. `initial` is captured once at creation time and is never
 *     changed by `replaceTerrain`, so reset always returns to the original
 *     map; switching samples goes through `replaceTerrain` (T011).
 *   - An invalid BrushCommand throws exactly the TerrainValidationError raised
 *     by applyBrush *before* any state object is built, so terrain and history
 *     are left completely untouched.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { applyBrush } from '../domain/brush';
import type { BrushCommand, TerrainV1 } from '../domain/types';

/** Maximum number of undoable steps kept in history (T010: 上限 30). */
export const MAX_HISTORY_STEPS = 30;

/**
 * Immutable snapshot of the whole editor. The stacks hold *past* and *future*
 * terrains in oldest-first order; `undoStack[undoStack.length - 1]` is the
 * version `undo()` restores and `redoStack[redoStack.length - 1]` is the
 * version `redo()` restores. Exposed read-only for tests and diagnostics.
 */
export interface EditorState {
  /** Terrain the editor was created with; `reset()` always restores it. */
  readonly initial: TerrainV1;
  /** Current terrain (the one the UI renders and strokes mutate). */
  readonly terrain: TerrainV1;
  /** Past terrains, oldest first, at most MAX_HISTORY_STEPS entries. */
  readonly undoStack: readonly TerrainV1[];
  /** Future terrains of the redo branch, oldest first. */
  readonly redoStack: readonly TerrainV1[];
}

/** Public hook API (IMPLEMENTATION_PLAN.md P0001-T010). */
export interface TerrainEditorApi {
  terrain: TerrainV1;
  /** Commits one brush command as ONE history step. Throws on an invalid command. */
  stroke: (cmd: BrushCommand) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Swaps in a validated terrain and clears the whole history. */
  replaceTerrain: (terrain: TerrainV1) => void;
  /** Restores the initial terrain and clears the whole history. */
  reset: () => void;
}

/**
 * Fresh, fully independent copy of a terrain. TerrainV1's only nested storage
 * is `elevations`, so copying the object plus slicing that array is a deep
 * copy; everything else is a primitive. The result shares no reference with
 * the input.
 */
function cloneTerrain(t: TerrainV1): TerrainV1 {
  return {
    schemaVersion: t.schemaVersion,
    width: t.width,
    height: t.height,
    elevations: t.elevations.slice(),
    title: t.title,
  };
}

/** Structural equality of two terrains, used to detect no-op strokes. */
function terrainsEqual(a: TerrainV1, b: TerrainV1): boolean {
  if (a === b) {
    return true;
  }
  if (
    a.schemaVersion !== b.schemaVersion ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.title !== b.title ||
    a.elevations.length !== b.elevations.length
  ) {
    return false;
  }
  for (let i = 0; i < a.elevations.length; i += 1) {
    if (a.elevations[i] !== b.elevations[i]) {
      return false;
    }
  }
  return true;
}

/** Pushes `snapshot` onto a stack, dropping the oldest entry beyond the cap. */
function pushCapped(stack: readonly TerrainV1[], snapshot: TerrainV1): TerrainV1[] {
  const next = stack.concat(snapshot);
  if (next.length > MAX_HISTORY_STEPS) {
    next.shift();
  }
  return next;
}

/** Creates the initial state. `initial` is deep-copied, never held by reference. */
export function createEditorState(initial: TerrainV1): EditorState {
  const initialCopy = cloneTerrain(initial);
  return {
    initial: initialCopy,
    terrain: cloneTerrain(initialCopy),
    undoStack: [],
    redoStack: [],
  };
}

/**
 * Applies one brush command as ONE history step. Throws (from `applyBrush`)
 * on an invalid command, leaving the state untouched. A stroke whose result
 * equals the current terrain is a no-op: it returns the same EditorState
 * object and does not enter history.
 */
export function editorStroke(state: EditorState, cmd: BrushCommand): EditorState {
  // Evaluated first: if applyBrush throws, nothing below runs and neither the
  // terrain nor either stack can change.
  const stroked = applyBrush(state.terrain, cmd);
  if (terrainsEqual(state.terrain, stroked)) {
    return state;
  }
  return {
    ...state,
    terrain: stroked,
    // Snapshot of the pre-stroke terrain; a new stroke abandons the redo branch.
    undoStack: pushCapped(state.undoStack, cloneTerrain(state.terrain)),
    redoStack: [],
  };
}

/** Steps one entry back. No-op (same object) when there is nothing to undo. */
export function editorUndo(state: EditorState): EditorState {
  const { undoStack, redoStack } = state;
  if (undoStack.length === 0) {
    return state;
  }
  const restored = undoStack[undoStack.length - 1];
  return {
    ...state,
    terrain: cloneTerrain(restored),
    undoStack: undoStack.slice(0, undoStack.length - 1),
    redoStack: redoStack.concat(cloneTerrain(state.terrain)),
  };
}

/** Steps one entry forward. No-op (same object) when the redo branch is empty. */
export function editorRedo(state: EditorState): EditorState {
  const { undoStack, redoStack } = state;
  if (redoStack.length === 0) {
    return state;
  }
  const restored = redoStack[redoStack.length - 1];
  return {
    ...state,
    terrain: cloneTerrain(restored),
    undoStack: undoStack.concat(cloneTerrain(state.terrain)),
    redoStack: redoStack.slice(0, redoStack.length - 1),
  };
}

/**
 * Replaces the current terrain with an already validated TerrainV1 (the
 * caller runs validateTerrain / importTerrainJson first) and clears the whole
 * history. The incoming terrain is deep-copied, so later mutation of the
 * caller's object cannot leak into the editor.
 */
export function editorReplace(state: EditorState, terrain: TerrainV1): EditorState {
  return {
    ...state,
    terrain: cloneTerrain(terrain),
    undoStack: [],
    redoStack: [],
  };
}

/** Restores the initial terrain and clears the whole history. */
export function editorReset(state: EditorState): EditorState {
  return {
    ...state,
    terrain: cloneTerrain(state.initial),
    undoStack: [],
    redoStack: [],
  };
}

export function editorCanUndo(state: EditorState): boolean {
  return state.undoStack.length > 0;
}

export function editorCanRedo(state: EditorState): boolean {
  return state.redoStack.length > 0;
}

/**
 * React hook owning the editor state. The returned API object is memoized:
 * `stroke` / `undo` / `redo` / `replaceTerrain` / `reset` have stable
 * identities across renders and `terrain` changes identity only when the
 * terrain itself changes, so downstream components may safely use it as a
 * dependency.
 *
 * The initial terrain is captured once, on first render; passing a different
 * object later does not reset the editor (use `replaceTerrain` instead).
 *
 * Operations run against a ref that mirrors the current state, so an invalid
 * command throws synchronously in the caller's frame instead of during a
 * React render, and several operations batched into one event handler chain
 * correctly (each sees the result of the previous one).
 *
 * Consumers must treat `terrain` as immutable: mutating its `elevations` in
 * place bypasses history. Domain code never does this (T005 applyBrush is
 * pure), and the deep-copied snapshots here stay independent even if a caller
 * does.
 */
export function useTerrainEditor(initial: TerrainV1): TerrainEditorApi {
  const [state, setState] = useState<EditorState>(() => createEditorState(initial));
  const stateRef = useRef<EditorState>(state);

  const apply = useCallback((next: EditorState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const stroke = useCallback(
    (cmd: BrushCommand) => {
      apply(editorStroke(stateRef.current, cmd));
    },
    [apply],
  );

  const undo = useCallback(() => {
    apply(editorUndo(stateRef.current));
  }, [apply]);

  const redo = useCallback(() => {
    apply(editorRedo(stateRef.current));
  }, [apply]);

  const replaceTerrain = useCallback(
    (terrain: TerrainV1) => {
      apply(editorReplace(stateRef.current, terrain));
    },
    [apply],
  );

  const reset = useCallback(() => {
    apply(editorReset(stateRef.current));
  }, [apply]);

  return useMemo<TerrainEditorApi>(
    () => ({
      terrain: state.terrain,
      stroke,
      undo,
      redo,
      canUndo: state.undoStack.length > 0,
      canRedo: state.redoStack.length > 0,
      replaceTerrain,
      reset,
    }),
    [state, stroke, undo, redo, replaceTerrain, reset],
  );
}
