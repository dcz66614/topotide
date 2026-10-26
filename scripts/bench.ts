/**
 * P0001-T014 — CPU benchmark for analyzePersistence() (gate MAT-007).
 *
 * Fixed protocol (implementation plan §P0001-T014 — deliberately not tunable):
 *   1. Build the bench terrain exactly once (untimed): 128x128 integer
 *      elevations 0..255, row-major, from a deterministic xorshift32 with
 *      seed=42, every cell taking rand() % 256.
 *   2. Warm up with 3 untimed analyzePersistence(terrain) calls.
 *   3. Time 20 runs. Each sample is one performance.now() pair wrapped around
 *      exactly one analyzePersistence(terrain) call; terrain generation,
 *      warmup, statistics and file I/O stay outside every timed window.
 *   4. Statistics over the 20 samples after ascending sort:
 *      min = sorted[0], max = sorted[19],
 *      median = (sorted[9] + sorted[10]) / 2, p95 = sorted[18], N = 20.
 *   5. Print the full JSON report to stdout AND write it, plus a human
 *      readable log, to the project-tree directory
 *      05_tests/benchmark/bench-<first-8-of-commit>.{json,log}
 *      (resolved relative to this file via import.meta.url; the BENCH_OUT_DIR
 *      environment variable overrides the output directory).
 *   6. If median > 250 ms the process exits non-zero (process.exitCode = 1).
 *      Logs are never hidden and numbers are never adjusted to pass.
 *
 * Type note: this repo ships no @types/node and T014 may not touch
 * package.json / tsconfig.json, so every Node builtin import below carries a
 * load-bearing @ts-expect-error and is narrowed to a minimal structural
 * interface right after import. If node types are ever installed, these
 * directives start erroring ("unused") on purpose instead of hiding anything.
 */
import { analyzePersistence } from '../src/domain/persistence';
import type { TerrainV1 } from '../src/domain/types';

// @ts-expect-error — no @types/node in this repo (see the file header).
import * as nodeOs from 'node:os';
// @ts-expect-error — no @types/node in this repo (see the file header).
import * as nodeFs from 'node:fs';
// @ts-expect-error — no @types/node in this repo (see the file header).
import * as nodePath from 'node:path';
// @ts-expect-error — no @types/node in this repo (see the file header).
import * as nodeUrl from 'node:url';
// @ts-expect-error — no @types/node in this repo (see the file header).
import * as nodeChildProcess from 'node:child_process';

/** Minimal structural view of `node:os` used by this script. */
interface OsModule {
  platform(): string;
  release(): string;
  cpus(): Array<{ model: string }>;
  loadavg(): [number, number, number];
}

/** Minimal structural view of the `node:fs` functions used by this script. */
interface FsModule {
  mkdirSync(dir: string | URL, options: { recursive: true }): string | undefined;
  writeFileSync(file: string | URL, data: string): void;
}

/** Minimal structural view of `node:path` used by this script. */
interface PathModule {
  resolve(...segments: string[]): string;
  join(...segments: string[]): string;
}

/** Minimal structural view of `node:url` used by this script. */
interface UrlModule {
  fileURLToPath(url: string | URL): string;
}

/** Minimal structural view of `node:child_process` used by this script. */
interface ChildProcessModule {
  execFileSync(
    file: string,
    args: string[],
    options: { cwd: string; encoding: 'utf8' },
  ): string;
}

/** Minimal ambient view of the Node.js `process` global used by this script. */
declare const process: {
  readonly version: string;
  exitCode: number | null | undefined;
  readonly env: Record<string, string | undefined>;
};

const os = nodeOs as OsModule;
const fs = nodeFs as FsModule;
const path = nodePath as PathModule;
const url = nodeUrl as UrlModule;
const childProcess = nodeChildProcess as ChildProcessModule;

/** Task-card constants (plan §P0001-T014): grid, PRNG seed, run counts. */
const BENCH_SEED = 42;
const GRID_WIDTH = 128;
const GRID_HEIGHT = 128;
const WARMUP_RUNS = 3;
const TIMED_RUNS = 20;
/** Budget gate: the median of the 20 timed samples must stay <= 250 ms. */
const MEDIAN_BUDGET_MS = 250;

/**
 * Deterministic xorshift32, mirroring the T004 construction: the requested
 * seed (here seed=42) is offset by the fixed nonzero constant 0x9e3779b9 so
 * that a requested seed of 0 could never collapse into xorshift32's all-zero
 * attractor state.
 */
