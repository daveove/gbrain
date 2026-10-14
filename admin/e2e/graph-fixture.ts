/**
 * Synthetic link graph for the #graph browser test: fictional pages across
 * the source families the explorer colours (default entities, Tana, Heptabase,
 * Bear, Logseq, Notion, Apple Notes) with every styled link type, a few
 * isolated pages per source, and one soft-deleted page. No real note text.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

const SOURCES = ['tana-cache-fixture', 'heptabase-export-fixture', 'bear-export-fixture', 'logseq-notes-fixture', 'aria-notion-export-fixture', 'apple-notes-export-fixture'];

const PEOPLE = ['Ada Park', 'Bruno Silva', 'Chen Wei', 'Dara Okafor', 'Elif Kaya', 'Farah Nasser'];
const COMPANIES = ['Northwind Labs', 'Blue Harbor Co', 'Quill & Lamp'];
const TOPICS = ['Field research', 'Pricing experiments', 'Onboarding flow', 'Quarterly planning', 'Hiring loop', 'Customer interviews'];

export async function seedGraphFixture(engine: BrainEngine): Promise<void> {
  for (const id of SOURCES) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [id]);
  const ids = new Map<string, number>();
  const page = async (source: string, slug: string, title: string, type = 'note', body = '', deleted = false) => {
    const rows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, deleted_at) VALUES ($1, $2, $3, $4, $5, ${deleted ? 'now()' : 'NULL'}) RETURNING id`,
      [source, slug, type, title, body || `${title}. Synthetic fixture page for the graph explorer.`]);
    ids.set(`${source}:${slug}`, rows[0].id);
  };
  const link = async (from: string, to: string, type: string, provenance = 'fixture') => {
    await engine.executeRaw('INSERT INTO links (from_page_id, to_page_id, link_type, link_source) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [ids.get(from), ids.get(to), type, provenance]);
  };
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // default: entity pages.
  for (const p of PEOPLE) await page('default', `people/${slugify(p)}`, p, 'person');
  for (const c of COMPANIES) await page('default', `companies/${slugify(c)}`, c, 'company');
  for (const [i, p] of PEOPLE.entries()) await link(`default:people/${slugify(p)}`, `default:companies/${slugify(COMPANIES[i % COMPANIES.length])}`, 'works_at', 'frontmatter');

  // Tana: a project tree with supertags and fields. Bodies use the Tana import
  // shape (a JSON node document), as real Tana pages do.
  const T = 'tana-cache-fixture';
  const tanaNode = (id: string, props: Record<string, unknown>) => JSON.stringify({ children: [`${id}-c1`, `${id}-c2`], id, props: { created: 1700000000000, ...props } });
  await page(T, 'project-atlas', 'Project Atlas', 'note', tanaNode('atlas', {
    name: 'Project Atlas',
    description: 'A synthetic project tree: milestones, tasks and <b>meeting notes</b>, owned by <span data-inlineref-node="ada">Ada Park</span>.',
  }));
  await page(T, 'tag-task', '#task', 'tag');
  await page(T, 'tag-meeting', '#meeting', 'tag');
  for (let m = 1; m <= 4; m++) {
    await page(T, `milestone-${m}`, `Milestone ${m}`, 'note', tanaNode(`m${m}`, {}));
    await link(`${T}:project-atlas`, `${T}:milestone-${m}`, 'contains', 'tana-children');
    for (let t = 1; t <= 5; t++) {
      const slug = `task-${m}-${t}`;
      await page(T, slug, `${TOPICS[(m + t) % TOPICS.length]} — task ${m}.${t}`);
      await link(`${T}:milestone-${m}`, `${T}:${slug}`, 'contains', 'tana-children');
      await link(`${T}:${slug}`, `${T}:tag-task`, 'tagged', 'tana-supertag');
      await link(`${T}:${slug}`, `default:people/${slugify(PEOPLE[(m * t) % PEOPLE.length])}`, 'field', 'tana-field');
    }
    await page(T, `meeting-${m}`, `Atlas sync ${m}`);
    await link(`${T}:project-atlas`, `${T}:meeting-${m}`, 'contains', 'tana-children');
    await link(`${T}:meeting-${m}`, `${T}:tag-meeting`, 'tagged', 'tana-supertag');
    for (const p of PEOPLE.slice(m - 1, m + 2)) await link(`${T}:meeting-${m}`, `default:people/${slugify(p)}`, 'mentions', 'tana-inline-ref');
  }
  await page(T, 'project-atlas-copy', 'Project Atlas (copy)');
  await link(`${T}:project-atlas-copy`, `${T}:project-atlas`, 'duplicate', 'dedup');
  await page(T, 'archived-node', 'Archived node', 'note', '', true);
  await link(`${T}:project-atlas`, `${T}:archived-node`, 'contains', 'tana-children');

  // Heptabase: a whiteboard with cards and connections.
  const H = 'heptabase-export-fixture';
  await page(H, 'whiteboard/research-board', 'Research board', 'whiteboard');
  for (let c = 1; c <= 7; c++) {
    await page(H, `card/research-${c}`, `Research card ${c}: ${TOPICS[c % TOPICS.length]}`);
    await link(`${H}:card/research-${c}`, `${H}:whiteboard/research-board`, 'on_whiteboard', 'heptabase-whiteboard');
    if (c > 1) await link(`${H}:card/research-${c - 1}`, `${H}:card/research-${c}`, 'connected', 'heptabase-connection');
  }
  await link(`${H}:card/research-2`, `${T}:project-atlas`, 'mentions', 'cross-source');
  await link(`${H}:card/research-5`, `default:companies/northwind-labs`, 'mentions', 'cross-source');

  // Bear + Logseq: wikilinked notes and journals.
  const B = 'bear-export-fixture';
  for (const [i, t] of ['Reading list', 'Coaching notes', 'Trip planning', 'Weekly review'].entries()) {
    await page(B, slugify(t), t);
    if (i > 0) await link(`${B}:${slugify(t)}`, `${B}:reading-list`, 'wikilink', 'wikilink-resolved');
  }
  await link(`${B}:coaching-notes`, `default:people/dara-okafor`, 'mentions', 'mentions');
  await link(`${B}:weekly-review`, `${T}:project-atlas`, 'mentions', 'cross-source');
  const L = 'logseq-notes-fixture';
  for (let d = 1; d <= 6; d++) {
    await page(L, `journals/2022-08-0${d}`, `Aug ${d}, 2022`, 'journal');
    await link(`${L}:journals/2022-08-0${d}`, `default:people/${slugify(PEOPLE[d % PEOPLE.length])}`, 'wikilink', 'wikilink-resolved');
  }
  await page(L, 'pages/favorite', 'favorite', 'tag');
  for (let d = 1; d <= 6; d += 2) await link(`${L}:journals/2022-08-0${d}`, `${L}:pages/favorite`, 'tagged', 'logseq-tag');

  // Notion: a workspace tree.
  const N = 'aria-notion-export-fixture';
  await page(N, 'workspace', 'Team workspace');
  for (const t of TOPICS.slice(0, 4)) {
    await page(N, slugify(t), t);
    await link(`${N}:workspace`, `${N}:${slugify(t)}`, 'contains', 'notion-parent');
  }
  await link(`${N}:pricing-experiments`, `default:companies/blue-harbor-co`, 'mentions', 'mentions');

  // A hub whose 2-hop neighbourhood exceeds the 150-node default cap: 180
  // member pages mention it, and each mentions one person, so recentring
  // between large neighbourhoods is exercised.
  await page(N, 'team-directory', 'Team directory');
  for (let i = 1; i <= 180; i++) {
    await page(N, `members/member-${i}`, `Member ${i}`);
    await link(`${N}:members/member-${i}`, `${N}:team-directory`, 'mentions', 'mentions');
    await link(`${N}:members/member-${i}`, `default:people/${slugify(PEOPLE[i % PEOPLE.length])}`, 'mentions', 'mentions');
  }

  // Hub-filter probe: total stored-row degree includes multiple provenances.
  // A hub is adjacent to the probe before its ordinary low-degree neighbour.
  await page(N, 'hub-filter-probe', 'Hub filter probe');
  await page(N, 'noisy-company', 'Noisy company', 'company');
  await page(N, 'noise-anchor', 'Noise anchor');
  await page(N, 'quiet-note', 'Quiet note');
  await link(`${N}:hub-filter-probe`, `${N}:noisy-company`, 'mentions');
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
    SELECT $1, $2, 'mentions', 'noise-' || n FROM generate_series(1, 500) n`,
    [ids.get(`${N}:noisy-company`), ids.get(`${N}:noise-anchor`)]);
  await link(`${N}:hub-filter-probe`, `${N}:quiet-note`, 'contains');

  // Isolated pages, so the source map shows a realistic isolated share.
  for (const source of [...SOURCES, 'default']) {
    for (let i = 1; i <= 6; i++) await page(source, `loose/${i}`, `Loose note ${i}`);
  }
  await engine.executeRaw(`INSERT INTO sources (id, name, archived) VALUES ('archived-fixture', 'Archived fixture', true) ON CONFLICT DO NOTHING`);
  await page('archived-fixture', 'retained-note', 'Retained archived note');
}
