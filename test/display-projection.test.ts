import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  projectPage,
  redactedPreview,
  referencedRecordIds,
  textFingerprint,
  type PageSnapshot,
  type Projection,
  type ReferenceSnapshot,
} from '../scripts/display-projection.ts';

type Expected = Pick<Projection, 'caption' | 'display_body' | 'status'>;

function page(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    id: 1,
    source_id: 'tana-example',
    slug: 'example-note',
    title: 'Example note',
    compiled_truth: 'Ordinary text.',
    record_id: null,
    ...overrides,
  };
}

function tana(id: string, props: Record<string, string>, children: string[] = []): ReferenceSnapshot {
  return {
    source_id: 'tana-example',
    record_id: id,
    compiled_truth: JSON.stringify({ id, props, children, metadata: 'Never display this.' }),
  };
}

function tanaPage(id: string, props: Record<string, string>, children: string[] = [], overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return { ...page({ title: '' }), ...tana(id, props, children), ...overrides };
}

function project(input: PageSnapshot, refs: ReferenceSnapshot[] = []): Projection {
  return projectPage(input, new Map(refs.map((ref) => [ref.record_id!, ref])));
}

function expectStable(input: PageSnapshot, expected: Expected, refs: ReferenceSnapshot[] = []): Projection {
  const first = project(input, refs);
  expect({ caption: first.caption, display_body: first.display_body, status: first.status }).toEqual(expected);
  const second = project({ ...input, title: first.caption, compiled_truth: first.display_body }, refs);
  expect({ caption: second.caption, display_body: second.display_body }).toEqual({
    caption: expected.caption,
    display_body: expected.display_body,
  });
  return first;
}

