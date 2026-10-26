/**
 * T009 tests — tests/panels.spec.tsx (IMPLEMENTATION_PLAN.md task card P0001-T009).
 *
 * ENVIRONMENT LIMITATION (honest scope note): this repo has no jsdom and no
 * happy-dom, `vite.config.ts` pins `test.environment: "node"`, and
 * `package.json` must not be modified. So this suite exercises exactly what
 * can be verified without a DOM: the pure exported helpers of the two panel
 * modules (`visiblePairs` filtering, `barGeometry`, `sortVisiblePairs`, label
 * formatters, `sortEvents`, `cellToXY`, `nextLevel`) on the REAL
 * `analyzePersistence` result of the STRIP terrain, plus a non-mounting
 * `createElement` contract check for both components. No React component is
 * mounted and no real browser rendering happens here; real-browser rendering /
 * screenshot evidence is deferred to T011 (wiring) and T013 (Playwright E2E)
 * by the plan.
 *
 * Scientific honesty checks baked in (PROJECT_BOOK.md §6.2):
 *  - the essential pair is NEVER shown as death=0 — its label says 未定义 and
 *    carries the note 「持续到过滤末端，数学死亡未定义」;
 *  - no negative lifetime is ever produced for any pair;
 *  - finite bars always list birth, death and persistence=birth-death.
 */
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  EventPanel,
  cellToXY,
  eventRowText,
  nextLevel,
  sortEvents,
} from '../src/components/EventPanel';
import {
  AXIS_MAX_LEVEL,
  ESSENTIAL_NOTE,
  PersistencePanel,
  barGeometry,
  barTitle,
  essentialBarText,
  finiteBarText,
  levelToAxis,
  sortVisiblePairs,
} from '../src/components/PersistencePanel';
import { visiblePairs } from '../src/domain/summarize';
import { analyzePersistence } from '../src/domain/persistence';
import type { PersistencePair, PersistenceResult, TerrainV1 } from '../src/domain/types';

/* ------------------------------------------------------------------ *
 * Local structural mirrors of the frozen §4.3 contracts (they pin the
 * shape the components must expose; see 'component contract' suite).
 * ------------------------------------------------------------------ */

interface PersistencePanelProps {
  result: PersistenceResult;
  tau: number;
  selectedPairId: string | null;
  onSelectPair(id: string): void;
  onTauChange(tau: number): void;
}

interface EventPanelProps {
  result: PersistenceResult;
  selectedPairId: string | null;
  width: number;
  level: number;
  onSelectPair(id: string): void;
  onSetLevel(h: number): void;
}

/* ------------------------------------------------------------------ *
 * Local test helpers (independent of the components under test)
 * ------------------------------------------------------------------ */