function makeXorshift32(requestedSeed: number): () => number {
  let state = (requestedSeed + 0x9e3779b9) >>> 0;
  if (state === 0) {
    state = 0x6d2b79f5;
  }
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** The single bench terrain: generated once, outside every timed window. */
function buildTerrain(): TerrainV1 {
  const rand = makeXorshift32(BENCH_SEED);
  const cellCount = GRID_WIDTH * GRID_HEIGHT;
  const elevations: number[] = new Array<number>(cellCount);
  for (let cell = 0; cell < cellCount; cell += 1) {
    // Row-major fill (id = y * width + x); integer elevation in [0, 255].
    elevations[cell] = rand() % 256;
  }
  return {
    schemaVersion: 1,
    width: GRID_WIDTH,
    height: GRID_HEIGHT,
    elevations,
    title: 'bench-128x128-seed42',
  };
}

/** `git rev-parse HEAD` at the repo root; 'unknown' when git is unavailable. */
function readCommit(repoRoot: string): string {
  try {
    const stdout = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const commit = stdout.trim();
    return commit.length > 0 ? commit : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** One indented `NN: x.xxx ms` line per sample, 1-based, in the given order. */
function formatSamples(values: number[]): string {
  return values
    .map((ms, index) => `  ${String(index + 1).padStart(2, '0')}: ${ms.toFixed(3)} ms`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Environment bookkeeping (never inside a timed window).
// ---------------------------------------------------------------------------
const loadavgStart = os.loadavg();
// This file lives at 04_source/source/scripts/bench.ts, so one level up is the
// repository root (04_source/source/).
const repoRoot = url.fileURLToPath(new URL('../', import.meta.url));
const commit = readCommit(repoRoot);
// The evidence file name always carries the git-derived commit prefix.
const commitToken = commit === 'unknown' ? 'unknown' : commit.slice(0, 8);
const cpuModel = os.cpus()[0]?.model ?? 'unknown';

// ---------------------------------------------------------------------------
// Fixed bench protocol: build once, warm up 3, time 20.
// ---------------------------------------------------------------------------
const terrain: TerrainV1 = buildTerrain();

for (let warmup = 0; warmup < WARMUP_RUNS; warmup += 1) {
  analyzePersistence(terrain);
}

const rawMs: number[] = [];
for (let run = 0; run < TIMED_RUNS; run += 1) {
  const startedAt = performance.now();
  analyzePersistence(terrain);
  const endedAt = performance.now();
  rawMs.push(endedAt - startedAt);
}
const loadavgEnd = os.loadavg();

// ---------------------------------------------------------------------------
// Statistics (ascending sort; 0-based indices exactly as the task card says).
// ---------------------------------------------------------------------------
const sortedMs = [...rawMs].sort((a, b) => a - b);
const minMs = sortedMs[0]; // sorted 1st
const maxMs = sortedMs[TIMED_RUNS - 1]; // sorted 20th
const medianMs = (sortedMs[9] + sortedMs[10]) / 2; // mean of sorted 10th/11th
const p95Ms = sortedMs[18]; // 0-based index 18
const sampleCount = rawMs.length; // N = 20

const report = {
  min: minMs,
  median: medianMs,
  p95: p95Ms,
  max: maxMs,
  N: sampleCount,
  seed: BENCH_SEED,
  node: process.version,
  os: `${os.platform()} ${os.release()}`,
  cpu: cpuModel,
  commit,
  loadavgStart,
  loadavgEnd,
  rawMs,
  sortedMs,
};

const json = `${JSON.stringify(report, null, 2)}\n`;
// Full JSON to stdout first, so the measured data exists even if the evidence
// file write fails afterwards.
console.log(json);

const withinBudget = medianMs <= MEDIAN_BUDGET_MS;
const logText = [
  'P0001-T014 CPU benchmark — analyzePersistence() — gate MAT-007',
  `protocol: xorshift32 seed=${BENCH_SEED}, ${GRID_WIDTH}x${GRID_HEIGHT} row-major rand()%256;`,
  `          warmup ${WARMUP_RUNS} (untimed) + ${TIMED_RUNS} timed runs;`,
  '          each timed sample wraps exactly one analyzePersistence(terrain) call',
  '          (terrain generation, warmup, sorting, JSON and file I/O excluded)',
  `commit: ${commit} (evidence file token: ${commitToken})`,
  `node: ${process.version}`,
  `os: ${os.platform()} ${os.release()}`,
  `cpu: ${cpuModel}`,
  `loadavg (1m 5m 15m) at start: ${loadavgStart.join(' ')}`,
  `loadavg (1m 5m 15m) at end:   ${loadavgEnd.join(' ')}`,
  'raw 20 samples (ms, execution order; full precision in the .json):',
  formatSamples(rawMs),
  'sorted statistics (ms):',
  `  min    = sorted[0]                  = ${minMs.toFixed(3)}`,
  `  median = (sorted[9] + sorted[10])/2 = ${medianMs.toFixed(3)}`,
  `  p95    = sorted[18]                 = ${p95Ms.toFixed(3)}`,
  `  max    = sorted[19]                 = ${maxMs.toFixed(3)}`,
  `  N      = ${sampleCount}`,
  `budget: median ${medianMs.toFixed(3)} ms ${withinBudget ? '<=' : '>'} ${MEDIAN_BUDGET_MS} ms -> ${withinBudget ? 'PASS' : 'FAIL'}`,
  'exit code meaning: 0 = median within the 250 ms budget;',
  '                   1 = median exceeded 250 ms (budget breach, reported as measured)',
  `this run exit code: ${withinBudget ? '0' : '1'}`,
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Evidence files: 05_tests/benchmark/bench-<commit-8>.{json,log} resolved from
// this script via import.meta.url (…/04_source/source/scripts ->
// …/P0001-topotide/05_tests/benchmark), overridable through BENCH_OUT_DIR.
// ---------------------------------------------------------------------------
const outDirEnv = process.env.BENCH_OUT_DIR;
const outDir =
  outDirEnv && outDirEnv.trim().length > 0
    ? path.resolve(outDirEnv)
    : url.fileURLToPath(new URL('../../../05_tests/benchmark/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `bench-${commitToken}.json`), json);
fs.writeFileSync(path.join(outDir, `bench-${commitToken}.log`), logText);

if (!withinBudget) {
  process.exitCode = 1;
}