function encode(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const OSLO_DATE = '<span data-inlineref-date="{&quot;dateTimeString&quot;:&quot;2025-01-15&quot;,&quot;timezone&quot;:&quot;Europe/Oslo&quot;}"></span>';

describe('ordinary text projection', () => {
  test('preserves an ordinary clean page including whitespace, Markdown, URLs and comparisons', () => {
    const body = '  First line.  \n\n\n## A heading\n- A list item\n\tLast line.\t\n1 < 2; see https://example.com/path?q=a&b=c\n';
    expectStable(page({ compiled_truth: body }), { caption: 'Example note', display_body: body, status: 'complete' });
  });

  test('captions a heading with the next distinct nonheading title line', () => {
    expectStable(page({ title: '\n \n## ### Example heading\nAdditional title line' }), {
      caption: 'Example heading · Additional title line', display_body: 'Ordinary text.', status: 'complete',
    });
    expectStable(page({ title: 'Notes\nnotes\n## Kickoff\nAgenda' }), {
      caption: 'Kickoff · Agenda', display_body: 'Ordinary text.', status: 'complete',
    });
  });

  test('skips empty Markdown headings without turning a caption into a new heading', () => {
    expectStable(tanaPage('root-example', { name: '#\nUseful context\nDetails' }, [], {
      title: '#\nUseful context\nDetails',
    }), {
      caption: 'Useful context · Details [p1]', display_body: '#\nUseful context\nDetails', status: 'complete',
    });
  });

  test('removes HTML and maps paragraphs, lists and breaks to plain text', () => {
    expectStable(page({
      title: '<b>Example heading</b>\\nSecond line',
      compiled_truth: '<head>Hidden</head><p>First <strong>paragraph</strong>.</p><ul><li>One</li><li>Two<br>continued</li></ul><script>Hidden</script>',
    }), { caption: 'Example heading · Second line', display_body: 'First paragraph.\n- One\n- Two\ncontinued', status: 'complete' });
  });

  test('preserves escaped comparison text inside actual HTML without treating it as a tag', () => {
    expectStable(page({ compiled_truth: '<p>1 &lt; 2; 3 &gt; 2</p>' }), {
      caption: 'Example note', display_body: '1 < 2; 3 > 2', status: 'complete',
    });
  });

  test('strips quote-aware attributes before decoding their embedded delimiters', () => {
    for (const markup of [
      '<span title="A > B">Visible</span>',
      '<span title="A &quot;&gt;&quot; B">Visible</span>',
      "<span title='A > B'>Visible</span>",
    ]) {
      expectStable(page({ compiled_truth: markup }), {
        caption: 'Example note', display_body: 'Visible', status: 'complete',
      });
    }
  });

  test('decodes nested encoded HTML and entities fully before returning', () => {
    expectStable(page({
      title: '&amp;lt;b&amp;gt;Example &amp;amp; title&amp;lt;/b&amp;gt;',
      compiled_truth: '&amp;lt;p&amp;gt;A &amp;amp; B&amp;lt;/p&amp;gt;&lt;p&gt;&quot;Next&quot; &apos;line&apos; &#x1F642; &#233;&lt;/p&gt;',
    }), { caption: 'Example & title', display_body: 'A & B\n"Next" \'line\' 🙂 é', status: 'complete' });
  });

  test('preserves whitespace around entities when there is no HTML', () => {
    expectStable(page({ compiled_truth: '  A&nbsp;B &amp; C  \n\n\n' }), {
      caption: 'Example note', display_body: '  A B & C  \n\n\n', status: 'complete',
    });
  });

  test('converts escaped newline runs and newlines revealed by entity decoding', () => {
    expectStable(page({
      title: '\\n# Example\\r\\nIgnored',
      compiled_truth: 'One\\nTwo\\r\\nThree\\\\nFour&#92;nFive',
    }), { caption: 'Example · Ignored', display_body: 'One\nTwo\nThree\nFour\nFive', status: 'complete' });
  });

  test('leaves unsupported entities and non-HTML angle notation unchanged', () => {
    expectStable(page({ compiled_truth: 'A &unknown; B <record-example> C.' }), {
      caption: 'Example note', display_body: 'A &unknown; B <record-example> C.', status: 'complete',
    });
    expectStable(page({ compiled_truth: 'Keep C:\\reports\\archive unchanged.' }), {
      caption: 'Example note', display_body: 'Keep C:\\reports\\archive unchanged.', status: 'complete',
    });
  });

  test('converges even when entity encoding is deeply nested', () => {
    expectStable(page({ compiled_truth: `&${'amp;'.repeat(80)}lt;p&${'amp;'.repeat(80)}gt;Nested&lt;/p&gt;` }), {
      caption: 'Example note', display_body: 'Nested', status: 'complete',
    });
  });

  test('falls back to body heading context and then the first body lines when the title is empty', () => {
    expectStable(page({ title: ' \n', compiled_truth: 'Opening text.\n## Body heading\nOther text.' }), {
      caption: 'Body heading · Other text.', display_body: 'Opening text.\n## Body heading\nOther text.', status: 'complete',
    });
    expectStable(page({ title: '', compiled_truth: '\n  First body line.  \nSecond line.' }), {
      caption: 'First body line. · Second line.', display_body: '\n  First body line.  \nSecond line.', status: 'complete',
    });
  });

  test('limits ordinary captions by Unicode code points without a second-pass trim', () => {
    expectStable(page({ title: `${'🙂'.repeat(120)}tail` }), { caption: '🙂'.repeat(120), display_body: 'Ordinary text.', status: 'complete' });
    expectStable(page({ title: `${'a'.repeat(119)} trailing` }), { caption: 'a'.repeat(119), display_body: 'Ordinary text.', status: 'complete' });
  });

  test('holds empty outputs and markup whose meaning exists only in attributes', () => {
    expect(project(page({ compiled_truth: ' \n\t' })).status).toBe('held');
    for (const body of [
      '<p>Before</p><img src="https://example.com/private.png">',
      '<p>Before</p><a href="https://example.com/private"></a>',
      '<p>Before</p><span data-private="value"></span>',
    ]) {
      const result = project(page({ compiled_truth: body }));
      expect({ display_body: result.display_body, status: result.status }).toEqual({ display_body: 'Before', status: 'held' });
    }
    expectStable(page({ compiled_truth: '<p id="x">Before</p><span data-color="red">Visible</span>' }), {
      caption: 'Example note', display_body: 'Before\nVisible', status: 'complete',
    });
  });
});

describe('Tana outline projection', () => {
  test('renders JSON names and ordered record-ID children without metadata', () => {
    const root = tanaPage('root-example', { name: '<b>Root</b>' }, ['child-b', 'child-a']);
    expectStable(root, {
      caption: 'Root · Second [p1]',
      display_body: 'Root\n- Second\n  continued\n  - Nested\n- First',
      status: 'complete',
    }, [
      tana('child-a', { name: 'First' }),
      tana('child-b', { name: 'Second\\ncontinued' }, ['grandchild']),
      tana('grandchild', { name: 'Nested' }),
    ]);
  });

  test('loads sparse child references from supported nested JSON roots', () => {
    const nested = JSON.stringify({ id: 'inner', props: { name: 'Inner' }, children: ['child'] });
    const input = tanaPage('outer', { name: nested }, [], { title: 'T' });
    const child = tana('child', { name: 'Child', _ownerId: 'inner' });
    const discovered = referencedRecordIds(input);
    expectStable(input, { caption: 'T [p1]', display_body: 'Inner\n- Child', status: 'complete' },
      [child].filter((ref) => discovered.includes(ref.record_id!)));
  });

  test('accepts optional child arrays on Tana leaf nodes', () => {
    const leaf = { source_id: 'tana-example', record_id: 'leaf', compiled_truth: '{"id":"leaf","props":{"name":"Leaf"}}' };
    expectStable(tanaPage('root-example', { name: 'Root' }, ['leaf'], { title: 'Example note' }), {
      caption: 'Example note [p1]', display_body: 'Root\n- Leaf', status: 'complete',
    }, [leaf]);
  });

  test('keeps unnamed nodes transparent and holds pages with no displayable text', () => {
    expectStable(tanaPage('root-example', {}, ['empty', 'branch'], { title: 'Example note' }), {
      caption: 'Example note [p1]', display_body: '- Leaf', status: 'complete',
    }, [tana('empty', {}), tana('branch', { name: '' }, ['leaf']), tana('leaf', { name: 'Leaf' })]);
    expectStable(tanaPage('empty', {}), { caption: '[p1]', display_body: '', status: 'held' });
    expectStable(tanaPage('whitespace', { name: ' \n\t' }), { caption: '[p1]', display_body: '', status: 'held' });
  });

  test('projects a plain-text child without guessing from other fields', () => {
    expectStable(tanaPage('root-example', { name: 'Root' }, ['plain', 'empty', 'blank'], { title: 'Example note' }), {
      caption: 'Example note [p1]', display_body: 'Root\n- Plain child.\n  Second line.', status: 'complete',
    }, [
      { source_id: 'tana-example', record_id: 'plain', compiled_truth: 'Plain child.\nSecond line.' },
      { source_id: 'tana-example', record_id: 'empty', compiled_truth: '' },
      { source_id: 'tana-example', record_id: 'blank', compiled_truth: ' \n\t' },
    ]);
  });

  test('preserves repeated acyclic references in their original order', () => {
    expect(project(tanaPage('root-example', { name: 'Root' }, ['shared', 'shared']), [tana('shared', { name: 'Shared' })]).display_body)
      .toBe('Root\n- Shared\n- Shared');
  });

  test('holds missing references and cycles visibly without exposing record IDs', () => {
    const root = tanaPage('root-example', { name: 'Root' }, ['branch', 'missing-a', 'missing-b']);
    const result = expectStable(root, {
      caption: 'Root · Branch [p1]',
      display_body: 'Root\n- Branch\n  - [held reference]\n- [held reference]\n- [held reference]',
      status: 'held',
    }, [root, tana('branch', { name: 'Branch' }, ['root-example'])]);
    expect(result.warnings).toEqual(['cycle:1', 'missing_reference:2']);
    for (const id of ['missing-a', 'missing-b', 'root-example']) expect(JSON.stringify(result)).not.toContain(id);
    const second = project({ ...root, title: result.caption, compiled_truth: result.display_body });
    expect(second.status).toBe('held');
  });

  test('does not resolve a child from another source or a mismatched record ID', () => {
    const result = projectPage(tanaPage('root-example', { name: 'Root' }, ['foreign', 'wrong']), new Map([
      ['foreign', { ...tana('foreign', { name: 'Private foreign content' }), source_id: 'other-source' }],
      ['wrong', tana('different-record', { name: 'Private mismatched content' })],
    ]));
    expect({ display_body: result.display_body, status: result.status, warnings: result.warnings }).toEqual({
      display_body: 'Root\n- [held reference]\n- [held reference]',
      status: 'held',
      warnings: ['record_id_mismatch:1', 'source_mismatch:1'],
    });
  });

  test('holds malformed and truncated JSON rather than printing metadata', () => {
    for (const body of ['{"children":["private-record"],"props":{"name":"Private prose"}', '{"children"']) {
      const result = project(page({ title: '', compiled_truth: body }));
      expect({ caption: result.caption, display_body: result.display_body, status: result.status }).toEqual({
        caption: '', display_body: '', status: 'held',
      });
    }
  });

  test('holds invalid node fields while retaining only valid names and children', () => {
    const invalid = project(page({ record_id: 'root-example', compiled_truth: '{"children":[42,"child"],"id":"root-example","props":{"name":"Root"}}' }), [
      tana('child', { name: 'Child' }),
    ]);
    expect({ display_body: invalid.display_body, status: invalid.status }).toEqual({ display_body: 'Root\n- Child', status: 'held' });
    const mismatch = project(page({ record_id: 'different-root', compiled_truth: '{"children":[],"id":"root-example","props":{"name":"Root"}}' }));
    expect({ display_body: mismatch.display_body, status: mismatch.status }).toEqual({ display_body: 'Root', status: 'held' });
  });

  test('recognizes a JSON node revealed by decoding or nested in a name', () => {
    expectStable(page({ compiled_truth: '{&quot;children&quot;:[],&quot;id&quot;:&quot;root-example&quot;,&quot;props&quot;:{&quot;name&quot;:&quot;Root&quot;}}' }), {
      caption: 'Example note [p1]', display_body: 'Root', status: 'complete',
    });
    expectStable(tanaPage('outer', { name: '{"children":[],"id":"inner","props":{"name":"Inner"}}' }, [], { title: 'Example note' }), {
      caption: 'Example note [p1]', display_body: 'Inner', status: 'complete',
    });
  });

  test('holds a depth-bounded projection instead of claiming it is complete', () => {
    const refs: ReferenceSnapshot[] = [];
    for (let i = 1; i <= 130; i++) refs.push(tana(`node-${i}`, {}, i < 130 ? [`node-${i + 1}`] : []));
    const result = project(tanaPage('root-example', { name: 'Root' }, ['node-1']), refs);
    expect({ display_body: result.display_body, status: result.status }).toEqual({ display_body: 'Root\n- [held reference]', status: 'held' });
  });

  test('bounds wide traversals including unresolved targets without claiming completeness', () => {
    const root = tanaPage('root-example', { name: 'Root' }, Array.from({ length: 10_005 }, (_, index) => `absent-${index}`));
    const result = project(root);
    expect(result.status).toBe('held');
    expect(result.display_body).toBe(`Root${'\n- [held reference]'.repeat(10_000)}`);
  });
});

describe('Tana inline dates', () => {
  test('renders dated journal parts with the source date and timezone', () => {
    expectStable(tanaPage('day', { name: OSLO_DATE, _docType: 'journalPart' }, [], { title: OSLO_DATE }), {
      caption: '2025-01-15 (Europe/Oslo) [p1]', display_body: '2025-01-15 (Europe/Oslo)', status: 'complete',
    });
  });

  test('renders single-quoted, self-closing, nested and encoded date spans without conversion', () => {
    const timed = `<span data-inlineref-date='{"dateTimeString":"2025-01-15T09:30:00","timezone":"America/New_York","hasTime":true}'/>`;
    const utc = '<span data-inlineref-date="{&quot;dateTimeString&quot;:&quot;2024-12-31&quot;,&quot;timezone&quot;:&quot;UTC&quot;}"><span class="x"></span></span>';
    const untimed = '<span data-inlineref-date="{&quot;dateTimeString&quot;:&quot;2024-02-29&quot;,&quot;hasTime&quot;:false}"></span>';
    const name = `<p>Call ${timed}</p><p>Due ${encode(utc)}; filed ${encode(encode(untimed))}</p>`;
    expectStable(tanaPage('root-example', { name }, [], { title: 'Example note' }), {
      caption: 'Example note [p1]',
      display_body: 'Call 2025-01-15T09:30:00 (America/New_York, hasTime=true)\nDue 2024-12-31 (UTC); filed 2024-02-29 (hasTime=false)',
      status: 'complete',
    });
  });

  test('preserves authored non-ISO strings and independent hasTime metadata', () => {
    const name = `<span data-inlineref-date='{"dateTimeString":"2025-W05","timezone":"Local authored zone","hasTime":false}'/>`;
    expectStable(tanaPage('root-example', { name }, [], { title: 'Example note' }), {
      caption: 'Example note [p1]',
      display_body: '2025-W05 (Local authored zone, hasTime=false)',
      status: 'complete',
    });
    const timedName = `<span data-inlineref-date='{"dateTimeString":"2025-01-15T00:00:00","hasTime":false}'/>`;
    expectStable(tanaPage('root-example', { name: timedName }, [], { title: 'Example note' }), {
      caption: 'Example note [p1]',
      display_body: '2025-01-15T00:00:00 (hasTime=false)',
      status: 'complete',
    });
  });

  test('preserves encoded date metadata inside actual HTML wrappers', () => {
    expectStable(tanaPage('root-example', { name: `<p>${encode(OSLO_DATE)}</p>` }, [], { title: 'Example note' }), {
      caption: 'Example note [p1]', display_body: '2025-01-15 (Europe/Oslo)', status: 'complete',
    });
  });

  test('preserves unstable authored date literals but holds the derived display', () => {
    for (const value of ['&amp;', '<b>Example</b>']) {
      const name = `<span data-inlineref-date='${JSON.stringify({ dateTimeString: value, timezone: 'UTC' })}'/>`;
      const result = project(tanaPage('root-example', { name }));
      expect({ display_body: result.display_body, status: result.status }).toEqual({
        display_body: `${value} (UTC)`, status: 'held',
      });
    }
  });

  test('preserves decoded source characters without aliasing generated inline markers', () => {
    const sourceText = '&#57344;0&#57345; &#57344;projection0:0&#57345;';
    const result = project(tanaPage('root-example', { name: `${sourceText} ${OSLO_DATE}` }));
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: '\uE0000\uE001 \uE000projection0:0\uE001 2025-01-15 (Europe/Oslo)', status: 'held',
    });
  });

  test('holds an unclosed semantic span even when its authored date is readable', () => {
    const name = `<span data-inlineref-date='{"dateTimeString":"2025-W05","timezone":"UTC"}'>`;
    const result = project(tanaPage('root-example', { name }));
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: '2025-W05 (UTC)', status: 'held',
    });
  });

  test('holds malformed date metadata instead of inventing values', () => {
    for (const json of [
      '{"dateTimeString":42}',
      '{"dateTimeString":""}',
      '{"dateTimeString":"2025-01-15","hasTime":"true"}',
      '{"dateTimeString":"2025-01-15","timezone":7}',
      '{"dateTimeString":"2025-01-15","label":"Private label"}',
      '{"dateTimeString":"2025-01',
    ]) {
      const span = `<span data-inlineref-date="${json.replace(/"/g, '&quot;')}"></span>`;
      const result = project(tanaPage('root-example', { name: `Due ${span}` }));
      expect({ display_body: result.display_body, status: result.status }).toEqual({ display_body: 'Due [held reference]', status: 'held' });
    }
  });
});

