#!/usr/bin/env node
// Release-only: collect Markdown fragments after VERSION has been stamped.
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function collectChangelog(root, date = new Date().toISOString().slice(0, 10)) {
  const directory = join(root, 'changelog.d');
  const names = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith('.md')).sort() : [];
  if (names.length === 0) return 0;
  const fragments = names.map((name) => {
    const text = readFileSync(join(directory, name), 'utf8').trim();
    if (!text || /^#{1,2}(?:\s|$)/m.test(text)) {
      throw new Error(`${name}: use nonempty Markdown with headings at level 3 or below`);
    }
    return text;
  });
  const version = readFileSync(join(root, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('VERSION must contain a release version');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Release date must use YYYY-MM-DD');
  const file = join(root, 'CHANGELOG.md');
  const before = readFileSync(file, 'utf8');
  const headings = [...before.matchAll(/^## \[([^\]]+)\][^\n]*(?:\n|$)/gm)];
  const entry = headings.findIndex((heading) => heading[1] === version);
  const body = fragments.join('\n\n') + '\n\n';
  let after;
  if (entry >= 0) {
    const end = headings[entry + 1]?.index ?? before.length;
    after = before.slice(0, end) + '\n' + body + before.slice(end);
  } else {
    const start = headings[0]?.index ?? before.length;
    after = before.slice(0, start) + `## [${version}] - ${date}\n\n` + body + before.slice(start);
  }
  writeFileSync(file, after);
  // Only consume fragments after the complete changelog has been written.
  for (const name of names) unlinkSync(join(directory, name));
  return names.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(`Collected ${collectChangelog(process.cwd(), process.env.GBRAIN_RESTAMP_DATE)} changelog fragment(s).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
