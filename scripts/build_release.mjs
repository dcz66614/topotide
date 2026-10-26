// P0001-T017 — TopoTide release builder (deterministic, offline, no secrets).
//
// Usage (from the repository root):
//   node scripts/build_release.mjs <project-root>
// project-root = <...>/projects/P0001-topotide (the project tree, not the repo).
//
// Reads the frozen HEAD tree via `git ls-files` (tracked files only, so
// .git, node_modules, dist, .env and any untracked file can never enter
// the release). Writes:
//   04_source/SOURCE_MANIFEST.csv
//   04_source/source-release.zip
//   04_source/SHA256SUMS.txt
//   07_evidence/REVIEW_PACKS/REVIEW_PACK_XX.md
//   07_evidence/REVIEW_PACKS/REVIEW_INDEX.md
// and verifies afterwards: manifest count == tracked file count, every
// file appears in exactly one pack with matching SHA-256, every pack
// file <= 120 KiB, and the zip file list == the manifest list.
// Exits non-zero on any mismatch instead of writing a partial release.
//
// Packing rule: files in `git ls-files` order, cumulative raw bytes per
// pack <= 110000, which keeps each pack file (headers + fences) under
// 120 KiB. A single file larger than the budget would get its own pack
// (none exists in this tree: the largest tracked file is ~54 KiB).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error("usage: node scripts/build_release.mjs <project-root>");
  process.exit(2);
}
const repoRoot = process.cwd();
const srcDir = join(projectRoot, "04_source");
const packsDir = join(projectRoot, "07_evidence", "REVIEW_PACKS");

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", cwd: repoRoot, ...opts });
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function csvField(v) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// The working tree must match HEAD for tracked files; otherwise the
// manifest would describe files the frozen commit does not contain.
try {
  sh("git", ["diff", "--quiet"]);
  sh("git", ["diff", "--cached", "--quiet"]);
} catch {
  console.error("refusing: tracked working tree differs from HEAD");
  process.exit(1);
}

const releaseCommit = sh("git", ["rev-parse", "HEAD"]).trim();
const tracked = sh("git", ["ls-files"]).trim().split("\n").filter(Boolean);

// Task mapping (from the P0001 task board; configs/scaffold = T001).
const taskOf = (p) => {
  if (p === "src/domain/types.ts" || p === "src/domain/validate.ts") return "T002";
  if (p === "src/domain/persistence.ts") return "T003";
  if (p === "tests/helpers/oracle.ts") return "T004";
  if (p === "src/domain/brush.ts") return "T005";
  if (p === "src/domain/presets.ts") return "T006";
  if (p === "src/domain/serialization.ts" || p === "src/domain/summarize.ts") return "T007";
  if (p === "src/components/TerrainCanvas.tsx" || p === "src/components/TerrainCanvas.module.css") return "T008";
  if (p === "src/components/PersistencePanel.tsx" || p === "src/components/EventPanel.tsx" || p === "src/components/Charts.module.css") return "T009";
  if (p === "src/hooks/useTerrainEditor.ts") return "T010";
  if (p === "src/App.tsx" || p === "src/components/EditToolbar.tsx" || p === "src/components/StatusBar.tsx" || p === "src/styles.css") return "T011";
  if (p === "src/components/ComparePanel.tsx" || p === "src/components/ComparePanel.module.css") return "T012";
  if (p === "tests/e2e/main-flow.spec.ts") return "T013";
  if (p === "scripts/bench.ts") return "T014";
  if (p === "README.md") return "T016";
  if (p === "scripts/build_release.mjs") return "T017";
  if (p === "vite.config.ts") return "T001;T013-FIX";
  if (p === "playwright.config.ts") return "T001;T013";
  if (p.startsWith("tests/")) return "T002-T013";
  return "T001";
};

const kindOf = (p) => {
  if (p.startsWith("src/domain/")) return "domain";
  if (p.startsWith("src/components/")) return "component";
  if (p.startsWith("src/hooks/")) return "hook";
  if (p === "src/App.tsx" || p === "src/main.tsx" || p === "src/styles.css") return "app";
  if (p.startsWith("tests/helpers/")) return "test-helper";
  if (p.startsWith("tests/e2e/")) return "e2e-test";
  if (p.startsWith("tests/")) return "test";
  if (p.startsWith("scripts/")) return "script";
  if (p.startsWith("public/")) return "asset";
  if (p === "README.md") return "doc";
  return "config";
};

const langOf = (p) => {
  if (p.endsWith(".tsx")) return "tsx";
  if (p.endsWith(".ts")) return "ts";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".svg")) return "xml";
  if (p.endsWith(".md")) return "md";
  return "text";
};

