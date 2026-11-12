#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkChangelogPr(files, branch) {
  if (!files.includes('CHANGELOG.md')) return;
  const release = branch.startsWith('release/') && files.includes('VERSION') && files.includes('package.json');
  if (!release) {
    throw new Error('Add changelog.d/<branch-or-issue>.md instead of editing CHANGELOG.md. Only release/* PRs that change VERSION and package.json may collect fragments.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [base, head] = process.argv.slice(2);
    if (!base || !head) throw new Error('Usage: node scripts/check-changelog-pr.mjs <base-sha> <head-sha>');
    // Disable rename detection so renaming CHANGELOG.md cannot hide its deletion.
    const files = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`, '--'], { encoding: 'utf8' }).split('\0');
    checkChangelogPr(files, process.env.PR_HEAD_REF ?? '');
    console.log('Changelog policy passed.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