describe('Tana inline node references', () => {
  test('renders labels only and bounds inline cycles', () => {
    const root = tanaPage('root-example', {
      name: 'Met <span data-inlineref-node="person"></span> about <span data-inlineref-node=\'topic\'/>',
    });
    const result = project(root, [
      root,
      tana('person', { name: 'Alex\nExample', _ownerId: 'elsewhere' }, ['person-detail']),
      tana('person-detail', { name: 'Private subtree' }),
      tana('topic', { name: 'Plan for <span data-inlineref-node="root-example"></span>' }),
    ]);
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: 'Met Alex Example about Plan for [held reference]',
      status: 'held',
    });
  });

  test('resolves encoded inline references through the same source-scoped resolver', () => {
    const span = '<span data-inlineref-node="person"></span>';
    expectStable(tanaPage('root-example', { name: `With ${encode(span)}` }, [], { title: 'Example note' }), {
      caption: 'Example note [p1]', display_body: 'With Alex', status: 'complete',
    }, [tana('person', { name: 'Alex' })]);
  });

  test('holds unresolved, foreign and unlabeled references without exposing IDs or foreign text', () => {
    const name = 'See <span data-inlineref-node="private-missing-id"></span>, <span data-inlineref-node="foreign"></span> and <span data-inlineref-node="tuple-ref"></span>';
    const result = project(tanaPage('root-example', { name }), [
      { ...tana('foreign', { name: 'Private foreign label' }), source_id: 'other-source' },
      tana('tuple-ref', { _docType: 'tuple' }, ['key', 'value']),
    ]);
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: 'See [held reference], [held reference] and [held reference]',
      status: 'held',
    });
    expect(JSON.stringify(result)).not.toContain('private-missing-id');
  });

  test('does not render malformed, invalid, mismatched or Readwise inline targets', () => {
    for (const target of [
      { source_id: 'tana-example', record_id: 'target', compiled_truth: '{"props"' },
      { source_id: 'tana-example', record_id: 'target', compiled_truth: '{"id":"different","props":{"name":"Hidden"}}' },
      { ...tana('target', { name: 'Hidden' }), readwise: true },
      tana('target', { name: 'https://readwise.io' }),
      tana('target', { name: 'Private view', _docType: 'viewDef', _ownerId: 'elsewhere' }),
    ]) {
      const result = project(tanaPage('root-example', { name: 'See <span data-inlineref-node="target"/>' }), [target]);
      expect({ display_body: result.display_body, status: result.status }).toEqual({
        display_body: 'See [held reference]', status: 'held',
      });
    }
  });

  test('holds nested semantic spans rather than claiming their contents were rendered', () => {
    for (const inner of [OSLO_DATE, '<span data-inlineref-node="topic"/>']) {
      const input = tanaPage('root-example', { name: `See <span data-inlineref-node="person">${inner}</span>` });
      const result = project(input, [tana('person', { name: 'Person' }), tana('topic', { name: 'Topic' })]);
      expect({ display_body: result.display_body, status: result.status }).toEqual({
        display_body: 'See Person', status: 'held',
      });
    }
  });

  test('excludes plain-text Readwise targets before stripping their URL attributes', () => {
    const input = tanaPage('root-example', { name: 'See <span data-inlineref-node="target"/>' }, ['target']);
    const target: ReferenceSnapshot = {
      source_id: 'tana-example', record_id: 'target',
      compiled_truth: 'Highlight <a href="https://read.readwise.io/read/example">source</a>',
    };
    const result = project(input, [target]);
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: 'See [held reference]\n- [held reference]', status: 'held',
    });
  });
});