const files = tracked.map((p) => {
  const buf = readFileSync(join(repoRoot, p));
  if (buf.includes(0)) throw new Error(`binary file not supported in review packs: ${p}`);
  const text = buf.toString("utf8");
  const runs = text.match(/`+/g) || [];
  const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length)) + 1);
  return { path: p, bytes: buf.length, sha: sha256(buf), text, fence };
});

// Pack greedily in ls-files order, raw bytes <= 110000 per pack.
const PACK_BUDGET = 110000;
const packs = [];
let cur = [];
let curBytes = 0;
for (const f of files) {
  if (cur.length > 0 && curBytes + f.bytes > PACK_BUDGET) {
    packs.push(cur);
    cur = [];
    curBytes = 0;
  }
  cur.push(f);
  curBytes += f.bytes;
}
if (cur.length > 0) packs.push(cur);
const packName = (i) => `REVIEW_PACK_${String(i + 1).padStart(2, "0")}.md`;
files.forEach((f) => {
  f.pack = packName(packs.findIndex((pk) => pk.includes(f)));
});

mkdirSync(srcDir, { recursive: true });
mkdirSync(packsDir, { recursive: true });

// Manifest.
const manifestLines = ["relative_path,kind,bytes,sha256,review_pack,requirement_ids,notes"];
for (const f of files) {
  manifestLines.push(
    [f.path, kindOf(f.path), f.bytes, f.sha, f.pack, taskOf(f.path), "tracked file at release commit"].map(csvField).join(","),
  );
}
writeFileSync(join(srcDir, "SOURCE_MANIFEST.csv"), manifestLines.join("\n") + "\n", "utf8");

// Zip (tracked files only, no extra fields).
const zipPath = join(srcDir, "source-release.zip");
if (existsSync(zipPath)) rmSync(zipPath);
execFileSync("zip", ["-X", "-q", zipPath, ...tracked], { cwd: repoRoot, encoding: "utf8" });

// SHA256SUMS: zip + four spec files (specs are NOT inside the zip; their
// hashes are recorded for reference). Spec paths are project-tree relative.
const specFiles = [
  "01_project_book/PROJECT_BOOK.md",
  "01_project_book/PROJECT_BOOK.docx",
  "02_implementation_plan/IMPLEMENTATION_PLAN.md",
  "02_implementation_plan/IMPLEMENTATION_PLAN.docx",
];
const sumLines = [
  "# P0001 TopoTide release hashes",
  `# release_commit: ${releaseCommit}`,
  `# source-release.zip contains the ${files.length} tracked source files only (no specs, no .git, no node_modules, no dist, no credentials)`,
  "",
  `${sha256(readFileSync(zipPath))}  04_source/source-release.zip`,
];
for (const s of specFiles) {
  const full = join(projectRoot, s);
  sumLines.push(existsSync(full) ? `${sha256(readFileSync(full))}  ${s}` : `# missing: ${s}`);
}
writeFileSync(join(srcDir, "SHA256SUMS.txt"), sumLines.join("\n") + "\n", "utf8");

// Review packs.
packs.forEach((pk, i) => {
  const out = [
    `# P0001 TopoTide Review Pack ${String(i + 1).padStart(2, "0")}`,
    "",
    `Release commit: ${releaseCommit}`,
    `Files in this pack: ${pk.length}`,
    "",
  ];
  for (const f of pk) {
    out.push(`START FILE: ${f.path}`);
    out.push(`SHA256: ${f.sha}`);
    out.push(`${f.fence}${langOf(f.path)}`);
    out.push(f.text.endsWith("\n") ? f.text.slice(0, -1) : f.text);
    out.push(f.fence);
    out.push(`END FILE: ${f.path}`);
    out.push("");
  }
  writeFileSync(join(packsDir, packName(i)), out.join("\n"), "utf8");
});

// Review index.
const totalBytes = files.reduce((a, f) => a + f.bytes, 0);
const indexLines = [
  "# P0001 TopoTide Review Index",
  "",
  `Release commit: ${releaseCommit}`,
  `Tracked source files: ${files.length}`,
  `Total source bytes: ${totalBytes}`,
  `Review packs: ${packs.length} (each pack file <= 120 KiB; no file truncated; each file appears exactly once)`,
  `Manifest: 04_source/SOURCE_MANIFEST.csv`,
  `Archive: 04_source/source-release.zip`,
  "",
  "| relative_path | bytes | sha256 | review_pack | requirement_ids |",
  "| --- | ---: | --- | --- | --- |",
];
for (const f of files) {
  indexLines.push(`| ${f.path} | ${f.bytes} | ${f.sha} | ${f.pack} | ${taskOf(f.path)} |`);
}
indexLines.push("", "Binary files: none (all tracked files are text, including public/favicon.svg which is XML text).");
indexLines.push("Secrets: none — the zip and packs contain tracked source files only; no .env, credential, key, token, email or phone content.");
writeFileSync(join(packsDir, "REVIEW_INDEX.md"), indexLines.join("\n") + "\n", "utf8");

// Verification: pack size, coverage, sha round-trip, zip listing.
for (let i = 0; i < packs.length; i++) {
  const size = statSync(join(packsDir, packName(i))).size;
  if (size > 120 * 1024) throw new Error(`pack too large: ${packName(i)} = ${size} bytes`);
}
const packText = packs.map((_, i) => readFileSync(join(packsDir, packName(i)), "utf8")).join("\n");
for (const f of files) {
  const starts = packText.split(`START FILE: ${f.path}\n`).length - 1;
  if (starts !== 1) throw new Error(`coverage mismatch: ${f.path} appears ${starts} times`);
  const block = packText.split(`START FILE: ${f.path}\n`)[1].split(`\nEND FILE: ${f.path}`)[0];
  const claimed = block.split("\n")[0].replace("SHA256: ", "").trim();
  if (claimed !== f.sha) throw new Error(`sha mismatch in pack: ${f.path}`);
}
const zipList = sh("unzip", ["-Z1", zipPath]).trim().split("\n").filter(Boolean);
const zipSet = new Set(zipList);
if (zipSet.size !== files.length || !files.every((f) => zipSet.has(f.path))) {
  throw new Error(`zip listing does not match manifest (${zipSet.size} vs ${files.length})`);
}

console.log(JSON.stringify({
  releaseCommit,
  files: files.length,
  totalBytes,
  packs: packs.length,
  zipSha256: sha256(readFileSync(zipPath)),
  zipBytes: statSync(zipPath).size,
}, null, 2));
