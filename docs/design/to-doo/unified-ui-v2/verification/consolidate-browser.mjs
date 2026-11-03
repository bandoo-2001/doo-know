import { readFile, writeFile } from 'node:fs/promises';

// Merge chronological runs by actual case identity; the latest observed result wins.
// A stopped run never counts an unexecuted case as passed.
const [expectedFile, ...logs] = process.argv.slice(2);
if (!expectedFile || !logs.length) throw Error('Expected: case-list.log chronological-run.log...');
const expected = new Map();
const identity = (project, file, title) =>
  [project, file, title.replace(/\s+\([\d.]+(?:ms|s|m|h)\)$/, '')].join('\0');
const location = /\[([^\]]+)\] › (?:tests\/e2e\/)?([^:]+):(\d+):(\d+) › (.*)$/;
for (const line of (await readFile(expectedFile, 'utf8')).split('\n')) {
  const match = line.match(location);
  if (!match) continue;
  const [, project, file, row, , title] = match;
  expected.set(identity(project, file, title), { project, file, line: Number(row), title });
}
if (!expected.size) throw Error('No expected browser cases');
const history = new Map();
for (const log of logs) {
  for (const [index, line] of (await readFile(log, 'utf8')).split('\n').entries()) {
    const mark = line.match(/^\s*(✓|✘|-)\s+\d+\s+/);
    const match = line.match(location);
    if (!mark || !match) continue;
    const [, project, file, , , title] = match;
    const key = identity(project, file, title);
    if (!expected.has(key)) throw Error('Unexpected browser case: ' + key);
    const attempts = history.get(key) ?? [];
    attempts.push({
      status: { '✓': 'passed', '✘': 'failed', '-': 'skipped' }[mark[1]],
      log: log.split('/').at(-1),
      logLine: index + 1,
    });
    history.set(key, attempts);
  }
}
const cases = [...expected].map(([key, definition]) => ({
  ...definition,
  status: history.get(key)?.at(-1)?.status ?? 'not-run',
  attempts: history.get(key) ?? [],
}));
const counts = {};
for (const row of cases) counts[row.status] = (counts[row.status] ?? 0) + 1;
const unresolved = cases.filter((row) => !['passed', 'skipped'].includes(row.status));
const result = {
  status: unresolved.length ? 'incomplete' : 'passed-by-case-consolidation',
  description:
    'All expected desktop/mobile cases reconciled against chronological native Playwright logs. Earlier failed attempts remain visible. Skips retain their original device-only conditions.',
  source: JSON.parse(await readFile(new URL('./production-source.json', import.meta.url), 'utf8')),
  expectedCount: expected.size,
  counts,
  cases,
};
await writeFile(
  new URL('./browser-coverage.json', import.meta.url),
  JSON.stringify(result, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    status: result.status,
    expectedCount: result.expectedCount,
    counts,
    unresolved: unresolved.map(({ project, file, title }) => ({ project, file, title })),
  }),
);
if (unresolved.length) process.exitCode = 1;
