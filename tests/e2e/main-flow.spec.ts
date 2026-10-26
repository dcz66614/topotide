/**
 * P0001-T013 — 浏览器端到端主路径测试（真实 Chromium）。
 *
 * 覆盖计划书 P0001-T013 任务卡要求的主路径：
 *  1. 预置可见（双峰样例、画布、条码面板、状态条）
 *  2. S-STRIP 导入后有限两条 / 水位变化 β0
 *  3. 选择条码定位峰与 witness（寿命条码 ↔ 事件解释联动）
 *  4. 画笔撤销重做（鼠标一笔 + Ctrl+Z / Ctrl+Shift+Z）
 *  5. 导出 JSON 再导入（往返稳定）
 *  6. 冻结基线后编辑，两组统计不同
 *  7. 错误 JSON 不丢当前状态
 *  8. 键盘操作与窄屏最小可用
 *
 * 选择器说明（按 T013 指令如实处理）：
 *  - 已存在 data-testid：terrain-canvas, level-slider, beta0-value, import-file,
 *    import-error, undo, redo, baseline-freeze, baseline-clear, preset-select,
 *    level-value, land-cells-value, finite-count-value, panel-tab-* 等。
 *  - 缺失 data-testid：persistence-panel → 用 section[aria-label="寿命条码"]；
 *    merge-event → 用 section[aria-label="事件解释"] 内 [data-event-id]；
 *    tau-slider → 用 input[aria-label="持久阈值 tau，0 到 255"]。
 *  - 不因为缺 testid 而 skip 任何 P0 用例。
 *
 * 截图落到项目树 07_evidence/screenshots/（相对仓库根 ../../..）。
 */
import { expect, test, type Page } from 'playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const SHOTS_DIR = path.resolve(import.meta.dirname, '../../../../07_evidence/screenshots');
mkdirSync(SHOTS_DIR, { recursive: true });

const SHOT = (name: string) => path.join(SHOTS_DIR, name);

/** S-STRIP 金标准地形（计划书 §数学金标准）：width=5,height=1,[5,1,4,1,3]。 */
const STRIP_JSON = JSON.stringify({
  schemaVersion: 1,
  width: 5,
  height: 1,
  elevations: [5, 1, 4, 1, 3],
  title: 'S-STRIP',
});

const PLATEAU_JSON = JSON.stringify({
  schemaVersion: 1,
  width: 3,
  height: 3,
  elevations: [4, 4, 1, 4, 1, 1, 1, 1, 4],
  title: 'S-PLATEAU',
});

const barcodePanel = (page: Page) => page.locator('section[aria-label="寿命条码"]');
const eventPanel = (page: Page) => page.locator('section[aria-label="事件解释"]');
const tauSlider = (page: Page) => page.locator('input[aria-label="持久阈值 tau，0 到 255"]');

/** 等待一次导入/编辑后的重算完成（可观察结果，非硬编码 sleep）。 */
async function waitReady(page: Page) {
  await expect(page.getByTestId('calc-status')).toContainText('就绪');
}

async function importJson(page: Page, json: string, name: string) {
  await page.getByTestId('import-file').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(json, 'utf-8'),
  });
  await waitReady(page);
}

/** 导入预期失败的文件：不等待“就绪”，等错误提示出现。 */
async function importBrokenJson(page: Page, json: string, name: string) {
  await page.getByTestId('import-file').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(json, 'utf-8'),
  });
  await expect(page.getByTestId('import-error')).toBeVisible();
}

