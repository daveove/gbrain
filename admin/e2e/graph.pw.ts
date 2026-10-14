import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { test, expect } from './fixtures';

// Set GBRAIN_GRAPH_SCREENSHOT_DIR to also capture the views (fixture brain only).
const SHOTS = process.env.GBRAIN_GRAPH_SCREENSHOT_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ipad', width: 834, height: 1194 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`graph explorer and source map work end to end (${viewport.name})`, async ({ page, graphBrain }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(await graphBrain.loginLink());
    await page.goto(`${graphBrain.url}/admin/#graph`);
    await expect(page.getByRole('heading', { name: 'Graph', exact: true })).toBeVisible();

    // Search -> explorer rooted at the hit.
    const search = page.getByRole('combobox', { name: 'Search pages by title or slug' });
    await search.fill('Project Atlas');
    await expect(page.getByRole('option').first()).toContainText('Project Atlas');
    await search.press('Enter');
    const figure = page.getByRole('group', { name: 'Neighbourhood of Project Atlas' });
    await expect(figure).toBeVisible();
    await expect(page).toHaveURL(/#graph\?id=\d+$/);
    await expect(page.getByRole('status').first()).toContainText('reachable pages');
    const nodes = figure.getByRole('button');
    expect(await nodes.count()).toBeGreaterThan(20);
    // `duplicate` is hidden by default; the soft-deleted child never appears.
    await expect(figure.getByRole('button', { name: /^Project Atlas \(copy\)/ })).toHaveCount(0);
    await expect(figure.getByRole('button', { name: /^Archived node/ })).toHaveCount(0);
    await page.getByRole('checkbox', { name: /duplicate/ }).check();
    await expect(figure.getByRole('button', { name: /^Project Atlas \(copy\)/ })).toHaveCount(1);
    await page.getByRole('checkbox', { name: /duplicate/ }).uncheck();
    await expect(figure.getByRole('button', { name: /^Project Atlas \(copy\)/ })).toHaveCount(0);

    // Selecting a node (its dot; labels are not hit targets) fills the side panel.
    await figure.getByRole('button', { name: /^Milestone 2 —/ }).locator('circle').last().click();
    const panel = page.getByRole('complementary', { name: 'Page details and filters' });
    await expect(panel.getByRole('heading', { name: 'Milestone 2' })).toBeVisible();
    await expect(panel.getByRole('cell', { name: 'contains' })).toBeVisible();
    // Its Tana JSON body has no name, so the excerpt names its children instead of showing JSON.
    await expect(panel.getByText(/^contains: Quarterly planning — task 2\.1, /)).toBeVisible();
    await expect(panel).not.toContainText('"children"');
    await shot(page, `explorer-${viewport.name}`);

    // Keyboard: Enter on a focused node recentres the explorer on it.
    await figure.getByRole('button', { name: /^Milestone 2 —/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('group', { name: 'Neighbourhood of Milestone 2' })).toBeVisible();

    // Source map: pick a source, jump to one of its most connected pages.
    await page.getByRole('tab', { name: 'Source map' }).click();
    const map = page.getByRole('group', { name: /Sources sized by page count/ });
    await expect(map).toBeVisible();
    await expect(page.getByRole('table')).toContainText('tana-cache-fixture');
    await page.getByRole('row', { name: /tana-cache-fixture/ }).getByRole('button').click();
    const sourcePanel = page.getByRole('complementary', { name: 'Source details' });
    await expect(sourcePanel.getByRole('heading', { name: 'Most connected pages' })).toBeVisible();
    await expect(sourcePanel.getByRole('link', { name: 'Project Atlas', exact: true })).toBeVisible();
    await shot(page, `source-map-${viewport.name}`);
    await sourcePanel.getByRole('link', { name: 'Project Atlas', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Neighbourhood of Project Atlas' })).toBeVisible();
  });
}

test('hide hubs presets filter on the server, keep the center, and can be turned off', async ({ page, graphBrain }) => {
  await page.goto(await graphBrain.loginLink());
  const hits = await (await page.request.get(`${graphBrain.url}/admin/api/graph/search?q=Hub%20filter%20probe`)).json() as Array<{ id: number }>;
  await page.goto(`${graphBrain.url}/admin/#graph?id=${hits[0].id}`);
  const select = page.getByRole('combobox', { name: 'Hide hubs' });
  const figure = page.getByRole('group', { name: 'Neighbourhood of Hub filter probe' });
  await expect(select).toHaveValue('');
  await expect(figure.getByRole('button')).toHaveCount(4);
  await expect(figure.getByRole('button', { name: /^Noisy company —/ })).toHaveCount(1);
  const filtered = page.waitForResponse(response => response.url().includes('/graph/neighbourhood?') && response.url().includes('max_degree=500'));
  await select.selectOption('500');
  const result = await (await filtered).json();
  expect(result.nodes.map((node: { slug: string }) => node.slug)).toEqual(['hub-filter-probe', 'quiet-note']);
  expect(result.candidates).toBe(1);
  expect(result.truncated).toBe(false);
  await expect(figure.getByRole('button')).toHaveCount(2);
  await expect(figure.getByRole('button', { name: /^Noisy company —/ })).toHaveCount(0);

  await select.selectOption('1000');
  await expect(figure.getByRole('button')).toHaveCount(4);
  await select.selectOption('2000');
  await expect(select).toHaveValue('2000');
  await select.selectOption('');
  await expect(figure.getByRole('button')).toHaveCount(4);

  await select.selectOption('500');
  await expect(figure.getByRole('button')).toHaveCount(2);
  const hubHits = await (await page.request.get(`${graphBrain.url}/admin/api/graph/search?q=Noisy%20company`)).json() as Array<{ id: number }>;
  await page.evaluate(id => { window.location.hash = `graph?id=${id}`; }, hubHits[0].id);
  const hubFigure = page.getByRole('group', { name: 'Neighbourhood of Noisy company' });
  await expect(select).toHaveValue('500');
  await expect(hubFigure.getByRole('button', { name: /^Noisy company —.*501 links, hop 0/ })).toHaveCount(1);
  await expect(hubFigure.getByRole('button')).toHaveCount(4);
});
