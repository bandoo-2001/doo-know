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
const runs = explicitProject
  ? [args]
  : ['desktop', 'mobile'].map((project) => [...args, '--project', project]);
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