describe('Tana fields and structure', () => {
  test('renders tuple keys, ordered values, descriptions and referenced values as labels', () => {
    const root = tanaPage('task', { name: 'Task' }, ['status-field', 'people-field', 'link'], { title: 'Task' });
    expectStable(root, {
      caption: 'Task [p1]',
      display_body: 'Task\n- Status: Done\n- Attendees:\n  Who attends\n  - Alex\n  - Sam\n- https://example.com/article',
      status: 'complete',
    }, [
      tana('status-field', { _docType: 'tuple', _ownerId: 'task' }, ['status-key', 'status-done']),
      tana('status-key', { name: 'Status', _docType: 'attrDef', _ownerId: 'schema' }, ['private-schema-child']),
      tana('status-done', { name: 'Done', _ownerId: 'status-field' }),
      tana('people-field', { _docType: 'tuple', _ownerId: 'task', description: 'Who attends' }, ['people-key', 'alex', 'sam']),
      tana('people-key', { name: 'Attendees', _docType: 'attrDef' }),
      tana('alex', { name: 'Alex', _ownerId: 'people' }, ['alex-private']),
      tana('alex-private', { name: 'Private profile text' }),
      tana('sam', { name: 'Sam', _ownerId: 'people-field' }),
      tana('link', { name: 'https://example.com/article', _docType: 'url', _ownerId: 'task' }),
    ]);
  });

  test('holds fields with unresolved keys or values', () => {
    const result = project(tanaPage('task', { name: 'Task' }, ['unknown-key-field', 'missing-value-field']), [
      tana('unknown-key-field', { _docType: 'tuple' }, ['unknown-key', 'value']),
      tana('value', { name: 'Value', _ownerId: 'unknown-key-field' }),
      tana('missing-value-field', { _docType: 'tuple' }, ['status-key', 'missing-value']),
      tana('status-key', { name: 'Status', _docType: 'attrDef' }),
    ]);
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: 'Task\n- [held reference]: Value\n- Status: [held reference]',
      status: 'held',
    });
  });

  test('holds unknown structural and media types without flattening their metadata', () => {
    const result = project(tanaPage('root-example', { name: 'Root' }, ['view', 'meta', 'image']), [
      tana('view', { name: 'Private view config', _docType: 'viewDef' }, ['view-child']),
      tana('meta', { name: 'Private metanode', _docType: 'metanode' }),
      tana('image', { name: 'Private image caption', _docType: 'visual' }),
      tana('view-child', { name: 'Private view child' }),
    ]);
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: 'Root\n- [held reference]\n- [held reference]\n- [held reference]',
      status: 'held',
    });
    const command = project(tanaPage('command', { name: 'Private command', _docType: 'command' }));
    expect({ display_body: command.display_body, status: command.status }).toEqual({ display_body: '', status: 'held' });
  });
});

