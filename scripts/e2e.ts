import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
const libs = resolve('.local/browser-deps/root/usr/lib/x86_64-linux-gnu');
const env = { ...process.env };
if (existsSync(libs))
  env.LD_LIBRARY_PATH = libs + (env.LD_LIBRARY_PATH ? delimiter + env.LD_LIBRARY_PATH : '');
const args = process.argv.slice(2);
// Each browser project gets a fresh owner, database and server. The session
// endpoint's real 20/minute policy must not be consumed by another project.
const explicitProject = args.some((arg) => arg === '--project' || arg.startsWith('--project='));
function projectArgs(project: string) {
  const run = [...args];
  const index = run.findIndex((arg) => arg === '--output' || arg.startsWith('--output='));
  let output = 'test-results';
  if (index >= 0) {
    if (run[index] === '--output') {
      if (!run[index + 1]) return [...run, '--project', project];
      output = run.splice(index, 2)[1];
    } else output = run.splice(index, 1)[0].slice('--output='.length);
  }
  return [...run, '--project', project, '--output', resolve(output, project)];
}
const runs = explicitProject ? [args] : ['desktop', 'mobile'].map(projectArgs);
let failed = false;
for (const run of runs) {
  const code = await new Promise<number>((resolve) => {
    const child = spawn(
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test', ...run],
      { stdio: 'inherit', env },
    );
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (code !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
