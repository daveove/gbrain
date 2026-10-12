import type { Page } from '@playwright/test';
import { join } from 'node:path';
import { test, expect } from './fixtures';

// Recentring between large (150-node, 2-hop) neighbourhoods must always leave
// a drawn graph inside the canvas, including rapid successive recentres and a
// recentre while the previous layout is still easing in.
const SHOTS = process.env.GBRAIN_GRAPH_SCREENSHOT_DIR;

interface CanvasState { label: string; viewport: string; expected: number; nodes: number; visible: number; nan: boolean }

async function canvasState(page: Page): Promise<CanvasState | null> {
  return page.evaluate(() => {
    const svg = document.querySelector('.graph-canvas svg');
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    // Only nodes with a position are rendered; the status line says how many the response holds.
    const status = document.querySelector('.graph-status')?.textContent ?? '';
    const expected = Number(/^([\d,]+) of /.exec(status)?.[1]?.replace(/,/g, '') ?? -1);
    const nodes = [...svg.querySelectorAll('g.graph-node')];
    const visible = nodes.filter(n => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom;
    });
    return {
      label: svg.getAttribute('aria-label') ?? '',
      viewport: svg.querySelector(':scope > g')?.getAttribute('transform') ?? '',
      expected,
      nodes: nodes.length,
      visible: visible.length,
      nan: /NaN|Infinity/.test(svg.innerHTML),
    };
  });
}

/** The canvas shows every node of `title`'s neighbourhood, all inside the visible box. */
async function expectDrawn(page: Page, title: string): Promise<void> {
  await expect.poll(async () => {
    const s = await canvasState(page);
    return s !== null && s.label === `Neighbourhood of ${title}` && !s.nan && s.nodes > 1 && s.nodes === s.expected && s.visible === s.nodes;
  }, { timeout: 5000, message: `canvas for ${title}: ${JSON.stringify(await canvasState(page))}` }).toBe(true);
}

async function idOf(page: Page, url: string, q: string): Promise<number> {
  const hits = await (await page.request.get(`${url}/admin/api/graph/search?${new URLSearchParams({ q })}`)).json() as Array<{ id: number; title: string }>;
  const hit = hits.find(h => h.title === q);
  if (!hit) throw new Error(`fixture page ${q} not found`);
  return hit.id;
}

test('recentring between large neighbourhoods always leaves a drawn graph', async ({ page, graphBrain }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(await graphBrain.loginLink());
  const hub = await idOf(page, graphBrain.url, 'Team directory');
  const ada = await idOf(page, graphBrain.url, 'Ada Park');
  const chen = await idOf(page, graphBrain.url, 'Chen Wei');
  await page.goto(`${graphBrain.url}/admin/#graph?id=${hub}`);
  await expect(page.getByRole('status').first()).toContainText('150 of');
  await expectDrawn(page, 'Team directory');
  const figure = () => page.locator('.graph-canvas svg');
  const panel = page.getByRole('complementary', { name: 'Page details and filters' });

  // 1. Select a member node (hop 1 of the hub), then "Explore from here".
  const member = figure().getByRole('button', { name: /^Member \d+ —/ }).first();
  const memberTitle = (await member.getAttribute('aria-label'))!.split(' — ')[0];
  await member.locator('circle').last().click();
  await panel.getByRole('button', { name: 'Explore from here' }).click();
  const shots: Array<[number, CanvasState | null]> = [];
  let elapsed = 0;
  for (const ms of [0, 120, 400, 1500]) {
    await page.waitForTimeout(ms - elapsed);
    elapsed = ms;
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `recentre-button-${ms}ms.png`) });
    shots.push([ms, await canvasState(page)]);
  }
  console.log('explore-from-here sequence', shots);
  await expectDrawn(page, memberTitle);

  // 2. Double-click a node.
  await figure().getByRole('button', { name: /^Team directory —/ }).locator('circle').last().dblclick();
  await expectDrawn(page, 'Team directory');

  // 3. Rapid successive recentres: the last one wins and is drawn.
  await page.evaluate(([a, b, c]) => {
    window.location.hash = `graph?id=${a}`;
    setTimeout(() => { window.location.hash = `graph?id=${b}`; }, 40);
    setTimeout(() => { window.location.hash = `graph?id=${c}`; }, 80);
  }, [ada, hub, chen]);
  await expectDrawn(page, 'Chen Wei');

  // 4. Recentre while the previous layout is still easing in (220 ms).
  await page.evaluate(id => { window.location.hash = `graph?id=${id}`; }, hub);
  await expect(page.locator('.graph-canvas svg')).toHaveAttribute('aria-label', 'Neighbourhood of Team directory');
  await page.evaluate(id => { window.location.hash = `graph?id=${id}`; }, ada);
  await expectDrawn(page, 'Ada Park');
});

// The new neighbourhood must be drawn in the same commit that shows its
// status line, not only after the next animation frame: browsers pause or
// throttle requestAnimationFrame in background tabs and on low-power iPads,
// and the frame between commit and the first eased frame was captured as an
// empty canvas on a real brain. With frames stopped, the graph must still be
// on screen at its final layout.
test('a recentre draws the new graph without waiting for an animation frame', async ({ page, graphBrain }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(await graphBrain.loginLink());
  const hub = await idOf(page, graphBrain.url, 'Team directory');
  const ada = await idOf(page, graphBrain.url, 'Ada Park');
  await page.goto(`${graphBrain.url}/admin/#graph?id=${hub}`);
  await expectDrawn(page, 'Team directory');
  // Stop animation frames, and record the canvas in the very commit that
  // switches to the new neighbourhood (before any timer can run).
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
    const record = window as unknown as { firstCommit?: { nodes: number; expected: string } };
    new MutationObserver((_m, observer) => {
      const svg = document.querySelector('.graph-canvas svg');
      if (svg?.getAttribute('aria-label') !== 'Neighbourhood of Ada Park') return;
      record.firstCommit = {
        nodes: svg.querySelectorAll('g.graph-node').length,
        expected: /^([\d,]+) of /.exec(document.querySelector('.graph-status')?.textContent ?? '')?.[1] ?? '',
      };
      observer.disconnect();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await page.evaluate(id => { window.location.hash = `graph?id=${id}`; }, ada);
  await expect(page.locator('.graph-canvas svg')).toHaveAttribute('aria-label', 'Neighbourhood of Ada Park');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'recentre-no-animation-frame.png') });
  const first = await page.evaluate(() => (window as unknown as { firstCommit?: { nodes: number; expected: string } }).firstCommit);
  expect(first, 'the first commit of the new neighbourhood draws every node').toEqual({ nodes: Number(first?.expected), expected: first?.expected });
  await expectDrawn(page, 'Ada Park');
});
