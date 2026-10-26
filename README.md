# TopoTide（岛屿谱 · 地貌拓扑实验室）v0.1.0

TopoTide 是一个**纯前端**的地貌持久性（persistence，持续同调的最简形态）教学实验台：
你在一块整数高程网格上用画笔雕塑地形、拖动水位滑块淹没低地，系统实时给出
超水平集连通数 β0 曲线、寿命条码（persistence barcode）、合并事件解释（峰顶 / witness）
以及基线对照。它的内核是一个确定性的 DSU（并查集）分层算法，全部计算在浏览器本地完成。

这不是营销页，而是复现入口：下面所有命令都对应本仓库的真实脚本与配置，
并且已在干净副本上按本文档实际执行过一遍（验收记录见下文「测试与性能基线」）。

---

## 1. 技术形态与运行环境

- 技术栈：React 19 + TypeScript + Vite + Canvas2D + SVG；无服务端、无 LLM、无外部 API。
- 包名 `topotide`，版本 `0.1.0`，`"private": true`，`"type": "module"`（见 `package.json`）。
- 本文档编写与验收时实际使用的工具链版本（`node -v` / `npm -v` / `git --version` 实测）：

  | 工具 | 版本 |
  |---|---|
  | Node.js | v24.22.1 |
  | npm | 10.9.4 |
  | git | 2.43.0 |

  未逐一验证其他版本；更旧的 Node（例如 18）未经测试，不承诺可用。
- 浏览器：任意现代浏览器即可运行 `dev` / `preview`。自动化 E2E 用 Playwright 1.64.1 +
  Chromium `chromium-1248`（Google Chrome for Testing 156.0.8078.4）完成过验证。

## 2. 安装

```bash
npm ci
```

`npm ci` 严格按 `package-lock.json` 安装依赖（lockfile 中除根包外共 98 个包）。
完整逐包许可证清单见项目树的 `08_release/THIRD_PARTY_NOTICES.md`（若你的源码包内没有
随附该文件，可向发布方索取）；概要：直接运行依赖
react / react-dom 19.3.1 为 MIT，开发依赖中 playwright 1.64.1 与 typescript 5.9.3 为
Apache-2.0，其余直接依赖为 MIT，传递依赖以清单文件为准。

### 仅跑 E2E 需要额外安装 Chromium

```bash
npx playwright install chromium
```

若本机已装过 Playwright Chromium（`~/.cache/ms-playwright/chromium-1248`），该命令会
复核并跳过重复下载。`npx playwright install chromium` 只影响 E2E；
`npm run dev` / `npm run build` / `npm run preview` / `npm test` / `npm run bench`
都不需要浏览器。

## 3. 常用命令（与 `package.json` 的 scripts 逐字一致）

| 命令 | 实际脚本 | 说明 |
|---|---|---|
| `npm run dev` | `vite` | 开发服务器，监听 `http://127.0.0.1:5173`（host 127.0.0.1、port 5173、strictPort：端口被占会直接失败而不是换端口） |
| `npm run build` | `tsc --noEmit && vite build` | 先类型检查再产物构建，输出到 `dist/` |
| `npm run preview` | `vite preview` | 本地预览 `dist/` 产物（默认端口 4173，见下文验收记录） |
| `npm test` | `vitest run` | 跑 `tests/` 下 11 个单元测试文件（已配置排除 `tests/e2e/**`，不会误捡 Playwright 用例） |
| `npm run test:e2e` | `playwright test` | 跑 `tests/e2e/` 的 10 个端到端用例；Playwright 配置会自动以 `npm run dev` 拉起 5173 开发服务器 |
| `npm run bench` | `tsx scripts/bench.ts` | CPU 基准（协议固定：128x128、xorshift32 seed 42、3 次热身 + 20 次计时，median 预算 250 ms，超预算退出码 1） |
| `npm run typecheck` | `tsc --noEmit` | 仅类型检查 |
| `npm run test:watch` | `vitest` | 单元测试观察模式 |

两个与 `npm run bench` 有关的注意点（读自 `scripts/bench.ts`，未改脚本）：

1. 基准证据默认写到**仓库外**的项目树目录 `…/P0001-topotide/05_tests/benchmark/bench-<commit前8位>.{json,log}`
   （脚本用 `import.meta.url` 解析 `../../../05_tests/benchmark/`，会自动建目录）。
   如果你只复制了本仓库（旁边没有项目树），请用环境变量改输出位置：
   ```bash
   BENCH_OUT_DIR=/tmp/bench-output npm run bench
   ```
2. 证据文件名里的 commit 来自 `git rev-parse HEAD`；副本不含 `.git` 时脚本会写
   `commit: unknown`，不影响基准本身。

