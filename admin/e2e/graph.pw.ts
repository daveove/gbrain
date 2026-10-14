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
    await expect(page.getByRole('row', { name: /archived-fixture/ })).toContainText('archived');
    await expect(map.getByRole('button', { name: /^Archived fixture \(archived\)/ })).toHaveCount(1);
    await page.getByRole('row', { name: /tana-cache-fixture/ }).getByRole('button').click();
    const sourcePanel = page.getByRole('complementary', { name: 'Source details' });
    await expect(sourcePanel.getByRole('heading', { name: 'Most connected pages' })).toBeVisible();
    await expect(sourcePanel.getByRole('link', { name: 'Project Atlas', exact: true })).toBeVisible();
    await shot(page, `source-map-${viewport.name}`);
    await sourcePanel.getByRole('link', { name: 'Project Atlas', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Neighbourhood of Project Atlas' })).toBeVisible();
  });
}

test('graph failures are visible and a failed recentre clears the old canvas', async ({ page, graphBrain }) => {
  await page.goto(await graphBrain.loginLink());
  await page.goto(`${graphBrain.url}/admin/#graph`);
  const search = page.getByRole('combobox', { name: 'Search pages by title or slug' });
  const unavailable = { status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'service_unavailable' }) };

  await page.route('**/admin/api/graph/search?**', route => route.fulfill(unavailable));
  await search.fill('Project Atlas');
  await expect(page.getByText('Search failed: service_unavailable')).toBeVisible();
  await page.unroute('**/admin/api/graph/search?**');
  await search.fill('Milestone');
  await expect(page.getByRole('option').first()).toBeVisible();
  await search.fill('Project Atlas');
  await expect(page.getByRole('option').first()).toContainText('Project Atlas');
  await search.press('Enter');
  await expect(page.getByRole('group', { name: 'Neighbourhood of Project Atlas' })).toBeVisible();

  await page.route('**/admin/api/graph/page?**', route => route.fulfill(unavailable));
  await page.getByRole('group', { name: 'Neighbourhood of Project Atlas' })
    .getByRole('button', { name: /^Milestone 2 —/ }).locator('circle').last().click();
  await expect(page.getByText('Page details could not be loaded: service_unavailable')).toBeVisible();
  await page.unroute('**/admin/api/graph/page?**');

  await page.route('**/admin/api/graph/neighbourhood?**', route => route.fulfill({
    ...unavailable, body: JSON.stringify({ error: 'graph_query_timeout', message: 'Fixture graph query timed out.' }),
  }));
  await page.getByRole('button', { name: '1 hop', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('Fixture graph query timed out.');
  await expect(page.locator('.graph-canvas')).toHaveCount(0);
  await page.unroute('**/admin/api/graph/neighbourhood?**');

  await page.route('**/admin/api/graph/sources', route => route.fulfill(unavailable));
  await page.getByRole('tab', { name: 'Source map' }).click();
  await expect(page.getByRole('alert')).toContainText('Source map unavailable: service_unavailable');
  await page.unroute('**/admin/api/graph/sources');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('group', { name: /Sources sized by page count/ })).toBeVisible();

  await page.route('**/admin/api/graph/sources/*/top', route => route.fulfill(unavailable));
  await page.getByRole('row', { name: /tana-cache-fixture/ }).getByRole('button').click();
  await expect(page.getByText("Could not load this source's pages: service_unavailable")).toBeVisible();
});