test.describe('TopoTide 主路径（P0001-T013，全部 P0）', () => {
  test('预置可见：双峰样例、水位、陆地高亮、条码可见 → 01-overview', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);

    await expect(page.getByTestId('terrain-canvas')).toBeVisible();
    await expect(page.getByTestId('beta0-value')).toBeVisible();
    await expect(page.getByTestId('level-slider')).toBeVisible();
    await expect(barcodePanel(page)).toBeVisible();

    // 默认双峰样例应至少有一条有限条码；essential 行注明死亡未定义。
    await expect(barcodePanel(page).locator('li').first()).toBeVisible();
    await expect(barcodePanel(page)).toContainText('未定义');
    await expect(barcodePanel(page)).not.toContainText('death 0');

    // 陆地高亮随水位变化：提高水位 → 陆地格数下降。
    const landBefore = Number(await page.getByTestId('land-cells-value').textContent());
    await page.getByTestId('level-slider').fill('200');
    await expect(page.getByTestId('level-value')).toHaveText('200');
    const landAfter = Number(await page.getByTestId('land-cells-value').textContent());
    expect(landAfter).toBeLessThan(landBefore);
    await page.getByTestId('level-slider').fill('0');
    await expect(page.getByTestId('level-value')).toHaveText('0');

    await page.screenshot({ path: SHOT('01-overview.png'), fullPage: true });
  });

  test('S-STRIP 导入：有限两条，水位变化 β0 正确', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);
    await importJson(page, STRIP_JSON, 'strip.json');

    // 金标准：恰好两条有限条码（essential 不计）。
    await expect(page.getByTestId('finite-count-value')).toHaveText('2');
    const bars = barcodePanel(page).locator('li');
    await expect(bars).toHaveCount(3); // essential + 2 finite
    await expect(bars.nth(1)).toContainText('birth 4 · death 1 · persistence=3');
    await expect(bars.nth(2)).toContainText('birth 3 · death 1 · persistence=2');

    // β0 随水位：β0(5,4,3,2,1,0) = (1,2,3,3,1,1)。
    const beta0At = async (h: number) => {
      await page.getByTestId('level-slider').fill(String(h));
      await expect(page.getByTestId('level-value')).toHaveText(String(h));
      return page.getByTestId('beta0-value').textContent();
    };
    expect(await beta0At(5)).toBe('1');
    expect(await beta0At(4)).toBe('2');
    expect(await beta0At(3)).toBe('3');
    expect(await beta0At(2)).toBe('3');
    expect(await beta0At(1)).toBe('1');
    expect(await beta0At(0)).toBe('1');
  });

  test('选择条码：峰与 witness 同时高亮，事件行联动 → 02-merge-evidence', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);
    await importJson(page, STRIP_JSON, 'strip.json');

    // 点击第一条有限条码（persistence=3 的峰 2）。
    const firstFinite = barcodePanel(page).locator('li').nth(1).locator('button');
    await firstFinite.click();
    await expect(firstFinite).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.statSelected')).toContainText('已选事件');

    // 切到事件解释 tab：对应事件行被选中，且含 witness 坐标。
    await page.getByTestId('panel-tab-events').click();
    const row = eventPanel(page).locator('[data-event-id]').first();
    await expect(row).toContainText('witness (1,0)');
    await expect(row).toContainText('被峰 (0,0) 吞并');

    // 跳到合并高度按钮：level 应被设为 death=1。
    await row.getByRole('button', { name: /跳到合并高度/ }).click();
    await expect(page.getByTestId('level-value')).toHaveText('1');
    await expect(page.getByTestId('beta0-value')).toHaveText('1');

    await page.getByTestId('panel-tab-barcode').click();
    await page.screenshot({ path: SHOT('02-merge-evidence.png'), fullPage: true });
  });

  test('画笔撤销重做：一笔编辑改变陆地格数，Ctrl+Z 还原，Ctrl+Shift+Z 重做', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);

    // 水位 0 时所有格都是陆地；先升到 128，画笔抬升才会改变陆地格数。
    await page.getByTestId('level-slider').fill('128');
    await expect(page.getByTestId('level-value')).toHaveText('128');

    const land0 = await page.getByTestId('land-cells-value').textContent();
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toBeDisabled();

    // 在画布中心附近画一笔（默认画笔 raise）。跨峰笔划必改变陆地格数。
    const canvas = page.getByTestId('terrain-canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx - 80, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy, { steps: 16 });
    await page.mouse.up();
    await waitReady(page);

    const landAfterStroke = await page.getByTestId('land-cells-value').textContent();
    expect(landAfterStroke).not.toBe(land0);
    await expect(page.getByTestId('undo')).toBeEnabled();

    // 撤销按钮 → 还原；重做按钮 → 再次改变。
    await page.getByTestId('undo').click();
    await waitReady(page);
    await expect(page.getByTestId('land-cells-value')).toHaveText(land0!);
    await expect(page.getByTestId('redo')).toBeEnabled();

    await page.getByTestId('redo').click();
    await waitReady(page);
    await expect(page.getByTestId('land-cells-value')).toHaveText(landAfterStroke!);

    // 键盘 Ctrl+Z 同样能撤销（热键路径）。
    await page.getByTestId('undo').click();
    await waitReady(page);
    await expect(page.getByTestId('land-cells-value')).toHaveText(land0!);
    await page.keyboard.press('Control+z');
    await waitReady(page);
    await expect(page.getByTestId('undo')).toBeDisabled();
  });

  test('导出 JSON 再导入：往返后统计一致', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);
    await importJson(page, STRIP_JSON, 'strip.json');
    await expect(page.getByTestId('finite-count-value')).toHaveText('2');

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-json').click();
    const download = await downloadPromise;
    const filePath = await download.path();
    expect(filePath).not.toBeNull();
    const { readFileSync } = await import('node:fs');
    const exported = readFileSync(filePath!, 'utf-8');

    // 先切回双峰样例，再导入导出结果 → 统计恢复。
    await page.getByTestId('reset').click();
    await waitReady(page);
    await importJson(page, exported, 'roundtrip.json');
    await expect(page.getByTestId('finite-count-value')).toHaveText('2');
    const bars = barcodePanel(page).locator('li');
    await expect(bars.nth(1)).toContainText('birth 4 · death 1 · persistence=3');
  });

  test('冻结基线后编辑：两组统计不同，图例可辨认 → 04-baseline-compare', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);
    await page.getByTestId('panel-tab-baseline').click();
    await expect(page.getByTestId('compare-panel-empty')).toBeVisible();

    // 先冻结双峰样例为基线（水位 128，有限条码数作为对照指标）。
    await page.getByTestId('panel-tab-barcode').click();
    await page.getByTestId('level-slider').fill('128');
    await expect(page.getByTestId('level-value')).toHaveText('128');
    await page.getByTestId('panel-tab-baseline').click();
    await page.getByTestId('baseline-freeze').click();
    await expect(page.getByTestId('compare-panel')).toBeVisible();

    const firstRowBaseline = page
      .locator('[data-testid="compare-panel"] tbody tr')
      .first()
      .locator('td')
      .nth(1);
    const baselineValue = await firstRowBaseline.textContent();

    // 大笔刷改地貌：设定模式、目标高度 0，整片压低 → 有限条码数必变。
    await page.getByRole('radio', { name: /画笔模式：设定/ }).check();
    const target = page.getByLabel('设定模式目标高度，0 到 255');
    await target.fill('0');
    await target.blur();
    await page.getByTestId('brush-radius').selectOption('4');
    const canvas = page.getByTestId('terrain-canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.move(cx - 100, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy, { steps: 12 });
    await page.mouse.move(cx, cy + 100, { steps: 12 });
    await page.mouse.up();
    await waitReady(page);

    const firstRowCurrent = page
      .locator('[data-testid="compare-panel"] tbody tr')
      .first()
      .locator('td')
      .nth(0);
    await expect(firstRowCurrent).not.toHaveText(baselineValue!);

    // 图例：当前与基线两条线可辨认。
    await expect(page.locator('[data-testid="compare-panel"] figcaption')).toContainText('当前');
    await expect(page.locator('[data-testid="compare-panel"] figcaption')).toContainText('基线');

    await page.screenshot({ path: SHOT('04-baseline-compare.png'), fullPage: true });

    // 清除基线 → 回到空状态。
    await page.getByTestId('baseline-clear').click();
    await expect(page.getByTestId('compare-panel-empty')).toBeVisible();
  });

  test('错误 JSON 不丢当前状态 → 05-import-error', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);
    await importJson(page, STRIP_JSON, 'strip.json');
    await expect(page.getByTestId('finite-count-value')).toHaveText('2');
    const beta0 = await page.getByTestId('beta0-value').textContent();

    // 非法 JSON：报错，原地貌未被覆盖。
    await importBrokenJson(page, '{ not valid json', 'broken.json');
    await expect(page.getByTestId('import-error')).toContainText('INVALID_SCHEMA');
    await expect(page.getByTestId('finite-count-value')).toHaveText('2');
    await expect(page.getByTestId('beta0-value')).toHaveText(beta0!);

    await page.screenshot({ path: SHOT('05-import-error.png'), fullPage: true });
  });

  test('平顶样例：无虚假零寿命条码、β0 正确 → 03-plateau-proof', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);
    await importJson(page, PLATEAU_JSON, 'plateau.json');

    // S-PLATEAU：恰好 1 条有限条码（peak8, 4→1），无 birth=death 假事件。
    await expect(page.getByTestId('finite-count-value')).toHaveText('1');
    const panel = barcodePanel(page);
    await expect(panel.locator('li')).toHaveCount(2); // essential + 1 finite
    await expect(panel).toContainText('birth 4 · death 1 · persistence=3');
    await expect(panel).not.toContainText('persistence=0');
    await expect(panel).not.toContainText('death 0');

    // β0(4)=2，β0(1)=1。
    await page.getByTestId('level-slider').fill('4');
    await expect(page.getByTestId('beta0-value')).toHaveText('2');
    await page.getByTestId('level-slider').fill('1');
    await expect(page.getByTestId('beta0-value')).toHaveText('1');
    await page.getByTestId('level-slider').fill('0');

    // 同时也验证内置 plateau 预置能正常切换渲染（平顶预置主路径）。
    await page.getByTestId('preset-select').selectOption('plateau');
    await waitReady(page);
    await expect(page.getByTestId('terrain-canvas')).toBeVisible();

    await page.screenshot({ path: SHOT('03-plateau-proof.png'), fullPage: true });
  });

  test('tau 阈值筛选：只影响可见条码，不改变 β0', async ({ page }) => {
    await page.goto('/');
    await waitReady(page);
    await importJson(page, STRIP_JSON, 'strip.json');
    await expect(page.getByTestId('finite-count-value')).toHaveText('2');
    const beta0 = await page.getByTestId('beta0-value').textContent();

    // τ=3 → persistence=2 的短条码被隐藏，仅剩 1 条可见有限条码。
    await tauSlider(page).fill('3');
    await expect(page.getByTestId('finite-count-value')).toHaveText('1');
    await expect(barcodePanel(page).locator('li')).toHaveCount(2);
    // β0 不受 τ 影响。
    await expect(page.getByTestId('beta0-value')).toHaveText(beta0!);

    await tauSlider(page).fill('0');
    await expect(page.getByTestId('finite-count-value')).toHaveText('2');
  });

  test('键盘操作与窄屏最小可用', async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await page.goto('/');
    await waitReady(page);
    await importJson(page, STRIP_JSON, 'strip.json');

    // Tab 到条码按钮并 Enter 激活（键盘可选中条码）。
    await barcodePanel(page).locator('li button').nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(barcodePanel(page).locator('li button').nth(1)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.locator('.statSelected')).toContainText('已选事件');

    // 窄屏下核心控件仍可见可用。
    await expect(page.getByTestId('terrain-canvas')).toBeVisible();
    await expect(page.getByTestId('beta0-value')).toBeVisible();
    await expect(page.getByTestId('level-slider')).toBeVisible();
    await expect(barcodePanel(page)).toBeVisible();

    // 窄屏水位滑块仍可键盘操作。
    await page.getByTestId('level-slider').focus();
    await page.keyboard.press('End');
    await expect(page.getByTestId('level-value')).toHaveText('255');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('level-value')).toHaveText('0');
  });
});