## 4. 离线运行与数据隐私

- **运行期完全离线**：`src/` 内没有任何 `fetch` / `axios` / WebSocket / 埋点 / 外部 URL
  调用；地貌、分析与导出全部在本地计算。构建产物 `dist/` 是静态文件，断网也能用
  `npm run preview` 打开。
- **只有两步需要联网**：首次 `npm ci`（下载依赖）和首次 `npx playwright install chromium`
  （仅 E2E 需要）。之后日常运行不再需要网络。
- **数据不出本机**：没有账号、没有上传、没有遥测；你导入的地形 JSON 只进内存，
  导出文件由浏览器直接下载。

## 5. 样本输入与期望输出（金标准）

内置确定性样例（下拉选择，均为 **64x64**）：`twin-peaks`（双峰）、`ridge-gate`（山脊门）、
`plateau`（台地）；应用启动时加载 `twin-peaks`。

你也可以用工具栏「导入地形 JSON 文件」导入下面的最小样本来核对算法输出
（JSON 格式：`schemaVersion` 固定 1，`elevations` 行主序，高度 0..255，标题 1..80 码点）。

### S-STRIP：5x1，高程 [5,1,4,1,3]

```json
{"schemaVersion":1,"width":5,"height":1,"elevations":[5,1,4,1,3],"title":"S-STRIP"}
```

期望分析结果（与 `tests/persistence.smoke.spec.ts`、`tests/persistence.spec.ts` 的断言一致）：

- essential（本质）条码 1 条：峰格 0，出生 5，永不消亡；
- 有限条码 2 条：
  - 峰格 2，出生 4 → 死亡 1（persistence 3，witness 格 1）；
  - 峰格 4，出生 3 → 死亡 1（persistence 2，witness 格 3）；
- 合并事件 2 次：等级 1 时峰 2 并入峰 0（witness 1）、峰 4 并入峰 0（witness 3）；
- 连通数曲线 β0(level)（level=5..0）：`(1, 2, 3, 3, 1, 1)`。

### S-PLATEAU：3x3，高程 [4,4,1,4,1,1,1,1,4]

```json
{"schemaVersion":1,"width":3,"height":3,"elevations":[4,4,1,4,1,1,1,1,4],"title":"S-PLATEAU"}
```

期望分析结果（平顶回归检查——同高度整批处理，不产生伪事件）：

- essential 1 条：峰格 0，出生 4；
- 有限条码 1 条：峰格 8，出生 4 → 死亡 1（persistence 3，witness 格 5）；
- 合并事件 1 次：等级 1 时峰 8 并入峰 0（witness 5，z(witness)=1）；
- β0(4)=2、β0(1)=1；**没有任何 birth=death 的零寿命假条码**。

## 6. 基本用户操作

- **画笔**（「雕塑工具」面板）：模式三选一——抬高 / 降低 / 设定；半径仅 1 / 2 / 4 格，
  力度仅 1 / 4 / 16（「设定」模式下忽略力度，改填目标高度 0..255）。笔刷作用域是
  曼哈顿菱形（|dx|+|dy| ≤ r），出界格自动裁剪，每次更新都钳制到 0..255。
- **水位**：滑块 0..255（另有数字输入），淹没低地并实时更新画布高亮、β0 与陆地格数。
- **持久阈值 τ**：「寿命条码」面板滑块 0..255，仅过滤有限条码的可见性
  （persistence ≥ τ 才显示），永不改变 β0。
- **撤销 / 重做**：30 步历史；按钮与快捷键均可。
- **文件**：导入地形 JSON、导出当前地形 JSON、导出条码 CSV、导出画布 PNG。
  导入失败（尺寸超限 / JSON 非法 / 字段非法）会给出明确错误，且**不覆盖当前地貌**。
- **基线对照**：「基线对照」选项卡内「冻结为基线」把当前地貌与分析结果深拷贝存为基线，
  之后继续编辑时对照"当前 vs 基线"；「清除基线」撤销冻结。只有这两个按钮能改基线。
- **键盘**（焦点不在输入框时）：`Escape` 清除条码选择；`Ctrl/Cmd+Z` 撤销；
  `Ctrl/Cmd+Shift+Z` 或 `Ctrl/Cmd+Y` 重做。
- **重置**：恒定回到**应用启动时的双峰样例**（与下拉当前所选样例无关——这是字面语义，
  工具栏帮助行已明示）。

## 7. 简化物理边界（必读）

这是一个**地貌拓扑教学实验台，不是真实水文模拟**：