describe('Readwise boundaries', () => {
  test('excludes flagged and exporter-marked Readwise nodes but keeps ordinary mentions', () => {
    const result = project(tanaPage('root-example', { name: 'Root' }, ['flagged', 'marker', 'mention']), [
      { ...tana('flagged', { name: 'Saved highlight' }), readwise: true },
      tana('marker', { name: 'Highlight <a href="https://read.readwise.io/read/example">source</a>' }),
      tana('mention', { name: 'Compare Readwise with other readers' }),
    ]);
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: 'Root\n- [held reference]\n- [held reference]\n- Compare Readwise with other readers',
      status: 'held',
    });
    expectStable(tanaPage('root-example', { name: 'Root' }, ['mention'], { title: 'Root' }), {
      caption: 'Root [p1]', display_body: 'Root\n- Compare Readwise with other readers', status: 'complete',
    }, [tana('mention', { name: 'Compare Readwise with other readers' })]);
  });

  test('renders a flagged Readwise page for review but holds it', () => {
    const result = project(tanaPage('article', { name: 'Article notes' }, [], { readwise: true }));
    expect({ display_body: result.display_body, status: result.status }).toEqual({ display_body: 'Article notes', status: 'held' });
  });

  test('holds a root excluded by source provenance even without a copied page flag', () => {
    const input = tanaPage('article', { name: 'Stored highlight' });
    const result = project(input, [{ ...input, readwise: true }]);
    expect({ display_body: result.display_body, status: result.status }).toEqual({
      display_body: 'Stored highlight', status: 'held',
    });
  });
});

