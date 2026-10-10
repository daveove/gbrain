import { expect, test } from 'bun:test';
import { extractPageLinks, resolvedLinkCandidate } from '../src/core/link-extraction.ts';
import { pendingCandidates } from '../src/core/pending-link-references.ts';

test('canonical attendance satisfies its bare candidate only for the exact origin, source, and context', async () => {
  const origin = 'meetings/example', person = 'people/bob-example', source = 'default';
  const result = await extractPageLinks(origin, 'Attendees: [[bob-example]]', {}, 'meeting', {
    resolve: async () => null, resolveBasenameMatches: async () => [person],
  }, { globalBasename: true, skipFrontmatter: true, targetType: slug => slug === person ? 'person' : undefined });
  const missing = result.candidates.filter(candidate => candidate.targetSlug === 'bob-example');
  const resolved = result.candidates.find(candidate => candidate.targetSlug === person)!;
  const row = resolvedLinkCandidate(resolved, origin, source, {
    fromSlug: origin, fromSourceId: source, toSourceId: source,
  });
  expect(result.attendanceComplete).toBe(true);
  expect(row.from_slug).toBe(person);
  expect(row.to_slug).toBe(origin);
  expect(pendingCandidates(missing, [row], true, origin, source)).toEqual([]);
  expect(pendingCandidates(missing, [{ ...row, from_slug: origin, to_slug: person, link_type: 'mentions' }],
    true, origin, source)).toEqual([]);
  for (const mismatch of [
    { origin_slug: 'meetings/other' }, { origin_source_id: 'other' },
    { to_slug: 'meetings/other' }, { from_source_id: 'other' },
    { context: 'Different evidence' }, { from_slug: 'people/robert-example' },
  ]) expect(pendingCandidates(missing, [{ ...row, ...mismatch }], true, origin, source)).toEqual(missing);
});