- 四邻接（对角线不相通）；分析对象是超水平集 `{elevation >= level}`；
- 同高度整批处理（plateau 不产生伪事件）；消亡归属用 elder rule（出生更高者胜，
  同出生则峰格 id 更小者胜）；
- 每次分析恰有一条 essential 条码；β0 另有独立 BFS 连通数交叉验证。
- 不含真实降雨、径流、侵蚀、潮汐物理；不要把输出当作工程水文依据。

## 8. 测试与性能基线

以下两组数字均来自真实运行，来源分别标注，未做任何修饰：

**(a) 仓库历史门禁证据**（T013 / T014 / T013-FIX 及总控复核，证据在项目树
`05_tests/` 与 `06_reviews/`）：

- 单元测试 `npm test`：**11 个文件 740 个用例全部通过**（T013-FIX 修复 vitest 误捡
  e2e 文件的问题之后）；
- E2E `npm run test:e2e`：**10 passed / 0 skipped**（Chromium chromium-1248）；
- `npm run typecheck`：退出码 0；`npm run build`：退出码 0
  （T013-FIX 时产物 JS 262.27 kB / CSS 10.25 kB）；
- CPU 基准 `npm run bench`（commit 459b4073，128x128、seed 42、20 次）：
  median **8.295 ms**、p95 **19.337 ms**、max **19.538 ms**、min **5.515 ms**，
  预算 250 ms（证据 `05_tests/benchmark/bench-459b4073.json`）；T015 复核在同一协议下
  median 7.407 ms，同样在预算内——绝对数值随机器波动，预算判定才是门禁。

**(b) 本 README 的干净副本验收**（T016 执行，见 §10）：`npm ci` / `npm run build` /
`npm run preview` 均真实跑通并记录退出码与产物大小于 `acceptance.log`。

## 9. 已知遗留问题（如实列出）

1. **冻结面板缺 3 个 `data-testid`**（`persistence-panel`、`merge-event`、`tau-slider`）。
   E2E 目前用可访问性选择器驱动：`section[aria-label="寿命条码"]`、`[data-event-id]`、
   `input[aria-label="持久阈值 tau，0 到 255"]`；用例没有跳过，功能不受影响。
2. **`scripts/bench.ts` 的 `@ts-expect-error` 属有意设计**：仓库未装 `@types/node` 且
   不允许改 `package.json` / `tsconfig.json`，因此对 Node 内置模块导入加了承重的
   `@ts-expect-error` + 最小结构接口；未来一旦安装 node 类型，这些指令会主动报错
   （提示未使用）而不是静默失效。
3. **β0 对照曲线各按自身最大值归一化**（图表 aria-label 与轴注已明示），表内数值才是
   原始精确值；不要把两条曲线的**高度**当作绝对值对比。
4. **重置的字面语义**：`reset()` 恒回创建时地貌（`replaceTerrain` 不更新 initial），
   工具栏帮助行「重置只回到启动时的双峰样例，与所选样例无关」已明示。

## 10. 复现与证据路径

逐步复现记录（含每条命令、退出码、产物大小）的格式与本次执行结果，见项目树
`08_release/HOW_TO_REPRODUCE.md`。用户视角完整操作说明见 `08_release/USER_GUIDE.md`，
本版本变化与实测数字见 `08_release/RELEASE_NOTES.md`，来源索引见
`09_references/SOURCES.md`（这些配套文档随项目树发布；若你的源码包内没有，
不影响本 README 自身的完整性——上面各节已含复现所需的全部关键信息）。

项目树内的既有证据（在仓库外层目录）：

| 证据 | 路径 |
|---|---|
| 真实截图（5 张，Chromium 实拍） | `07_evidence/screenshots/01-overview.png` … `05-import-error.png` |
| E2E 运行日志 | `05_tests/test-results/e2e.log` |
| CPU 基准证据 | `05_tests/benchmark/bench-459b4073.json` 与 `bench-459b4073.log` |
| 主线审查报告（T015） | `06_reviews/TASK_REVIEWS/P0001-T015.md` |
| 数学独立复算 | `06_reviews/MATH_AUDIT.md` |

## 11. 许可

本项目代码为本工厂私有产物（`"private": true`，未发布到 npm）。
第三方依赖许可：直接运行依赖 react / react-dom 19.3.1（MIT）；开发依赖中 playwright 1.64.1、
typescript 5.9.3（Apache-2.0），其余直接依赖（MIT）；传递依赖含 MIT 为主，另有
lightningcss 系（MPL-2.0）、picocolors（ISC）、source-map-js（BSD-3-Clause）。
完整逐包清单（98 个依赖包，包名+版本+许可证）见 `08_release/THIRD_PARTY_NOTICES.md`。