describe('Tana captions', () => {
  test('keeps same-named Tana pages distinct with a stable page suffix inside the budget', () => {
    expectStable(tanaPage('first', { name: 'Meeting' }, [], { title: 'Meeting' }), {
      caption: 'Meeting [p1]', display_body: 'Meeting', status: 'complete',
    });
    expectStable(tanaPage('second', { name: 'Meeting' }, [], { id: 2, title: 'Meeting' }), {
      caption: 'Meeting [p2]', display_body: 'Meeting', status: 'complete',
    });
  });

  test('truncates by code points including the suffix and never appends it twice', () => {
    expectStable(tanaPage('long', { name: 'Long' }, [], { title: 'a'.repeat(200) }), {
      caption: `${'a'.repeat(115)} [p1]`, display_body: 'Long', status: 'complete',
    });
    const emoji = expectStable(tanaPage('emoji', { name: 'Long' }, [], { id: 123456789, title: '🙂'.repeat(200) }), {
      caption: `${'🙂'.repeat(110)} [p21i3v9]`, display_body: 'Long', status: 'complete',
    });
    expect(Array.from(emoji.caption)).toHaveLength(120);
  });
});

describe('projection inputs', () => {
  test('does not mutate the page or reference snapshots', () => {
    const refs = [tana('child', { name: 'Child' }), { ...tana('flagged', { name: 'Flagged' }), readwise: true }];
    const input = tanaPage('root-example', { name: `Root ${OSLO_DATE}` }, ['child', 'flagged'], { title: 'Root' });
    const before = structuredClone({ input, refs });
    for (const value of [input, ...refs]) Object.freeze(value);
    const result = project(input, refs);
    expect(result.display_body).toBe('Root 2025-01-15 (Europe/Oslo)\n- Child\n- [held reference]');
    expect({ input, refs }).toEqual(before);
  });
});