function makeTerrain(width: number, height: number, elevations: number[]): TerrainV1 {
  return { schemaVersion: 1, width, height, elevations, title: 't009-panels' };
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

/** Real analysis of the STRIP preset from the task card: [5, 1, 4, 1, 3]. */
const S_STRIP = (): TerrainV1 => makeTerrain(5, 1, [5, 1, 4, 1, 3]);
const STRIP_RESULT = (): PersistenceResult => analyzePersistence(S_STRIP());

function findPair(result: PersistenceResult, id: string): PersistencePair {
  const pair = result.pairs.find((candidate) => candidate.id === id);
  if (pair === undefined) {
    throw new Error(`pair ${id} missing`);
  }
  return pair;
}

/* ------------------------------------------------------------------ *
 * Real STRIP analysis: two finite barcodes + one essential
 * ------------------------------------------------------------------ */

describe('analyzePersistence on STRIP [5,1,4,1,3] (real result)', () => {
  it('produces exactly the two finite barcodes 4→1 (p=3) and 3→1 (p=2)', () => {
    const result = STRIP_RESULT();
    expect(result.pairs).toHaveLength(3);

    const peak2 = findPair(result, 'peak-2');
    expect(peak2).toEqual({
      id: 'peak-2',
      peakCell: 2,
      birth: 4,
      death: 1,
      persistence: 3,
      winnerPeakCell: 0,
      witnessCell: 1,
    });

    const peak4 = findPair(result, 'peak-4');
    expect(peak4).toEqual({
      id: 'peak-4',
      peakCell: 4,
      birth: 3,
      death: 1,
      persistence: 2,
      winnerPeakCell: 0,
      witnessCell: 3,
    });
  });

  it('keeps the essential pair mathematically undefined (death/persistence null)', () => {
    const result = STRIP_RESULT();
    const essential = findPair(result, 'peak-0');
    expect(essential).toEqual({
      id: 'peak-0',
      peakCell: 0,
      birth: 5,
      death: null,
      persistence: null,
      winnerPeakCell: null,
      witnessCell: null,
    });
    // null death must never leak into a number (and never as 0).
    expect(essential.death === null).toBe(true);
    expect(essential.persistence === null).toBe(true);
  });

  it('emits two merge events at level 1 with the right loser/winner/witness', () => {
    const result = STRIP_RESULT();
    expect(result.merges).toEqual([
      { id: 'peak-2', level: 1, winnerPeakCell: 0, loserPeakCell: 2, witnessCell: 1 },
      { id: 'peak-4', level: 1, winnerPeakCell: 0, loserPeakCell: 4, witnessCell: 3 },
    ]);
  });

  it('never yields a negative or zero finite lifetime anywhere', () => {
    const result = STRIP_RESULT();
    for (const pair of result.pairs) {
      if (pair.persistence === null) {
        continue; // essential: undefined by mathematics, not a number
      }
      expect(Number.isInteger(pair.persistence)).toBe(true);
      expect(pair.persistence).toBeGreaterThan(0);
      expect(pair.persistence).toBe(pair.birth - (pair.death as number));
      expect(pair.birth).toBeGreaterThan(pair.death as number);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Barcode geometry: x(death) → x(birth), essential 0 → birth
 * ------------------------------------------------------------------ */

describe('barGeometry (axis 0..255, pure)', () => {
  it('maps levels linearly onto the axis width (identity at axisWidth=255)', () => {
    expect(AXIS_MAX_LEVEL).toBe(255);
    expect(levelToAxis(0, 255)).toBe(0);
    expect(levelToAxis(255, 255)).toBe(255);
    expect(levelToAxis(1, 255)).toBe(1);
    expect(levelToAxis(128, 510)).toBe(256);
    expect(levelToAxis(64, 100)).toBeCloseTo((64 / 255) * 100, 10);
  });

  it('draws a finite bar from x(death) to x(birth) with persistence=birth-death', () => {
    const peak2 = findPair(STRIP_RESULT(), 'peak-2');
    expect(barGeometry(peak2, 255)).toEqual({
      x0: 1, // x(death)
      x1: 4, // x(birth)
      isEssential: false,
      birth: 4,
      death: 1,
      persistence: 3,
    });
    expect(barGeometry(peak2, 510)).toEqual({
      x0: 2,
      x1: 8,
      isEssential: false,
      birth: 4,
      death: 1,
      persistence: 3,
    });
    const peak4 = findPair(STRIP_RESULT(), 'peak-4');
    expect(barGeometry(peak4, 255).x0).toBe(1);
    expect(barGeometry(peak4, 255).x1).toBe(3);
    // Bar length is exactly the persistence on an identity axis: never negative.
    const geometry = barGeometry(peak4, 255);
    expect(geometry.x1 - geometry.x0).toBe(2);
    expect(geometry.x1 - geometry.x0).toBeGreaterThan(0);
  });

  it('draws the essential bar from 0 to x(birth) and never fakes death=0', () => {
    const essential = findPair(STRIP_RESULT(), 'peak-0');
    expect(barGeometry(essential, 255)).toEqual({
      x0: 0,
      x1: 5,
      isEssential: true,
      birth: 5,
      death: null, // undefined — NOT 0
      persistence: null, // undefined — NOT birth-0
    });
    expect(barGeometry(essential, 100).x1).toBeCloseTo((5 / 255) * 100, 10);
  });
});

/* ------------------------------------------------------------------ *
 * Barcode ordering + tau filtering
 * ------------------------------------------------------------------ */

describe('sortVisiblePairs (essential pinned top, persistence desc)', () => {
  it('orders the real STRIP pairs: essential first, then p=3, then p=2', () => {
    const result = STRIP_RESULT();
    expect(sortVisiblePairs(result.pairs).map((pair) => pair.id)).toEqual([
      'peak-0',
      'peak-2',
      'peak-4',
    ]);
  });

  it('restores the essential to the top even when the input is shuffled', () => {
    const result = STRIP_RESULT();
    const shuffled = [result.pairs[2], result.pairs[0], result.pairs[1]];
    expect(sortVisiblePairs(shuffled).map((pair) => pair.id)).toEqual([
      'peak-0',
      'peak-2',
      'peak-4',
    ]);
  });

  it('breaks persistence ties deterministically (birth desc, peakCell asc)', () => {
    const essential = findPair(STRIP_RESULT(), 'peak-0');
    const tieA: PersistencePair = {
      id: 'peak-10',
      peakCell: 10,
      birth: 3,
      death: 1,
      persistence: 2,
      winnerPeakCell: 0,
      witnessCell: 9,
    };
    const tieB: PersistencePair = {
      id: 'peak-6',
      peakCell: 6,
      birth: 5,
      death: 3,
      persistence: 2,
      winnerPeakCell: 0,
      witnessCell: 4,
    };
    const ordered = sortVisiblePairs([tieA, tieB, essential]);
    expect(ordered.map((pair) => pair.id)).toEqual(['peak-0', 'peak-6', 'peak-10']);
  });

  it('returns a fresh array and never mutates its input', () => {
    const result = STRIP_RESULT();
    const snapshot = result.pairs.map((pair) => pair.id);
    const sorted = sortVisiblePairs(result.pairs);
    expect(sorted).not.toBe(result.pairs);
    expect(result.pairs.map((pair) => pair.id)).toEqual(snapshot);
  });
});

describe('visiblePairs tau filtering (essential always retained)', () => {
  it('keeps finite pairs iff persistence >= tau for tau = 0/1/2/3/4/255', () => {
    const result = STRIP_RESULT();
    // persistences available: 3 and 2.
    expect(visiblePairs(result, 0).map((pair) => pair.id)).toEqual(['peak-0', 'peak-2', 'peak-4']);
    expect(visiblePairs(result, 1).map((pair) => pair.id)).toEqual(['peak-0', 'peak-2', 'peak-4']);
    expect(visiblePairs(result, 2).map((pair) => pair.id)).toEqual(['peak-0', 'peak-2', 'peak-4']);
    expect(visiblePairs(result, 3).map((pair) => pair.id)).toEqual(['peak-0', 'peak-2']);
    expect(visiblePairs(result, 4).map((pair) => pair.id)).toEqual(['peak-0']);
    expect(visiblePairs(result, 255).map((pair) => pair.id)).toEqual(['peak-0']);
  });

  it('retains the essential pair at every threshold', () => {
    const result = STRIP_RESULT();
    for (const tau of [0, 1, 2, 3, 4, 127, 255]) {
      const visible = visiblePairs(result, tau);
      expect(visible.some((pair) => pair.id === 'peak-0' && pair.death === null)).toBe(true);
      for (const pair of visible) {
        if (pair.persistence !== null) {
          expect(pair.persistence).toBeGreaterThanOrEqual(tau);
        }
      }
    }
  });

  it('rejects non-integer or out-of-range tau like the domain layer', () => {
    const result = STRIP_RESULT();
    expect(() => visiblePairs(result, -1)).toThrow(RangeError);
    expect(() => visiblePairs(result, 256)).toThrow(RangeError);
    expect(() => visiblePairs(result, 1.5)).toThrow(RangeError);
  });

  it('filters without mutating the full pairs array', () => {
    const result = STRIP_RESULT();
    const snapshot = result.pairs.map((pair) => pair.id);
    visiblePairs(result, 255);
    expect(result.pairs.map((pair) => pair.id)).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ *
 * Labels: essential wording, no death=0, no negative lifetimes
 * ------------------------------------------------------------------ */

describe('barcode labels (scientific text)', () => {
  it('always lists birth, death and persistence=birth-death on finite bars', () => {
    const result = STRIP_RESULT();
    expect(finiteBarText(findPair(result, 'peak-2'))).toBe('birth 4 · death 1 · persistence=3');
    expect(finiteBarText(findPair(result, 'peak-4'))).toBe('birth 3 · death 1 · persistence=2');
  });

  it('labels the essential bar with the §6.2 note and no death number', () => {
    expect(ESSENTIAL_NOTE).toBe('持续到过滤末端，数学死亡未定义');
    const result = STRIP_RESULT();
    const text = essentialBarText(findPair(result, 'peak-0'));
    expect(text).toContain('birth 5');
    expect(text).toContain('未定义');
    expect(text).toContain(ESSENTIAL_NOTE);
    // Never death=0, never a fabricated persistence number.
    expect(text).not.toMatch(/death\s*=\s*0/);
    expect(text).not.toMatch(/death\s+0/);
    expect(text).not.toMatch(/persistence\s*=\s*-?\d/);
  });

  it('shows no negative lifetime in any label of any pair', () => {
    const result = STRIP_RESULT();
    for (const pair of result.pairs) {
      const text = pair.death === null ? essentialBarText(pair) : finiteBarText(pair);
      expect(text).not.toMatch(/persistence\s*=\s*-/);
      expect(text).not.toMatch(/death\s*=\s*-/);
      expect(text).toMatch(/birth \d+/);
    }
    expect(barTitle(findPair(result, 'peak-2'))).toBe('峰 peak-2（格 2）');
  });
});

/* ------------------------------------------------------------------ *
 * Merge events: order, coordinates, previous level
 * ------------------------------------------------------------------ */

describe('sortEvents (level desc, loserPeakCell asc, witnessCell asc)', () => {
  it('orders the real STRIP events with the loserPeak tie-break', () => {
    const result = STRIP_RESULT();
    // Both merges sit at level 1: loserPeakCell 2 before 4 decides.
    expect(sortEvents(result.merges).map((event) => event.id)).toEqual(['peak-2', 'peak-4']);
  });

  it('sorts across levels descending and breaks ties deterministically', () => {
    const base = { winnerPeakCell: 0 };
    const shuffled = [
      { id: 'peak-2', level: 1, ...base, loserPeakCell: 2, witnessCell: 1 },
      { id: 'peak-9', level: 5, ...base, loserPeakCell: 9, witnessCell: 8 },
      { id: 'peak-6', level: 5, ...base, loserPeakCell: 6, witnessCell: 7 },
      { id: 'peak-4', level: 5, ...base, loserPeakCell: 6, witnessCell: 4 },
      { id: 'peak-7', level: 0, ...base, loserPeakCell: 7, witnessCell: 3 },
    ];
    expect(sortEvents(shuffled).map((event) => event.id)).toEqual([
      'peak-4', // level 5, loser 6, witness 4
      'peak-6', // level 5, loser 6, witness 7
      'peak-9', // level 5, loser 9
      'peak-2', // level 1
      'peak-7', // level 0
    ]);
  });

  it('returns a fresh array and never mutates its input', () => {
    const result = STRIP_RESULT();
    const snapshot = result.merges.map((event) => event.id);
    const sorted = sortEvents(result.merges);
    expect(sorted).not.toBe(result.merges);
    expect(result.merges.map((event) => event.id)).toEqual(snapshot);
  });
});

describe('cellToXY (row-major: x = cell % width, y = floor(cell / width))', () => {
  it('maps the real STRIP witness cells on the 5-wide grid', () => {
    expect(cellToXY(1, 5)).toEqual({ x: 1, y: 0 });
    expect(cellToXY(3, 5)).toEqual({ x: 3, y: 0 });
    const result = STRIP_RESULT();
    expect(cellToXY(result.merges[0].witnessCell, 5)).toEqual({ x: 1, y: 0 });
    expect(cellToXY(result.merges[1].witnessCell, 5)).toEqual({ x: 3, y: 0 });
  });

  it('wraps rows exactly at the grid width', () => {
    expect(cellToXY(0, 64)).toEqual({ x: 0, y: 0 });
    expect(cellToXY(63, 64)).toEqual({ x: 63, y: 0 });
    expect(cellToXY(64, 64)).toEqual({ x: 0, y: 1 });
    expect(cellToXY(7, 5)).toEqual({ x: 2, y: 1 });
    expect(cellToXY(2 * 8 + 3, 8)).toEqual({ x: 3, y: 2 });
  });

  it('rejects broken inputs instead of inventing coordinates', () => {
    expect(() => cellToXY(-1, 5)).toThrow(RangeError);
    expect(() => cellToXY(0, 0)).toThrow(RangeError);
    expect(() => cellToXY(1.5, 5)).toThrow(RangeError);
    expect(() => cellToXY(0, 2.5)).toThrow(RangeError);
  });
});

describe('nextLevel (previous filtration level h+1)', () => {
  it('returns level + 1 below the cap', () => {
    expect(nextLevel(0)).toBe(1);
    expect(nextLevel(1)).toBe(2);
    expect(nextLevel(254)).toBe(255);
  });

  it('returns null at 255 and beyond (level 255 has no previous level)', () => {
    expect(nextLevel(255)).toBeNull();
    expect(nextLevel(256)).toBeNull();
    expect(nextLevel(9999)).toBeNull();
  });
});

describe('eventRowText (row explanation with real coordinates)', () => {
  it('names loser, winner and witness coordinates of the real STRIP events', () => {
    const result = STRIP_RESULT();
    const text = eventRowText(result.merges[0], 5);
    expect(text).toContain('高度 1');
    expect(text).toContain('峰 (2,0) 被峰 (0,0) 吞并');
    expect(text).toContain('witness (1,0)');
    expect(text).toContain('较年轻山峰在此配对终止');
  });
});

/* ------------------------------------------------------------------ *
 * Component contract (no DOM, no mounting)
 * ------------------------------------------------------------------ */

describe('component contract without a DOM', () => {
  const panelProps = (): PersistencePanelProps => ({
    result: STRIP_RESULT(),
    tau: 1,
    selectedPairId: null,
    onSelectPair: () => {},
    onTauChange: () => {},
  });

  const eventProps = (): EventPanelProps => ({
    result: STRIP_RESULT(),
    selectedPairId: null,
    width: 5,
    level: 1,
    onSelectPair: () => {},
    onSetLevel: () => {},
  });

  it('accepts exactly the §4.3 PersistencePanelProps via createElement', () => {
    const props = panelProps();
    const element = createElement(PersistencePanel, props);
    expect(element).toBeTruthy();
    expect(element.type).toBe(PersistencePanel);
    expect(element.props.result).toBe(props.result);
    expect(element.props.tau).toBe(1);
    expect(element.props.selectedPairId).toBeNull();
    expect(typeof element.props.onSelectPair).toBe('function');
    expect(typeof element.props.onTauChange).toBe('function');
    // createElement with props only: no children were passed in (never mounted).
    expect((element.props as { children?: unknown }).children).toBeUndefined();
  });

  it('accepts a selected finite pair id and a non-default tau', () => {
    const props = panelProps();
    props.selectedPairId = 'peak-2';
    props.tau = 3;
    const element = createElement(PersistencePanel, props);
    expect(element).toBeTruthy();
    expect(element.props.selectedPairId).toBe('peak-2');
    expect(element.props.tau).toBe(3);
  });

  it('accepts exactly the §4.3 EventPanelProps via createElement', () => {
    const props = eventProps();
    const element = createElement(EventPanel, props);
    expect(element).toBeTruthy();
    expect(element.type).toBe(EventPanel);
    expect(element.props.result).toBe(props.result);
    expect(element.props.width).toBe(5);
    expect(element.props.level).toBe(1);
    expect(element.props.selectedPairId).toBeNull();
    expect(typeof element.props.onSelectPair).toBe('function');
    expect(typeof element.props.onSetLevel).toBe('function');
    expect((element.props as { children?: unknown }).children).toBeUndefined();
  });

  it('accepts a selected event id and a cap level whose previous level is null', () => {
    const props = eventProps();
    props.selectedPairId = 'peak-4';
    props.level = 255;
    const element = createElement(EventPanel, props);
    expect(element).toBeTruthy();
    expect(element.props.selectedPairId).toBe('peak-4');
    // Contract: the "上一级" button must be disabled at level 255 (nextLevel → null).
    expect(nextLevel(element.props.level)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Input immutability
 * ------------------------------------------------------------------ */

describe('input immutability', () => {
  it('never mutates the terrain handed to analyzePersistence', () => {
    const terrain = S_STRIP();
    const snapshot = Array.from(terrain.elevations);
    analyzePersistence(terrain);
    expect(Array.from(terrain.elevations)).toEqual(snapshot);
  });

  it('runs every helper on a deeply frozen result without throwing', () => {
    const result = deepFreeze(STRIP_RESULT());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.pairs)).toBe(true);
    expect(() => {
      for (const tau of [0, 1, 3, 255]) {
        visiblePairs(result, tau);
        sortVisiblePairs(visiblePairs(result, tau));
      }
      for (const pair of result.pairs) {
        barGeometry(pair, 255);
        barGeometry(pair, 100);
        if (pair.death === null) {
          essentialBarText(pair);
        } else {
          finiteBarText(pair);
        }
      }
      sortEvents(result.merges);
      for (const event of result.merges) {
        cellToXY(event.witnessCell, 5);
        eventRowText(event, 5);
      }
      nextLevel(255);
    }).not.toThrow();
  });

  it('leaves the original pairs/merges order untouched after every sort', () => {
    const result = STRIP_RESULT();
    const pairsSnapshot = result.pairs.map((pair) => pair.id);
    const mergesSnapshot = result.merges.map((event) => event.id);
    sortVisiblePairs(result.pairs);
    sortEvents(result.merges);
    visiblePairs(result, 255);
    expect(result.pairs.map((pair) => pair.id)).toEqual(pairsSnapshot);
    expect(result.merges.map((event) => event.id)).toEqual(mergesSnapshot);
  });
});