describe('reference discovery', () => {
  test('lists ordered child IDs and inline node IDs including encoded spans', () => {
    const snapshot = tana('root-example', {
      name: `<span data-inlineref-node="p"></span> ${encode('<span data-inlineref-node="q"></span>')} ${OSLO_DATE}`,
      description: '<span data-inlineref-node=\'r\'/> <span data-inlineref-node="b"></span>',
    }, ['b', 'a']);
    expect(referencedRecordIds(snapshot)).toEqual(['b', 'a', 'p', 'q', 'r']);
    expect(referencedRecordIds({ source_id: 'tana-example', record_id: null, compiled_truth: 'See <span data-inlineref-node="x"></span>' })).toEqual(['x']);
  });
});

describe('content fingerprints', () => {
  test('hashes an unambiguous deterministic JSON pair and distinguishes title/body boundaries', () => {
    const expected = createHash('sha256').update('["Heading","Body\\nline"]').digest('hex');
    expect(textFingerprint('Heading', 'Body\nline')).toBe(expected);
    expect(textFingerprint('ab', 'c')).toBe(createHash('sha256').update('["ab","c"]').digest('hex'));
    expect(textFingerprint('a', 'bc')).toBe(createHash('sha256').update('["a","bc"]').digest('hex'));
    expect(textFingerprint('ab', 'c')).not.toBe(textFingerprint('a', 'bc'));
  });
});

describe('redacted structural previews', () => {
  test('strips single-quoted and multiline attributes and preserves self-closing tags', () => {
    const text = `<P\n title='private > prose'>Name</P><img src='https://example.com/private'/>`;
    expect(redactedPreview(text)).toEqual({
      text: '<p>[redacted]</p><img/>',
      characters: text.length,
      lines: 2,
      html_tags: ['p', 'img'],
      raw_tana_json: false,
    });
  });

  test('preserves HTML structure and punctuation without names or attributes', () => {
    expect(redactedPreview('<p id="x">Name!</p>\n')).toEqual({
      text: '<p>[redacted]!</p>\n', characters: 20, lines: 2, html_tags: ['p'], raw_tana_json: false,
    });
  });

  test('removes quoted attribute values, embedded delimiters and all raw URLs', () => {
    const text = '<a href="https://example.com/private?id=record-1" title="private > prose" data-secret="!!!">Read</a> https://example.com/path?q=record-1';
    expect(redactedPreview(text)).toEqual({
      text: '<a>[redacted]</a> [redacted]://[redacted].[redacted]/[redacted]?[redacted]=[redacted]-[redacted]',
      characters: text.length,
      lines: 1,
      html_tags: ['a'],
      raw_tana_json: false,
    });
  });

  test('redacts Unicode words, numbers, joined IDs and existing redaction markers', () => {
    expect(redactedPreview('Élan 東京 123')).toEqual({
      text: '[redacted] [redacted] [redacted]', characters: 11, lines: 1, html_tags: [], raw_tana_json: false,
    });
    expect(redactedPreview('record_example-123 a\u200bb [redacted]').text).toBe('[redacted]-[redacted] [redacted] [redacted]');
    expect(redactedPreview('Private 😔 ❤️').text).toBe('[redacted] [redacted] [redacted]');
    expect(redactedPreview(redactedPreview('<b>Example!</b> [redacted]').text).text).toBe('<b>[redacted]!</b> [redacted]');
  });

  test('redacts JSON keys, prose and record IDs while reporting the raw-node structure', () => {
    const text = '{"children":["ref"],"id":"ref","props":{"name":"Example"}}';
    expect(redactedPreview(text)).toEqual({
      text: '{"[redacted]":["[redacted]"],"[redacted]":"[redacted]","[redacted]":{"[redacted]":"[redacted]"}}',
      characters: text.length,
      lines: 1,
      html_tags: [],
      raw_tana_json: true,
    });
  });

  test('does not leak custom tag names, comments or unterminated attributes', () => {
    expect(redactedPreview('<private-record secret="!!!">Name</private-record><!-- private note -->').text).toBe('[redacted][redacted][redacted]<!--[redacted]-->');
    expect(redactedPreview('<a href="https://example.com/private').text).toBe('<a>');
  });

  test('does not split redaction markers or tags at the preview cap', () => {
    const first = redactedPreview('Word '.repeat(60));
    expect(first.text).toBe('[redacted] '.repeat(45));
    expect(redactedPreview(first.text).text).toBe('[redacted] '.repeat(45));
    expect(redactedPreview(`${'!'.repeat(499)}<p>Private</p>`).text).toBe('!'.repeat(499));
  });

  test('caps structural text while counting the full original input and tags beyond the cap', () => {
    const text = `${'!'.repeat(600)}\n<p>🙂</p>`;
    expect(redactedPreview(text)).toEqual({
      text: '!'.repeat(500), characters: 609, lines: 2, html_tags: ['p'], raw_tana_json: false,
    });
    expect(redactedPreview('')).toEqual({ text: '', characters: 0, lines: 0, html_tags: [], raw_tana_json: false });
  });
});
